const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, execFileSync, spawn } = require('child_process');
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

// Ventana de contexto en tokens. Todos los Claude 3.5/4 usan 200k por defecto.
// Si en el futuro algún modelo cambia (o se habilita 1M en Sonnet), agregar prefijo acá.
const CONTEXT_WINDOW_TABLE = [
  { prefix: 'claude-', tokens: 200_000 },
];
function contextWindowFor(model) {
  if (!model) return 200_000;
  const row = CONTEXT_WINDOW_TABLE.find(p => model.startsWith(p.prefix));
  return row ? row.tokens : 200_000;
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

runner.on('status', s => {
  broadcast(s.convId, { kind: 'status', ...s });
  if (s.status === 'idle' && s.code === 0) {
    maybeGenerateTitle(s.convId).catch(() => {});
  }
});

// ── Título automático vía Groq ──
const _lastTitleAttempt = new Map(); // convId → timestamp
const TITLE_MIN_MSGS = 3;
const TITLE_RETRY_MS = 30_000;

function _groqTitle(excerpt) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: 'Sos un generador de títulos. El usuario te va a pasar el inicio de una conversación y vos respondés SOLO con un título corto (3 a 6 palabras) en español que la resuma. Nada de comillas, puntos, emojis, ni explicaciones. Ejemplo:\n\nEntrada:\nuser: Cómo instalo Docker en Ubuntu?\nassistant: Ejecutá sudo apt install docker.io\n\nTítulo: Instalación de Docker en Ubuntu' },
        { role: 'user', content: excerpt },
      ],
      max_tokens: 30,
      temperature: 0.3,
    });
    execFile('curl', [
      '-s', '-X', 'POST',
      'https://api.groq.com/openai/v1/chat/completions',
      '-H', `Authorization: Bearer ${GROQ_API_KEY}`,
      '-H', 'Content-Type: application/json',
      '--max-time', '15',
      '-d', body,
    ], { maxBuffer: 512 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.error) return resolve(null);
        const raw = (parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content) || '';
        const t = raw.trim().replace(/^["'`«»]+|["'`«»\.]+$/g, '').slice(0, 80);
        resolve(t || null);
      } catch { resolve(null); }
    });
  });
}

const SUMMARIZE_SYSTEM_PROMPT = 'Sos un compresor de contexto. El usuario te pasa una conversación entre él (user) y un asistente (assistant). Devolvés un resumen estructurado en español que preserve: (1) el objetivo/tema de la charla, (2) las decisiones tomadas, (3) los archivos/paths/comandos relevantes mencionados, (4) el estado actual (qué está hecho y qué falta), y (5) cualquier información no obvia que se necesite para continuar. Sin saludos, sin conclusiones, sin comentarios sobre tu tarea — solo el resumen en prosa concisa con bullets cuando ayude. Longitud: 200-500 palabras según lo que amerite.';

function _claudeSummarize(excerpt) {
  return new Promise((resolve, reject) => {
    const prompt = `${SUMMARIZE_SYSTEM_PROMPT}\n\n--- CONVERSACIÓN A RESUMIR ---\n\n${excerpt}`;
    const args = ['-p', prompt, '--model', 'claude-sonnet-4-6', '--dangerously-skip-permissions'];
    const child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('timeout (120s) resumiendo con claude'));
    }, 120_000);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => {
      clearTimeout(timer);
      console.error('[compact] spawn claude error:', err.message);
      reject(new Error('no se pudo lanzar claude: ' + err.message));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        console.error('[compact] claude exit', code, 'stderr:', stderr.slice(0, 500));
        return reject(new Error(`claude salió con código ${code}: ${(stderr || '').slice(0, 200)}`));
      }
      const t = (stdout || '').trim();
      if (!t) return reject(new Error('resumen vacío de claude'));
      resolve(t);
    });
  });
}

