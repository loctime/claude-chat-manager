const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, execFileSync, spawn } = require('child_process');
const multer = require('multer');
const archiver = require('archiver');
const scanner = require('./scanner');
const notes = require('./notes');
const mail = require('./mail');
const meta = require('./meta');
const { Runner } = require('./runner');
const { CLAUDE_CMD } = require('./claude-cmd');

const IS_WIN = process.platform === 'win32';
// WSL: Linux corriendo dentro de Windows (kernel expone "microsoft" en
// /proc/version). Con interop habilitado (default) se puede invocar
// explorer.exe directo desde acá — lo usamos para que "abrir en la PC"
// funcione también cuando Jarvis corre dentro de WSL, no solo en Windows
// nativo (ver /api/reveal más abajo).
const IS_WSL = !IS_WIN && (() => {
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch { return false; }
})();
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

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || os.homedir();

// GROQ_API_KEY: primero env var, si no está la buscamos en ~/.claude/settings.json (clave env)
function loadGroqKey() {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(HOME_DIR, '.claude', 'settings.json'), 'utf8'));
    return (s.env && s.env.GROQ_API_KEY) || '';
  } catch { return ''; }
}
const GROQ_API_KEY = loadGroqKey();

// ── Multi-cuenta ──
// SINGLE_ACCOUNT=1 fuerza modo single-user (solo el usuario que corre el proceso).
// Sin esa var el server intenta detectar otras cuentas en /home y ofrecer switch.
function detectAccounts() {
  const current = os.userInfo().username;
  // En Windows no hay /home ni sudo -u: siempre single-account
  if (process.env.SINGLE_ACCOUNT === '1' || IS_WIN) return [current];
  const accounts = [];
  try {
    const homes = fs.readdirSync('/home');
    for (const user of homes) {
      const settingsPath = path.join('/home', user, '.claude', 'settings.json');
      if (fs.existsSync(settingsPath)) accounts.push(user);
    }
  } catch {}
  if (!accounts.includes(current)) accounts.unshift(current);
  else { accounts.splice(accounts.indexOf(current), 1); accounts.unshift(current); }
  return accounts;
}

const ACCOUNTS = detectAccounts();
let activeAccount = ACCOUNTS[0];

function accountHomeDir(acc) {
  const current = os.userInfo().username;
  return acc === current ? HOME_DIR : path.join('/home', acc);
}
function accountProjectsDir(acc) {
  return path.join(accountHomeDir(acc), '.claude', 'projects');
}
function accountMetaFile(acc) {
  const current = os.userInfo().username;
  if (acc === current) return path.join(HOME_DIR, '.claude', 'session-manager', 'meta.json');
  return path.join(HOME_DIR, '.claude', 'session-manager', `meta-${acc}.json`);
}
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

// ── Endpoints de cuentas ──
const OTHER_LOCAL_URL = process.env.OTHER_LOCAL_URL || '';
const OTHER_PUBLIC_URL = process.env.OTHER_PUBLIC_URL || '';
const OTHER_LABEL = process.env.OTHER_LABEL || '';

app.get('/api/accounts', (req, res) => {
  res.json({
    accounts: ACCOUNTS,
    active: activeAccount,
    otherLocalUrl: OTHER_LOCAL_URL,
    otherPublicUrl: OTHER_PUBLIC_URL,
    otherLabel: OTHER_LABEL,
  });
});

app.post('/api/accounts/switch', (req, res) => {
  const { account } = req.body;
  if (!ACCOUNTS.includes(account)) return res.status(400).json({ error: 'cuenta no disponible' });
  activeAccount = account;
  res.json({ ok: true, active: activeAccount });
});

// index.html y archivos JS/CSS nunca cacheados por el browser
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('manifest.json')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  },
}));

const runner = new Runner({ selfHost: HOST, selfPort: PORT });
const sseClients = new Map(); // convId → Set<res>

