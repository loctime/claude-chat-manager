# Sala Compartida Jarvis ↔ FerStark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Sala" tab to claude-chat-manager where Diego/Jarvis and Fernando/FerStark leave and read messages in a shared, asynchronous thread — each agent still runs 100% locally on its owner's PC, only the message buffer is centralized.

**Architecture:** A small standalone Express service (`sala-jarvis/`) deployed on the Contabo VPS stores rooms as append-only jsonl (same pattern as `src/notes.js`'s notebooks) behind per-instance bearer tokens. Each claude-chat-manager instance gets a thin HTTP client (`src/sala-client.js`) and a pure context-formatting function (`src/sala-context.js`), wired into `src/server.js` as a new `/api/sala/*` route set that reuses the existing `Runner`/`runner.send()` exactly like regular chats — a "sala conversation" is a normal local Claude Code session, just with messages from the shared room prepended as context before each turn, and its own final reply published back to the room when the turn completes.

**Tech Stack:** Node 22, Express 5, `node --test` (no test framework deps), PM2 + Caddy on the VPS (existing pattern), global `fetch` (no HTTP client library).

**Spec:** `docs/superpowers/specs/2026-09-07-sala-compartida-design.md`

## Global Constraints

- No new npm dependencies beyond what's already in `package.json` / what `sala-jarvis/package.json` declares (`express` only) — no axios, no supertest, no uuid lib (`crypto.randomUUID()` is built in).
- Every async HTTP call in `src/sala-client.js` takes an injectable `fetchImpl` (default `fetch`), same pattern as `src/groq-suggest.js` — needed for tests, no real network calls in `node --test`.
- Storage is append-only jsonl + a JSON index, same shape/verbs as `src/notes.js`'s notebook pattern (`readAll`/`append`, `readIndex`/`writeIndex`, atomic tmp+rename saves like `src/meta.js`). No SQL, no new DB.
- Auth on the VPS service is a static bearer token per instance (env var, comma-separated `Name:token` pairs) — no OAuth, no per-request session, no room-level permissions (out of scope per spec, 2 trusted instances only).
- A "sala conversation" reuses the existing `runner` (Claude), `runner.send()`, and session (`--resume`) machinery untouched — `src/runner.js` is not modified.
- All new server-side comments/strings follow the existing file's language (Spanish, informal "vos", same comment density as the surrounding code — see `src/server.js`/`src/notes.js` for tone).

---

## Part A — VPS service `sala-jarvis`

### Task 1: `sala-jarvis/src/rooms.js` — pure storage

**Files:**
- Create: `sala-jarvis/package.json`
- Create: `sala-jarvis/src/rooms.js`
- Test: `sala-jarvis/test/rooms.test.js`

**Interfaces:**
- Produces: `listRooms(indexFile?, roomsDir?) → [{id, name, createdAt, lastActivity}]`, `createRoom(name, indexFile?) → {id, name, createdAt}`, `getRoom(id, indexFile?) → {id, name, createdAt} | null`, `appendMessage(id, author, text, roomsDir?) → {message: {author, text, ts}, total: number}`, `readMessagesSince(id, since, roomsDir?) → {messages: [{author, text, ts}], nextCursor: number}`, plus `ROOMS_DIR`, `ROOMS_INDEX_FILE` constants.

- [ ] **Step 1: Write the failing test**

Create `sala-jarvis/test/rooms.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  listRooms, createRoom, getRoom, appendMessage, readMessagesSince,
} = require('../src/rooms');

const tmpIndexFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sala-index-')), 'rooms.json');
const tmpRoomsDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sala-rooms-'));

test('createRoom crea una sala con id y la lista la devuelve', () => {
  const indexFile = tmpIndexFile();
  const roomsDir = tmpRoomsDir();
  const room = createRoom('ControlDoc', indexFile);
  assert.ok(room.id);
  assert.equal(room.name, 'ControlDoc');
  assert.ok(room.createdAt);
  const list = listRooms(indexFile, roomsDir);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, room.id);
});

test('listRooms calcula lastActivity del último mensaje, o createdAt si no hay ninguno', () => {
  const indexFile = tmpIndexFile();
  const roomsDir = tmpRoomsDir();
  const room = createRoom('Sin mensajes', indexFile);
  let list = listRooms(indexFile, roomsDir);
  assert.equal(list[0].lastActivity, room.createdAt);

  appendMessage(room.id, 'Jarvis', 'hola', roomsDir);
  list = listRooms(indexFile, roomsDir);
  assert.notEqual(list[0].lastActivity, room.createdAt);
});

test('getRoom devuelve null si no existe', () => {
  assert.equal(getRoom('no-existe', tmpIndexFile()), null);
});

test('appendMessage acumula y readMessagesSince respeta el cursor', () => {
  const indexFile = tmpIndexFile();
  const roomsDir = tmpRoomsDir();
  const room = createRoom('Test', indexFile);

  appendMessage(room.id, 'Diego', 'primero', roomsDir);
  const { message, total } = appendMessage(room.id, 'Jarvis', 'segundo', roomsDir);
  assert.equal(message.author, 'Jarvis');
  assert.equal(message.text, 'segundo');
  assert.equal(total, 2);

  const fromStart = readMessagesSince(room.id, 0, roomsDir);
  assert.equal(fromStart.messages.length, 2);
  assert.equal(fromStart.nextCursor, 2);

  const fromOne = readMessagesSince(room.id, 1, roomsDir);
  assert.deepEqual(fromOne.messages.map(m => m.text), ['segundo']);
  assert.equal(fromOne.nextCursor, 2);
});

test('readMessagesSince sobre una sala sin mensajes todavía devuelve vacío', () => {
  const indexFile = tmpIndexFile();
  const roomsDir = tmpRoomsDir();
  const room = createRoom('Vacía', indexFile);
  const { messages, nextCursor } = readMessagesSince(room.id, 0, roomsDir);
  assert.deepEqual(messages, []);
  assert.equal(nextCursor, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sala-jarvis && npm test`
Expected: FAIL — `Cannot find module '../src/rooms'` (module doesn't exist yet).

- [ ] **Step 3: Write `sala-jarvis/package.json`**

```json
{
  "name": "sala-jarvis",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test \"test/**/*.test.js\""
  },
  "dependencies": {
    "express": "^5.2.1"
  }
}
```

- [ ] **Step 4: Write `sala-jarvis/src/rooms.js`**

```js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Mismo patrón que src/notes.js del repo principal (notebooks): un índice
// JSON chico con la lista de salas + un jsonl append-only por sala con sus
// mensajes. No comparte código con notes.js porque este servicio se deploya
// solo (sala-jarvis es un paquete npm aparte, sin acceso al resto del repo).
const DATA_DIR = path.join(__dirname, '..', 'data');
const ROOMS_INDEX_FILE = path.join(DATA_DIR, 'rooms.json');
const ROOMS_DIR = path.join(DATA_DIR, 'rooms');

function readIndex(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return []; }
  try { return JSON.parse(raw); }
  catch (e) { console.error('[rooms] rooms.json corrupto, se ignora:', e.message); return []; }
}

function writeIndex(list, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, file);
}

function roomMessagesFile(id, roomsDir) {
  return path.join(roomsDir, id, 'messages.jsonl');
}

function readAllMessages(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); }
    catch (e) { console.error('[rooms] línea corrupta salteada:', e.message); }
  }
  return out;
}

function listRooms(indexFile = ROOMS_INDEX_FILE, roomsDir = ROOMS_DIR) {
  return readIndex(indexFile).map(room => {
    const messages = readAllMessages(roomMessagesFile(room.id, roomsDir));
    const last = messages[messages.length - 1];
    return { ...room, lastActivity: last ? last.ts : room.createdAt };
  });
}

function createRoom(name, indexFile = ROOMS_INDEX_FILE) {
  const list = readIndex(indexFile);
  const entry = { id: crypto.randomUUID(), name, createdAt: Date.now() };
  list.push(entry);
  writeIndex(list, indexFile);
  return entry;
}

function getRoom(id, indexFile = ROOMS_INDEX_FILE) {
  return readIndex(indexFile).find(r => r.id === id) || null;
}

function appendMessage(id, author, text, roomsDir = ROOMS_DIR) {
  const file = roomMessagesFile(id, roomsDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const message = { author, text, ts: Date.now() };
  fs.appendFileSync(file, JSON.stringify(message) + '\n');
  const total = readAllMessages(file).length;
  return { message, total };
}

function readMessagesSince(id, since, roomsDir = ROOMS_DIR) {
  const all = readAllMessages(roomMessagesFile(id, roomsDir));
  return { messages: all.slice(since), nextCursor: all.length };
}

module.exports = {
  listRooms, createRoom, getRoom, appendMessage, readMessagesSince,
  ROOMS_INDEX_FILE, ROOMS_DIR,
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd sala-jarvis && npm install && npm test`
Expected: PASS — all 5 tests green.

- [ ] **Step 6: Commit**

```bash
git add sala-jarvis/package.json sala-jarvis/src/rooms.js sala-jarvis/test/rooms.test.js
git commit -m "feat(sala): storage de salas y mensajes (jsonl append-only)"
```

---

### Task 2: `sala-jarvis/src/server.js` — Express app with token auth

**Files:**
- Create: `sala-jarvis/src/server.js`
- Test: `sala-jarvis/test/server.test.js`

**Interfaces:**
- Consumes: `rooms.js` from Task 1 (`listRooms`, `createRoom`, `getRoom`, `appendMessage`, `readMessagesSince`).
- Produces: `app` (Express instance, exported unlistened for tests), `parseTokens(raw) → Map<token, senderName>`. Endpoints: `GET /rooms`, `POST /rooms`, `GET /rooms/:id/messages?since=N`, `POST /rooms/:id/messages`.

- [ ] **Step 1: Write the failing test**

Create `sala-jarvis/test/server.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.SALA_TOKENS = 'Jarvis:tok-diego,FerStark:tok-fernando';
const { app, parseTokens } = require('../src/server');

function listen(appInstance) {
  return new Promise(resolve => {
    const server = appInstance.listen(0, () => resolve(server));
  });
}

test('parseTokens arma un mapa token→nombre desde "Nombre:token,Nombre:token"', () => {
  const map = parseTokens('Jarvis:abc,FerStark:def');
  assert.equal(map.get('abc'), 'Jarvis');
  assert.equal(map.get('def'), 'FerStark');
  assert.equal(map.size, 2);
});

test('parseTokens ignora entradas vacías o mal formadas', () => {
  const map = parseTokens('Jarvis:abc,, :  ,FerStark:def');
  assert.equal(map.size, 2);
});

test('sin token válido, cualquier endpoint devuelve 401', async () => {
  const server = await listen(app);
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/rooms`);
  assert.equal(res.status, 401);
  server.close();
});