async function maybeGenerateTitle(convId) {
  if (!GROQ_API_KEY) return;
  const last = _lastTitleAttempt.get(convId) || 0;
  if (Date.now() - last < TITLE_RETRY_MS) return;
  const data = meta.load();
  const conv = data.conversations[convId];
  if (!conv || conv.name || conv.aiTitle) return;
  const file = conv.currentSessionId ? scanner.findSessionFile(conv.currentSessionId) : null;
  if (!file) return;
  const info = scanner.sessionInfo(file);
  if (!info || info.messageCount < TITLE_MIN_MSGS) return;
  _lastTitleAttempt.set(convId, Date.now());
  const messages = scanner.getMessagesIncremental(file).filter(m => m.role !== 'tool').slice(0, 6);
  const excerpt = messages.map(m => `${m.role}: ${(m.text || '').slice(0, 400)}`).join('\n\n').slice(0, 2000);
  const title = await _groqTitle(excerpt);
  if (!title) return;
  const latest = meta.load();
  const latestConv = latest.conversations[convId];
  if (!latestConv || latestConv.name) return;
  latestConv.name = title;
  latestConv.aiTitle = true;
  meta.save(latest);
  broadcast(convId, { kind: 'meta', name: title, aiTitle: true });
}

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
  function contextPctFor(s) {
    const tokens = s.contextTokens || 0;
    if (!tokens) return 0;
    return tokens / contextWindowFor(s.lastModel);
  }
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
      pinned: !!c.pinned,
      archived: !!c.archived,
      aiTitle: !!c.aiTitle,
      contextPct: contextPctFor(s),
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
      pinned: false,
      archived: false,
      contextPct: contextPctFor(s),
      status: runner.running.has(s.sessionId) ? 'running' : (runner.isBusy(s.sessionId) ? 'queued' : 'idle'),
    });
  }

  const showArchived = req.query.archived === '1';
  const archivedTotal = convs.filter(c => c.archived).length;
  const filtered = showArchived ? convs.filter(c => c.archived) : convs.filter(c => !c.archived);

  // Sort: pinned primero, después lastActivity desc.
  filtered.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.lastActivity || '').localeCompare(a.lastActivity || '');
  });

  const total = filtered.length;
  const requested = Number(req.query.limit) || DEFAULT_TREE_LIMIT;
  const limit = Math.max(1, Math.min(MAX_TREE_LIMIT, requested));
  const visible = filtered.slice(0, limit);
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
  res.json({ tree, hasMore, total, limit, archivedTotal });
});

app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.json({ results: [] });
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  const results = scanner.searchSessions(q, { limit });
  // Anotar convId real (si existe conversación con nombre custom) para poder abrirla.
  const data = meta.load();
  const bySessionId = new Map();
  for (const [convId, c] of Object.entries(data.conversations)) {
    bySessionId.set(c.currentSessionId, { convId, name: c.name });
  }
  const enriched = results.map(r => {
    const ref = bySessionId.get(r.sessionId);
    return {
      ...r,
      convId: ref ? ref.convId : r.sessionId,
      displayName: (ref && ref.name) || r.name,
    };
  });
  res.json({ results: enriched });
});

app.get('/api/conversations/:id/usage', (req, res) => {
  const empty = { total: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, byModel: {}, costUSD: 0, contextTokens: 0, contextWindow: 200_000, contextPct: 0 };
  const { conv } = resolveConv(req.params.id);
  if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
  if (!conv.currentSessionId) return res.json(empty);
  const file = scanner.findSessionFile(conv.currentSessionId);
  if (!file) return res.json(empty);
  const info = scanner.sessionInfo(file);
  if (!info || !info.usage) return res.json(empty);
  const window = contextWindowFor(info.lastModel);
  const contextTokens = info.contextTokens || 0;
  res.json({
    ...usageCost(info.usage),
    contextTokens,
    contextWindow: window,
    contextPct: window > 0 ? contextTokens / window : 0,
  });
});

app.get('/api/conversations/:id/messages', (req, res) => {
  const { conv } = resolveConv(req.params.id);
  if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
  const out = [];
  if (conv.compactedFromSession) {
    const oldFile = scanner.findSessionFile(conv.compactedFromSession);
    if (oldFile) {
      for (const m of scanner.getMessagesIncremental(oldFile)) out.push({ ...m, compacted: true });
    }
  }
  if (conv.currentSessionId) {
    const file = scanner.findSessionFile(conv.currentSessionId);
    if (file) {
      for (const m of scanner.getMessagesIncremental(file)) out.push(m);
    }
  }
  res.json(out);
});

function slugify(s) {
  return (s || 'conversacion')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'conversacion';
}

function messagesToMarkdown({ conv, info, messages }) {
  const lines = [];
  const name = conv.name || (info && info.snippet) || '(sin título)';
  lines.push(`# ${name}`, '');
  lines.push(`- Proyecto: \`${conv.projectDir || (info && info.cwd) || ''}\``);
  if (info && info.lastActivity) lines.push(`- Última actividad: ${info.lastActivity}`);
  if (info && info.lastModel) lines.push(`- Modelo: ${info.lastModel}`);
  if (conv.currentSessionId) lines.push(`- Session ID: \`${conv.currentSessionId}\``);
  lines.push('', '---', '');

  const MAX_TOOL = 4000;
  for (const m of messages) {
    if (m.role === 'user') {
      lines.push('## Usuario', '', m.text, '');
    } else if (m.role === 'assistant') {
      lines.push('## Asistente', '', m.text, '');
    } else if (m.role === 'tool') {
      lines.push(`### 🔧 ${m.name}`, '');
      const inp = typeof m.input === 'string' ? m.input : JSON.stringify(m.input, null, 2);
      lines.push('**Input:**', '', '```json', inp, '```', '');
      if (m.output) {
        const out = String(m.output);
        const trimmed = out.length > MAX_TOOL ? out.slice(0, MAX_TOOL) + `\n... [truncado ${out.length - MAX_TOOL} caracteres]` : out;
        lines.push('**Output:**', '', '```', trimmed, '```', '');
      }
    }
  }
  return lines.join('\n');
}

