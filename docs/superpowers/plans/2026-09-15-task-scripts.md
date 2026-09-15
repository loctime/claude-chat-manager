# Task: catálogo de tareas ejecutadas por script — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar un modo de ejecución `execution:'script'` a las tareas del catálogo de la pestaña Agenda/Task, para que una tarea recurrente pueda correr un script determinístico (sin gastar tokens) en vez de spawnear siempre una conversación de chat, con un modo prueba obligatorio antes de cualquier acción real — y una Skill de proyecto (`crear-tarea`) que investiga y arma cada tarea nueva.

**Architecture:** Cada tarea-script vive en `src/tasks/<archivo>.js` con un único contrato `run({state, input, dryRun, task})`. Un runner genérico (`src/task-runner.js`) lo invoca con timeout; tres endpoints genéricos en `routes/agenda.js` (`/run`, `/verify`, `/reset-run`) son los únicos puntos de entrada — nunca hace falta escribir una ruta nueva por tarea. El front renderiza la pausa actual (`ui.type`) con un único renderer genérico. El estado de una corrida vive junto al resto del estado mensual de la tarea en `agenda.json`, así sobrevive reinicios y esperas largas.

**Tech Stack:** Node.js (`node --test`), Express, JS clásico sin bundler del lado del cliente (`public/agenda.js`, scripts globales sin módulos).

**Spec:** `docs/superpowers/specs/2026-09-15-task-scripts-design.md`

## Global Constraints

- Toda tarea sin `execution` explícito se comporta como `execution:'chat'` (comportamiento actual, sin romper el catálogo existente).
- El server fuerza `dryRun:true` cuando `!task.verified`, sin importar lo que mande el cliente — nadie puede saltarse el modo prueba desde la UI.
- Ningún script puede duplicar una acción irreversible al reintentar — regla obligatoria documentada en el contrato y en la Skill.
- Un único endpoint genérico de ejecución (`/api/agenda/:id/run`) para todas las tareas-script — nunca una ruta nueva por tarea.
- Ninguna pausa mantiene un proceso vivo esperando input — todo es llamadas HTTP independientes sobre estado persistido.
- Cada llamada a `run()` tiene un límite de 90 segundos (por debajo del límite de idle del túnel de Cloudflare que expone esta app, ~100s — ver `CLAUDE.local.md`). Ajustado desde los "2 minutos" del spec original por este límite de infraestructura real.
- La etiqueta visible de la pestaña cambia a "Task"; ids internos, nombres de módulo (`agenda.js`) y rutas (`/api/agenda/...`) no se tocan.
- La Skill nunca crea, pide ni asume credenciales por su cuenta — siempre dice qué falta y dónde guardarlo, y recomienda hacerlo desde otra sesión si es sensible.

---

### Task 1: Modelo de datos — ejecución por script en `src/agenda.js`

**Files:**
- Modify: `src/agenda.js` (funciones `read`, `write`, `migrateLegacySeed`, `list`, `markDone`, `addCustomTask`, `module.exports`)
- Test: `test/agenda.test.js` (nuevo — hoy `agenda.js` no tiene tests)

**Interfaces:**
- Consumes: nada nuevo (módulo independiente).
- Produces (usado por Task 3):
  - `agenda.list(file?)` → cada item suma `execution: 'chat'|'script'`, `scriptModule: string|null`, `verified: boolean`, `runStatus: 'idle'|'waiting'|'error'|'done'`, `runUi: object|null`, `runError: string|null`.
  - `agenda.getRunState(id, file?)` → `object` (vacío si no hay corrida previa).
  - `agenda.saveRunResult(id, { state, ui }, file?)` → persiste, marca `hecho` si `ui.type==='listo'`, devuelve `data.tasks[id]` actualizado (con `.run.status`) o `null` si la tarea no existe.
  - `agenda.saveRunError(id, message, file?)` → devuelve `data.tasks[id]` actualizado o `null`.
  - `agenda.resetRun(id, file?)` → devuelve `data.tasks[id]` actualizado o `null`.
  - `agenda.setTaskVerified(id, verified?, file?)` → devuelve el `customTask` actualizado, o `null` si no existe o no es `execution:'script'`.
  - `agenda.addCustomTask({..., execution?, scriptModule?}, file?)` → sin cambios de comportamiento cuando no se pasan los campos nuevos.

Todas las funciones tocadas suman un último parámetro opcional `file` (default `AGENDA_FILE`) — mismo patrón que ya usan `notes.js`/`meta.js` en este repo para poder testear sin tocar el `agenda.json` real del usuario. Ningún call site existente en `routes/agenda.js` pasa ese argumento, así que su comportamiento no cambia.

- [ ] **Step 1: Escribir los tests (van a fallar, las funciones todavía no existen/cambiaron)**

