# Notas (anotador sin IA) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar a Jarvis una libreta "Notas" (texto + archivos, sin IA) accesible como tercer panel junto a Chats/Archivado, con los archivos cayendo en una carpeta real del Escritorio.

**Architecture:** Módulo de storage propio (`src/notes.js`, jsonl append-only + carpeta de archivos) sin tocar la lógica de sesiones de Claude (scanner/runner/meta). El mecanismo de paneles deslizantes que hoy alterna Chats↔Archivadas se generaliza de 2 a 3 estados (`activePane` 0/1/2) y se le suma una barra de pestañas visible solo en desktop (≥768px); en mobile se navega igual que hoy, por swipe, ahora con dos swipes hasta Notas. Sincronización entre dispositivos por polling (5s), no SSE — evita repetir el problema de conexiones idle del túnel Cloudflare ya documentado para `/stream`.

**Tech Stack:** Node.js/Express (server.js existente), multer (upload), vanilla JS + CSS (frontend existente, sin build step), `node --test` para tests de backend.

**Spec:** `docs/superpowers/specs/2026-08-11-notas-jarvis-design.md`

## Global Constraints

- Todo endpoint nuevo vive detrás del mismo `ACCESS_PIN` que ya protege `/api/*` (server.js:82-98) — no se agrega autenticación nueva.
- Sin SSE/websockets nuevos para Notas — solo polling.
- Una sola libreta (no hay múltiples "notebooks" en v1).
- Archivos de Notas van a `~/Desktop/Notas Jarvis/` (carpeta visible, no `.ccm-uploads`).
- Texto de Notas va a `~/.ccm-notes/notes.jsonl` (append-only), sin relación con `~/.claude/session-manager/meta.json` ni con el scanner de sesiones.
- No se toca ningún archivo bajo `src/scanner.js`, `src/runner.js`, `src/claude-cmd.js` — el módulo de Notas es standalone.

---

### Task 1: Módulo de storage `src/notes.js`

**Files:**
- Create: `src/notes.js`
- Test: `test/notes.test.js`

**Interfaces:**
- Produces: `append(entry, file = NOTES_FILE)` → escribe una línea jsonl, devuelve `entry` tal cual. `readAll(file = NOTES_FILE)` → `Array<object>` en orden de inserción, saltea líneas corruptas. `ensureFilesDir(dir = FILES_DIR)` → crea el directorio si no existe, lo devuelve. `resolveDestName(dir, originalName)` → `string`, nombre final sin colisión. Constantes exportadas: `NOTES_DIR`, `NOTES_FILE`, `FILES_DIR`.
- `entry` no tiene shape fijo impuesto por este módulo — el caller (Task 2) decide los campos (`id`, `ts`, `type`, etc.). `notes.js` solo persiste/lee objetos.

- [ ] **Step 1: Escribir los tests (van a fallar — el módulo no existe todavía)**

```javascript
// test/notes.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { append, readAll, resolveDestName, ensureFilesDir } = require('../src/notes');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-notes-')), 'sub', 'notes.jsonl');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-notes-dir-'));

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
```

- [ ] **Step 2: Correr los tests y confirmar que fallan**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/notes'`

- [ ] **Step 3: Implementar `src/notes.js`**

```javascript
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || os.homedir();
const NOTES_DIR = path.join(HOME_DIR, '.ccm-notes');
const NOTES_FILE = path.join(NOTES_DIR, 'notes.jsonl');
const FILES_DIR = path.join(HOME_DIR, 'Desktop', 'Notas Jarvis');

// Agrega una entrada al final del jsonl. No genera id/ts — el caller (server.js)
// ya los arma, así este módulo queda testeable con objetos arbitrarios.
function append(entry, file = NOTES_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  return entry;
}

// Lee todas las entradas en orden de inserción (el archivo es append-only, así
// que el orden del archivo ES el orden cronológico). Una línea corrupta no
// tira abajo el resto: se salta y se loguea.
function readAll(file = NOTES_FILE) {
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

module.exports = { append, readAll, ensureFilesDir, resolveDestName, NOTES_DIR, NOTES_FILE, FILES_DIR };
```

- [ ] **Step 4: Correr los tests y confirmar que pasan**

Run: `npm test`
Expected: PASS — todos los tests de `test/notes.test.js`, y los 58 preexistentes siguen en verde.

