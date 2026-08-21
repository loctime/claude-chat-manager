# Limpieza de sesiones Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pantalla nueva "Sesiones" que lista todas las sesiones de `~/.claude/projects` de la cuenta activa (incluidas las hoy invisibles: canal/MCP y vacías), las clasifica, protege las importantes/recientes/activas, y permite borrarlas de verdad del disco en bloque.

**Architecture:** Toda la lógica de clasificación/protección/borrado vive en `src/scanner.js` como funciones puras y testeables (mismo patrón que `rewindSessionFile`); `src/server.js` solo expone dos endpoints delgados que llaman a esas funciones y persisten `meta.json`. El frontend suma un 5º pane al carrusel existente (Chats/Archivado/Notas/Escáner/**Sesiones**) con un archivo nuevo `public/sessions-cleanup.js`, cargado como `<script>` clásico después de `app.js` — mismo patrón que `search.js`/`doc-scanner.js`.

**Tech Stack:** Node.js + Express 5, `node:test` para unitarios, vanilla JS/CSS/HTML en el frontend (sin bundler), Playwright para e2e existente.

**Spec:** `docs/superpowers/specs/2026-08-20-limpieza-sesiones-design.md`

## Global Constraints

- No se modifica el comportamiento de `scanner.listSessions()`/`sessionInfo()` — los sigue usando el chat en vivo tal cual. Todo lo nuevo va en funciones aparte.
- Borrado permanente e inmediato tras confirmar — sin papelera ni soft-delete.
- La protección (`archived`/`pinned`/`running`/`recent` — últimos 5 días) se recalcula siempre server-side, nunca se confía en lo que mandó el cliente.
- Alcance de una sola cuenta de Windows por instancia — sin lectura/escritura cross-cuenta.
- Los endpoints nuevos quedan cubiertos por el mismo middleware `ACCESS_PIN` que ya protege el resto de `/api/*` (se logran gratis por estar definidos después de ese middleware en `server.js`, no hace falta código extra).
- Frontend sin ES modules ni bundler: `<script>` clásico, mismo scope global que ya comparten `app.js`/`search.js`/etc.

---

### Task 1: `scanner.js` — clasificación y protección (funciones puras)

**Files:**
- Modify: `src/scanner.js`
- Test: `test/cleanup.test.js` (nuevo)

**Interfaces:**
- Consumes: nada nuevo — usa `parseJsonl`, `contentToText`, `isChannelSession`, `_sessionCwd` que ya existen en el módulo.
- Produces (para Task 2):
  - `listForCleanup(projectsDir): Array<{sessionId, filePath, sizeBytes, cwd, messageCount, lastActivity, isChannel, snippet}>`
  - `classifySession(s, { referencedAsApp: boolean }): 'channel'|'app'|'trivial'|'orphan'`
  - `isProtectedSession(s, { conv, running, now }): { protected: boolean, reason: string|null }` — `s` solo necesita `.lastActivity`; `reason` es uno de `'archived'|'pinned'|'running'|'recent'|null`.
  - `RECENT_PROTECTION_MS` (constante exportada, = 5 días en ms) — para que el test pueda calcular el borde exacto sin hardcodear el número dos veces.

- [ ] **Step 1: Escribir los tests que fallan**

Crear `test/cleanup.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  listForCleanup, classifySession, isProtectedSession, RECENT_PROTECTION_MS,
} = require('../src/scanner');

function tmpProjectsDir() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-cleanup-'));
  const dir = path.join(base, '-home-x-demo');
  fs.mkdirSync(dir);
  return dir;
}

function writeSession(dir, id, lines) {
  fs.writeFileSync(path.join(dir, id + '.jsonl'), lines.join('\n'));
}

const userMsg = (text) => JSON.stringify({
  type: 'user', cwd: '/home/x/demo',
  timestamp: '2026-08-01T10:00:00.000Z', message: { role: 'user', content: text },
});
const assistantMsg = (text) => JSON.stringify({
  type: 'assistant', cwd: '/home/x/demo',
  timestamp: '2026-08-01T10:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const channelMsg = () => JSON.stringify({
  type: 'assistant', cwd: '/home/x/demo',
  timestamp: '2026-08-01T10:00:05.000Z',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'mcp__plugin_x__algo', input: {} }] },
});

test('listForCleanup incluye sesiones de canal y vacías (a diferencia de listSessions)', () => {
  const dir = tmpProjectsDir();
  writeSession(dir, 'canal-1', [userMsg('hola'), channelMsg()]);
  writeSession(dir, 'vacia-1', ['{"type":"summary","summary":"x"}']);
  writeSession(dir, 'normal-1', [userMsg('arreglame el login'), assistantMsg('dale')]);
  const out = listForCleanup(path.dirname(dir));
  const ids = out.map(s => s.sessionId).sort();
  assert.deepEqual(ids, ['canal-1', 'normal-1', 'vacia-1']);
  const canal = out.find(s => s.sessionId === 'canal-1');
  assert.equal(canal.isChannel, true);
  const normal = out.find(s => s.sessionId === 'normal-1');
  assert.equal(normal.isChannel, false);
  assert.equal(normal.messageCount, 2);
  assert.ok(normal.sizeBytes > 0);
});

test('classifySession: prioridad channel > app > trivial > orphan', () => {
  assert.equal(classifySession({ isChannel: true, messageCount: 10 }, { referencedAsApp: true }), 'channel');
  assert.equal(classifySession({ isChannel: false, messageCount: 10 }, { referencedAsApp: true }), 'app');
  assert.equal(classifySession({ isChannel: false, messageCount: 2 }, { referencedAsApp: false }), 'trivial');
  assert.equal(classifySession({ isChannel: false, messageCount: 3 }, { referencedAsApp: false }), 'orphan');
});

test('isProtectedSession: pinned/archived ganan aunque no esté corriendo ni sea reciente', () => {
  const vieja = { lastActivity: '2020-01-01T00:00:00.000Z' };
  const r1 = isProtectedSession(vieja, { conv: { archived: true }, running: false, now: Date.parse('2026-08-20') });
  assert.deepEqual(r1, { protected: true, reason: 'archived' });
  const r2 = isProtectedSession(vieja, { conv: { pinned: true }, running: false, now: Date.parse('2026-08-20') });
  assert.deepEqual(r2, { protected: true, reason: 'pinned' });
});

test('isProtectedSession: activa protege aunque sea vieja y sin conv', () => {
  const vieja = { lastActivity: '2020-01-01T00:00:00.000Z' };
  const r = isProtectedSession(vieja, { conv: null, running: true, now: Date.parse('2026-08-20') });
  assert.deepEqual(r, { protected: true, reason: 'running' });
});

test('isProtectedSession: frontera exacta de 5 días', () => {
  const now = Date.parse('2026-08-20T00:00:00.000Z');
  const justoAdentro = new Date(now - (RECENT_PROTECTION_MS - 1)).toISOString();
  const justoAfuera = new Date(now - RECENT_PROTECTION_MS).toISOString();
  assert.equal(isProtectedSession({ lastActivity: justoAdentro }, { conv: null, running: false, now }).protected, true);
  assert.equal(isProtectedSession({ lastActivity: justoAfuera }, { conv: null, running: false, now }).protected, false);
});

test('isProtectedSession: sin conv, sin running, vieja -> no protegida', () => {
  const r = isProtectedSession({ lastActivity: '2020-01-01T00:00:00.000Z' }, { conv: null, running: false, now: Date.parse('2026-08-20') });
  assert.deepEqual(r, { protected: false, reason: null });
});
```

- [ ] **Step 2: Correr los tests y confirmar que fallan**

Run: `npm test -- --test-name-pattern="listForCleanup|classifySession|isProtectedSession"` (o `node --test test/cleanup.test.js`)
Expected: FAIL — `listForCleanup is not a function` (todavía no existe en `scanner.js`).

- [ ] **Step 3: Implementar en `src/scanner.js`**

Agregar, cerca de `rewindSessionFile` (antes del `module.exports` final):

```js
// ── Limpieza de sesiones ──
// Funciones puras y testeables aparte de listSessions()/sessionInfo(): esas dos
// las usa el chat en vivo (con su cache por mtime) y descartan sesiones de canal
// y vacías a propósito — acá necesitamos justo lo contrario, verlas todas, así
// que se reimplementa un recorrido chico en vez de meterle un flag "includeAll"
// al camino cacheado (evita arriesgar ese cache por una pantalla de mantenimiento).

const RECENT_PROTECTION_MS = 5 * 24 * 60 * 60 * 1000; // 5 días

function listForCleanup(projectsDir = PROJECTS_DIR) {
  let dirs;
  try { dirs = fs.readdirSync(projectsDir); } catch { return []; }
  const out = [];
  for (const d of dirs) {
    const dirPath = path.join(projectsDir, d);
    let files;
    try { files = fs.readdirSync(dirPath); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const filePath = path.join(dirPath, f);
      let stat;
      try { stat = fs.statSync(filePath); } catch { continue; }
      const entries = parseJsonl(filePath);
      const isChannel = isChannelSession(entries);
      const msgs = entries.filter(e => (e.type === 'user' || e.type === 'assistant') && e.message && !e.isMeta);
      const firstUser = msgs.find(e => e.type === 'user' && contentToText(e.message.content).trim());
      const snippet = firstUser ? contentToText(firstUser.message.content).trim().slice(0, 60) : '(sin mensajes)';
      const last = entries[entries.length - 1];
      let lastActivity = last && last.timestamp;
      if (!lastActivity) lastActivity = stat.mtime.toISOString();
      out.push({
        sessionId: path.basename(f, '.jsonl'),
        filePath,
        sizeBytes: stat.size,
        cwd: _sessionCwd(filePath, entries),
        messageCount: msgs.length,
        lastActivity,
        isChannel,
        snippet,
      });
    }
  }
  return out;
}

function classifySession(s, { referencedAsApp }) {
  if (s.isChannel) return 'channel';
  if (referencedAsApp) return 'app';
  if (s.messageCount <= 2) return 'trivial';
  return 'orphan';
}

function isProtectedSession(s, { conv, running, now = Date.now() } = {}) {
  if (conv && conv.archived) return { protected: true, reason: 'archived' };
  if (conv && conv.pinned) return { protected: true, reason: 'pinned' };
  if (running) return { protected: true, reason: 'running' };
  const activityMs = s.lastActivity ? new Date(s.lastActivity).getTime() : NaN;
  if (!Number.isNaN(activityMs) && (now - activityMs) < RECENT_PROTECTION_MS) {
    return { protected: true, reason: 'recent' };
  }
  return { protected: false, reason: null };
}
```

Sumar al `module.exports` existente: `listForCleanup, classifySession, isProtectedSession, RECENT_PROTECTION_MS,`.

- [ ] **Step 4: Correr los tests y confirmar que pasan**

Run: `node --test test/cleanup.test.js`
Expected: PASS (7/7).

- [ ] **Step 5: Commit**

```bash
git add src/scanner.js test/cleanup.test.js
git commit -m "feat(cleanup): clasificación y protección de sesiones en scanner.js

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `scanner.js` — armar el reporte y ejecutar el borrado

**Files:**
- Modify: `src/scanner.js`
- Test: `test/cleanup.test.js`

**Interfaces:**
- Consumes: `listForCleanup`, `classifySession`, `isProtectedSession`, `findSessionFile`, `sessionInfo` (Task 1 y ya existentes).
- Produces (para Task 3):
  - `buildCleanupReport(projectsDir, conversations, isRunningFn = () => false): { sessions: Array<{sessionId, cwd, snippet, sizeBytes, messageCount, lastActivity, classification, convId, name, pinned, archived, protected, protectedReason}>, totalBytes: number, byClassification: Record<string, number> }`
  - `deleteCleanupSessions(projectsDir, conversations, sessionIds, isRunningFn = () => false): { deleted: string[], skipped: Array<{id, reason}>, freedBytes: number, removedConvIds: string[] }`
  - `conversations` es el objeto `data.conversations` tal cual vive en `meta.json` (`{ [convId]: { currentSessionId, name, pinned, archived, ... } }`).
  - `isRunningFn(convId)` la provee `server.js` (usa `convStatus()`, que vive ahí) — `scanner.js` no importa nada de `runner.js`, se mantiene desacoplado del estado en vivo del proceso.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar a `test/cleanup.test.js`:

```js
const { buildCleanupReport, deleteCleanupSessions } = require('../src/scanner');

function projectsRoot(dir) { return path.dirname(dir); }

test('buildCleanupReport clasifica, protege y suma bytes', () => {
  const dir = tmpProjectsDir();
  writeSession(dir, 'app-1', [userMsg('hola'), assistantMsg('dale')]);
  writeSession(dir, 'suelta-1', [userMsg('a'), assistantMsg('b'), userMsg('c'), assistantMsg('d')]);
  const conversations = { 'conv-1': { currentSessionId: 'app-1', name: 'Mi charla', pinned: false, archived: false } };
  const report = buildCleanupReport(projectsRoot(dir), conversations, () => false);
  assert.equal(report.sessions.length, 2);
  const app = report.sessions.find(s => s.sessionId === 'app-1');
  assert.equal(app.classification, 'app');
  assert.equal(app.convId, 'conv-1');
  assert.equal(app.name, 'Mi charla');
  const suelta = report.sessions.find(s => s.sessionId === 'suelta-1');
  assert.equal(suelta.classification, 'orphan');
  assert.equal(suelta.convId, null);
  assert.equal(report.totalBytes, app.sizeBytes + suelta.sizeBytes);
  assert.equal(report.byClassification.app, 1);
  assert.equal(report.byClassification.orphan, 1);
});

test('deleteCleanupSessions borra lo permitido, saltea lo protegido y lo inexistente', () => {
  const dir = tmpProjectsDir();
  writeSession(dir, 'borrable-1', [userMsg('a'), assistantMsg('b'), userMsg('c'), assistantMsg('d')]);
  writeSession(dir, 'pineada-1', [userMsg('a'), assistantMsg('b'), userMsg('c'), assistantMsg('d')]);
  const conversations = { 'conv-p': { currentSessionId: 'pineada-1', pinned: true } };
  const root = projectsRoot(dir);
  const result = deleteCleanupSessions(root, conversations, ['borrable-1', 'pineada-1', 'no-existe'], () => false);
  assert.deepEqual(result.deleted, ['borrable-1']);
  assert.equal(result.skipped.length, 2);
  assert.deepEqual(result.skipped.find(s => s.id === 'pineada-1'), { id: 'pineada-1', reason: 'pinned' });
  assert.deepEqual(result.skipped.find(s => s.id === 'no-existe'), { id: 'no-existe', reason: 'no-existe' });
  assert.deepEqual(result.removedConvIds, []); // pineada-1 no se borró -> no se remueve su conv
  assert.ok(result.freedBytes > 0);
  assert.equal(fs.existsSync(path.join(dir, 'borrable-1.jsonl')), false);
  assert.equal(fs.existsSync(path.join(dir, 'pineada-1.jsonl')), true);
});

test('deleteCleanupSessions devuelve el convId a borrar cuando la sesión sí era app', () => {
  const dir = tmpProjectsDir();
  writeSession(dir, 'app-vieja', [userMsg('a'), assistantMsg('b'), userMsg('c'), assistantMsg('d')]);
  const conversations = { 'conv-x': { currentSessionId: 'app-vieja', pinned: false, archived: false } };
  const root = projectsRoot(dir);
  const result = deleteCleanupSessions(root, conversations, ['app-vieja'], () => false);
  assert.deepEqual(result.deleted, ['app-vieja']);
  assert.deepEqual(result.removedConvIds, ['conv-x']);
});
```

- [ ] **Step 2: Correr los tests y confirmar que fallan**

Run: `node --test test/cleanup.test.js`
Expected: FAIL — `buildCleanupReport is not a function`.

- [ ] **Step 3: Implementar en `src/scanner.js`**

Agregar debajo de las funciones del Task 1:

```js
function _cleanupConvBySession(conversations) {
  const map = new Map();
  for (const [convId, c] of Object.entries(conversations || {})) {
    if (c.currentSessionId) map.set(c.currentSessionId, { convId, ...c });
  }
  return map;
}

function buildCleanupReport(projectsDir, conversations, isRunningFn = () => false) {
  const bySession = _cleanupConvBySession(conversations);
  const raw = listForCleanup(projectsDir);
  const now = Date.now();
  let totalBytes = 0;
  const byClassification = {};
  const sessions = raw.map(s => {
    const conv = bySession.get(s.sessionId) || null;
    const classification = classifySession(s, { referencedAsApp: !!conv });
    const running = conv ? isRunningFn(conv.convId) : false;
    const prot = isProtectedSession(s, { conv, running, now });
    totalBytes += s.sizeBytes;
    byClassification[classification] = (byClassification[classification] || 0) + 1;
    return {
      sessionId: s.sessionId,
      cwd: s.cwd || '(desconocido)',
      snippet: s.snippet,
      sizeBytes: s.sizeBytes,
      messageCount: s.messageCount,
      lastActivity: s.lastActivity,
      classification,
      convId: conv ? conv.convId : null,
      name: conv ? (conv.name || s.snippet) : s.snippet,
      pinned: !!(conv && conv.pinned),
      archived: !!(conv && conv.archived),
      protected: prot.protected,
      protectedReason: prot.reason,
    };
  });
  return { sessions, totalBytes, byClassification };
}

function deleteCleanupSessions(projectsDir, conversations, sessionIds, isRunningFn = () => false) {
  const bySession = _cleanupConvBySession(conversations);
  const deleted = [];
  const skipped = [];
  const removedConvIds = [];
  let freedBytes = 0;
  const now = Date.now();
  for (const sessionId of sessionIds) {
    const filePath = findSessionFile(sessionId, projectsDir);
    if (!filePath) { skipped.push({ id: sessionId, reason: 'no-existe' }); continue; }
    let stat;
    try { stat = fs.statSync(filePath); } catch { skipped.push({ id: sessionId, reason: 'no-existe' }); continue; }
    const conv = bySession.get(sessionId) || null;
    const running = conv ? isRunningFn(conv.convId) : false;
    const info = sessionInfo(filePath);
    const lastActivity = (info && info.lastActivity) || stat.mtime.toISOString();
    const prot = isProtectedSession({ lastActivity }, { conv, running, now });
    if (prot.protected) { skipped.push({ id: sessionId, reason: prot.reason }); continue; }
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      skipped.push({ id: sessionId, reason: 'error: ' + err.message });
      continue;
    }
    freedBytes += stat.size;
    deleted.push(sessionId);
    if (conv) removedConvIds.push(conv.convId);
  }
  return { deleted, skipped, freedBytes, removedConvIds };
}
```

Sumar al `module.exports`: `buildCleanupReport, deleteCleanupSessions,`.

- [ ] **Step 4: Correr los tests y confirmar que pasan**

Run: `node --test test/cleanup.test.js`
Expected: PASS (10/10).

- [ ] **Step 5: Correr toda la suite unitaria para descartar regresiones**

Run: `npm test`
Expected: PASS (todos, incluidos los ~120 preexistentes).

- [ ] **Step 6: Commit**

```bash
git add src/scanner.js test/cleanup.test.js
git commit -m "feat(cleanup): armar reporte y ejecutar borrado en bloque (scanner.js)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `server.js` — endpoints `GET /api/cleanup/sessions` y `POST /api/cleanup/delete`

**Files:**
- Modify: `src/server.js:1357` (justo después del cierre de `app.get('/api/tree', ...)`)

**Interfaces:**
- Consumes: `scanner.buildCleanupReport`, `scanner.deleteCleanupSessions` (Task 2); `meta.load`/`meta.save`, `accountMetaFile`, `accountProjectsDir`, `convStatus`, `syncSearchIndex` (ya existen en `server.js`).
- Produces (para Task 5, el frontend):
  - `GET /api/cleanup/sessions?account=` → `{ sessions: [...], totalBytes, byClassification, account }`
  - `POST /api/cleanup/delete` body `{ account, sessionIds: string[] }` → `{ deleted: string[], skipped: [{id, reason}], freedBytes }`

- [ ] **Step 1: Agregar los endpoints**

Insertar en `src/server.js` inmediatamente después de la línea `});` que cierra `app.get('/api/tree', ...)` (línea 1357 en el estado actual del archivo):

```js
// ── Limpieza de sesiones ──
// Ver docs/superpowers/specs/2026-08-20-limpieza-sesiones-design.md. Toda la
// lógica pesada (clasificar, proteger, borrar) vive en scanner.js como
// funciones puras testeadas aparte — acá solo se cablea HTTP + persistencia
// de meta.json + el resync del índice de búsqueda.
app.get('/api/cleanup/sessions', (req, res) => {
  const acc = req.query.account || activeAccount;
  const data = meta.load(accountMetaFile(acc));
  const report = scanner.buildCleanupReport(
    accountProjectsDir(acc),
    data.conversations,
    convId => convStatus(convId) !== 'idle',
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
  );
  if (result.removedConvIds.length) {
    for (const convId of result.removedConvIds) delete data.conversations[convId];
    if (Array.isArray(data.superseded)) {
      data.superseded = data.superseded.filter(sid => !result.deleted.includes(sid));
    }
    meta.save(data, metaFile);
  }
  // Resync best-effort: si falla (índice no disponible en esta máquina), el
  // borrado ya ocurrió igual — no vale la pena fallar la request por esto.
  syncSearchIndex(acc, { reason: 'cleanup' }).catch(() => {});
  res.json({ deleted: result.deleted, skipped: result.skipped, freedBytes: result.freedBytes });
});
```

- [ ] **Step 2: Chequeo de sintaxis**

Run: `node -c src/server.js`
Expected: sin salida (0 errores).

- [ ] **Step 3: Smoke test manual contra el server real**

No hay precedente en este repo de testear endpoints de `server.js` con un runner unitario (los existentes cubren `scanner`/`meta`/`notes`/`search-index`/`runner`; los endpoints se verifican corriendo el server real, igual que se hizo para el buscador FTS5). Levantar el server contra una carpeta descartable:

```bash
mkdir -p /tmp/ccm-cleanup-smoke/.claude/projects/-tmp-demo
cat > /tmp/ccm-cleanup-smoke/.claude/projects/-tmp-demo/smoke-1.jsonl <<'EOF'
{"type":"user","cwd":"/tmp/demo","timestamp":"2020-01-01T00:00:00.000Z","message":{"role":"user","content":"hola"}}
{"type":"assistant","cwd":"/tmp/demo","timestamp":"2020-01-01T00:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"dale"}]}}
EOF
HOME=/tmp/ccm-cleanup-smoke SINGLE_ACCOUNT=1 PORT=3799 node src/server.js &
sleep 1
curl -s http://127.0.0.1:3799/api/cleanup/sessions | python3 -m json.tool
curl -s -X POST http://127.0.0.1:3799/api/cleanup/delete \
  -H 'Content-Type: application/json' \
  -d '{"sessionIds":["smoke-1"]}' | python3 -m json.tool
curl -s http://127.0.0.1:3799/api/cleanup/sessions | python3 -m json.tool
kill %1
```

Expected: primer `GET` devuelve `smoke-1` con `classification: "orphan"` (no está en `meta.json`), `protected: true`, `protectedReason: "recent"` porque `lastActivity` cae al `mtime` del archivo (recién creado), no al timestamp viejo del `.jsonl` (eso es esperado — `lastActivity` sale del último entry o del mtime del archivo si falta, y acá el archivo se acaba de escribir). Para probar el camino de borrado real sin el bloqueo de "reciente", tocar el archivo con fecha vieja antes del `DELETE`:

```bash
touch -d '2020-01-01' /tmp/ccm-cleanup-smoke/.claude/projects/-tmp-demo/smoke-1.jsonl
```

Repetir la secuencia — ahora el `POST /api/cleanup/delete` debe devolver `{"deleted":["smoke-1"],"skipped":[],"freedBytes":<n>}` y el segundo `GET` ya no debe listar `smoke-1`.

- [ ] **Step 4: Commit**

```bash
git add src/server.js
git commit -m "feat(cleanup): endpoints GET/POST /api/cleanup/sessions y /delete

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Frontend — pestaña "Sesiones", contenedor y CSS del carrusel de 5 panes

**Files:**
- Modify: `public/index.html:59-89` (nav de pestañas + contenedor del pane)
- Modify: `public/style.css:207-218` (matemática del carrusel, hoy hardcodeada a 4 panes)
- Modify: `public/app.js:11` (comentario), `public/app.js:3137` (`PANE_COUNT`)

**Interfaces:**
- Consumes: nada nuevo.
- Produces (para Task 5): `#tree-sessions` (contenedor del pane), `.pane-tab[data-pane="4"]` (pestaña), `#cleanup-confirm-dialog` (modal de confirmación) — ids que `sessions-cleanup.js` va a usar.

- [ ] **Step 1: Sumar la pestaña y el contenedor del pane en `index.html`**

En `public/index.html`, agregar una 5ª pestaña dentro de `<nav id="pane-tabs">` (línea 63, después del botón de Escáner):

```html
        <button type="button" class="pane-tab" data-pane="4">🧹 Sesiones</button>
```

Y dentro de `#tree-viewport-inner` (línea 87, después del cierre de `#tree-scan`), agregar el pane nuevo:

```html
          <div id="tree-sessions" class="tree-pane sessions-pane">
            <div class="cleanup-header">
              <h2>🧹 Sesiones</h2>
              <span id="cleanup-total">0 sesiones · 0 MB</span>
            </div>
            <div class="cleanup-filters">
              <div id="cleanup-class-filters" class="cleanup-chips"></div>
              <select id="cleanup-folder-filter"><option value="">Todas las carpetas</option></select>
              <select id="cleanup-size-filter">
                <option value="0">Cualquier tamaño</option>
                <option value="1000000">&gt; 1 MB</option>
                <option value="5000000">&gt; 5 MB</option>
                <option value="20000000">&gt; 20 MB</option>
              </select>
              <select id="cleanup-date-filter">
                <option value="0">Cualquier fecha</option>
                <option value="7">Últimos 7 días</option>
                <option value="30">Últimos 30 días</option>
                <option value="older30">Hace más de 30 días</option>
              </select>
              <select id="cleanup-sort">
                <option value="size">Tamaño (mayor primero)</option>
                <option value="lastActivity">Última actividad</option>
                <option value="messageCount">Cantidad de mensajes</option>
              </select>
            </div>
            <label class="cleanup-select-all">
              <input type="checkbox" id="cleanup-select-all-cb">
              Seleccionar todo lo visible
            </label>
            <div id="cleanup-list" class="cleanup-list"></div>
          </div>
```

Y un `<dialog>` de confirmación, junto a los otros diálogos (después del cierre de `</dialog>` de `search-dialog`, línea 207):

```html
  <!-- Confirmación de borrado de sesiones -->
  <dialog id="cleanup-confirm-dialog">
    <form method="dialog" id="cleanup-confirm-form">
      <p id="cleanup-confirm-text"></p>
      <div class="cleanup-confirm-actions">
        <button type="button" id="cleanup-confirm-cancel">Cancelar</button>
        <button type="submit" id="cleanup-confirm-ok" class="danger">Borrar</button>
      </div>
    </form>
  </dialog>
```

- [ ] **Step 2: Arreglar la matemática del carrusel para 5 panes en `style.css`**

`public/style.css` tiene hoy 4 panes hardcodeados (`width: 400%`, cada `.tree-pane` al 25%, y 3 reglas `translateX` fijas). Reemplazar el bloque de las líneas 207-218:

```css
#tree-viewport { flex: 1; overflow: hidden; position: relative; }
#tree-viewport-inner {
  display: flex;
  width: 500%;
  height: 100%;
  transition: transform .25s ease;
  touch-action: pan-y;
}
#tree-viewport-inner[data-pane="1"] { transform: translateX(-20%); }
#tree-viewport-inner[data-pane="2"] { transform: translateX(-40%); }
#tree-viewport-inner[data-pane="3"] { transform: translateX(-60%); }
#tree-viewport-inner[data-pane="4"] { transform: translateX(-80%); }
.tree-pane { width: 20%; flex: none; height: 100%; overflow-y: auto; }
.tree-pane::-webkit-scrollbar { width: 4px; }
```

(El resto del archivo desde `.tree-pane::-webkit-scrollbar-thumb` en adelante no cambia.)

- [ ] **Step 3: Sumar estilos del pane nuevo**

Agregar al final de `public/style.css`:

```css
.sessions-pane { display: flex; flex-direction: column; overflow: hidden; }
.cleanup-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 10px 12px; border-bottom: 1px solid var(--border); flex: none;
}
.cleanup-header h2 { font-size: 14px; margin: 0; }
#cleanup-total { font-size: 12px; color: var(--text2); }
.cleanup-filters { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--border); flex: none; }
.cleanup-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.cleanup-chip {
  border: 1px solid var(--border); border-radius: 999px; padding: 3px 10px;
  font-size: 12px; background: none; color: var(--text2); cursor: pointer;
}
.cleanup-chip.active { border-color: var(--accent); color: var(--accent); }
.cleanup-filters select {
  background: var(--input-bg); color: var(--text); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 4px 6px; font-size: 12px;
}
.cleanup-select-all { display: flex; align-items: center; gap: 6px; padding: 6px 12px; font-size: 12px; color: var(--text2); flex: none; }
.cleanup-list { flex: 1; overflow-y: auto; }
.session-row {
  display: flex; align-items: center; gap: 8px; padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}
.session-row.protected { opacity: .6; }
.session-row-body { flex: 1; min-width: 0; }
.session-row-name { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.session-row-meta { font-size: 11px; color: var(--text2); display: flex; gap: 6px; flex-wrap: wrap; }
.session-badge {
  font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--border);
}
.session-badge-app { color: var(--accent); border-color: var(--accent); }
.session-badge-channel { color: var(--danger); border-color: var(--danger); }
.cleanup-toolbar {
  display: none; align-items: center; justify-content: space-between;
  padding: 8px 12px; border-top: 1px solid var(--border); background: var(--panel); flex: none;
}
.cleanup-toolbar.visible { display: flex; }
.cleanup-toolbar button.danger { background: var(--danger); color: #fff; border: none; border-radius: var(--radius); padding: 6px 12px; }
#cleanup-confirm-dialog { border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); color: var(--text); padding: 16px; max-width: 360px; }
.cleanup-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.cleanup-confirm-actions button.danger { background: var(--danger); color: #fff; border: none; border-radius: var(--radius); padding: 6px 14px; }
```

- [ ] **Step 4: Actualizar `PANE_COUNT` y el comentario en `app.js`**

En `public/app.js:11`, cambiar:

```js
let activePane = 0; // 0=chats 1=archived 2=notas 3=escaner
```

por:

```js
let activePane = 0; // 0=chats 1=archived 2=notas 3=escaner 4=sesiones
```

En `public/app.js:3137`, cambiar:

```js
const PANE_COUNT = 4;
```

por:

```js
const PANE_COUNT = 5;
```

- [ ] **Step 5: Bump de cache-busting**

En `public/index.html`, subir la versión de `style.css` y `app.js` (hoy `?v=66` y `?v=70` respectivamente) a `?v=67` y `?v=71`.

- [ ] **Step 6: Verificar que no se rompió la navegación existente**

Run: `npm run test:e2e`
Expected: PASS (3/3, los specs existentes de abrir/cerrar chat, buscador y mandar mensaje — ninguno toca el pane nuevo todavía, pero si la matemática del carrusel quedó mal, `chat.spec.js` lo va a notar al fallar el flujo de abrir/cerrar).

Verificación visual manual (no automatizada, como el resto de las features de UI de este proyecto): abrir la app, click en cada pestaña (Chats/Archivado/Notas/Escáner/Sesiones) y confirmar que cada una desliza a la posición correcta y las 4 pestañas viejas se siguen viendo bien — la pestaña "Sesiones" puede aparecer vacía todavía (Task 5 la llena).

- [ ] **Step 7: Commit**

```bash
git add public/index.html public/style.css public/app.js
git commit -m "feat(cleanup): pestaña y contenedor de Sesiones, carrusel a 5 panes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Frontend — `public/sessions-cleanup.js` (listar, filtrar, seleccionar, borrar)

**Files:**
- Create: `public/sessions-cleanup.js`
- Modify: `public/index.html` (script tag nuevo + wiring de carga perezosa)
- Modify: `public/app.js:785-822` (rama de carga perezosa en `goToPane`)

**Interfaces:**
- Consumes: `$()`, `api()`, `withAccount()`, `withAccountBody()`, `toast()`, `activePane`, `activeAccount`, `goToPane()` (todas ya definidas en `app.js`, mismo scope global).
- Produces: `window.loadCleanupSessions()` — la llama `goToPane()` al entrar al pane 4, mismo patrón que `loadArchivedTree()`/`loadNotebookList()`.

- [ ] **Step 1: Crear `public/sessions-cleanup.js`**

```js
// ── Limpieza de sesiones ──
// Extraído como dominio propio desde el arranque (no hay código viejo que
// mover — nace ya separado, sigue el mismo patrón que search.js/doc-scanner.js:
// script clásico cargado después de app.js, mismo scope global compartido.
// Ver docs/superpowers/specs/2026-08-20-limpieza-sesiones-design.md.

let cleanupSessions = [];      // último reporte crudo del server
let cleanupActiveClasses = new Set(); // clasificaciones activas en los chips (vacío = todas)
let cleanupFolder = '';
let cleanupMinSize = 0;       // bytes; 0 = sin filtro de tamaño
let cleanupDateFilter = '0';  // '0' | '7' | '30' | 'older30'
let cleanupSort = 'size';
let cleanupSelected = new Set(); // sessionIds seleccionados (nunca incluye protegidas)

const CLEANUP_CLASS_LABELS = { app: 'App', orphan: 'Suelta', trivial: 'Trivial', channel: 'Canal' };
const CLEANUP_REASON_LABELS = { archived: '🔒 archivada', pinned: '🔒 pineada', running: '🔒 activa', recent: '🔒 reciente' };

function cleanupFolderName(cwd) {
  return (cwd || '').split(/[\\/]/).filter(Boolean).pop() || cwd || '(desconocido)';
}

function cleanupFormatMB(bytes) {
  return (bytes / 1e6).toFixed(1) + ' MB';
}

async function loadCleanupSessions() {
  const resp = await api(withAccount('/cleanup/sessions'));
  cleanupSessions = resp.sessions;
  cleanupSelected = new Set([...cleanupSelected].filter(id => cleanupSessions.some(s => s.sessionId === id)));
  renderCleanupChips(resp.byClassification);
  renderCleanupFolders();
  renderCleanupList();
  updateCleanupTotals(resp.totalBytes);
}

function renderCleanupChips(byClassification) {
  const box = $('cleanup-class-filters');
  box.innerHTML = '';
  for (const key of Object.keys(CLEANUP_CLASS_LABELS)) {
    const count = byClassification[key] || 0;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'cleanup-chip' + (cleanupActiveClasses.has(key) ? ' active' : '');
    chip.textContent = `${CLEANUP_CLASS_LABELS[key]} (${count})`;
    chip.onclick = () => {
      if (cleanupActiveClasses.has(key)) cleanupActiveClasses.delete(key);
      else cleanupActiveClasses.add(key);
      renderCleanupChips(byClassification);
      renderCleanupList();
    };
    box.appendChild(chip);
  }
}

function renderCleanupFolders() {
  const select = $('cleanup-folder-filter');
  const prev = select.value;
  const folders = [...new Set(cleanupSessions.map(s => s.cwd))].sort();
  select.innerHTML = '<option value="">Todas las carpetas</option>' +
    folders.map(f => `<option value="${f.replace(/"/g, '&quot;')}">${cleanupFolderName(f)}</option>`).join('');
  select.value = folders.includes(prev) ? prev : '';
  cleanupFolder = select.value;
}

function cleanupFilteredSorted() {
  let list = cleanupSessions;
  if (cleanupActiveClasses.size) list = list.filter(s => cleanupActiveClasses.has(s.classification));
  if (cleanupFolder) list = list.filter(s => s.cwd === cleanupFolder);
  if (cleanupMinSize) list = list.filter(s => s.sizeBytes > cleanupMinSize);
  if (cleanupDateFilter !== '0') {
    const now = Date.now();
    const ageMs = (sess) => now - new Date(sess.lastActivity || 0).getTime();
    list = cleanupDateFilter === 'older30'
      ? list.filter(s => ageMs(s) > 30 * 86400000)
      : list.filter(s => ageMs(s) <= Number(cleanupDateFilter) * 86400000);
  }
  const sorted = [...list];
  if (cleanupSort === 'size') sorted.sort((a, b) => b.sizeBytes - a.sizeBytes);
  else if (cleanupSort === 'lastActivity') sorted.sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));
  else if (cleanupSort === 'messageCount') sorted.sort((a, b) => b.messageCount - a.messageCount);
  return sorted;
}

function renderCleanupList() {
  const box = $('cleanup-list');
  box.innerHTML = '';
  const list = cleanupFilteredSorted();
  for (const s of list) {
    const row = document.createElement('div');
    row.className = 'session-row' + (s.protected ? ' protected' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.disabled = s.protected;
    cb.checked = cleanupSelected.has(s.sessionId);
    cb.onchange = () => {
      if (cb.checked) cleanupSelected.add(s.sessionId);
      else cleanupSelected.delete(s.sessionId);
      updateCleanupToolbar();
    };
    const body = document.createElement('div');
    body.className = 'session-row-body';
    const name = document.createElement('div');
    name.className = 'session-row-name';
    name.textContent = s.name || s.snippet || '(sin mensajes)';
    const meta = document.createElement('div');
    meta.className = 'session-row-meta';
    const badge = document.createElement('span');
    badge.className = 'session-badge session-badge-' + s.classification;
    badge.textContent = CLEANUP_CLASS_LABELS[s.classification];
    meta.appendChild(badge);
    if (s.protected) {
      const reasonBadge = document.createElement('span');
      reasonBadge.className = 'session-badge';
      reasonBadge.textContent = CLEANUP_REASON_LABELS[s.protectedReason] || '🔒';
      meta.appendChild(reasonBadge);
    }
    const rest = document.createElement('span');
    rest.textContent = [cleanupFolderName(s.cwd), cleanupFormatMB(s.sizeBytes), (s.lastActivity || '').slice(0, 10)].join(' · ');
    meta.appendChild(rest);
    body.appendChild(name);
    body.appendChild(meta);
    row.appendChild(cb);
    row.appendChild(body);
    box.appendChild(row);
  }
}

function updateCleanupTotals(totalBytes) {
  $('cleanup-total').textContent = `${cleanupSessions.length} sesiones · ${cleanupFormatMB(totalBytes)}`;
}

function updateCleanupToolbar() {
  let toolbar = $('cleanup-toolbar');
  if (!toolbar) {
    toolbar = document.createElement('div');
    toolbar.id = 'cleanup-toolbar';
    toolbar.className = 'cleanup-toolbar';
    toolbar.innerHTML = `
      <span id="cleanup-toolbar-count"></span>
      <button type="button" id="cleanup-toolbar-delete" class="danger">Borrar</button>
    `;
    $('tree-sessions').appendChild(toolbar);
    $('cleanup-toolbar-delete').onclick = openCleanupConfirm;
  }
  const selectedRows = cleanupSessions.filter(s => cleanupSelected.has(s.sessionId));
  const bytes = selectedRows.reduce((sum, s) => sum + s.sizeBytes, 0);
  toolbar.classList.toggle('visible', cleanupSelected.size > 0);
  $('cleanup-toolbar-count').textContent = `${cleanupSelected.size} seleccionadas · ${cleanupFormatMB(bytes)}`;
}

function openCleanupConfirm() {
  const selectedRows = cleanupSessions.filter(s => cleanupSelected.has(s.sessionId));
  const bytes = selectedRows.reduce((sum, s) => sum + s.sizeBytes, 0);
  $('cleanup-confirm-text').textContent =
    `Vas a borrar ${selectedRows.length} sesiones (${cleanupFormatMB(bytes)}) de forma permanente. ¿Confirmás?`;
  $('cleanup-confirm-dialog').showModal();
}

async function runCleanupDelete() {
  const ids = [...cleanupSelected];
  try {
    const resp = await api('/cleanup/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(withAccountBody({ sessionIds: ids })),
    });
    cleanupSelected.clear();
    const freedMB = cleanupFormatMB(resp.freedBytes);
    const skippedMsg = resp.skipped.length ? `, ${resp.skipped.length} salteadas` : '';
    toast(`Borradas ${resp.deleted.length} sesiones · liberaste ${freedMB}${skippedMsg}`, 'info', 5000);
    await loadCleanupSessions();
    updateCleanupToolbar();
  } catch (err) {
    toast('Error borrando sesiones: ' + err.message);
  }
}

$('cleanup-folder-filter').addEventListener('change', () => {
  cleanupFolder = $('cleanup-folder-filter').value;
  renderCleanupList();
});
$('cleanup-size-filter').addEventListener('change', () => {
  cleanupMinSize = Number($('cleanup-size-filter').value);
  renderCleanupList();
});
$('cleanup-date-filter').addEventListener('change', () => {
  cleanupDateFilter = $('cleanup-date-filter').value;
  renderCleanupList();
});
$('cleanup-sort').addEventListener('change', () => {
  cleanupSort = $('cleanup-sort').value;
  renderCleanupList();
});
$('cleanup-select-all-cb').addEventListener('change', (e) => {
  const visible = cleanupFilteredSorted().filter(s => !s.protected);
  if (e.target.checked) visible.forEach(s => cleanupSelected.add(s.sessionId));
  else visible.forEach(s => cleanupSelected.delete(s.sessionId));
  renderCleanupList();
  updateCleanupToolbar();
});
$('cleanup-confirm-cancel').onclick = () => $('cleanup-confirm-dialog').close();
$('cleanup-confirm-form').addEventListener('submit', (e) => {
  e.preventDefault();
  $('cleanup-confirm-dialog').close();
  runCleanupDelete();
});
```

- [ ] **Step 2: Cargar el script en `index.html`**

En `public/index.html`, agregar después de `<script src="lightbox.js?v=66"></script>`:

```html
  <script src="sessions-cleanup.js?v=67"></script>
```

- [ ] **Step 3: Enganchar la carga perezosa en `goToPane` (`public/app.js`)**

En `public/app.js`, dentro de `goToPane` (línea 785), agregar una rama nueva junto a las de `index === 1` y `index === 2` (después de la de `index === 2`, antes del `if (myGeneration !== paneNavGeneration) return;` de la línea 816):

```js
  if (index === 4) {
    try {
      await loadCleanupSessions();
    } catch (err) {
      toast('No se pudieron cargar las sesiones: ' + err.message);
      if (myGeneration === paneNavGeneration) paneNavTarget = activePane;
      return;
    }
  }
```

(A diferencia de Archivado/Notas, acá se recarga cada vez que se entra al pane — no hay flag `cleanupPaneLoaded` — porque el estado de "protegida" cambia con el tiempo real (últimos 5 días) y conviene refrescar siempre que el usuario vuelve a mirar la pantalla de limpieza.)

- [ ] **Step 4: Chequeo de sintaxis**

Run: `node -c public/sessions-cleanup.js` y `node -c public/app.js`
Expected: sin salida en ambos.

- [ ] **Step 5: Correr toda la suite (unitaria + e2e)**

Run: `npm test && npm run test:e2e`
Expected: PASS en ambas — la e2e confirma que el resto de la navegación (abrir/cerrar chat, buscador, mandar mensaje) sigue intacta con el 5º pane sumado.

- [ ] **Step 6: Verificación visual manual**

Con el server corriendo, entrar a la pestaña "Sesiones": confirmar que aparece la lista con badges de clasificación, que las filas protegidas tienen el checkbox deshabilitado y su motivo, que los chips de clasificación, el filtro de carpeta y los filtros de tamaño/fecha filtran de verdad, que tildar filas hace aparecer la barra inferior con el conteo/MB, que "Borrar" abre el modal de confirmación con el resumen correcto, y que confirmar borra de verdad (la fila desaparece de la lista y el total baja). Repetir con "Seleccionar todo lo visible" tildado y algún filtro activo, para confirmar que solo selecciona lo filtrado y no-protegido.

- [ ] **Step 7: Commit**

```bash
git add public/sessions-cleanup.js public/index.html public/app.js
git commit -m "feat(cleanup): UI de la pestaña Sesiones — listar, filtrar, seleccionar, borrar

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```