test('flujo completo: crear sala, postear mensajes de los dos, leer desde un cursor', async () => {
  const server = await listen(app);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const headers = (token) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

  const created = await fetch(`${base}/rooms`, {
    method: 'POST', headers: headers('tok-diego'), body: JSON.stringify({ name: 'Sala de prueba' }),
  }).then(r => r.json());
  assert.ok(created.id);

  const list = await fetch(`${base}/rooms`, { headers: headers('tok-diego') }).then(r => r.json());
  assert.equal(list.rooms.length, 1);

  await fetch(`${base}/rooms/${created.id}/messages`, {
    method: 'POST', headers: headers('tok-diego'), body: JSON.stringify({ text: 'hola desde Diego' }),
  });
  const posted = await fetch(`${base}/rooms/${created.id}/messages`, {
    method: 'POST', headers: headers('tok-fernando'), body: JSON.stringify({ text: 'hola desde Fernando' }),
  }).then(r => r.json());
  // El autor sale del token, no de lo que mande el body — nadie puede
  // publicar en nombre del otro aunque lo intente.
  assert.equal(posted.message.author, 'FerStark');

  const fromZero = await fetch(`${base}/rooms/${created.id}/messages?since=0`, { headers: headers('tok-diego') }).then(r => r.json());
  assert.deepEqual(fromZero.messages.map(m => m.author), ['Jarvis', 'FerStark']);
  assert.equal(fromZero.nextCursor, 2);

  const fromOne = await fetch(`${base}/rooms/${created.id}/messages?since=1`, { headers: headers('tok-diego') }).then(r => r.json());
  assert.deepEqual(fromOne.messages.map(m => m.text), ['hola desde Fernando']);

  server.close();
});

test('sala inexistente devuelve 404 tanto en GET como en POST de mensajes', async () => {
  const server = await listen(app);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer tok-diego' };

  const get = await fetch(`${base}/rooms/no-existe/messages`, { headers });
  assert.equal(get.status, 404);

  const post = await fetch(`${base}/rooms/no-existe/messages`, { method: 'POST', headers, body: JSON.stringify({ text: 'x' }) });
  assert.equal(post.status, 404);

  server.close();
});

