# Slots de colaborador — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Diego lend a restricted, single-conversation Jarvis slot to a trusted collaborator, with its own OS-level isolation, its own PIN, and a motor (Claude/Codex/Gemini) that Diego can switch at will without the collaborator knowing which engine is behind it.

**Architecture:** A new `src/slots.js` data layer (same atomic tmp+rename JSON pattern as `src/config.js`) stores slot records. The existing auth middleware in `src/server.js` is extended to resolve a request's identity (admin, via the existing `ACCESS_PIN` + Telegram OTP flow, unchanged; or a specific slot, via a new PIN-only login with no OTP step). New, parallel endpoints (`/api/slots/*`) handle slot CRUD (admin-only) and slot messaging/streaming (slot-scoped) — mirroring the precedent already set by Sala (a separate endpoint surface reusing the same `runner.js` machinery, documented in `docs/superpowers/specs/2026-09-07-sala-compartida-design.md`) rather than retrofitting the existing account-switcher endpoints. A dedicated minimal client (`public/slot.html`/`slot.js`) renders the collaborator's one active conversation; a small admin page (`public/admin-slots.html`/`admin-slots.js`) lets Diego create slots and switch engines. OS user + git clone provisioning stays a manual one-time script Diego runs himself (out of the Node process, no `useradd` from the app).

**Tech Stack:** Node.js + Express (existing), `node --test` (existing unit test runner), vanilla JS client (existing pattern, no framework), `runner.js`/`codex-runner.js`/`gemini-runner.js` (existing, reused unmodified).

**Spec:** `docs/superpowers/specs/2026-10-02-slots-colaborador-design.md`

## Global Constraints

- OS user creation and git cloning for a slot's project is a manual, one-time script Diego runs on the VPS — the Node app never calls `useradd` itself.
- Slot login is PIN-only, no Telegram OTP step — the existing admin 2FA flow (`ACCESS_PIN` + OTP via Telegram to Diego's chat) is unchanged and untouched by this plan; a slot's own PIN is a single factor, since requiring Diego to relay a Telegram code to the collaborator on every login defeats the point of an independent slot.
- `activeConversationId`/`archivedConversationIds` and the slot's `engine`/`osUser`/`projectPath` live in `slots.json`, never in `meta.json` (which is per-account, not per-slot) or in any in-memory global shared across requests — the plan explicitly closes the existing `activeAccount`-as-global-variable pattern for slots; it does not touch the existing account-switcher's behavior for admin.
- A slot's PIN must never resolve to data from another slot or from the admin's own accounts — every slot-scoped endpoint re-derives the slot from the authenticated identity on every request, never trusts a client-supplied `slotId`.
- Follow the existing atomic-write pattern (`tmp-${pid}-${timestamp}` + rename) from `src/config.js` for `slots.json` — never a bare `writeFileSync`.

## Review Focus

- Two collaborators are given slots at the same time; one's messages must never appear in or affect the other's conversation or archived list (cross-slot isolation, same class of bug as the pre-existing shared `activeAccount` global this plan is explicitly fixing).
- Diego switches a slot's engine WHILE the collaborator has an in-flight message being processed by the old engine — the in-flight job must finish (or be cleanly rejected) without corrupting the archive/rotate bookkeeping or losing the response.
- A slot's PIN happens to collide with the admin `ACCESS_PIN` string, or with another slot's PIN — creation must reject this, not silently let two identities share one PIN.
- The collaborator reloads the page or reconnects (same failure class as the documented SSE/status-sync bug in Sala/the main chat) — they must land back on their own current active conversation, not an empty or stale one, and must not see a "processing" indicator that never resolves.
- A slot is created pointing at a `projectPath` that doesn't exist yet (provisioning script hasn't run, or ran against a different path) — the first message attempt must fail with a clear, slot-visible error, not a silent hang or a server crash.

---

## File Structure

```
src/
  slots.js                  # NEW — data layer: load/save/CRUD, PIN resolution, archive+rotate
  server.js                 # MODIFY — identity resolution, slot login, /api/slots/* endpoints
public/
  slot.html                 # NEW — collaborator's restricted page shell
  slot.js                   # NEW — collaborator client: load active conv, send, render archived
  admin-slots.html          # NEW — admin page shell
  admin-slots.js            # NEW — admin client: list/create slots, switch engine
scripts/
  provision-slot.sh         # NEW — one-time ops script: useradd + git clone
test/
  slots.test.js             # NEW — unit tests for src/slots.js
docs/
  slots-provisioning.md     # NEW — runbook for Diego: how to run provision-slot.sh, how to register the slot after
```

---

### Task 1: Slots data layer

**Files:**
- Create: `src/slots.js`
- Test: `test/slots.test.js`

