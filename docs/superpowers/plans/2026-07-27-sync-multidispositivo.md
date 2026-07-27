# Sincronización Multi-dispositivo (SSE Global) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Usar Jarvis desde desktop y celular en simultáneo sobre las mismas conversaciones: mensajes enviados desde cualquiera aparecen al instante en el otro, estado ocupado consistente, meta sincronizada.

**Architecture:** Un único canal SSE global (`GET /api/stream`) por cliente reemplaza al SSE por conversación y al poll de 15s. El server emite todos los eventos etiquetados con `convId` (claude/status/user/meta/compacted) más un snapshot `hello` con las conversaciones ocupadas al conectar. El cliente rutea por `convId` y deduplica sus propios mensajes vía `clientId`.

**Tech Stack:** Node 22 + Express (server), vanilla JS (cliente PWA), `node --test` (tests). Sin dependencias nuevas.

**Spec:** `docs/superpowers/specs/2026-07-27-sync-multidispositivo-design.md`

## Global Constraints

- Sin dependencias npm nuevas.
- Código común multiplataforma: no tocar guards `IS_WIN` ni nada específico de Windows/Linux.
- Los 47 tests existentes deben seguir pasando (`npm test`).
- Mantener heartbeat SSE cada 20s (Cloudflare Tunnel corta SSE con ~100s de idle).
- **NUNCA matar ni reiniciar el proceso que escucha el puerto 3777** — es el transporte de esta sesión. Pruebas manuales del server: usar otro puerto (`PORT=3999`).
- Textos de UI en español, sin signos de apertura ¿ ¡.

## Estado actual (referencia rápida)

- `src/server.js` — Express; hoy tiene `sseClients` (Map convId→Set<res>), `broadcast(convId, payload)`, endpoint `GET /api/conversations/:id/stream`, y `app.listen` a nivel módulo.
- `src/runner.js` — clase `Runner` (EventEmitter); `running` (Map convId→child), `queue` (array de jobs), `isBusy(convId)`.
- `public/app.js` — cliente; `openStream(convId)` abre un EventSource por conversación; `setInterval(safeLoadTree, 15000)`; `selectConv` hace `setBusy(false)` incondicional.
- `public/index.html` — carga `app.js?v=24`.
- Tests en `test/*.test.js`, estilo `node:test` + `assert`, en español.

---

### Task 1: Módulo SseHub (`src/sse.js`)

Hub SSE global aislado y testeable: registra clientes, emite broadcast, escribe el evento inicial y mantiene un único heartbeat.

**Files:**
- Create: `src/sse.js`
- Test: `test/sse.test.js`

**Interfaces:**
- Produces: `class SseHub { constructor({ heartbeatMs = 20000 }); handle(req, res, hello); broadcast(payload); get size() }`
  - `handle(req, res, hello)`: escribe headers SSE, el payload `hello` como primer evento `data:`, registra el cliente y lo remueve en `req.on('close')`.
  - `broadcast(payload)`: escribe `data: ${JSON.stringify(payload)}\n\n` a todos los clientes conectados.
  - Heartbeat: un solo `setInterval` compartido que escribe `:heartbeat\n\n` a todos; se crea con el primer cliente y se limpia cuando no queda ninguno (así los tests no dejan el proceso colgado).

- [ ] **Step 1: Escribir los tests que fallan**

