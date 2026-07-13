# Claude Chat Manager — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gestor web local de conversaciones de Claude Code: sidebar por proyecto, chat con streaming, máximo 2 procesos `claude` concurrentes.

**Architecture:** Server Node/Express que lee los JSONL de `~/.claude/projects/` (solo lectura), guarda nombres en un sidecar `meta.json`, y spawnea `claude -p --resume ... --output-format stream-json` por mensaje, reenviando eventos al browser por SSE. Frontend vanilla servido estático.

**Tech Stack:** Node.js 22 (CommonJS), Express 5, test runner nativo `node --test`. Sin frameworks de frontend, sin build step.

## Global Constraints

- Única dependencia npm: `express`. Tests con `node:test` + `node:assert` (nativos).
- Los JSONL de Claude NUNCA se escriben — solo lectura. Lo único que escribimos es `~/.claude/session-manager/meta.json`.
- Máximo 2 procesos `claude` concurrentes; cola FIFO; una respuesta a la vez por conversación.
- Todos los spawns llevan `--dangerously-skip-permissions`.
- Server bind a `127.0.0.1`, puerto `3777` (configurables por env `HOST` / `PORT`).
- Textos de UI en español, sin signos de apertura ¿ ¡.

## Gotcha crítico: `--resume` crea un session-id NUEVO

Cada `claude -p --resume <id>` continúa la conversación pero la guarda en un **JSONL nuevo con otro session-id** (que contiene todo el historial). El evento `init`/`result` del stream trae el `session_id` nuevo. Por eso:

- Una **conversación** se identifica por un `convId` estable (guardado en meta.json), y meta.json trackea su `currentSessionId`, que se actualiza tras cada mensaje.
- Los session-ids viejos van a la lista `superseded` para que el scanner no los muestre como conversaciones separadas.
- `--output-format stream-json` en modo `-p` requiere también `--verbose` (el CLI da error si falta).

## Estructura de archivos

```
claude-chat-manager/
├── package.json
├── src/
│   ├── scanner.js    # leer/parsear JSONL, listar sesiones, historial para el chat
│   ├── meta.js       # sidecar meta.json (nombres, currentSessionId, superseded)
│   ├── runner.js     # spawn de claude, semáforo de 2, cola FIFO, eventos
│   └── server.js     # Express: API REST + SSE + estáticos
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js
└── test/
    ├── scanner.test.js
    ├── meta.test.js
    └── runner.test.js
```

---

### Task 1: Scaffolding + Scanner (parser JSONL, sesiones, historial)

**Files:**
- Create: `package.json`
- Create: `src/scanner.js`
- Test: `test/scanner.test.js`

**Interfaces:**
- Produces:
  - `parseJsonl(filePath) → Array<object>` — entradas JSON válidas, líneas corruptas salteadas.
  - `sessionInfo(filePath) → {sessionId, cwd, snippet, messageCount, lastActivity} | null` — null si no hay mensajes.
  - `listSessions(projectsDir?) → Array<sessionInfo>` — todas las sesiones de todos los proyectos.
  - `toChatMessages(entries) → Array<{role:'user'|'assistant', text} | {role:'tool', name, input, output}>`
  - `findSessionFile(sessionId, projectsDir?) → string | null`

- [ ] **Step 1: Crear package.json e instalar express**

```json
{
  "name": "claude-chat-manager",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test test/"
  }
}
```

Run: `cd ~/Proyectos/claude-chat-manager && npm install express`
Expected: `express` en dependencies, `node_modules/` creado. Crear también `.gitignore` con `node_modules/`.

- [ ] **Step 2: Escribir tests del scanner (van a fallar)**

