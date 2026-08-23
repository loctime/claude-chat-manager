# Pestaña Codex Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar una pestaña "Codex" a Jarvis con chat interactivo contra Codex CLI (`codex exec`), en paralelo a la pestaña "Chats" de Claude, sin tocar la lógica existente de Claude.

**Architecture:** Patrón espejo — `codex-cmd.js`/`codex-runner.js`/`codex-scanner.js` nuevos, mismas formas que sus equivalentes de Claude pero apuntando a `codex exec`/`~/.codex/sessions/`; reusan `meta.js` tal cual (ya es genérico por archivo) apuntando a un `codex-meta.json` separado; rutas nuevas bajo `/api/codex/...` sin tocar las de Claude; frontend con funciones `codex*` propias que reusan solo los helpers de render genéricos (`addMsg`/`addTool`/`renderTextWithPaths`), no las funciones Claude-específicas (`selectConv`/`performSend`/`loadTree` quedan intactas).

**Tech Stack:** Node.js/Express (backend ya existente), `node --test` (testing ya existente), vanilla JS (frontend ya existente, sin framework).

**Spec:** `docs/superpowers/specs/2026-08-22-pestana-codex-design.md`

## Global Constraints

- v1 incluye: lista, abrir, mandar mensaje, streaming, cancelar, resumir, pin/archivar, adjuntar imagen. v1 excluye: Notas-para-Codex, rewind, compact manual, adjuntar archivos no-imagen, selector de modelo.
- No tocar `runner.js`/`scanner.js`/rutas `/api/conversations/...` existentes de Claude, salvo la extracción puntual descrita en Task 1 (cambio aditivo, mismos tests deben seguir pasando sin modificarlos).
- Todas las rutas nuevas van bajo `/api/codex/...` y respetan el mismo `ACCESS_PIN` que ya protege el resto (no hay auth nueva que armar — el middleware ya corre para todo `/api/*`).
- Windows-only por ahora (mismo alcance que el resto del port a Windows ya documentado en `CLAUDE.local.md`) — no hace falta lógica multi-cuenta ni `sudo`.
- Verificado en vivo en esta PC (2026-08-22) antes de escribir este plan: `codex exec --json`/`codex exec resume <id> --json` con stdin cerrado (`</dev/null`) terminan limpio (exit 0), stdout es JSONL puro (eventos `thread.started`/`turn.started`/`item.started`/`item.completed`/`turn.completed`), stderr trae un aviso inocuo ("Reading additional input from stdin...") que no contamina el parseo. El binario real es `AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js` (Node puro, sin `.exe` vendoreado — a diferencia de Claude, siempre hay que invocarlo vía `node <ruta>`).

---

### Task 1: Extraer los fragmentos de prompt compartidos

**Files:**
- Create: `src/prompt-fragments.js`
- Modify: `src/runner.js:64-82`
- Test: `test/prompt-fragments.test.js`

**Interfaces:**
- Produces: `infraNotice(host, port)` → string; `pathContract()` → string. Ambas funciones puras, sin dependencias.

Motivo: Codex también corre shell dentro de Jarvis y necesita el mismo aviso de "no mates tu propio transporte" y el mismo contrato de rutas que ya tiene Claude — en vez de duplicar el texto literal en `codex-runner.js`, se extrae una vez y la usan los dos runners.

- [ ] **Step 1: Crear el módulo con las dos funciones, texto idéntico al que ya está inline en `runner.js`**

```javascript
// src/prompt-fragments.js
// Fragmentos de --append-system-prompt / cola de prompt compartidos entre
// runner.js (Claude) y codex-runner.js (Codex) — ver CLAUDE.local.md,
// "Modos de respuesta: probados y eliminados" para el porqué de que esto
// tenga que ser regla mecánica y no de estilo.
function infraNotice(host, port) {
  return `AVISO INFRAESTRUCTURA: te está ejecutando claude-chat-manager (Node/Express) en ${host}:${port}. Ese proceso es tu propio transporte hacia el usuario — si lo matás perdés el stream a la mitad y el usuario ve tu respuesta cortada. NO ejecutes comandos que apunten a ese puerto ni a ese proceso: nada de kill/pkill/fuser/lsof -ti:${port} -k, ss ... | xargs kill, systemctl stop, etc. Si el usuario te pide reiniciar el chat-manager, explicale que lo tiene que hacer él desde otra terminal (o via PM2/systemd) porque vos no podés matar tu propio host.`;
}

function pathContract() {
  return `CONTRATO DE RUTAS EN ESTE CHAT: cuando compartas un archivo o carpeta por su ruta, para que aparezca como tarjeta clickeable (descargar / abrir en la PC / bajar zip de una carpeta) escribí la ruta ABSOLUTA en texto plano dentro del mensaje — NUNCA entre backticks ni dentro de un bloque de código \`\`\`, ahí no se detecta. Ejemplos correctos: C:\\Users\\User\\Desktop\\informe.pdf (Windows) o /home/user/carpeta (Linux) — nunca una ruta relativa. Las carpetas con espacios en el nombre no se detectan solas (limitación conocida del detector) — si el nombre tiene espacios, decilo en prosa en vez de mandar la ruta pelada.`;
}

module.exports = { infraNotice, pathContract };
```

- [ ] **Step 2: Escribir el test**

```javascript
// test/prompt-fragments.test.js
const test = require('node:test');
const assert = require('node:assert');
const { infraNotice, pathContract } = require('../src/prompt-fragments');

test('infraNotice incluye host:puerto y menciona el riesgo de auto-matarse', () => {
  const s = infraNotice('127.0.0.1', 3777);
  assert.match(s, /127\.0\.0\.1:3777/);
  assert.match(s, /AVISO INFRAESTRUCTURA/);
});

test('pathContract menciona rutas absolutas y el límite de carpetas con espacios', () => {
  const s = pathContract();
  assert.match(s, /CONTRATO DE RUTAS/);
  assert.match(s, /espacios/);
});
```

- [ ] **Step 3: Correr los tests nuevos**

Run: `npm test -- --test-name-pattern=prompt-fragments` (o `node --test test/prompt-fragments.test.js`)
Expected: PASS, 2 tests.

- [ ] **Step 4: Reemplazar el texto inline en `runner.js` por las llamadas al módulo nuevo**

En `src/runner.js`, agregar `const { infraNotice, pathContract } = require('./prompt-fragments');` junto a los demás `require` del tope, y reemplazar el bloque de `_start()` (líneas ~64-79) que arma `promptFragments` con:

```javascript
    const promptFragments = [];
    if (this.selfPort) {
      const host = this.selfHost || '127.0.0.1';
      promptFragments.push(infraNotice(host, this.selfPort));
      promptFragments.push(pathContract());
    }