Crear `test/sse.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { SseHub } = require('../src/sse');

function fakeRes() {
  return {
    headers: null,
    chunks: [],
    writeHead(code, headers) { this.code = code; this.headers = headers; },
    write(s) { this.chunks.push(s); },
  };
}

test('handle escribe headers SSE y el evento hello', () => {
  const hub = new SseHub({ heartbeatMs: 60_000 });
  const req = new EventEmitter();
  const res = fakeRes();
  hub.handle(req, res, { kind: 'hello', busy: ['c1'] });
  assert.equal(res.code, 200);
  assert.equal(res.headers['Content-Type'], 'text/event-stream');
  const helloChunk = res.chunks.find(c => c.startsWith('data: '));
  assert.deepEqual(JSON.parse(helloChunk.slice(6)), { kind: 'hello', busy: ['c1'] });
  assert.equal(hub.size, 1);
  req.emit('close');
  assert.equal(hub.size, 0);
});

test('broadcast llega a todos los clientes conectados', () => {
  const hub = new SseHub({ heartbeatMs: 60_000 });
  const reqA = new EventEmitter(); const resA = fakeRes();
  const reqB = new EventEmitter(); const resB = fakeRes();
  hub.handle(reqA, resA, { kind: 'hello', busy: [] });
  hub.handle(reqB, resB, { kind: 'hello', busy: [] });
  hub.broadcast({ convId: 'c1', kind: 'status', status: 'running' });
  for (const res of [resA, resB]) {
    const last = res.chunks[res.chunks.length - 1];
    assert.deepEqual(JSON.parse(last.slice(6)), { convId: 'c1', kind: 'status', status: 'running' });
  }
  reqA.emit('close'); reqB.emit('close');
});

test('el heartbeat arranca con el primer cliente y se apaga con el último', () => {
  const hub = new SseHub({ heartbeatMs: 60_000 });
  assert.equal(hub._timer, null);
  const req = new EventEmitter(); const res = fakeRes();
  hub.handle(req, res, { kind: 'hello', busy: [] });
  assert.notEqual(hub._timer, null);
  req.emit('close');
  assert.equal(hub._timer, null);
});
```

- [ ] **Step 2: Verificar que fallan**

Run: `npm test`
Expected: los 3 tests nuevos FAIL con `Cannot find module '../src/sse'`; los 47 existentes PASS.

- [ ] **Step 3: Implementar `src/sse.js`**

```js
// Hub SSE global: un solo canal por cliente conectado, broadcast a todos.
// El heartbeat (un único interval compartido) existe solo mientras haya
// clientes — así el proceso puede salir limpio y los tests no cuelgan.
class SseHub {
  constructor({ heartbeatMs = 20000 } = {}) {
    this.clients = new Set();
    this.heartbeatMs = heartbeatMs;
    this._timer = null;
  }

  handle(req, res, hello) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('\n');
    if (hello) res.write(`data: ${JSON.stringify(hello)}\n\n`);
    this.clients.add(res);
    if (!this._timer) {
      // Cloudflare Tunnel corta conexiones SSE inactivas (~100s de idle).
      this._timer = setInterval(() => {
        for (const c of this.clients) c.write(':heartbeat\n\n');
      }, this.heartbeatMs);
    }
    req.on('close', () => {
      this.clients.delete(res);
      if (this.clients.size === 0 && this._timer) {
        clearInterval(this._timer);
        this._timer = null;
      }
    });
  }

  broadcast(payload) {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const c of this.clients) c.write(data);
  }

  get size() { return this.clients.size; }
}

module.exports = { SseHub };
```

- [ ] **Step 4: Verificar que pasan**