`test/scanner.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseJsonl, sessionInfo, listSessions, toChatMessages, findSessionFile } = require('../src/scanner');

function tmpFile(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-'));
  const file = path.join(dir, 'aaaa-1111.jsonl');
  fs.writeFileSync(file, lines.join('\n'));
  return { dir, file };
}

const userEntry = (text, extra = {}) => JSON.stringify({
  type: 'user', cwd: '/home/loctime/Proyectos/demo', sessionId: 'aaaa-1111',
  timestamp: '2026-07-12T10:00:00.000Z', message: { role: 'user', content: text }, ...extra,
});
const assistantEntry = (content) => JSON.stringify({
  type: 'assistant', cwd: '/home/loctime/Proyectos/demo', sessionId: 'aaaa-1111',
  timestamp: '2026-07-12T10:00:05.000Z', message: { role: 'assistant', content },
});

test('parseJsonl saltea líneas corruptas y vacías', () => {
  const { file } = tmpFile([userEntry('hola'), '{{{roto', '', assistantEntry([{ type: 'text', text: 'buenas' }])]);
  const entries = parseJsonl(file);
  assert.equal(entries.length, 2);
});

test('parseJsonl devuelve [] si el archivo no existe', () => {
  assert.deepEqual(parseJsonl('/no/existe.jsonl'), []);
});

test('sessionInfo extrae snippet, cwd y messageCount', () => {
  const { file } = tmpFile([userEntry('arreglame el bug del login por favor'), assistantEntry([{ type: 'text', text: 'dale' }])]);
  const info = sessionInfo(file);
  assert.equal(info.sessionId, 'aaaa-1111');
  assert.equal(info.cwd, '/home/loctime/Proyectos/demo');
  assert.ok(info.snippet.startsWith('arreglame el bug'));
  assert.equal(info.messageCount, 2);
});

test('sessionInfo devuelve null para archivo sin mensajes', () => {
  const { file } = tmpFile(['{"type":"summary","summary":"x"}']);
  assert.equal(sessionInfo(file), null);
});

test('listSessions recorre subdirectorios de projectsDir', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-projects-'));
  const projDir = path.join(base, '-home-loctime-Proyectos-demo');
  fs.mkdirSync(projDir);
  fs.writeFileSync(path.join(projDir, 'bbbb-2222.jsonl'), userEntry('hola'));
  const sessions = listSessions(base);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, 'bbbb-2222');
});

test('findSessionFile encuentra el path por sessionId', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-find-'));
  const projDir = path.join(base, '-home-x');
  fs.mkdirSync(projDir);
  fs.writeFileSync(path.join(projDir, 'cccc-3333.jsonl'), userEntry('hola'));
  assert.equal(findSessionFile('cccc-3333', base), path.join(projDir, 'cccc-3333.jsonl'));
  assert.equal(findSessionFile('zzzz', base), null);
});

test('toChatMessages arma burbujas y tool calls con su output', () => {
  const entries = [
    JSON.parse(userEntry('corré los tests')),
    JSON.parse(assistantEntry([
      { type: 'text', text: 'Voy a correrlos.' },
      { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } },
    ])),
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '5 passing' }] } },
    JSON.parse(assistantEntry([{ type: 'text', text: 'Todo verde.' }])),
  ];
  const msgs = toChatMessages(entries);
  assert.deepEqual(msgs.map(m => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(msgs[2].name, 'Bash');
  assert.equal(msgs[2].output, '5 passing');
});

test('toChatMessages ignora entradas meta y tool_results como mensajes de usuario', () => {
  const entries = [
    { type: 'user', isMeta: true, message: { role: 'user', content: 'meta interna' } },
    JSON.parse(userEntry('hola')),
  ];
  const msgs = toChatMessages(entries);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, 'hola');
});
```

- [ ] **Step 3: Correr tests, verificar que fallan**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/scanner'`

- [ ] **Step 4: Implementar `src/scanner.js`**

```js
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

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

function contentToText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return '';
}

function sessionInfo(filePath) {
  const entries = parseJsonl(filePath);
  const msgs = entries.filter(e => (e.type === 'user' || e.type === 'assistant') && e.message && !e.isMeta);
  if (msgs.length === 0) return null;
  const firstUser = msgs.find(e => e.type === 'user' && contentToText(e.message.content).trim());
  const snippet = firstUser ? contentToText(firstUser.message.content).trim().slice(0, 60) : '(sin mensajes)';
  const last = entries[entries.length - 1];
  let lastActivity = last && last.timestamp;
  if (!lastActivity) { try { lastActivity = fs.statSync(filePath).mtime.toISOString(); } catch { lastActivity = null; } }
  return {
    sessionId: path.basename(filePath, '.jsonl'),
    cwd: (entries.find(e => e.cwd) || {}).cwd || null,
    snippet,
    messageCount: msgs.length,
    lastActivity,
  };
}

function listSessions(projectsDir = PROJECTS_DIR) {
  let dirs;
  try { dirs = fs.readdirSync(projectsDir); } catch { return []; }
  const sessions = [];
  for (const d of dirs) {
    const dirPath = path.join(projectsDir, d);
    let files;
    try { files = fs.readdirSync(dirPath); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const info = sessionInfo(path.join(dirPath, f));
      if (info) sessions.push(info);
    }
  }
  return sessions;
}

function findSessionFile(sessionId, projectsDir = PROJECTS_DIR) {
  let dirs;
  try { dirs = fs.readdirSync(projectsDir); } catch { return null; }
  for (const d of dirs) {
    const candidate = path.join(projectsDir, d, sessionId + '.jsonl');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function toChatMessages(entries) {
  const toolResults = {};
  for (const e of entries) {
    if (e.type === 'user' && e.message && Array.isArray(e.message.content)) {
      for (const b of e.message.content) {
        if (b.type === 'tool_result') toolResults[b.tool_use_id] = contentToText(b.content);
      }
    }
  }
  const items = [];
  for (const e of entries) {
    if (!e.message || e.isMeta) continue;
    if (e.type === 'user') {
      const text = contentToText(e.message.content);
      if (text.trim()) items.push({ role: 'user', text });
    } else if (e.type === 'assistant' && Array.isArray(e.message.content)) {
      for (const b of e.message.content) {
        if (b.type === 'text' && b.text.trim()) items.push({ role: 'assistant', text: b.text });
        else if (b.type === 'tool_use') items.push({ role: 'tool', name: b.name, input: b.input, output: toolResults[b.id] || '' });
      }
    }
  }
  return items;
}

module.exports = { parseJsonl, sessionInfo, listSessions, findSessionFile, toChatMessages, contentToText, PROJECTS_DIR };
```