```

- [ ] **Step 5: Correr toda la suite existente de runner y confirmar que nada se rompió**

Run: `node --test test/runner.test.js test/runner.concurrency.test.js`
Expected: PASS, mismos tests que antes (el cambio es aditivo, el texto emitido es idéntico byte a byte).

- [ ] **Step 6: Commit**

```bash
git add src/prompt-fragments.js src/runner.js test/prompt-fragments.test.js
git commit -m "refactor: extraer fragmentos de prompt compartidos a prompt-fragments.js

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `codex-cmd.js` — resolver el binario real

**Files:**
- Create: `src/codex-cmd.js`
- Test: `test/codex-cmd.test.js`

**Interfaces:**
- Produces: `resolveCodexCommand()` → string (path o `'codex'` como fallback); `module.exports.CODEX_CMD` = resultado ya resuelto una vez al cargar el módulo (mismo patrón que `claude-cmd.js`).

- [ ] **Step 1: Escribir el módulo**

```javascript
// src/codex-cmd.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// codex en PATH es un shim .cmd de npm (igual que claude, ver claude-cmd.js) —
// Node no puede spawnearlo sin shell:true. A diferencia de Claude, el paquete
// @openai/codex no vendorea un .exe: el entry point real es bin/codex.js, un
// script Node puro. Se invoca con `node <ruta> <args>` (ver isNodeScript en
// codex-runner.js). Verificado en esta PC: where codex → codex.cmd, real en
// AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js.
function resolveCodexCommand() {
  if (process.platform !== 'win32') return 'codex';
  if (process.env.CODEX_CMD) return process.env.CODEX_CMD;
  let candidates = [];
  try {
    candidates = execFileSync('where', ['codex'], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch {}
  for (const c of candidates) {
    const dir = path.dirname(c);
    const entry = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (fs.existsSync(entry)) return entry;
  }
  return 'codex';
}

module.exports = { CODEX_CMD: resolveCodexCommand() };
```

- [ ] **Step 2: Escribir el test — exporta `resolveCodexCommand` además de la constante ya resuelta, para poder testear la función pura sin depender del PATH real de la máquina que corre los tests**

Primero, agregar `resolveCodexCommand` a los exports:

```javascript
module.exports = { CODEX_CMD: resolveCodexCommand(), resolveCodexCommand };
```

```javascript
// test/codex-cmd.test.js
const test = require('node:test');
const assert = require('node:assert');

test('en plataformas no-Windows devuelve "codex" tal cual', () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  delete require.cache[require.resolve('../src/codex-cmd')];
  const { resolveCodexCommand } = require('../src/codex-cmd');
  assert.equal(resolveCodexCommand(), 'codex');
  Object.defineProperty(process, 'platform', original);
  delete require.cache[require.resolve('../src/codex-cmd')];
});

test('CODEX_CMD env var tiene prioridad en Windows', () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  process.env.CODEX_CMD = 'C:\\fake\\codex.js';
  delete require.cache[require.resolve('../src/codex-cmd')];
  const { resolveCodexCommand } = require('../src/codex-cmd');
  assert.equal(resolveCodexCommand(), 'C:\\fake\\codex.js');
  delete process.env.CODEX_CMD;
  Object.defineProperty(process, 'platform', original);
  delete require.cache[require.resolve('../src/codex-cmd')];
});
```

- [ ] **Step 3: Correr el test**

Run: `node --test test/codex-cmd.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 4: Commit**

```bash
git add src/codex-cmd.js test/codex-cmd.test.js
git commit -m "feat: resolver de binario para Codex CLI (codex-cmd.js)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `codex-scanner.js` — indexar y leer sesiones de Codex

**Files:**
- Create: `src/codex-scanner.js`
- Test: `test/codex-scanner.test.js`

**Interfaces:**
- Consumes: nada de tasks anteriores.
- Produces: `listSessions(sessionsDir)` → `[{sessionId, cwd, snippet, messageCount, lastActivity}]`; `findSessionFile(sessionId, sessionsDir)` → string|null; `getMessages(filePath)` → `[{role:'user'|'assistant', text, ts}]`; `toChatMessages(entries)` → mismo shape (función pura separada para poder testearla con fixtures sin tocar disco). Todas usadas por Task 5 (rutas de server.js).

Nota importante descubierta al investigar (no estaba en la spec): `~/.codex/session_index.jsonl` **no** se actualiza cuando la sesión se crea vía `codex exec` (solo lo alimentan otros paths de uso, como el TUI interactivo) — verificado en vivo corriendo `codex exec` y comprobando que el índice no ganó una línea nueva aunque el rollout `.jsonl` sí se escribió. Por eso este scanner **no** usa `session_index.jsonl`: lista caminando `~/.codex/sessions/AAAA/MM/DD/*.jsonl` directo, mismo patrón que `scanner.listSessions` de Claude camina `~/.claude/projects/*/`.

- [ ] **Step 1: Escribir el módulo**