- [ ] **Step 5: Commit**

```bash
git add src/notes.js test/notes.test.js
git commit -m "feat(notes): módulo de storage jsonl para la libreta de Notas

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Endpoints HTTP `/api/notes*`

**Files:**
- Modify: `src/server.js:1-11` (requires), `src/server.js:451-453` (inserción de endpoints, justo después de `/api/files` y antes de `DEFAULT_TREE_LIMIT`)

**Interfaces:**
- Consumes: `notes.append`, `notes.readAll`, `notes.ensureFilesDir`, `notes.resolveDestName`, `notes.FILES_DIR` (Task 1).
- Produces: `GET /api/notes` → `{ notes: Array<entry> }`. `POST /api/notes` `{text}` → `201` con el `entry` creado (`{id, ts, type:'text', text}`). `POST /api/notes/upload` (multipart, campo `file`) → `201` con el `entry` creado (`{id, ts, type:'file', fileName, filePath, mime, size}`). Todos protegidos por el mismo middleware de `ACCESS_PIN` ya existente (no hace falta tocarlo: se registra antes que estas rutas).

- [ ] **Step 1: Agregar el require de `notes.js`**

En `src/server.js`, modificar la línea 8 (justo debajo de `const scanner = require('./scanner');`):

```javascript
const scanner = require('./scanner');
const notes = require('./notes');
```

- [ ] **Step 2: Agregar los endpoints**

En `src/server.js`, insertar el siguiente bloque inmediatamente después del cierre del endpoint `/api/files` (línea 451, `});`) y antes de `const DEFAULT_TREE_LIMIT = 100;` (línea 453):

```javascript
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
```

- [ ] **Step 3: Verificación manual — levantar el server en un puerto aparte**

Run (en background, para no pisar el Jarvis real que corre en 3777):
```bash
cd "/c/Users/User/Desktop/Proyectos/claude-chat-manager"
PORT=3988 ACCESS_PIN= node src/server.js &
sleep 1
```
Expected: log `Claude Chat Manager en http://127.0.0.1:3988`

- [ ] **Step 4: Verificación manual — texto**

Run:
```bash
curl -s -X POST http://127.0.0.1:3988/api/notes -H "Content-Type: application/json" -d '{"text":"primera nota de prueba"}'
curl -s http://127.0.0.1:3988/api/notes
```
Expected: el primer curl devuelve `{"id":"...","ts":...,"type":"text","text":"primera nota de prueba"}`; el segundo devuelve `{"notes":[{...esa misma entrada...}]}`.

- [ ] **Step 5: Verificación manual — archivo**

Run:
```bash
curl -s -X POST http://127.0.0.1:3988/api/notes/upload -F "file=@package.json"
ls -la ~/Desktop/"Notas Jarvis"/
curl -s -X POST http://127.0.0.1:3988/api/notes/upload -F "file=@package.json"
ls -la ~/Desktop/"Notas Jarvis"/
```
Expected: primer curl devuelve un `entry` con `type:"file"`, `fileName:"package.json"` y `filePath` apuntando a `Desktop\Notas Jarvis\package.json`; `ls` muestra el archivo. El segundo curl (mismo nombre) devuelve un `filePath` distinto con timestamp antepuesto (`Desktop\Notas Jarvis\<timestamp>-package.json`), y el `ls` final muestra los dos archivos sin que ninguno se haya pisado.

- [ ] **Step 6: Apagar el server de prueba**

Run: `kill %1` (o el PID que haya quedado del `node src/server.js &` del Step 3)
Expected: sin proceso node escuchando en 3988 (`curl http://127.0.0.1:3988/api/notes` falla con connection refused).

- [ ] **Step 7: Confirmar que la suite de tests existente sigue en verde (server.js no rompió nada)**

Run: `npm test`
Expected: PASS, mismos tests que antes + los de `notes.test.js`.

- [ ] **Step 8: Commit**

