# Notas: múltiples libretas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convertir la libreta única de Notas en múltiples libretas independientes ("conversaciones" de notas), navegables desde una lista, reusando el mecanismo de overlay/back-button que ya usan los chats en vez de inventar una interacción nueva para mobile.

**Architecture:** El pane "Notas" (uno de los 3 paneles deslizantes Chats/Archivado/Notas) deja de mostrar una libreta directo y pasa a mostrar una lista de libretas (mismo look que `#tree`). Al tocar una libreta se abre reusando literalmente `#panel-chat` — el mismo panel/overlay/`history.pushState` que ya usan los chats — alternando qué sub-vista se muestra dentro de él (`showNotebookView(true/false)`) en vez de crear un panel nuevo. Storage: un `notebooks.json` (índice) + un `notes.jsonl` por libreta bajo `~/.ccm-notes/notebooks/<id>/`. Sin migración: las notas de prueba existentes se descartan.

**Tech Stack:** Node.js/Express (server.js existente), multer (upload), vanilla JS + CSS (frontend existente, sin build step), `node --test` para tests de backend.

**Spec:** `docs/superpowers/specs/2026-08-13-notas-libretas-design.md`

## Global Constraints

- Todo endpoint nuevo vive detrás del mismo `ACCESS_PIN` que ya protege `/api/*` — no se agrega autenticación nueva.
- Sin SSE/websockets nuevos — solo polling (5s), mismo criterio ya usado en la v1 de Notas.
- Archivos de Notas siguen yendo todos juntos a `~/Desktop/Notas Jarvis/`, sin subcarpetas por libreta.
- Sin migración de datos: el `notes.jsonl` viejo (formato plano, v1) se descarta. `notebooks.json` arranca vacío en una instalación existente.
- Borrar/reordenar libretas queda fuera de esta v1.
- No se toca `src/scanner.js`, `src/runner.js`, `src/claude-cmd.js` — el módulo de Notas sigue siendo standalone.

---

### Task 1: Módulo de storage — índice de libretas + notas por libreta

**Files:**
- Modify: `src/notes.js` (reescritura completa)
- Modify: `test/notes.test.js` (agrega tests de libretas, mantiene los existentes)

**Interfaces:**
- Produces: `append(entry, file)` y `readAll(file)` — igual que antes, pero ahora requieren `file` explícito (ya no hay un `NOTES_FILE` global). `ensureFilesDir(dir = FILES_DIR)`, `resolveDestName(dir, originalName)` — sin cambios. Nuevo: `listNotebooks(indexFile = NOTEBOOKS_FILE, notebooksDir = NOTEBOOKS_DIR)` → `Array<{id, name, createdAt, lastActivity}>`. `createNotebook(indexFile = NOTEBOOKS_FILE)` → `{id, name, createdAt}`, nombre `"Nueva libreta"` o `"Nueva libreta N"` si hay colisión. `renameNotebook(id, name, indexFile = NOTEBOOKS_FILE)` → entrada actualizada o `null` si no existe. `getNotebook(id, indexFile = NOTEBOOKS_FILE)` → entrada o `null`. `notebookNotesFile(id, notebooksDir = NOTEBOOKS_DIR)` → `string`, ruta del jsonl de esa libreta. `nextDefaultName(existingNames)` → `string`. Constante `DEFAULT_NAME_RE` (regex que matchea `"Nueva libreta"`/`"Nueva libreta N"`). Constantes exportadas: `NOTES_DIR`, `NOTEBOOKS_FILE`, `NOTEBOOKS_DIR`, `FILES_DIR`.
- Consumido por Task 2 (`server.js`).

- [ ] **Step 1: Escribir los tests nuevos (van a fallar — las funciones no existen todavía)**

Reemplazar el contenido completo de `test/notes.test.js` por:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  append, readAll, resolveDestName, ensureFilesDir,
  listNotebooks, createNotebook, renameNotebook, getNotebook,
  notebookNotesFile, nextDefaultName, DEFAULT_NAME_RE,
} = require('../src/notes');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-notes-')), 'sub', 'notes.jsonl');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-notes-dir-'));
const tmpIndexFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-notebooks-')), 'notebooks.json');
const tmpNotebooksDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-notebooks-dir-'));

test('readAll devuelve [] si el archivo no existe', () => {
  assert.deepEqual(readAll('/no/existe/notes.jsonl'), []);
});

test('append crea el directorio y readAll lo lee de vuelta', () => {
  const file = tmpFile();
  const entry = { id: '1', ts: 1000, type: 'text', text: 'hola' };
  append(entry, file);
  assert.deepEqual(readAll(file), [entry]);
});

test('append es acumulativo: preserva el orden de inserción', () => {
  const file = tmpFile();
  const a = { id: '1', ts: 1000, type: 'text', text: 'primero' };
  const b = { id: '2', ts: 2000, type: 'text', text: 'segundo' };
  append(a, file);
  append(b, file);
  assert.deepEqual(readAll(file), [a, b]);
});

test('readAll saltea líneas corruptas sin tirar abajo el resto', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const good1 = { id: '1', ts: 1000, type: 'text', text: 'ok' };
  const good2 = { id: '2', ts: 2000, type: 'text', text: 'también ok' };
  fs.writeFileSync(file, JSON.stringify(good1) + '\n{ esto no es json }\n' + JSON.stringify(good2) + '\n');
  assert.deepEqual(readAll(file), [good1, good2]);
});

test('resolveDestName devuelve el nombre original si no hay colisión', () => {
  const dir = tmpDir();
  assert.equal(resolveDestName(dir, 'foto.jpg'), 'foto.jpg');
});

test('resolveDestName antepone timestamp si el nombre ya existe', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'foto.jpg'), 'x');
  const resolved = resolveDestName(dir, 'foto.jpg');
  assert.notEqual(resolved, 'foto.jpg');
  assert.match(resolved, /^\d+-foto\.jpg$/);
});

test('resolveDestName sanitiza separadores de path del nombre original', () => {
  const dir = tmpDir();
  assert.equal(resolveDestName(dir, '../../etc/passwd'), 'passwd');
});

test('ensureFilesDir crea el directorio si no existe', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-notes-ensure-')), 'Notas Jarvis');
  assert.ok(!fs.existsSync(dir));
  ensureFilesDir(dir);
  assert.ok(fs.existsSync(dir));
});