// Precios en USD por millón de tokens. Match por prefijo del model id.
// Fuente: página pública de precios Anthropic (Ene 2026). Ajustar cuando cambien.
const PRICE_TABLE = [
  { prefix: 'claude-fable-5',     input: 10,   output: 50,  cacheWrite: 12.5,  cacheRead: 1 },
  { prefix: 'claude-opus-5',      input: 5,    output: 25,  cacheWrite: 6.25,  cacheRead: 0.5 },
  { prefix: 'claude-sonnet-5',    input: 3,    output: 15,  cacheWrite: 3.75,  cacheRead: 0.3 },
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
  { prefix: 'claude-fable-5',   tokens: 1_000_000 },
  { prefix: 'claude-opus-5',    tokens: 1_000_000 },
  { prefix: 'claude-sonnet-5',  tokens: 1_000_000 },
  { prefix: 'claude-opus-4-6',  tokens: 1_000_000 },
  { prefix: 'claude-opus-4-7',  tokens: 1_000_000 },
  { prefix: 'claude-opus-4-8',  tokens: 1_000_000 },
  { prefix: 'claude-sonnet-4-6', tokens: 1_000_000 },
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

runner.on('event', ({ convId, event, account }) => {
  // Hilo de conversación de un mail (borrador/envío): no es una conversación
  // normal, no tiene meta ni SSE propio — solo nos interesa guardar el
  // sessionId apenas aparece, para poder --resume en el próximo pedido de
  // borrador y para leer el jsonl cuando el job termine.
  if (convId.startsWith(MAIL_THREAD_PREFIX)) {
    const mailId = convId.slice(MAIL_THREAD_PREFIX.length);
    if (event.session_id) mail.setDraft(mailId, { threadSessionId: event.session_id });
    return;
  }
  // Job de escaneo de mail: igual que arriba, solo nos interesa guardar el
  // sessionId apenas aparece — lo usamos si el escaneo falla, para ir a
  // buscar al jsonl qué dijo el LLM (ej. "las tools de Gmail no están
  // disponibles") y mostrar ese motivo real en vez de un genérico.
  if (convId === MAIL_SCAN_CONV_ID) {
    if (event.session_id) mailScanSessionId = event.session_id;
    return;
  }
  const sid = event.session_id;
  if (sid) {
    const metaFile = accountMetaFile(account || activeAccount);
    const data = meta.load(metaFile);
    if (data.conversations[convId] && data.conversations[convId].currentSessionId !== sid) {
      meta.advanceSession(data, convId, sid);
      meta.save(data, metaFile);
    }
  }
  broadcast(convId, { kind: 'claude', event });
});

runner.on('status', s => {
  // Job de escaneo de mail: no tiene conversación real ni SSE que lo escuche.
  // Al terminar (incluso si terminó mal) mergeamos lo que el LLM haya
  // escrito en el staging file con mail.json — nunca lo pisamos directo, ver
  // mail.mergeScan(). mergeScan ya se encarga de apagar "scanning" pase lo
  // que pase, así no queda trabado en true para siempre. No hace broadcast
  // ni intenta generar título porque no es una conversación normal.
  if (s.convId === MAIL_SCAN_CONV_ID) {
    if (s.status === 'idle') {
      clearTimeout(mailScanTimeoutTimer);
      mailScanTimeoutTimer = null;
      handleMailScanIdle(s).catch(err => console.error('[mail] error procesando fin de escaneo:', err.message));
    }
    return;
  }
  // Hilo de conversación de un mail (pedido de borrador o envío): al terminar
  // el job leemos el último mensaje assistant de esa sesión (el CLI no
  // escribe el resultado a mano en el JSON, lo sacamos del jsonl directo,
  // igual que hace el resto de la app) y lo guardamos como draft o sendResult
  // según qué tipo de job era. Tampoco es una conversación normal: nada de
  // broadcast SSE ni título automático.
  if (s.convId.startsWith(MAIL_THREAD_PREFIX)) {
    if (s.status === 'idle') handleMailThreadIdle(s).catch(err => console.error('[mail] error procesando fin de hilo:', err.message));
    return;
  }
  broadcast(s.convId, { kind: 'status', ...s });
  if (s.status === 'idle' && s.code === 0) {
    maybeGenerateTitle(s.convId, s.account || activeAccount).catch(() => {});
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

// Compact nativo: en vez de armar un excerpt y pedirle a un claude aparte que lo
// resuma en prosa (perdía tool calls, se truncaba a 120k caracteres y ese mismo
// excerpt pasado como argumento de spawn reventaba ENAMETOOLONG en Windows con
// conversaciones largas), le mandamos "/compact" al propio `claude --resume
// <sessionId>` — es el mismo mecanismo que corre solo en la consola interactiva,
// pero invocado a mano. Ve la sesión completa (no un recorte de texto), y el
// resultado queda en la MISMA sesión (mismo session_id, con un entry
// type:"system", subtype:"compact_boundary" en su jsonl) en vez de generar un
// resumen aparte que había que reinyectar a mano en el próximo mensaje.
function _claudeCompact(sessionId, cwd) {
  return new Promise((resolve, reject) => {
    const args = ['--resume', sessionId, '-p', '/compact', '--dangerously-skip-permissions', '--output-format', 'json'];
    const child = spawn(CLAUDE_CMD, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('timeout (5min) compactando con claude'));
    }, 300_000);
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
      resolve();
    });
  });
}

// Lee el jsonl recién compactado y devuelve la metadata del último boundary —
// para mostrarle al usuario "de Xk a Yk tokens" en vez de un simple "listo".
function _lastCompactMetadata(file) {
  const entries = scanner.parseJsonl(file);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'system' && e.subtype === 'compact_boundary') return e.compactMetadata || null;
  }
  return null;
}

// convId → true mientras un /compact está en curso. Necesario para: (1) no
// pisarlo con un /message que le mande --resume al mismo tiempo (dos procesos
// tocando la misma sesión), y (2) que el status del árbol de conversaciones
// muestre el mismo ping-dot "procesando" que ya existe para runner.running.
const compacting = new Set();

async function maybeGenerateTitle(convId, acc = activeAccount) {
  if (!GROQ_API_KEY) return;
  const last = _lastTitleAttempt.get(convId) || 0;
  if (Date.now() - last < TITLE_RETRY_MS) return;
  const metaFile = accountMetaFile(acc);
  const projDir = accountProjectsDir(acc);
  const data = meta.load(metaFile);
  const conv = data.conversations[convId];
  if (!conv || conv.name || conv.aiTitle) return;
  const file = conv.currentSessionId ? scanner.findSessionFile(conv.currentSessionId, projDir) : null;
  if (!file) return;
  const info = scanner.sessionInfo(file);
  if (!info || info.messageCount < TITLE_MIN_MSGS) return;
  _lastTitleAttempt.set(convId, Date.now());
  const messages = scanner.getMessagesIncremental(file).filter(m => m.role !== 'tool').slice(0, 6);
  const excerpt = messages.map(m => `${m.role}: ${(m.text || '').slice(0, 400)}`).join('\n\n').slice(0, 2000);
  const title = await _groqTitle(excerpt);
  if (!title) return;
  const latest = meta.load(metaFile);
  const latestConv = latest.conversations[convId];
  if (!latestConv || latestConv.name) return;
  latestConv.name = title;
  latestConv.aiTitle = true;
  meta.save(latest, metaFile);
  broadcast(convId, { kind: 'meta', name: title, aiTitle: true });
}

function resolveConv(convId, acc = activeAccount) {
  const metaFile = accountMetaFile(acc);
  const projDir = accountProjectsDir(acc);
  const data = meta.load(metaFile);
  if (data.conversations[convId]) return { data, conv: data.conversations[convId], metaFile };
  const file = scanner.findSessionFile(convId, projDir);
  if (!file) return { data, conv: null, metaFile };
  const info = scanner.sessionInfo(file);
  data.conversations[convId] = { currentSessionId: convId, projectDir: (info && info.cwd) || HOME_DIR };
  return { data, conv: data.conversations[convId], metaFile };
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
      if (err) {
        // Fallback: usar original renombrado (ej. ImageMagick no instalado)
        fs.renameSync(req.file.path, finalPath);
        return finish(finalPath);
      }
      fs.unlink(req.file.path, () => {});
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
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return res.status(404).json({ error: 'archivo no encontrado' });
  }
  if (!stat.isFile()) return res.status(400).json({ error: 'no es un archivo (¿es una carpeta?)' });
  const filename = path.basename(filePath);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const stream = fs.createReadStream(filePath);
  // Sin este listener, cualquier error de lectura (path resultó ser una
  // carpeta, permisos, disco) tira una excepción no capturada y crashea
  // todo el proceso de Jarvis — .pipe() no reenvía errores del source.
  stream.on('error', err => {
    console.error('[api/files] error leyendo', filePath, err.message);
    if (!res.headersSent) res.status(500).json({ error: 'error leyendo el archivo' });
    else res.end();
  });
  stream.pipe(res);
});