```javascript
// src/codex-scanner.js
const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

function parseJsonl(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return []; }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* línea corrupta: se saltea */ }
  }
  return entries;
}

// Recorre ~/.codex/sessions/AAAA/MM/DD/*.jsonl (3 niveles fijos, no arbitrariamente
// recursivo — así es como Codex CLI los organiza).
function walkRolloutFiles(sessionsDir) {
  const out = [];
  let years;
  try { years = fs.readdirSync(sessionsDir); } catch { return out; }
  for (const y of years) {
    const yDir = path.join(sessionsDir, y);
    let months; try { months = fs.readdirSync(yDir); } catch { continue; }
    for (const m of months) {
      const mDir = path.join(yDir, m);
      let days; try { days = fs.readdirSync(mDir); } catch { continue; }
      for (const d of days) {
        const dDir = path.join(mDir, d);
        let files; try { files = fs.readdirSync(dDir); } catch { continue; }
        for (const f of files) {
          if (f.endsWith('.jsonl')) out.push(path.join(dDir, f));
        }
      }
    }
  }
  return out;
}

// entries → mensajes de chat. Solo user_message/agent_message (event_msg) — los
// tool calls (custom_tool_call/custom_tool_call_output en el rollout persistido)
// quedan fuera de v1 a propósito: se ven en vivo durante el turno (vía SSE, ver
// codex-runner.js) pero no se reconstruyen al reabrir una conversación vieja.
function toChatMessages(entries) {
  const items = [];
  for (const e of entries) {
    if (e.type !== 'event_msg' || !e.payload) continue;
    if (e.payload.type === 'user_message' && e.payload.message) {
      items.push({ role: 'user', text: e.payload.message, ts: e.timestamp });
    } else if (e.payload.type === 'agent_message' && e.payload.message) {
      items.push({ role: 'assistant', text: e.payload.message, ts: e.timestamp });
    }
  }
  return items;
}

function getMessages(filePath) {
  return toChatMessages(parseJsonl(filePath));
}

// Cache por mtime, mismo patrón que _sessionInfoCache en scanner.js.
const _infoCache = new Map();

function _computeSessionInfo(filePath) {
  const entries = parseJsonl(filePath);
  const meta = entries.find(e => e.type === 'session_meta');
  const msgs = toChatMessages(entries);
  if (!meta && msgs.length === 0) return null;
  const firstUser = msgs.find(m => m.role === 'user');
  const snippet = firstUser ? firstUser.text.trim().slice(0, 60) : '(sin mensajes)';
  const last = entries[entries.length - 1];
  let lastActivity = last && last.timestamp;
  if (!lastActivity) { try { lastActivity = fs.statSync(filePath).mtime.toISOString(); } catch { lastActivity = null; } }
  return {
    sessionId: meta ? (meta.payload.session_id || meta.payload.id) : path.basename(filePath, '.jsonl').split('-').slice(-5).join('-'),
    cwd: meta ? meta.payload.cwd : null,
    snippet,
    messageCount: msgs.length,
    lastActivity,
  };
}

function sessionInfo(filePath) {
  let mtimeMs;
  try { mtimeMs = fs.statSync(filePath).mtimeMs; }
  catch { _infoCache.delete(filePath); return null; }
  const cached = _infoCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.info;
  const info = _computeSessionInfo(filePath);
  _infoCache.set(filePath, { mtimeMs, info });
  return info;
}

function listSessions(sessionsDir = SESSIONS_DIR) {
  const sessions = [];
  for (const f of walkRolloutFiles(sessionsDir)) {
    const info = sessionInfo(f);
    if (info && info.sessionId) sessions.push(info);
  }
  return sessions;
}

// El nombre de archivo siempre termina en "-<sessionId>.jsonl" (verificado en
// vivo: rollout-2026-08-22T21-48-07-01a02c16-d110-78b2-bb8d-9848fd815cde.jsonl).
// Matchear por sufijo de nombre es mucho más barato que parsear cada archivo
// para leer su session_meta, y alcanza para encontrar el archivo a abrir.
function findSessionFile(sessionId, sessionsDir = SESSIONS_DIR) {
  const suffix = `-${sessionId}.jsonl`;
  for (const f of walkRolloutFiles(sessionsDir)) {
    if (f.endsWith(suffix)) return f;
  }
  return null;
}

function _clearSessionInfoCache() { _infoCache.clear(); }

module.exports = { listSessions, findSessionFile, getMessages, toChatMessages, SESSIONS_DIR, _clearSessionInfoCache };
```

- [ ] **Step 2: Escribir los tests con fixtures en un directorio temporal (mismo patrón que `scanner.test.js` — no depende de sesiones reales de la máquina)**

```javascript
// test/codex-scanner.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const scanner = require('../src/codex-scanner');

function makeTmpSessionsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-scanner-test-'));
}

function writeRollout(sessionsDir, sessionId, lines) {
  const dir = path.join(sessionsDir, '2026', '08', '22');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-08-22T00-00-00-${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

test('toChatMessages: extrae solo user_message y agent_message', () => {
  const entries = [
    { type: 'session_meta', payload: { session_id: 's1', cwd: 'C:\\x' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'hola' }, timestamp: 't1' },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'hola de vuelta' }, timestamp: 't2' },
    { type: 'event_msg', payload: { type: 'token_count' } }, // se ignora
  ];
  const msgs = scanner.toChatMessages(entries);
  assert.deepEqual(msgs, [
    { role: 'user', text: 'hola', ts: 't1' },
    { role: 'assistant', text: 'hola de vuelta', ts: 't2' },
  ]);
});

test('listSessions: camina AAAA/MM/DD y arma snippet + cwd desde session_meta', () => {
  const dir = makeTmpSessionsDir();
  writeRollout(dir, 'abc-123', [
    { type: 'session_meta', payload: { session_id: 'abc-123', cwd: 'C:\\Users\\User' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'primer mensaje de prueba' }, timestamp: '2026-08-22T00:00:01Z' },
  ]);
  scanner._clearSessionInfoCache();
  const sessions = scanner.listSessions(dir);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, 'abc-123');
  assert.equal(sessions[0].cwd, 'C:\\Users\\User');
  assert.equal(sessions[0].snippet, 'primer mensaje de prueba');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('findSessionFile: matchea por sufijo del nombre de archivo', () => {
  const dir = makeTmpSessionsDir();
  const file = writeRollout(dir, 'xyz-789', [{ type: 'session_meta', payload: { session_id: 'xyz-789', cwd: 'C:\\p' } }]);
  assert.equal(scanner.findSessionFile('xyz-789', dir), file);
  assert.equal(scanner.findSessionFile('no-existe', dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getMessages: una línea corrupta no tira abajo el resto', () => {
  const dir = makeTmpSessionsDir();
  const file = path.join(dir, '2026', '08', '22');
  fs.mkdirSync(file, { recursive: true });
  const f = path.join(file, 'rollout-2026-08-22T00-00-00-corrupt-1.jsonl');
  fs.writeFileSync(f, '{"type":"event_msg","payload":{"type":"user_message","message":"ok"},"timestamp":"t1"}\nno es json\n');
  const msgs = scanner.getMessages(f);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, 'ok');
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 3: Correr los tests**

Run: `node --test test/codex-scanner.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 4: Commit**