test('texto vacío al postear un mensaje devuelve 400', async () => {
  const server = await listen(app);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer tok-diego' };
  const created = await fetch(`${base}/rooms`, { method: 'POST', headers, body: JSON.stringify({ name: 'X' }) }).then(r => r.json());

  const res = await fetch(`${base}/rooms/${created.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ text: '   ' }) });
  assert.equal(res.status, 400);

  server.close();
});
```

Note: this test suite uses real jsonl files under `sala-jarvis/data/` via the module's default paths (no fixture override — `rooms.js`'s exported functions all accept optional file/dir args, but `server.js` calls them with defaults). To keep the test suite hermetic, Step 3 wires `server.js` to read `ROOMS_INDEX_FILE`/`ROOMS_DIR` from `rooms.js`'s exports every time rather than caching them, and this test file sets `process.env.SALA_DATA_DIR` before requiring `server.js` — add that override:

At the very top of `sala-jarvis/test/server.test.js`, before the `require('../src/server')` line, add:

```js
process.env.SALA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sala-server-test-'));
```//before setting SALA_TOKENS is fine, order between the two env vars doesn't matter, just both before the require.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sala-jarvis && npm test`
Expected: FAIL — `Cannot find module '../src/server'`.

- [ ] **Step 3: Write `sala-jarvis/src/server.js`**

```js
const express = require('express');
const path = require('path');
const rooms = require('./rooms');

// SALA_DATA_DIR: override para tests (hermético, sin tocar sala-jarvis/data/
// real) y para poder apuntar el servicio en el VPS a un disco/ruta distinta
// si hiciera falta. Sin la env var, rooms.js usa sus defaults (sala-jarvis/data/).
const dataDir = process.env.SALA_DATA_DIR;
const indexFile = dataDir ? path.join(dataDir, 'rooms.json') : rooms.ROOMS_INDEX_FILE;
const roomsDir = dataDir ? path.join(dataDir, 'rooms') : rooms.ROOMS_DIR;

const PORT = Number(process.env.PORT || 3410);

// "Nombre1:token1,Nombre2:token2" → Map<token, nombre>. Entradas vacías o
// sin ":" se ignoran en silencio (config a mano en el VPS, más vale
// tolerante que tirar el server por una coma de más).
function parseTokens(raw) {
  const map = new Map();
  for (const pair of (raw || '').split(',')) {
    const [name, token] = pair.split(':').map(s => (s || '').trim());
    if (name && token) map.set(token, name);
  }
  return map;
}

const TOKENS = parseTokens(process.env.SALA_TOKENS || '');

const app = express();
app.use(express.json());

// El autor de cada mensaje sale del token, nunca de lo que mande el cliente
// en el body — así ninguna de las dos instancias puede publicar en nombre
// de la otra, ni por bug ni a propósito.
app.use((req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const senderName = TOKENS.get(token);
  if (!senderName) return res.status(401).json({ error: 'token inválido' });
  req.senderName = senderName;
  next();
});

app.get('/rooms', (req, res) => {
  res.json({ rooms: rooms.listRooms(indexFile, roomsDir) });
});

app.post('/rooms', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'nombre vacío' });
  res.status(201).json(rooms.createRoom(name, indexFile));
});

app.get('/rooms/:id/messages', (req, res) => {
  if (!rooms.getRoom(req.params.id, indexFile)) return res.status(404).json({ error: 'sala no encontrada' });
  const since = Number(req.query.since || 0);
  res.json(rooms.readMessagesSince(req.params.id, since, roomsDir));
});

app.post('/rooms/:id/messages', (req, res) => {
  if (!rooms.getRoom(req.params.id, indexFile)) return res.status(404).json({ error: 'sala no encontrada' });
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'texto vacío' });
  res.status(201).json(rooms.appendMessage(req.params.id, req.senderName, text, roomsDir));
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`sala-jarvis escuchando en :${PORT}`));
}

module.exports = { app, parseTokens };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sala-jarvis && npm test`
Expected: PASS — all tests in `rooms.test.js` and `server.test.js` green.

- [ ] **Step 5: Commit**

```bash
git add sala-jarvis/src/server.js sala-jarvis/test/server.test.js
git commit -m "feat(sala): API HTTP con auth por token (GET/POST rooms + messages)"
```

---

### Task 3: Deploy `sala-jarvis` al VPS (Contabo)

**Files:**
- Create: `sala-jarvis/ecosystem.config.js`
- Create: `sala-jarvis/README.md`

No test cycle here (infra, not code) — verification is a live curl against the deployed service at the end.

- [ ] **Step 1: Write `sala-jarvis/ecosystem.config.js`**

```js
module.exports = {
  apps: [{
    name: 'sala-jarvis',
    script: 'src/server.js',
    cwd: __dirname,
    autorestart: true,
    env: {
      PORT: 3410,
      // SALA_TOKENS se setea en el shell antes de `pm2 start` (no en este
      // archivo, no se commitea) — ver README.md de este mismo folder.
    },
  }],
};
```

- [ ] **Step 2: Write `sala-jarvis/README.md`**

```md
# sala-jarvis

Servicio chico de mensajería para la sala compartida Jarvis↔FerStark. Ver
diseño completo en `../docs/superpowers/specs/2026-09-07-sala-compartida-design.md`.

## Deploy en el VPS (Contabo, root@5.189.136.177)

1. Clonar (o `git pull` si ya existe) el repo completo en `/opt/sala-jarvis`:
   ```
   cd /opt && git clone git@github.com:loctime/claude-chat-manager.git sala-jarvis-repo
   ```
   (Se clona el repo entero por simplicidad — sala-jarvis vive en un subfolder,
   no hace falta un repo aparte. El servicio solo corre `sala-jarvis-repo/sala-jarvis`.)

2. Instalar dependencias:
   ```
   cd /opt/sala-jarvis-repo/sala-jarvis && npm install --omit=dev
   ```

3. Generar dos tokens random (uno por instancia) y arrancar con PM2:
   ```
   export SALA_TOKENS="Jarvis:$(openssl rand -hex 24),FerStark:$(openssl rand -hex 24)"
   echo "$SALA_TOKENS"   # copiar cada token para pegarlo en la Configuración de cada Jarvis
   pm2 start ecosystem.config.js --env production
   pm2 save
   ```
   Los tokens quedan solo en el env de PM2 (`pm2 env <id>` los muestra —
   mismo gotcha de seguridad ya documentado para el resto del VPS, no correr
   `pm2 env`/`pm2 jlist` con salida cruda a la vista de terceros).

4. Bloque Caddy (`/etc/caddy/Caddyfile`), mismo patrón que el resto del VPS:
   ```
   sala.controlapps.ar {
       encode gzip
       reverse_proxy localhost:3410
       log { output file /var/log/caddy/sala.controlapps.ar.log }
   }
   ```
   ```
   touch /var/log/caddy/sala.controlapps.ar.log && chown caddy:caddy /var/log/caddy/sala.controlapps.ar.log
   systemctl reload caddy
   ```
   DNS: A record `sala` → `5.189.136.177`, proxy ON, en la zona `controlapps.ar` de Cloudflare.

5. Verificar en vivo:
   ```
   curl -s -X POST https://sala.controlapps.ar/rooms \
     -H "Authorization: Bearer <token-de-Jarvis>" -H 'Content-Type: application/json' \
     -d '{"name":"prueba deploy"}'
   ```
   Debe devolver `201` con `{id, name, createdAt}`. Después borrar la sala de
   prueba a mano (borrar su entrada de `data/rooms.json` y su carpeta en
   `data/rooms/<id>/` — no hay endpoint de borrado, no lo necesita esta v1).
```

- [ ] **Step 3: Ejecutar el deploy real**

Correr los pasos del README contra el VPS (SSH puerto 22022, ver `reference_vps_acceso_warp.md`), incluida la verificación con `curl` del paso 5. Guardar los dos tokens generados — hacen falta en el Task 6 de la Parte B, uno para configurar esta instancia (Jarvis) y el otro para pasárselo a Fernando.

- [ ] **Step 4: Commit**

```bash
git add sala-jarvis/ecosystem.config.js sala-jarvis/README.md
git commit -m "docs(sala): deploy PM2+Caddy del servicio sala-jarvis"
```

---

## Part B — Integración en claude-chat-manager (Jarvis)

### Task 4: `src/sala-client.js` — cliente HTTP del servicio VPS

**Files:**
- Create: `src/sala-client.js`
- Test: `test/sala-client.test.js`

**Interfaces:**
- Produces: `listRooms({baseUrl, token, fetchImpl?}) → [{id,name,createdAt,lastActivity}]`, `createRoom({baseUrl, token, name, fetchImpl?}) → {id,name,createdAt}`, `fetchMessages({baseUrl, token, roomId, since, fetchImpl?}) → {messages, nextCursor}`, `postMessage({baseUrl, token, roomId, text, fetchImpl?}) → {message, total}`. Every function throws `Error` (message from the response body's `error`, or a generic one) on non-2xx or network failure — callers decide how to surface it, this module never swallows errors (unlike `groq-suggest.js`, whose failures are cosmetic; here a failed publish must be visible).

- [ ] **Step 1: Write the failing test**

Create `test/sala-client.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { listRooms, createRoom, fetchMessages, postMessage } = require('../src/sala-client');

const OPTS = { baseUrl: 'https://sala.controlapps.ar', token: 'tok-x' };

test('listRooms pega a GET /rooms con el bearer token', async () => {
  let seenUrl, seenOpts;
  const fetchImpl = async (url, opts) => {
    seenUrl = url; seenOpts = opts;
    return { ok: true, json: async () => ({ rooms: [{ id: '1', name: 'X' }] }) };
  };
  const rooms = await listRooms({ ...OPTS, fetchImpl });
  assert.equal(seenUrl, 'https://sala.controlapps.ar/rooms');
  assert.equal(seenOpts.headers.Authorization, 'Bearer tok-x');
  assert.deepEqual(rooms, [{ id: '1', name: 'X' }]);
});

test('createRoom pega a POST /rooms con el nombre', async () => {
  let seenOpts;
  const fetchImpl = async (url, opts) => {
    seenOpts = opts;
    return { ok: true, json: async () => ({ id: '1', name: 'Nueva' }) };
  };
  const room = await createRoom({ ...OPTS, name: 'Nueva', fetchImpl });
  assert.equal(seenOpts.method, 'POST');
  assert.deepEqual(JSON.parse(seenOpts.body), { name: 'Nueva' });
  assert.equal(room.name, 'Nueva');
});

test('fetchMessages agrega ?since= a la URL', async () => {
  let seenUrl;
  const fetchImpl = async (url) => {
    seenUrl = url;
    return { ok: true, json: async () => ({ messages: [], nextCursor: 5 }) };
  };
  await fetchMessages({ ...OPTS, roomId: 'r1', since: 5, fetchImpl });
  assert.equal(seenUrl, 'https://sala.controlapps.ar/rooms/r1/messages?since=5');
});

test('postMessage pega a POST /rooms/:id/messages con el texto', async () => {
  let seenUrl, seenOpts;
  const fetchImpl = async (url, opts) => {
    seenUrl = url; seenOpts = opts;
    return { ok: true, json: async () => ({ message: { author: 'Jarvis', text: 'hola', ts: 1 }, total: 1 }) };
  };
  const result = await postMessage({ ...OPTS, roomId: 'r1', text: 'hola', fetchImpl });
  assert.equal(seenUrl, 'https://sala.controlapps.ar/rooms/r1/messages');
  assert.deepEqual(JSON.parse(seenOpts.body), { text: 'hola' });
  assert.equal(result.message.author, 'Jarvis');
});

test('una respuesta no-ok tira un Error con el mensaje del body', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: 'token inválido' }) });
  await assert.rejects(() => listRooms({ ...OPTS, fetchImpl }), /token inválido/);
});

test('una respuesta no-ok sin body JSON parseable tira un Error genérico con el status', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => { throw new Error('no json'); } });
  await assert.rejects(() => listRooms({ ...OPTS, fetchImpl }), /500/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="sala-client"` (o `node --test test/sala-client.test.js`)
Expected: FAIL — `Cannot find module '../src/sala-client'`.

- [ ] **Step 3: Write `src/sala-client.js`**

```js
// Cliente HTTP del servicio "sala-jarvis" (ver sala-jarvis/README.md y
// docs/superpowers/specs/2026-09-07-sala-compartida-design.md). Mismo
// patrón que src/groq-suggest.js: fetchImpl inyectable (default global
// fetch) para que los tests no pegan red real. A diferencia de
// groq-suggest.js (que traga errores porque es cosmético), acá un fallo se
// propaga siempre — publicar/leer la sala es la funcionalidad, no un extra.
async function request(url, { method = 'GET', token, body, fetchImpl = fetch } = {}) {
  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}` },
  };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetchImpl(url, opts);
  if (!res.ok) {
    let message = `sala-jarvis respondió ${res.status}`;
    try {
      const data = await res.json();
      if (data && data.error) message = data.error;
    } catch { /* body no era JSON, se queda con el mensaje genérico */ }
    throw new Error(message);
  }
  return res.json();
}