test('listNotebooks devuelve [] si no hay índice todavía', () => {
  assert.deepEqual(listNotebooks(tmpIndexFile(), tmpNotebooksDir()), []);
});

test('createNotebook arma el primer nombre default y lo persiste', () => {
  const indexFile = tmpIndexFile();
  const nb = createNotebook(indexFile);
  assert.equal(nb.name, 'Nueva libreta');
  assert.ok(nb.id);
  assert.ok(nb.createdAt);
  const list = listNotebooks(indexFile, tmpNotebooksDir());
  assert.equal(list.length, 1);
  assert.equal(list[0].id, nb.id);
});

test('createNotebook numera libretas default sucesivas para no chocar de nombre', () => {
  const indexFile = tmpIndexFile();
  const a = createNotebook(indexFile);
  const b = createNotebook(indexFile);
  const c = createNotebook(indexFile);
  assert.equal(a.name, 'Nueva libreta');
  assert.equal(b.name, 'Nueva libreta 2');
  assert.equal(c.name, 'Nueva libreta 3');
});

test('renameNotebook actualiza el nombre y devuelve la entrada actualizada', () => {
  const indexFile = tmpIndexFile();
  const nb = createNotebook(indexFile);
  const renamed = renameNotebook(nb.id, 'Recetas', indexFile);
  assert.equal(renamed.name, 'Recetas');
  assert.equal(getNotebook(nb.id, indexFile).name, 'Recetas');
});

test('renameNotebook devuelve null si el id no existe', () => {
  const indexFile = tmpIndexFile();
  assert.equal(renameNotebook('no-existe', 'x', indexFile), null);
});

test('getNotebook devuelve null si el id no existe', () => {
  assert.equal(getNotebook('no-existe', tmpIndexFile()), null);
});

test('listNotebooks calcula lastActivity desde la última nota de cada libreta', () => {
  const indexFile = tmpIndexFile();
  const notebooksDir = tmpNotebooksDir();
  const nb = createNotebook(indexFile);
  const file = notebookNotesFile(nb.id, notebooksDir);
  append({ id: '1', ts: 1000, type: 'text', text: 'a' }, file);
  append({ id: '2', ts: 5000, type: 'text', text: 'b' }, file);
  const [entry] = listNotebooks(indexFile, notebooksDir);
  assert.equal(entry.lastActivity, 5000);
});

test('listNotebooks usa createdAt como lastActivity si la libreta todavía no tiene notas', () => {
  const indexFile = tmpIndexFile();
  const nb = createNotebook(indexFile);
  const [entry] = listNotebooks(indexFile, tmpNotebooksDir());
  assert.equal(entry.lastActivity, nb.createdAt);
});

test('nextDefaultName arma el primer nombre libre entre libretas ya default', () => {
  assert.equal(nextDefaultName([]), 'Nueva libreta');
  assert.equal(nextDefaultName(['Nueva libreta']), 'Nueva libreta 2');
  assert.equal(nextDefaultName(['Nueva libreta', 'Nueva libreta 2']), 'Nueva libreta 3');
  assert.equal(nextDefaultName(['Recetas']), 'Nueva libreta');
});

test('DEFAULT_NAME_RE matchea nombres default y no matchea nombres puestos a mano', () => {
  assert.ok(DEFAULT_NAME_RE.test('Nueva libreta'));
  assert.ok(DEFAULT_NAME_RE.test('Nueva libreta 12'));
  assert.ok(!DEFAULT_NAME_RE.test('Recetas'));
  assert.ok(!DEFAULT_NAME_RE.test('Nueva libretas'));
});

test('notebookNotesFile arma la ruta jsonl de una libreta dentro de su propio directorio', () => {
  const dir = tmpNotebooksDir();
  const file = notebookNotesFile('abc-123', dir);
  assert.equal(file, path.join(dir, 'abc-123', 'notes.jsonl'));
});
```

- [ ] **Step 2: Correr los tests y confirmar que fallan**

Run: `npm test`
Expected: FAIL — `listNotebooks is not a function` (o similar, las funciones nuevas no existen todavía).

- [ ] **Step 3: Reescribir `src/notes.js`**

Reemplazar el contenido completo del archivo por:

```javascript
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || os.homedir();
const NOTES_DIR = path.join(HOME_DIR, '.ccm-notes');
const NOTEBOOKS_FILE = path.join(NOTES_DIR, 'notebooks.json');
const NOTEBOOKS_DIR = path.join(NOTES_DIR, 'notebooks');
const FILES_DIR = path.join(HOME_DIR, 'Desktop', 'Notas Jarvis');

// Nombre por default de una libreta recién creada, y su patrón de detección
// (para saber si el auto-nombre por primera nota todavía puede pisarlo, o si
// el usuario ya la renombró a mano y hay que dejarla en paz).
const DEFAULT_NAME_RE = /^Nueva libreta( \d+)?$/;

// Agrega una entrada al final del jsonl de una libreta. No genera id/ts — el
// caller (server.js) ya los arma, así este módulo queda testeable con
// objetos arbitrarios.
function append(entry, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  return entry;
}

// Lee todas las entradas en orden de inserción (el archivo es append-only, así
// que el orden del archivo ES el orden cronológico). Una línea corrupta no
// tira abajo el resto: se salta y se loguea.
function readAll(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); }
    catch (e) { console.error('[notes] línea corrupta salteada:', e.message); }
  }
  return out;
}

function ensureFilesDir(dir = FILES_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Evita pisar un archivo existente: si ya hay uno con ese nombre, antepone el
// timestamp. path.basename además descarta cualquier separador de carpeta que
// venga en el nombre original (defensa ante un originalname tipo '../../x').
function resolveDestName(dir, originalName) {
  const safeName = path.basename(originalName);
  if (!fs.existsSync(path.join(dir, safeName))) return safeName;
  return `${Date.now()}-${safeName}`;
}

// ── Índice de libretas (~/.ccm-notes/notebooks.json) ──

function readNotebooksIndex(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return []; }
  try { return JSON.parse(raw); }
  catch (e) { console.error('[notes] notebooks.json corrupto, se ignora:', e.message); return []; }
}

function writeNotebooksIndex(list, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list, null, 2));
}