```bash
git add src/codex-scanner.js test/codex-scanner.test.js
git commit -m "feat: codex-scanner.js — listar y leer sesiones de Codex CLI

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: `codex-runner.js` — spawnear `codex exec` y traducir eventos

**Files:**
- Create: `src/codex-runner.js`
- Test: `test/codex-runner.test.js`

**Interfaces:**
- Consumes: `CODEX_CMD` de `src/codex-cmd.js`; `infraNotice`/`pathContract` de `src/prompt-fragments.js`.
- Produces: clase `CodexRunner` (EventEmitter) con `send({convId, sessionId, cwd, text, imagePath})`, `isBusy(convId)`, `cancel(convId)` — misma API pública que `Runner`, usada por Task 5. Emite `'status'` (`{convId, status:'running'|'queued'|'idle', code, stderr}`) y `'event'` (`{convId, event}` con `event` = línea JSON parseada tal cual de `codex exec --json`).

Verificado en vivo (esta PC, 2026-08-22): `codex exec --json --dangerously-bypass-approvals-and-sandbox -C <cwd> "<prompt>"` con stdin `ignore` termina con exit 0 y stdout limpio; `codex exec resume <id> --json ...` reusa el mismo `thread_id`. No hace falta lógica de cola con `maxConcurrent` como en `Runner` — Codex y Claude corren en árboles de proceso separados y no compiten por nada — pero se mantiene el mismo semáforo simple (`maxConcurrent: 2`) para no dejar que un uso descuidado dispare procesos Codex ilimitados en paralelo.

- [ ] **Step 1: Escribir el módulo**

```javascript
// src/codex-runner.js
const { spawn, execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const { CODEX_CMD } = require('./codex-cmd');
const { infraNotice, pathContract } = require('./prompt-fragments');

const IS_WIN = process.platform === 'win32';

class CodexRunner extends EventEmitter {
  constructor({ maxConcurrent = 2, spawnFn = spawn, command = CODEX_CMD, selfHost, selfPort } = {}) {
    super();
    this.max = maxConcurrent;
    this.spawnFn = spawnFn;
    this.command = command;
    this.selfHost = selfHost;
    this.selfPort = selfPort;
    this.queue = [];
    this.running = new Map(); // convId → child
  }

  send(job) {
    this.queue.push(job);
    this.emit('status', { convId: job.convId, status: 'queued' });
    this._drain();
  }

  isBusy(convId) {
    return this.running.has(convId) || this.queue.some(j => j.convId === convId);
  }

  cancel(convId) {
    const child = this.running.get(convId);
    if (child) {
      if (IS_WIN && child.pid) {
        try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); }
        catch { child.kill('SIGTERM'); }
      } else {
        child.kill('SIGTERM');
      }
      return true;
    }
    const idx = this.queue.findIndex(j => j.convId === convId);
    if (idx >= 0) {
      const [job] = this.queue.splice(idx, 1);
      this.emit('status', { convId: job.convId, status: 'idle', code: -1, cancelled: true });
      return true;
    }
    return false;
  }

  _drain() {
    while (this.running.size < this.max && this.queue.length > 0) {
      this._start(this.queue.shift());
    }
  }

  _start(job) {
    const promptParts = [job.text];
    if (this.selfPort) {
      const host = this.selfHost || '127.0.0.1';
      promptParts.push(infraNotice(host, this.selfPort));
      promptParts.push(pathContract());
    }
    const prompt = promptParts.join('\n\n');

    const sub = ['exec'];
    if (job.sessionId) sub.push('resume', job.sessionId);
    const args = [...sub, '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'];
    if (job.cwd) args.push('-C', job.cwd);
    if (job.imagePath) args.push('-i', job.imagePath);
    args.push(prompt);

    // El paquete @openai/codex no vendorea un .exe (ver codex-cmd.js) — siempre
    // se invoca vía node.exe con el script como primer argumento, igual que el
    // caso isNodeScript de runner.js para un CLAUDE_CMD apuntando a un .js.
    const isNodeScript = /\.[cm]?js$/i.test(this.command);
    const spawnCmd = isNodeScript ? process.execPath : this.command;
    const spawnArgs = isNodeScript ? [this.command, ...args] : args;

    const child = this.spawnFn(spawnCmd, spawnArgs, { cwd: job.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.running.set(job.convId, child);
    this.emit('status', { convId: job.convId, status: 'running' });

    let buf = '';
    let stderr = '';
    let done = false;

    child.stdout.on('data', d => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        this.emit('event', { convId: job.convId, event: ev });
      }
    });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => {
      if (done) return;
      done = true;
      this.running.delete(job.convId);
      this.emit('status', { convId: job.convId, status: 'idle', code: -1, stderr: err.message });
      this._drain();
    });
    child.on('close', code => {
      if (done) return;
      done = true;
      this.running.delete(job.convId);
      if (buf.trim()) {
        let ev;
        try { ev = JSON.parse(buf); } catch {}
        if (ev) this.emit('event', { convId: job.convId, event: ev });
      }
      const status = { convId: job.convId, status: 'idle', code };
      if (code !== 0) status.stderr = stderr;
      this.emit('status', status);
      this._drain();
    });
  }
}

module.exports = { CodexRunner };
```

- [ ] **Step 2: Escribir los tests, mismo patrón que `test/runner.test.js` (fakeChild + spawnFn inyectado)**

```javascript
// test/codex-runner.test.js
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { CodexRunner } = require('../src/codex-runner');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  // pid + kill: cancel() en Windows revisa child.pid antes de intentar
  // taskkill, y cae a child.kill(...) si taskkill falla — sin estos dos
  // campos, cancelar un job "corriendo" en el test tira TypeError
  // (EventEmitter no tiene .kill). El pid es inventado: taskkill va a
  // fallar contra un PID inexistente, se cae al catch, y child.kill (acá
  // un no-op) absorbe el resto sin tocar ningún proceso real.
  child.pid = 999999;
  child.kill = () => {};
  return child;
}

function makeRunner(spawned, opts = {}) {
  return new CodexRunner({
    maxConcurrent: 2,
    ...opts,
    spawnFn: (cmd, args, o) => {
      const child = fakeChild();
      spawned.push({ cmd, args, opts: o, child });
      return child;
    },
  });
}

test('mensaje nuevo: "exec" sin "resume", con -C y el prompt al final', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  r.send({ convId: 'c1', sessionId: null, cwd: 'C:\\p', text: 'hola' });
  const a = spawned[0].args;
  assert.equal(a[0], 'exec');
  assert.ok(!a.includes('resume'));
  assert.ok(a.includes('-C') && a[a.indexOf('-C') + 1] === 'C:\\p');
  assert.equal(a[a.length - 1], 'hola');
});

test('con sessionId: "exec resume <id>"', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  r.send({ convId: 'c1', sessionId: 's1', cwd: 'C:\\p', text: 'segundo mensaje' });
  const a = spawned[0].args;
  assert.equal(a[0], 'exec');
  assert.equal(a[1], 'resume');
  assert.equal(a[2], 's1');
});

test('con imagePath agrega -i', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  r.send({ convId: 'c1', sessionId: null, cwd: 'C:\\p', text: 'mirá esto', imagePath: 'C:\\img.png' });
  const a = spawned[0].args;
  assert.ok(a.includes('-i') && a[a.indexOf('-i') + 1] === 'C:\\img.png');
});

test('con selfPort, el prompt final incluye el aviso de infraestructura y el contrato de rutas', () => {
  const spawned = [];
  const r = makeRunner(spawned, { selfPort: 3777 });
  r.send({ convId: 'c1', sessionId: null, cwd: 'C:\\p', text: 'hola' });
  const prompt = spawned[0].args[spawned[0].args.length - 1];
  assert.match(prompt, /^hola/);
  assert.match(prompt, /AVISO INFRAESTRUCTURA/);
  assert.match(prompt, /CONTRATO DE RUTAS/);
});

test('command siempre incluye --dangerously-bypass-approvals-and-sandbox y --json', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  r.send({ convId: 'c1', sessionId: null, cwd: 'C:\\p', text: 'hola' });
  const a = spawned[0].args;
  assert.ok(a.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(a.includes('--json'));
});

test('parsea stdout JSONL y emite un evento por línea', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  const events = [];
  r.on('event', e => events.push(e));
  r.send({ convId: 'c1', sessionId: null, cwd: 'C:\\p', text: 'hola' });
  spawned[0].child.stdout.emit('data', '{"type":"thread.started","thread_id":"t1"}\n{"type":"turn.completed","usage":{}}\n');
  assert.equal(events.length, 2);
  assert.equal(events[0].event.type, 'thread.started');
  assert.equal(events[0].event.thread_id, 't1');
});