// ── "Mostrar en carpeta" — abre el Explorador en la PC donde corre Jarvis ──
// Windows nativo o WSL (con interop, que llama a explorer.exe igual). El
// botón que lo dispara se oculta en el cliente salvo que se esté navegando
// desde 127.0.0.1/localhost, pero eso es un gate de UI, no de seguridad —
// cualquiera con la cookie ACCESS_PIN puede pegarle a este endpoint igual
// (mismo modelo de confianza que el resto de la app, que ya puede correr
// comandos arbitrarios vía Claude).
app.get('/api/reveal', (req, res) => {
  if (!IS_WIN && !IS_WSL) return res.status(400).json({ error: 'solo disponible en Windows/WSL' });
  const filePath = (req.query.path || '').trim();
  if (!filePath || !path.isAbsolute(filePath)) return res.status(400).json({ error: 'path inválido' });
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return res.status(404).json({ error: 'no encontrado' });
  }
  // Bajo WSL, filePath viene en formato POSIX (/mnt/c/...) — explorer.exe
  // no lo entiende, hay que convertirlo a Windows (C:\...) con wslpath.
  let explorerPath = filePath;
  if (IS_WSL) {
    try {
      explorerPath = execFileSync('wslpath', ['-w', filePath], { encoding: 'utf8' }).trim();
    } catch {
      return res.status(500).json({ error: 'no se pudo convertir el path (wslpath)' });
    }
  }
  // 'explorer.exe' a secas depende de que el PATH del proceso incluya el
  // Windows PATH via interop de WSL — verificado en vivo que NO es
  // confiable (a veces no está, según cómo se haya lanzado el proceso). En
  // WSL usamos la ruta absoluta directo; en Windows nativo 'explorer.exe'
  // ya se resuelve solo desde System32.
  const explorerBin = IS_WSL ? '/mnt/c/Windows/explorer.exe' : 'explorer.exe';
  // Si es carpeta la abrimos directo; si es archivo, abrimos su carpeta
  // contenedora con el archivo ya seleccionado.
  const args = stat.isDirectory() ? [explorerPath] : ['/select,' + explorerPath];
  execFile(explorerBin, args, (err) => {
    // explorer.exe devuelve exit code 1 aunque abra bien (gotcha conocido
    // de Windows) — err.code es un número en ese caso, no lo tratamos como
    // error real. Un fallo real de lanzamiento (binario no encontrado,
    // permisos) trae err.code como string ('ENOENT', 'EACCES', etc.).
    if (err && typeof err.code !== 'number') {
      console.error('[api/reveal] no se pudo lanzar', explorerBin, ':', err.message);
      return res.status(500).json({ error: 'no se pudo abrir el explorador: ' + err.message });
    }
    res.json({ ok: true });
  });
});

// ── "Descargar carpeta como .zip" ──
// Complementa a /api/reveal para cuando estás lejos de la PC (celu por el
// túnel) y "abrir en la PC" no te sirve — permite bajarte la carpeta
// entera. Arma el zip al vuelo con `archiver` y lo pipea directo a la
// response, sin escribir nada a disco. A diferencia de /api/reveal, no
// tiene gate IS_WIN — armar un zip funciona en cualquier plataforma.
const MAX_ZIP_BYTES = 200 * 1024 * 1024; // 200MB, límite elegido por Diego

// Recorre la carpeta sumando tamaños de archivo y corta apenas se pasa
// del límite (no sigue bajando en carpetas gigantes) — devuelve true si
// se pasa. Symlinks se saltean (evita loops); carpetas sin permisos
// también se saltean en vez de tirar.
function folderExceedsLimit(dirPath, limitBytes) {
  let total = 0;
  const stack = [dirPath];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          continue;
        }
        if (total > limitBytes) return true;
      }
    }
  }
  return false;
}

app.get('/api/folder-zip', (req, res) => {
  const folderPath = (req.query.path || '').trim();
  if (!folderPath || !path.isAbsolute(folderPath)) return res.status(400).json({ error: 'path inválido' });
  let stat;
  try {
    stat = fs.statSync(folderPath);
  } catch {
    return res.status(404).json({ error: 'no encontrado' });
  }
  if (!stat.isDirectory()) return res.status(400).json({ error: 'no es una carpeta' });

  if (folderExceedsLimit(folderPath, MAX_ZIP_BYTES)) {
    return res.status(413).json({ error: 'carpeta muy grande (>200MB) para descargar por acá — abrila desde la PC' });
  }

  const name = path.basename(folderPath) || 'carpeta';
  res.setHeader('Content-Disposition', `attachment; filename="${name}.zip"`);
  res.setHeader('Content-Type', 'application/zip');

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', err => {
    console.error('[api/folder-zip] error armando zip', folderPath, err.message);
    if (!res.headersSent) res.status(500).json({ error: 'error armando el zip' });
    else res.end();
  });
  archive.pipe(res);
  archive.directory(folderPath, false);
  archive.finalize();
});

// ── Notas (anotador sin IA, sin sesión de Claude) ──
// Ver docs/superpowers/specs/2026-08-11-notas-jarvis-design.md
const notesUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        notes.ensureFilesDir();
        cb(null, notes.FILES_DIR);
      } catch (err) { cb(err); }
    },
    filename: (req, file, cb) => {
      cb(null, notes.resolveDestName(notes.FILES_DIR, file.originalname));
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

app.get('/api/notes', (req, res) => {
  res.json({ notes: notes.readAll() });
});

app.post('/api/notes', (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'texto vacío' });
  const entry = { id: crypto.randomUUID(), ts: Date.now(), type: 'text', text };
  notes.append(entry);
  res.status(201).json(entry);
});