// Ruta del jsonl de notas de una libreta puntual — cada libreta vive en su
// propio subdirectorio, aislada de las demás.
function notebookNotesFile(id, notebooksDir = NOTEBOOKS_DIR) {
  return path.join(notebooksDir, id, 'notes.jsonl');
}

// Arma "Nueva libreta" o, si ya existe, "Nueva libreta 2", "Nueva libreta 3"…
function nextDefaultName(existingNames) {
  if (!existingNames.includes('Nueva libreta')) return 'Nueva libreta';
  let n = 2;
  while (existingNames.includes(`Nueva libreta ${n}`)) n++;
  return `Nueva libreta ${n}`;
}

// Lista de libretas con su actividad más reciente calculada al vuelo (ts de
// la última nota, o createdAt si todavía no tiene ninguna) — así el cliente
// puede ordenar/mostrar "última vez" sin tener que mantener ese dato
// duplicado y potencialmente desincronizado en el índice.
function listNotebooks(indexFile = NOTEBOOKS_FILE, notebooksDir = NOTEBOOKS_DIR) {
  return readNotebooksIndex(indexFile).map(nb => {
    const entries = readAll(notebookNotesFile(nb.id, notebooksDir));
    const last = entries[entries.length - 1];
    return { ...nb, lastActivity: last ? last.ts : nb.createdAt };
  });
}

function createNotebook(indexFile = NOTEBOOKS_FILE) {
  const list = readNotebooksIndex(indexFile);
  const name = nextDefaultName(list.map(nb => nb.name));
  const entry = { id: crypto.randomUUID(), name, createdAt: Date.now() };
  list.push(entry);
  writeNotebooksIndex(list, indexFile);
  return entry;
}

function renameNotebook(id, name, indexFile = NOTEBOOKS_FILE) {
  const list = readNotebooksIndex(indexFile);
  const nb = list.find(n => n.id === id);
  if (!nb) return null;
  nb.name = name;
  writeNotebooksIndex(list, indexFile);
  return nb;
}

function getNotebook(id, indexFile = NOTEBOOKS_FILE) {
  return readNotebooksIndex(indexFile).find(n => n.id === id) || null;
}

module.exports = {
  append, readAll, ensureFilesDir, resolveDestName,
  listNotebooks, createNotebook, renameNotebook, getNotebook,
  notebookNotesFile, nextDefaultName, DEFAULT_NAME_RE,
  NOTES_DIR, NOTEBOOKS_FILE, NOTEBOOKS_DIR, FILES_DIR,
};
```

- [ ] **Step 4: Correr los tests y confirmar que pasan**

Run: `npm test`
Expected: PASS — todos los tests de `test/notes.test.js` (viejos + nuevos), y el resto de la suite preexistente sigue en verde.

- [ ] **Step 5: Commit**

```bash
git add src/notes.js test/notes.test.js
git commit -m "feat(notes): storage de múltiples libretas (índice + notes.jsonl por libreta)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Endpoints HTTP `/api/notebooks*`

**Files:**
- Modify: `src/server.js:454-496` (reemplaza el bloque entero de endpoints `/api/notes*`)

**Interfaces:**
- Consumes: `notes.listNotebooks`, `notes.createNotebook`, `notes.renameNotebook`, `notes.getNotebook`, `notes.notebookNotesFile`, `notes.DEFAULT_NAME_RE`, `notes.append`, `notes.readAll`, `notes.ensureFilesDir`, `notes.resolveDestName`, `notes.FILES_DIR` (Task 1).
- Produces:
  - `GET /api/notebooks` → `{ notebooks: Array<{id, name, createdAt, lastActivity}> }`
  - `POST /api/notebooks` (sin body) → `201` con `{id, name, createdAt}` (nombre default, `"Nueva libreta"` o siguiente numerado)
  - `PATCH /api/notebooks/:id` `{name}` → `200` con la entrada actualizada, `404` si no existe
  - `GET /api/notebooks/:id/notes` → `{ notes: Array<entry> }`, `404` si la libreta no existe
  - `POST /api/notebooks/:id/notes` `{text}` → `201` con `{ entry, notebook }` (`notebook` refleja el auto-rename si acaba de ocurrir), `404` si la libreta no existe
  - `POST /api/notebooks/:id/notes/upload` (multipart, campo `file`) → `201` con `{ entry, notebook }`, `404` si la libreta no existe
  - Todos protegidos por el mismo middleware de `ACCESS_PIN` ya existente.
  - Consumido por Task 3/4 (`app.js`).

- [ ] **Step 1: Reemplazar el bloque de endpoints viejo**

En `src/server.js`, reemplazar el bloque completo desde `// ── Notas (anotador sin IA, sin sesión de Claude) ──` (línea 454) hasta el cierre del `app.post('/api/notes/upload', ...)` (línea 496) por:

```javascript
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
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'nombre vacío' });
  const nb = notes.renameNotebook(req.params.id, name);
  if (!nb) return res.status(404).json({ error: 'libreta no encontrada' });
  res.json(nb);
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
  res.status(201).json({ entry, notebook: nb });
});
```

- [ ] **Step 2: Verificación manual — levantar el server en un puerto aparte**

Run (en background, para no pisar el Jarvis real que corre en 3777):
```bash
cd "/c/Users/User/Desktop/Proyectos/claude-chat-manager"
PORT=3988 ACCESS_PIN= node src/server.js &
sleep 1
```
Expected: log `Claude Chat Manager en http://127.0.0.1:3988`

- [ ] **Step 3: Verificación manual — crear libretas y listar**

Run:
```bash
curl -s -X POST http://127.0.0.1:3988/api/notebooks
curl -s -X POST http://127.0.0.1:3988/api/notebooks
curl -s http://127.0.0.1:3988/api/notebooks
```
Expected: los dos primeros curls devuelven `{"id":"...","name":"Nueva libreta","createdAt":...}` y `{"id":"...","name":"Nueva libreta 2","createdAt":...}`; el tercero devuelve `{"notebooks":[...ambas, cada una con "lastActivity" igual a su "createdAt"...]}`.

- [ ] **Step 4: Verificación manual — renombrar, texto, auto-nombre**

