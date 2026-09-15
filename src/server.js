const express = require('express');
const compression = require('compression');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, execFileSync, exec, spawn } = require('child_process');
const { createFilesRouter } = require('./routes/files');
const { createScansRouter } = require('./routes/scans');
const scanner = require('./scanner');
const notes = require('./notes');
const { createNotesRouter } = require('./routes/notes');
const agendaRouter = require('./routes/agenda');
const meta = require('./meta');
const config = require('./config');
const icon = require('./icon');
const { Runner } = require('./runner');
const { CLAUDE_CMD } = require('./claude-cmd');
const { CodexRunner } = require('./codex-runner');
const { createCodexRouter } = require('./routes/codex');
const { GeminiRunner } = require('./gemini-runner');
const { createGeminiRouter, createAntigravityRouter } = require('./routes/gemini');
const { createSalaRouter } = require('./routes/sala');
const { createConversationsRouter, resolveConversationGitRepo } = require('./routes/conversations');
const {
  projectEntry,
  registerProject,
  projectsWithCounts,
  hiddenProjectNames,
  createProjectsRouter,
} = require('./routes/projects');
const codexScanner = require('./codex-scanner');
const geminiScanner = require('./gemini-scanner');
const searchIndex = require('./search-index');
const { getReplySuggestions } = require('./groq-suggest');
const gitSync = require('./git-sync');
const salaClient = require('./sala-client');
const { buildContextBlock, isMentioned, mentionNotice } = require('./sala-context');

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
// Nombre mostrado en título/manifest/PWA/toasts. Prioridad: lo guardado desde
// la pantalla de Configuración (~/.ccm-config.json) > env var CCM_APP_NAME >
// default genérico. Se lee del archivo en cada request (no una constante al boot) para
// que guardar desde la UI aplique sin reiniciar el server.
function getAppName() {
  const name = (config.load().appName || '').trim();
  return name || process.env.CCM_APP_NAME || 'Claude Chat Manager';
}

// Tu propio nombre (no el del agente) — usado para etiquetar tus mensajes
// cuando copiás una conversación en "modo conversación" desde el chat.
// Mismo patrón de prioridad que getAppName(): config guardada > env var > default.
function getUserName() {
  const name = (config.load().userName || '').trim();
  return name || process.env.CCM_USER_NAME || 'Vos';
}

// API key de Groq para las respuestas sugeridas debajo del último mensaje de
// Claude (ver /api/suggest-replies más abajo). Mismo patrón de prioridad que
// getAppName()/getUserName(): config guardada > env var > sin key (la
// feature queda apagada en silencio, getReplySuggestions ya contempla eso).
function getGroqApiKey() {
  const key = (config.load().groqApiKey || '').trim();
  return key || process.env.GROQ_API_KEY || '';
}

// URL y token del servicio sala-jarvis (VPS) — mismo patrón de prioridad que
// getGroqApiKey(): config guardada en Configuración > env var > vacío. Sin
// salaUrl configurada, la pestaña Sala se muestra pero avisa que falta
// configurar (ver /api/sala/rooms más abajo).
function getSalaUrl() {
  const url = (config.load().salaUrl || '').trim();
  return url || process.env.SALA_URL || '';
}

function getSalaToken() {
  const token = (config.load().salaToken || '').trim();
  return token || process.env.SALA_TOKEN || '';
}

// Versión mostrada en la pantalla de Configuración. Se lee de package.json
// (bump manual a mano en cada release) en cada request, no en una constante
// al boot, mismo motivo que getAppName().
function getAppVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || '';
  } catch {
    return '';
  }
}

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || os.homedir();

// Color de identidad de esta instancia: pinta --accent en toda la UI, el
// theme_color del manifest y el círculo de los íconos de la PWA (ver
// icon.js). Mismo patrón que getAppName(): se lee del archivo en cada
// request, default = el verde original de la app.
const DEFAULT_APP_COLOR = '#25d366';
function getAppColor() {
  const color = (config.load().appColor || '').trim();
  return icon.isValidColor(color) ? color : DEFAULT_APP_COLOR;
}

// Cache en disco (no en public/, que es del repo) de los íconos regenerados
// para el color actual. Se regeneran al guardar un color nuevo desde
// Configuración; serveIcon() de más abajo cae al PNG original del repo si
// todavía no se generó ninguno (instalación nueva).
const ICON_CACHE_DIR = path.join(HOME_DIR, '.ccm-icons');
// Devuelve true/false (no tira) para que el caller pueda avisarle al
// usuario si falló — antes quedaba solo en el log del server, invisible
// desde la UI, y el toast decía "guardado" igual aunque ImageMagick no
// esté en el PATH de esta cuenta de Windows (gotcha real: se instaló en el
// PATH de usuario de `User`, no machine-wide — otra cuenta como `locti` no
// lo ve).
function regenerateIconsSafe(color) {
  try {
    icon.regenerateIcons(color, ICON_CACHE_DIR, { magickCmd: MAGICK_CMD, magickArgs });
    return true;
  } catch (e) {
    console.error('No se pudo regenerar el ícono PWA:', e.message);
    return false;
  }
}
// Al boot: si hay un color guardado de una sesión anterior pero el cache de
// íconos no está (primera vez que corre esta versión, o se borró a mano),
// regenerarlo — si no, serveIcon() serviría el verde default hasta el
// próximo cambio de color desde Configuración.
{
  const savedColor = (config.load().appColor || '').trim();
  if (icon.isValidColor(savedColor) && !fs.existsSync(path.join(ICON_CACHE_DIR, icon.iconFileName(512)))) {
    regenerateIconsSafe(savedColor);
  }
}

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

// ── Índice de búsqueda ──
// Se abre acá y se sincroniza en background: el backfill de la primera vez
// recorre todo el historial, así que arrancar el server no puede depender de
// que termine. Si el Node de esta máquina no trae node:sqlite, `index` queda
// null y /api/search cae al scan lineal de scanner.js.
const SEARCH_DB = process.env.CCM_SEARCH_DB || path.join(HOME_DIR, '.ccm-search.db');
let index = null;
try {
  index = searchIndex.openIndex(SEARCH_DB);
} catch (e) {
  console.error('[search] índice no disponible, se usa el scan lineal:', e.message);
}

// Las libretas viven en el HOME del proceso (~/.ccm-notes), no dentro de cada
// cuenta de Claude como los chats — o sea que son las mismas se mire la cuenta
// que se mire. Van con su propio scope: indexarlas una vez por cuenta las haría
// rebotar de dueño en cada sync (el path es único en el índice).
const NOTES_ACCOUNT = '__local__';

// Un sync a la vez por cuenta: el timer y el sync disparado al terminar un
// turno pueden pisarse, y dos backfills en paralelo sobre la misma base solo
// duplican trabajo.
const syncing = new Set();

async function syncSearchIndex(acc, { reason = 'timer' } = {}) {
  if (!index || syncing.has(acc)) return;
  syncing.add(acc);
  const t0 = Date.now();
  try {
    // Las sesiones de Sala corren con el mismo runner y el mismo cwd que un
    // chat normal (ver /api/sala/rooms/:id/message) — a nivel archivo son
    // indistinguibles, así que sin esto su contenido aparecería en la
    // Búsqueda como si fuera un chat cualquiera. Viven en SALA_META_FILE,
    // no en accountMetaFile, a propósito (ver docs/superpowers/specs/
    // 2026-09-07-sala-compartida-design.md).
    const salaSessionIds = new Set(
      Object.values(meta.load(SALA_META_FILE).conversations)
        .map(c => c.currentSessionId)
        .filter(Boolean)
    );
    const chats = await index.syncChats(accountProjectsDir(acc), acc, { excludeSessionIds: salaSessionIds });
    const notebooks = notes.listNotebooks().map(nb => ({
      id: nb.id, name: nb.name, file: notes.notebookNotesFile(nb.id),
    }));
    const notas = await index.syncNotes(notebooks, NOTES_ACCOUNT);
    // Solo logueamos cuando hubo trabajo real — si no, cada tick del timer
    // ensuciaría el log con "0 indexados".
    if (chats.indexed || chats.removed || notas.indexed || notas.removed) {
      console.log(`[search] sync ${acc} (${reason}): ${chats.indexed} chats, ${notas.indexed} notas, ${chats.removed + notas.removed} bajas, ${Date.now() - t0}ms`);
    }
  } catch (e) {
    console.error('[search] sync falló:', e.message);
  } finally {
    syncing.delete(acc);
  }
}