app.post('/api/notes/upload', notesUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no se recibió archivo' });
  const entry = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    type: 'file',
    fileName: req.file.originalname,
    filePath: path.join(notes.FILES_DIR, req.file.filename),
    mime: req.file.mimetype || '',
    size: req.file.size,
  };
  notes.append(entry);
  res.status(201).json(entry);
});

// ── Mail (panel Kanban Pendiente/Respondido/Archivado) ──
// El escaneo real de las bandejas lo hace un job de Claude Code CLI (mismo
// mecanismo que un mensaje de chat normal, vía runner), porque solo esa
// sesión tiene las tools MCP de Gmail/Microsoft 365 — Express no. Se encola
// con un convId fijo dedicado para que no aparezca en la lista de
// conversaciones normales del usuario.

// Pausado 15/08/2026 a pedido de Fernando — no está seguro de si le va a
// servir la función y no quiere que gaste nada mientras lo piensa. Este flag
// corta las 4 acciones que disparan un job (cada una cuesta tokens) ANTES de
// llegar a runner.send, así que la garantía de $0 es real, no solo "no lo
// uses". Los mails ya escaneados siguen visibles (leer no cuesta nada).
// Para reactivar: poner en false, no hace falta tocar nada más — el front ya
// reacciona solo al campo `paused` que viaja en GET /api/mail.
const MAIL_FEATURE_PAUSED = true;

const MAIL_SCAN_CONV_ID = '__mail-scan__';
const MAIL_VALID_STATES = new Set(['pendiente', 'respondido', 'archivado']);
// Hilo de conversación por mail (pedido de borrador / envío): un convId
// dedicado por mail, MAIL_THREAD_PREFIX + item.id, para que --resume vaya
// acumulando contexto entre "pedí un borrador" → "hacelo más corto" → "mandalo".
// mailJobKind recuerda si el job en curso de cada hilo es 'draft' o 'send' —
// puramente en memoria del proceso: si el server se reinicia a mitad de un
// job se pierde (aceptable para v1, el usuario simplemente vuelve a pedir).
const MAIL_THREAD_PREFIX = 'mail-thread-';
const mailJobKind = new Map(); // convId → 'draft'|'send'
// sessionId del último job de escaneo — puramente en memoria, como
// mailJobKind. Solo se usa para ir a buscar el motivo real de un escaneo
// fallido (ver handleMailScanIdle); si el server se reinicia a mitad de un
// escaneo, en el peor caso el error queda con el mensaje genérico.
let mailScanSessionId = null;
// Guardarraíl: si el job de escaneo se cuelga (una tool MCP que nunca
// responde, por ejemplo) no hay nada que lo corte solo — runner.js no tiene
// timeout propio. Sin esto, "scanning" queda en true para siempre y el panel
// se queda mostrando "Escaneando..." sin límite hasta reiniciar el server a mano.
const MAIL_SCAN_TIMEOUT_MS = 5 * 60 * 1000; // 5 min: de sobra para 2 bandejas con Haiku
let mailScanTimeoutTimer = null;
let mailScanTimedOut = false; // para que handleMailScanIdle sepa distinguir timeout de error real
const MAIL_SCAN_PROMPT = `Escaneá la bandeja de entrada de dos cuentas de correo usando las herramientas MCP disponibles:
1. Gmail de ferzepsas@gmail.com (herramientas mcp__claude_ai_Gmail__*) — buscá no leídos y los últimos 3 días.
2. Outlook de hys@maximia.com.ar (herramientas mcp__claude_ai_Microsoft_365__*) — buscá no leídos y los últimos 3 días.

Para cada mail relevante (ignorá spam/promociones/notificaciones automáticas obvias) generá:
- from: remitente (nombre o email)
- subject: asunto
- summary: resumen de UNA línea en español de qué pide o informa
- body: el cuerpo completo del mail en texto plano y legible (sin HTML ni firmas/disclaimers largos), truncado a los primeros 4000 caracteres si es muy largo
- project: a qué proyecto de FERZEP/Maximia/ControlApps pertenece si es identificable (o "" si no aplica), usando como referencia las carpetas descriptas en /mnt/c/Users/Fernando/Desktop/claude/CLAUDE.md
- urgent: true si pide una acción con plazo concreto o parece importante, false si no
- receivedAt: fecha ISO del mail
- messageId y threadId: los que corresponda según la cuenta (para Gmail: id de mensaje/thread; para Outlook: id del mensaje)
- account: "ferzepsas" o "maximia" según corresponda
- id: un string único, por ejemplo \`\${account}-\${messageId}\`

NO envíes ni respondas ningún mail, esto es solo lectura y clasificación. NO
incluyas el campo "state" — el panel decide el estado, no vos.

Escribí el resultado con la tool Write, sobrescribiendo el archivo ~/.ccm-notes/mail.scan.json (creá el directorio si no existe, es un archivo de staging separado de mail.json — NO toques mail.json) con este JSON exacto:
{"items": [ ... ] }

No respondas con texto largo de más, tu tarea termina cuando el archivo quedó escrito correctamente.`;

app.get('/api/mail', (req, res) => {
  res.json({ ...mail.read(), paused: MAIL_FEATURE_PAUSED });
});

app.post('/api/mail/scan', (req, res) => {
  if (MAIL_FEATURE_PAUSED) return res.status(403).json({ error: 'La función de Mail está en pausa.', paused: true });
  if (runner.isBusy(MAIL_SCAN_CONV_ID)) return res.status(409).json({ error: 'ya hay un escaneo en curso' });
  mail.setScanning(true);
  const cwd = process.env.CCM_DEFAULT_PROJECT_DIR || accountHomeDir(activeAccount);
  // Haiku: es clasificación/resumen en bulk (2 bandejas, no leídos + 3 días),
  // no necesita razonamiento fuerte — más rápido y barato que el default.
  runner.send({ convId: MAIL_SCAN_CONV_ID, text: MAIL_SCAN_PROMPT, account: activeAccount, cwd, model: 'haiku' });
  clearTimeout(mailScanTimeoutTimer);
  mailScanTimedOut = false;
  mailScanTimeoutTimer = setTimeout(() => {
    mailScanTimedOut = true;
    runner.cancel(MAIL_SCAN_CONV_ID);
  }, MAIL_SCAN_TIMEOUT_MS);
  res.json({ ok: true, started: true });
});