Run: `npm test`
Expected: 50 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sse.js test/sse.test.js
git commit -m "feat: módulo SseHub para canal SSE global"
```

---

### Task 2: `Runner.busyIds()`

Lista de conversaciones running o en cola, para el snapshot `hello`.

**Files:**
- Modify: `src/runner.js` (agregar método después de `isBusy`, ~línea 34)
- Test: `test/runner.test.js` (append al final)

**Interfaces:**
- Consumes: `this.running` (Map convId→child), `this.queue` (array de jobs con `convId`).
- Produces: `busyIds(): string[]` — convIds únicos, running primero.

- [ ] **Step 1: Escribir el test que falla**

Append en `test/runner.test.js`:

```js
test('busyIds devuelve running + encolados sin duplicados', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  assert.deepEqual(r.busyIds(), []);
  r.send({ convId: 'c1', sessionId: 's1', cwd: '/t', text: 'a' });
  r.send({ convId: 'c2', sessionId: 's2', cwd: '/t', text: 'b' });
  r.send({ convId: 'c3', sessionId: 's3', cwd: '/t', text: 'c' }); // queda en cola (max 2)
  assert.deepEqual([...r.busyIds()].sort(), ['c1', 'c2', 'c3']);
  spawned[0].child.emit('close', 0); // c1 termina, c3 arranca
  assert.deepEqual([...r.busyIds()].sort(), ['c2', 'c3']);
});
```

- [ ] **Step 2: Verificar que falla**

Run: `npm test`
Expected: FAIL con `r.busyIds is not a function`.

- [ ] **Step 3: Implementar en `src/runner.js`**

Después del método `isBusy(convId)`:

```js
  busyIds() {
    const ids = new Set(this.running.keys());
    for (const j of this.queue) ids.add(j.convId);
    return [...ids];
  }
```

- [ ] **Step 4: Verificar que pasa**

Run: `npm test`
Expected: PASS (51 tests).

- [ ] **Step 5: Commit**

```bash
git add src/runner.js test/runner.test.js
git commit -m "feat(runner): busyIds() para snapshot de estado"
```

---

### Task 3: Server — canal global `/api/stream` + server testeable

Reemplazar `sseClients`/endpoint por conversación por el hub global, y hacer el server importable desde tests (listen solo si es el módulo principal).

**Files:**
- Modify: `src/server.js`
- Test: `test/server.sse.test.js` (nuevo — harness de integración HTTP real)

**Interfaces:**
- Consumes: `SseHub` (Task 1), `runner.busyIds()` (Task 2).
- Produces:
  - `GET /api/stream` — SSE; primer evento `{ kind: 'hello', busy: string[] }`; todos los broadcasts siguientes llevan `convId` en el payload.
  - `module.exports = { app, runner, sseHub }` desde `src/server.js` (los tests de Tasks 4 y 5 dependen de esto).
  - `broadcast(convId, payload)` interno pasa a delegar en `sseHub.broadcast({ convId, ...payload })` — misma firma, no cambian los call sites existentes.

- [ ] **Step 1: Escribir el test de integración que falla**

Crear `test/server.sse.test.js`. El harness: HOME temporal ANTES de requerir el server (así meta/uploads van a un sandbox), sin PIN, `runner.send` stubbeado (no spawnea claude real), server escuchando en puerto efímero, y un lector SSE sobre `fetch`.

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Sandbox: HOME temporal y sin auth, ANTES de requerir el server.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-sse-test-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
delete process.env.ACCESS_PIN;
process.env.SINGLE_ACCOUNT = '1';

const { app, runner, sseHub } = require('../src/server');

// Stub: no spawnear claude real. Los jobs quedan registrados para asserts.
const sentJobs = [];
runner.send = job => { sentJobs.push(job); };

let srv;
let baseUrl;

test.before(async () => {
  await new Promise(resolve => { srv = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${srv.address().port}`;
});

test.after(() => { srv.close(); });