const SEARCH_SYNC_MS = 60_000;
// Más seguido que el índice de búsqueda a propósito — una mención quiere
// sentirse como "el otro te contestó al toque", no como background sync.
const SALA_MENTION_POLL_MS = 20_000;


const app = express();
// Comprimido global, EXCEPTO las rutas SSE (/stream): compression bufferea en
// zlib antes de flushear, lo que rompería el heartbeat de 20s que ya existe
// para evitar que Cloudflare Tunnel corte esas conexiones por inactividad
// (~100s) — ver "Bug resuelto 2026-07-20: mensajes que desaparecían" en
// CLAUDE.local.md. No comprimir SSE es estándar (no ganan casi nada igual,
// son eventos chicos), así que excluirlas no cuesta nada.
app.use(compression({
  filter: (req, res) => !req.path.endsWith('/stream') && compression.filter(req, res),
}));
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
    appName: getAppName(),
    appColor: getAppColor(),
    userName: getUserName(),
    groqApiKeySet: !!getGroqApiKey(),
    salaUrl: getSalaUrl(),
    salaTokenSet: !!getSalaToken(),
  });
});

app.post('/api/accounts/switch', (req, res) => {
  const { account } = req.body;
  if (!ACCOUNTS.includes(account)) return res.status(400).json({ error: 'cuenta no disponible' });
  activeAccount = account;
  res.json({ ok: true, active: activeAccount });
});

// ── Uso de cuenta Claude (email + límites 5h/semanal) ──
// GET /api/oauth/usage es el mismo endpoint que usa la CLI oficial para
// pintar el statusLine ("rate_limits.five_hour/seven_day"), autenticado con
// el mismo access token OAuth que ya vive en ~/.claude/.credentials.json —
// no hace falta login aparte. Está MUY rate-limiteado del lado de Anthropic
// (~1 request/hora, responde 429 + Retry-After si te pasás), así que
// cacheamos agresivo acá y respetamos ese Retry-After en vez de reintentar
// por nuestra cuenta. El polling del frontend es liviano porque siempre pega
// contra este cache, nunca directo a la API externa.
const USAGE_MIN_INTERVAL_MS = 55 * 60 * 1000; // piso propio aunque Anthropic no nos frene
const usageCache = new Map(); // account → { data, email, fetchedAt, nextAt, error }

// La línea final ("type": "result") de cada job normal (claude -p ...) ya
// trae este mismo rate_limits de regalo — es la misma cuenta que usa la CLI
// para su statusLine, pero llega gratis con cada mensaje real que se manda
// por acá (la sesión ya recibió los headers anthropic-ratelimit-unified-* de
// Anthropic al responder), sin gastar el request tan limitado de arriba.
// Se usa para refrescar usageCache "en vivo" — mientras estés chateando el
// % se actualiza con cada turno en vez de esperar hasta 55 min.
function ingestStreamRateLimits(acc, rl) {
  if (!rl || (!rl.five_hour && !rl.seven_day)) return;
  const now = Date.now();
  const prev = usageCache.get(acc);
  const entry = {
    data: {
      five_hour: rl.five_hour ? { utilization: rl.five_hour.used_percentage / 100, resets_at: rl.five_hour.resets_at } : (prev?.data?.five_hour ?? null),
      seven_day: rl.seven_day ? { utilization: rl.seven_day.used_percentage / 100, resets_at: rl.seven_day.resets_at } : (prev?.data?.seven_day ?? null),
    },
    email: (prev && prev.email) || '',
    fetchedAt: now,
    nextAt: now + USAGE_MIN_INTERVAL_MS,
    error: null,
  };
  usageCache.set(acc, entry);
}

function accountCredentialsFile(acc) {
  return path.join(accountHomeDir(acc), '.claude', '.credentials.json');
}
function accountClaudeJsonFile(acc) {
  return path.join(accountHomeDir(acc), '.claude.json');
}
function readAccountAuth(acc) {
  let email = '';
  let accessToken = '';
  try {
    const creds = JSON.parse(fs.readFileSync(accountCredentialsFile(acc), 'utf8'));
    accessToken = (creds.claudeAiOauth && creds.claudeAiOauth.accessToken) || '';
  } catch {}
  try {
    // .claude.json a veces trae BOM
    const raw = fs.readFileSync(accountClaudeJsonFile(acc), 'utf8').replace(/^﻿/, '');
    const cj = JSON.parse(raw);
    email = (cj.oauthAccount && cj.oauthAccount.emailAddress) || '';
  } catch {}
  return { email, accessToken };
}

async function fetchAccountUsage(acc, { force = false } = {}) {
  const now = Date.now();
  const cached = usageCache.get(acc);
  // force=true (botón de refresco manual) salta nuestro piso propio de 55min,
  // pero NO el rate limit real de Anthropic — si están muy encima del último
  // pedido real, la rama de abajo (429) sigue respondiendo con el error tal
  // cual y sin gastar nada extra.
  if (!force && cached && now < cached.nextAt) return cached;

  const { email, accessToken } = readAccountAuth(acc);
  if (!accessToken) {
    const entry = { data: null, email, fetchedAt: now, nextAt: now + 5 * 60 * 1000, error: 'sin credenciales' };
    usageCache.set(acc, entry);
    return entry;
  }
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || 3600;
      const entry = { data: cached ? cached.data : null, email, fetchedAt: now, nextAt: now + retryAfter * 1000, error: 'rate limited' };
      usageCache.set(acc, entry);
      return entry;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const entry = { data, email, fetchedAt: now, nextAt: now + USAGE_MIN_INTERVAL_MS, error: null };
    usageCache.set(acc, entry);
    return entry;
  } catch (err) {
    const entry = { data: cached ? cached.data : null, email, fetchedAt: now, nextAt: now + 5 * 60 * 1000, error: err.message };
    usageCache.set(acc, entry);
    return entry;
  }
}

app.get('/api/usage', async (req, res) => {
  const acc = req.query.account || activeAccount;
  const force = req.query.force === '1';
  const entry = await fetchAccountUsage(acc, { force });
  const d = entry.data;
  res.json({
    email: entry.email || '',
    fiveHour: d && d.five_hour ? { pct: d.five_hour.utilization, resetsAt: d.five_hour.resets_at } : null,
    sevenDay: d && d.seven_day ? { pct: d.seven_day.utilization, resetsAt: d.seven_day.resets_at } : null,
    fetchedAt: entry.fetchedAt,
    error: entry.error || null,
  });
});


// ── Config de instancia (nombre + color de identidad) — pantalla de Configuración ──
app.patch('/api/config', (req, res) => {
  const cfg = config.load();
  if ('appName' in req.body) {
    const name = (req.body.appName || '').trim();
    if (name) cfg.appName = name;
    else delete cfg.appName; // vacío = volver al env var / default
  }
  if ('appColor' in req.body) {
    const color = (req.body.appColor || '').trim();
    if (!color) {
      delete cfg.appColor; // vacío = volver al verde default
    } else if (icon.isValidColor(color)) {
      cfg.appColor = color;
    } else {
      return res.status(400).json({ error: 'color inválido, esperado formato #rrggbb' });
    }
  }
  if ('userName' in req.body) {
    const name = (req.body.userName || '').trim();
    if (name) cfg.userName = name;
    else delete cfg.userName; // vacío = volver al env var / default
  }
  if ('groqApiKey' in req.body) {
    const key = (req.body.groqApiKey || '').trim();
    if (key) cfg.groqApiKey = key;
    else delete cfg.groqApiKey; // vacío = apagar la feature de sugerencias
  }
  if ('salaUrl' in req.body) {
    const url = (req.body.salaUrl || '').trim();
    if (url) cfg.salaUrl = url;
    else delete cfg.salaUrl;
  }
  if ('salaToken' in req.body) {
    const token = (req.body.salaToken || '').trim();
    if (token) cfg.salaToken = token;
    else delete cfg.salaToken; // vacío = desconfigurar (la pestaña Sala avisa)
  }
  config.save(cfg);
  const appColor = getAppColor();
  const iconOk = ('appColor' in req.body) ? regenerateIconsSafe(appColor) : true;
  res.json({
    ok: true,
    appName: getAppName(),
    appColor,
    iconOk,
    userName: getUserName(),
    groqApiKeySet: !!getGroqApiKey(),
    salaUrl: getSalaUrl(),
    salaTokenSet: !!getSalaToken(),
  });
});