app.patch('/api/mail/:id', (req, res) => {
  const state = req.body.state;
  if (!MAIL_VALID_STATES.has(state)) return res.status(400).json({ error: 'estado inválido' });
  const item = mail.setState(req.params.id, state);
  if (!item) return res.status(404).json({ error: 'mail no encontrado' });
  res.json(item);
});

// Un solo item — lo usa el frontend para pollear la tarjeta expandida sin
// re-renderizar las otras 25 mientras espera un draft/send.
app.get('/api/mail/:id', (req, res) => {
  const item = mail.read().items.find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'mail no encontrado' });
  res.json(item);
});

// Pide un borrador (o un ajuste sobre el borrador existente) para un mail.
// Primer pedido: arma el prompt con todo el contexto (cuenta, remitente,
// asunto, cuerpo completo). Pedidos siguientes: --resume de la misma sesión,
// solo manda la instrucción nueva. Nunca manda nada — solo redacta texto.
app.post('/api/mail/:id/draft', (req, res) => {
  if (MAIL_FEATURE_PAUSED) return res.status(403).json({ error: 'La función de Mail está en pausa.', paused: true });
  const item = mail.read().items.find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'mail no encontrado' });
  const convId = MAIL_THREAD_PREFIX + item.id;
  if (runner.isBusy(convId)) return res.status(409).json({ error: 'ya hay un pedido en curso para este mail' });

  const instruction = (req.body && req.body.instruction) || '';
  const RULE = 'NO envíes nada todavía, solo redactá el texto de la respuesta en español, directo, sin explicaciones tuyas alrededor — tu mensaje final tiene que ser SOLO el texto del mail de respuesta, listo para mandar tal cual, nada de "Acá tenés el borrador:" ni comentarios editoriales.';
  let prompt;
  if (!item.threadSessionId) {
    const label = item.account === 'maximia' ? 'maximia (hys@maximia.com.ar, Outlook)' : 'ferzepsas (ferzepsas@gmail.com, Gmail)';
    const body = item.body || item.summary || '(sin contenido)';
    prompt = `Vas a redactar una respuesta a este mail.\n\nCuenta: ${label}\nDe: ${item.from}\nAsunto: "${item.subject}"\nFecha: ${item.receivedAt || ''}\n\nCuerpo del mail:\n${body}\n\n${instruction || 'Armá un primer borrador razonable de respuesta.'}\n\n${RULE}`;
  } else {
    prompt = `${instruction || 'Armá un primer borrador razonable de respuesta.'}\n\n${RULE}`;
  }

  mail.setDraft(item.id, { draftPending: true });
  mailJobKind.set(convId, 'draft');
  const cwd = process.env.CCM_DEFAULT_PROJECT_DIR || accountHomeDir(activeAccount);
  runner.send({ convId, text: prompt, sessionId: item.threadSessionId || undefined, account: activeAccount, cwd });
  res.json({ ok: true, started: true });
});

// Trae el texto ORIGINAL del mail, tal cual está en el servidor de correo —
// a diferencia de item.body (lo escribe el job de escaneo, hoy con Haiku,
// "limpio y legible" para la tarjeta — no garantiza ser palabra por palabra
// igual al original). Pedido de Fernando: quiere poder confirmar qué se
// escribió de verdad, no una versión reformulada. Comparte el mismo hilo
// (MAIL_THREAD_PREFIX + id) que draft/send así reusa threadSessionId si ya
// existe; sin `model` a propósito — el default (Sonnet) es más confiable que
// Haiku para seguir al pie de la letra una instrucción de "no cambies nada".
app.post('/api/mail/:id/raw', (req, res) => {
  if (MAIL_FEATURE_PAUSED) return res.status(403).json({ error: 'La función de Mail está en pausa.', paused: true });
  const item = mail.read().items.find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'mail no encontrado' });
  const convId = MAIL_THREAD_PREFIX + item.id;
  if (runner.isBusy(convId)) return res.status(409).json({ error: 'ya hay un pedido en curso para este mail' });

  const label = item.account === 'maximia' ? 'maximia (hys@maximia.com.ar, Outlook, tools mcp__claude_ai_Microsoft_365__*)' : 'ferzepsas (ferzepsas@gmail.com, Gmail, tools mcp__claude_ai_Gmail__*)';
  const prompt = `Buscá el mail original con messageId "${item.messageId}"${item.threadId ? ` (threadId "${item.threadId}")` : ''} en la cuenta ${label} y traé su cuerpo TAL CUAL está escrito — texto plano, sin resumir, sin reformular, sin sacar ni agregar nada (podés sacar el HTML/firmas de cadena si hace mucho ruido, pero el texto humano tiene que quedar palabra por palabra igual al original). Tu respuesta final tiene que ser SOLO ese texto, sin comentarios tuyos alrededor ni "Acá está el mail:".`;

  mail.setDraft(item.id, { rawBodyPending: true });
  mailJobKind.set(convId, 'raw');
  const cwd = process.env.CCM_DEFAULT_PROJECT_DIR || accountHomeDir(activeAccount);
  runner.send({ convId, text: prompt, sessionId: item.threadSessionId || undefined, account: activeAccount, cwd });
  res.json({ ok: true, started: true });
});