```bash
git add src/server.js
git commit -m "feat(notes): endpoints GET/POST /api/notes y POST /api/notes/upload

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Generalizar el panel deslizante de 2 a 3 estados + pestañas desktop

**Files:**
- Modify: `public/index.html:13,35-45,217` (link de versión, tab bar, tercer panel)
- Modify: `public/style.css:138-152,858-885,892-904` (ancho/transform de 3 paneles, tab bar, quitar `.archived-toggle`)
- Modify: `public/app.js:11,441-448,490-515,2208-2247` (estado `activePane`, `goToPane`, swipe, wiring de pestañas)

**Interfaces:**
- Produces: `let activePane` (0/1/2), `async function goToPane(index)` (navega y dispara la carga perezosa del panel 1 o 2 si hace falta), `let notesPaneLoaded` (bool), `async function loadNotes()` (stub en este task — Task 4 lo completa; acá solo deja `notesData = []` y no revienta), `let notesData` (array). Estas cuatro piezas las consume Task 4/5.
- Consumes: nada nuevo de tasks anteriores (es puramente frontend/markup).

- [ ] **Step 1: `index.html` — agregar la barra de pestañas (solo visible en desktop)**

En `public/index.html`, insertar inmediatamente después de la línea 35 (`</header>`) y antes de la línea 36 (`<div id="ptr-indicator" hidden>`):

```html
      <nav id="pane-tabs">
        <button type="button" class="pane-tab active" data-pane="0">Chats</button>
        <button type="button" class="pane-tab" data-pane="1">Archivado</button>
        <button type="button" class="pane-tab" data-pane="2">📝 Notas</button>
      </nav>
```

- [ ] **Step 2: `index.html` — agregar el tercer panel (Notas) dentro de `#tree-viewport-inner`**

Reemplazar el bloque de las líneas 40-45:

```html
      <div id="tree-viewport">
        <div id="tree-viewport-inner">
          <nav id="tree" class="tree-pane"></nav>
          <nav id="tree-archived" class="tree-pane"></nav>
        </div>
      </div>
```

por:

```html
      <div id="tree-viewport">
        <div id="tree-viewport-inner" data-pane="0">
          <nav id="tree" class="tree-pane"></nav>
          <nav id="tree-archived" class="tree-pane"></nav>
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
        </div>
      </div>
```

- [ ] **Step 3: `index.html` — bump de versión de cache-busting**

En las líneas 13 y 217, cambiar `?v=32` por `?v=33` en `style.css?v=32` y `app.js?v=32` (server.js ya manda `Cache-Control: no-store` para estos archivos — el bump es solo para mantener la convención existente del proyecto).

- [ ] **Step 4: `style.css` — 3 paneles en vez de 2 + estilos del panel de Notas**

Reemplazar las líneas 141-152:

```css
#tree-viewport { flex: 1; overflow: hidden; position: relative; }
#tree-viewport-inner {
  display: flex;
  width: 200%;
  height: 100%;
  transition: transform .25s ease;
  touch-action: pan-y;
}
#tree-viewport-inner.showing-archived { transform: translateX(-50%); }
.tree-pane { width: 50%; flex: none; height: 100%; overflow-y: auto; }
.tree-pane::-webkit-scrollbar { width: 4px; }
.tree-pane::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
```

por:

```css
#tree-viewport { flex: 1; overflow: hidden; position: relative; }
#tree-viewport-inner {
  display: flex;
  width: 300%;
  height: 100%;
  transition: transform .25s ease;
  touch-action: pan-y;
}
#tree-viewport-inner[data-pane="1"] { transform: translateX(-33.3333%); }
#tree-viewport-inner[data-pane="2"] { transform: translateX(-66.6667%); }
.tree-pane { width: 33.3333%; flex: none; height: 100%; overflow-y: auto; }
.tree-pane::-webkit-scrollbar { width: 4px; }
.tree-pane::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

.notes-pane { display: flex; flex-direction: column; overflow: hidden; }
.notes-header {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 12px; border-bottom: 1px solid var(--border); flex: none;
}
.notes-header h2 { font-size: 14px; margin: 0; flex: 1; }
.notes-header .archived-back { width: auto; margin: 0; padding: 6px 8px; border: none; font-size: 13px; }
.notes-messages { flex: 1; overflow-y: auto; padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; }
.notes-attachments { padding: 0 12px; display: flex; flex-wrap: wrap; gap: 6px; }
.notes-composer { display: flex; gap: 6px; padding: 8px 12px; border-top: 1px solid var(--border); align-items: flex-end; flex: none; }
.notes-composer textarea {
  flex: 1; resize: none; max-height: 120px; padding: 8px 10px;
  background: var(--input-bg); border: none; border-radius: var(--radius);
  color: var(--text); font-family: var(--chat-font); font-size: var(--chat-size);
}
.notes-composer button {
  background: none; border: none; color: var(--text2); cursor: pointer;
  width: 36px; height: 36px; flex: none; display: flex; align-items: center; justify-content: center;
}
.notes-composer button:hover { color: var(--text); }
```