// ── Respuestas sugeridas por IA (Groq) debajo del último mensaje de Claude ──
// Nunca falla el chat: sin key configurada, o si Groq no responde a tiempo,
// devuelve suggestions: [] y el cliente simplemente no muestra botones.
app.post('/api/suggest-replies', async (req, res) => {
  const text = (req.body && req.body.text) || '';
  const apiKey = getGroqApiKey();
  const suggestions = await getReplySuggestions(text, { apiKey });
  res.json({ suggestions });
});

// ── Reinicio del server desde la pantalla de Configuración ──
// Mismo alcance que la tarea programada "JarvisRestart"/restart-jarvis.ps1 ya
// existente: reinicia SOLO el proceso Node, no el túnel de Cloudflare (no
// hace falta para tomar código nuevo). Pensado para no depender de abrir otra
// terminal — pero OJO: si el que aprieta el botón está viendo la UI a través
// de ESTE mismo server, su propia conexión se corta durante el restart, es
// inevitable (el proceso que la sirve muere). Por eso se responde `ok` ANTES
// de matar nada, y recién con la respuesta ya en vuelo se dispara el restart.
//
// Antes de reiniciar se intenta un `git pull` (gitPull() abajo) — es lo que
// el botón dice que hace ("aplica cambios de código nuevos") pero hasta acá
// nunca hacía de verdad, solo relanzaba el mismo código que ya estaba en
// disco. Best-effort: si el pull falla (sin red, conflicto, etc.) o hay
// cambios sin commitear en el working tree, se loguea y se reinicia igual
// con el código que hay — nunca se bloquea el restart por el pull.
//
// Dos modos, elegidos por si hay o no un supervisor externo:
//  - RESTART_CMD seteado (env var): se ejecuta ese comando y se deja que ÉL
//    mate y relance — pensado para deploys bajo un supervisor de verdad (ej.
//    FerStark en WSL: "systemctl --user restart ferstark-server.service").
//    No hacemos process.exit() acá: si RESTART_CMD nos mata, el supervisor
//    ya se encarga; si no nos mata, seguir vivos es más seguro que adivinar.
//  - Sin RESTART_CMD, en Windows (los dos deploys de escritorio, User/locti):
//    este mismo proceso se relanza a sí mismo — spawn detached de
//    "node src/server.js" con el mismo cwd/env — y recién ahí hace
//    process.exit(). Mismo resultado que restart-jarvis.ps1 pero sin
//    terminal ni Task Scheduler de por medio.
//  - Sin RESTART_CMD fuera de Windows: no hay forma segura de auto-relanzarse
//    sin supervisor (podría duplicar el proceso o perder los logs) — se
//    avisa por consola y no se hace nada más.
function doRestart() {
  if (process.env.RESTART_CMD) {
    console.log('[restart] ejecutando RESTART_CMD:', process.env.RESTART_CMD);
    exec(process.env.RESTART_CMD, { windowsHide: true }, err => {
      if (err) console.error('[restart] RESTART_CMD falló:', err.message);
    });
    return;
  }
  if (!IS_WIN) {
    console.error('[restart] no es Windows y no hay RESTART_CMD seteado — no se puede autoreiniciar. Configurá RESTART_CMD para este deploy.');
    return;
  }
  console.log('[restart] relanzando server.js...');
  const child = spawn(process.execPath, [__filename], {
    cwd: path.join(__dirname, '..'),
    env: process.env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true, // mismo motivo que el resto de los spawn del server (ver 6eba406): sin consola propia, Windows abriría una nueva
  });
  child.unref();
  process.exit(0);
}

// Repo root: el mismo cwd que ya usa el relanzamiento de arriba.
const REPO_ROOT = path.join(__dirname, '..');

// Cuando el git pull automático del restart no se puede resolver solo
// (working tree sucio, o el pull mismo falla — típicamente un merge
// conflict), antes se le mandaba el aviso a Claude como mensaje de una
// conversación nueva — pero esa conversación se creaba en meta.json y el
// restart mataba el proceso (process.exit) tres líneas después sin esperar
// a que runner.send() terminara, así que el aviso real nunca se escribía:
// quedaba una conversación vacía, con currentSessionId null, sin mensajes.
// Ahora en vez de eso se deja un aviso liviano en disco (un solo pendiente,
// se pisa si hay uno sin leer) y el cliente lo levanta como toast al abrir
// la PWA — sin abrir conversación ni depender de que un `claude -p` llegue
// a correr antes de que el proceso se mate a sí mismo.
const RESTART_NOTICE_FILE = path.join(HOME_DIR, '.claude', 'session-manager', 'restart-notice.json');
function writeRestartNotice(text, kind = 'info') {
  try {
    fs.mkdirSync(path.dirname(RESTART_NOTICE_FILE), { recursive: true });
    fs.writeFileSync(RESTART_NOTICE_FILE, JSON.stringify({ text, kind, ts: new Date().toISOString() }));
  } catch (err) {
    // Best-effort sobre best-effort: si esto falla, ya quedó el console.error
    // de gitPull() de todos modos — no es la única forma de enterarse.
    console.error('[restart] no se pudo guardar el aviso de restart-notice:', err.message);
  }
}

// git pull best-effort. Se salta (sin tocar nada) si hay cambios sin
// commitear — un pull sobre un working tree sucio puede fallar a mitad de
// camino o traer un merge conflict, y este server no tiene forma de
// resolverlo solo. En ese caso el restart sigue de largo con el código
// actual, tal cual se comportaba antes de agregar esto.
function gitPull() {
  return new Promise(resolve => {
    exec('git status --porcelain', { cwd: REPO_ROOT, windowsHide: true }, (err, stdout) => {
      if (err) {
        console.error('[restart] git status falló, se saltea el pull:', err.message);
        return resolve();
      }
      if (stdout.trim()) {
        console.warn('[restart] hay cambios sin commitear en el repo, se saltea el git pull (reinicia con el código actual):\n' + stdout);
        const files = stdout.trim().split('\n').map(l => l.replace(/^.{0,3}/, '').trim()).join(', ');
        writeRestartNotice(
          `Reinicio: se saltó "git pull" porque había cambios sin commitear (${files}). Reinició igual con el código que ya tenía en disco.`,
          'info'
        );
        return resolve();
      }
      exec('git pull', { cwd: REPO_ROOT, windowsHide: true }, (err2, stdout2, stderr2) => {
        if (err2) {
          console.error('[restart] git pull falló:', err2.message);
          writeRestartNotice(
            `Reinicio: "git pull" falló (${err2.message.split('\n')[0]}). Reinició igual con el código que ya tenía en disco — mirá la consola del server para el detalle.`,
            'error'
          );
        } else {
          console.log('[restart] git pull:', (stdout2 || stderr2 || '').trim() || '(sin cambios)');
        }
        resolve();
      });
    });
  });
}

app.post('/api/restart', (req, res) => {
  res.json({ ok: true, restarting: true });
  // Esperar a que la respuesta ya haya salido por el socket antes de matar el
  // proceso que la está sirviendo (si no, el cliente puede quedarse sin
  // confirmación aunque el restart haya salido bien). El pequeño delay extra
  // le da margen a proxies de por medio (el túnel de Cloudflare).
  res.on('finish', () => setTimeout(async () => {
    await gitPull();
    doRestart();
  }, 300));
});

// Read-once: el cliente lo pregunta al abrir la PWA y, si hay algo, lo
// muestra como toast y se borra acá mismo — así no vuelve a aparecer en el
// próximo refresh ni queda pisando la lista de conversaciones.
app.get('/api/restart-notice', (req, res) => {
  try {
    const raw = fs.readFileSync(RESTART_NOTICE_FILE, 'utf8');
    fs.unlinkSync(RESTART_NOTICE_FILE);
    res.json(JSON.parse(raw));
  } catch {
    res.json({ text: null });
  }
});