Crear `test/agenda.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const agenda = require('../src/agenda');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-agenda-')), 'sub', 'agenda.json');

test('addCustomTask con execution chat (default) no agrega scriptModule/verified', () => {
  const file = tmpFile();
  const task = agenda.addCustomTask({ title: 'Rutina X', group: 'Grupo' }, file);
  assert.equal(task.execution, 'chat');
  assert.equal(task.scriptModule, undefined);
  assert.equal(task.verified, undefined);
});

test('addCustomTask con execution script arranca verified:false', () => {
  const file = tmpFile();
  const task = agenda.addCustomTask({ title: 'Facturar X', group: 'Facturación', execution: 'script', scriptModule: 'facturar_x.js' }, file);
  assert.equal(task.execution, 'script');
  assert.equal(task.scriptModule, 'facturar_x.js');
  assert.equal(task.verified, false);
});

test('list() expone execution/scriptModule/verified/runStatus por default', () => {
  const file = tmpFile();
  agenda.addCustomTask({ title: 'Facturar Y', execution: 'script', scriptModule: 'facturar_y.js' }, file);
  const [task] = agenda.list(file);
  assert.equal(task.execution, 'script');
  assert.equal(task.scriptModule, 'facturar_y.js');
  assert.equal(task.verified, false);
  assert.equal(task.runStatus, 'idle');
  assert.equal(task.runUi, null);
  assert.equal(task.runError, null);
});

test('setTaskVerified activa una tarea-script', () => {
  const file = tmpFile();
  const task = agenda.addCustomTask({ title: 'Facturar Z', execution: 'script', scriptModule: 'facturar_z.js' }, file);
  const updated = agenda.setTaskVerified(task.id, true, file);
  assert.equal(updated.verified, true);
  const [listed] = agenda.list(file);
  assert.equal(listed.verified, true);
});

test('setTaskVerified devuelve null si la tarea no existe o no es script', () => {
  const file = tmpFile();
  assert.equal(agenda.setTaskVerified('no-existe', true, file), null);
  const chatTask = agenda.addCustomTask({ title: 'Charla normal' }, file);
  assert.equal(agenda.setTaskVerified(chatTask.id, true, file), null);
});

test('saveRunResult guarda state/ui y deja runStatus waiting si no terminó', () => {
  const file = tmpFile();
  const task = agenda.addCustomTask({ title: 'Facturar W', execution: 'script', scriptModule: 'facturar_w.js' }, file);
  agenda.saveRunResult(task.id, { state: { paso: 1 }, ui: { type: 'pedir-dato', pregunta: '¿Código?' } }, file);
  const [listed] = agenda.list(file);
  assert.equal(listed.runStatus, 'waiting');
  assert.deepEqual(listed.runUi, { type: 'pedir-dato', pregunta: '¿Código?' });
  assert.deepEqual(agenda.getRunState(task.id, file), { paso: 1 });
});

test('saveRunResult con ui.type listo marca la tarea hecha y no pierde el run', () => {
  const file = tmpFile();
  const task = agenda.addCustomTask({ title: 'Facturar V', execution: 'script', scriptModule: 'facturar_v.js' }, file);
  agenda.saveRunResult(task.id, { state: { paso: 2 }, ui: { type: 'listo' } }, file);
  const [listed] = agenda.list(file);
  assert.equal(listed.state, 'hecho');
  assert.equal(listed.runStatus, 'done');
});

test('saveRunError guarda el mensaje y preserva el state previo', () => {
  const file = tmpFile();
  const task = agenda.addCustomTask({ title: 'Facturar U', execution: 'script', scriptModule: 'facturar_u.js' }, file);
  agenda.saveRunResult(task.id, { state: { paso: 1 }, ui: { type: 'accion', boton: 'Seguir' } }, file);
  agenda.saveRunError(task.id, 'El portal no respondió', file);
  const [listed] = agenda.list(file);
  assert.equal(listed.runStatus, 'error');
  assert.equal(listed.runError, 'El portal no respondió');
  assert.deepEqual(agenda.getRunState(task.id, file), { paso: 1 });
});

test('resetRun limpia el estado de la corrida sin tocar el semáforo', () => {
  const file = tmpFile();
  const task = agenda.addCustomTask({ title: 'Facturar T', execution: 'script', scriptModule: 'facturar_t.js' }, file);
  agenda.saveRunResult(task.id, { state: { paso: 1 }, ui: { type: 'accion', boton: 'Seguir' } }, file);
  agenda.resetRun(task.id, file);
  const [listed] = agenda.list(file);
  assert.equal(listed.runStatus, 'idle');
  assert.equal(listed.runUi, null);
  assert.deepEqual(agenda.getRunState(task.id, file), {});
});

test('markDone y addCustomTask siguen funcionando igual con el file explícito (regresión)', () => {
  const file = tmpFile();
  const task = agenda.addCustomTask({ title: 'Tarea vieja' }, file);
  agenda.markDone(task.id, true, file);
  const [listed] = agenda.list(file);
  assert.equal(listed.state, 'hecho');
});
```

- [ ] **Step 2: Correr los tests y confirmar que fallan**

Run: `npm test -- --test-name-pattern="addCustomTask|list|setTaskVerified|saveRun|resetRun|markDone"`
Expected: FAIL — `agenda.setTaskVerified is not a function` (y similares para `saveRunResult`/`saveRunError`/`resetRun`/`getRunState`).

- [ ] **Step 3: Implementar los cambios en `src/agenda.js`**

Reemplazar `read`/`write` (hoy sin parámetro de archivo) por:

```js
function read(file = AGENDA_FILE) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return emptyState(); }
  let data;
  try { data = JSON.parse(raw); }
  catch { return emptyState(); }
  data.tasks = data.tasks || {};
  data.customTasks = data.customTasks || [];
  data = migrateLegacySeed(data, file);
  if (data.period !== currentPeriod()) {
    const fresh = emptyState();
    fresh.macarena = data.macarena || fresh.macarena;
    fresh.customTasks = data.customTasks || fresh.customTasks;
    fresh.migratedLegacyCatalog = data.migratedLegacyCatalog;
    write(fresh, file);
    return fresh;
  }
  data.tasks = data.tasks || {};
  data.macarena = data.macarena || emptyState().macarena;
  data.customTasks = data.customTasks || [];
  return data;
}

function write(data, file = AGENDA_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
```

Actualizar `migrateLegacySeed` para recibir y propagar `file`:

```js
function migrateLegacySeed(data, file = AGENDA_FILE) {
  if (data.migratedLegacyCatalog) return data;
  const hadLegacyProgress = LEGACY_SEED_CATALOG.some(t => data.tasks[t.id]);
  if (hadLegacyProgress) {
    const existingIds = new Set((data.customTasks || []).map(t => t.id));
    for (const task of LEGACY_SEED_CATALOG) {
      if (!existingIds.has(task.id)) data.customTasks.push({ ...task, learned: true });
    }
  }
  data.migratedLegacyCatalog = true;
  write(data, file);
  return data;
}
```

Actualizar `list`:

```js
function list(file = AGENDA_FILE) {
  const data = read(file);
  return allTasks(data).map(task => {
    const ts = data.tasks[task.id] || { state: 'pendiente', doneAt: null };
    const items = ts.items || {};
    const checklistState = Array.isArray(task.checklist)
      ? task.checklist.map((text, i) => ({
          text,
          done: items[i] ? items[i].state === 'hecho' : false,
          doneAt: items[i] ? items[i].doneAt : null,
        }))
      : null;
    const run = ts.run || null;
    return {
      ...task,
      ...ts,
      checklistState,
      color: colorFor(task, ts),
      execution: task.execution || 'chat',
      scriptModule: task.scriptModule || null,
      verified: !!task.verified,
      runStatus: run ? run.status : 'idle',
      runUi: run ? run.ui : null,
      runError: run ? run.error : null,
    };
  });
}
```