- [ ] **Step 5: Correr tests, verificar que pasan**

Run: `npm test`
Expected: PASS (todos los tests de scanner)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .gitignore src/scanner.js test/scanner.test.js
git commit -m "feat: scanner de sesiones JSONL con parser tolerante"
```

---

### Task 2: Meta sidecar (nombres, currentSessionId, superseded)

**Files:**
- Create: `src/meta.js`
- Test: `test/meta.test.js`

**Interfaces:**
- Consumes: nada de tasks anteriores.
- Produces:
  - `load(file?) → {conversations: {[convId]: {name?, currentSessionId, projectDir}}, superseded: string[]}`
  - `save(data, file?)` — crea el directorio si falta.
  - `advanceSession(data, convId, newSessionId) → data` — mueve el currentSessionId viejo a superseded y setea el nuevo.
  - `META_FILE` — path por defecto `~/.claude/session-manager/meta.json`.

- [ ] **Step 1: Escribir tests (van a fallar)**

`test/meta.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { load, save, advanceSession } = require('../src/meta');

const tmpMeta = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-meta-')), 'sub', 'meta.json');

test('load devuelve estructura vacía si el archivo no existe', () => {
  const data = load('/no/existe/meta.json');
  assert.deepEqual(data, { conversations: {}, superseded: [] });
});

test('save crea directorios y load lo lee de vuelta', () => {
  const file = tmpMeta();
  const data = { conversations: { c1: { name: 'mi charla', currentSessionId: 's1', projectDir: '/tmp/p' } }, superseded: [] };
  save(data, file);
  assert.deepEqual(load(file), data);
});

test('advanceSession mueve el id viejo a superseded', () => {
  const data = { conversations: { c1: { currentSessionId: 's1', projectDir: '/tmp/p' } }, superseded: [] };
  advanceSession(data, 'c1', 's2');
  assert.equal(data.conversations.c1.currentSessionId, 's2');
  assert.deepEqual(data.superseded, ['s1']);
});

test('advanceSession con mismo id no duplica en superseded', () => {
  const data = { conversations: { c1: { currentSessionId: 's1', projectDir: '/tmp/p' } }, superseded: [] };
  advanceSession(data, 'c1', 's1');
  assert.deepEqual(data.superseded, []);
});

test('advanceSession con currentSessionId null solo setea el nuevo', () => {
  const data = { conversations: { c1: { currentSessionId: null, projectDir: '/tmp/p' } }, superseded: [] };
  advanceSession(data, 'c1', 's9');
  assert.equal(data.conversations.c1.currentSessionId, 's9');
  assert.deepEqual(data.superseded, []);
});
```

- [ ] **Step 2: Correr tests, verificar que fallan**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/meta'`

- [ ] **Step 3: Implementar `src/meta.js`**

```js
const fs = require('fs');
const path = require('path');
const os = require('os');

const META_FILE = path.join(os.homedir(), '.claude', 'session-manager', 'meta.json');

function load(file = META_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { conversations: {}, superseded: [] }; }
}

function save(data, file = META_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function advanceSession(data, convId, newSessionId) {
  const conv = data.conversations[convId];
  const old = conv.currentSessionId;
  if (old && old !== newSessionId && !data.superseded.includes(old)) data.superseded.push(old);
  conv.currentSessionId = newSessionId;
  return data;
}

module.exports = { load, save, advanceSession, META_FILE };
```

