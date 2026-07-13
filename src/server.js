const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, execFileSync } = require('child_process');
const multer = require('multer');
const scanner = require('./scanner');
const meta = require('./meta');
const { Runner } = require('./runner');

const IS_WIN = process.platform === 'win32';
// En Windows ImageMagick 7 se llama 'magick'; en Linux/Mac es 'convert'
const MAGICK_CMD = IS_WIN ? 'magick' : 'convert';
// args para magick en Windows: magick [convert] input ... output
// en Linux: convert input ... output
function magickArgs(args) {
  return IS_WIN ? ['convert', ...args] : args;
}

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3777);
const ACCESS_PIN = process.env.ACCESS_PIN || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || os.homedir();
const UPLOAD_DIR = path.join(HOME_DIR, '.ccm-uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 50 * 1024 * 1024 } });

const app = express();
app.use(express.json());

// Auth por cookie — solo si ACCESS_PIN está seteado
if (ACCESS_PIN) {
  app.post('/__auth', (req, res) => {
    if ((req.body.pin || '') === ACCESS_PIN) {
      res.cookie('ccm_auth', ACCESS_PIN, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
      res.json({ ok: true });
    } else {
      res.status(401).json({ error: 'PIN incorrecto' });
    }
  });
  app.use((req, res, next) => {
    const PUBLIC = ['/login.html', '/__auth', '/sw.js', '/manifest.json', '/icon-192.png', '/icon-512.png'];
    if (PUBLIC.includes(req.path)) return next();
    const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')));
    if (cookies.ccm_auth === ACCESS_PIN) return next();
    res.redirect('/login.html');
  });
}

// index.html y archivos JS/CSS nunca cacheados por el browser
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  },
}));

const runner = new Runner();
const sseClients = new Map(); // convId → Set<res>

// Precios en USD por millón de tokens. Match por prefijo del model id.
// Fuente: página pública de precios Anthropic (Ene 2026). Ajustar cuando cambien.
const PRICE_TABLE = [
  { prefix: 'claude-opus-4',      input: 15,   output: 75,  cacheWrite: 18.75, cacheRead: 1.5 },
  { prefix: 'claude-sonnet-4',    input: 3,    output: 15,  cacheWrite: 3.75,  cacheRead: 0.3 },
  { prefix: 'claude-haiku-4',     input: 1,    output: 5,   cacheWrite: 1.25,  cacheRead: 0.1 },
  { prefix: 'claude-3-5-sonnet',  input: 3,    output: 15,  cacheWrite: 3.75,  cacheRead: 0.3 },
  { prefix: 'claude-3-5-haiku',   input: 0.8,  output: 4,   cacheWrite: 1,     cacheRead: 0.08 },
  { prefix: 'claude-3-opus',      input: 15,   output: 75,  cacheWrite: 18.75, cacheRead: 1.5 },
];
function priceFor(model) {
  return PRICE_TABLE.find(p => model.startsWith(p.prefix)) || null;
}
function usageCost(usage) {
  let costUSD = 0;
  const byModel = {};
  for (const [model, t] of Object.entries(usage.byModel || {})) {
    const p = priceFor(model);
    if (!p) { byModel[model] = { ...t, costUSD: null }; continue; }
    const c =
      (t.input       * p.input       / 1_000_000) +
      (t.output      * p.output      / 1_000_000) +
      (t.cacheCreate * p.cacheWrite  / 1_000_000) +
      (t.cacheRead   * p.cacheRead   / 1_000_000);
    byModel[model] = { ...t, costUSD: c };
    costUSD += c;
  }
  return { total: usage.total, byModel, costUSD };
}