- [ ] **Step 5: `style.css` — barra de pestañas (solo desktop ≥768px)**

Insertar después de la línea 139 (`#ptr-indicator svg { animation: spin .6s linear infinite; }`) y antes de `#tree-viewport { ... }`:

```css
#pane-tabs { display: none; }
@media (min-width: 768px) {
  #pane-tabs {
    display: flex; flex: none;
    border-bottom: 1px solid var(--border);
  }
  .pane-tab {
    flex: 1; background: none; border: none; cursor: pointer;
    padding: 10px 4px; font-size: 13px; color: var(--text2);
    border-bottom: 2px solid transparent;
  }
  .pane-tab:hover { color: var(--text); }
  .pane-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
}
```

- [ ] **Step 6: `style.css` — quitar `.archived-toggle` (reemplazado por las pestañas de desktop; ya estaba oculto en mobile)**

Borrar la línea `.archived-toggle { display: none; }` (dentro del bloque `@media (max-width: 767px)`, cerca de la línea 884) y borrar el bloque completo (líneas ~892-904):

```css
.archived-toggle {
  display: block;
  width: calc(100% - 20px);
  margin: 8px 10px 12px;
  padding: 8px;
  background: transparent;
  color: var(--text2);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  font-size: 12px;
}
.archived-toggle:hover { background: var(--input-bg); color: var(--text); }
```

- [ ] **Step 7: `app.js` — generalizar el estado de 2 a 3 paneles**

Reemplazar la línea 11 (`let viewingArchived = false;`) por:

```javascript
let activePane = 0; // 0=chats 1=archived 2=notas
let notesPaneLoaded = false;
let notesData = [];

// Implementación real en el próximo task — acá solo evita que goToPane(2)
// rompa mientras no existe el fetch/render todavía.
async function loadNotes() { notesData = []; }
```

- [ ] **Step 8: `app.js` — quitar el botón `.archived-toggle` de `loadTree()` y actualizar el label de la pestaña "Archivado"**

Reemplazar el bloque (líneas 441-448):

```javascript
  if (archivedTotal > 0) {
    const t = document.createElement('button');
    t.className = 'archived-toggle';
    t.type = 'button';
    t.textContent = `Ver archivadas (${archivedTotal})`;
    t.onclick = () => { goToArchived(); };
    nav.appendChild(t);
  }
```

por:

```javascript
  const archTab = document.querySelector('.pane-tab[data-pane="1"]');
  if (archTab) archTab.textContent = archivedTotal > 0 ? `Archivado (${archivedTotal})` : 'Archivado';
```

- [ ] **Step 9: `app.js` — reemplazar `goToArchived`/`goToActive`/`resetArchivedPane` por `goToPane` genérico**

Reemplazar el bloque (líneas 490-515):

```javascript
async function goToArchived() {
  if (viewingArchived) return;
  if (!archivedPaneLoaded) {
    try {
      await loadArchivedTree();
      archivedPaneLoaded = true;
    } catch (err) {
      toast('No se pudo cargar archivadas: ' + err.message);
      return;
    }
  }
  viewingArchived = true;
  $('tree-viewport-inner').classList.add('showing-archived');
}

function goToActive() {
  viewingArchived = false;
  $('tree-viewport-inner').classList.remove('showing-archived');
}

function resetArchivedPane() {
  archivedPaneLoaded = false;
  archivedTreeLimit = 100;
  $('tree-archived').innerHTML = '';
  if (viewingArchived) goToActive();
}
```

por:

```javascript
async function goToPane(index) {
  if (index === activePane) return;
  if (index === 1 && !archivedPaneLoaded) {
    try {
      await loadArchivedTree();
      archivedPaneLoaded = true;
    } catch (err) {
      toast('No se pudo cargar archivadas: ' + err.message);
      return;
    }
  }
  if (index === 2 && !notesPaneLoaded) {
    try {
      await loadNotes();
      notesPaneLoaded = true;
    } catch (err) {
      toast('No se pudo cargar notas: ' + err.message);
      return;
    }
  }
  activePane = index;
  $('tree-viewport-inner').dataset.pane = String(index);
  document.querySelectorAll('.pane-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.pane === String(index));
  });
}

function resetArchivedPane() {
  archivedPaneLoaded = false;
  archivedTreeLimit = 100;
  $('tree-archived').innerHTML = '';
  if (activePane === 1) goToPane(0);
}

document.querySelectorAll('.pane-tab').forEach(btn => {
  btn.onclick = () => goToPane(Number(btn.dataset.pane));
});
$('notes-back').onclick = () => goToPane(0);
```