// index.html y manifest.json tienen placeholders {{APP_NAME}}/{{APP_COLOR}} —
// se sirven acá con el reemplazo hecho, ANTES del express.static de abajo (si
// no, este último los serviría primero tal cual, con el placeholder crudo sin
// reemplazar). Reemplazo global por si el mismo archivo lo usa más de una vez.
function serveTemplated(filePath, contentType) {
  return (req, res) => {
    let body;
    try {
      body = fs.readFileSync(filePath, 'utf8');
    } catch {
      return res.status(404).end();
    }
    res.set('Cache-Control', 'no-store');
    res.type(contentType).send(body
      .replaceAll('{{APP_NAME}}', getAppName())
      .replaceAll('{{APP_VERSION}}', getAppVersion())
      .replaceAll('{{APP_COLOR}}', getAppColor()));
  };
}
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.get('/', serveTemplated(path.join(PUBLIC_DIR, 'index.html'), 'html'));
app.get('/index.html', serveTemplated(path.join(PUBLIC_DIR, 'index.html'), 'html'));
app.get('/manifest.json', serveTemplated(path.join(PUBLIC_DIR, 'manifest.json'), 'application/json'));

// Ícono de la PWA: si hay uno regenerado en el cache para el color actual, se
// sirve ese; si no (instalación nueva, o cache borrado a mano), cae al PNG
// verde original del repo. Rutas explícitas ANTES del express.static de abajo
// para que tengan prioridad sobre los archivos estáticos del mismo nombre.
//
// Gotcha Windows: res.sendFile(pathAbsolutoConBackslashes) tira 404 siempre
// (Not Found) aunque el archivo exista — Express hace encodeURI() sobre el
// path antes de pasarlo a `send`, y encodeURI codifica el backslash como
// %5C, así que la ruta que llega a `send` queda rota. La forma correcta en
// Windows (y la que además documenta Express) es pasar SOLO el nombre de
// archivo + `{ root: carpeta }`, nunca la ruta absoluta ya unida.
function serveIcon(size) {
  const fileName = icon.iconFileName(size);
  return (req, res) => {
    const useCache = fs.existsSync(path.join(ICON_CACHE_DIR, fileName));
    const root = useCache ? ICON_CACHE_DIR : PUBLIC_DIR;
    res.set('Cache-Control', 'no-store');
    res.sendFile(fileName, { root }, err => {
      if (err && !res.headersSent) res.status(err.status || 500).end();
    });
  };
}
app.get('/icon-192.png', serveIcon(192));
app.get('/icon-512.png', serveIcon(512));

// index.html y el código propio (app.js/style.css) nunca cacheados por el
// browser, para que un rebrand no quede pegado en el celu. Las libs de
// vendor/ son distintas: son terceros pineados por versión que no cambian
// entre deploys de este repo — no hay motivo para bajarlas de nuevo en cada
// carga. Se les da cache normal (revalidación por ETag, no "para siempre").
app.use(express.static(PUBLIC_DIR, {
  setHeaders(res, filePath) {
    if (filePath.includes(`${path.sep}vendor${path.sep}`)) return;
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('manifest.json')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  },
}));

const runner = new Runner({ selfHost: HOST, selfPort: PORT });
const sseClients = new Map(); // convId → Set<res>

const CODEX_META_FILE = path.join(os.homedir(), '.claude', 'session-manager', 'codex-meta.json');
const GEMINI_META_FILE = path.join(os.homedir(), '.claude', 'session-manager', 'gemini-meta.json');
const SALA_META_FILE = path.join(os.homedir(), '.claude', 'session-manager', 'sala-meta.json');
const codexRunner = new CodexRunner({ selfHost: HOST, selfPort: PORT });
const codexSseClients = new Map(); // convId → Set<res>
const geminiRunner = new GeminiRunner({ selfHost: HOST, selfPort: PORT });
const geminiSseClients = new Map();
// convId → Date.now() de cuando se despachó el mensaje. Sirve para distinguir
// una respuesta real (aunque gemini-runner haya perdido el hilo del stream)
// de una vieja: ver findFreshGeminiAnswer más abajo.
const geminiTurnStartedAt = new Map();
const CODEX_TTS_SCRIPT = path.join(os.homedir(), '.claude', 'scripts', 'speak-response.py');
const {
  createVoiceRouter,
  readVoiceName,
  readVoiceVolume,
  getVoiceFlagFiles,
} = require('./routes/voice');
const VOICE_FLAG_FILES = getVoiceFlagFiles(HOME_DIR);

app.use('/api/voice-settings', createVoiceRouter({ homeDir: HOME_DIR }));

function codexBroadcast(convId, payload) {
  const set = codexSseClients.get(convId);
  if (!set) return;
  for (const res of set) res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// Reusa el narrador del sistema de Claude Code: mismo switch ~/.claude/voice-on,
// resumen por LLM, limpieza de texto y lock de reproducción. Solo cambia la voz
// para que Codex se distinga de Claude (Tomás vs. Elena).
function narrateCodexResponse(convId) {
  if (!IS_WIN || !fs.existsSync(CODEX_TTS_SCRIPT)) return;
  try {
    const data = meta.load(CODEX_META_FILE);
    const conv = data.conversations[convId];
    const file = conv && conv.currentSessionId && codexScanner.findSessionFile(conv.currentSessionId);
    if (!file) return;
    const messages = codexScanner.getMessages(file);
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.text && m.text.trim());
    if (!lastAssistant) return;
    const assistantIndex = messages.lastIndexOf(lastAssistant);
    const user = [...messages.slice(0, assistantIndex)].reverse().find(m => m.role === 'user');
    const inputFile = path.join(os.tmpdir(), `codex-tts-${process.pid}-${Date.now()}-${crypto.randomUUID()}.json`);
    fs.writeFileSync(inputFile, JSON.stringify({ user: user?.text || '', assistant: lastAssistant.text }), { encoding: 'utf8', mode: 0o600 });
    const child = spawn('python', [CODEX_TTS_SCRIPT, '--say-json', inputFile], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        CLAUDE_TTS_VOICE: readVoiceName('codex'),
        CLAUDE_TTS_VOLUME: String(readVoiceVolume('codex')),
        CLAUDE_TTS_FLAG_FILE: VOICE_FLAG_FILES.codex,
      },
    });
    child.unref();
  } catch (err) {
    console.error('[codex-tts] no se pudo lanzar el narrador:', err.message);
  }
}

// Mismo mecanismo que narrateCodexResponse (Antigravity tampoco tiene hooks
// propios) — voz propia (Valentina, uruguaya/rioplatense) para distinguirse
// de Elena (Claude) y Tomás (Codex). A diferencia de Codex, el texto ya está
// en meta.json (gemini-runner.js lo persiste ahí) — no hace falta ir a buscar
// un archivo de sesión aparte.
function narrateGeminiResponse(convId) {
  if (!IS_WIN || !fs.existsSync(CODEX_TTS_SCRIPT)) return;
  try {
    const data = meta.load(GEMINI_META_FILE);
    const conv = data.conversations[convId];
    const messages = conv && conv.messages;
    if (!messages) return;
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.text && m.text.trim());
    if (!lastAssistant) return;
    const assistantIndex = messages.lastIndexOf(lastAssistant);
    const user = [...messages.slice(0, assistantIndex)].reverse().find(m => m.role === 'user');
    const inputFile = path.join(os.tmpdir(), `agy-tts-${process.pid}-${Date.now()}-${crypto.randomUUID()}.json`);
    fs.writeFileSync(inputFile, JSON.stringify({ user: user?.text || '', assistant: lastAssistant.text }), { encoding: 'utf8', mode: 0o600 });
    const child = spawn('python', [CODEX_TTS_SCRIPT, '--say-json', inputFile], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        CLAUDE_TTS_VOICE: readVoiceName('antigravity'),
        CLAUDE_TTS_VOLUME: String(readVoiceVolume('antigravity')),
        CLAUDE_TTS_FLAG_FILE: VOICE_FLAG_FILES.antigravity,
      },
    });
    child.unref();
  } catch (err) {
    console.error('[antigravity-tts] no se pudo lanzar el narrador:', err.message);
  }
}

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

function convStatus(convId) {
  return (runner.running.has(convId) || compacting.has(convId)) ? 'running'
    : runner.isBusy(convId) ? 'queued'
    : 'idle';
}