app.get('/api/conversations/:id/export', (req, res) => {
  const { conv } = resolveConv(req.params.id);
  if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
  const format = (req.query.format || 'md').toLowerCase();
  if (format !== 'md') return res.status(400).json({ error: 'formato no soportado' });
  const messages = conv.currentSessionId
    ? (scanner.findSessionFile(conv.currentSessionId)
        ? scanner.getMessagesIncremental(scanner.findSessionFile(conv.currentSessionId))
        : [])
    : [];
  const info = conv.currentSessionId
    ? (scanner.findSessionFile(conv.currentSessionId)
        ? scanner.sessionInfo(scanner.findSessionFile(conv.currentSessionId))
        : null)
    : null;
  const md = messagesToMarkdown({ conv, info, messages });
  const filename = `${slugify(conv.name || (info && info.snippet))}.md`;
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.end(md);
});

app.post('/api/conversations/:id/message', (req, res) => {
  const convId = req.params.id;
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'mensaje vacío' });
  if (runner.isBusy(convId)) return res.status(409).json({ error: 'esa conversación ya está procesando un mensaje' });
  const { data, conv } = resolveConv(convId);
  if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
  let outgoing = text;
  if (conv.compactedSummary && !conv.currentSessionId) {
    outgoing = `[Resumen del contexto previo — la conversación fue compactada]\n${conv.compactedSummary}\n\n[Mensaje actual del usuario]\n${text}`;
    delete conv.compactedSummary;
    delete conv.compactedAt;
  }
  meta.save(data);
  runner.send({ convId, sessionId: conv.currentSessionId, cwd: conv.projectDir, text: outgoing, model: conv.model });
  res.status(202).json({ queued: true });
});

app.post('/api/conversations/:id/compact', async (req, res) => {
  const convId = req.params.id;
  if (runner.isBusy(convId)) return res.status(409).json({ error: 'esa conversación está procesando un mensaje' });
  const { data, conv } = resolveConv(convId);
  if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
  if (!conv.currentSessionId) return res.status(400).json({ error: 'la conversación no tiene sesión activa' });
  const file = scanner.findSessionFile(conv.currentSessionId);
  if (!file) return res.status(404).json({ error: 'archivo de sesión no encontrado' });
  const messages = scanner.getMessagesIncremental(file).filter(m => m.role === 'user' || m.role === 'assistant');
  if (messages.length < 2) return res.status(400).json({ error: 'nada útil para compactar (menos de 2 mensajes)' });

  const MAX_CHARS_PER_MSG = 2000;
  const MAX_TOTAL_CHARS = 120000;
  let total = 0;
  const chunks = [];
  for (const m of messages) {
    const t = (m.text || '').slice(0, MAX_CHARS_PER_MSG);
    const line = `${m.role}: ${t}`;
    if (total + line.length > MAX_TOTAL_CHARS) { chunks.push('[... resto omitido por límite ...]'); break; }
    chunks.push(line);
    total += line.length;
  }
  const excerpt = chunks.join('\n\n');

  let summary;
  try { summary = await _claudeSummarize(excerpt); }
  catch (err) { return res.status(500).json({ error: 'no se pudo resumir: ' + err.message }); }

  const old = conv.currentSessionId;
  if (old && !data.superseded.includes(old)) data.superseded.push(old);
  conv.compactedFromSession = old;
  conv.currentSessionId = null;
  conv.compactedSummary = summary;
  conv.compactedAt = new Date().toISOString();
  meta.save(data);
  broadcast(convId, { kind: 'compacted', summary });
  res.json({ ok: true, summary, messagesCompacted: messages.length });
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
  if ('name' in req.body) {
    conv.name = (req.body.name || '').trim() || undefined;
    conv.aiTitle = false;
  }
  if ('model' in req.body) conv.model = (req.body.model || '').trim() || undefined;
  if ('pinned' in req.body) conv.pinned = !!req.body.pinned;
  if ('archived' in req.body) conv.archived = !!req.body.archived;
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