test('close con código 0 emite status idle', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  const statuses = [];
  r.on('status', s => statuses.push(s));
  r.send({ convId: 'c1', sessionId: null, cwd: 'C:\\p', text: 'hola' });
  spawned[0].child.emit('close', 0);
  const idle = statuses.find(s => s.status === 'idle');
  assert.equal(idle.code, 0);
  assert.equal(r.isBusy('c1'), false);
});

test('cancelar en cola vs. corriendo', () => {
  const spawned = [];
  const r = makeRunner(spawned, { maxConcurrent: 1 });
  r.send({ convId: 'c1', sessionId: null, cwd: 'C:\\p', text: 'a' });
  r.send({ convId: 'c2', sessionId: null, cwd: 'C:\\p', text: 'b' });
  assert.equal(r.cancel('c2'), true); // en cola
  assert.equal(r.isBusy('c2'), false);
  assert.equal(r.cancel('c1'), true); // corriendo → taskkill contra el pid falso falla, cae a child.kill() (no-op en el fake)
});
```

- [ ] **Step 3: Correr los tests**

Run: `node --test test/codex-runner.test.js`
Expected: PASS, 8 tests (el último test de `cancel` puede loguear un intento fallido de `taskkill` si no hay proceso real con ese PID — no falla el assert, `cancel()` igual devuelve `true` porque encontró el child en `running`).

- [ ] **Step 4: Commit**

```bash
git add src/codex-runner.js test/codex-runner.test.js
git commit -m "feat: codex-runner.js — spawnea codex exec y traduce eventos JSONL

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Rutas de servidor — `/api/codex/...`

**Files:**
- Modify: `src/server.js`

**Interfaces:**
- Consumes: `CodexRunner` (Task 4), `codex-scanner` (Task 3), `meta.load`/`meta.save`/`meta.advanceSession` (ya existente, sin cambios).
- Produces: rutas HTTP consumidas por el frontend en Tasks 6-7.

No hay test automatizado para esto (mismo criterio que el resto de `server.js`: sin test de integración HTTP/SSE en el repo). Se verifica a mano en Task 8.

- [ ] **Step 1: Agregar imports y el store de meta de Codex, cerca de donde ya se define `runner`/`sseClients` (línea ~623 de `server.js`)**

```javascript
const { CodexRunner } = require('./codex-runner');
const codexScanner = require('./codex-scanner');

const CODEX_META_FILE = path.join(os.homedir(), '.claude', 'session-manager', 'codex-meta.json');
const codexRunner = new CodexRunner({ selfHost: HOST, selfPort: PORT });
const codexSseClients = new Map(); // convId → Set<res>

function codexBroadcast(convId, payload) {
  const set = codexSseClients.get(convId);
  if (!set) return;
  for (const res of set) res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function codexConvStatus(convId) {
  return codexRunner.running.has(convId) ? 'running' : codexRunner.isBusy(convId) ? 'queued' : 'idle';
}
```

(`path` y `os` ya están importados arriba en `server.js` para el resto de la app — no hace falta agregarlos de nuevo.)

- [ ] **Step 2: Wire de eventos del runner, mismo patrón que el bloque `runner.on('event', ...)`/`runner.on('status', ...)` ya existente**

```javascript
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
  // Mismo criterio de "no leído" que ya usa Claude (ver runner.on('status', ...)
  // más arriba en este archivo): un turno terminó sin nadie mirando esta convId
  // por SSE ahora mismo → se marca unread. No se replica la generación de título
  // por IA ni el resync del índice de búsqueda — ninguno de los dos existe para
  // Codex en v1 (fuera de alcance, ver spec).
  if (s.status === 'idle' && !s.cancelled) {
    const hasViewer = (codexSseClients.get(s.convId)?.size || 0) > 0;
    if (!hasViewer) {
      const data = meta.load(CODEX_META_FILE);
      const conv = data.conversations[s.convId];
      if (conv) {
        conv.unread = true;
        meta.save(data, CODEX_META_FILE);
      }
    }
  }
});
```

- [ ] **Step 3: Rutas CRUD — crear/listar/parchear conversaciones**

```javascript
app.post('/api/codex/conversations', (req, res) => {
  const projectDir = process.env.CCM_DEFAULT_PROJECT_DIR || os.homedir();
  const convId = crypto.randomUUID();
  const data = meta.load(CODEX_META_FILE);
  data.conversations[convId] = { currentSessionId: null, projectDir };
  meta.save(data, CODEX_META_FILE);
  res.status(201).json({ convId, projectDir });
});

app.get('/api/codex/tree', (req, res) => {
  const data = meta.load(CODEX_META_FILE);
  const sessions = codexScanner.listSessions();
  const byId = new Map(sessions.map(s => [s.sessionId, s]));
  const convs = [];
  for (const [convId, c] of Object.entries(data.conversations)) {
    if (c.hidden) continue;
    const s = byId.get(c.currentSessionId) || {};
    convs.push({
      convId,
      name: c.name || s.snippet || '(nueva conversación)',
      snippet: s.snippet || '',
      lastActivity: s.lastActivity || null,
      messageCount: s.messageCount || 0,
      pinned: !!c.pinned,
      archived: !!c.archived,
      unread: !!c.unread,
      status: codexConvStatus(convId),
    });
  }
  const showArchived = req.query.archived === '1';
  const filtered = showArchived ? convs.filter(c => c.archived) : convs.filter(c => !c.archived);
  filtered.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.lastActivity || '').localeCompare(a.lastActivity || '');
  });
  res.json({ conversations: filtered, archivedTotal: convs.filter(c => c.archived).length });
});

app.patch('/api/codex/conversations/:id', (req, res) => {
  const data = meta.load(CODEX_META_FILE);
  const conv = data.conversations[req.params.id];
  if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
  if ('pinned' in req.body) conv.pinned = !!req.body.pinned;
  if ('archived' in req.body) conv.archived = !!req.body.archived;
  if ('unread' in req.body) conv.unread = !!req.body.unread;
  meta.save(data, CODEX_META_FILE);
  res.json({ ok: true });
});
```

Nota: no se replica `hidden` (no hay UI para eso en v1) ni `resolveConv`/multi-cuenta (Codex es single-account).

- [ ] **Step 4: Mensajes y envío**