runner.on('event', ({ convId, event, account }) => {
  const sid = event.session_id;
  if (sid) {
    const metaFile = accountMetaFile(account || activeAccount);
    const data = meta.load(metaFile);
    if (data.conversations[convId] && data.conversations[convId].currentSessionId !== sid) {
      meta.advanceSession(data, convId, sid);
      meta.save(data, metaFile);
    } else {
      // No está en el store de la cuenta — puede ser una conversación de
      // Sala, que vive en SALA_META_FILE en vez de accountMetaFile.
      const salaData = meta.load(SALA_META_FILE);
      if (salaData.conversations[convId] && salaData.conversations[convId].currentSessionId !== sid) {
        meta.advanceSession(salaData, convId, sid);
        meta.save(salaData, SALA_META_FILE);
      }
    }
  }
  // Línea final del job — a veces trae rate_limits de regalo (ver
  // ingestStreamRateLimits). No todos los "result" lo traen (recién
  // disponible después de la primera respuesta real de la API en la
  // sesión), por eso sigue existiendo el fetch a /api/oauth/usage como
  // respaldo para cuando todavía no chateaste nada.
  if (event.type === 'result' && event.rate_limits) {
    ingestStreamRateLimits(account || activeAccount, event.rate_limits);
  }
  broadcast(convId, { kind: 'claude', event });
});

// Si el turno que acaba de terminar era una conversación de Sala, publica
// la respuesta final de vuelta al VPS y avanza el cursor local — así la
// próxima vez que ESTA instancia hable no se re-inyecta a sí misma lo que
// acaba de decir. No hace nada (silencioso, solo un log) si el convId no es
// de Sala, si el turno fue cancelado, o si sala no está configurada — mismo
// criterio de "nunca romper el chat normal" que ya usa maybeGenerateTitle.
async function publishSalaReplyIfNeeded(convId, account, cancelled) {
  if (cancelled) return;
  const data = meta.load(SALA_META_FILE);
  const conv = data.conversations[convId];
  if (!conv) return; // no es una conversación de Sala
  const salaUrl = getSalaUrl(), salaToken = getSalaToken();
  if (!salaUrl || !salaToken) return;
  if (!conv.currentSessionId) return; // el turno no llegó a generar sesión (raro, pero posible si falló antes de arrancar)

  const file = scanner.findSessionFile(conv.currentSessionId, accountProjectsDir(account));
  if (!file) return;
  const messages = scanner.getMessagesIncremental(file).filter(m => m.role === 'assistant');
  const last = messages[messages.length - 1];
  if (!last || !last.text) return;

  const { total } = await salaClient.postMessage({ baseUrl: salaUrl, token: salaToken, roomId: conv.roomId, text: `${getAppName()}: ${last.text}`, kind: 'agent' });
  const fresh = meta.load(SALA_META_FILE);
  if (fresh.conversations[convId]) {
    fresh.conversations[convId].contextCursor = Math.max(fresh.conversations[convId].contextCursor || 0, total);
    meta.save(fresh, SALA_META_FILE);
  }
}

// Poll de fondo: revisa las salas donde esta instancia ya participó (viven
// en SALA_META_FILE) buscando si alguien la mencionó con @<su appName>
// desde la última vez que le tocó hablar — y si es así, dispara un turno
// SOLO, sin que su propio humano haya escrito nada. Es lo que permite
// "@FerStark" desde el lado de Diego sin que Fernando toque nada.
//
// Solo reacciona a menciones con kind:'human' — un mensaje kind:'agent'
// (la respuesta de un agente) puede perfectamente citar "@FerStark" de
// vuelta sin que eso dispare nada; sin este filtro, dos agentes que se
// mencionan en sus propias respuestas podrían quedar respondiéndose en
// bucle para siempre. También corre gateado por runner.isBusy(convId), como
// cualquier otro disparador de turno en este archivo — evita pisarse con un
// turno humano en curso en la misma sala.
//
// No usa un cursor aparte: reusa contextCursor (el mismo que mueve el envío
// humano) — si esta pasada NO encuentra mención, no lo toca, así los
// mensajes siguen "pendientes" para la próxima vez que alguien (humano o
// mención) sí dispare un turno real. Si lo encuentra, el turno consume
// exactamente lo que ya se había leído para detectarla — no hace falta un
// segundo fetch.
async function checkSalaMentions() {
  const salaUrl = getSalaUrl(), salaToken = getSalaToken();
  if (!salaUrl || !salaToken) return;

  // Antes de revisar lo que ya conocía: se fija si hay salas en el VPS que
  // esta instancia todavía no tiene en SALA_META_FILE. Esa lista solo se
  // llena hoy cuando ALGUIEN, desde ESTA instancia, mandó un mensaje ahí (ver
  // resolveOrCreateSalaConv) — si Fernando nunca abrió/escribió en una sala
  // nueva que Diego creó, su FerStark no tenía forma de enterarse de una
  // mención ahí, por más que el poll corriera cada 20s para siempre. Se
  // registra con contextCursor:0 — la primera vez que SÍ la mencionen, el
  // turno arranca con el historial completo de esa sala como contexto,
  // mismo comportamiento que el primer mensaje humano en una sala nueva.
  try {
    const remoteRooms = await salaClient.listRooms({ baseUrl: salaUrl, token: salaToken });
    const data0 = meta.load(SALA_META_FILE);
    const knownRoomIds = new Set(Object.values(data0.conversations).map(c => c.roomId));
    let discovered = false;
    for (const r of remoteRooms) {
      if (!knownRoomIds.has(r.id)) {
        data0.conversations[crypto.randomUUID()] = { roomId: r.id, contextCursor: 0, createdAt: new Date().toISOString() };
        discovered = true;
      }
    }
    if (discovered) meta.save(data0, SALA_META_FILE);
  } catch (err) {
    console.error('[sala] no se pudo listar salas para autodescubrir menciones:', err.message);
  }

  const data = meta.load(SALA_META_FILE);
  for (const [convId, conv] of Object.entries(data.conversations)) {
    if (runner.isBusy(convId)) continue;
    try {
      const { messages, nextCursor } = await salaClient.fetchMessages({
        baseUrl: salaUrl, token: salaToken, roomId: conv.roomId, since: conv.contextCursor,
      });
      if (messages.length === 0) continue;
      const mentioned = messages.some(m => m.kind === 'human' && isMentioned(m.text, getAppName()));
      if (!mentioned) continue;

      const outgoing = `${buildContextBlock(messages)}\n\n${mentionNotice(getAppName())}`;
      // restrictedTools: este turno lo disparó una mención de OTRA persona
      // (Fernando/FerStark), no un mensaje que Diego mandó desde su propio
      // dispositivo — ver runner.js para el detalle de qué bloquea y por
      // qué. El envío humano normal (POST /api/sala/rooms/:id/message,
      // más abajo en este archivo) NO lleva esta restricción.
      runner.send({ convId, sessionId: conv.currentSessionId, cwd: accountHomeDir(activeAccount), text: outgoing, account: activeAccount, isSala: true, appName: getAppName(), restrictedTools: true });

      const fresh = meta.load(SALA_META_FILE);
      if (fresh.conversations[convId]) {
        fresh.conversations[convId].contextCursor = Math.max(fresh.conversations[convId].contextCursor || 0, nextCursor);
        meta.save(fresh, SALA_META_FILE);
      }
    } catch (err) {
      console.error(`[sala] no se pudo chequear menciones en la sala ${conv.roomId}:`, err.message);
    }
  }
}

runner.on('status', s => {
  broadcast(s.convId, { kind: 'status', ...s });
  if (s.status === 'idle' && s.code === 0) {
    maybeGenerateTitle(s.convId, s.account || activeAccount).catch(() => {});
    // Indexar el turno recién escrito ahora y no en el próximo tick del timer:
    // buscar algo que acabás de hablar es justo el caso más frecuente.
    syncSearchIndex(s.account || activeAccount, { reason: 'turno' });
  }
  // Un turno terminó sin que nadie lo estuviera mirando (ni en este dispositivo
  // ni en otro): marcarla "no leída". "Nadie mirando" = sin conexión SSE abierta
  // a esta convId ahora mismo — mismo canal que usa el chat para verse en vivo,
  // así que si estás en la conversación no se marca (ya la viste aparecer).
  // No aplica a cancelaciones manuales: no hay "respuesta nueva" que anunciar.
  if (s.status === 'idle' && !s.cancelled) {
    const hasViewer = (sseClients.get(s.convId)?.size || 0) > 0;
    if (!hasViewer) {
      const metaFile = accountMetaFile(s.account || activeAccount);
      const data = meta.load(metaFile);
      const conv = data.conversations[s.convId];
      // Igual que Codex: un borrador que nunca llegó a crear sesión no puede
      // tener una respuesta pendiente. Marcarlo hacía brillar Chats para
      // siempre y ocultaba visualmente los avisos reales de Codex.
      if (conv && conv.currentSessionId) {
        conv.unread = true;
        meta.save(data, metaFile);
      } else {
        // No está en el store de la cuenta — puede ser una conversación de
        // Sala (vive en SALA_META_FILE, no en accountMetaFile, mismo caso ya
        // resuelto para el evento 'session_id' más arriba). Sin esto, la
        // pestaña "Sala" nunca se enteraba de que FerStark/Jarvis contestó
        // mientras nadie miraba — Diego reportó "siempre brilla Chats" y
        // ESTA era la mitad real del bug: Sala directamente nunca brillaba.
        const salaData = meta.load(SALA_META_FILE);
        const salaConv = salaData.conversations[s.convId];
        if (salaConv) {
          salaConv.unread = true;
          meta.save(salaData, SALA_META_FILE);
        }
      }
    }
  }
  if (s.status === 'idle' && s.code === 0) {
    publishSalaReplyIfNeeded(s.convId, s.account || activeAccount, s.cancelled)
      .catch(err => console.error('[sala] no se pudo publicar la respuesta:', err.message));
  }
});