- [ ] **Step 4: Correr tests, verificar que pasan**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/meta.js test/meta.test.js
git commit -m "feat: sidecar meta.json con avance de session-id"
```

---

### Task 3: Runner (spawn, semáforo de 2, cola FIFO)

**Files:**
- Create: `src/runner.js`
- Test: `test/runner.test.js`

**Interfaces:**
- Consumes: nada (spawn inyectable para tests).
- Produces:
  - `new Runner({maxConcurrent?, spawnFn?, command?})` — EventEmitter.
  - `runner.send({convId, sessionId, cwd, text})` — encola/ejecuta.
  - `runner.isBusy(convId) → boolean`
  - Evento `'status'`: `{convId, status: 'queued'|'running'|'idle', code?, stderr?}`
  - Evento `'event'`: `{convId, event}` — cada línea JSON del stream de claude (tipos `system/init`, `assistant`, `user`, `result`).

- [ ] **Step 1: Escribir tests con spawn falso (van a fallar)**

`test/runner.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { Runner } = require('../src/runner');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function makeRunner(spawned) {
  return new Runner({
    maxConcurrent: 2,
    spawnFn: (cmd, args, opts) => {
      const child = fakeChild();
      spawned.push({ cmd, args, opts, child });
      return child;
    },
  });
}

test('arma los args correctos con y sin --resume', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  r.send({ convId: 'c1', sessionId: 's1', cwd: '/tmp/p', text: 'hola' });
  r.send({ convId: 'c2', sessionId: null, cwd: '/tmp/q', text: 'nueva' });
  assert.ok(spawned[0].args.includes('--resume') && spawned[0].args.includes('s1'));
  assert.ok(spawned[0].args.includes('--dangerously-skip-permissions'));
  assert.ok(spawned[0].args.includes('--verbose'));
  assert.equal(spawned[0].opts.cwd, '/tmp/p');
  assert.ok(!spawned[1].args.includes('--resume'));
});

test('semáforo de 2: el tercero queda en cola y arranca al liberarse un slot', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  const statuses = [];
  r.on('status', s => statuses.push(s));
  r.send({ convId: 'c1', sessionId: 's1', cwd: '/t', text: 'a' });
  r.send({ convId: 'c2', sessionId: 's2', cwd: '/t', text: 'b' });
  r.send({ convId: 'c3', sessionId: 's3', cwd: '/t', text: 'c' });
  assert.equal(spawned.length, 2);
  assert.ok(statuses.some(s => s.convId === 'c3' && s.status === 'queued'));
  assert.ok(r.isBusy('c3'));
  spawned[0].child.emit('close', 0);
  assert.equal(spawned.length, 3);
  assert.equal(spawned[2].args[1], 'c');
});

test('parsea stdout por líneas y emite eventos JSON', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  const events = [];
  r.on('event', e => events.push(e));
  r.send({ convId: 'c1', sessionId: 's1', cwd: '/t', text: 'a' });
  spawned[0].child.stdout.emit('data', '{"type":"assistant","message":{}}\n{"type":"res');
  spawned[0].child.stdout.emit('data', 'ult","session_id":"s2"}\nbasura no json\n');
  assert.equal(events.length, 2);
  assert.equal(events[1].event.type, 'result');
  assert.equal(events[1].event.session_id, 's2');
});

test('close con código != 0 emite idle con stderr', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  const statuses = [];
  r.on('status', s => statuses.push(s));
  r.send({ convId: 'c1', sessionId: 's1', cwd: '/t', text: 'a' });
  spawned[0].child.stderr.emit('data', 'explotó todo');
  spawned[0].child.emit('close', 1);
  const idle = statuses.find(s => s.status === 'idle');
  assert.equal(idle.code, 1);
  assert.match(idle.stderr, /explotó/);
  assert.equal(r.isBusy('c1'), false);
});
```

- [ ] **Step 2: Correr tests, verificar que fallan**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/runner'`

- [ ] **Step 3: Implementar `src/runner.js`**

```js
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

class Runner extends EventEmitter {
  constructor({ maxConcurrent = 2, spawnFn = spawn, command = 'claude' } = {}) {
    super();
    this.max = maxConcurrent;
    this.spawnFn = spawnFn;
    this.command = command;
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

  _drain() {
    while (this.running.size < this.max && this.queue.length > 0) {
      this._start(this.queue.shift());
    }
  }

  _start(job) {
    const args = ['-p', job.text, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
    if (job.sessionId) args.push('--resume', job.sessionId);
    const child = this.spawnFn(this.command, args, { cwd: job.cwd });
    this.running.set(job.convId, child);
    this.emit('status', { convId: job.convId, status: 'running' });

    let buf = '';
    let stderr = '';
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
    child.on('close', code => {
      this.running.delete(job.convId);
      const status = { convId: job.convId, status: 'idle', code };
      if (code !== 0) status.stderr = stderr;
      this.emit('status', status);
      this._drain();
    });
  }
}

module.exports = { Runner };
```