// Lector SSE: abre /api/stream y expone next() para esperar el próximo evento data:.
async function openSse() {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/api/stream`, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  const waiters = [];
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let i;
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const line = chunk.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue; // heartbeats y líneas vacías
          const ev = JSON.parse(line.slice(6));
          const w = waiters.shift();
          if (w) w(ev); else events.push(ev);
        }
      }
    } catch { /* abort esperado al cerrar */ }
  })();
  return {
    next(timeoutMs = 5000) {
      if (events.length > 0) return Promise.resolve(events.shift());
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout esperando evento SSE')), timeoutMs);
        waiters.push(ev => { clearTimeout(t); resolve(ev); });
      });
    },
    close() { controller.abort(); },
  };
}

test('GET /api/stream manda hello con las conversaciones ocupadas del runner', async () => {
  runner.running.set('conv-ocupada', {});
  const sse = await openSse();
  try {
    const hello = await sse.next();
    assert.equal(hello.kind, 'hello');
    assert.ok(hello.busy.includes('conv-ocupada'));
  } finally {
    sse.close();
    runner.running.delete('conv-ocupada');
  }
});
```

- [ ] **Step 2: Verificar que falla**

Run: `npm test`
Expected: FAIL — `require('../src/server')` no exporta `{ app, runner, sseHub }` (destructuring da undefined) o el server se pone a escuchar en 3777/HOST al requerirlo. Los demás tests PASS.

- [ ] **Step 3: Modificar `src/server.js`**

3a. Import del hub (junto a los otros requires):

```js
const { SseHub } = require('./sse');
```

3b. Reemplazar la línea `const sseClients = new Map(); // convId → Set<res>` por:

```js
const sseHub = new SseHub();
```

3c. Reemplazar la función `broadcast` existente:

```js
function broadcast(convId, payload) {
  sseHub.broadcast({ convId, ...payload });
}
```

3d. Eliminar completo el endpoint `app.get('/api/conversations/:id/stream', ...)` (incluye su heartbeat propio — ahora vive en el hub) y agregar en su lugar:

```js
app.get('/api/stream', (req, res) => {
  sseHub.handle(req, res, { kind: 'hello', busy: runner.busyIds() });
});
```

3e. Reemplazar el `app.listen(...)` final por:

```js
if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Claude Chat Manager en http://${HOST}:${PORT}`);
  });
}

module.exports = { app, runner, sseHub };
```

- [ ] **Step 4: Verificar que pasa**

Run: `npm test`
Expected: PASS (52 tests).

- [ ] **Step 5: Smoke manual del canal (puerto alternativo — JAMÁS el 3777)**

```bash
PORT=3999 node src/server.js &
sleep 1
curl -N -m 3 http://127.0.0.1:3999/api/stream
```

Expected: primera línea de datos `data: {"kind":"hello","busy":[]}`, luego el curl corta por timeout. Matar el server de prueba: `kill %1` (es el de puerto 3999, no el 3777).

- [ ] **Step 6: Commit**

```bash
git add src/server.js test/server.sse.test.js
git commit -m "feat(server): canal SSE global /api/stream con snapshot hello"
```

---

### Task 4: Server — broadcast del mensaje de usuario con clientId

Al recibir un mensaje (POST message o conversación nueva con texto), emitirlo por el canal global para que los otros dispositivos lo vean al instante.

**Files:**
- Modify: `src/server.js` (`POST /api/conversations/:id/message` y `POST /api/conversations`)
- Test: `test/server.sse.test.js` (append)

**Interfaces:**
- Consumes: `broadcast(convId, payload)`, harness de Task 3 (`openSse`, `sentJobs`).
- Produces: evento SSE `{ convId, kind: 'user', text: string, clientId: string|null }`. `text` es el texto crudo del usuario (con markers `[Archivo adjunto: ...]` si los hay), NO el `outgoing` (que puede llevar el resumen de compactación inyectado).

- [ ] **Step 1: Escribir los tests que fallan**

Append en `test/server.sse.test.js`:

```js
test('POST /message emite evento user con clientId por el canal global', async () => {
  const create = await fetch(`${baseUrl}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const { convId } = await create.json();

  const sse = await openSse();
  try {
    await sse.next(); // hello
    const post = await fetch(`${baseUrl}/api/conversations/${convId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hola desde el desktop', clientId: 'dev-abc' }),
    });
    assert.equal(post.status, 202);
    const ev = await sse.next();
    assert.equal(ev.kind, 'user');
    assert.equal(ev.convId, convId);
    assert.equal(ev.text, 'hola desde el desktop');
    assert.equal(ev.clientId, 'dev-abc');
  } finally {
    sse.close();
  }
});