async function listRooms({ baseUrl, token, fetchImpl }) {
  const data = await request(`${baseUrl}/rooms`, { token, fetchImpl });
  return data.rooms;
}

async function createRoom({ baseUrl, token, name, fetchImpl }) {
  return request(`${baseUrl}/rooms`, { method: 'POST', token, body: { name }, fetchImpl });
}

async function fetchMessages({ baseUrl, token, roomId, since, fetchImpl }) {
  return request(`${baseUrl}/rooms/${roomId}/messages?since=${since}`, { token, fetchImpl });
}

async function postMessage({ baseUrl, token, roomId, text, fetchImpl }) {
  return request(`${baseUrl}/rooms/${roomId}/messages`, { method: 'POST', token, body: { text }, fetchImpl });
}

module.exports = { listRooms, createRoom, fetchMessages, postMessage };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sala-client.test.js`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/sala-client.js test/sala-client.test.js
git commit -m "feat(sala): cliente HTTP del servicio sala-jarvis"
```

---

### Task 5: `src/sala-context.js` — armado del bloque de contexto

**Files:**
- Create: `src/sala-context.js`
- Test: `test/sala-context.test.js`

**Interfaces:**
- Produces: `buildContextBlock(messages) → string`. `messages` is the array shape from `sala-client.js`'s `fetchMessages` (`[{author, text, ts}]`). Returns `''` for an empty array (caller skips prepending in that case).

- [ ] **Step 1: Write the failing test**

Create `test/sala-context.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { buildContextBlock } = require('../src/sala-context');

test('array vacío devuelve string vacío', () => {
  assert.equal(buildContextBlock([]), '');
});

test('un mensaje se arma como [Autor dijo:] texto', () => {
  const block = buildContextBlock([{ author: 'Fernando', text: 'che, revisá el deploy', ts: 1 }]);
  assert.equal(block, '[Fernando dijo:]\nche, revisá el deploy');
});

test('varios mensajes quedan uno debajo del otro, en orden', () => {
  const block = buildContextBlock([
    { author: 'Fernando', text: 'che, revisá el deploy', ts: 1 },
    { author: 'FerStark', text: 'ya lo revisé, está OK', ts: 2 },
  ]);
  assert.equal(
    block,
    '[Fernando dijo:]\nche, revisá el deploy\n\n[FerStark dijo:]\nya lo revisé, está OK'
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sala-context.test.js`
Expected: FAIL — `Cannot find module '../src/sala-context'`.

- [ ] **Step 3: Write `src/sala-context.js`**