- [ ] **Step 4: Correr tests, verificar que pasan**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runner.js test/runner.test.js
git commit -m "feat: runner con semáforo de 2 y cola FIFO"
```

---

### Task 4: Server Express (API REST + SSE + estáticos)

**Files:**
- Create: `src/server.js`
- Create: `public/index.html` (placeholder mínimo para probar estáticos)

**Interfaces:**
- Consumes: `listSessions`, `findSessionFile`, `parseJsonl`, `toChatMessages` (Task 1); `load`, `save`, `advanceSession` (Task 2); `Runner` (Task 3).
- Produces (API HTTP para el frontend de Task 5):
  - `GET /api/tree` → `[{projectDir, conversations: [{convId, name, snippet, lastActivity, messageCount, status}]}]`
  - `GET /api/conversations/:id/messages` → `Array` de `toChatMessages`
  - `POST /api/conversations/:id/message` body `{text}` → `202 {queued: true}` o `409` si esa conversación ya está ocupada
  - `POST /api/conversations` body `{projectDir, text}` → `201 {convId}`
  - `PATCH /api/conversations/:id` body `{name}` → `200`
  - `GET /api/conversations/:id/stream` → SSE con eventos `{kind:'claude', event}` y `{kind:'status', status, code?, stderr?}`

- [ ] **Step 1: Implementar `src/server.js`**

```js
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const scanner = require('./scanner');
const meta = require('./meta');
const { Runner } = require('./runner');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3777);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const runner = new Runner();
const sseClients = new Map(); // convId → Set<res>

function broadcast(convId, payload) {
  const set = sseClients.get(convId);
  if (!set) return;
  for (const res of set) res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

runner.on('event', ({ convId, event }) => {
  // --resume crea un session-id nuevo: al verlo, avanzar la conversación
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

// Conversación: entrada en meta.json, o sesión suelta de disco (convId = sessionId)
function resolveConv(convId) {
  const data = meta.load();
  if (data.conversations[convId]) return { data, conv: data.conversations[convId] };
  const file = scanner.findSessionFile(convId);
  if (!file) return { data, conv: null };
  const info = scanner.sessionInfo(file);
  data.conversations[convId] = { currentSessionId: convId, projectDir: (info && info.cwd) || process.env.HOME };
  return { data, conv: data.conversations[convId] };
}

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
      status: runner.running.has(s.sessionId) ? 'running' : (runner.isBusy(s.sessionId) ? 'queued' : 'idle'),
    });
  }
  const groups = new Map();
  for (const c of convs) {
    if (!groups.has(c.projectDir)) groups.set(c.projectDir, []);
    groups.get(c.projectDir).push(c);
  }
  const tree = [...groups.entries()].map(([projectDir, conversations]) => ({
    projectDir,
    conversations: conversations.sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || '')),
  }));
  res.json(tree);
});

app.get('/api/conversations/:id/messages', (req, res) => {
  const { conv } = resolveConv(req.params.id);
  if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
  if (!conv.currentSessionId) return res.json([]);
  const file = scanner.findSessionFile(conv.currentSessionId);
  if (!file) return res.json([]);
  res.json(scanner.toChatMessages(scanner.parseJsonl(file)));
});

app.post('/api/conversations/:id/message', (req, res) => {
  const convId = req.params.id;
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'mensaje vacío' });
  if (runner.isBusy(convId)) return res.status(409).json({ error: 'esa conversación ya está procesando un mensaje' });
  const { data, conv } = resolveConv(convId);
  if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
  meta.save(data);
  runner.send({ convId, sessionId: conv.currentSessionId, cwd: conv.projectDir, text });
  res.status(202).json({ queued: true });
});

app.post('/api/conversations', (req, res) => {
  const { projectDir, text } = req.body;
  if (!projectDir || !(text || '').trim()) return res.status(400).json({ error: 'faltan projectDir o text' });
  const convId = crypto.randomUUID();
  const data = meta.load();
  data.conversations[convId] = { currentSessionId: null, projectDir };
  meta.save(data);
  runner.send({ convId, sessionId: null, cwd: projectDir, text: text.trim() });
  res.status(201).json({ convId });
});