codexRunner.on('event', ({ convId, event }) => {
  if (event.type === 'thread.started' && event.thread_id) {
    const data = meta.load(CODEX_META_FILE);
    if (data.conversations[convId] && data.conversations[convId].currentSessionId !== event.thread_id) {
      meta.advanceSession(data, convId, event.thread_id);
      meta.save(data, CODEX_META_FILE);
    }
  }
  codexBroadcast(convId, { kind: 'codex', event });
});

codexRunner.on('status', s => {
  codexBroadcast(s.convId, { kind: 'status', ...s });
  if (s.status === 'idle' && s.code === 0 && !s.cancelled) {
    narrateCodexResponse(s.convId);
    maybeGenerateCodexTitle(s.convId).catch(() => {});
  }
  // Mismo criterio de "no leído" que ya usa Claude (ver runner.on('status', ...)
  // más arriba en este archivo): un turno terminó sin nadie mirando esta convId
  // por SSE ahora mismo → se marca unread.
  if (s.status === 'idle' && !s.cancelled) {
    const hasViewer = (codexSseClients.get(s.convId)?.size || 0) > 0;
    if (!hasViewer) {
      const data = meta.load(CODEX_META_FILE);
      const conv = data.conversations[s.convId];
      // Un borrador puede terminar/cancelarse antes de que Codex anuncie el
      // thread.started. No es una respuesta para avisar y, si quedara marcado,
      // haría brillar la pestaña para siempre.
      if (conv && conv.currentSessionId) {
        conv.unread = true;
        meta.save(data, CODEX_META_FILE);
      }
    }
  }
});

// ── Título automático vía Groq ──
const _lastTitleAttempt = new Map(); // convId → timestamp
const TITLE_MIN_MSGS = 2;
const TITLE_RETRY_MS = 30_000;

function _groqTitle(excerpt) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'qwen/qwen3.8-27b',
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
    ], { maxBuffer: 512 * 1024, windowsHide: true }, (err, stdout) => {
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

async function maybeGenerateCodexTitle(convId) {
  if (!GROQ_API_KEY) return;
  const last = _lastTitleAttempt.get(convId) || 0;
  if (Date.now() - last < TITLE_RETRY_MS) return;
  const data = meta.load(CODEX_META_FILE);
  const conv = data.conversations[convId];
  if (!conv || conv.name || conv.aiTitle) return;
  const file = conv.currentSessionId ? codexScanner.findSessionFile(conv.currentSessionId) : null;
  if (!file) return;
  const messages = codexScanner.getMessages(file).filter(m => m.role !== 'tool');
  if (messages.length < TITLE_MIN_MSGS) return;
  _lastTitleAttempt.set(convId, Date.now());
  const excerpt = messages.slice(0, 6).map(m => `${m.role}: ${(m.text || '').slice(0, 400)}`).join('\n\n').slice(0, 2000);
  const title = await _groqTitle(excerpt);
  if (!title) return;
  const latest = meta.load(CODEX_META_FILE);
  const latestConv = latest.conversations[convId];
  if (!latestConv || latestConv.name) return;
  latestConv.name = title;
  latestConv.aiTitle = true;
  meta.save(latest, CODEX_META_FILE);
  codexBroadcast(convId, { kind: 'meta', name: title, aiTitle: true });
}

async function maybeGenerateGeminiTitle(convId) {
  if (!GROQ_API_KEY) return;
  const last = _lastTitleAttempt.get(convId) || 0;
  if (Date.now() - last < TITLE_RETRY_MS) return;
  const data = meta.load(GEMINI_META_FILE);
  const conv = data.conversations[convId];
  if (!conv || conv.name || conv.aiTitle) return;
  let messages = [];
  if (conv.currentSessionId) {
    const realMessages = geminiScanner.getMessages(conv.currentSessionId);
    if (realMessages && realMessages.length > 0) messages = realMessages;
  }
  if (!messages.length && conv.messages) messages = conv.messages;
  messages = messages.filter(m => m.role !== 'tool');
  if (messages.length < TITLE_MIN_MSGS) return;
  _lastTitleAttempt.set(convId, Date.now());
  const excerpt = messages.slice(0, 6).map(m => `${m.role}: ${(m.text || '').slice(0, 400)}`).join('\n\n').slice(0, 2000);
  const title = await _groqTitle(excerpt);
  if (!title) return;
  const latest = meta.load(GEMINI_META_FILE);
  const latestConv = latest.conversations[convId];
  if (!latestConv || latestConv.name) return;
  latestConv.name = title;
  latestConv.aiTitle = true;
  meta.save(latest, GEMINI_META_FILE);
  geminiBroadcast(convId, { kind: 'meta', name: title, aiTitle: true });
}



const PROJECT_SEARCH_ROOTS = [
  path.join(HOME_DIR, 'Desktop', 'Proyectos'),
  path.join(HOME_DIR, 'Desktop'),
];

function normalizeProjectName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// "trabajemos en chat-manager" tiene que poder matchear la carpeta
// "claude-chat-manager". Probamos el nombre entero y sus sufijos unidos por
// guiones; se exige un alias de al menos 5 caracteres para no confundir repos
// por palabras comunes.
function projectMatchScore(message, dirName) {
  const text = normalizeProjectName(message);
  const parts = String(dirName).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let best = 0;
  for (let i = 0; i < parts.length; i++) {
    const alias = parts.slice(i).join('');
    if (alias.length >= 5 && text.includes(alias)) best = Math.max(best, alias.length);
  }
  const full = normalizeProjectName(dirName);
  if (full.length >= 5 && text.includes(full)) best = Math.max(best, full.length);
  return best;
}

async function inferRepoFromMessage(text) {
  if (!text) return null;
  const candidates = [];
  for (const root of PROJECT_SEARCH_ROOTS) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const score = projectMatchScore(text, entry.name);
      if (score) candidates.push({ path: path.join(root, entry.name), score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return gitSync.resolveRepo(candidates.map(c => c.path));
}

// Nombres reales de carpeta bajo PROJECT_SEARCH_ROOTS, para el picker de
// "+ Nuevo proyecto…" — así el tag que se registra coincide de una con lo
// que inferRepoFromMessage() ya sabe resolver, sin depender de que alguien
// tipee el nombre exacto a mano.
function listProjectFolderNames() {
  const names = new Set();
  for (const root of PROJECT_SEARCH_ROOTS) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory()) names.add(entry.name);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'es'));
}

async function inferRepoFromMessages(messages) {
  // La asociación queda pendiente: si el primer mensaje fue genérico, el
  // siguiente "trabajemos en X" la completa. Priorizamos el más reciente
  // porque describe mejor el proyecto al que terminó entrando la charla.
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue;
    const repo = await inferRepoFromMessage(messages[i].text);
    if (repo) return repo;
  }
  return null;
}



app.use('/api', createFilesRouter({
  uploadDir: UPLOAD_DIR,
  magickCmd: MAGICK_CMD,
  magickArgs,
  isWin: IS_WIN,
  isWsl: IS_WSL,
  getGroqApiKey: () => GROQ_API_KEY,
}));

app.use('/api/notebooks', createNotesRouter({
  syncSearchIndex,
  getActiveAccount: () => activeAccount,
}));
app.use('/api/agenda', agendaRouter);

app.use('/api/scan', createScansRouter({
  homeDir: HOME_DIR,
  isWin: IS_WIN,
  syncSearchIndex,
  getActiveAccount: () => activeAccount,
}));