```js
// Arma el bloque de contexto que se antepone al mensaje del usuario en una
// conversación de Sala — mismo criterio mecánico entre corchetes que ya usa
// el resto del proyecto (pendingRewindNotice/compactedSummary en server.js,
// las etiquetas de "Citar" en app.js): instrucciones/contexto de tono se
// pierden en el system prompt, pero un marcador mecánico tipo "[Fernando
// dijo:]" se respeta. Ver CLAUDE.local.md, "Modos de respuesta".
function buildContextBlock(messages) {
  if (!messages || messages.length === 0) return '';
  return messages
    .map(m => `[${m.author} dijo:]\n${m.text}`)
    .join('\n\n');
}

module.exports = { buildContextBlock };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sala-context.test.js`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/sala-context.js test/sala-context.test.js
git commit -m "feat(sala): armado del bloque de contexto [Autor dijo:]"
```

---

### Task 6: Config de instancia — URL y token de la sala

**Files:**
- Modify: `src/server.js:262-274` (GET `/api/accounts`), `src/server.js:403-436` (PATCH `/api/config`)
- Test: `test/config.test.js` (no changes needed — `config.js` itself is untouched, it already persists arbitrary keys; this task's test coverage is the server.js routes, covered by a new integration-style check in Step 3 below run manually, since this repo has no HTTP test harness for `server.js` — see existing pattern, e.g. `groqApiKey` has no dedicated route test either)

**Interfaces:**
- Consumes: `config.load()`/`config.save()` from `src/config.js` (unchanged).
- Produces: `getSalaUrl()`, `getSalaToken()` functions in `server.js`, same prioridad pattern as `getGroqApiKey()` (config guardada > env var > vacío). `PATCH /api/config` accepts `salaUrl`/`salaToken`; `GET /api/accounts` and the `PATCH` response expose `salaUrl` (plain) and `salaTokenSet` (boolean — mismo patrón que `groqApiKeySet`, nunca se devuelve el token en texto).

- [ ] **Step 1: Add the getters, mirroring `getGroqApiKey()`**

In `src/server.js`, right after the existing `getGroqApiKey()` function (around line 68), add:

```js
// URL y token del servicio sala-jarvis (VPS) — mismo patrón de prioridad que
// getGroqApiKey(): config guardada en Configuración > env var > vacío. Sin
// salaUrl configurada, la pestaña Sala se muestra pero avisa que falta
// configurar (ver Task 7/9).
function getSalaUrl() {
  const url = (config.load().salaUrl || '').trim();
  return url || process.env.SALA_URL || '';
}

function getSalaToken() {
  const token = (config.load().salaToken || '').trim();
  return token || process.env.SALA_TOKEN || '';
}
```

- [ ] **Step 2: Expose in `GET /api/accounts`**

In `src/server.js`, inside the `app.get('/api/accounts', ...)` handler (around line 262), add two fields to the response object:

```js
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
```

- [ ] **Step 3: Accept and persist in `PATCH /api/config`**

In `src/server.js`, inside `app.patch('/api/config', ...)` (around line 403), add two `if` blocks mirroring the `groqApiKey` one, and add the two fields to the final response:

```js
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
```

(The `config.save(cfg)` line already exists once in the handler — don't duplicate it, just add the two `if` blocks before it and the two fields to the existing response object.)

- [ ] **Step 4: Verify manually**

Run: `npm test` (full suite — confirms nothing existing broke; there's no dedicated route test for this, same as `groqApiKey`'s routes).
Then with the server running locally: `curl -s -X PATCH http://127.0.0.1:3777/api/config -H 'Content-Type: application/json' -d '{"salaUrl":"https://sala.controlapps.ar","salaToken":"tok-diego"}'` should return `salaUrl` set and `salaTokenSet: true`; a follow-up `curl http://127.0.0.1:3777/api/accounts` should show the same.
Expected: 190/190 pre-existing tests still pass; the two curls confirm the new fields round-trip.

- [ ] **Step 5: Commit**

```bash
git add src/server.js
git commit -m "feat(sala): config de instancia para URL y token de sala-jarvis"
```

---

### Task 7: `server.js` — endpoints `/api/sala/rooms*` (listar, crear, mandar mensaje)