Actualizar `addCustomTask`:

```js
function addCustomTask({ title, group, day, kind, insumoNota, execution, scriptModule }, file = AGENDA_FILE) {
  const data = read(file);
  const id = 'custom_' + (title || 'tarea').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    .slice(0, 40) + '_' + Date.now().toString(36);
  const task = {
    id,
    title: title || 'Tarea nueva',
    group: group || 'Aprendidas',
    day: (day === '' || day == null) ? null : Number(day),
    kind: kind || 'auto',
    insumoNota: insumoNota || '',
    learned: true,
    execution: execution === 'script' ? 'script' : 'chat',
  };
  if (task.execution === 'script') {
    task.scriptModule = scriptModule || null;
    task.verified = false;
  }
  data.customTasks.push(task);
  write(data, file);
  return task;
}
```

Actualizar `markDone` para aceptar `file` (agregar el parámetro y pasarlo a `read`/`write`):

```js
function markDone(id, done = true, file = AGENDA_FILE) {
  const data = read(file);
  const task = allTasks(data).find(t => t.id === id);
  if (!task) return null;
  const doneAt = done ? Date.now() : null;
  const out = { state: done ? 'hecho' : 'pendiente', doneAt };
  if (Array.isArray(task.checklist) && task.checklist.length) {
    const items = {};
    task.checklist.forEach((_, i) => { items[i] = { state: done ? 'hecho' : 'pendiente', doneAt }; });
    out.items = items;
  }
  data.tasks[id] = out;
  write(data, file);
  return data.tasks[id];
}
```

Agregar las funciones nuevas (después de `markItem`, antes de `setWaiting`):

```js
// ── Ejecución de tareas-script (ver docs/superpowers/specs/2026-09-15-task-scripts-design.md) ──
// El "run" de una tarea vive junto al resto de su estado mensual en
// data.tasks[id] (mismo objeto que ya guarda state/doneAt/items) para que
// resetee solo cuando cambia el período, igual que el resto del semáforo.

function getRunState(id, file = AGENDA_FILE) {
  const data = read(file);
  const ts = data.tasks[id];
  return (ts && ts.run && ts.run.state) || {};
}

// Guarda el resultado de una corrida (real o dry-run). Si el script señala
// que terminó (ui.type === 'listo'), marca la tarea hecha primero —
// markDone reemplaza data.tasks[id] entero, así que el campo `run` se suma
// DESPUÉS, nunca antes, para que no se pise.
function saveRunResult(id, { state, ui }, file = AGENDA_FILE) {
  const data = read(file);
  if (!allTasks(data).find(t => t.id === id)) return null;
  const status = ui && ui.type === 'listo' ? 'done' : 'waiting';
  if (status === 'done') markDone(id, true, file);
  const fresh = read(file);
  const prev = fresh.tasks[id] || { state: 'pendiente', doneAt: null };
  fresh.tasks[id] = { ...prev, run: { state: state || {}, status, ui: ui || null, error: null } };
  write(fresh, file);
  return fresh.tasks[id];
}

function saveRunError(id, message, file = AGENDA_FILE) {
  const data = read(file);
  if (!allTasks(data).find(t => t.id === id)) return null;
  const prev = data.tasks[id] || { state: 'pendiente', doneAt: null };
  const prevRun = prev.run || { state: {}, ui: null };
  data.tasks[id] = { ...prev, run: { state: prevRun.state, status: 'error', ui: prevRun.ui, error: message } };
  write(data, file);
  return data.tasks[id];
}

function resetRun(id, file = AGENDA_FILE) {
  const data = read(file);
  if (!allTasks(data).find(t => t.id === id)) return null;
  const prev = data.tasks[id] || { state: 'pendiente', doneAt: null };
  data.tasks[id] = { ...prev, run: { state: {}, status: 'idle', ui: null, error: null } };
  write(data, file);
  return data.tasks[id];
}

// Pasa una tarea-script de "modo prueba" a activada de verdad — la Skill
// nunca llama esto por su cuenta, es una confirmación explícita del usuario
// desde la tarjeta ("✅ Confirmar y activar"). No aplica a execution:'chat'.
function setTaskVerified(id, verified = true, file = AGENDA_FILE) {
  const data = read(file);
  const task = data.customTasks.find(t => t.id === id);
  if (!task || task.execution !== 'script') return null;
  task.verified = !!verified;
  write(data, file);
  return task;
}
```

Actualizar `module.exports`:

```js
module.exports = {
  CATALOG, list, markDone, markItem, setWaiting, getMacarena, updateMacarena,
  addCustomTask, removeCustomTask, currentPeriod, AGENDA_FILE,
  setTaskVerified, saveRunResult, saveRunError, resetRun, getRunState,
};
```

- [ ] **Step 4: Correr los tests y confirmar que pasan**

Run: `npm test`
Expected: PASS (todos los tests existentes siguen pasando + los nuevos de `test/agenda.test.js`).

- [ ] **Step 5: Commit**

```bash
git add src/agenda.js test/agenda.test.js
git commit -m "feat(agenda): modelo de datos para tareas ejecutadas por script"
```

---

### Task 2: Runner genérico de scripts (`src/task-runner.js`)

**Files:**
- Create: `src/task-runner.js`
- Test: `test/task-runner.test.js`

**Interfaces:**
- Consumes: nada de Task 1 (módulo independiente).
- Produces (usado por Task 3): `runTaskScript(task, { state, input, dryRun }, tasksDir?, timeoutMs?)` → `Promise<{ state, ui }>`. `task` necesita al menos `{ scriptModule }`. Rechaza (throw) si el módulo no existe, no exporta `run`, no devuelve `{state, ui}` con `ui.type` string, o si supera `timeoutMs`. También exporta `TASKS_DIR` (default `path.join(__dirname, 'tasks')`) y `RUN_TIMEOUT_MS` (90000).

- [ ] **Step 1: Escribir los tests**

