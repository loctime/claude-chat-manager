const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, execFileSync, exec, spawn } = require('child_process');
const multer = require('multer');
const archiver = require('archiver');
const { PDFDocument } = require('pdf-lib');
const scanner = require('./scanner');
const notes = require('./notes');
const meta = require('./meta');
const config = require('./config');
const icon = require('./icon');
const { Runner } = require('./runner');
const { CLAUDE_CMD } = require('./claude-cmd');
const searchIndex = require('./search-index');

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
// default. Se lee del archivo en cada request (no una constante al boot) para
// que guardar desde la UI aplique sin reiniciar el server.
function getAppName() {
  const name = (config.load().appName || '').trim();
  return name || process.env.CCM_APP_NAME || 'J.A.R.V.I.S';
}

// Tu propio nombre (no el del agente) — usado para etiquetar tus mensajes
// cuando copiás una conversación en "modo conversación" desde el chat.
// Mismo patrón de prioridad que getAppName(): config guardada > env var > default.
function getUserName() {
  const name = (config.load().userName || '').trim();
  return name || process.env.CCM_USER_NAME || 'Vos';
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
    const chats = await index.syncChats(accountProjectsDir(acc), acc);
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
    appName: getAppName(),
    appColor: getAppColor(),
    userName: getUserName(),
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

async function fetchAccountUsage(acc) {
  const now = Date.now();
  const cached = usageCache.get(acc);
  if (cached && now < cached.nextAt) return cached;

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
  const entry = await fetchAccountUsage(acc);
  const d = entry.data;
  res.json({
    email: entry.email || '',
    fiveHour: d && d.five_hour ? { pct: d.five_hour.utilization, resetsAt: d.five_hour.resets_at } : null,
    sevenDay: d && d.seven_day ? { pct: d.seven_day.utilization, resetsAt: d.seven_day.resets_at } : null,
    fetchedAt: entry.fetchedAt,
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
  config.save(cfg);
  const appColor = getAppColor();
  const iconOk = ('appColor' in req.body) ? regenerateIconsSafe(appColor) : true;
  res.json({ ok: true, appName: getAppName(), appColor, iconOk, userName: getUserName() });
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

// index.html y archivos JS/CSS nunca cacheados por el browser
app.use(express.static(PUBLIC_DIR, {
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
      if (conv) {
        conv.unread = true;
        meta.save(data, metaFile);
      }
    }
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
    const child = spawn(CLAUDE_CMD, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
    ]), { windowsHide: true }, (err) => {
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
  ], { maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
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
    execFileSync(cmd, [gsName], { windowsHide: true });
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

  execFile(MAGICK_CMD, magickArgs(args), { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
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

// ── Notas (anotador sin IA, sin sesión de Claude) — múltiples libretas ──
// Ver docs/superpowers/specs/2026-08-13-notas-libretas-design.md
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

app.get('/api/notebooks', (req, res) => {
  res.json({ notebooks: notes.listNotebooks() });
});

app.post('/api/notebooks', (req, res) => {
  res.status(201).json(notes.createNotebook());
});

app.patch('/api/notebooks/:id', (req, res) => {
  if (!notes.getNotebook(req.params.id)) return res.status(404).json({ error: 'libreta no encontrada' });
  if ('name' in req.body) {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'nombre vacío' });
    notes.renameNotebook(req.params.id, name);
  }
  // hidden: saca la libreta de la lista sin borrar sus notas — mismo patrón
  // que conv.hidden (ver PATCH /api/conversations/:id).
  if ('hidden' in req.body) notes.hideNotebook(req.params.id, !!req.body.hidden);
  res.json(notes.getNotebook(req.params.id));
});

app.get('/api/notebooks/:id/notes', (req, res) => {
  const nb = notes.getNotebook(req.params.id);
  if (!nb) return res.status(404).json({ error: 'libreta no encontrada' });
  res.json({ notes: notes.readAll(notes.notebookNotesFile(req.params.id)) });
});

app.post('/api/notebooks/:id/notes', (req, res) => {
  const nb = notes.getNotebook(req.params.id);
  if (!nb) return res.status(404).json({ error: 'libreta no encontrada' });
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'texto vacío' });
  const file = notes.notebookNotesFile(req.params.id);
  const entry = { id: crypto.randomUUID(), ts: Date.now(), type: 'text', text };
  notes.append(entry, file);
  syncSearchIndex(activeAccount, { reason: 'nota' });

  // Auto-nombre: si esta es la primera nota de texto y la libreta todavía
  // tiene el nombre default ("Nueva libreta"/"Nueva libreta N"), la renombra
  // usando el principio de esta nota. Si ya se renombró a mano, el nombre
  // deja de matchear el patrón y esto no la vuelve a tocar.
  let notebook = nb;
  if (notes.DEFAULT_NAME_RE.test(nb.name)) {
    const textNotes = notes.readAll(file).filter(e => e.type === 'text');
    if (textNotes.length === 1) {
      const firstLine = text.split('\n')[0].trim();
      const autoName = firstLine.length > 40 ? firstLine.slice(0, 40) + '…' : firstLine;
      notebook = notes.renameNotebook(req.params.id, autoName) || nb;
    }
  }
  res.status(201).json({ entry, notebook });
});

app.post('/api/notebooks/:id/notes/upload', notesUpload.single('file'), (req, res) => {
  const nb = notes.getNotebook(req.params.id);
  if (!nb) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(404).json({ error: 'libreta no encontrada' });
  }
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
  notes.append(entry, notes.notebookNotesFile(req.params.id));
  syncSearchIndex(activeAccount, { reason: 'nota' });
  res.status(201).json({ entry, notebook: nb });
});

// ── Escáner de documentos (tipo CamScanner) ──
// Detecta el documento en la foto, endereza la perspectiva y limpia el
// contraste (canal rojo + umbral adaptivo — mismo enfoque que ya veníamos
// usando para remitos, ver scripts/mejora-imagen/README.md). Todo corre
// local con OpenCV vía un script Python — no pasa por Claude ni gasta
// tokens. Vendorizado adentro del repo (antes vivía en una carpeta hermana
// fuera de git, así que se rompía en cualquier checkout que no fuera el de
// Fernando) — ver docs/superpowers/specs/2026-08-17-escaner-documentos-design.md.
const PYTHON_CMD = IS_WIN ? 'python' : 'python3';
const SCAN_SCRIPT = path.join(__dirname, '..', 'scripts', 'mejora-imagen', 'mejorar_imagen.py');
const SCANS_DIR = path.join(HOME_DIR, '.ccm-notes', 'scans');

const scanUpload = multer({
  storage: multer.diskStorage({
    // El id de cada escaneo se genera acá (no hay :id de ruta todavía en el
    // POST inicial) y se cuelga del req para que el handler lo use después.
    destination: (req, file, cb) => {
      const id = crypto.randomUUID();
      const dir = path.join(SCANS_DIR, id);
      try {
        fs.mkdirSync(dir, { recursive: true });
        req.scanId = id;
        req.scanDir = dir;
        cb(null, dir);
      } catch (err) { cb(err); }
    },
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
      cb(null, 'original' + ext);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

app.post('/api/scan', scanUpload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no se recibió foto' });
  execFile(PYTHON_CMD, [SCAN_SCRIPT, req.file.path, req.scanDir, '--json'], { maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
    if (err) {
      console.error('[scan] error procesando', stderr || err.message);
      return res.status(500).json({ error: 'no se pudo procesar la imagen: ' + (stderr || err.message).toString().slice(0, 300) });
    }
    let result;
    try { result = JSON.parse(stdout); } catch { return res.status(500).json({ error: 'respuesta inválida del script de escaneo' }); }
    if (result.error) return res.status(500).json({ error: result.error });
    res.json({
      id: req.scanId,
      detectado: result.detectado,
      recortada: result.recortada,
      limpia: result['1x'],
      limpia2x: result['2x'],
    });
  });
});

// Encuentra (o crea) la libreta "Escaneos" — ahí van a parar los documentos
// que el usuario decide conservar desde la solapa Escáner.
function findOrCreateScanNotebook() {
  const existing = notes.listNotebooks().find(nb => nb.name === 'Escaneos');
  if (existing) return existing;
  const nb = notes.createNotebook();
  return notes.renameNotebook(nb.id, 'Escaneos') || nb;
}

const SCAN_VARIANT_SUFFIX = { recortada: '_recortada.jpg', limpia: '_limpia.jpg', limpia2x: '_limpia_2x.jpg' };

app.post('/api/scan/:id/keep', (req, res) => {
  const suffix = SCAN_VARIANT_SUFFIX[req.body && req.body.variant];
  if (!suffix) return res.status(400).json({ error: 'variante inválida' });
  // El id de la URL es el nombre de carpeta que armamos nosotros mismos en
  // destination() de arriba (crypto.randomUUID()) — nunca llega a un path
  // fuera de SCANS_DIR aunque el cliente mande cualquier cosa acá, porque
  // path.join + fs.existsSync sobre ese path fijo no puede "escaparse" de la
  // carpeta con un id que no matchea ningún directorio real.
  const dir = path.join(SCANS_DIR, req.params.id);
  let files;
  try { files = fs.readdirSync(dir); } catch { return res.status(404).json({ error: 'escaneo no encontrado' }); }
  const fileName = files.find(f => f.endsWith(suffix));
  if (!fileName) return res.status(404).json({ error: 'no se encontró el archivo procesado' });
  const srcPath = path.join(dir, fileName);

  notes.ensureFilesDir();
  const destName = notes.resolveDestName(notes.FILES_DIR, `escaneo-${req.params.id.slice(0, 8)}.jpg`);
  const destPath = path.join(notes.FILES_DIR, destName);
  fs.copyFileSync(srcPath, destPath);

  const notebook = findOrCreateScanNotebook();
  const entry = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    type: 'file',
    fileName: destName,
    filePath: destPath,
    mime: 'image/jpeg',
    size: fs.statSync(destPath).size,
  };
  notes.append(entry, notes.notebookNotesFile(notebook.id));
  syncSearchIndex(activeAccount, { reason: 'nota' });
  res.status(201).json({ entry, notebook });
});

// ── Documento multi-página: juntar varios escaneos en un solo PDF ──
// Cada página ya pasó por /api/scan (detectar borde + enderezar + limpiar);
// esto solo arma el PDF a partir de los archivos que ya están en disco, sin
// volver a tocar la imagen. Los PDF armados quedan en PDF_DRAFTS_DIR hasta
// que el usuario decide guardarlo en Notas (mismo patrón que SCANS_DIR: sin
// job de limpieza todavía si el usuario nunca lo guarda).
const PDF_DRAFTS_DIR = path.join(HOME_DIR, '.ccm-notes', 'scan-pdfs');

app.post('/api/scan/pdf', async (req, res) => {
  const pages = Array.isArray(req.body && req.body.pages) ? req.body.pages : [];
  if (!pages.length) return res.status(400).json({ error: 'no se recibió ninguna página' });
  if (pages.length > 50) return res.status(400).json({ error: 'máximo 50 páginas por documento' });

  // Resuelve cada página a un path real en disco ANTES de tocar el PDF —
  // si una sola página tiene un id o variante inválida, se corta acá con un
  // error claro en vez de generar un PDF a medio armar.
  const resolved = [];
  for (const p of pages) {
    const suffix = SCAN_VARIANT_SUFFIX[p && p.variant];
    if (!suffix) return res.status(400).json({ error: `variante inválida en página: ${p && p.variant}` });
    const dir = path.join(SCANS_DIR, String(p.id || ''));
    let files;
    try { files = fs.readdirSync(dir); } catch { return res.status(404).json({ error: `escaneo no encontrado: ${p.id}` }); }
    const fileName = files.find(f => f.endsWith(suffix));
    if (!fileName) return res.status(404).json({ error: `no se encontró el archivo procesado de ${p.id}` });
    resolved.push(path.join(dir, fileName));
  }

  try {
    const pdfDoc = await PDFDocument.create();
    for (const imgPath of resolved) {
      const bytes = fs.readFileSync(imgPath);
      const jpg = await pdfDoc.embedJpg(bytes);
      // Página del tamaño exacto de la imagen (en puntos = píxeles) — evita
      // deformar o dejar márgenes blancos, y es el truco estándar para
      // "una imagen por página" en pdf-lib.
      const page = pdfDoc.addPage([jpg.width, jpg.height]);
      page.drawImage(jpg, { x: 0, y: 0, width: jpg.width, height: jpg.height });
    }
    const pdfBytes = await pdfDoc.save();

    const id = crypto.randomUUID();
    fs.mkdirSync(PDF_DRAFTS_DIR, { recursive: true });
    const pdfPath = path.join(PDF_DRAFTS_DIR, `${id}.pdf`);
    fs.writeFileSync(pdfPath, pdfBytes);

    res.status(201).json({ id, path: pdfPath, pageCount: resolved.length });
  } catch (err) {
    console.error('[scan/pdf] error generando PDF', err.message);
    res.status(500).json({ error: 'no se pudo generar el PDF: ' + err.message.slice(0, 300) });
  }
});

app.post('/api/scan/pdf/:id/keep', (req, res) => {
  // Mismo chequeo de path que /api/scan/:id/keep: el id de la URL es el
  // nombre de archivo que generamos nosotros mismos (crypto.randomUUID())
  // arriba — nunca se resuelve a nada fuera de PDF_DRAFTS_DIR.
  const srcPath = path.join(PDF_DRAFTS_DIR, `${req.params.id}.pdf`);
  if (!fs.existsSync(srcPath)) return res.status(404).json({ error: 'PDF no encontrado (¿ya se guardó o se generó de nuevo?)' });

  notes.ensureFilesDir();
  const destName = notes.resolveDestName(notes.FILES_DIR, `documento-${req.params.id.slice(0, 8)}.pdf`);
  const destPath = path.join(notes.FILES_DIR, destName);
  fs.copyFileSync(srcPath, destPath);

  const notebook = findOrCreateScanNotebook();
  const entry = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    type: 'file',
    fileName: destName,
    filePath: destPath,
    mime: 'application/pdf',
    size: fs.statSync(destPath).size,
  };
  notes.append(entry, notes.notebookNotesFile(notebook.id));
  syncSearchIndex(activeAccount, { reason: 'nota' });
  res.status(201).json({ entry, notebook });
});

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
      unread: !!c.unread,
      contextPct: contextPctFor(s),
      status: convStatus(convId),
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
      status: convStatus(s.sessionId),
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
  // Read-once: si el turno anterior rebobinó ignorando acciones con efecto real,
  // esta nota va antepuesta al primer mensaje que se manda después — así entra
  // al contexto real de Claude en vez de quedar en una notificación que nadie lee.
  if (conv.pendingRewindNotice) {
    outgoing = `${conv.pendingRewindNotice}\n\n[Mensaje actual del usuario]\n${outgoing}`;
    delete conv.pendingRewindNotice;
  }
  if (conv.compactedSummary && !conv.currentSessionId) {
    outgoing = `[Resumen del contexto previo — la conversación fue compactada]\n${conv.compactedSummary}\n\n[Mensaje actual del usuario]\n${outgoing}`;
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

// Da el mismo texto que rewindSessionFile dejaría como aviso pendiente — lo usan
// tanto el preview (antes de confirmar) como el rewind real (para guardarlo).
function formatRewindNotice(effects) {
  const lines = effects.map(e => {
    const tag = e.reversible === true ? ' [reversible]' : e.reversible === false ? ' [IRREVERSIBLE]' : '';
    return `- ${e.summary}${tag}${e.hint ? ' — ' + e.hint : ''}`;
  });
  return `[Aviso: se rebobinó la charla]\nEntre el punto al que se volvió y el estado anterior se habían ejecutado estas acciones fuera de la charla. Rebobinar NO las deshace — si siguen aplicadas en el sistema, tenelo en cuenta antes de asumir el estado actual:\n${lines.join('\n')}`;
}

// Preview de qué se perdería al rebobinar hasta `uuid`, sin tocar el archivo.
// Pensado para mostrar la advertencia ANTES de que el usuario confirme.
app.get('/api/conversations/:id/rewind-preview', (req, res) => {
  const convId = req.params.id;
  const uuid = (req.query.uuid || '').trim();
  if (!uuid) return res.status(400).json({ error: 'falta uuid del mensaje' });
  const acc = req.query.account || activeAccount;
  const { conv } = resolveConv(convId, acc);
  if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
  if (!conv.currentSessionId) return res.status(400).json({ error: 'la conversación no tiene sesión activa' });
  const file = scanner.findSessionFile(conv.currentSessionId, accountProjectsDir(acc));
  if (!file) return res.status(404).json({ error: 'archivo de sesión no encontrado' });
  const preview = scanner.previewRewindEffects(file, uuid);
  if (!preview) return res.status(400).json({ error: 'no se puede rebobinar ahí (mensaje no encontrado en la sesión actual, o dejaría la conversación vacía)' });
  res.json(preview);
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
  const { data, conv, metaFile } = resolveConv(convId, acc);
  if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
  if (!conv.currentSessionId) return res.status(400).json({ error: 'la conversación no tiene sesión activa' });
  const file = scanner.findSessionFile(conv.currentSessionId, accountProjectsDir(acc));
  if (!file) return res.status(404).json({ error: 'archivo de sesión no encontrado' });
  let result;
  try { result = scanner.rewindSessionFile(file, uuid); }
  catch (err) { return res.status(500).json({ error: 'no se pudo rebobinar: ' + err.message }); }
  if (!result) return res.status(400).json({ error: 'no se puede rebobinar ahí (mensaje no encontrado en la sesión actual, o dejaría la conversación vacía)' });
  // Si se perdieron acciones con efecto real, dejamos una nota que se antepone
  // sola al próximo mensaje que se mande — así Claude la ve en su contexto de
  // verdad en vez de depender de que alguien la lea a mano en algún lado.
  if (result.effects && result.effects.length) {
    conv.pendingRewindNotice = formatRewindNotice(result.effects);
  } else {
    delete conv.pendingRewindNotice;
  }
  meta.save(data, metaFile);
  broadcast(convId, { kind: 'status', status: 'idle', code: 0 });
  res.json({ ok: true, removed: result.removed, effects: result.effects || [] });
});

app.post('/api/conversations', (req, res) => {
  const { model } = req.body;
  const acc = req.body.account || activeAccount;
  // No se elige carpeta por conversación — siempre arranca en la carpeta
  // configurada para esta cuenta (CCM_DEFAULT_PROJECT_DIR si está seteado,
  // si no accountHomeDir), así lee el CLAUDE.md y la memoria de esa carpeta
  // igual que una sesión interactiva normal. Antes se podía elegir carpeta
  // local o "proyecto VPS" por conversación (string "VPS: <nombre>", que no
  // es una ruta real); se sacó esa opción del todo — evita, entre otras
  // cosas, terminar pasando ese string como cwd real de un spawn.
  const projectDir = process.env.CCM_DEFAULT_PROJECT_DIR || accountHomeDir(acc);
  const metaFile = accountMetaFile(acc);
  const convId = crypto.randomUUID();
  const data = meta.load(metaFile);
  data.conversations[convId] = { currentSessionId: null, projectDir, model: model || undefined };
  meta.save(data, metaFile);
  // Conversación arranca vacía, sin mensaje inicial — el usuario escribe el
  // primero desde el composer como cualquier otro mensaje.
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
  if ('unread' in req.body) conv.unread = !!req.body.unread;
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
  // Si la conversación ya está procesando un turno cuando este cliente se
  // conecta (ej. volviste a abrirla mientras corría, o el broadcast único de
  // 'running' pasó mientras estabas mirando otra conversación), el cliente
  // nunca se entera y el botón de cancelar queda oculto hasta el 'idle' final.
  // Mandamos el estado actual como primer evento para que se sincronice solo.
  const st = convStatus(convId);
  if (st !== 'idle') res.write(`data: ${JSON.stringify({ kind: 'status', status: st })}\n\n`);
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
  // Backfill después del listen, no antes: el buscador arranca degradado
  // (devuelve lo que ya haya indexado) pero la app responde desde el segundo cero.
  if (index) {
    console.log('[search] indexando historial en background…');
    syncSearchIndex(activeAccount, { reason: 'arranque' });
    setInterval(() => syncSearchIndex(activeAccount), SEARCH_SYNC_MS).unref();
  }
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