app.patch('/api/conversations/:id', (req, res) => {
  const { data, conv } = resolveConv(req.params.id);
  if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
  conv.name = (req.body.name || '').trim() || undefined;
  meta.save(data);
  res.json({ ok: true });
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
  req.on('close', () => sseClients.get(convId).delete(res));
});

app.listen(PORT, HOST, () => {
  console.log(`Claude Chat Manager en http://${HOST}:${PORT}`);
});
```

- [ ] **Step 2: Crear `public/index.html` placeholder**

```html
<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Claude Chat Manager</title></head>
<body>placeholder</body></html>
```

- [ ] **Step 3: Verificar a mano con curl**

```bash
node src/server.js &
sleep 1
curl -s http://127.0.0.1:3777/api/tree | head -c 400; echo
curl -s http://127.0.0.1:3777/ | head -c 100; echo
curl -s -X POST http://127.0.0.1:3777/api/conversations/inexistente/message -H 'Content-Type: application/json' -d '{"text":"hola"}'
kill %1
```

Expected: `/api/tree` devuelve JSON (las sesiones reales de esta máquina agrupadas por proyecto); `/` devuelve el placeholder; el POST a conversación inexistente devuelve `404`.

- [ ] **Step 4: Verificar que los tests existentes siguen verdes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server.js public/index.html
git commit -m "feat: server Express con API REST y SSE"
```

---

### Task 5: Frontend (sidebar, chat, streaming, renombrar, nueva conversación)

**Files:**
- Modify: `public/index.html` (reemplazo completo)
- Create: `public/style.css`
- Create: `public/app.js`

**Interfaces:**
- Consumes: toda la API HTTP de Task 4 (mismas rutas y shapes).

- [ ] **Step 1: Escribir `public/index.html`**