Crear `test/task-runner.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runTaskScript } = require('../src/task-runner');

function writeScript(dir, name, code) {
  fs.writeFileSync(path.join(dir, name), code);
}

test('runTaskScript llama a run() y devuelve state/ui', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-tasks-'));
  writeScript(dir, 'ok.js', `
    module.exports = { run: async ({ state, input }) => ({ state: { ...state, visto: input }, ui: { type: 'accion', boton: 'Seguir' } }) };
  `);
  const result = await runTaskScript({ scriptModule: 'ok.js' }, { state: {}, input: 'hola', dryRun: true }, dir);
  assert.deepEqual(result, { state: { visto: 'hola' }, ui: { type: 'accion', boton: 'Seguir' } });
});

test('runTaskScript pasa dryRun al script', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-tasks-dryrun-'));
  writeScript(dir, 'dryrun.js', `
    module.exports = { run: async ({ dryRun }) => ({ state: {}, ui: { type: 'accion', boton: dryRun ? 'Prueba' : 'Real' } }) };
  `);
  const result = await runTaskScript({ scriptModule: 'dryrun.js' }, { state: {}, dryRun: true }, dir);
  assert.equal(result.ui.boton, 'Prueba');
});

test('runTaskScript tira error si el módulo no existe', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-tasks-missing-'));
  await assert.rejects(
    () => runTaskScript({ scriptModule: 'no-existe.js' }, { state: {} }, dir),
    /No se pudo cargar el script/
  );
});

test('runTaskScript tira error si run() no devuelve { state, ui }', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-tasks-badshape-'));
  writeScript(dir, 'bad.js', `module.exports = { run: async () => ({ algo: 1 }) };`);
  await assert.rejects(
    () => runTaskScript({ scriptModule: 'bad.js' }, { state: {} }, dir),
    /debe devolver \{ state, ui/
  );
});

test('runTaskScript corta con timeout si el script no responde', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-tasks-timeout-'));
  writeScript(dir, 'slow.js', `module.exports = { run: async () => new Promise(() => {}) };`);
  await assert.rejects(
    () => runTaskScript({ scriptModule: 'slow.js' }, { state: {} }, dir, 50),
    /tardó más de/
  );
});
```

- [ ] **Step 2: Correr los tests y confirmar que fallan**

Run: `node --test test/task-runner.test.js`
Expected: FAIL — `Cannot find module '../src/task-runner'`.

- [ ] **Step 3: Implementar `src/task-runner.js`**

```js
const path = require('path');

// 90s: por debajo del límite de idle del túnel de Cloudflare que expone esta
// app (~100s, ver CLAUDE.local.md) — un script que necesite más tiempo debe
// partirse en varias llamadas a run() con una pausa ui:{type:'accion'} en
// el medio, no bajar este número.
const TASKS_DIR = path.join(__dirname, 'tasks');
const RUN_TIMEOUT_MS = 90 * 1000;

function timeoutAfter(ms, message) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

async function runTaskScript(task, { state, input, dryRun }, tasksDir = TASKS_DIR, timeoutMs = RUN_TIMEOUT_MS) {
  const modPath = path.join(tasksDir, task.scriptModule);
  let mod;
  try {
    mod = require(modPath);
  } catch (err) {
    throw new Error(`No se pudo cargar el script "${task.scriptModule}": ${err.message}`);
  }
  if (typeof mod.run !== 'function') {
    throw new Error(`El script "${task.scriptModule}" no exporta una función run()`);
  }
  const result = await Promise.race([
    mod.run({ state: state || {}, input, dryRun: !!dryRun, task }),
    timeoutAfter(timeoutMs, `El script "${task.scriptModule}" tardó más de ${Math.round(timeoutMs / 1000)}s`),
  ]);
  if (!result || typeof result !== 'object' || !result.ui || typeof result.ui.type !== 'string') {
    throw new Error(`El script "${task.scriptModule}" debe devolver { state, ui: { type } }`);
  }
  return { state: result.state || {}, ui: result.ui };
}

module.exports = { runTaskScript, TASKS_DIR, RUN_TIMEOUT_MS };
```

- [ ] **Step 4: Correr los tests y confirmar que pasan**

Run: `node --test test/task-runner.test.js`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add src/task-runner.js test/task-runner.test.js
git commit -m "feat(agenda): runner genérico para tareas-script con timeout"
```

---

### Task 3: Endpoints genéricos en `routes/agenda.js`

**Files:**
- Modify: `src/routes/agenda.js`

**Interfaces:**
- Consumes: `agenda.list`, `agenda.getRunState`, `agenda.saveRunResult`, `agenda.saveRunError`, `agenda.setTaskVerified`, `agenda.resetRun` (Task 1); `runTaskScript` (Task 2).
- Produces (usado por Task 4): `POST /api/agenda/:id/run` (body opcional `{input}`) → `200 {ui, runStatus}` o `500 {error}`; `POST /api/agenda/:id/verify` → `200 {ok, verified}`; `POST /api/agenda/:id/reset-run` → `200 {ok}`.

- [ ] **Step 1: Agregar el require al tope de `src/routes/agenda.js`**

```js
const { runTaskScript } = require('../task-runner');
```

(junto a los `require` existentes de `express`, `../agenda`, `../outlook-classic`).

- [ ] **Step 2: Agregar los tres endpoints**

Insertar antes de `const MACARENA_EMAIL = ...`:

```js
// ── Ejecución de tareas-script — único punto de entrada genérico, ninguna
// tarea nueva necesita una ruta a medida (a diferencia de Macarena, abajo).
router.post('/:id/run', async (req, res) => {
  const tasks = agenda.list();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'tarea no encontrada' });
  if (task.execution !== 'script') return res.status(400).json({ error: 'esta tarea no se ejecuta por script' });
  const dryRun = !task.verified; // el server decide, nunca el cliente
  const input = req.body ? req.body.input : undefined;
  const state = agenda.getRunState(task.id);
  try {
    const result = await runTaskScript(task, { state, input, dryRun });
    const updated = agenda.saveRunResult(task.id, result);
    res.json({ ui: result.ui, runStatus: updated.run.status });
  } catch (err) {
    console.error(`[api/agenda/${task.id}/run]`, err.message);
    agenda.saveRunError(task.id, err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/verify', (req, res) => {
  const updated = agenda.setTaskVerified(req.params.id, true);
  if (!updated) return res.status(404).json({ error: 'tarea no encontrada o no es de tipo script' });
  res.json({ ok: true, verified: updated.verified });
});