Run (reemplazar `<id1>` por el `id` de la primera libreta creada en el Step 3):
```bash
curl -s -X PATCH http://127.0.0.1:3988/api/notebooks/<id1> -H "Content-Type: application/json" -d '{"name":"Recetas"}'
curl -s -X POST http://127.0.0.1:3988/api/notebooks
curl -s http://127.0.0.1:3988/api/notebooks
```
Expected: el PATCH devuelve `{"id":"<id1>","name":"Recetas",...}`; el nuevo POST crea `"Nueva libreta"` de nuevo (el nombre "Nueva libreta" quedó libre porque la libreta 1 se renombró) en vez de `"Nueva libreta 3"`; el listado final muestra "Recetas", "Nueva libreta 2" y esta última "Nueva libreta".

Run (reemplazar `<id2>` por el `id` de "Nueva libreta 2"):
```bash
curl -s -X POST http://127.0.0.1:3988/api/notebooks/<id2>/notes -H "Content-Type: application/json" -d '{"text":"Comprar leche mañana"}'
curl -s http://127.0.0.1:3988/api/notebooks
```
Expected: el POST devuelve `{"entry":{...,"type":"text","text":"Comprar leche mañana"},"notebook":{"id":"<id2>","name":"Comprar leche mañana",...}}` (se auto-renombró desde el default); el listado confirma que esa libreta ahora se llama "Comprar leche mañana" con `lastActivity` actualizado.

Run (mandar una segunda nota a la misma libreta):
```bash
curl -s -X POST http://127.0.0.1:3988/api/notebooks/<id2>/notes -H "Content-Type: application/json" -d '{"text":"segunda nota"}'
```
Expected: el `notebook` en la respuesta sigue siendo `"Comprar leche mañana"` (ya no matchea el patrón default, el auto-rename no la vuelve a tocar).

- [ ] **Step 5: Verificación manual — archivo y aislamiento entre libretas**

Run:
```bash
curl -s -X POST http://127.0.0.1:3988/api/notebooks/<id2>/notes/upload -F "file=@package.json"
curl -s http://127.0.0.1:3988/api/notebooks/<id2>/notes
curl -s http://127.0.0.1:3988/api/notebooks/<id1>/notes
ls -la ~/Desktop/"Notas Jarvis"/
```
Expected: el upload devuelve `201` con `entry.type:"file"`; `GET /notes` de `<id2>` muestra las 2 notas de texto + el archivo (3 entradas); `GET /notes` de `<id1>` ("Recetas") devuelve `{"notes":[]}` — vacía, no se mezcló nada entre libretas; el archivo aparece en la carpeta compartida.

Run (id inexistente):
```bash
curl -s -w " [%{http_code}]" http://127.0.0.1:3988/api/notebooks/no-existe/notes
curl -s -w " [%{http_code}]" -X POST http://127.0.0.1:3988/api/notebooks/no-existe/notes -H "Content-Type: application/json" -d '{"text":"x"}'
```
Expected: ambos devuelven `404` con `{"error":"libreta no encontrada"}`.

- [ ] **Step 6: Apagar el server de prueba**

Run: `kill %1` (o el PID que haya quedado del `node src/server.js &` del Step 2)
Expected: sin proceso node escuchando en 3988 (`curl http://127.0.0.1:3988/api/notebooks` falla con connection refused).

- [ ] **Step 7: Confirmar que la suite de tests existente sigue en verde**

Run: `npm test`
Expected: PASS, mismos tests que al final de Task 1.

- [ ] **Step 8: Commit**

```bash
git add src/server.js
git commit -m "feat(notes): endpoints /api/notebooks* (múltiples libretas, reemplaza /api/notes)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Lista de libretas + abrir/cerrar reusando el panel del chat + notas de texto

**Files:**
- Modify: `public/index.html:13,49-66,122-123,240` (versión de cache-busting, markup de la lista, vista de detalle dentro de `#panel-chat`)
- Modify: `public/style.css:273,281,302-308,925` (extender selectores de header/back-btn/título para que los comparta la libreta), y agregar reglas nuevas al final del archivo
- Modify: `public/app.js:11-121,603-640,649-652,1696` (estado, render/carga, `goToPane`, wiring, hook en `selectConv`); reemplaza `public/app.js:2616-2707` (composer viejo) por el nuevo wiring de composer

**Interfaces:**
- Consumes: `GET /api/notebooks`, `POST /api/notebooks`, `PATCH /api/notebooks/:id`, `GET/POST /api/notebooks/:id/notes` (Task 2); `$()`, `api()`, `toast()`, `copyToClipboard()`, `autoResize()`, `isTouchDevice`, `IMAGE_EXTS`, `avatarChar()`, `openChat()`, `closeChat()`, `isMobile()` (ya existentes en `app.js`).
- Produces: `let notebooks`, `let currentNotebook` (`{id, name}` o `null`), `let notesData`; `function showNotebookView(show)`, `async function openNotebook(id, name)`, `async function loadNotebookList()`, `function renderNotebookList()` — consumidos por Task 4 (subida de archivos + polling).

- [ ] **Step 1: `index.html` — bump de versión de cache-busting**

En las líneas 13 y 240, cambiar `?v=33` por `?v=34` en `style.css?v=33` y `app.js?v=33`.

- [ ] **Step 2: `index.html` — `#tree-notes` pasa a ser la lista de libretas**

Reemplazar el bloque (líneas 49-66):

```html
          <div id="tree-notes" class="tree-pane notes-pane">
            <div class="notes-header">
              <button type="button" id="notes-back" class="archived-back">← Volver a chats</button>
              <h2>📝 Notas</h2>
            </div>
            <div id="notes-messages" class="notes-messages"></div>
            <div id="notes-attachments" class="notes-attachments"></div>
            <form id="notes-composer" class="notes-composer">
              <input id="notes-file-input" type="file" hidden multiple>
              <button id="notes-attach-btn" type="button" title="Adjuntar archivo" aria-label="Adjuntar archivo">
                <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5a2.5 2.5 0 0 1 5 0v10.5c0 .83-.67 1.5-1.5 1.5s-1.5-.67-1.5-1.5V6H9v9.5a2.5 2.5 0 0 0 5 0V5c0-2.21-1.79-4-4-4S6 2.79 6 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>
              </button>
              <textarea id="notes-input" rows="1" placeholder="Escribí una nota…"></textarea>
              <button id="notes-send" type="submit" aria-label="Enviar">
                <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
              </button>
            </form>
          </div>
```

por:

```html
          <div id="tree-notes" class="tree-pane notes-pane">
            <div class="notes-header">
              <button type="button" id="notes-back" class="archived-back">← Volver a chats</button>
              <h2>📝 Notas</h2>
              <button type="button" id="notebook-new-btn" class="notebook-new-btn" title="Nueva libreta" aria-label="Nueva libreta">+</button>
            </div>
            <nav id="notebook-list"></nav>
          </div>
```

- [ ] **Step 3: `index.html` — vista de detalle de libreta, dentro de `#panel-chat`**

Insertar, inmediatamente antes del `</div>` que cierra `#panel-chat` (línea 123, justo después del `</form>` que cierra `#composer`):

```html
      <!-- Notas: libreta abierta — reusa este mismo panel/overlay/back que el chat -->
      <div id="notebook-view" class="notes-pane" hidden>
        <header id="notebook-header">
          <button id="notebook-back-btn" aria-label="Volver" title="Volver">
            <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
          </button>
          <div id="notebook-info">
            <span id="notebook-title">Libreta</span>
          </div>
        </header>
        <div id="notes-messages" class="notes-messages"></div>
        <div id="notes-attachments" class="notes-attachments"></div>
        <form id="notes-composer" class="notes-composer">
          <input id="notes-file-input" type="file" hidden multiple>
          <button id="notes-attach-btn" type="button" title="Adjuntar archivo" aria-label="Adjuntar archivo">
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5a2.5 2.5 0 0 1 5 0v10.5c0 .83-.67 1.5-1.5 1.5s-1.5-.67-1.5-1.5V6H9v9.5a2.5 2.5 0 0 0 5 0V5c0-2.21-1.79-4-4-4S6 2.79 6 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>
          </button>
          <textarea id="notes-input" rows="1" placeholder="Escribí una nota…"></textarea>
          <button id="notes-send" type="submit" aria-label="Enviar">
            <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
        </form>
      </div>
```

- [ ] **Step 4: `style.css` — reusar los estilos de `#chat-header`/`#conv-info`/`#conv-title`/`#back-btn` para la libreta**

Cambiar (línea 273):
```css
#chat-header {
```
por:
```css
#chat-header, #notebook-header {
```

Cambiar (línea 281):
```css
#back-btn {
```
por:
```css
#back-btn, #notebook-back-btn {
```

Cambiar (línea 302):
```css
#conv-info { flex: 1; min-width: 0; }
```
por:
```css
#conv-info, #notebook-info { flex: 1; min-width: 0; }
```

Cambiar (línea 303):
```css
#conv-title {
```
por:
```css
#conv-title, #notebook-title {
```

Cambiar (línea 308):
```css
#conv-title[contenteditable] { outline: 1px dashed var(--accent); border-radius: 3px; }
```
por:
```css
#conv-title[contenteditable], #notebook-title[contenteditable] { outline: 1px dashed var(--accent); border-radius: 3px; }
```

En el bloque `@media (max-width: 767px)`, cambiar (línea 925):
```css
  #back-btn { display: flex; }
```
por:
```css
  #back-btn, #notebook-back-btn { display: flex; }
```

- [ ] **Step 5: `style.css` — tamaño de la vista de detalle, lista de libretas y botón "+" (append al final del archivo)**

```css
/* ── Notas: lista y detalle de libretas ── */
#notebook-view { flex: 1; min-height: 0; }
#notebook-list { flex: 1; overflow-y: auto; }
#notebook-list::-webkit-scrollbar { width: 4px; }
#notebook-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
.notebook-new-btn {
  background: none; border: none; color: var(--text2); cursor: pointer;
  width: 30px; height: 30px; border-radius: 50%; font-size: 18px; line-height: 1;
  flex: none; display: flex; align-items: center; justify-content: center;
}
.notebook-new-btn:hover { background: var(--border); color: var(--text); }
.notes-empty { padding: 24px 12px; text-align: center; color: var(--text2); font-size: 13px; }
```

- [ ] **Step 6: `app.js` — reemplazar el estado y el bloque de render/carga de notas (líneas 11-121)**

Reemplazar el bloque completo desde `let activePane = 0;` (línea 11) hasta el cierre de `safeLoadNotes` (línea 121) por:

```javascript
let activePane = 0; // 0=chats 1=archived 2=notas
let notebookListLoaded = false;
let notebooks = [];
let currentNotebook = null; // {id, name} de la libreta abierta, o null si estamos en la lista
let notesData = [];

function noteTimeLabel(ts) {
  return new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}

function renderNoteBubble(entry) {
  const div = document.createElement('div');
  div.className = 'note-bubble';

  if (entry.type === 'file') {
    div.classList.add('note-bubble-file');
    const ext = (entry.fileName.split('.').pop() || '').toLowerCase();
    if (IMAGE_EXTS.has(ext)) {
      const img = document.createElement('img');
      img.className = 'note-file-thumb';
      img.alt = entry.fileName;
      img.src = '/api/thumbnail?path=' + encodeURIComponent(entry.filePath);
      div.appendChild(img);
    }
    const name = document.createElement('div');
    name.className = 'note-file-name';
    name.textContent = entry.fileName;
    div.appendChild(name);
    const meta = document.createElement('div');
    meta.className = 'note-file-meta';
    meta.textContent = (entry.size ? (entry.size / 1024).toFixed(0) + ' KB · ' : '') + entry.filePath;
    div.appendChild(meta);
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'note-copy-btn';
    copyBtn.textContent = 'Copiar ruta';
    copyBtn.onclick = () => copyToClipboard(entry.filePath);
    div.appendChild(copyBtn);
  } else {
    div.classList.add('note-bubble-text');
    const text = document.createElement('div');
    text.className = 'note-text';
    text.textContent = entry.text;
    div.appendChild(text);
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'note-copy-btn';
    copyBtn.textContent = 'Copiar';
    copyBtn.onclick = () => copyToClipboard(entry.text);
    div.appendChild(copyBtn);
  }

  const time = document.createElement('div');
  time.className = 'note-time';
  time.textContent = noteTimeLabel(entry.ts);
  div.appendChild(time);

  return div;
}

function renderNotes(scrollToBottom = true) {
  const wrap = $('notes-messages');
  wrap.innerHTML = '';
  if (notesData.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'notes-empty';
    empty.textContent = 'No hay notas todavía — escribí algo o adjuntá un archivo.';
    wrap.appendChild(empty);
  } else {
    for (const entry of notesData) wrap.appendChild(renderNoteBubble(entry));
  }
  if (scrollToBottom) wrap.scrollTop = wrap.scrollHeight;
}

// Combina lo que devuelve el server con lo que ya tenemos en memoria: un push
// optimista (composer de texto / upload) puede no estar todavía en la
// respuesta de un poll que salió antes de que el POST terminara. Si lo
// pisáramos sin más, la nota recién mandada desaparece hasta el próximo poll.
// Une por id (así una entrada optimista se reemplaza por la del server en
// cuanto aparece ahí, sin quedar duplicada) y ordena por ts.
function mergeNotes(incoming, current) {
  const byId = new Map(incoming.map(n => [n.id, n]));
  for (const entry of current) {
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }
  return Array.from(byId.values()).sort((a, b) => a.ts - b.ts);
}

async function loadNotes() {
  if (!currentNotebook) return;
  const { notes } = await api(`/notebooks/${currentNotebook.id}/notes`);
  const merged = mergeNotes(notes, notesData);

  // Nada cambió (mismo largo y mismo último id): no tocar el DOM ni el
  // scroll. Evita que el poll de 5s le arruine al usuario una selección de
  // texto o lo empuje al final si estaba leyendo notas viejas más arriba.
  const prevLast = notesData[notesData.length - 1];
  const mergedLast = merged[merged.length - 1];
  const unchanged = merged.length === notesData.length &&
    (!mergedLast || (prevLast && mergedLast.id === prevLast.id));
  if (unchanged) return;

  const wrap = $('notes-messages');
  const wasNearBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80;

  notesData = merged;
  renderNotes(wasNearBottom);
}

let notesPolling = false;
async function safeLoadNotes() {
  if (notesPolling) return; // ya hay un poll en vuelo, no pisarlo con otro
  notesPolling = true;
  try { await loadNotes(); }
  // Falla silenciosa: es polling de fondo, el próximo tick a los 5s se
  // autocura. El error SÍ se muestra en la carga inicial (openNotebook, con
  // su propio try/catch).
  catch { /* noop */ }
  finally { notesPolling = false; }
}

// ── Notas: lista de libretas ──
function notebookElement(nb) {
  const div = document.createElement('div');
  div.className = 'conv';
  div.innerHTML = `
    <div class="conv-avatar">${avatarChar(nb.name)}</div>
    <div class="conv-body">
      <div class="name"><span class="conv-name-text"></span></div>
      <div class="sub"><span class="conv-date"></span></div>
    </div>
  `;
  div.querySelector('.conv-name-text').textContent = nb.name;
  div.querySelector('.conv-date').textContent = nb.lastActivity
    ? new Date(nb.lastActivity).toLocaleString('es', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : 'Sin notas todavía';
  div.onclick = () => openNotebook(nb.id, nb.name);
  return div;
}

function renderNotebookList() {
  const nav = $('notebook-list');
  nav.innerHTML = '';
  for (const nb of notebooks) nav.appendChild(notebookElement(nb));
}

async function loadNotebookList() {
  const { notebooks: list } = await api('/notebooks');
  notebooks = list;
  renderNotebookList();
}

async function safeLoadNotebookList() {
  try { await loadNotebookList(); }
  catch { /* noop: polling de fondo, se autocura en el próximo tick */ }
}

// ── Notas: abrir/cerrar una libreta reusando el panel/overlay del chat ──
// Mismo mecanismo que ya usan los chats (#panel-chat, clase .open,
// history.pushState para el botón atrás de Android) — ver el diseño en
// docs/superpowers/specs/2026-08-13-notas-libretas-design.md. show=true
// oculta la vista de chat y muestra la de libreta; show=false es lo inverso
// (lo usa selectConv al abrir un chat real, por si había una libreta abierta).
function showNotebookView(show) {
  $('chat-header').hidden = show;
  $('messages-wrap').hidden = show;
  $('composer-attachments').hidden = show;
  $('composer').hidden = show;
  $('notebook-view').hidden = !show;
}

async function openNotebook(id, name) {
  currentNotebook = { id, name };
  $('notebook-title').textContent = name;
  notesData = [];
  renderNotes();
  showNotebookView(true);
  openChat();
  try { await loadNotes(); }
  catch (err) { toast('No se pudieron cargar las notas: ' + err.message); }
}
```

- [ ] **Step 7: `app.js` — `goToPane` carga la lista de libretas en vez del stub viejo**

Dentro de `goToPane`, reemplazar:

```javascript
  if (index === 2 && !notesPaneLoaded) {
    try {
      await loadNotes();
      notesPaneLoaded = true;
    } catch (err) {
      toast('No se pudo cargar notas: ' + err.message);
      if (myGeneration === paneNavGeneration) paneNavTarget = activePane;
      return;
    }
  }
```

por:

```javascript
  if (index === 2 && !notebookListLoaded) {
    try {
      await loadNotebookList();
      notebookListLoaded = true;
    } catch (err) {
      toast('No se pudieron cargar las libretas: ' + err.message);
      if (myGeneration === paneNavGeneration) paneNavTarget = activePane;
      return;
    }
  }
```

- [ ] **Step 8: `app.js` — wiring de "+", back-btn y renombrar (insertar después de `$('notes-back').onclick = () => goToPane(0);`)**

```javascript
$('notebook-back-btn').onclick = closeChat;

$('notebook-new-btn').onclick = async () => {
  try {
    const nb = await api('/notebooks', { method: 'POST' });
    notebooks.push(nb);
    renderNotebookList();
    openNotebook(nb.id, nb.name);
  } catch (err) { toast('No se pudo crear la libreta: ' + err.message); }
};

// ── Renombrar libreta (doble click en el título, mismo patrón que #conv-title) ──
$('notebook-title').ondblclick = () => {
  if (!currentNotebook) return;
  const el = $('notebook-title');
  el.contentEditable = 'true';
  el.focus();
  el.onblur = async () => {
    el.contentEditable = 'false';
    const name = el.textContent.trim();
    if (!name || name === currentNotebook.name) { el.textContent = currentNotebook.name; return; }
    try {
      const nb = await api(`/notebooks/${currentNotebook.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      currentNotebook.name = nb.name;
      el.textContent = nb.name;
      const idx = notebooks.findIndex(n => n.id === nb.id);
      if (idx !== -1) notebooks[idx] = { ...notebooks[idx], ...nb };
    } catch (err) {
      el.textContent = currentNotebook.name;
      toast('No se pudo renombrar: ' + err.message);
    }
  };
  el.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); el.blur(); } };
};
```

- [ ] **Step 9: `app.js` — `selectConv` vuelve a mostrar la vista de chat si había una libreta abierta**

En `selectConv`, cambiar:

```javascript
  setBusy(false);
  clearAttachments();
  openChat();