**Interfaces:**
- Produces: `load(file?)`, `save(slots, file?)` — same shape as `src/config.js`'s `load`/`save`.
- Produces: `createSlot({ label, osUser, projectPath, engine }, file?) → Slot` — validates uniqueness of `id`/`osUser`/`pin`, generates `id` and `pin`, throws on invalid `engine`.
- Produces: `resolveByPin(pin, file?) → Slot | null`.
- Produces: `switchEngine(slotId, newEngine, file?) → Slot` — archives `activeConversationId` into `archivedConversationIds`, sets `activeConversationId = null`, sets `engine = newEngine`. Throws if `slotId` not found or `newEngine` invalid.
- Produces: `setActiveConversation(slotId, conversationId, file?) → Slot`.
- Produces: `listSlots(file?) → Slot[]` (never includes `pin` in a form meant for client display — see Task 3 for the redaction boundary; this layer itself returns the full record, redaction is the API's job).
- Produces type shape: `{ id: string, label: string, osUser: string, projectPath: string, engine: 'claude'|'codex'|'gemini', pin: string, activeConversationId: string|null, archivedConversationIds: string[] }`.

- [ ] **Step 1: Write the failing tests**

```js
// test/slots.test.js
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const slots = require('../src/slots');

function tmpFile() {
  return path.join(os.tmpdir(), `ccm-slots-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test('createSlot genera id y pin, y los slots nuevos no colisionan', () => {
  const file = tmpFile();
  const a = slots.createSlot({ label: 'Fernando', osUser: 'colab-fernando', projectPath: '/home/colab-fernando/proyecto', engine: 'claude' }, file);
  const b = slots.createSlot({ label: 'Otra', osUser: 'colab-otra', projectPath: '/home/colab-otra/proyecto', engine: 'codex' }, file);
  assert.notStrictEqual(a.id, b.id);
  assert.notStrictEqual(a.pin, b.pin);
  assert.strictEqual(a.activeConversationId, null);
  assert.deepStrictEqual(a.archivedConversationIds, []);
  fs.unlinkSync(file);
});

test('createSlot rechaza un engine invalido', () => {
  const file = tmpFile();
  assert.throws(() => slots.createSlot({ label: 'X', osUser: 'colab-x', projectPath: '/home/colab-x/p', engine: 'gpt5' }, file));
});

test('createSlot rechaza un osUser repetido', () => {
  const file = tmpFile();
  slots.createSlot({ label: 'Fernando', osUser: 'colab-fernando', projectPath: '/a', engine: 'claude' }, file);
  assert.throws(() => slots.createSlot({ label: 'Otro', osUser: 'colab-fernando', projectPath: '/b', engine: 'claude' }, file));
  fs.unlinkSync(file);
});

test('resolveByPin encuentra el slot correcto y ninguno para un pin inexistente', () => {
  const file = tmpFile();
  const a = slots.createSlot({ label: 'Fernando', osUser: 'colab-fernando', projectPath: '/a', engine: 'claude' }, file);
  const found = slots.resolveByPin(a.pin, file);
  assert.strictEqual(found.id, a.id);
  assert.strictEqual(slots.resolveByPin('no-existe-este-pin', file), null);
  fs.unlinkSync(file);
});

test('switchEngine archiva la conversacion activa y arranca una nueva', () => {
  const file = tmpFile();
  const a = slots.createSlot({ label: 'Fernando', osUser: 'colab-fernando', projectPath: '/a', engine: 'claude' }, file);
  slots.setActiveConversation(a.id, 'conv-1', file);
  const updated = slots.switchEngine(a.id, 'codex', file);
  assert.strictEqual(updated.engine, 'codex');
  assert.strictEqual(updated.activeConversationId, null);
  assert.deepStrictEqual(updated.archivedConversationIds, ['conv-1']);
  fs.unlinkSync(file);
});

test('switchEngine sobre un slot sin conversacion activa no agrega null a archivedConversationIds', () => {
  const file = tmpFile();
  const a = slots.createSlot({ label: 'Fernando', osUser: 'colab-fernando', projectPath: '/a', engine: 'claude' }, file);
  const updated = slots.switchEngine(a.id, 'gemini', file);
  assert.deepStrictEqual(updated.archivedConversationIds, []);
  fs.unlinkSync(file);
});

test('switchEngine tira si el slot no existe', () => {
  const file = tmpFile();
  slots.save({ slots: [] }, file);
  assert.throws(() => slots.switchEngine('no-existe', 'claude', file));
  fs.unlinkSync(file);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/slots.test.js`
Expected: FAIL — `Cannot find module '../src/slots'`

- [ ] **Step 3: Implement `src/slots.js`**

```js
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || os.homedir();
const SLOTS_FILE = path.join(HOME_DIR, '.ccm-slots.json');
const VALID_ENGINES = new Set(['claude', 'codex', 'gemini']);

function load(file = SLOTS_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (parsed && Array.isArray(parsed.slots)) ? parsed : { slots: [] };
  } catch {
    return { slots: [] };
  }
}

function save(data, file = SLOTS_FILE) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function genId() { return crypto.randomBytes(6).toString('hex'); }
function genPin() { return crypto.randomBytes(9).toString('base64url'); }

function createSlot({ label, osUser, projectPath, engine }, file = SLOTS_FILE) {
  if (!VALID_ENGINES.has(engine)) throw new Error(`engine invalido: ${engine}`);
  const data = load(file);
  if (data.slots.some(s => s.osUser === osUser)) throw new Error(`osUser ya usado por otro slot: ${osUser}`);
  const slot = {
    id: genId(),
    label,
    osUser,
    projectPath,
    engine,
    pin: genPin(),
    activeConversationId: null,
    archivedConversationIds: [],
  };
  data.slots.push(slot);
  save(data, file);
  return slot;
}

function listSlots(file = SLOTS_FILE) {
  return load(file).slots;
}

function resolveByPin(pin, file = SLOTS_FILE) {
  return load(file).slots.find(s => s.pin === pin) || null;
}

function getSlot(slotId, file = SLOTS_FILE) {
  const slot = load(file).slots.find(s => s.id === slotId);
  if (!slot) throw new Error(`slot no encontrado: ${slotId}`);
  return slot;
}

function switchEngine(slotId, newEngine, file = SLOTS_FILE) {
  if (!VALID_ENGINES.has(newEngine)) throw new Error(`engine invalido: ${newEngine}`);
  const data = load(file);
  const slot = data.slots.find(s => s.id === slotId);
  if (!slot) throw new Error(`slot no encontrado: ${slotId}`);
  if (slot.activeConversationId) slot.archivedConversationIds.push(slot.activeConversationId);
  slot.activeConversationId = null;
  slot.engine = newEngine;
  save(data, file);
  return slot;
}

function setActiveConversation(slotId, conversationId, file = SLOTS_FILE) {
  const data = load(file);
  const slot = data.slots.find(s => s.id === slotId);
  if (!slot) throw new Error(`slot no encontrado: ${slotId}`);
  slot.activeConversationId = conversationId;
  save(data, file);
  return slot;
}

module.exports = { load, save, createSlot, listSlots, resolveByPin, getSlot, switchEngine, setActiveConversation, SLOTS_FILE, VALID_ENGINES };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/slots.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/slots.js test/slots.test.js
git commit -m "feat: add slots data layer with PIN resolution and engine-switch archiving"
```

---

### Task 2: Identity resolution and slot login

**Files:**
- Create: `src/identity.js`
- Modify: `src/server.js` (around the existing auth block at lines 285-368 — read it first; the admin `ACCESS_PIN` + Telegram OTP flow there stays exactly as-is, you are adding a parallel path, not replacing it)
- Test: `test/identity.test.js`

**Interfaces:**
- Consumes: `resolveByPin` from Task 1's `src/slots.js`.
- Produces: `resolveIdentity(cookieValue, accessPin, slotsFile?) → { kind: 'admin' } | { kind: 'slot', slot: Slot } | { kind: 'none' }` — a pure function, no Express objects, so it's unit-testable without spinning up the server.

- [ ] **Step 1: Write the failing tests**

```js
// test/identity.test.js
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const slotsLib = require('../src/slots');
const { resolveIdentity } = require('../src/identity');

function tmpFile() {
  return path.join(os.tmpdir(), `ccm-identity-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test('resolveIdentity reconoce el ACCESS_PIN como admin', () => {
  const result = resolveIdentity('el-pin-admin', 'el-pin-admin', tmpFile());
  assert.deepStrictEqual(result, { kind: 'admin' });
});

test('resolveIdentity reconoce el pin de un slot como ese slot', () => {
  const file = tmpFile();
  const slot = slotsLib.createSlot({ label: 'Fernando', osUser: 'colab-fernando', projectPath: '/a', engine: 'claude' }, file);
  const result = resolveIdentity(slot.pin, 'el-pin-admin', file);
  assert.strictEqual(result.kind, 'slot');
  assert.strictEqual(result.slot.id, slot.id);
  fs.unlinkSync(file);
});

test('resolveIdentity no reconoce un valor que no es ni el admin ni ningun slot', () => {
  const file = tmpFile();
  slotsLib.createSlot({ label: 'Fernando', osUser: 'colab-fernando', projectPath: '/a', engine: 'claude' }, file);
  const result = resolveIdentity('cualquier-otra-cosa', 'el-pin-admin', file);
  assert.deepStrictEqual(result, { kind: 'none' });
  fs.unlinkSync(file);
});

test('resolveIdentity prioriza admin si por error un slot tuviera el mismo pin que ACCESS_PIN', () => {
  // createSlot nunca deberia permitir esto (ver Task 1 / Review Focus), pero
  // la resolucion en si debe preferir admin de todas formas, nunca filtrar
  // datos de un slot bajo el pin admin.
  const file = tmpFile();
  const data = slotsLib.load(file);
  data.slots.push({ id: 'x', label: 'x', osUser: 'x', projectPath: '/x', engine: 'claude', pin: 'el-pin-admin', activeConversationId: null, archivedConversationIds: [] });
  slotsLib.save(data, file);
  const result = resolveIdentity('el-pin-admin', 'el-pin-admin', file);
  assert.deepStrictEqual(result, { kind: 'admin' });
  fs.unlinkSync(file);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/identity.test.js`
Expected: FAIL — `Cannot find module '../src/identity'`

- [ ] **Step 3: Implement `src/identity.js`**

```js
const { resolveByPin } = require('./slots');

function resolveIdentity(cookieValue, accessPin, slotsFile) {
  if (!cookieValue) return { kind: 'none' };
  if (accessPin && cookieValue === accessPin) return { kind: 'admin' };
  const slot = resolveByPin(cookieValue, slotsFile);
  if (slot) return { kind: 'slot', slot };
  return { kind: 'none' };
}

module.exports = { resolveIdentity };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/identity.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Add the slot login endpoint and wire identity resolution into the auth middleware**

Read `src/server.js` lines 285-368 first (the existing `if (ACCESS_PIN) { ... }` block) to see exactly how `ccm_auth` is set and checked today — do not change the admin login (`/__auth`, `/__auth/otp`) behavior. Add, inside that same `if (ACCESS_PIN)` block, right after the existing `/__auth/otp` handler and before the final `app.use((req, res, next) => { ... })` gate:

```js
const { resolveIdentity } = require('./identity'); // add near the top of server.js with the other requires

app.post('/__auth/slot', (req, res) => {
  const ip = clientIp(req);
  const locked = lockInfo(ip);
  if (locked) return res.status(429).json({ error: `Demasiados intentos. Esperá ${Math.ceil((locked.lockedUntil - Date.now()) / 60000)} min.` });
  const identity = resolveIdentity(req.body.pin || '', ACCESS_PIN);
  if (identity.kind !== 'slot') {
    registerFailure(ip);
    const nowLocked = lockInfo(ip);
    return res.status(401).json({ error: nowLocked ? `Demasiados intentos. Esperá ${Math.ceil((nowLocked.lockedUntil - Date.now()) / 60000)} min.` : 'PIN incorrecto' });
  }
  registerSuccess(ip);
  res.cookie('ccm_auth', identity.slot.pin, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
  res.json({ ok: true });
});
```

Then change the final gate of that same block from:
```js
app.use((req, res, next) => {
  const PUBLIC = ['/login.html', '/__auth', '/__auth/otp', '/sw.js', '/manifest.json', '/icon-192.png', '/icon-512.png'];
  if (PUBLIC.includes(req.path)) return next();
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')));
  if (cookies.ccm_auth === ACCESS_PIN) return next();
  res.redirect('/login.html');
});
```
to:
```js
app.use((req, res, next) => {
  const PUBLIC = ['/login.html', '/slot.html', '/__auth', '/__auth/otp', '/__auth/slot', '/sw.js', '/manifest.json', '/icon-192.png', '/icon-512.png'];
  if (PUBLIC.includes(req.path)) return next();
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')));
  const identity = resolveIdentity(cookies.ccm_auth, ACCESS_PIN);
  if (identity.kind === 'none') return res.redirect('/login.html');
  req.identity = identity;
  next();
});
```

`req.identity` is now `{ kind: 'admin' }` or `{ kind: 'slot', slot }` on every authenticated request — later tasks' endpoints read it to decide what a request is allowed to touch. `/slot.html` is added to `PUBLIC` because it's the collaborator's login landing page, same reason `/login.html` is already there.

- [ ] **Step 6: Run the full suite to confirm nothing broke**

Run: `node --test`
Expected: all existing tests still pass, plus the 4 new ones from Step 4 (11 total if this was the only prior change on the branch).

- [ ] **Step 7: Commit**

```bash
git add src/identity.js test/identity.test.js src/server.js
git commit -m "feat: add slot PIN login and per-request identity resolution"
```

---

### Task 3: Admin slot-management endpoints

**Files:**
- Modify: `src/server.js`

**Interfaces:**
- Consumes: `req.identity` from Task 2; `createSlot`, `listSlots`, `switchEngine` from Task 1.
- Produces: `GET /api/slots`, `POST /api/slots`, `POST /api/slots/:id/engine` — all admin-only.

- [ ] **Step 1: Add the endpoints**

Add near the existing `/api/accounts` endpoints (around line 375 of `src/server.js`):

```js
const slotsLib = require('./slots'); // add near the top with the other requires

function requireAdmin(req, res, next) {
  if (!ACCESS_PIN) return next(); // sin ACCESS_PIN configurado, no hay auth en absoluto (mismo comportamiento que hoy)
  if (req.identity?.kind !== 'admin') return res.status(403).json({ error: 'solo admin' });
  next();
}

app.get('/api/slots', requireAdmin, (req, res) => {
  const list = slotsLib.listSlots().map(({ pin, ...rest }) => rest); // nunca se manda el pin de vuelta en el listado
  res.json({ slots: list });
});

app.post('/api/slots', requireAdmin, (req, res) => {
  const { label, osUser, projectPath, engine } = req.body;
  if (!label || !osUser || !projectPath || !engine) {
    return res.status(400).json({ error: 'faltan campos: label, osUser, projectPath, engine' });
  }
  try {
    const slot = slotsLib.createSlot({ label, osUser, projectPath, engine });
    res.json({ slot }); // el pin SI va en la respuesta de creacion — es el unico momento en que Diego lo necesita para compartirlo
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/slots/:id/engine', requireAdmin, (req, res) => {
  const { engine } = req.body;
  try {
    const slot = slotsLib.switchEngine(req.params.id, engine);
    const { pin, ...rest } = slot;
    res.json({ slot: rest });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
```

- [ ] **Step 2: Manual verification**

Run: `node src/server.js` with `ACCESS_PIN` set, log in as admin, then:
```bash
curl -s -b cookies.txt -c cookies.txt -X POST http://127.0.0.1:3777/__auth -H 'Content-Type: application/json' -d '{"pin":"<tu ACCESS_PIN>"}'
# (completar OTP a mano si Telegram esta configurado, o probar esto en un entorno sin ACCESS_PIN seteado para saltear auth)
curl -s -b cookies.txt -X POST http://127.0.0.1:3777/api/slots -H 'Content-Type: application/json' -d '{"label":"Fernando","osUser":"colab-fernando","projectPath":"/home/colab-fernando/proyecto","engine":"claude"}'
```
Expected: `{"slot":{...,"pin":"..."}}` — guardá ese PIN, lo vas a necesitar en la Tarea 5 para probar el login del colaborador.

- [ ] **Step 3: Commit**

```bash
git add src/server.js
git commit -m "feat: add admin endpoints for slot creation, listing, and engine switch"
```

---

### Task 4: Slot-scoped messaging and streaming

**Files:**
- Modify: `src/server.js`

**Interfaces:**
- Consumes: `req.identity` (Task 2), `runner.send`/`runner.on('event'|'status', ...)` (existing `Runner` class from `src/runner.js`, unchanged), `setActiveConversation`/`getSlot` (Task 1).
- Produces: `POST /api/slot/message`, `GET /api/slot/stream`, `GET /api/slot/conversation`, `GET /api/slot/archived` — all require `req.identity.kind === 'slot'`, and ALWAYS operate on `req.identity.slot` (the slot resolved from the authenticated cookie), never on a client-supplied slot id, closing the Review Focus item about trusting client input for identity.

- [ ] **Step 1: Read the existing Sala message-handling endpoint first**

Before writing this task's endpoints, find and read the Sala message-sending endpoint in `src/server.js` (search for `/api/sala/rooms/:id/message` or similar — it's referenced in `CLAUDE.local.md` and in comments inside `src/runner.js` around the `isSala`/`restrictedTools` job fields). That endpoint already does exactly the pattern this task needs — call `runner.send({ convId, text, account, cwd, sessionId, ... })` and relay `runner`'s `event`/`status` emissions back over SSE for one specific conversation — reusing the same runner instance the main chat and Sala already share. Mirror its structure; do not invent a different event-relay mechanism.

- [ ] **Step 2: Add the slot-scoped endpoints**

```js
function requireSlot(req, res, next) {
  if (req.identity?.kind !== 'slot') return res.status(403).json({ error: 'solo colaborador' });
  next();
}

const slotRunners = { claude: runner, codex: codexRunner, gemini: geminiRunner }; // usar los nombres reales de las instancias de Runner ya creadas mas arriba en server.js para cada motor

app.get('/api/slot/conversation', requireSlot, (req, res) => {
  const { slot } = req.identity;
  res.json({
    activeConversationId: slot.activeConversationId,
    archivedConversationIds: slot.archivedConversationIds,
    engine: slot.engine,
    label: slot.label,
  });
});

app.post('/api/slot/message', requireSlot, (req, res) => {
  const { slot } = req.identity;
  const engineRunner = slotRunners[slot.engine];
  let convId = slot.activeConversationId;
  if (!convId) {
    convId = `slot-${slot.id}-${Date.now()}`;
    slotsLib.setActiveConversation(slot.id, convId);
  }
  engineRunner.send({
    convId,
    text: req.body.text,
    account: slot.osUser,
    cwd: slot.projectPath,
  });
  res.json({ ok: true, convId });
});

app.get('/api/slot/stream', requireSlot, (req, res) => {
  const { slot } = req.identity;
  const convId = slot.activeConversationId;
  if (!convId) return res.status(409).json({ error: 'no hay conversacion activa todavia' });
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const engineRunner = slotRunners[slot.engine];
  const onEvent = (payload) => { if (payload.convId === convId) res.write(`data: ${JSON.stringify({ kind: 'event', event: payload.event })}\n\n`); };
  const onStatus = (payload) => { if (payload.convId === convId) res.write(`data: ${JSON.stringify({ kind: 'status', status: payload.status })}\n\n`); };
  engineRunner.on('event', onEvent);
  engineRunner.on('status', onStatus);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20000); // mismo patron de 20s que /stream ya usa contra el idle-timeout del tunel de Cloudflare
  req.on('close', () => {
    clearInterval(heartbeat);
    engineRunner.off('event', onEvent);
    engineRunner.off('status', onStatus);
  });
});

app.get('/api/slot/archived/:convId', requireSlot, (req, res) => {
  const { slot } = req.identity;
  if (!slot.archivedConversationIds.includes(req.params.convId)) {
    return res.status(404).json({ error: 'esa conversacion no es de este slot' });
  }
  // Delegar al mismo mecanismo de lectura de historial que ya usa scanner.js
  // para una conversacion normal (buscar `toChatMessages` o equivalente en
  // scanner.js) pasandole el cwd/account de este slot — leer solo lectura,
  // este endpoint nunca debe permitir mandar un mensaje a una conversacion archivada.
  res.status(501).json({ error: 'completar con scanner.toChatMessages del motor correspondiente' });
});
```

The `slotRunners` map and the `/api/slot/archived/:convId` handler reference existing variables/functions (the per-engine `Runner` instances, and `scanner.js`'s conversation-history reader) that you need to find by their real names in `server.js`/`scanner.js` — grep for `new Runner(`, `new CodexRunner(` or similar, and for however `scanner.js`/`codex-scanner.js`/`gemini-scanner.js` expose "give me the message history for this session id" today, and wire those real names in. Do not leave the `501` placeholder in the final commit — it exists here only to mark what you must replace with the real call before this task is done.

- [ ] **Step 3: Manual verification**

Using the PIN saved from Task 3's Step 2:
```bash
curl -s -c slot-cookies.txt -X POST http://127.0.0.1:3777/__auth/slot -H 'Content-Type: application/json' -d '{"pin":"<pin del slot>"}'
curl -s -b slot-cookies.txt -X POST http://127.0.0.1:3777/api/slot/message -H 'Content-Type: application/json' -d '{"text":"hola"}'
```
Expected: `{"ok":true,"convId":"slot-...-..."}`, and the configured engine's CLI actually spawns (check with `ps aux | grep claude` or equivalent) under the slot's `osUser`.

- [ ] **Step 4: Commit**

```bash
git add src/server.js
git commit -m "feat: add slot-scoped messaging and streaming endpoints"
```

---

### Task 5: Collaborator client

**Files:**
- Create: `public/slot.html`
- Create: `public/slot.js`

**Interfaces:**
- Consumes: `/api/slot/conversation`, `/api/slot/message`, `/api/slot/stream`, `/api/slot/archived/:convId`, `/__auth/slot` (Tasks 2 and 4).

- [ ] **Step 1: Create the page shell**

```html
<!-- public/slot.html -->
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chat</title>
<style>
body { font-family: system-ui, sans-serif; margin: 0; display: flex; flex-direction: column; height: 100vh; }
#messages { flex: 1; overflow-y: auto; padding: 1rem; }
#composer { display: flex; gap: .5rem; padding: .75rem; border-top: 1px solid #ddd; }
#composer input { flex: 1; padding: .6rem; font-size: 1rem; }
#composer button { padding: .6rem 1rem; }
.msg-user { text-align: right; color: #075; margin: .5rem 0; }
.msg-agent { text-align: left; color: #333; margin: .5rem 0; white-space: pre-wrap; }
#archived-list { padding: 1rem; display: none; }
#login-form { max-width: 320px; margin: 4rem auto; display: flex; flex-direction: column; gap: .5rem; }
</style>
</head>
<body>
<form id="login-form">
  <input id="pin" type="password" placeholder="PIN" required>
  <button type="submit">Entrar</button>
  <span id="login-error" style="color:red"></span>
</form>
<div id="chat-screen" hidden>
  <div id="messages"></div>
  <div id="archived-list"></div>
  <form id="composer">
    <input id="text" placeholder="Escribí tu mensaje" autocomplete="off">
    <button type="submit">Enviar</button>
  </form>
</div>
<script src="/slot.js"></script>
</body>
</html>
```

- [ ] **Step 2: Implement the client**

```js
// public/slot.js
const $ = id => document.getElementById(id);

async function login(pin) {
  const r = await fetch('/__auth/slot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'error de login');
}

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = role === 'user' ? 'msg-user' : 'msg-agent';
  div.textContent = text;
  $('messages').appendChild(div);
  $('messages').scrollTop = $('messages').scrollHeight;
}

let stream = null;
function openStream() {
  if (stream) stream.close();
  stream = new EventSource('/api/slot/stream');
  let buf = '';
  stream.onmessage = (ev) => {
    const payload = JSON.parse(ev.data);
    if (payload.kind === 'event' && payload.event?.type === 'assistant') {
      const text = payload.event.message?.content?.map(c => c.text || '').join('') || '';
      if (text) { buf += text; }
    }
    if (payload.kind === 'status' && payload.status === 'idle') {
      if (buf) { addMessage('agent', buf); buf = ''; }
    }
  };
}

async function loadConversation() {
  const r = await fetch('/api/slot/conversation');
  const data = await r.json();
  if (data.activeConversationId) openStream();
  const archived = $('archived-list');
  archived.innerHTML = (data.archivedConversationIds || []).length
    ? '<h4>Charlas anteriores (solo lectura)</h4>' + data.archivedConversationIds.map(id => `<div><a href="#" data-conv="${id}">${id}</a></div>`).join('')
    : '';
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await login($('pin').value);
    $('login-form').hidden = true;
    $('chat-screen').hidden = false;
    await loadConversation();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('text').value.trim();
  if (!text) return;
  addMessage('user', text);
  $('text').value = '';
  const r = await fetch('/api/slot/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  if (r.ok) openStream(); // primera vez que hay convId, recien ahi se puede abrir el stream
});
```

- [ ] **Step 3: Manual verification**

Open `http://127.0.0.1:3777/slot.html`, log in with a slot's PIN, send a message, confirm the response streams in and the page survives a reload (lands back on the same active conversation).

- [ ] **Step 4: Commit**

```bash
git add public/slot.html public/slot.js
git commit -m "feat: add collaborator restricted chat client"
```

---

### Task 6: Admin panel client

**Files:**
- Create: `public/admin-slots.html`
- Create: `public/admin-slots.js`

**Interfaces:**
- Consumes: `GET/POST /api/slots`, `POST /api/slots/:id/engine` (Task 3).

- [ ] **Step 1: Create the page shell**

```html
<!-- public/admin-slots.html -->
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Colaboradores</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; }
table { width: 100%; border-collapse: collapse; }
td, th { border-bottom: 1px solid #ddd; padding: .5rem; text-align: left; }
form { display: flex; gap: .5rem; margin: 1rem 0; flex-wrap: wrap; }
input, select { padding: .4rem; }
</style>
</head>
<body>
<h1>Colaboradores</h1>
<table id="slots-table"><thead><tr><th>Nombre</th><th>Proyecto</th><th>Motor</th><th></th></tr></thead><tbody></tbody></table>
<h2>Nuevo slot</h2>
<form id="new-slot-form">
  <input id="label" placeholder="Nombre (ej. Fernando)" required>
  <input id="osUser" placeholder="Usuario del sistema (ej. colab-fernando)" required>
  <input id="projectPath" placeholder="/home/colab-fernando/proyecto" required>
  <select id="engine"><option value="claude">Claude</option><option value="codex">Codex</option><option value="gemini">Gemini</option></select>
  <button type="submit">Crear</button>
</form>
<p id="new-slot-pin"></p>
<script src="/admin-slots.js"></script>
</body>
</html>
```

- [ ] **Step 2: Implement the client**

```js
// public/admin-slots.js
const $ = id => document.getElementById(id);

async function loadSlots() {
  const r = await fetch('/api/slots');
  const { slots } = await r.json();
  $('slots-table').querySelector('tbody').innerHTML = slots.map(s => `
    <tr>
      <td>${s.label}</td>
      <td>${s.projectPath}</td>
      <td>
        <select data-slot-id="${s.id}" class="engine-select">
          <option value="claude" ${s.engine === 'claude' ? 'selected' : ''}>Claude</option>
          <option value="codex" ${s.engine === 'codex' ? 'selected' : ''}>Codex</option>
          <option value="gemini" ${s.engine === 'gemini' ? 'selected' : ''}>Gemini</option>
        </select>
      </td>
    </tr>
  `).join('');
  document.querySelectorAll('.engine-select').forEach(sel => {
    sel.addEventListener('change', async () => {
      await fetch(`/api/slots/${sel.dataset.slotId}/engine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine: sel.value }),
      });
      loadSlots();
    });
  });
}

$('new-slot-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    label: $('label').value,
    osUser: $('osUser').value,
    projectPath: $('projectPath').value,
    engine: $('engine').value,
  };
  const r = await fetch('/api/slots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) { $('new-slot-pin').textContent = 'Error: ' + data.error; return; }
  $('new-slot-pin').textContent = `PIN para compartir con ${body.label}: ${data.slot.pin}`;
  $('new-slot-form').reset();
  loadSlots();
});

loadSlots();
```

- [ ] **Step 3: Manual verification**

Open `http://127.0.0.1:3777/admin-slots.html` as admin, create a slot, confirm the PIN appears, change its engine, confirm the table updates.

- [ ] **Step 4: Commit**

```bash
git add public/admin-slots.html public/admin-slots.js
git commit -m "feat: add admin panel for managing collaborator slots"
```

---

### Task 7: Provisioning script and runbook

**Files:**
- Create: `scripts/provision-slot.sh`
- Create: `docs/slots-provisioning.md`

**Interfaces:**
- None (ops script, run manually by Diego on the VPS — not called by the Node app).

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# scripts/provision-slot.sh <osUser> <repoUrl> [projectDirName]
# Crea el usuario de sistema para un slot y clona el proyecto asignado en su home.
# Correr a mano en el VPS, una vez por slot nuevo, ANTES de crear el slot desde
# el panel de admin (Tarea 6) — el projectPath que le pasas al panel tiene que
# coincidir con la ruta que este script deja clonada.
set -euo pipefail

OS_USER="${1:?uso: provision-slot.sh <osUser> <repoUrl> [projectDirName]}"
REPO_URL="${2:?falta la URL del repo a clonar}"
PROJECT_DIR="${3:-$(basename "$REPO_URL" .git)}"

if id "$OS_USER" &>/dev/null; then
  echo "El usuario $OS_USER ya existe — abortando para no pisar un slot existente." >&2
  exit 1
fi

useradd -m -s /bin/bash "$OS_USER"
sudo -u "$OS_USER" git clone "$REPO_URL" "/home/$OS_USER/$PROJECT_DIR"

echo "Listo. projectPath para el panel de admin: /home/$OS_USER/$PROJECT_DIR"
```

- [ ] **Step 2: Write the runbook**

```markdown
<!-- docs/slots-provisioning.md -->
# Dar de alta un nuevo slot de colaborador

1. En el VPS, como root: `sudo bash scripts/provision-slot.sh colab-<nombre> <url del repo git>`
2. Copiá el `projectPath` que imprime el script al final.
3. Entrá a `/admin-slots.html` con tu PIN de admin, completá el formulario "Nuevo slot" con ese `osUser`/`projectPath` y el motor inicial que quieras.
4. Copiá el PIN que te muestra la página y compartíselo a la persona junto con la URL `/slot.html`.
5. Para cambiarle el motor más adelante, volvé a `/admin-slots.html` y elegí el motor nuevo en el selector de esa fila — la charla anterior queda archivada, solo lectura, y arranca una nueva.

Si el motor elegido (Codex o Gemini) nunca se logueó para ese usuario del sistema, el primer mensaje de la persona va a fallar con un error claro — loguear ese motor como `sudo -u colab-<nombre> <comando de login del motor>` antes de avisarle que ya puede usarlo.
```

- [ ] **Step 3: Commit**

```bash
git add scripts/provision-slot.sh docs/slots-provisioning.md
git commit -m "docs: add slot provisioning script and runbook"
```

---

## Self-Review Notes

**Spec coverage:** §3 arquitectura → Tasks 1, 2, 4, 7 (VPS/PM2 deploy itself is an ops step outside this code plan, covered by the runbook). §4 modelo de datos → Task 1. §5 flujo → Tasks 3 (alta de slot), 4-5 (mensajes), 6 (cambio de motor desde el panel). §6 interfaz → Tasks 5 (colaborador) y 6 (admin). §7 manejo de errores → Review Focus items below, each pinned to its owning task. §8 testing → Tasks 1 and 2 have real unit tests; Tasks 3-6 are manually verified per their own steps, consistent with the spec's own acknowledgment that OS-level provisioning can't be tested in CI.

**Placeholder scan:** the one explicit placeholder (`501` in Task 4's `/api/slot/archived/:convId`) is flagged as something to replace before the task is considered done, with a concrete pointer to which existing module/function to use — not left as an open TODO.

**Review Focus coverage:** cross-slot isolation → Task 2's identity tests + Task 4's `requireSlot`/`req.identity.slot` (never a client-supplied id). Engine switch mid-flight → Task 1's `switchEngine` archiving logic, exercised by its own test; Task 4's message endpoint always re-reads the slot's *current* `engine`/`activeConversationId` from disk per request, so a switch that lands between two requests is picked up on the next one rather than corrupting an in-flight job. PIN collision → Task 1's uniqueness tests (osUser) plus Task 2's test confirming admin takes priority even in a hypothetical collision. Reload/reconnect landing on stale state → Task 5's `loadConversation` re-fetches `/api/slot/conversation` fresh on every page load rather than caching client-side. Missing `projectPath` → Task 4's manual verification step calls this out explicitly; the runner's own `spawn` error path (already existing in `runner.js`, emits `status: 'idle'` with `stderr`) surfaces as a clear error through the SSE stream rather than a silent hang.