router.post('/:id/reset-run', (req, res) => {
  const updated = agenda.resetRun(req.params.id);
  if (!updated) return res.status(404).json({ error: 'tarea no encontrada' });
  res.json({ ok: true });
});
```

- [ ] **Step 3: Verificación manual en vivo (este repo no testea rutas Express con un harness HTTP — ver `test/files.test.js` para el patrón real: solo se testean funciones puras, ya cubierto en Tasks 1-2)**

Con el server corriendo local (`npm start` o la instancia que ya tengas arriba) y tu `ACCESS_PIN` a mano:

```bash
export CCM_PIN=<tu ACCESS_PIN>

# 1. Crear un script de prueba temporal (se borra al final)
mkdir -p src/tasks
cat > src/tasks/prueba_mecanismo.js <<'EOF'
module.exports = {
  run: async ({ state }) => {
    if (!state.pedido) return { state: { pedido: true }, ui: { type: 'pedir-dato', pregunta: '¿Cuál es tu color favorito?' } };
    return { state, ui: { type: 'listo' } };
  },
};
EOF

# 2. Registrar una tarea temporal contra ese script
node -e "
const agenda = require('./src/agenda');
const t = agenda.addCustomTask({ title: 'Prueba mecanismo', execution: 'script', scriptModule: 'prueba_mecanismo.js' });
console.log(t.id);
" > /tmp/prueba-task-id.txt
TASK_ID=$(cat /tmp/prueba-task-id.txt)

# 3. Primera corrida (dry-run forzado porque verified:false) — debe pedir el dato
curl -s -X POST -H "Content-Type: application/json" -H "Cookie: ccm_auth=$CCM_PIN" \
  http://127.0.0.1:3777/api/agenda/$TASK_ID/run -d '{}'
# Esperado: {"ui":{"type":"pedir-dato","pregunta":"¿Cuál es tu color favorito?"},"runStatus":"waiting"}

# 4. Segunda corrida con input — debe terminar
curl -s -X POST -H "Content-Type: application/json" -H "Cookie: ccm_auth=$CCM_PIN" \
  http://127.0.0.1:3777/api/agenda/$TASK_ID/run -d '{"input":"verde"}'
# Esperado: {"ui":{"type":"listo"},"runStatus":"done"}

# 5. Confirmar que la tarea quedó marcada hecha
curl -s -H "Cookie: ccm_auth=$CCM_PIN" http://127.0.0.1:3777/api/agenda | grep -o "\"id\":\"$TASK_ID\"[^}]*\"state\":\"hecho\""

# 6. Limpieza — borrar la tarea y el script de prueba
curl -s -X DELETE -H "Cookie: ccm_auth=$CCM_PIN" http://127.0.0.1:3777/api/agenda/tasks/$TASK_ID
rm src/tasks/prueba_mecanismo.js
```

Expected: los dos `curl` de los pasos 3 y 4 devuelven exactamente los JSON esperados, el paso 5 encuentra la tarea en estado `hecho`, y el paso 6 no deja rastro (ni la tarea en `agenda.json` ni el archivo del script).

- [ ] **Step 4: Commit**

```bash
git add src/routes/agenda.js
git commit -m "feat(agenda): endpoints genéricos run/verify/reset-run"
```

---

### Task 4: UI — tarjetas de tareas-script en la pestaña

**Files:**
- Modify: `public/agenda.js` (`agendaCardActions`, `renderAgendaList`, nuevas funciones)
- Modify: `public/style.css`

**Interfaces:**
- Consumes: `task.execution`, `task.verified`, `task.runStatus`, `task.runUi`, `task.runError` (de `GET /api/agenda`, Task 1+3); endpoints `/run`, `/verify`, `/reset-run` (Task 3).
- Produces: nada consumido por otra tarea de este plan.

- [ ] **Step 1: Modificar `agendaCardActions` en `public/agenda.js` (líneas 142-159 actuales)**

Reemplazar la función completa por:

```js
function agendaCardActions(task) {
  if (task.id === 'estadistico_contratista') {
    return `
      <div class="agenda-actions">
        <button type="button" onclick="agendaPrepareMacarena()">✉️ Pedir nómina</button>
        <button type="button" onclick="agendaCheckMacarena()">🔄 ¿Contestó?</button>
      </div>
      <div class="agenda-draft" id="agenda-macarena-draft" hidden></div>
    `;
  }
  if (task.execution === 'script') {
    const runLabel = task.verified ? '▶️ Hacer ahora' : '🧪 Probar';
    return `
      <div class="agenda-actions">
        <button type="button" class="primary" onclick="agendaRunScript('${task.id}')">${runLabel}</button>
      </div>
      <div class="agenda-run-box"></div>
    `;
  }
  const label = task.state === 'hecho' ? '↩️ Desmarcar' : '✅ Marcar hecho';
  const runBtn = task.autoPrompt ? `<button type="button" class="primary" onclick="agendaRunTask('${task.id}')">▶️ Hacer ahora</button>` : '';
  return `<div class="agenda-actions">${runBtn}<button type="button" onclick="agendaToggleDone('${task.id}', ${task.state !== 'hecho'})">${label}</button></div>`;
}
```

- [ ] **Step 2: Rellenar el contenido dinámico del `.agenda-run-box` en `renderAgendaList` (líneas 220-229 actuales)**

Antes:
```js
    } else if (ul) {
      for (const item of task.checklist) {
        const li = document.createElement('li');
        li.textContent = item;
        ul.appendChild(li);
      }
    }
    wrap.appendChild(card);
  }
}
```

Después:
```js
    } else if (ul) {
      for (const item of task.checklist) {
        const li = document.createElement('li');
        li.textContent = item;
        ul.appendChild(li);
      }
    }
    if (task.execution === 'script') agendaRenderRunBox(task, card);
    wrap.appendChild(card);
  }
}
```

- [ ] **Step 3: Agregar las funciones nuevas (después de `renderAgendaList`, antes de `agendaToggleDone`)**

```js
// ── Ejecución de tareas-script — renderer genérico de la pausa actual ──
// A diferencia del resto de agendaCardActions (HTML armado a mano, seguro
// porque son strings fijos nuestros), esto arma el contenido con el DOM y
// textContent — task.runUi/task.runError pueden traer texto de afuera (un
// mail, un dato de un portal), nunca hay que meterlo con innerHTML.
function agendaRenderRunBox(task, card) {
  const box = card.querySelector('.agenda-run-box');
  if (!box) return;
  box.innerHTML = '';
  if (task.runStatus === 'error') {
    const wrap = document.createElement('div');
    wrap.className = 'agenda-draft';
    const warn = document.createElement('div');
    warn.className = 'agenda-warning';
    warn.textContent = task.runError || 'Error desconocido';
    wrap.appendChild(warn);
    const actions = document.createElement('div');
    actions.className = 'agenda-actions';
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.textContent = 'Reintentar';
    retryBtn.onclick = () => agendaRunScript(task.id);
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.textContent = 'Reiniciar';
    resetBtn.onclick = () => agendaResetRun(task.id);
    actions.appendChild(retryBtn);
    actions.appendChild(resetBtn);
    wrap.appendChild(actions);
    box.appendChild(wrap);
    return;
  }
  if (task.runUi) agendaRenderRunStep(task, task.runUi, box);
  if (!task.verified && task.runStatus === 'waiting') {
    const banner = document.createElement('div');
    banner.className = 'agenda-run-dryrun-banner';
    banner.append('🧪 Esto no ejecutó nada real todavía. ');
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'primary';
    confirmBtn.textContent = '✅ Confirmar y activar';
    confirmBtn.onclick = () => agendaVerifyTask(task.id);
    banner.appendChild(confirmBtn);
    box.appendChild(banner);
  }
}