```javascript
app.get('/api/codex/conversations/:id/messages', (req, res) => {
  const data = meta.load(CODEX_META_FILE);
  const conv = data.conversations[req.params.id];
  if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
  if (!conv.currentSessionId) return res.json([]);
  const file = codexScanner.findSessionFile(conv.currentSessionId);
  res.json(file ? codexScanner.getMessages(file) : []);
});

app.post('/api/codex/conversations/:id/message', (req, res) => {
  const convId = req.params.id;
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'mensaje vacío' });
  if (codexRunner.isBusy(convId)) return res.status(409).json({ error: 'esa conversación ya está procesando un mensaje' });
  const data = meta.load(CODEX_META_FILE);
  const conv = data.conversations[convId];
  if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
  const cwd = conv.projectDir || os.homedir();
  codexRunner.send({ convId, sessionId: conv.currentSessionId, cwd, text, imagePath: req.body.imagePath || undefined });
  res.status(202).json({ queued: true });
});

app.delete('/api/codex/conversations/:id/message', (req, res) => {
  res.json({ cancelled: codexRunner.cancel(req.params.id) });
});
```

- [ ] **Step 5: SSE stream, mismo heartbeat de 20s y mismo "sincronizar estado al conectar" que el de Claude**

```javascript
app.get('/api/codex/conversations/:id/stream', (req, res) => {
  const convId = req.params.id;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('\n');
  if (!codexSseClients.has(convId)) codexSseClients.set(convId, new Set());
  codexSseClients.get(convId).add(res);
  const st = codexConvStatus(convId);
  if (st !== 'idle') res.write(`data: ${JSON.stringify({ kind: 'status', status: st })}\n\n`);
  const heartbeat = setInterval(() => res.write(':heartbeat\n\n'), 20000);
  req.on('close', () => {
    clearInterval(heartbeat);
    const set = codexSseClients.get(convId);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) codexSseClients.delete(convId);
  });
});
```

- [ ] **Step 6: Levantar el server local y probar las rutas a mano con curl (con el ACCESS_PIN real de esta PC)**

Run (PowerShell, con Jarvis corriendo local): usar la cookie de sesión ya autenticada del navegador, o pegar el flujo de `/__auth` — más simple: probar desde el navegador ya logueado pegándole a `http://127.0.0.1:3777/api/codex/tree` y a un POST de `/api/codex/conversations` desde la consola del devtools con `fetch('/api/codex/conversations', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'}).then(r=>r.json()).then(console.log)`.
Expected: `POST /api/codex/conversations` devuelve `{convId, projectDir}`; `GET /api/codex/tree` devuelve `{conversations:[], archivedTotal:0}` con la conversación recién creada si tiene `currentSessionId` o directamente vacía si no matchea ningún session file todavía (correcto: recién se crea el archivo de sesión al mandar el primer mensaje).

- [ ] **Step 7: Commit**

```bash
git add src/server.js
git commit -m "feat: rutas /api/codex/... (tree, messages, message, stream, cancel, patch)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Frontend — pestaña Codex, árbol de conversaciones

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/style.css` (solo si hace falta un ajuste puntual — la mayoría de las clases ya existen y se reusan)

**Interfaces:**
- Consumes: rutas de Task 5.
- Produces: `codexApi(path, opts)`, `codexLoadTree()`, `codexConvElement(c)`, extensión de `goToPane`/paneIndex a un 4to pane (índice 3 = "Codex").

- [ ] **Step 1: Agregar la pestaña "Codex" al tab bar y el pane nuevo en `index.html`, junto a los paneles existentes de Chats/Archivado/Notas**

Ubicar el bloque de `.pane-tab` (desktop) y el contenedor `#tree-viewport-inner` (mobile swipe) en `index.html`, agregar un cuarto botón `data-pane="3"` con texto "Codex" y un cuarto `<div class="pane">` con esta estructura interna (ids exactos — los usa el código de los steps siguientes):

```html
<div class="pane" id="codex-pane">
  <div id="codex-tree">
    <button onclick="codexNewConversation()">+ Nueva conversación</button>
    <button id="codex-archived-toggle" onclick="codexToggleArchivedView()">Ver archivadas</button>
    <div id="codex-tree-list"></div>
  </div>
  <div id="codex-chat" style="display:none">
    <button onclick="codexShowTreeList()">← Volver</button>
    <div id="codex-messages"></div>
    <div class="composer">
      <input type="file" id="codex-image-input" accept="image/*" style="display:none">
      <button id="codex-attach-btn" onclick="$('codex-image-input').click()">📎</button>
      <textarea id="codex-composer-text" placeholder="Escribile a Codex..."></textarea>
      <button id="codex-cancel-btn" style="display:none" onclick="codexCancel()">Cancelar</button>
      <button id="codex-send-btn" onclick="codexSubmitComposer()">Enviar</button>
    </div>
  </div>
</div>
```

`codex-chat` arranca oculto y se muestra al entrar a una conversación (mismo patrón mobile que usa Chats: la vista de conversación se superpone al árbol, no coexisten side-by-side en pantallas chicas). Reusar las clases CSS ya existentes (`.pane`, `.pane-tab`, `.tree-row`, `.composer`, etc.) — no se necesita CSS nuevo salvo por `.tree-row-action` (Step 3 de este task).

- [ ] **Step 2: `codexApi` — mismo wrapper que `api()` pero sin `withAccount`/`withAccountBody` (Codex es single-account)**

```javascript
async function codexApi(path, opts) {
  const method = (opts && opts.method) || 'GET';
  const res = method === 'GET'
    ? await netFetch('/api/codex' + path, opts)
    : await fetch('/api/codex' + path, opts).catch(err => { throw netError(err); });
  if (!res.ok && res.status !== 202) throw new Error((await res.json()).error || res.statusText);
  return res.json();
}
```

- [ ] **Step 3: Fila de conversación simplificada (sin badges de modelo/costo — eso es Claude-específico), con pin/archivar como botones directos en vez del swipe complejo de Chats — misma acción final (PATCH), gesto más simple: swipe-to-archive depende de la estructura DOM específica de `attachRowGestures` (pensada para las filas de Claude, con su propio menú contextual) y replicarla entera no vale la pena para v1. Dos botones (📌/🗄️) visibles en la fila cubren el mismo caso de uso con una fracción del código.**

```javascript
async function codexTogglePin(convId, pinned) {
  await codexApi(`/conversations/${convId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned }),
  });
  codexLoadTree();
}