- [ ] **Step 10: `app.js` — actualizar el botón "← Volver a activas" de `loadArchivedTree()`**

En la función `loadArchivedTree()`, cambiar:

```javascript
  back.onclick = () => { goToActive(); };
```

por:

```javascript
  back.onclick = () => { goToPane(0); };
```

- [ ] **Step 11: `app.js` — generalizar el swipe de pantalla a 3 posiciones**

Reemplazar el bloque `paneSwipeMove`/`paneSwipeEnd` (líneas ~2208-2247):

```javascript
function paneSwipeMove(clientX, clientY) {
  if (!paneDragging) return false;
  const dx = clientX - paneStartX;
  const dy = clientY - paneStartY;
  if (paneAxisLocked === null) {
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return false;
    paneAxisLocked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
  }
  if (paneAxisLocked !== 'x') return false;
  const base = viewingArchived ? -paneViewportWidth() : 0;
  paneCurrentTranslate = Math.min(0, Math.max(-paneViewportWidth(), base + dx));
  $('tree-viewport-inner').style.transform = `translateX(${paneCurrentTranslate}px)`;
  return true;
}

async function paneSwipeEnd() {
  if (!paneDragging) return;
  paneDragging = false;
  const inner = $('tree-viewport-inner');

  try {
    if (paneAxisLocked === 'x') {
      const base = viewingArchived ? -paneViewportWidth() : 0;
      const delta = paneCurrentTranslate - base;
      // Navigate first (await if async), THEN clear inline styles so CSS class transform can take over
      if (!viewingArchived && delta < -PANE_SWIPE_THRESHOLD) {
        paneNavigating = true;
        await goToArchived();
      } else if (viewingArchived && delta > PANE_SWIPE_THRESHOLD) {
        paneNavigating = true;
        goToActive();
      }
    }
  } finally {
    inner.style.transition = '';
    inner.style.transform = '';
    paneAxisLocked = null;
    paneNavigating = false;
  }
}
```

por:

```javascript
const PANE_COUNT = 3;

function paneSwipeMove(clientX, clientY) {
  if (!paneDragging) return false;
  const dx = clientX - paneStartX;
  const dy = clientY - paneStartY;
  if (paneAxisLocked === null) {
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return false;
    paneAxisLocked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
  }
  if (paneAxisLocked !== 'x') return false;
  const base = -activePane * paneViewportWidth();
  const min = -(PANE_COUNT - 1) * paneViewportWidth();
  paneCurrentTranslate = Math.min(0, Math.max(min, base + dx));
  $('tree-viewport-inner').style.transform = `translateX(${paneCurrentTranslate}px)`;
  return true;
}

async function paneSwipeEnd() {
  if (!paneDragging) return;
  paneDragging = false;
  const inner = $('tree-viewport-inner');

  try {
    if (paneAxisLocked === 'x') {
      const base = -activePane * paneViewportWidth();
      const delta = paneCurrentTranslate - base;
      // Navigate first (await if async), THEN clear inline styles so CSS attribute transform can take over
      if (delta < -PANE_SWIPE_THRESHOLD && activePane < PANE_COUNT - 1) {
        paneNavigating = true;
        await goToPane(activePane + 1);
      } else if (delta > PANE_SWIPE_THRESHOLD && activePane > 0) {
        paneNavigating = true;
        await goToPane(activePane - 1);
      }
    }
  } finally {
    inner.style.transition = '';
    inner.style.transform = '';
    paneAxisLocked = null;
    paneNavigating = false;
  }
}
```

- [ ] **Step 12: Verificación manual — desktop**