function agendaRenderRunStep(task, ui, box) {
  const wrap = document.createElement('div');
  wrap.className = 'agenda-draft';
  if (ui.type === 'texto-editable') {
    const ta = document.createElement('textarea');
    ta.value = ui.texto || '';
    wrap.appendChild(ta);
    const actions = document.createElement('div');
    actions.className = 'agenda-actions';
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'primary';
    confirmBtn.textContent = 'Confirmar';
    confirmBtn.onclick = () => agendaRunScript(task.id, ta.value);
    actions.appendChild(confirmBtn);
    wrap.appendChild(actions);
  } else if (ui.type === 'pedir-dato') {
    const label = document.createElement('div');
    label.className = 'agenda-meta';
    label.textContent = ui.pregunta || '';
    wrap.appendChild(label);
    const input = document.createElement('input');
    input.type = 'text';
    wrap.appendChild(input);
    const actions = document.createElement('div');
    actions.className = 'agenda-actions';
    const sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'primary';
    sendBtn.textContent = 'Enviar';
    sendBtn.onclick = () => agendaRunScript(task.id, input.value);
    actions.appendChild(sendBtn);
    wrap.appendChild(actions);
  } else if (ui.type === 'accion') {
    const actions = document.createElement('div');
    actions.className = 'agenda-actions';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary';
    btn.textContent = ui.boton || 'Continuar';
    btn.onclick = () => agendaRunScript(task.id);
    actions.appendChild(btn);
    wrap.appendChild(actions);
  } else {
    return; // 'listo' u otro tipo desconocido: nada que mostrar acá
  }
  box.appendChild(wrap);
}