// Manda el draft ya guardado tal cual (sin reescribirlo) como reply al mail
// original. Solo se llama desde el botón explícito "Confirmar y enviar" —
// nunca por texto libre del usuario.
app.post('/api/mail/:id/send', (req, res) => {
  if (MAIL_FEATURE_PAUSED) return res.status(403).json({ error: 'La función de Mail está en pausa.', paused: true });
  const item = mail.read().items.find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'mail no encontrado' });
  if (!item.draft) return res.status(400).json({ error: 'no hay borrador para mandar' });
  if (!item.threadSessionId) return res.status(400).json({ error: 'todavía no se generó una conversación con Claude sobre este mail' });
  const convId = MAIL_THREAD_PREFIX + item.id;
  if (runner.isBusy(convId)) return res.status(409).json({ error: 'ya hay un pedido en curso para este mail' });

  const prompt = `Mandá exactamente este texto como respuesta al mail original (cuenta ${item.account}, threadId/messageId: ${item.threadId}/${item.messageId}), usando la tool de responder/enviar que corresponda (Gmail si es ferzepsas, Outlook si es maximia). No cambies ni una palabra del texto. Después de mandarlo confirmá en una sola línea qué pasó.\n\n---\n${item.draft}\n---`;

  mail.setDraft(item.id, { draftPending: true });
  mailJobKind.set(convId, 'send');
  const cwd = process.env.CCM_DEFAULT_PROJECT_DIR || accountHomeDir(activeAccount);
  runner.send({ convId, text: prompt, sessionId: item.threadSessionId, account: activeAccount, cwd });
  res.json({ ok: true, started: true });
});

// Al terminar el job de escaneo: mergeamos lo que haya en el staging file
// (mail.mergeScan ya deja lastScanError seteado con un mensaje genérico si
// no encontró nada para mergear). Si falló, intentamos reemplazar ese
// genérico por el último mensaje real del LLM — normalmente algo como "las
// tools de Gmail/Outlook no están disponibles en esta sesión", mucho más
// útil para saber qué pasó que un genérico "revisá el MCP".
async function handleMailScanIdle(s) {
  const result = mail.mergeScan();
  // Lo cortamos nosotros por el guardarraíl de MAIL_SCAN_TIMEOUT_MS (una
  // tool MCP se quedó sin responder) — mensaje específico, no tiene sentido
  // ir a buscar el último texto del LLM porque lo matamos a mitad de frase.
  if (mailScanTimedOut) {
    mailScanTimedOut = false;
    mail.setScanError(`El escaneo tardó más de ${MAIL_SCAN_TIMEOUT_MS / 60000} minutos y se canceló solo (probablemente una tool de Gmail/Outlook se quedó sin responder). Probá de nuevo — si se repite, revisá que los conectores estén activos.`);
    return;
  }
  if (!result.lastScanError || !mailScanSessionId) return;
  const file = scanner.findSessionFile(mailScanSessionId, accountProjectsDir(s.account || activeAccount));
  if (!file) return;
  const assistantMsgs = scanner.getMessagesIncremental(file).filter(m => m.role === 'assistant');
  const last = assistantMsgs[assistantMsgs.length - 1];
  if (last && last.text) mail.setScanError(last.text.slice(0, 500));
}

// Al terminar un job de hilo de mail (draft o send) leemos el último mensaje
// assistant directo del jsonl de la sesión — el job no escribe el resultado a
// mano en mail.json, así que lo sacamos nosotros del historial ya persistido
// por el CLI (mismo mecanismo que usa el resto de la app para leer sesiones).
async function handleMailThreadIdle(s) {
  const mailId = s.convId.slice(MAIL_THREAD_PREFIX.length);
  const kind = mailJobKind.get(s.convId);
  mailJobKind.delete(s.convId);
  // 'raw' apaga rawBodyPending, no draftPending — todo lo demás ('send' o
  // 'draft', y el default ante un Map perdido por reinicio) apaga draftPending.
  const pendingField = kind === 'raw' ? 'rawBodyPending' : 'draftPending';

  const item = mail.read().items.find(i => i.id === mailId);
  if (!item || !item.threadSessionId) {
    mail.setDraft(mailId, { [pendingField]: false, sendResult: 'No se encontró la sesión del hilo — revisá manualmente.' });
    return;
  }

  const file = scanner.findSessionFile(item.threadSessionId, accountProjectsDir(s.account || activeAccount));
  let text = '(no se pudo leer la respuesta — revisá manualmente)';
  if (file) {
    const assistantMsgs = scanner.getMessagesIncremental(file).filter(m => m.role === 'assistant');
    const last = assistantMsgs[assistantMsgs.length - 1];
    if (last && last.text) text = last.text;
  }

  if (kind === 'send') {
    mail.setDraft(mailId, { draftPending: false, sendResult: text, sentAt: new Date().toISOString() });
    // Solo pasa a "respondido" si el proceso terminó bien — si terminó con
    // error lo dejamos en "pendiente" para que el usuario lo note y reintente,
    // nunca lo damos por mandado sin confirmación real.
    if (s.code === 0) mail.setState(mailId, 'respondido');
  } else if (kind === 'raw') {
    mail.setDraft(mailId, { rawBody: text, rawBodyPending: false });
  } else {
    // kind === 'draft' (o se perdió el Map por un reinicio a mitad de job:
    // ante la duda tratamos como draft, nunca marcamos enviado sin certeza).
    mail.setDraft(mailId, { draft: text, draftPending: false });
  }
}

const DEFAULT_TREE_LIMIT = 100;
const MAX_TREE_LIMIT = 500;