Run: iniciar el server normal (o usar el ya corriendo en 3777) y abrir `http://127.0.0.1:3777` en una ventana ancha (≥768px).
Expected:
- Aparece la barra de 3 pestañas debajo del header ("Chats" / "Archivado" o "Archivado (N)" / "📝 Notas").
- Clic en "Archivado" desliza al panel de archivadas (mismo comportamiento que antes, ya no depende del botón viejo).
- Clic en "📝 Notas" desliza a un panel vacío con header "📝 Notas", botón "← Volver a chats", lista vacía y composer — sin errores en la consola del navegador.
- Clic en "Chats" vuelve al árbol normal.
- No quedan referencias a `.archived-toggle` ni a `goToArchived`/`goToActive`/`viewingArchived` (buscar en `public/app.js`).

- [ ] **Step 13: Verificación manual — mobile**

Run: en DevTools, activar el modo dispositivo (ancho <768px).
Expected: la barra de pestañas está oculta; deslizando el dedo (o simulando touch) de derecha a izquierda sobre la lista de chats se llega primero a Archivado, y con un segundo swipe se llega a Notas; swipe de vuelta (izquierda a derecha) recorre el camino inverso.

- [ ] **Step 14: Correr la suite de tests de backend (nada debería haberse roto — este task es 100% frontend)**

Run: `npm test`
Expected: PASS, sin cambios respecto a Task 2.

- [ ] **Step 15: Commit**

```bash
git add public/index.html public/style.css public/app.js
git commit -m "feat(notes): generaliza el panel deslizante Chats/Archivado a 3 estados + pestañas desktop

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Render de notas + composer de texto

**Files:**
- Modify: `public/app.js` (reemplazar el stub `loadNotes` del Task 3, agregar render + wiring del composer de texto; append al final del archivo)
- Modify: `public/style.css` (append — clases de burbuja de Notas)

**Interfaces:**
- Consumes: `GET /api/notes`, `POST /api/notes` (Task 2); `activePane`, `notesData`, `notesPaneLoaded`, `goToPane` (Task 3); `api()`, `toast()`, `copyToClipboard()`, `autoResize()`, `isTouchDevice`, `IMAGE_EXTS` (ya existentes en `app.js`).
- Produces: `function renderNotes()`, `async function loadNotes()` (reemplaza el stub), `async function safeLoadNotes()` — consumidas por Task 5 (polling).

- [ ] **Step 1: `app.js` — reemplazar el stub de `loadNotes` (agregado en Task 3, Step 7) por la implementación real**

Reemplazar:

```javascript
// Implementación real en el próximo task — acá solo evita que goToPane(2)
// rompa mientras no existe el fetch/render todavía.
async function loadNotes() { notesData = []; }
```

por:

```javascript
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

function renderNotes() {
  const wrap = $('notes-messages');
  wrap.innerHTML = '';
  for (const entry of notesData) wrap.appendChild(renderNoteBubble(entry));
  wrap.scrollTop = wrap.scrollHeight;
}

async function loadNotes() {
  const { notes } = await api('/notes');
  notesData = notes;
  renderNotes();
}

async function safeLoadNotes() {
  try { await loadNotes(); }
  catch (err) { toast('No se pudo actualizar notas: ' + err.message); }
}
```

- [ ] **Step 2: `app.js` — wiring del composer de texto (append al final del archivo)**

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
  const input = $('notes-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  autoResize(input);
  try {
    const entry = await api('/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    notesData.push(entry);
    renderNotes();
  } catch (err) {
    input.value = text;
    autoResize(input);
    toast('No se pudo guardar la nota: ' + err.message);
  }
});
```

- [ ] **Step 3: `style.css` — burbujas de Notas (append al final del archivo)**

```css
/* ── Notas: burbujas ── */
.note-bubble {
  align-self: flex-start; max-width: 90%;
  background: var(--bubble-me); border-radius: var(--radius);
  padding: 7px 12px 18px; position: relative;
  font-family: var(--chat-font); font-size: var(--chat-size);
  white-space: pre-wrap; word-break: break-word;
}
.note-text { line-height: 1.45; }
.note-file-name { font-weight: 600; }
.note-file-meta { font-size: 11px; color: var(--text2); word-break: break-all; margin-top: 2px; }
.note-file-thumb { max-width: 180px; max-height: 180px; border-radius: 6px; display: block; margin-bottom: 6px; }
.note-copy-btn {
  display: block; margin-top: 6px;
  background: var(--input-bg); border: none; color: var(--text2);
  border-radius: 12px; padding: 3px 10px; font-size: 11px; cursor: pointer;
}
.note-copy-btn:hover { color: var(--text); }
.note-time { position: absolute; right: 10px; bottom: 4px; font-size: 10px; color: var(--text2); opacity: .8; }
```