async function codexToggleArchive(convId, archived) {
  await codexApi(`/conversations/${convId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archived }),
  });
  codexLoadTree();
}

function codexConvElement(c) {
  const div = document.createElement('div');
  div.className = 'tree-row';
  div.dataset.convId = c.convId;
  const badgeEl = badge(c.status) || (c.unread ? '<span class="unread-dot"></span>' : '');
  const main = document.createElement('div');
  main.className = 'tree-row-main';
  const nameEl = document.createElement('span');
  nameEl.className = 'tree-row-name';
  nameEl.textContent = c.name; // textContent, no innerHTML — mismo criterio de escape que el resto del árbol
  main.appendChild(nameEl);
  if (badgeEl) main.insertAdjacentHTML('beforeend', badgeEl);
  const snippet = document.createElement('div');
  snippet.className = 'tree-row-snippet';
  snippet.textContent = c.snippet;
  const pinBtn = document.createElement('button');
  pinBtn.className = 'tree-row-action';
  pinBtn.textContent = c.pinned ? '📌' : '📍';
  pinBtn.title = c.pinned ? 'Desanclar' : 'Anclar';
  pinBtn.onclick = ev => { ev.stopPropagation(); codexTogglePin(c.convId, !c.pinned); };
  const archiveBtn = document.createElement('button');
  archiveBtn.className = 'tree-row-action';
  archiveBtn.textContent = c.archived ? '↩️' : '🗄️';
  archiveBtn.title = c.archived ? 'Desarchivar' : 'Archivar';
  archiveBtn.onclick = ev => { ev.stopPropagation(); codexToggleArchive(c.convId, !c.archived); };
  div.appendChild(main);
  div.appendChild(snippet);
  div.appendChild(pinBtn);
  div.appendChild(archiveBtn);
  div.onclick = () => codexSelectConv(c.convId, c.name);
  return div;
}

let codexShowingArchived = false;

async function codexLoadTree() {
  const { conversations, archivedTotal } = await codexApi(`/tree${codexShowingArchived ? '?archived=1' : ''}`);
  const nav = $('codex-tree-list');
  nav.innerHTML = '';
  if (conversations.length === 0) {
    nav.innerHTML = `<div class="empty-state">${codexShowingArchived ? 'Sin conversaciones archivadas' : 'Sin conversaciones de Codex todavía'}</div>`;
  } else {
    for (const c of conversations) nav.appendChild(codexConvElement(c));
  }
  $('codex-archived-toggle').textContent = codexShowingArchived ? '← Volver a activas' : `Ver archivadas (${archivedTotal})`;
}

function codexToggleArchivedView() {
  codexShowingArchived = !codexShowingArchived;
  codexLoadTree();
}
```

Agregar en `index.html`, dentro del pane de Codex: un botón `id="codex-archived-toggle"` con `onclick="codexToggleArchivedView()"`, junto al botón "+ Nueva conversación" (mismo lugar donde Chats tiene el suyo).

`badge` y `$` ya existen en `app.js` y se reusan tal cual; `.tree-row-action` es una clase nueva — si no hay ya un estilo de botón chico reusable en `style.css`, agregar un estilo mínimo (padding chico, sin borde, mismo tamaño de fuente que los íconos de badge existentes).

- [ ] **Step 4: Botón "+ Nueva conversación Codex" y extender `goToPane`/`initPaneSwipe` al 4to índice**

En el botón de nueva conversación del pane Codex:

```javascript
async function codexNewConversation() {
  const { convId } = await codexApi('/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  codexSelectConv(convId, 'Nueva conversación');
}
```

En `goToPane(index)`, agregar el caso `index === 3` con su propio guard de "ya cargado" (mismo patrón que `archivedPaneLoaded`/`notebookListLoaded`):

```javascript
  if (index === 3 && !codexTreeLoaded) {
    try {
      await codexLoadTree();
      codexTreeLoaded = true;
    } catch (err) {
      toast('No se pudo cargar Codex: ' + err.message);
      if (myGeneration === paneNavGeneration) paneNavTarget = activePane;
      return;
    }
  }
```

Declarar `let codexTreeLoaded = false;` junto a las otras variables de estado de panes (`archivedPaneLoaded`, `notebookListLoaded`). Actualizar el swipe mobile (`initPaneSwipe`/`paneSwipeEnd`) para que el rango de índices válidos pase de 0-2 a 0-3, y el tab bar desktop para mostrar el 4to botón.

- [ ] **Step 5: Probar a mano en el browser (local, `http://127.0.0.1:3777`)**

Abrir Jarvis, ir a la pestaña Codex, confirmar que la lista carga vacía la primera vez, crear una conversación nueva y confirmar que aparece en la lista tras volver al árbol (aunque todavía no se pueda chatear — eso es Task 7).

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/app.js public/style.css
git commit -m "feat: pestaña Codex — árbol de conversaciones

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Frontend — chatear con Codex (mensajes, streaming, cancelar, adjuntar imagen)

**Files:**
- Modify: `public/app.js`
- Modify: `public/index.html` (composer propio de Codex)

**Interfaces:**
- Consumes: `codexApi` (Task 6), `addMsg`/`addTool` generalizados (este task los generaliza), `uploadFiles`/`prepareForUpload` (ya existentes, reusados tal cual para adjuntar imagen).

- [ ] **Step 1: Generalizar `addMsg`/`addTool` para aceptar un contenedor destino opcional — cambio aditivo, default preserva el comportamiento actual**

En `public/app.js`, cambiar la firma de ambas funciones:

```javascript
function addMsg(role, text, opts = {}) {
  const container = opts.container || messagesEl;
  const existing = container.querySelector('#empty-state') || (container === messagesEl ? document.getElementById('empty-state') : null);
  if (existing) existing.remove();
  // ... resto de la función igual, reemplazando cada `messagesEl.appendChild(div)` por `container.appendChild(div)`
}

function addTool(name, input, output, opts = {}) {
  const container = opts.container || messagesEl;
  // ... resto de la función igual, reemplazando el appendChild final por `container.appendChild(det)`
}
```

Verificar con `grep -n "messagesEl.appendChild\|container.appendChild" public/app.js` que solo esos dos `appendChild` finales cambiaron, y que ningún otro call site de `addMsg`/`addTool` pasa un segundo argumento posicional que ahora colisione con `opts.container` (todos los usos existentes pasan `opts` como tercer/cuarto argumento con otras claves — `container` es nueva, no pisa nada).

- [ ] **Step 2: Correr la suite completa para confirmar que el cambio aditivo no rompió nada (no hay tests de DOM en este repo, pero sí puede haber tests que importen `app.js` — confirmar)**

Run: `npm test`
Expected: mismos resultados que antes de este task (si `app.js` no está bajo test — es frontend puro sin `require` en Node — este paso es un no-op informativo; confirmarlo mirando si `test/*.test.js` referencia `public/app.js`, y si no, saltar directo a la verificación manual del Step 5).

- [ ] **Step 3: Composer propio de Codex — texto + adjuntar imagen + enviar, en el pane de Codex de `index.html`**

Reusar el `<input type="file" accept="image/*">` + `prepareForUpload`/`uploadAttachment` ya existentes para la subida (mismo flujo que ya materializa el archivo a Blob y lo sube a `.ccm-uploads`, devolviendo una ruta local). El composer de Codex es más simple que el de Claude: sin selector de modelo, sin adjuntar archivos no-imagen.

```javascript
async function codexPerformSend(convId, text, imagePath) {
  addMsg('user', text, { container: $('codex-messages') });
  setCodexBusy(true);
  try {
    await codexApi(`/conversations/${convId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, imagePath }),
    });
  } catch (err) {
    addMsg('error', 'No se pudo enviar: ' + err.message, { container: $('codex-messages') });
    setCodexBusy(false);
  }
}