function broadcast(convId, payload) {
  const set = sseClients.get(convId);
  if (!set) return;
  for (const res of set) res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

runner.on('event', ({ convId, event }) => {
  const sid = event.session_id;
  if (sid) {
    const data = meta.load();
    if (data.conversations[convId] && data.conversations[convId].currentSessionId !== sid) {
      meta.advanceSession(data, convId, sid);
      meta.save(data);
    }
  }
  broadcast(convId, { kind: 'claude', event });
});

runner.on('status', s => broadcast(s.convId, { kind: 'status', ...s }));

function resolveConv(convId) {
  const data = meta.load();
  if (data.conversations[convId]) return { data, conv: data.conversations[convId] };
  const file = scanner.findSessionFile(convId);
  if (!file) return { data, conv: null };
  const info = scanner.sessionInfo(file);
  data.conversations[convId] = { currentSessionId: convId, projectDir: (info && info.cwd) || process.env.HOME };
  return { data, conv: data.conversations[convId] };
}

// ── Upload de archivo adjunto (con compresión automática de imágenes) ──
const IMAGE_COMPRESS_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024; // 1.5MB → comprimir

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no se recibió archivo' });
  const ext = (path.extname(req.file.originalname) || '').slice(1).toLowerCase();
  const finalPath = req.file.path + '.' + (ext || 'bin');

  const finish = (compressedPath) => {
    res.json({ path: compressedPath, name: req.file.originalname, size: fs.statSync(compressedPath).size });
  };

  if (IMAGE_COMPRESS_EXTS.has(ext) && req.file.size > MAX_IMAGE_BYTES) {
    // Comprimir: max 2048px ancho, calidad 82
    const outPath = req.file.path + '_c.jpg';
    execFile(MAGICK_CMD, magickArgs([
      req.file.path,
      '-resize', '2048x2048>',
      '-quality', '82',
      '-strip',
      outPath,
    ]), (err) => {
      fs.unlink(req.file.path, () => {});
      if (err) {
        // Fallback: usar original renombrado
        fs.renameSync(req.file.path, finalPath);
        return finish(finalPath);
      }
      finish(outPath);
    });
  } else {
    fs.renameSync(req.file.path, finalPath);
    finish(finalPath);
  }
});

// ── Transcripción de audio vía Groq Whisper ──
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no se recibió audio' });
  if (!GROQ_API_KEY) {
    fs.unlinkSync(req.file.path);
    return res.status(503).json({ error: 'GROQ_API_KEY no configurada' });
  }
  const audioPath = req.file.path;
  const originalName = req.file.originalname || 'audio.webm';
  execFile('curl', [
    '-s', '-X', 'POST',
    'https://api.groq.com/openai/v1/audio/transcriptions',
    '-H', `Authorization: Bearer ${GROQ_API_KEY}`,
    '-F', 'model=whisper-large-v3',
    '-F', 'language=es',
    '-F', `file=@${audioPath};filename=${originalName}`,
  ], { maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
    fs.unlink(audioPath, () => {});
    if (err) return res.status(500).json({ error: 'error de transcripción: ' + (stderr || err.message) });
    let parsed;
    try { parsed = JSON.parse(stdout); } catch { return res.status(500).json({ error: 'respuesta inválida de Groq' }); }
    if (parsed.error) return res.status(500).json({ error: parsed.error.message || 'error Groq' });
    res.json({ text: parsed.text || '' });
  });
});

// ── Thumbnail de archivos (imágenes y PDFs) ──
const GS_AVAILABLE = (() => {
  try {
    // 'where' en Windows, 'which' en Unix; gs en Linux, gswin64c en Windows
    const cmd = IS_WIN ? 'where' : 'which';
    const gsName = IS_WIN ? 'gswin64c' : 'gs';
    execFileSync(cmd, [gsName]);
    return true;
  } catch { return false; }
})();

app.get('/api/thumbnail', (req, res) => {
  const filePath = (req.query.path || '').trim();
  if (!filePath || !path.isAbsolute(filePath)) return res.status(400).end();
  if (!fs.existsSync(filePath)) return res.status(404).end();

  const ext = path.extname(filePath).slice(1).toLowerCase();
  const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];
  const isPdf = ext === 'pdf';
  const isImage = IMAGE_EXTS.includes(ext);

  if (!isImage && !isPdf) return res.status(404).end();
  if (isPdf && !GS_AVAILABLE) return res.status(404).end();

  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=3600');

  let args;
  if (isPdf) {
    args = ['-density', '72', `${filePath}[0]`, '-resize', '200x200>', '-background', 'white', '-flatten', 'jpeg:-'];
  } else {
    args = [filePath, '-resize', '200x200>', '-background', '#111b21', '-flatten', 'jpeg:-'];
  }

  execFile(MAGICK_CMD, magickArgs(args), { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
    if (err || !stdout || stdout.length === 0) return res.status(404).end();
    res.end(stdout);
  });
});

// ── Descarga de archivos del filesystem ──
app.get('/api/files', (req, res) => {
  const filePath = (req.query.path || '').trim();
  if (!filePath || !path.isAbsolute(filePath)) return res.status(400).json({ error: 'path inválido' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'archivo no encontrado' });
  const filename = path.basename(filePath);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  fs.createReadStream(filePath).pipe(res);
});

const DEFAULT_TREE_LIMIT = 100;
const MAX_TREE_LIMIT = 500;