- [ ] **Step 4: Verificación manual**

Run: abrir Jarvis, ir a la pestaña/panel "📝 Notas", escribir "nota de prueba" y enviar (Enter en desktop o botón enviar).
Expected: aparece una burbuja con el texto, hora abajo a la derecha, y botón "Copiar" que copia el texto al portapapeles (confirma con el toast "Copiado"). Recargar la página y volver a Notas: la nota sigue ahí (se releyó de `~/.ccm-notes/notes.jsonl`).

Run: `cat ~/.ccm-notes/notes.jsonl` (en el server real corriendo en 3777, no el de prueba de Task 2)
Expected: una línea JSON por nota enviada.

- [ ] **Step 5: Commit**

```bash
git add public/app.js public/style.css
git commit -m "feat(notes): render de burbujas y composer de texto para Notas

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Adjuntar archivos + sincronización por polling

**Files:**
- Modify: `public/app.js` (append al final del archivo)

**Interfaces:**
- Consumes: `POST /api/notes/upload` (Task 2); `renderNotes()`, `notesData`, `safeLoadNotes()`, `activePane` (Task 3/4); `netFetch()` (ya existente en `app.js`).
- Produces: ninguna interfaz nueva consumida por otro task — es la última pieza.

- [ ] **Step 1: `app.js` — subida de archivos (append al final del archivo)**

```javascript
// ── Notas: adjuntar archivos ──
async function uploadNoteFile(file) {
  const loadingChip = document.createElement('div');
  loadingChip.className = 'attach-chip attach-chip-loading';
  loadingChip.innerHTML = `<span class="attach-spinner"></span><span class="attach-chip-name"></span>`;
  loadingChip.querySelector('.attach-chip-name').textContent = file.name || 'archivo';
  $('notes-attachments').appendChild(loadingChip);

  try {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const res = await netFetch('/api/notes/upload', { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const entry = await res.json();
    notesData.push(entry);
    renderNotes();
  } catch (err) {
    toast('No se pudo subir el archivo: ' + err.message);
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

- [ ] **Step 2: `app.js` — polling liviano mientras el panel de Notas está abierto (append al final del archivo)**

```javascript
// ── Notas: sincronización entre dispositivos por polling ──
// 5s (no los 15s del árbol de chats) porque un uso central es "mandar un
// archivo del celu y pasar a la PC a buscarlo enseguida". Sin SSE nuevo: ver
// razones documentadas en la spec (mismo problema de conexiones idle que ya
// se resolvió a los ponchazos para /stream).
setInterval(() => { if (activePane === 2) safeLoadNotes(); }, 5000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && activePane === 2) safeLoadNotes();
});
```

- [ ] **Step 3: Verificación manual — subida de archivo**

Run: en Jarvis, ir a "📝 Notas", tocar el botón de adjuntar y elegir un archivo cualquiera (ej. una imagen).
Expected: aparece un chip "cargando…", luego una burbuja con nombre + tamaño + ruta (y thumbnail si es imagen), botón "Copiar ruta" copia la ruta completa. El archivo aparece en `C:\Users\User\Desktop\Notas Jarvis\`.

Run: repetir la subida del mismo archivo (mismo nombre) una segunda vez.
Expected: la segunda burbuja muestra una ruta distinta (con timestamp antepuesto) y ambos archivos conviven en la carpeta sin pisarse.

- [ ] **Step 4: Verificación manual — sincronización entre dispositivos**

Run: abrir Jarvis en dos pestañas/dispositivos distintos (o dos ventanas del navegador), ambas en el panel "📝 Notas". Mandar un texto desde la pestaña A.
Expected: la pestaña B muestra la nota nueva dentro de los 5 segundos siguientes (o al instante si se le da foco a la pestaña B antes de que pase el intervalo — dispara el refresh de `visibilitychange`).

- [ ] **Step 5: Correr toda la suite de tests una última vez**

Run: `npm test`
Expected: PASS — 58+ tests preexistentes + los de `notes.test.js`, todos en verde.

- [ ] **Step 6: Commit**

```bash
git add public/app.js
git commit -m "feat(notes): adjuntar archivos y sincronización por polling entre dispositivos

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```