async function agendaRunScript(id, input) {
  try {
    await api(`/agenda/${id}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input === undefined ? {} : { input }),
    });
    await loadAgendaList();
  } catch (err) { toast('No se pudo ejecutar la tarea: ' + err.message); }
}

async function agendaVerifyTask(id) {
  try {
    await api(`/agenda/${id}/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await loadAgendaList();
  } catch (err) { toast('No se pudo confirmar: ' + err.message); }
}

async function agendaResetRun(id) {
  try {
    await api(`/agenda/${id}/reset-run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await loadAgendaList();
  } catch (err) { toast('No se pudo reiniciar: ' + err.message); }
}
```

- [ ] **Step 4: Agregar el CSS mínimo nuevo en `public/style.css`** (junto al resto de reglas `.agenda-*`, después de `.agenda-warning`)

```css
.agenda-draft input[type="text"] { padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--input-bg); color: inherit; font: inherit; }
.agenda-run-dryrun-banner { font-size: 12px; color: var(--text2); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
```

- [ ] **Step 5: Verificación manual en vivo (este proyecto no tiene tests automáticos de DOM — mismo criterio que el resto de features de UI, ver `CLAUDE.local.md`)**

Reusando la tarea temporal del Step 3 de Task 3 (o creando una nueva igual), abrir la pestaña Task en el navegador con el server corriendo y confirmar visualmente:
1. Card con botón "🧪 Probar" (no "▶️ Hacer ahora", porque `verified:false`).
2. Al apretarlo, aparece el input de "¿Cuál es tu color favorito?" con botón "Enviar".
3. Al mandar una respuesta, aparece el banner "🧪 Esto no ejecutó nada real todavía." con el botón "✅ Confirmar y activar" (la tarea real de prueba llega a `ui:{type:'listo'}` en la segunda llamada, así que en este caso puntual el banner no llega a mostrarse — para verlo, usar un script fixture con 3+ pasos, o verificar el banner directamente inspeccionando que `agendaRenderRunBox` lo agrega cuando `runStatus==='waiting' && !verified`, con DevTools).
4. Provocar un error a mano (ej. renombrar momentáneamente el archivo del script y apretar "Reintentar") y confirmar que aparece la caja roja con "Reintentar"/"Reiniciar".

Borrar la tarea de prueba al terminar.

- [ ] **Step 6: Commit**

```bash
git add public/agenda.js public/style.css
git commit -m "feat(agenda): UI de tarjetas para tareas ejecutadas por script"
```

---

### Task 5: Renombrar la pestaña a "Task" y arreglar el hardcode de "Aprender rutina nueva"

**Files:**
- Modify: `public/index.html:67`
- Modify: `public/agenda.js:49-88` (comentario + `AGENDA_LEARN_PROMPT` + `agendaLearnNewRoutine`)

**Interfaces:** ninguna consumida ni producida — cambio autocontenido.

Contexto del bug que se arregla acá: `AGENDA_LEARN_PROMPT` hoy es un `const` de módulo con "FerStark" y la ruta absoluta de la PC de Fernando hardcodeadas — mal en cualquier instancia que no sea la suya (encontrado en esta misma sesión). Además, evaluarlo como `const` en vez de función lo congela con el `APP_NAME` default ("Claude Chat Manager"), porque `APP_NAME` recién se resuelve después de un fetch async a `/config`.

- [ ] **Step 1: Cambiar la etiqueta de la pestaña**

En `public/index.html:67`, cambiar:
```html
<button type="button" class="pane-tab" data-pane="4">🚦 Agenda<span id="agenda-badge" class="tab-badge" hidden></span></button>
```
por:
```html
<button type="button" class="pane-tab" data-pane="4">🚦 Task<span id="agenda-badge" class="tab-badge" hidden></span></button>
```

- [ ] **Step 2: Reemplazar `AGENDA_LEARN_PROMPT` por una función en `public/agenda.js`**

Reemplazar el bloque completo (comentario + const, líneas ~49-61 actuales) por:

```js
// ── "🎓 Aprender rutina nueva" — enseñar una tarea recurrente por CHAT ──
// Fernando pidió esto en vez del formulario de 3 campos que había antes
// (07/09/2026): "tengo que tener el chat así podemos ver, pasar link, y si
// está todo bien o no" — enseñar una rutina real necesita ida y vuelta
// (pegar links, capturas, aclarar pasos), no un formulario. Así que este
// botón abre una conversación real nueva (mismo mecanismo que "+ Nueva
// conversación") con un mensaje inicial que le explica a esa sesión cómo
// registrar la tarea en el catálogo una vez que quede clara.
//
// Función, no const de módulo: necesita leer APP_NAME (app.js), que recién
// se resuelve tras un fetch async a /config — evaluado antes de tiempo
// siempre devolvía el default "Claude Chat Manager". Antes de este fix el
// prompt tenía hardcodeado "FerStark" + la ruta absoluta de la PC de
// Fernando (mal en cualquier otra instancia) — ver
// docs/superpowers/specs/2026-09-15-task-scripts-design.md.
function buildAgendaLearnPrompt() {
  return `Quiero crear una tarea nueva para la pestaña Task de ${APP_NAME} (semáforo de tareas recurrentes).

Usá la skill "crear-tarea" de este repo para armarla: investigá cómo automatizarla gastando lo menos posible (¿hay una API oficial del sistema destino? ¿se puede scriptear de forma determinística?), y si corresponde escribí el script y dejalo listo para probar en modo prueba antes de activarlo. Si no se puede scriptear con confianza, dejala como tarea de chat, como las que ya existen.

Empecemos: contame qué tarea es.`;
}
```

- [ ] **Step 3: Usar la función nueva en `agendaLearnNewRoutine`**

Cambiar:
```js
    await agendaSpawnConversation(AGENDA_LEARN_PROMPT, 'Agenda');
```
por:
```js
    await agendaSpawnConversation(buildAgendaLearnPrompt(), 'Agenda');
```

- [ ] **Step 4: Verificación manual**

Recargar la app y confirmar que la pestaña dice "Task". Apretar "🎓 Aprender rutina nueva" y confirmar que el primer mensaje del chat nuevo menciona el nombre real de esta instancia (ej. "Jarvis", no "Claude Chat Manager" ni "FerStark") y no contiene ninguna ruta de `/mnt/c/Users/Fernando/...`.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/agenda.js
git commit -m "fix(agenda): saca el hardcode de FerStark/ruta de Fernando; renombra la pestaña a Task"
```

---

### Task 6: Skill `crear-tarea`

**Files:**
- Create: `.claude/skills/crear-tarea/SKILL.md`

**Interfaces:** ninguna — es un archivo de instrucciones, no código.

- [ ] **Step 1: Crear el archivo**

```markdown
---
name: crear-tarea
description: Use when adding a new recurring Task to the "Task" tab of claude-chat-manager (src/agenda.js) — investigates whether it can run as a cheap deterministic script instead of a token-costing chat flow, writes the script, and registers it safely behind a dry-run gate before it can execute anything real.
---

# Crear tarea nueva para la pestaña Task

Esta skill se activa cuando alguien quiere agregar una tarea recurrente nueva al catálogo de `src/agenda.js` (pestaña "Task" de esta app) — típicamente porque el botón "🎓 Aprender rutina nueva" abrió esta conversación, o porque te lo piden directamente.

El objetivo NO es solo agregar la tarea al catálogo — es decidir, con criterio, si conviene que se ejecute como **script determinístico** (gasta cero tokens cada mes) o como **chat** (un agente la resuelve razonando, como siempre). Ver `docs/superpowers/specs/2026-09-15-task-scripts-design.md` para el diseño completo del mecanismo.

## Paso 1 — Entender la tarea

Preguntá lo que haga falta, en tono conversacional (podés pedir que te peguen links, capturas, que te expliquen los pasos a mano una vez). Necesitás saber, como mínimo:
- **Título** de la tarea.
- **Día fijo del mes** (para el semáforo) o si no tiene uno.
- **Grupo** al que pertenece (una categoría existente del catálogo, o una nueva).
- Cualquier detalle de negocio relevante (a quién se factura, qué formato, dónde se sube el resultado, etc.) — esto va a hacer falta después para escribir el script o el `autoPrompt`.

## Paso 2 — Investigar ANTES de decidir cómo se ejecuta

No asumas que hace falta un agente. En este orden de preferencia:

1. **¿El sistema destino tiene una API oficial?** Preferila siempre sobre automatizar una interfaz web — es más barata, más estable, y no depende de que un LLM interprete una pantalla. Ejemplos ya resueltos en este ecosistema: ControlDoc tiene una API documentada (ver memoria del proyecto, `reference_ferzep_controldoc_acceso`); AFIP/ARCA tiene el servicio SOAP WSFEv1 (facturación electrónica con certificado) en vez de depender del portal RCEL. Buscá en la memoria del proyecto y en `CLAUDE.local.md`/`CLAUDE.md` antes de asumir que no existe.
2. **Si no hay API, ¿se puede automatizar de forma determinística?** Selectores estables de una UI web (Playwright/agent-browser), un archivo de Excel con formato fijo, un mail con estructura predecible (mismo patrón que `src/outlook-classic.js`, ya usado para Macarena) — cualquier cosa que un script sin criterio pueda seguir siempre igual.
3. **Si la tarea necesita juicio real en cada corrida** (leer contenido variable y decidir algo, resolver un captcha visual, interpretar una respuesta ambigua), **la conclusión correcta es dejarla como tarea de chat** (`execution:'chat'`, con `autoPrompt`, igual que la mayoría del catálogo hoy). No fuerces un script donde no corresponde — es peor tener un script frágil que se rompe en silencio que un chat que razona.

## Paso 3 — Credenciales que falten

Si necesitás una API key, un certificado, o cualquier credencial que no esté ya en `settings.json` o documentada en la memoria del proyecto:

- **Nunca la crees ni la pidas vos directamente.** Decile a la persona exactamente qué falta y dónde conviene guardarlo, siguiendo la convención existente (tabla de `settings.json` en `CLAUDE.md` global, o una memoria de referencia nueva tipo `reference_<servicio>.md`).
- Si conseguirla implica un paso sensible (un login con 2FA, generar un certificado con clave privada, un flujo OAuth), decile explícitamente que es mejor que lo haga desde otra sesión — no lo intentes vos.

## Paso 4 — Si es script: escribilo

Creá `src/tasks/<nombre-descriptivo>.js` (nombre elegido por vos, en minúsculas con guiones bajos — no tiene que coincidir con el `id` autogenerado de la tarea). Contrato único, sin excepciones:

```js
module.exports = {
  run: async ({ state, input, dryRun, task }) => {
    // ... tu lógica ...
    return { state: nuevoState, ui: { type: '...' } };
  },
};
```

- `state`: lo que vos mismo devolviste la vez anterior (objeto vacío `{}` la primera vez). Usalo para recordar en qué paso vas.
- `input`: lo que la persona mandó en respuesta a la pausa anterior (`undefined` si el paso previo no pedía nada).
- `dryRun`: `true` mientras la tarea no esté verificada — el servidor lo fuerza, no lo controla el script. En este modo hacé todo el trabajo de preparación real, pero NO ejecutes la acción irreversible final (no mandes el mail, no presentes la factura, no confirmes el envío) — simulá el resultado y contalo en la `ui`.
- Devolvé siempre `{ state, ui }`, con `ui.type` uno de:
  - `{ type: 'texto-editable', texto: '...' }` — para que la persona revise/edite texto antes de seguir (mismo patrón que el borrador de Macarena).
  - `{ type: 'pedir-dato', pregunta: '...' }` — para pedir un dato puntual (ej. un código de un login).
  - `{ type: 'accion', boton: '...' }` — un paso que solo necesita que aprieten para seguir, sin datos.
  - `{ type: 'listo' }` — la tarea terminó; el servidor la marca hecha solo.
- **Regla de oro: nunca dupliques una acción real al reintentar.** Si el paso puede volver a llamarse después de un error (el botón "Reintentar" de la tarjeta hace exactamente eso), el script tiene que poder chequear si la acción ya se hizo antes de repetirla — mismo criterio que ya usan los `autoPrompt` de facturación existentes ("revisá antes de reintentar, para no duplicar").
- **Cada llamada a `run()` tiene un límite de ~90 segundos** (por debajo del límite de conexiones inactivas del túnel de Cloudflare que expone esta app). Si tu tarea necesita más tiempo (ej. varios minutos de Playwright), partila en varios pasos: devolvé `{ type: 'accion' }` para ceder el control y seguir en la próxima llamada, usando `state` para recordar el progreso.

## Paso 5 — Registrar la tarea

Con la sesión corriendo en la raíz de este repo:

```bash
node -e "
const agenda = require('./src/agenda');
agenda.addCustomTask({
  title: '<título>',
  group: '<grupo>',
  day: <día o null>,
  execution: 'script',
  scriptModule: '<nombre-del-archivo>.js',
});
"
```

Si decidiste que es de chat (Paso 2, opción 3), usá la misma función sin `execution`/`scriptModule`, y agregale un `autoPrompt` con las instrucciones completas para el agente que la corra cada mes — mismo formato que las tareas de facturación existentes en `src/agenda.js` (`LEGACY_SEED_CATALOG`).

Una tarea-script nace con `verified:false` — el botón real todavía no está habilitado, solo "🧪 Probar".

## Paso 6 — Corré un dry-run y mostraselo a la persona

Antes de darla por terminada, ejecutá vos mismo el flujo completo en modo prueba (podés invocar el script directo con `node -e`, pasándole `dryRun:true`, o pedirle a la persona que apriete "🧪 Probar" en la tarjeta) y contale exactamente qué haría en una corrida real — qué leería, qué escribiría, a quién le mandaría qué.

## Paso 7 — Confirmación explícita, no automática

**No llames vos al endpoint `/verify` ni actives la tarea por tu cuenta.** Una vez que la persona vio el dry-run y te confirma que está bien, decile que apriete "✅ Confirmar y activar" en la tarjeta de la pestaña Task — recién ahí el botón real ("▶️ Hacer ahora") queda habilitado.
```

- [ ] **Step 2: Verificación**

Confirmar que el frontmatter parsea (`name`/`description` presentes, sin tabs, delimitadores `---` correctos) y que las 7 secciones (Pasos 1-7) están completas sin placeholders. Como prueba de humo real, en una sesión nueva de este mismo repo pedir "quiero crear una tarea de prueba que no toque nada real" y confirmar que la skill se invoca sola y sigue el checklist (title/group/day → investigación → si no hay nada que scriptear con confianza, concluye `execution:'chat'` sin forzar un script — es una salida válida y esperada del Paso 2).

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/crear-tarea/SKILL.md
git commit -m "docs: skill crear-tarea para armar tareas nuevas de la pestaña Task"
```