// Sube una imagen a /api/upload (mismo endpoint genérico que ya usa el
// composer de Chats, no es Codex-específico) y devuelve la ruta local.
// No se reusa uploadAttachment() tal cual: esa función está acoplada al DOM
// del composer de Claude (escribe en #composer-attachments, empuja a
// pendingAttachments, y aborta si currentConv es null) — para Codex hace
// falta solo la subida, sin esos efectos secundarios. Sí se reusa
// prepareForUpload(), que es genérica (File → Blob, sin tocar el DOM).
async function codexUploadImage(file) {
  const { blob, name } = await prepareForUpload(file, file.name);
  const fd = new FormData();
  fd.append('file', blob, name);
  const res = await netFetch('/api/upload', { method: 'POST', body: fd });
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  const { path: filePath } = await res.json();
  return filePath;
}

async function codexSubmitComposer() {
  const textEl = $('codex-composer-text');
  const text = textEl.value.trim();
  if (!text || !currentCodexConv) return;
  const imageInput = $('codex-image-input');
  let imagePath;
  try {
    if (imageInput.files[0]) {
      imagePath = await codexUploadImage(imageInput.files[0]);
      imageInput.value = '';
    }
  } catch (err) {
    addMsg('error', 'No se pudo subir la imagen: ' + err.message, { container: $('codex-messages') });
    return;
  }
  textEl.value = '';
  await codexPerformSend(currentCodexConv, text, imagePath);
}
```

- [ ] **Step 4: Abrir conversación — cargar historial + abrir el stream SSE**

```javascript
let currentCodexConv = null;

async function codexLoadMessages(convId) {
  const container = $('codex-messages');
  container.innerHTML = '';
  const msgs = await codexApi(`/conversations/${convId}/messages`);
  for (const m of msgs) addMsg(m.role, m.text, { container, ts: m.ts });
  if (msgs.length === 0) container.innerHTML = '<div id="empty-state" class="empty-state">Escribile algo a Codex</div>';
}

function codexOpenStream(convId) {
  const es = new EventSource(`/api/codex/conversations/${convId}/stream`);
  es.onmessage = e => {
    const data = JSON.parse(e.data);
    const container = $('codex-messages');
    if (data.kind === 'status') {
      setCodexBusy(data.status === 'running' || data.status === 'queued');
      return;
    }
    if (data.kind !== 'codex') return;
    const ev = data.event;
    if (ev.type === 'item.completed' && ev.item) {
      if (ev.item.type === 'agent_message' && ev.item.text) {
        addMsg('assistant', ev.item.text, { container });
      } else if (ev.item.type === 'command_execution') {
        addTool('command_execution', { command: ev.item.command }, ev.item.aggregated_output || '', { container });
      }
    }
  };
  es.onerror = () => { /* EventSource reintenta solo; nada que hacer acá */ };
  return es;
}

let codexStream = null;

function codexShowChat() {
  $('codex-tree').style.display = 'none';
  $('codex-chat').style.display = '';
}

function codexShowTreeList() {
  if (codexStream) { codexStream.close(); codexStream = null; }
  currentCodexConv = null;
  $('codex-chat').style.display = 'none';
  $('codex-tree').style.display = '';
  codexLoadTree();
}

async function codexSelectConv(convId, name) {
  currentCodexConv = convId;
  codexShowChat();
  if (codexStream) codexStream.close();
  // Limpiar "no leído" al abrir, en paralelo con la carga de mensajes — mismo
  // orden que usa selectConv() para Claude (PATCH antes de refrescar el árbol,
  // evita que el punto quede pegado un instante de más por una carrera).
  codexApi(`/conversations/${convId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unread: false }),
  }).catch(() => {});
  await codexLoadMessages(convId);
  codexStream = codexOpenStream(convId);
}

function setCodexBusy(b) {
  $('codex-send-btn').disabled = b;
  $('codex-cancel-btn').style.display = b ? '' : 'none';
}

async function codexCancel() {
  if (!currentCodexConv) return;
  await codexApi(`/conversations/${currentCodexConv}/message`, { method: 'DELETE' });
}
```

- [ ] **Step 5: Verificación manual end-to-end en el browser, contra el server real (no se puede automatizar sin gastar una llamada real a Codex por test — se deja como verificación manual, igual que el resto de los flujos de streaming del repo)**

Pasos: abrir pestaña Codex → "+ Nueva conversación" → escribir un mensaje trivial ("respondé OK") → confirmar que aparece la burbuja de usuario al toque, el botón de cancelar se habilita, y la respuesta de Codex aparece por streaming sin recargar. Cerrar la conversación y reabrirla → confirmar que el historial persiste (`codexLoadMessages` trae los mismos 2 mensajes). Pin/archivar desde el menú de la fila (reusar `attachRowGestures`/`commitArchiveToggle` si generalizan fácil, o el equivalente mínimo — un botón simple alcanza para v1 si generalizar el swipe completo resulta más trabajo del que vale).

- [ ] **Step 6: Commit**

```bash
git add public/app.js public/index.html
git commit -m "feat: chat interactivo con Codex — mensajes, streaming, cancelar, adjuntar imagen

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Reinicio, verificación en vivo completa y revisión final

**Files:** ninguno nuevo — solo verificación.

- [ ] **Step 1: Reiniciar Jarvis para tomar los cambios de `server.js`**

Run: `schtasks /Run /TN JarvisRestart` (o pedirle a Diego que lo haga si la sesión que implementa corre sobre el propio Jarvis — mismo caveat ya documentado en `CLAUDE.local.md` para cambios anteriores de `server.js`).

- [ ] **Step 2: Correr toda la suite**

Run: `npm test`
Expected: todos los tests pasan, incluyendo los nuevos de Tasks 1-4 (16 tests nuevos aprox.) y los 72 ya existentes.

- [ ] **Step 3: Prueba manual completa desde el celu (no solo la PC)**

Confirmar que la pestaña Codex es usable desde `jarvis.controlapps.ar` con el túnel — el SSE de Codex pasa por el mismo heartbeat de 20s que ya mitiga el corte de Cloudflare, pero es la primera vez que se prueba con Codex real en vez de Claude.

- [ ] **Step 4: Revisión final de todo el diff del branch (o del working tree si se trabajó en `master` directo, según lo que Diego prefiera para este repo)**

Repasar los 8 archivos tocados/creados de punta a punta buscando: fragmentos de código muerto dejados por los pasos intermedios, cualquier `console.log` de debug olvidado, y que `codex-meta.json` efectivamente separado de `meta.json` (no se mezclaron conversaciones de Claude y Codex en el mismo archivo por error).

- [ ] **Step 5: Actualizar `CLAUDE.local.md` del proyecto con lo aprendido durante la implementación (gotchas reales encontrados, si los hubo) — mismo hábito que el resto de las features documentadas ahí**