```

por:

```javascript
  setBusy(false);
  clearAttachments();
  showNotebookView(false);
  openChat();
```

- [ ] **Step 10: `app.js` — reemplazar el composer viejo (líneas 2616-2707) por el nuevo, scopeado a la libreta abierta**

Reemplazar el bloque completo desde `// ── Notas: composer de texto ──` hasta el cierre del `document.addEventListener('visibilitychange', ...)` de Notas (el resto del archivo, hasta el final) por:

```javascript
// ── Notas: composer de texto ──
$('notes-input').addEventListener('input', () => autoResize($('notes-input')));
$('notes-input').addEventListener('keydown', e => {
  if (isTouchDevice) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('notes-composer').requestSubmit();
  }
});

$('notes-composer').addEventListener('submit', async e => {
  e.preventDefault();
  if (!currentNotebook) return;
  const input = $('notes-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  autoResize(input);
  try {
    const { entry, notebook } = await api(`/notebooks/${currentNotebook.id}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    notesData.push(entry);
    renderNotes();
    if (notebook && notebook.name !== currentNotebook.name) {
      currentNotebook.name = notebook.name;
      $('notebook-title').textContent = notebook.name;
      const idx = notebooks.findIndex(n => n.id === notebook.id);
      if (idx !== -1) notebooks[idx] = { ...notebooks[idx], ...notebook };
    }
  } catch (err) {
    input.value = text;
    autoResize(input);
    toast('No se pudo guardar la nota: ' + err.message);
  }
});
```

(La subida de archivos y el polling entre dispositivos se agregan en el próximo task — por ahora el botón de adjuntar de la libreta no hace nada al tocarlo, lo cual no rompe nada.)

- [ ] **Step 11: Verificación manual — desktop**

Run: iniciar el server normal (o usar el ya corriendo en 3777) y abrir `http://127.0.0.1:3777` en una ventana ancha (≥768px).
Expected:
- La pestaña "📝 Notas" muestra una lista vacía con un botón "+".
- Tocar "+" crea "Nueva libreta" y la abre de inmediato — aparece el mismo panel donde antes se veían los chats, ahora con header "Nueva libreta", vacío ("No hay notas todavía…") y el composer abajo.
- Escribir "Comprar leche" y enviar: aparece la burbuja, y el título del header cambia a "Comprar leche" (auto-nombre desde la primera nota).
- Doble click en el título, escribir "Recetas", Enter: el título cambia y persiste al recargar la página.
- Tocar "← Volver a chats" en la lista de libretas: vuelve al pane de Chats (sin relación con la libreta abierta).
- Volver a "📝 Notas": la libreta "Recetas" aparece en la lista con la fecha/hora de la última nota.
- Crear una segunda libreta con "+": se llama "Nueva libreta" (no "Nueva libreta 2" — el nombre quedó libre porque la primera ya se renombró) y no comparte notas con la primera.

- [ ] **Step 12: Verificación manual — mobile (DevTools, ancho <768px)**

Run: activar el modo dispositivo, ir al pane de Notas (swipe x2 desde Chats), crear/abrir una libreta.
Expected: la libreta se abre a pantalla completa (mismo overlay que un chat), con flecha atrás arriba a la izquierda. Tocar la flecha atrás vuelve a la lista de libretas (no a Chats). El botón atrás físico/gesto de Android hace lo mismo (cierra el overlay, vuelve a la lista) — confirmar en la consola que no hay errores.

- [ ] **Step 13: Correr la suite de tests de backend**

Run: `npm test`
Expected: PASS, sin cambios respecto a Task 2 (este task es 100% frontend).

- [ ] **Step 14: Commit**