app.get('/api/tree', (req, res) => {
  const acc = req.query.account || activeAccount;
  const data = meta.load(accountMetaFile(acc));
  const sessions = scanner.listSessions(accountProjectsDir(acc));
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
    if (c.hidden) continue;
    const s = byId.get(c.currentSessionId) || {};
    convs.push({
      convId,
      projectDir: c.projectDir,
      // Carpeta real donde vive la sesión ahora mismo (puede diferir de projectDir,
      // que queda anclado a home a propósito — ver /conversations POST). Sirve
      // solo para mostrar en el header del chat, no para agrupar en el sidebar.
      currentDir: s.cwd || c.projectDir,
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
      status: (runner.running.has(convId) || compacting.has(convId)) ? 'running' : (runner.isBusy(convId) ? 'queued' : 'idle'),
    });
  }
  for (const s of sessions) {
    if (referenced.has(s.sessionId) || data.conversations[s.sessionId]) continue;
    convs.push({
      convId: s.sessionId,
      projectDir: s.cwd || '(desconocido)',
      currentDir: s.cwd || '(desconocido)',
      name: s.snippet,
      snippet: s.snippet,
      lastActivity: s.lastActivity,
      messageCount: s.messageCount,
      model: null,
      lastModel: s.lastModel || null,
      pinned: false,
      archived: false,
      contextPct: contextPctFor(s),
      status: (runner.running.has(s.sessionId) || compacting.has(s.sessionId)) ? 'running' : (runner.isBusy(s.sessionId) ? 'queued' : 'idle'),
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
  res.json({ tree, hasMore, total, limit, archivedTotal, account: acc });
});

app.get('/api/search', (req, res) => {
  const acc = req.query.account || activeAccount;
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.json({ results: [] });
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  const results = scanner.searchSessions(q, { limit, projectsDir: accountProjectsDir(acc) });
  // Anotar convId real (si existe conversación con nombre custom) para poder abrirla.
  const data = meta.load(accountMetaFile(acc));
  const bySessionId = new Map();
  for (const [convId, c] of Object.entries(data.conversations)) {
    bySessionId.set(c.currentSessionId, { convId, name: c.name });
  }
  const enriched = results.map(r => {
    const ref = bySessionId.get(r.sessionId);
    const convId = ref ? ref.convId : r.sessionId;
    const conv = data.conversations[convId];
    return {
      ...r,
      convId,
      displayName: (ref && ref.name) || r.name,
      model: conv ? conv.model : null,
      lastModel: conv ? conv.lastModel : r.lastModel,
    };
  });
  res.json({ results: enriched });
});

app.get('/api/conversations/:id/usage', (req, res) => {
  const empty = { total: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, byModel: {}, costUSD: 0, contextTokens: 0, contextWindow: 200_000, contextPct: 0 };
  const acc = req.query.account || activeAccount;
  const { conv } = resolveConv(req.params.id, acc);
  if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
  if (!conv.currentSessionId) return res.json(empty);
  const file = scanner.findSessionFile(conv.currentSessionId, accountProjectsDir(acc));
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
  const acc = req.query.account || activeAccount;
  const projDir = accountProjectsDir(acc);
  const { conv } = resolveConv(req.params.id, acc);
  if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
  const out = [];
  if (conv.compactedFromSession) {
    const oldFile = scanner.findSessionFile(conv.compactedFromSession, projDir);
    if (oldFile) {
      for (const m of scanner.getMessagesIncremental(oldFile)) out.push({ ...m, compacted: true });
    }
  }
  if (conv.currentSessionId) {
    const file = scanner.findSessionFile(conv.currentSessionId, projDir);
    if (file) {
      for (const m of scanner.getMessagesIncremental(file)) out.push(m);
    }
  }
  res.json(out);
});

app.post('/api/conversations/:id/message', (req, res) => {
  const convId = req.params.id;
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'mensaje vacío' });
  if (runner.isBusy(convId)) return res.status(409).json({ error: 'esa conversación ya está procesando un mensaje' });
  if (compacting.has(convId)) return res.status(409).json({ error: 'esa conversación se está compactando' });
  const acc = req.body.account || activeAccount;
  const { data, conv, metaFile } = resolveConv(convId, acc);
  if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
  let outgoing = text;
  if (conv.compactedSummary && !conv.currentSessionId) {
    outgoing = `[Resumen del contexto previo — la conversación fue compactada]\n${conv.compactedSummary}\n\n[Mensaje actual del usuario]\n${text}`;
    delete conv.compactedSummary;
    delete conv.compactedAt;
  }
  meta.save(data, metaFile);
  // Las conversaciones "VPS: <proyecto>" no tienen una carpeta local real —
  // conv.projectDir ahí es solo metadata para agrupar/mostrar, no un cwd válido.
  // Para el resto, no confiamos ciegamente en conv.projectDir: si Claude entró a un
  // git worktree a mitad de charla, la sesión quedó reubicada a otra carpeta de
  // proyecto y projectDir quedó desactualizado — resolveCwd busca dónde vive
  // realmente la sesión ahora.
  const cwd = (conv.projectDir || '').startsWith('VPS: ') ? accountHomeDir(acc) : scanner.resolveCwd(conv, accountProjectsDir(acc));
  runner.send({ convId, sessionId: conv.currentSessionId, cwd, text: outgoing, model: conv.model, account: acc });
  res.status(202).json({ queued: true });
});

app.post('/api/conversations/:id/compact', (req, res) => {
  const convId = req.params.id;
  if (runner.isBusy(convId)) return res.status(409).json({ error: 'esa conversación está procesando un mensaje' });
  if (compacting.has(convId)) return res.status(409).json({ error: 'ya se está compactando esta conversación' });
  const acc = req.body.account || activeAccount;
  const projDir = accountProjectsDir(acc);
  const { conv } = resolveConv(convId, acc);
  if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
  if (!conv.currentSessionId) return res.status(400).json({ error: 'la conversación no tiene sesión activa' });
  const file = scanner.findSessionFile(conv.currentSessionId, projDir);
  if (!file) return res.status(404).json({ error: 'archivo de sesión no encontrado' });
  const messages = scanner.getMessagesIncremental(file).filter(m => m.role === 'user' || m.role === 'assistant');
  if (messages.length < 2) return res.status(400).json({ error: 'nada útil para compactar (menos de 2 mensajes)' });

  // La compactación real puede tardar bastante en sesiones largas — justo el
  // caso que más lo necesita — y una respuesta HTTP colgada esperando eso corre
  // el mismo riesgo que ya documentamos para /stream: el túnel Cloudflare corta
  // conexiones idle. Por eso responde 202 al toque y hace el trabajo en
  // background, avisando por el mismo canal SSE que ya usan los mensajes
  // normales (heartbeat cada 20s incluido).
  const cwd = (conv.projectDir || '').startsWith('VPS: ') ? accountHomeDir(acc) : scanner.resolveCwd(conv, projDir);
  compacting.add(convId);
  broadcast(convId, { kind: 'status', status: 'running' });
  _claudeCompact(conv.currentSessionId, cwd)
    .then(() => {
      compacting.delete(convId);
      const cm = _lastCompactMetadata(file);
      if (!cm) console.warn('[compact] terminó sin error pero no encontré el compact_boundary en el jsonl:', file);
      broadcast(convId, { kind: 'compacted', ...cm });
      broadcast(convId, { kind: 'status', status: 'idle', code: 0 });
    })
    .catch(err => {
      compacting.delete(convId);
      console.error('[compact] falló:', err.message);
      broadcast(convId, { kind: 'status', status: 'idle', code: -1, stderr: 'No se pudo compactar: ' + err.message });
    });
  res.status(202).json({ queued: true });
});