**Files:**
- Modify: `src/server.js` (add requires, `SALA_META_FILE` constant, helper functions, and three new routes — insert the new route block right after the existing Codex route block, i.e. after line ~2313's `/api/codex/conversations/:id/stream`)

**Interfaces:**
- Consumes: `sala-client.js` (Task 4: `listRooms`, `createRoom`, `fetchMessages`, `postMessage`), `sala-context.js` (Task 5: `buildContextBlock`), `getSalaUrl()`/`getSalaToken()` (Task 6), `meta.load`/`meta.save`/`meta.advanceSession` (existing, same as `CODEX_META_FILE` usage), `runner.send()`/`runner.isBusy()` (existing, unchanged), `getAppName()`/`getUserName()` (existing), `accountHomeDir(activeAccount)` (existing), `scanner.resolveCwd` is NOT used here — sala conversations always run from `accountHomeDir(activeAccount)` (no project association, see spec).
- Produces: `resolveOrCreateSalaConv(roomId)` helper — used again by Task 8. Route `GET /api/sala/rooms` → `{rooms: [{id,name,createdAt,lastActivity,convId}]}`. Route `POST /api/sala/rooms` → `201 {id,name,createdAt}`. Route `POST /api/sala/rooms/:id/message` → `202 {queued:true}` (same async pattern as `/api/conversations/:id/message`).

- [ ] **Step 1: Add the require and the meta file constant**

In `src/server.js`, near the top with the other `require`s (after `const gitSync = require('./git-sync');`, around line 23), add:

```js
const salaClient = require('./sala-client');
const { buildContextBlock } = require('./sala-context');
```

Near `const CODEX_META_FILE = ...` (around line 661), add:

```js
const SALA_META_FILE = path.join(os.homedir(), '.claude', 'session-manager', 'sala-meta.json');
```

- [ ] **Step 2: Add `resolveOrCreateSalaConv` and the three routes**

Insert this block in `src/server.js` right after the existing Codex routes end (after the `app.get('/api/codex/conversations/:id/stream', ...)` handler, i.e. right before the final `app.listen(...)` / server bootstrap code — same place the Codex block sits relative to the rest):

```js
// ── Sala compartida (Jarvis ↔ FerStark) ──
// Cada "sala" es una conversación de Claude local normal (mismo runner,
// mismo --resume) — lo único distinto es que antes de cada turno se le
// antepone lo que se dijo en la sala compartida desde la última vez que
// esta instancia miró, y al terminar se publica la respuesta de vuelta.
// Ver docs/superpowers/specs/2026-09-07-sala-compartida-design.md.

// Une el convId local (una sesión de Claude de ESTA instancia) con el
// roomId remoto (la sala en el VPS, compartida). 1 sala ↔ 1 conv local por
// instancia — se crea la primera vez que se manda un mensaje a esa sala.
function resolveOrCreateSalaConv(roomId) {
  const data = meta.load(SALA_META_FILE);
  let convId = Object.keys(data.conversations).find(id => data.conversations[id].roomId === roomId);
  if (!convId) {
    convId = crypto.randomUUID();
    data.conversations[convId] = { roomId, contextCursor: 0, createdAt: new Date().toISOString() };
    meta.save(data, SALA_META_FILE);
  }
  return { convId, conv: data.conversations[convId] };
}

app.get('/api/sala/rooms', async (req, res) => {
  const salaUrl = getSalaUrl(), salaToken = getSalaToken();
  if (!salaUrl || !salaToken) return res.status(400).json({ error: 'sala no configurada — completá la URL y el token en Configuración' });
  try {
    const rooms = await salaClient.listRooms({ baseUrl: salaUrl, token: salaToken });
    const data = meta.load(SALA_META_FILE);
    const withConv = rooms.map(r => {
      const convId = Object.keys(data.conversations).find(id => data.conversations[id].roomId === r.id) || null;
      return { ...r, convId };
    });
    res.json({ rooms: withConv });
  } catch (err) {
    res.status(502).json({ error: 'no se pudo contactar la sala: ' + err.message });
  }
});

app.post('/api/sala/rooms', async (req, res) => {
  const salaUrl = getSalaUrl(), salaToken = getSalaToken();
  if (!salaUrl || !salaToken) return res.status(400).json({ error: 'sala no configurada — completá la URL y el token en Configuración' });
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'nombre vacío' });
  try {
    const room = await salaClient.createRoom({ baseUrl: salaUrl, token: salaToken, name });
    res.status(201).json(room);
  } catch (err) {
    res.status(502).json({ error: 'no se pudo crear la sala: ' + err.message });
  }
});

app.get('/api/sala/rooms/:id/messages', async (req, res) => {
  const salaUrl = getSalaUrl(), salaToken = getSalaToken();
  if (!salaUrl || !salaToken) return res.status(400).json({ error: 'sala no configurada — completá la URL y el token en Configuración' });
  try {
    // Para MOSTRARLE la sala al humano siempre se trae desde el principio
    // (since=0) — es una lectura completa para renderizar, independiente
    // del contextCursor que trackea qué ya se le dio de comer a Claude.
    const { messages } = await salaClient.fetchMessages({ baseUrl: salaUrl, token: salaToken, roomId: req.params.id, since: 0 });
    res.json({ messages });
  } catch (err) {
    res.status(502).json({ error: 'no se pudo leer la sala: ' + err.message });
  }
});

app.post('/api/sala/rooms/:id/message', async (req, res) => {
  const salaUrl = getSalaUrl(), salaToken = getSalaToken();
  if (!salaUrl || !salaToken) return res.status(400).json({ error: 'sala no configurada — completá la URL y el token en Configuración' });
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'mensaje vacío' });
  const roomId = req.params.id;
  const { convId, conv } = resolveOrCreateSalaConv(roomId);
  if (runner.isBusy(convId)) return res.status(409).json({ error: 'esa sala ya está procesando un mensaje' });

  try {
    // 1. Traer lo nuevo que se dijeron los demás desde la última vez.
    const { messages: newFromOthers, nextCursor } = await salaClient.fetchMessages({
      baseUrl: salaUrl, token: salaToken, roomId, since: conv.contextCursor,
    });
    // 2. Publicar YA el mensaje del humano en la sala, para que el otro lado
    //    lo vea aunque esta instancia tarde en responder.
    const { total: totalAfterOwn } = await salaClient.postMessage({
      baseUrl: salaUrl, token: salaToken, roomId, text: `${getUserName()}: ${text}`,
    });
    // 3. El cursor avanza más allá de lo leído en (1) Y de lo que uno mismo
    //    acaba de publicar en (2) — nada de eso hay que re-inyectárselo a
    //    Claude la próxima vez, ya está en su sesión local vía --resume.
    const data = meta.load(SALA_META_FILE);
    data.conversations[convId].contextCursor = Math.max(nextCursor, totalAfterOwn);
    meta.save(data, SALA_META_FILE);

    const contextBlock = buildContextBlock(newFromOthers);
    const outgoing = contextBlock
      ? `${contextBlock}\n\n[Mensaje actual de ${getUserName()}]\n${text}`
      : text;

    runner.send({ convId, sessionId: conv.currentSessionId, cwd: accountHomeDir(activeAccount), text: outgoing, account: activeAccount });
    res.status(202).json({ queued: true });
  } catch (err) {
    res.status(502).json({ error: 'no se pudo publicar en la sala: ' + err.message });
  }
});
```

- [ ] **Step 3: Verify manually against a locally running `sala-jarvis`**

Run `sala-jarvis` locally (`cd sala-jarvis && SALA_TOKENS="Jarvis:dev,FerStark:dev2" npm start`), configure this instance's `salaUrl`/`salaToken` via the `PATCH /api/config` from Task 6 pointing at `http://127.0.0.1:3410`, then:

```bash
curl -s -X POST http://127.0.0.1:3777/api/sala/rooms -H 'Content-Type: application/json' -d '{"name":"prueba"}'
curl -s http://127.0.0.1:3777/api/sala/rooms
```

Expected: the room is created, appears in the list with a `convId: null` (no message sent yet). Full send-a-message verification happens in Task 8 (needs the publish-on-completion hook to close the loop) — for this task, confirm the three GET/POST-without-message routes respond correctly and `npm test` (full suite) still passes.

- [ ] **Step 4: Commit**

```bash
git add src/server.js
git commit -m "feat(sala): endpoints /api/sala/rooms (listar, crear, mandar mensaje)"
```

---

### Task 8: `server.js` — publicar la respuesta del agente al terminar el turno

**Files:**
- Modify: `src/server.js:794-816` (the existing `runner.on('status', ...)` handler)

**Interfaces:**
- Consumes: `SALA_META_FILE`, `meta.load`/`meta.save` (existing), `scanner.getMessagesIncremental`/`scanner.findSessionFile` (existing, same functions `maybeGenerateTitle` already uses), `salaClient.postMessage` (Task 4), `getAppName()` (existing).
- Produces: no new exports — this is a behavioral addition to an existing handler.

- [ ] **Step 1: Add the sala-publish helper, right before the existing `runner.on('status', ...)` block**

In `src/server.js`, right before `runner.on('status', s => {` (around line 794), add:

```js
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

  const { total } = await salaClient.postMessage({ baseUrl: salaUrl, token: salaToken, roomId: conv.roomId, text: `${getAppName()}: ${last.text}` });
  const fresh = meta.load(SALA_META_FILE);
  if (fresh.conversations[convId]) {
    fresh.conversations[convId].contextCursor = Math.max(fresh.conversations[convId].contextCursor || 0, total);
    meta.save(fresh, SALA_META_FILE);
  }
}
```

- [ ] **Step 2: Also advance `currentSessionId` for sala conversations in the `event` handler**

The existing `runner.on('event', ...)` handler (around line 773) only advances the session id in `accountMetaFile(account)`. Sala conversations live in `SALA_META_FILE` instead, so it needs a parallel check. Replace the existing body of `runner.on('event', ({ convId, event, account }) => { ... })`'s session-advance block:

```js
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
  ...
```

(Keep the rest of that handler — the `result`/`rate_limits` block and the final `broadcast(convId, ...)` call — unchanged, only the session-advance `if` block above gets the `else` branch added.)

- [ ] **Step 3: Call the helper from the `status` handler**

In the existing `runner.on('status', s => { ... })` handler (around line 794), add the call right after the existing unread-marking block, still inside the same handler:

```js
runner.on('status', s => {
  broadcast(s.convId, { kind: 'status', ...s });
  if (s.status === 'idle' && s.code === 0) {
    maybeGenerateTitle(s.convId, s.account || activeAccount).catch(() => {});
    syncSearchIndex(s.account || activeAccount, { reason: 'turno' });
  }
  if (s.status === 'idle' && !s.cancelled) {
    const hasViewer = (sseClients.get(s.convId)?.size || 0) > 0;
    if (!hasViewer) {
      const metaFile = accountMetaFile(s.account || activeAccount);
      const data = meta.load(metaFile);
      const conv = data.conversations[s.convId];
      if (conv && conv.currentSessionId) {
        conv.unread = true;
        meta.save(data, metaFile);
      }
    }
  }
  if (s.status === 'idle' && s.code === 0) {
    publishSalaReplyIfNeeded(s.convId, s.account || activeAccount, s.cancelled)
      .catch(err => console.error('[sala] no se pudo publicar la respuesta:', err.message));
  }
});
```

- [ ] **Step 4: Verify manually, end to end**

With `sala-jarvis` running locally (from Task 7's Step 3) and this server pointed at it:

```bash
curl -s -X POST http://127.0.0.1:3777/api/sala/rooms/<roomId>/message -H 'Content-Type: application/json' -d '{"text":"decime la hora"}'
```

Wait a few seconds (Claude runs a real turn), then:

```bash
curl -s http://127.0.0.1:3777/api/sala/rooms/<roomId>/messages
```

Expected: two new messages appear — `"Vos: decime la hora"` (or whatever `getUserName()` resolves to) and `"J.A.R.V.I.S: <respuesta real de Claude>"` (or whatever `getAppName()` resolves to). Also run `npm test` (full suite) to confirm nothing existing broke.

- [ ] **Step 5: Commit**

```bash
git add src/server.js
git commit -m "feat(sala): publicar la respuesta del agente al terminar el turno"
```

---

### Task 9: `public/index.html` + `public/style.css` — pestaña "Sala"

**Files:**
- Modify: `public/index.html` (add tab button + pane markup, mirroring the Notas tab)
- Modify: `public/style.css` (only if the reused `.conv`/`.notebook-row`/`.tree-pane` classes need a small addition — see Step 2)

**Interfaces:**
- Produces: DOM ids `sala-tab` (pane-tab button, `data-pane="4"`), `tree-sala` (the room-list pane), `sala-view` (the open-room view, reusing the same panel/overlay pattern as `notebook-view`), `sala-title`, `sala-messages`, `new-room-btn`.

- [ ] **Step 1: Add the tab button**

In `public/index.html`, in the `#pane-tabs` nav (around line 56-60), add a 5th tab button after the Notas one:

```html
      <nav id="pane-tabs">
        <button type="button" class="pane-tab active" data-pane="0">Chats</button>
        <button type="button" class="pane-tab" data-pane="1">Archivado</button>
        <button type="button" class="pane-tab" id="codex-tab" data-pane="2">Codex</button>
        <button type="button" class="pane-tab" data-pane="3">📝 Notas</button>
        <button type="button" class="pane-tab" data-pane="4">💬 Sala</button>
      </nav>
```

- [ ] **Step 2: Add the room-list pane**

In `public/index.html`, inside `#tree-viewport-inner` (around line 103, right after the `#tree-notes` div), add:

```html
          <div id="tree-sala" class="tree-pane notes-pane">
            <div class="notes-toolbar">
              <button type="button" id="new-room-btn" class="btn-icon" title="Nueva sala">+ Nueva sala</button>
            </div>
            <nav id="room-list"></nav>
          </div>
```

(Reuses the `.notes-pane`/`.notes-toolbar` classes already styled for the Notas tab — no new CSS needed for the list itself.)

- [ ] **Step 3: Add the open-room view**

In `public/index.html`, right after the existing `#notebook-view` div (around line 189-229, same panel it lives in — `#panel-chat`), add a sibling view:

```html
      <!-- Sala: sala abierta — mismo panel/overlay/back que el chat y las libretas -->
      <div id="sala-view" class="notes-pane" hidden>
        <div class="notes-header">
          <button type="button" class="back-btn" id="sala-back-btn">←</button>
          <div class="notes-title" id="sala-title"></div>
        </div>
        <!-- Oculto por default; se muestra cuando una llamada a /api/sala/* falla
             (VPS caído o sala sin configurar) — ver Task 10, safeLoadRoomList/
             safeLoadRoomMessages/sendRoomMessage. Mientras está visible, el
             composer queda deshabilitado (no tiene sentido mandar sin poder
             traer lo que dijeron los demás primero). -->
        <div id="sala-offline-banner" class="notes-empty" hidden>Sin conexión con la sala — mostrando lo último que se pudo cargar.</div>
        <div class="notes-messages" id="sala-messages"></div>
        <div class="notes-composer">
          <textarea id="sala-input" placeholder="Escribí acá..."></textarea>
          <button type="button" id="sala-send-btn">Enviar</button>
        </div>
      </div>
```

- [ ] **Step 4: Verify markup renders**

Run: `npm start` (or however this instance is normally started locally — see `start-jarvis.bat`), open `http://127.0.0.1:3777`, confirm the "💬 Sala" tab appears and clicking it shows an empty pane with the "+ Nueva sala" button (no JS wired yet — that's Task 10, so the button won't do anything and the pane switch relies on the existing generic `goToPane`/tab-click wiring in `app.js`, which already handles any `data-pane` index generically — confirm by checking `document.querySelectorAll('.pane-tab')` picks up 5 tabs and clicking the 5th one switches `#tree-viewport-inner`'s visible pane via the existing swipe/tab CSS).

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat(sala): markup de la pestaña Sala (lista + vista de sala abierta)"
```

---

### Task 10: `public/app.js` — listar salas, abrir una, mandar mensajes, polling

**Files:**
- Modify: `public/app.js` (add room-list rendering + open-room flow + composer send + polling, mirroring the existing Notebooks functions read in this plan's research: `notebookElement`/`renderNotebookList`/`loadNotebookList`/`safeLoadNotebookList`/`openNotebook`/`showNotebookView`)

**Interfaces:**
- Produces: `roomElement(room)`, `renderRoomList()`, `loadRoomList()`, `safeLoadRoomList()`, `openRoom(id, name)`, `loadRoomMessages()`, `sendRoomMessage()`, module-level `rooms = []`, `currentRoom = null`, `roomPollTimer`.

- [ ] **Step 1: Add room-list state and rendering, mirroring the notebook pattern**

In `public/app.js`, near the existing `let notebooks = [];` declaration (search for it, likely near the top with other module-level state), add:

```js
let rooms = [];
let currentRoom = null; // { id, name }
let roomMessages = [];
```

Right after the existing `async function safeLoadNotebookList() { ... }` function, add:

```js
// ── Sala: lista de salas ──
function roomElement(room) {
  const div = document.createElement('div');
  div.className = 'conv notebook-row';
  div.innerHTML = `
    <div class="conv-avatar">${avatarChar(room.name)}</div>
    <div class="conv-body">
      <div class="name"><span class="conv-name-text"></span></div>
      <div class="sub"><span class="conv-date"></span></div>
    </div>
  `;
  div.querySelector('.conv-name-text').textContent = room.name;
  div.querySelector('.conv-date').textContent = room.lastActivity
    ? new Date(room.lastActivity).toLocaleString('es', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : 'Sin mensajes todavía';
  div.onclick = () => openRoom(room.id, room.name);
  return div;
}

function renderRoomList() {
  const nav = $('room-list');
  nav.innerHTML = '';
  if (rooms.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'notes-empty';
    empty.textContent = 'No hay salas todavía — creá una con el botón + de arriba.';
    nav.appendChild(empty);
    return;
  }
  for (const room of rooms) nav.appendChild(roomElement(room));
}

async function loadRoomList() {
  const { rooms: list } = await api('/sala/rooms');
  rooms = list;
  renderRoomList();
}

async function safeLoadRoomList() {
  try { await loadRoomList(); }
  catch { /* noop: polling de fondo, se autocura en el próximo tick */ }
}
```

- [ ] **Step 2: Add open-room + message rendering + send, mirroring `openNotebook`/`showNotebookView`**

Right after the functions from Step 1, add:

```js
// ── Sala: abrir/cerrar una sala, reusando el panel/overlay del chat ──
function showSalaView(show) {
  $('chat-header').hidden = show;
  $('messages-wrap').hidden = show;
  $('composer-attachments').hidden = show;
  $('composer').hidden = show;
  $('sala-view').hidden = !show;
}

function renderRoomMessages() {
  const wrap = $('sala-messages');
  wrap.innerHTML = '';
  for (const m of roomMessages) {
    const div = document.createElement('div');
    div.className = 'note-entry'; // reusa el estilo ya definido para entradas de Notas
    div.innerHTML = `<div class="note-author"></div><div class="note-text"></div>`;
    div.querySelector('.note-author').textContent = m.author;
    div.querySelector('.note-text').textContent = m.text;
    wrap.appendChild(div);
  }
  wrap.scrollTop = wrap.scrollHeight;
}

async function loadRoomMessages() {
  const { messages } = await api(`/sala/rooms/${currentRoom.id}/messages`);
  roomMessages = messages;
  renderRoomMessages();
}

// Refleja si la última llamada a /api/sala/* funcionó — controla el banner
// "sin conexión con la sala" y si se puede mandar un mensaje. Arranca en
// true (optimista) para no mostrar el banner antes de la primera carga.
let salaOnline = true;
function setSalaOnline(online) {
  salaOnline = online;
  $('sala-offline-banner').hidden = online;
  $('sala-send-btn').disabled = !online;
}

async function safeLoadRoomMessages() {
  if (!currentRoom) return;
  try { await loadRoomMessages(); setSalaOnline(true); }
  // Falla silenciosa en el toast (es polling de fondo) pero SÍ actualiza el
  // banner — a diferencia de las notas, acá "no se pudo" bloquea mandar
  // mensajes (mandar sin el contexto de lo que dijeron los demás no tiene
  // sentido, ver spec sección 4).
  catch { setSalaOnline(false); }
}

async function openRoom(id, name) {
  currentRoom = { id, name };
  $('sala-title').textContent = name;
  roomMessages = [];
  renderRoomMessages();
  showSalaView(true);
  openChat();
  try { await loadRoomMessages(); setSalaOnline(true); }
  catch (err) { setSalaOnline(false); toast('No se pudieron cargar los mensajes de la sala: ' + err.message); }
}

async function sendRoomMessage() {
  if (!salaOnline) return; // el botón ya está disabled, pero Enter en el textarea igual dispara este handler
  const input = $('sala-input');
  const text = input.value.trim();
  if (!text || !currentRoom) return;
  input.value = '';
  try {
    await api(`/sala/rooms/${currentRoom.id}/message`, { method: 'POST', body: JSON.stringify({ text }) });
    await loadRoomMessages();
  } catch (err) {
    toast('No se pudo mandar el mensaje: ' + err.message);
    input.value = text; // no perder lo escrito si falló
  }
}
```

- [ ] **Step 3: Wire the buttons and polling**

Near the end of `public/app.js`, alongside the existing `document.querySelectorAll('.pane-tab').forEach(...)` wiring and the existing `let notesPollTimer = setInterval(pollNotesPane, 5000);` (around line 4977), add:

```js
$('new-room-btn').onclick = async () => {
  const name = prompt('Nombre de la sala:');
  if (!name || !name.trim()) return;
  try {
    await api('/sala/rooms', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
    await loadRoomList();
  } catch (err) { toast('No se pudo crear la sala: ' + err.message); }
};

$('sala-back-btn').onclick = () => {
  showSalaView(false);
  currentRoom = null;
  closeChat(); // función existente que ya usa openNotebook/selectConv para volver a la lista
};

$('sala-send-btn').onclick = sendRoomMessage;
$('sala-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendRoomMessage(); }
});

// Mismo intervalo de 5s que ya usa Notas — la sala es texto chico, no hace
// falta el intervalo de 15s de /tree.
setInterval(() => {
  safeLoadRoomList();
  safeLoadRoomMessages();
}, 5000);
```

- [ ] **Step 4: Load the room list when the Sala tab is first opened**

Find the existing tab-click handler (`document.querySelectorAll('.pane-tab').forEach(btn => { ... })`, around line 1499) and confirm it already calls the generic `goToPane(index)` — if pane `4` needs an explicit initial load (same as pane `3`/Notas presumably calls `safeLoadNotebookList()` on first switch), add the equivalent call for pane `4`:

```js
document.querySelectorAll('.pane-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const pane = Number(btn.dataset.pane);
    goToPane(pane);
    if (pane === 3) safeLoadNotebookList();
    if (pane === 4) safeLoadRoomList();
  });
});
```

(Match this to whatever the existing handler actually looks like — if it already has a `if (pane === 3) ...` line for Notas, add the `pane === 4` line right after it instead of rewriting the whole block.)

- [ ] **Step 5: Verify end to end with Playwright, against the real server**

With `sala-jarvis` running locally and this server configured to point at it (Task 7's Step 3 setup), write and run a throwaway Node script using the already-installed Playwright:

```js
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:3777');
  await page.click('.pane-tab[data-pane="4"]');
  await page.click('#new-room-btn');
  await page.on('dialog', d => d.accept('Sala de prueba Playwright'));
  await page.waitForTimeout(1000);
  await page.click('#room-list .conv:first-child');
  await page.fill('#sala-input', 'hola, esto es una prueba');
  await page.click('#sala-send-btn');
  await page.waitForTimeout(15000); // el turno real de Claude tarda unos segundos
  const authors = await page.$$eval('#sala-messages .note-author', els => els.map(e => e.textContent));
  console.log('Autores vistos:', authors);
  await browser.close();
})();
```

Expected console output: `Autores vistos: [ 'Vos', 'J.A.R.V.I.S' ]` (or whatever `getUserName()`/`getAppName()` resolve to on this instance) — confirms the full loop (crear sala → mandar mensaje → Claude corre → respuesta se publica → aparece en el polling) funciona contra el server real. Then run `npm test` (full suite) one more time to confirm the complete feature didn't break any existing test.

- [ ] **Step 6: Commit**

```bash
git add public/app.js
git commit -m "feat(sala): lista de salas, sala abierta, envío de mensajes y polling"
```

---

## Fuera de alcance de este plan (ver spec)

Menciones `@FerStark`/`@Jarvis`, adjuntos en la sala, más de dos instancias/permisos por sala, rastro de herramientas visible para el otro humano, mudar Jarvis completo al VPS. Ninguna tarea de este plan los cubre a propósito.