const DEFAULT_TREE_LIMIT = 100;
const MAX_TREE_LIMIT = 500;

app.use('/api', createProjectsRouter({
  getActiveAccount: () => activeAccount,
  accountMetaFile,
  listProjectFolderNames,
}));

app.get('/api/tree', (req, res) => {
  const acc = req.query.account || activeAccount;
  const data = meta.load(accountMetaFile(acc));
  const sessions = scanner.listSessions(accountProjectsDir(acc));
  // Sesiones de Sala (viven en SALA_META_FILE, no en accountMetaFile — ver
  // resolveOrCreateSalaConv) — sin esto, caían en el segundo loop de abajo
  // como "huérfanas" sin proyecto. Ahora se agrupan bajo el proyecto "Salas",
  // registrado (una sola vez) con hideFromAll:true — así no ensucian "Todos
  // los proyectos" pero siguen disponibles filtrando por ese proyecto
  // puntual, para cuando haga falta ver cómo se arma la conversación.
  const salaSessionIds = new Set(
    Object.values(meta.load(SALA_META_FILE).conversations).map(c => c.currentSessionId).filter(Boolean)
  );
  if (salaSessionIds.size > 0 && !(data.projects || []).some(p => projectEntry(p).name === 'Salas')) {
    registerProject(data, 'Salas', true);
    meta.save(data, accountMetaFile(acc));
  }
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
      gitRepo: c.gitRepo || null,
      // Carpeta real donde vive la sesión ahora mismo (puede diferir de projectDir,
      // que queda anclado a home a propósito — ver /conversations POST). Sirve
      // solo para mostrar en el header del chat, no para agrupar en el sidebar.
      currentDir: s.cwd || c.projectDir,
      name: c.name || s.snippet || '(nueva conversación)',
      snippet: s.snippet || '',
      // Fallback a lastMessageAt (seteado al mandar el mensaje, ver POST
      // .../message) mientras el CLI todavía no escribió el .jsonl real —
      // sin esto, una charla recién mandada/en cola ordena al fondo de la
      // lista hasta que arranca a procesar. Una vez que s.lastActivity
      // existe (el CLI ya está escribiendo), gana esa por ser más reciente.
      lastActivity: s.lastActivity || c.lastMessageAt || null,
      messageCount: s.messageCount || 0,
      model: c.model || null,
      lastModel: s.lastModel || null,
      pinned: !!c.pinned,
      archived: !!c.archived,
      aiTitle: !!c.aiTitle,
      // Los flags viejos de borradores sin sesión pueden seguir en meta.json,
      // pero no representan una respuesta que el usuario pueda leer.
      unread: !!c.currentSessionId && !!c.unread,
      // Etiqueta libre de "proyecto" (FERZEP, Maximia, ControlApps, etc.) —
      // NO es una carpeta ni un cwd, es solo para que Fernando ubique con qué
      // tema está trabajando cuando tiene 2-3 charlas abiertas a la vez. Ver
      // /api/projects y el filtro ?project= más abajo.
      project: c.project || null,
      contextPct: contextPctFor(s),
      status: convStatus(convId),
    });
  }
  for (const s of sessions) {
    if (referenced.has(s.sessionId) || data.conversations[s.sessionId]) continue;
    convs.push({
      convId: s.sessionId,
      projectDir: s.cwd || '(desconocido)',
      gitRepo: null,
      currentDir: s.cwd || '(desconocido)',
      name: s.snippet,
      snippet: s.snippet,
      lastActivity: s.lastActivity,
      messageCount: s.messageCount,
      model: null,
      lastModel: s.lastModel || null,
      pinned: false,
      archived: false,
      project: salaSessionIds.has(s.sessionId) ? 'Salas' : null,
      contextPct: contextPctFor(s),
      status: convStatus(s.sessionId),
    });
  }

  const showArchived = req.query.archived === '1';
  const archivedTotal = convs.filter(c => c.archived).length;
  const unreadTotal = convs.filter(c => !c.archived && c.unread).length;
  let filtered = showArchived ? convs.filter(c => c.archived) : convs.filter(c => !c.archived);

  // Filtro de proyecto: ?project=<etiqueta> muestra solo esas; ?project=__none__
  // muestra las que todavía no tienen etiqueta asignada. Sin el parámetro, no
  // filtra (comportamiento de siempre).
  const projectFilter = req.query.project;
  if (projectFilter) {
    filtered = projectFilter === '__none__'
      ? filtered.filter(c => !c.project)
      : filtered.filter(c => c.project === projectFilter);
  } else {
    // "Todos los proyectos": saltar los marcados hideFromAll (ej. "Salas").
    // Filtrando específicamente por ESE proyecto (rama de arriba) sí se ven.
    const hidden = hiddenProjectNames(data);
    if (hidden.size > 0) filtered = filtered.filter(c => !c.project || !hidden.has(c.project));
  }

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
  res.json({ tree, hasMore, total, limit, archivedTotal, unreadTotal, account: acc });
});

// ── Limpieza de sesiones ──
// Ver docs/superpowers/specs/2026-08-20-limpieza-sesiones-design.md. Toda la
// lógica pesada (clasificar, proteger, borrar) vive en scanner.js como
// funciones puras testeadas aparte — acá solo se cablea HTTP + persistencia
// de meta.json + el resync del índice de búsqueda.
app.get('/api/cleanup/sessions', (req, res) => {
  const acc = req.query.account || activeAccount;
  const data = meta.load(accountMetaFile(acc));
  // Sin esto, una sesión de Sala (vive en SALA_META_FILE, no en
  // accountMetaFile) se clasifica como "orphan" — nada la referencia desde
  // el punto de vista de este endpoint — y queda ofrecida para borrar como
  // si fuera basura, cuando en realidad es la sesión activa de una sala.
  const salaConversations = meta.load(SALA_META_FILE).conversations;
  const report = scanner.buildCleanupReport(
    accountProjectsDir(acc),
    { ...data.conversations, ...salaConversations },
    convId => convStatus(convId) !== 'idle',
    data.superseded,
  );
  res.json({ ...report, account: acc });
});

app.post('/api/cleanup/delete', (req, res) => {
  const acc = req.body.account || activeAccount;
  const ids = Array.isArray(req.body.sessionIds) ? req.body.sessionIds : [];
  const metaFile = accountMetaFile(acc);
  const data = meta.load(metaFile);
  const result = scanner.deleteCleanupSessions(
    accountProjectsDir(acc),
    data.conversations,
    ids,
    convId => convStatus(convId) !== 'idle',
    data.superseded,
  );
  let changed = false;
  if (result.removedConvIds.length) {
    for (const convId of result.removedConvIds) delete data.conversations[convId];
    changed = true;
  }
  // Corre siempre que se haya borrado algo (no solo cuando removedConvIds no está
  // vacío): un sessionId puede estar únicamente en superseded — sin conv propia
  // asociada a un currentSessionId borrado — y aun así hay que sacarlo de la lista
  // para no dejar un id stale apuntando a un .jsonl que ya no existe.
  if (result.deleted.length && Array.isArray(data.superseded)) {
    const before = data.superseded.length;
    data.superseded = data.superseded.filter(sid => !result.deleted.includes(sid));
    if (data.superseded.length !== before) changed = true;
  }
  if (changed) meta.save(data, metaFile);
  // Resync best-effort: si falla (índice no disponible en esta máquina), el
  // borrado ya ocurrió igual — no vale la pena fallar la request por esto.
  syncSearchIndex(acc, { reason: 'cleanup' }).catch(() => {});
  res.json({ deleted: result.deleted, skipped: result.skipped, freedBytes: result.freedBytes });
});

app.get('/api/search', (req, res) => {
  const acc = req.query.account || activeAccount;
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.json({ results: [] });
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  // Scope: parado en chats busca chats, parado en libretas busca notas.
  const kind = req.query.kind === 'note' ? 'note' : 'chat';
  const includeTools = req.query.tools === '1';

  if (kind === 'note') {
    if (!index) return res.json({ results: [], degraded: true });
    const results = index.search(q, { kind: 'note', account: NOTES_ACCOUNT, limit });
    return res.json({ results });
  }

  // Sin índice (Node sin node:sqlite) el buscador sigue andando con el scan
  // lineal de siempre: más lento y sin tildes, pero no deja al usuario a pie.
  const results = index
    ? index.search(q, { kind: 'chat', account: acc, limit, includeTools })
    : scanner.searchSessions(q, { limit, projectsDir: accountProjectsDir(acc) });

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
  res.json({ results: enriched, degraded: !index });
});