// Rebobinar: elimina un turno user y todo lo posterior del jsonl de la sesión.
// Ver scanner.rewindSessionFile para el porqué de que esto es seguro (cadena
// parentUuid estilo git, cortada en borde de turno). Es rápido (reescritura
// local del archivo), así que responde sincrónico — no necesita el baile de
// 202+SSE del compact.
app.post('/api/conversations/:id/rewind', (req, res) => {
  const convId = req.params.id;
  const uuid = (req.body.uuid || '').trim();
  if (!uuid) return res.status(400).json({ error: 'falta uuid del mensaje' });
  if (runner.isBusy(convId)) return res.status(409).json({ error: 'esa conversación está procesando un mensaje' });
  if (compacting.has(convId)) return res.status(409).json({ error: 'esa conversación se está compactando' });
  const acc = req.body.account || activeAccount;
  const { conv } = resolveConv(convId, acc);
  if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
  if (!conv.currentSessionId) return res.status(400).json({ error: 'la conversación no tiene sesión activa' });
  const file = scanner.findSessionFile(conv.currentSessionId, accountProjectsDir(acc));
  if (!file) return res.status(404).json({ error: 'archivo de sesión no encontrado' });
  let result;
  try { result = scanner.rewindSessionFile(file, uuid); }
  catch (err) { return res.status(500).json({ error: 'no se pudo rebobinar: ' + err.message }); }
  if (!result) return res.status(400).json({ error: 'no se puede rebobinar ahí (mensaje no encontrado en la sesión actual, o dejaría la conversación vacía)' });
  broadcast(convId, { kind: 'status', status: 'idle', code: 0 });
  res.json({ ok: true, removed: result.removed });
});

app.post('/api/conversations', (req, res) => {
  const { text, model } = req.body;
  const acc = req.body.account || activeAccount;
  // Sin projectDir explícito: la conversación queda anclada a home (no hay
  // "carpeta elegida" que mostrar/agrupar, y tampoco hace falta un mensaje
  // de navegación — ya arranca ahí).
  const projectDir = req.body.projectDir || process.env.CCM_DEFAULT_PROJECT_DIR || accountHomeDir(acc);
  const metaFile = accountMetaFile(acc);
  const convId = crypto.randomUUID();
  const data = meta.load(metaFile);
  data.conversations[convId] = { currentSessionId: null, projectDir, model: model || undefined };
  meta.save(data, metaFile);
  // cwd = projectDir (CCM_DEFAULT_PROJECT_DIR si está seteado, si no home del
  // usuario): así la sesión arranca leyendo el CLAUDE.md y la memoria de esa
  // carpeta, igual que una sesión interactiva normal. Antes esto ignoraba
  // CCM_DEFAULT_PROJECT_DIR y siempre usaba accountHomeDir(acc) sin importar
  // lo que projectDir hubiera resuelto arriba.
  // Si no vino texto (se dejó sin destino explícito) no hace falta mandar un
  // primer mensaje — la conversación queda vacía, lista para escribir.
  if ((text || '').trim()) {
    runner.send({ convId, sessionId: null, cwd: projectDir, text: text.trim(), model: model || undefined, account: acc });
  }
  res.status(201).json({ convId, projectDir });
});

app.patch('/api/conversations/:id', (req, res) => {
  const acc = req.body.account || activeAccount;
  const { data, conv, metaFile } = resolveConv(req.params.id, acc);
  if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
  if ('name' in req.body) {
    conv.name = (req.body.name || '').trim() || undefined;
    conv.aiTitle = false;
  }
  if ('model' in req.body) conv.model = (req.body.model || '').trim() || undefined;
  if ('pinned' in req.body) conv.pinned = !!req.body.pinned;
  if ('archived' in req.body) conv.archived = !!req.body.archived;
  // hidden: saca la conversación de las dos listas (activas y archivadas) sin
  // tocar el .jsonl real — a diferencia de un borrado, es reversible a mano
  // editando meta.json si hiciera falta.
  if ('hidden' in req.body) conv.hidden = !!req.body.hidden;
  meta.save(data, metaFile);
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
  // Cloudflare Tunnel corta conexiones SSE inactivas (~100s de idle).
  // Sin este ping, un turno largo de Claude sin output deja el stream mudo
  // y el edge lo mata a mitad de camino, perdiendo el evento 'idle' final.
  const heartbeat = setInterval(() => res.write(':heartbeat\n\n'), 20000);
  req.on('close', () => {
    clearInterval(heartbeat);
    const set = sseClients.get(convId);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) sseClients.delete(convId);
  });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Claude Chat Manager en http://${HOST}:${PORT}`);
});

// Cloudflare Tunnel mantiene conexiones al origin en su pool y las reutiliza
// hasta ~100s de idle (mismo límite que ya documentamos arriba para SSE) —
// pero el keepAliveTimeout default de Node es de solo 5s. Si cloudflared
// reutiliza un socket que Node ya cerró en esa ventana de 5-100s, la request
// falla del lado del túnel con "context canceled"/"Failed to proxy HTTP" sin
// relación con el tamaño o tipo de request — es pura carrera entre los dos
// timeouts. Visto en jarvis-tunnel-err.log: ~50 cortes en una hora, cada
// 30-90s, constante, sin importar si había tráfico activo o no. Alineamos el
// timeout de Node por encima del límite del túnel para que Node nunca cierre
// primero. headersTimeout tiene que ser mayor a keepAliveTimeout (Node lo
// exige internamente).
server.keepAliveTimeout = 110_000;
server.headersTimeout = 115_000;