```html
<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Claude Chat Manager</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <aside id="sidebar">
    <header>
      <h1>Claude Chat</h1>
      <button id="new-conv" title="Nueva conversación">+</button>
    </header>
    <nav id="tree"></nav>
  </aside>
  <main id="chat">
    <header id="chat-header">
      <span id="conv-title">Elegí una conversación</span>
    </header>
    <section id="messages"></section>
    <form id="composer">
      <textarea id="input" rows="3" placeholder="Escribí un mensaje…" disabled></textarea>
      <button id="send" type="submit" disabled>Enviar</button>
    </form>
  </main>
  <dialog id="new-dialog">
    <form method="dialog" id="new-form">
      <h2>Nueva conversación</h2>
      <label>Proyecto
        <select id="project-select"></select>
      </label>
      <label>U otra carpeta
        <input id="project-custom" type="text" placeholder="/home/loctime/Proyectos/...">
      </label>
      <label>Primer mensaje
        <textarea id="first-message" rows="3" required></textarea>
      </label>
      <menu>
        <button value="cancel">Cancelar</button>
        <button id="create-conv" value="default">Crear</button>
      </menu>
    </form>
  </dialog>
  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Escribir `public/style.css`**

```css
* { box-sizing: border-box; margin: 0; }
body { display: flex; height: 100vh; font-family: system-ui, sans-serif; background: #111; color: #ddd; }
#sidebar { width: 300px; border-right: 1px solid #333; display: flex; flex-direction: column; }
#sidebar header { display: flex; justify-content: space-between; align-items: center; padding: 12px; border-bottom: 1px solid #333; }
#sidebar h1 { font-size: 16px; }
#new-conv { background: #2a6; color: #fff; border: 0; border-radius: 6px; width: 28px; height: 28px; font-size: 18px; cursor: pointer; }
#tree { overflow-y: auto; flex: 1; }
.project > summary { padding: 8px 12px; cursor: pointer; font-weight: 600; font-size: 13px; color: #9ab; }
.conv { padding: 8px 12px 8px 24px; cursor: pointer; border-left: 3px solid transparent; }
.conv:hover { background: #1a1a1a; }
.conv.active { border-left-color: #2a6; background: #1a1a1a; }
.conv .name { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.conv .sub { font-size: 11px; color: #777; }
.badge { font-size: 11px; }
#chat { flex: 1; display: flex; flex-direction: column; }
#chat-header { padding: 12px 16px; border-bottom: 1px solid #333; font-weight: 600; }
#conv-title[contenteditable] { outline: 1px dashed #2a6; }
#messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
.msg { max-width: 75%; padding: 10px 14px; border-radius: 12px; white-space: pre-wrap; line-height: 1.45; }
.msg.user { align-self: flex-end; background: #245; }
.msg.assistant { align-self: flex-start; background: #222; }
.msg.error { align-self: flex-start; background: #522; color: #fbb; }
.tool { align-self: flex-start; max-width: 75%; font-size: 12px; color: #888; }
.tool summary { cursor: pointer; }
.tool pre { background: #181818; padding: 8px; border-radius: 6px; overflow-x: auto; max-height: 300px; }
#composer { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid #333; }
#input { flex: 1; background: #1a1a1a; color: #ddd; border: 1px solid #333; border-radius: 8px; padding: 8px; resize: none; }
#send { background: #2a6; color: #fff; border: 0; border-radius: 8px; padding: 0 20px; cursor: pointer; }
#send:disabled, #input:disabled { opacity: 0.4; }
dialog { background: #1a1a1a; color: #ddd; border: 1px solid #333; border-radius: 10px; padding: 20px; min-width: 400px; }
dialog::backdrop { background: rgba(0,0,0,0.6); }
dialog label { display: block; margin: 10px 0; font-size: 13px; }
dialog select, dialog input, dialog textarea { width: 100%; margin-top: 4px; background: #111; color: #ddd; border: 1px solid #333; border-radius: 6px; padding: 6px; }
dialog menu { display: flex; justify-content: flex-end; gap: 8px; padding: 0; margin-top: 12px; }
dialog button { background: #333; color: #ddd; border: 0; border-radius: 6px; padding: 6px 14px; cursor: pointer; }
#create-conv { background: #2a6; color: #fff; }
```

- [ ] **Step 3: Escribir `public/app.js`**

```js
let currentConv = null;
let eventSource = null;
let tree = [];

const $ = id => document.getElementById(id);
const messagesEl = $('messages');

async function api(path, opts) {
  const res = await fetch('/api' + path, opts);
  if (!res.ok && res.status !== 202) throw new Error((await res.json()).error || res.statusText);
  return res.json();
}

function badge(status) {
  return status === 'running' ? ' ⚡' : status === 'queued' ? ' ⏳' : '';
}

async function loadTree() {
  tree = await api('/tree');
  const nav = $('tree');
  nav.innerHTML = '';
  for (const proj of tree) {
    const det = document.createElement('details');
    det.className = 'project';
    det.open = true;
    const sum = document.createElement('summary');
    sum.textContent = proj.projectDir.split('/').pop() || proj.projectDir;
    sum.title = proj.projectDir;
    det.appendChild(sum);
    for (const c of proj.conversations) {
      const div = document.createElement('div');
      div.className = 'conv' + (c.convId === currentConv ? ' active' : '');
      div.innerHTML = `<div class="name"></div><div class="sub"></div>`;
      div.querySelector('.name').textContent = c.name + badge(c.status);
      div.querySelector('.sub').textContent = (c.lastActivity || '').slice(0, 16).replace('T', ' ');
      div.onclick = () => selectConv(c.convId, c.name);
      det.appendChild(div);
    }
    nav.appendChild(det);
  }
}

function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function addTool(name, input, output) {
  const det = document.createElement('details');
  det.className = 'tool';
  const summary = typeof input === 'object' && input && input.command ? input.command : JSON.stringify(input || '').slice(0, 80);
  det.innerHTML = '<summary></summary><pre class="in"></pre><pre class="out"></pre>';
  det.querySelector('summary').textContent = `▸ ${name}: ${summary}`;
  det.querySelector('.in').textContent = JSON.stringify(input, null, 2);
  det.querySelector('.out').textContent = output || '';
  messagesEl.appendChild(det);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function loadMessages(convId) {
  messagesEl.innerHTML = '';
  const msgs = await api(`/conversations/${convId}/messages`);
  for (const m of msgs) {
    if (m.role === 'tool') addTool(m.name, m.input, m.output);
    else addMsg(m.role, m.text);
  }
}

function setBusy(busy) {
  $('input').disabled = busy || !currentConv;
  $('send').disabled = busy || !currentConv;
}

function openStream(convId) {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/conversations/${convId}/stream`);
  eventSource.onmessage = e => {
    const payload = JSON.parse(e.data);
    if (payload.kind === 'claude') {
      const ev = payload.event;
      if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
        for (const b of ev.message.content) {
          if (b.type === 'text' && b.text.trim()) addMsg('assistant', b.text);
          else if (b.type === 'tool_use') addTool(b.name, b.input, '');
        }
      }
    } else if (payload.kind === 'status') {
      if (payload.status === 'idle') {
        setBusy(false);
        if (payload.code !== 0 && payload.stderr) addMsg('error', 'Error del proceso claude:\n' + payload.stderr);
        loadMessages(currentConv);
        loadTree();
      } else {
        setBusy(true);
        loadTree();
      }
    }
  };
}

async function selectConv(convId, name) {
  currentConv = convId;
  $('conv-title').textContent = name;
  setBusy(false);
  await loadMessages(convId);
  openStream(convId);
  loadTree();
}

$('composer').onsubmit = async e => {
  e.preventDefault();
  const text = $('input').value.trim();
  if (!text || !currentConv) return;
  addMsg('user', text);
  $('input').value = '';
  setBusy(true);
  try {
    await api(`/conversations/${currentConv}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    addMsg('error', err.message);
    setBusy(false);
  }
};

$('conv-title').ondblclick = () => {
  if (!currentConv) return;
  const el = $('conv-title');
  el.contentEditable = 'true';
  el.focus();
  el.onblur = async () => {
    el.contentEditable = 'false';
    await api(`/conversations/${currentConv}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: el.textContent.trim() }),
    });
    loadTree();
  };
  el.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); el.blur(); } };
};

$('new-conv').onclick = () => {
  const sel = $('project-select');
  sel.innerHTML = '';
  for (const proj of tree) {
    const opt = document.createElement('option');
    opt.value = proj.projectDir;
    opt.textContent = proj.projectDir;
    sel.appendChild(opt);
  }
  $('new-dialog').showModal();
};

$('new-form').onsubmit = async e => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  const projectDir = $('project-custom').value.trim() || $('project-select').value;
  const text = $('first-message').value.trim();
  if (!projectDir || !text) return;
  const { convId } = await api('/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectDir, text }),
  });
  $('new-dialog').close();
  $('first-message').value = '';
  $('project-custom').value = '';
  await selectConv(convId, text.slice(0, 60));
  addMsg('user', text);
  setBusy(true);
};

loadTree();
setInterval(loadTree, 15000);
```

- [ ] **Step 4: Probar en el browser (golden path)**

```bash
node src/server.js
```

Abrir `http://127.0.0.1:3777` y verificar:
1. La sidebar muestra las sesiones reales de esta máquina agrupadas por proyecto.
2. Click en una conversación → se ve el historial con burbujas y tool calls plegadas (expandir una y ver input/output).
3. Escribir "decime hola y nada más" y enviar → badge ⚡, tool activity/texto en vivo, al terminar el input se rehabilita y el historial recarga completo.
4. Doble click en el título → renombrar → el nombre aparece en la sidebar (verificar que quedó en `~/.claude/session-manager/meta.json`).
5. "+" → crear conversación nueva en un proyecto → responde y aparece en la sidebar.
6. Verificar el gotcha del session-id: tras responder, `meta.json` tiene `currentSessionId` distinto al original y el viejo en `superseded`; la sidebar NO muestra la conversación duplicada.

Expected: los 6 puntos funcionan.

- [ ] **Step 5: Probar concurrencia y errores**

1. Mandar mensajes en 3 conversaciones distintas rápido → la tercera muestra ⏳ y arranca cuando termina una de las primeras.
2. Mandar un segundo mensaje en una conversación ocupada → el server responde 409 y la UI muestra el error (el input debería estar deshabilitado de todas formas).

Expected: semáforo y cola visibles en la UI; sin crashes.

- [ ] **Step 6: Commit**

```bash
git add public/
git commit -m "feat: frontend de chat con sidebar, streaming SSE y renombrado"
```

---

### Task 6: README + verificación final

**Files:**
- Create: `README.md`

- [ ] **Step 1: Escribir `README.md`**

```markdown
# Claude Chat Manager

Gestor web local de conversaciones de Claude Code. Sidebar por proyecto,
chat con streaming, máximo 2 procesos `claude` concurrentes (cola FIFO).

## Uso

    npm install
    npm start          # http://127.0.0.1:3777

Variables: `PORT` (default 3777), `HOST` (default 127.0.0.1 — cambiar a
0.0.0.0 para acceso desde la red local, bajo tu responsabilidad: las
sesiones corren con --dangerously-skip-permissions).

## Cómo funciona

- Lee los JSONL de `~/.claude/projects/` (solo lectura, nunca los escribe).
- Nombres y estado de conversaciones en `~/.claude/session-manager/meta.json`.
- Cada mensaje spawnea `claude -p --resume <id> --output-format stream-json`.
- Gotcha: `--resume` genera un session-id nuevo por mensaje; meta.json
  trackea la cadena y oculta los ids viejos (`superseded`).

## Tests

    npm test
```

- [ ] **Step 2: Correr la suite completa**

Run: `npm test`
Expected: PASS — scanner, meta y runner en verde.

- [ ] **Step 3: Commit final**

```bash
git add README.md
git commit -m "docs: README con uso y arquitectura"
```