app.use('/api/conversations', createConversationsRouter({
  getActiveAccount: () => activeAccount,
  accountMetaFile,
  accountProjectsDir,
  accountHomeDir,
  homeDir: HOME_DIR,
  runner,
  compacting,
  broadcast,
  convStatus,
  contextWindowFor,
  usageCost,
  inferRepoFromMessage,
  inferRepoFromMessages,
  registerProject,
  sseClients,
  claudeCmd: CLAUDE_CMD,
}));

app.use('/api/codex', createCodexRouter({
  codexRunner,
  codexSseClients,
  codexMetaFile: CODEX_META_FILE,
  resolveConversationGitRepo: (conv, file) => resolveConversationGitRepo(conv, file, { inferRepoFromMessages }),
  inferRepoFromMessage,
}));

// ── Gemini CLI ──
function geminiBroadcast(convId, payload) { for (const res of geminiSseClients.get(convId) || []) res.write(`data: ${JSON.stringify(payload)}\n\n`); }
geminiRunner.on('session', ({ convId, sessionId }) => {
  const data = meta.load(GEMINI_META_FILE), conv = data.conversations[convId];
  if (conv && !conv.currentSessionId) {
    conv.currentSessionId = sessionId;
    meta.save(data, GEMINI_META_FILE);
  }
});
// Bug real 2026-09-15: Diego reportó que la voz de AgY a veces avisa "se
// detuvo antes de entregar la respuesta final" pero el mensaje SÍ le llega
// bien en el chat. Causa: dos fuentes de verdad desincronizadas. Lo que ve
// Diego en /messages sale de geminiScanner (el transcript real de
// Antigravity en disco) — pero "incomplete" lo decide gemini-runner.js
// mirando solo el stdout de ESTE proceso, y Antigravity puede reportar un
// error de stream ("the stream was interrupted", ver 2026-09-14 más arriba)
// y aun así terminar escribiendo la respuesta completa en su propio
// transcript un instante después. Antes de tratar un turno como fallido,
// esta función chequea si el transcript real ya tiene una respuesta nueva
// (más nueva que cuando se mandó el mensaje) — si la tiene, es un éxito real
// aunque gemini-runner se haya confundido.
function findFreshGeminiAnswer(conv, turnStartedAt) {
  if (!conv || !conv.currentSessionId || !turnStartedAt) return null;
  let messages;
  try { messages = geminiScanner.getMessages(conv.currentSessionId); } catch { return null; }
  if (!messages || !messages.length) return null;
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.text && m.text.trim());
  if (!lastAssistant || !lastAssistant.ts) return null;
  const ts = new Date(lastAssistant.ts).getTime();
  // -2000ms de margen: Antigravity puede escribir la entrada del transcript
  // un toque antes de que nuestro `send()` termine de registrar el arranque.
  if (!Number.isFinite(ts) || ts < turnStartedAt - 2000) return null;
  return lastAssistant.text;
}
geminiRunner.on('event', ({ convId, event }) => geminiBroadcast(convId, { kind: 'gemini', event }));
geminiRunner.on('status', rawStatus => {
  const turnStartedAt = geminiTurnStartedAt.get(rawStatus.convId);
  if (rawStatus.status === 'idle') geminiTurnStartedAt.delete(rawStatus.convId);
  let status = rawStatus;
  if (status.status === 'idle' && status.incomplete && !status.cancelled) {
    const conv = meta.load(GEMINI_META_FILE).conversations[status.convId];
    const freshAnswer = findFreshGeminiAnswer(conv, turnStartedAt);
    if (freshAnswer) status = { ...status, incomplete: false, response: freshAnswer };
  }
  // Antes exigía code===0 — con el fix del 2026-09-14 (gemini-runner.js) el
  // código de salida del proceso ya no es la señal confiable de éxito (ver
  // comentario ahí); lo que importa es que gemini-runner NO lo haya marcado
  // incomplete (result real, sin status:"ERROR").
  if (status.status === 'idle' && !status.incomplete && !status.cancelled && status.response) {
    const data = meta.load(GEMINI_META_FILE), conv = data.conversations[status.convId];
    if (conv) { conv.messages.push({ role: 'assistant', text: status.response, ts: new Date().toISOString() }); conv.currentSessionId = status.conversationId || conv.currentSessionId; conv.lastActivity = new Date().toISOString(); meta.save(data, GEMINI_META_FILE); }
  }
  // Bug real del 2026-09-14: un pedido grande se cortó sin dejar NINGÚN
  // rastro — ni mensaje de error en el historial, ni toast (nadie miraba en
  // ese momento). Este mensaje ahora es el "siempre queda algo" para
  // cualquier motivo de corte (timeout, límite de herramientas, error de
  // Antigravity) — incluye el motivo real cuando gemini-runner lo trae.
  // Si fue cancelado a propósito por el usuario, no se agrega advertencia.
  if (status.status === 'idle' && status.incomplete && !status.cancelled) {
    const data = meta.load(GEMINI_META_FILE), conv = data.conversations[status.convId];
    if (conv) {
      conv.currentSessionId = status.conversationId || conv.currentSessionId;
      const motivo = status.stderr ? ` (motivo: ${status.stderr})` : '';
      conv.messages.push({ role: 'assistant', text: `Antigravity se detuvo antes de entregar la respuesta final${motivo}. Podés enviar “continuá y dame la respuesta final” para retomar el trabajo.`, ts: new Date().toISOString(), incomplete: true });
      conv.lastActivity = new Date().toISOString();
      meta.save(data, GEMINI_META_FILE);
    }
  }
  // Mismo criterio que Codex (narrateCodexResponse, arriba): narrar también
  // el caso "incomplete" (cualquier motivo, no solo code===0 — ver arriba)
  // porque ya le agregamos un mensaje real al historial avisando que no hubo
  // respuesta final — tiene sentido que Diego se entere por voz igual que
  // por texto, sobre todo si es el único aviso que va a recibir.
  if (status.status === 'idle' && !status.cancelled) {
    narrateGeminiResponse(status.convId);
    maybeGenerateGeminiTitle(status.convId).catch(() => {});
  }
  // Mismo criterio que Chats (ver comentario ahí): un turno terminó sin nadie
  // mirando esta convId por SSE → marcarla no leída. Faltaba acá — la pestaña
  // AgY nunca prendía el punto de "no leído" aunque el backend ya lo soporta.
  if (status.status === 'idle' && !status.cancelled) {
    // Darle un instante al cierre de SSE para llegar al server. Sin esta
    // espera, si Diego cambia de pestaña justo cuando termina AgY, todavía
    // contamos un viewer fantasma y se pierde el triángulo de “finalizado”.
    setTimeout(() => {
      const hasViewer = (geminiSseClients.get(status.convId)?.size || 0) > 0;
      if (!hasViewer) {
        const data = meta.load(GEMINI_META_FILE), conv = data.conversations[status.convId];
        if (conv) { conv.unread = true; meta.save(data, GEMINI_META_FILE); }
      }
    }, 150).unref();
  }
  geminiBroadcast(status.convId, { kind: 'status', ...status });
});
app.use('/api/antigravity', createAntigravityRouter());
app.use('/api/gemini', createGeminiRouter({
  geminiRunner,
  geminiSseClients,
  geminiMetaFile: GEMINI_META_FILE,
  geminiTurnStartedAt,
  inferRepoFromMessage,
  inferRepoFromMessages,
}));

app.use('/api/sala', createSalaRouter({
  runner,
  salaMetaFile: SALA_META_FILE,
  getSalaUrl,
  getSalaToken,
  getUserName,
  getAppName,
  getActiveAccount: () => activeAccount,
  accountHomeDir,
}));

const server = app.listen(PORT, HOST, () => {
  console.log(`Claude Chat Manager en http://${HOST}:${PORT}`);
  // Backfill después del listen, no antes: el buscador arranca degradado
  // (devuelve lo que ya haya indexado) pero la app responde desde el segundo cero.
  if (index) {
    console.log('[search] indexando historial en background…');
    syncSearchIndex(activeAccount, { reason: 'arranque' });
    setInterval(() => syncSearchIndex(activeAccount), SEARCH_SYNC_MS).unref();
  }
  setInterval(() => checkSalaMentions().catch(err => console.error('[sala] error en el poll de menciones:', err.message)), SALA_MENTION_POLL_MS).unref();
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