test('POST /conversations con texto inicial también emite evento user', async () => {
  const sse = await openSse();
  try {
    await sse.next(); // hello
    const create = await fetch(`${baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'arranquemos', clientId: 'dev-abc' }),
    });
    const { convId } = await create.json();
    const ev = await sse.next();
    assert.equal(ev.kind, 'user');
    assert.equal(ev.convId, convId);
    assert.equal(ev.text, 'arranquemos');
    assert.equal(ev.clientId, 'dev-abc');
  } finally {
    sse.close();
  }
});
```

- [ ] **Step 2: Verificar que fallan**

Run: `npm test`
Expected: los 2 nuevos FAIL por timeout esperando el evento `user`.

- [ ] **Step 3: Implementar en `src/server.js`**

En `POST /api/conversations/:id/message`, después de `runner.send({ ... })` y antes del `res.status(202)`:

```js
  broadcast(convId, { kind: 'user', text, clientId: req.body.clientId || null });
```

En `POST /api/conversations`, dentro del `if ((text || '').trim()) { ... }`, después del `runner.send(...)`:

```js
    broadcast(convId, { kind: 'user', text: text.trim(), clientId: req.body.clientId || null });
```

- [ ] **Step 4: Verificar que pasan**

Run: `npm test`
Expected: PASS (54 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server.js test/server.sse.test.js
git commit -m "feat(server): broadcast del mensaje de usuario con clientId"
```

---

### Task 5: Server — broadcast de cambios de meta en PATCH

Que renombrar / fijar / archivar / cambiar modelo o modo se propague al otro dispositivo al instante.

**Files:**
- Modify: `src/server.js` (`PATCH /api/conversations/:id`)
- Test: `test/server.sse.test.js` (append)

**Interfaces:**
- Consumes: harness de Task 3.
- Produces: evento SSE `{ convId, kind: 'meta', ...soloLosCamposCambiados }` con claves posibles `name`, `aiTitle`, `model`, `responseMode`, `pinned`, `archived`. El broadcast del título Groq existente (`maybeGenerateTitle`) ya queda unificado a este formato vía el nuevo `broadcast` (lleva `convId` automáticamente) — no requiere cambios.

- [ ] **Step 1: Escribir el test que falla**

Append en `test/server.sse.test.js`:

```js
test('PATCH /conversations/:id emite evento meta con los campos cambiados', async () => {
  const create = await fetch(`${baseUrl}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const { convId } = await create.json();

  const sse = await openSse();
  try {
    await sse.next(); // hello
    await fetch(`${baseUrl}/api/conversations/${convId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Charla renombrada', pinned: true }),
    });
    const ev = await sse.next();
    assert.equal(ev.kind, 'meta');
    assert.equal(ev.convId, convId);
    assert.equal(ev.name, 'Charla renombrada');
    assert.equal(ev.pinned, true);
    assert.ok(!('model' in ev)); // solo los campos que cambiaron
  } finally {
    sse.close();
  }
});
```

- [ ] **Step 2: Verificar que falla**

Run: `npm test`
Expected: FAIL por timeout esperando el evento `meta`.

- [ ] **Step 3: Implementar en `src/server.js`**

Reemplazar el cuerpo del `app.patch('/api/conversations/:id', ...)` para acumular los cambios y emitirlos:

```js
app.patch('/api/conversations/:id', (req, res) => {
  const acc = req.body.account || activeAccount;
  const { data, conv, metaFile } = resolveConv(req.params.id, acc);
  if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
  const changed = {};
  if ('name' in req.body) {
    conv.name = (req.body.name || '').trim() || undefined;
    conv.aiTitle = false;
    changed.name = conv.name || '';
    changed.aiTitle = false;
  }
  if ('model' in req.body) { conv.model = (req.body.model || '').trim() || undefined; changed.model = conv.model || ''; }
  if ('responseMode' in req.body) { conv.responseMode = (req.body.responseMode || '').trim() || undefined; changed.responseMode = conv.responseMode || ''; }
  if ('pinned' in req.body) { conv.pinned = !!req.body.pinned; changed.pinned = conv.pinned; }
  if ('archived' in req.body) { conv.archived = !!req.body.archived; changed.archived = conv.archived; }
  meta.save(data, metaFile);
  if (Object.keys(changed).length > 0) broadcast(req.params.id, { kind: 'meta', ...changed });
  res.json({ ok: true });
});
```

- [ ] **Step 4: Verificar que pasa**

Run: `npm test`
Expected: PASS (55 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server.js test/server.sse.test.js
git commit -m "feat(server): broadcast de cambios de meta en PATCH"
```

---

### Task 6: Cliente — canal global, routing por convId y estado busy real

Reemplazar el EventSource por conversación por el canal global, mantener el estado busy de todas las conversaciones, y arreglar el `setBusy(false)` incondicional de `selectConv`.

**Files:**
- Modify: `public/app.js`

**Interfaces:**
- Consumes: `GET /api/stream` (Task 3) — eventos `hello`/`claude`/`status`/`meta`/`user`/`compacted`, todos con `convId` (salvo `hello`).
- Produces (para Task 7): `const CLIENT_ID` (string UUID), `const busyConvs` (Set de convId), `function handleConvEvent(payload)` — router de eventos de la conversación abierta; Task 7 agrega ahí los cases `user` y amplía `meta`.

No hay test runner para el cliente — la verificación es sintáctica + smoke manual en Task 8.

- [ ] **Step 1: Estado global nuevo**

En el bloque de variables del tope de `public/app.js` (donde está `let eventSource = null;`), reemplazar `let eventSource = null;` por:

```js
let globalStream = null;
const busyConvs = new Set(); // convIds procesando o en cola, según el server
const CLIENT_ID = crypto.randomUUID(); // identifica este dispositivo para dedupe de eventos propios
```

- [ ] **Step 2: Reemplazar `openStream` por el canal global**

Eliminar completa la función `openStream(convId)` (sección `── Stream ──`) y poner en su lugar:

```js
// ── Stream global ──
// Un solo EventSource para todo: eventos de cualquier conversación llegan
// etiquetados con convId. Los de la conversación abierta se renderizan
// inline; los demás solo refrescan el sidebar.
function handleConvEvent(payload) {
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
      // Recargar ANTES de mostrar el error: loadMessages() reemplaza todo
      // messagesEl.innerHTML, así que si el addMsg('error', ...) va primero
      // queda tapado al instante por el reload.
      loadMessages(payload.convId).then(() => {
        if (payload.code !== 0 && payload.stderr) addMsg('error', 'Error: ' + payload.stderr);
      });
      refreshCostBadge(payload.convId);
    } else {
      setBusy(true);
    }
  } else if (payload.kind === 'meta') {
    if (payload.name) $('conv-title').textContent = payload.name;
  } else if (payload.kind === 'compacted') {
    loadMessages(payload.convId);
  }
}

function openGlobalStream() {
  if (globalStream) globalStream.close();
  globalStream = new EventSource('/api/stream');
  globalStream.onmessage = e => {
    const payload = JSON.parse(e.data);
    if (payload.kind === 'hello') {
      // Snapshot de estado al (re)conectar: re-sincroniza busy de todas.
      busyConvs.clear();
      for (const id of payload.busy || []) busyConvs.add(id);
      if (currentConv) setBusy(busyConvs.has(currentConv));
      return;
    }
    if (payload.kind === 'status') {
      if (payload.status === 'idle') busyConvs.delete(payload.convId);
      else busyConvs.add(payload.convId);
    }
    if (payload.convId === currentConv) handleConvEvent(payload);
    if (payload.kind !== 'claude') safeLoadTree();
  };
  globalStream.onerror = () => {
    // El tunnel de Cloudflare puede cortar el stream SSE en turnos largos;
    // EventSource reconecta solo pero cualquier evento emitido durante el
    // corte se pierde (el servidor no los reenvía). Al reconectar, refrescar
    // por las dudas para no dejar la conversación "colgada" con el mensaje
    // enviado sin respuesta visible. El hello de la reconexión re-sincroniza busy.
    setTimeout(() => {
      if (currentConv) loadMessages(currentConv);
      safeLoadTree();
    }, 1500);
  };
}
```

Nota: los eventos `status`/`meta`/`user`/`compacted` disparan `safeLoadTree()` (actualiza badges y orden del sidebar); los `claude` no (serían decenas por turno).

- [ ] **Step 3: `selectConv` usa el estado real y ya no abre stream propio**

En `selectConv`:
- Reemplazar la línea `setBusy(false);` por `setBusy(busyConvs.has(convId));`
- Eliminar la línea `openStream(convId);`

- [ ] **Step 4: Abrir el canal al iniciar y bajar el poll a 60s**

Reemplazar:

```js
loadAccounts().then(() => safeLoadTree());
setInterval(safeLoadTree, 15000);
```

por:

```js
loadAccounts().then(() => safeLoadTree());
openGlobalStream();
// Poll de respaldo lento: detecta sesiones creadas por fuera de Jarvis
// (CLI directo), que no generan eventos SSE. Lo demás llega por el stream.
setInterval(safeLoadTree, 60000);
```

- [ ] **Step 5: Verificación sintáctica**

Run: `node --check public/app.js`
Expected: sin salida (OK). Verificar además que no queden referencias: `grep -n "openStream\|eventSource" public/app.js` no debe devolver nada.

- [ ] **Step 6: Commit**

```bash
git add public/app.js
git commit -m "feat(ui): canal SSE global con routing por convId y busy real"
```

---

### Task 7: Cliente — mensajes de usuario remotos, clientId y meta en header

Dedupe por clientId, render del mensaje del otro dispositivo, y sincronización de selectores del header.

**Files:**
- Modify: `public/app.js`
- Modify: `public/index.html` (bump `app.js?v=24` → `?v=25` y `style.css?v=24` queda igual)

**Interfaces:**
- Consumes: `CLIENT_ID`, `handleConvEvent` (Task 6); evento `user` (Task 4); evento `meta` con campos parciales (Task 5).
- Produces: nada nuevo para otras tasks.

- [ ] **Step 1: Mandar `clientId` en los envíos**

En el submit del composer (`$('composer').onsubmit`), cambiar el body del POST:

```js
      body: JSON.stringify(withAccountBody({ text, clientId: CLIENT_ID })),
```

En `$('new-form').onsubmit`, cambiar el body del POST de creación:

```js
      body: JSON.stringify(withAccountBody({ projectDir, text, model: model || undefined, clientId: CLIENT_ID })),
```

- [ ] **Step 2: Render de mensajes de usuario remotos en `handleConvEvent`**

Agregar un case en `handleConvEvent`, entre el de `claude` y el de `status`:

```js
  } else if (payload.kind === 'user') {
    // Mensaje enviado desde otro dispositivo. El propio ya se renderizó local.
    if (payload.clientId !== CLIENT_ID) {
      addMsg('user', payload.text);
      setBusy(true);
    }
  } else if (payload.kind === 'status') {
```

(`addMsg` ya renderiza los markers `[Archivo adjunto: ...]` vía `renderTextWithPaths`.)

- [ ] **Step 3: Meta completa en el header**

Reemplazar el case `meta` de `handleConvEvent` por:

```js
  } else if (payload.kind === 'meta') {
    if ('name' in payload && payload.name) $('conv-title').textContent = payload.name;
    if ('model' in payload) $('model-select').value = payload.model || 'sonnet';
    if ('responseMode' in payload) $('response-mode-select').value = payload.responseMode || 'directo';
  } else if (payload.kind === 'compacted') {
```

- [ ] **Step 4: Bump de versión del cliente**

En `public/index.html` cambiar `<script src="app.js?v=24"></script>` por `<script src="app.js?v=25"></script>`.

- [ ] **Step 5: Verificación sintáctica**

Run: `node --check public/app.js`
Expected: sin salida (OK).

- [ ] **Step 6: Commit**

```bash
git add public/app.js public/index.html
git commit -m "feat(ui): sync de mensajes de usuario y meta entre dispositivos"
```

---

### Task 8: Verificación integral y smoke multi-dispositivo

**Files:**
- Ninguno nuevo (solo verificación; fix de lo que aparezca).

- [ ] **Step 1: Suite completa**

Run: `npm test`
Expected: 55 tests PASS (47 originales + 3 sse + 1 runner + 4 integración server).

- [ ] **Step 2: Smoke manual de sincronización (puerto alternativo — JAMÁS tocar el 3777)**

```bash
PORT=3999 node src/server.js &
sleep 1
# Terminal A: escuchar el canal global
curl -N http://127.0.0.1:3999/api/stream &
# Crear conversación y mandar mensaje simulando otro dispositivo
CONV=$(curl -s -X POST http://127.0.0.1:3999/api/conversations -H 'Content-Type: application/json' -d '{}' | grep -o '"convId":"[^"]*"' | cut -d'"' -f4)
curl -s -X POST "http://127.0.0.1:3999/api/conversations/$CONV/message" -H 'Content-Type: application/json' -d '{"text":"prueba sync","clientId":"otro-dispositivo"}'
```

Expected en la salida del curl -N:
1. `data: {"kind":"hello","busy":[]}` al conectar.
2. `data: {"convId":"...","kind":"user","text":"prueba sync","clientId":"otro-dispositivo"}` al postear.
3. Eventos `status` (queued/running) — acá el server SÍ spawnea claude real; es esperable, cancelar con `curl -X DELETE .../message` o dejar que termine.

Cerrar: matar el server de prueba del puerto 3999 (`kill %1` o el job que corresponda) — verificar con `Get-NetTCPConnection -LocalPort 3999` que murió y que el 3777 sigue vivo.

- [ ] **Step 3: Commit final si hubo fixes**

```bash
git add -A
git commit -m "fix: ajustes post-verificación de sync multi-dispositivo"
```

(Solo si hubo cambios; si no, saltear.)

- [ ] **Step 4: Nota de deploy (para Diego, no para el ejecutor)**

El server vivo en el puerto 3777 sigue corriendo el código viejo hasta reiniciarse. El ejecutor NO debe reiniciarlo (es el transporte de la sesión). Dejar dicho en el mensaje final: Diego corre `schtasks /Run /TN JarvisRestart` desde una terminal cuando quiera activar la versión nueva (corta el stream de Jarvis unos segundos). En la PC Linux: `git pull` + reiniciar su servicio.

---

## Notas para el ejecutor

- El repo tiene cambios sin commitear ajenos a este plan: soporte del modelo Fable (`README.md`, `public/index.html`, `src/server.js` — precios, ventana de contexto y opciones de selector) más `jarvis-watchdog.ps1` y `restart-jarvis.ps1` sin trackear. NO incluirlos en los commits de este plan — stagear siempre archivos explícitos (nunca `git add .` salvo en Task 8 Step 3, revisando antes con `git status`). Al mergear este plan a master puede haber un conflicto trivial en `public/index.html` (los selectores de Fable vs el bump de `?v=25`) — resolver conservando ambos.
- Si se ejecuta en worktree (recomendado, patrón del repo: `.claude/worktrees/<feature>`), los cambios sin commitear de arriba no van a estar — mejor todavía.
- Tests: `npm test` corre `node --test test/`. En Windows y Linux.