```bash
git add public/index.html public/style.css public/app.js
git commit -m "feat(notes): lista de libretas + abrir/cerrar reusando el panel de chat

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Adjuntar archivos + sincronización por polling (lista y libreta abierta)

**Files:**
- Modify: `public/app.js` (append al final del archivo)

**Interfaces:**
- Consumes: `POST /api/notebooks/:id/notes/upload` (Task 2); `currentNotebook`, `notesData`, `renderNotes`, `safeLoadNotes`, `safeLoadNotebookList`, `activePane`, `isMobile()` (Task 3); `prepareForUpload()`, `netFetch()` (ya existentes en `app.js`, usados por el composer de chat).
- Produces: ninguna interfaz nueva consumida por otro task — es la última pieza de funcionalidad.

- [ ] **Step 1: `app.js` — subida de archivos, scopeada a la libreta abierta (append al final del archivo)**

```javascript
// ── Notas: adjuntar archivos ──
// Mismo problema ya resuelto para el composer de chat y para la v1 de Notas:
// un File que sale del picker de galería del celu es un handle a content://
// (Android) o a la fototeca (iOS), no bytes en memoria — subirlo crudo
// funciona con una foto recién sacada de la cámara pero falla con una
// elegida de la galería si el uplink tarda y el sistema invalida el handle a
// mitad de camino. prepareForUpload ya resuelve esto (materializa a Blob +
// comprime fotos grandes) — reusarlo acá en vez de mandar `file` directo.
async function uploadNoteFile(file) {
  if (!currentNotebook) return;
  const displayName = file.name || `pegado-${Date.now()}.${(file.type.split('/')[1] || 'bin')}`;
  const loadingChip = document.createElement('div');
  loadingChip.className = 'attach-chip attach-chip-loading';
  loadingChip.innerHTML = `<span class="attach-spinner"></span><span class="attach-chip-name"></span>`;
  loadingChip.querySelector('.attach-chip-name').textContent = displayName;
  $('notes-attachments').appendChild(loadingChip);

  const t0 = Date.now();
  let sentBytes = 0;
  try {
    const { blob, name: uploadName } = await prepareForUpload(file, displayName);
    sentBytes = blob.size;
    const fd = new FormData();
    fd.append('file', blob, uploadName);
    const res = await netFetch(`/api/notebooks/${currentNotebook.id}/notes/upload`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const { entry } = await res.json();
    notesData.push(entry);
    renderNotes();
  } catch (err) {
    const detalle = sentBytes
      ? ` [${(sentBytes / 1024 / 1024).toFixed(1)}MB, ${((Date.now() - t0) / 1000).toFixed(1)}s]`
      : ` [falló al preparar, ${((Date.now() - t0) / 1000).toFixed(1)}s]`;
    toast('No se pudo subir el archivo: ' + err.message + detalle);
  } finally {
    loadingChip.remove();
  }
}

$('notes-attach-btn').onclick = () => { $('notes-file-input').click(); };
$('notes-file-input').onchange = async () => {
  const files = Array.from($('notes-file-input').files);
  $('notes-file-input').value = '';
  for (const f of files) await uploadNoteFile(f);
};
```

- [ ] **Step 2: `app.js` — polling: lista de libretas o libreta abierta, según qué esté visible (append al final del archivo)**

```javascript
// ── Notas: sincronización entre dispositivos por polling ──
// 5s (no los 15s del árbol de chats) porque un uso central es "mandar un
// archivo del celu y pasar a la PC a buscarlo enseguida". Sin SSE nuevo: ver
// razones documentadas en la spec (mismo problema de conexiones idle que ya
// se resolvió a los ponchazos para /stream).
//
// notebookIsVisible() distingue si lo que se está mirando ahora mismo es la
// libreta abierta o la lista: en mobile #notebook-view solo cuenta si el
// overlay #panel-chat está .open (si no, aunque currentNotebook siga seteado
// de la última libreta vista, lo que hay en pantalla es la lista); en
// desktop el panel de detalle no es un overlay — su visibilidad depende
// solo de qué contenido tiene cargado ahora.
function notebookIsVisible() {
  if (isMobile()) return $('panel-chat').classList.contains('open') && !$('notebook-view').hidden;
  return !$('notebook-view').hidden;
}

function pollNotesPane() {
  if (activePane !== 2) return;
  if (notebookIsVisible()) safeLoadNotes(); else safeLoadNotebookList();
}

setInterval(pollNotesPane, 5000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) pollNotesPane();
});
```

- [ ] **Step 3: Verificación manual — subida de archivo**

Run: en Jarvis, abrir una libreta, tocar el botón de adjuntar y elegir un archivo cualquiera (ej. una imagen).
Expected: aparece un chip "cargando…", luego una burbuja con nombre + tamaño + ruta (y thumbnail si es imagen), botón "Copiar ruta" copia la ruta completa. El archivo aparece en `C:\Users\User\Desktop\Notas Jarvis\`.

- [ ] **Step 4: Verificación manual — sincronización entre dispositivos, lista y detalle**

Run: abrir Jarvis en dos pestañas, ambas en el pane "📝 Notas" — pestaña A mirando la lista, pestaña B con una libreta abierta. Desde una tercera vía (curl, o una tercera pestaña) crear una libreta nueva y mandarle una nota de texto.
Expected: dentro de los 5s siguientes, la pestaña A (lista) muestra la libreta nueva; si en la pestaña B se manda una nota a la libreta que tiene abierta desde otra pestaña/dispositivo, aparece también dentro de los 5s (o al instante si se le da foco a esa pestaña).

- [ ] **Step 5: Correr toda la suite de tests una última vez**

Run: `npm test`
Expected: PASS — todos los tests preexistentes + los de `notes.test.js`, en verde.

- [ ] **Step 6: Commit**

```bash
git add public/app.js
git commit -m "feat(notes): adjuntar archivos y sincronización por polling (lista + libreta abierta)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Verificación final end-to-end + limpieza de todo el branch

**Files:**
- Ninguno predeterminado — este task revisa y corrige lo que haga falta en cualquiera de los archivos tocados por Tasks 1-4.

**Interfaces:**
- No produce ni consume interfaces nuevas — es la pasada de cierre, mismo rol que tuvo el commit final de la v1 de Notas (`8d4f2f2`, "cleanup pass on final whole-branch review").

- [ ] **Step 1: Levantar el server real y verificar con Playwright el flujo mobile completo**

Usar las tools `mcp__playwright__*` (`browser_navigate`, `browser_resize` a un viewport mobile, `browser_snapshot`, `browser_click`, `browser_type`, `browser_file_upload`, `browser_console_messages`) contra el Jarvis real corriendo en `http://127.0.0.1:3777`, replicando el flujo que en la v1 destapó los dos bugs reales (banner de instalar tapando clicks, archivo de galería sin materializar):

1. Swipe/navegación hasta el pane de Notas.
2. Crear una libreta, escribir una nota, adjuntar un archivo.
3. Volver a la lista con el botón atrás — confirmar que aparece la libreta con la actividad actualizada.
4. Abrir de nuevo la libreta — confirmar que la nota y el archivo siguen ahí.
5. Revisar `browser_console_messages` — sin errores.

Expected: los 5 pasos funcionan sin error de consola ni de red.

- [ ] **Step 2: Revisar todo el diff del branch con ojos frescos**

Run: `git diff master --stat` y `git diff master` (o revisar archivo por archivo)
Expected: buscar específicamente:
- Restos de la v1 de un solo notebook (`notesPaneLoaded`, referencias a `/api/notes` sin `/notebooks/:id`, etc.) — no debería quedar ninguno.
- Que `showNotebookView(false)` se llame en cualquier otro lugar donde se abra un chat real además de `selectConv` (buscar otros callers de `openChat()`).
- Que el mensaje de error de "libreta no encontrada" (404) en el frontend no deje al usuario en un estado roto si borra manualmente `notebooks.json` mientras Jarvis está abierto.

Corregir inline lo que aparezca.

- [ ] **Step 3: Correr toda la suite de tests una vez más**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit final de limpieza (si el Step 2 encontró algo para corregir)**

```bash
git add -A
git commit -m "fix: cleanup pass on final whole-branch review of libretas de Notas

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

Si el Step 2 no encontró nada para corregir, se omite este commit y el branch queda listo para el flujo de `finishing-a-development-branch` (push + PR), igual que la v1.