app.get('/api/tree', (req, res) => {
  const data = meta.load();
  const sessions = scanner.listSessions();
  const referenced = new Set(data.superseded);
  for (const c of Object.values(data.conversations)) referenced.add(c.currentSessionId);
  const byId = new Map(sessions.map(s => [s.sessionId, s]));
  const convs = [];
  for (const [convId, c] of Object.entries(data.conversations)) {
    const s = byId.get(c.currentSessionId) || {};
    convs.push({
      convId,
      projectDir: c.projectDir,
      name: c.name || s.snippet || '(nueva conversación)',
      snippet: s.snippet || '',
      lastActivity: s.lastActivity || null,
      messageCount: s.messageCount || 0,
      model: c.model || null,
      lastModel: s.lastModel || null,
      status: runner.running.has(convId) ? 'running' : (runner.isBusy(convId) ? 'queued' : 'idle'),
    });
  }
  for (const s of sessions) {
    if (referenced.has(s.sessionId) || data.conversations[s.sessionId]) continue;
    convs.push({
      convId: s.sessionId,
      projectDir: s.cwd || '(desconocido)',
      name: s.snippet,
      snippet: s.snippet,
      lastActivity: s.lastActivity,
      messageCount: s.messageCount,
      model: null,
      lastModel: s.lastModel || null,
      status: runner.running.has(s.sessionId) ? 'running' : (runner.isBusy(s.sessionId) ? 'queued' : 'idle'),
    });
  }

  // Ordenar flat por lastActivity desc y quedarnos con los top N; el resto queda para load-more.
  convs.sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));
  const total = convs.length;
  const requested = Number(req.query.limit) || DEFAULT_TREE_LIMIT;
  const limit = Math.max(1, Math.min(MAX_TREE_LIMIT, requested));
  const visible = convs.slice(0, limit);
  const hasMore = total > limit;

  const groups = new Map();
  for (const c of visible) {
    if (!groups.has(c.projectDir)) groups.set(c.projectDir, []);
    groups.get(c.projectDir).push(c);
  }
  const tree = [...groups.entries()].map(([projectDir, conversations]) => ({
    projectDir,
    conversations,
  }));
  res.json({ tree, hasMore, total, limit });
});

app.get('/api/conversations/:id/usage', (req, res) => {
  const { conv } = resolveConv(req.params.id);
  if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
  if (!conv.currentSessionId) return res.json({ total: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, byModel: {}, costUSD: 0 });
  const file = scanner.findSessionFile(conv.currentSessionId);
  if (!file) return res.json({ total: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, byModel: {}, costUSD: 0 });
  const info = scanner.sessionInfo(file);
  if (!info || !info.usage) return res.json({ total: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, byModel: {}, costUSD: 0 });
  res.json(usageCost(info.usage));
});

app.get('/api/conversations/:id/messages', (req, res) => {
  const { conv } = resolveConv(req.params.id);
  if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
  if (!conv.currentSessionId) return res.json([]);
  const file = scanner.findSessionFile(conv.currentSessionId);
  if (!file) return res.json([]);
  res.json(scanner.getMessagesIncremental(file));
});

app.post('/api/conversations/:id/message', (req, res) => {
  const convId = req.params.id;
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'mensaje vacío' });
  if (runner.isBusy(convId)) return res.status(409).json({ error: 'esa conversación ya está procesando un mensaje' });
  const { data, conv } = resolveConv(convId);
  if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
  meta.save(data);
  runner.send({ convId, sessionId: conv.currentSessionId, cwd: conv.projectDir, text, model: conv.model });
  res.status(202).json({ queued: true });
});

app.post('/api/conversations', (req, res) => {
  const { projectDir, text, model } = req.body;
  if (!projectDir || !(text || '').trim()) return res.status(400).json({ error: 'faltan projectDir o text' });
  const convId = crypto.randomUUID();
  const data = meta.load();
  data.conversations[convId] = { currentSessionId: null, projectDir, model: model || undefined };
  meta.save(data);
  runner.send({ convId, sessionId: null, cwd: projectDir, text: text.trim(), model: model || undefined });
  res.status(201).json({ convId });
});

app.patch('/api/conversations/:id', (req, res) => {
  const { data, conv } = resolveConv(req.params.id);
  if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
  if ('name' in req.body) conv.name = (req.body.name || '').trim() || undefined;
  if ('model' in req.body) conv.model = (req.body.model || '').trim() || undefined;
  meta.save(data);
  res.json({ ok: true });
});

app.delete('/api/conversations/:id/message', (req, res) => {
  const cancelled = runner.cancel(req.params.id);
  res.json({ cancelled });
});

app.get('/api/conversations/:id/stream', (req, res) => {
  const convId = req.params.id;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');
  if (!sseClients.has(convId)) sseClients.set(convId, new Set());
  sseClients.get(convId).add(res);
  req.on('close', () => {
    const set = sseClients.get(convId);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) sseClients.delete(convId);
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Claude Chat Manager en http://${HOST}:${PORT}`);
});
