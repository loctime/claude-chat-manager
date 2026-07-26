# Modos de Respuesta por Conversación — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar un selector de "modo de respuesta" por conversación en Jarvis (detallado / directo / cavernícola), que reemplaza al plugin caveman ya eliminado, controlando la verbosidad de Claude vía `--append-system-prompt`.

**Architecture:** Se replica exactamente el flujo ya existente de `conv.model` (persistencia en `meta.json` vía `server.js`, PATCH endpoint, `runner.send`, selector en el header del composer). La única pieza nueva de lógica es `src/response-modes.js`, un módulo puro que mapea el modo elegido a un fragmento de texto para el system prompt; `runner.js` lo concatena con el aviso de infraestructura que ya inyecta.

**Tech Stack:** Node.js (backend, `node --test`), HTML/CSS/JS vanilla (frontend, sin build step).

## Global Constraints

- Tres modos: `detallado` (sin instrucción agregada — comportamiento normal de Claude), `directo` (default cuando no hay valor guardado), `cavernicola` (máxima brevedad).
- El selector vive en Jarvis únicamente — no afecta la consola de Claude Code fuera de `runner.js`.
- Cambiar de modo a mitad de conversación aplica al próximo mensaje enviado, igual que el cambio de modelo ya existente.
- No hay modo automático por contexto — elección manual del usuario.
- El texto de "cavernícola" es contenido nuevo propio de Jarvis, no una copia de las reglas del plugin caveman eliminado.
- `src/server.js` no está exportado para tests de integración (ningún endpoint del proyecto lo está hoy) — los cambios ahí se verifican corriendo el server y con `curl`/uso manual, siguiendo el patrón ya establecido en el repo. `app.js`/`index.html`/`style.css` se verifican manualmente en el browser (tampoco hay harness de DOM tests en el repo).

---

### Task 1: Módulo de modos de respuesta

**Files:**
- Create: `src/response-modes.js`
- Test: `test/response-modes.test.js`

**Interfaces:**
- Produces: `responseModeInstruction(mode: string|undefined) => string|null` — usado por `runner.js` en la Task 2. `mode` sin valor o `'directo'` devuelve el texto del modo directo; `'detallado'` o cualquier valor no reconocido devuelve `null`; `'cavernicola'` devuelve el texto cavernícola.
- Produces: `RESPONSE_MODES` (objeto `{ directo, cavernicola }`) — exportado por si `server.js` necesita validar valores permitidos en una task futura (no se usa en este plan).

- [ ] **Step 1: Write the failing test**

Crear `test/response-modes.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { responseModeInstruction, RESPONSE_MODES } = require('../src/response-modes');

test('sin modo (undefined) devuelve la instrucción de "directo"', () => {
  assert.equal(responseModeInstruction(undefined), RESPONSE_MODES.directo);
});

test('modo "directo" explícito devuelve la misma instrucción', () => {
  assert.equal(responseModeInstruction('directo'), RESPONSE_MODES.directo);
});

test('modo "detallado" no agrega ninguna instrucción', () => {
  assert.equal(responseModeInstruction('detallado'), null);
});

test('modo "cavernicola" devuelve su propia instrucción', () => {
  assert.equal(responseModeInstruction('cavernicola'), RESPONSE_MODES.cavernicola);
  assert.notEqual(RESPONSE_MODES.cavernicola, RESPONSE_MODES.directo);
});

test('modo desconocido no agrega ninguna instrucción', () => {
  assert.equal(responseModeInstruction('algo-que-no-existe'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/response-modes.test.js`
Expected: FAIL — `Cannot find module '../src/response-modes'`

- [ ] **Step 3: Write minimal implementation**

Crear `src/response-modes.js`:

```js
const RESPONSE_MODES = {
  directo: 'Modo de respuesta: directo. Da la respuesta, el porqué, y una recomendación si aplica — nada más. No incluyas fragmentos de código, listas de pasos ni explicaciones extensas salvo que el usuario las pida explícitamente en su mensaje. Escribí en frases completas, tono normal — esto no es un modo telegráfico.',
  cavernicola: 'Modo de respuesta: cavernícola. Sé lo más breve posible. Frases cortas o fragmentos, sin cortesías ni relleno. No expliques nada salvo que se pida explícitamente. Si hace falta un comando, ruta o fragmento de código exacto, dejalo intacto y verbatim.',
};

function responseModeInstruction(mode) {
  const key = mode || 'directo';
  return RESPONSE_MODES[key] || null;
}

module.exports = { RESPONSE_MODES, responseModeInstruction };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/response-modes.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/response-modes.js test/response-modes.test.js
git commit -m "feat: agregar módulo de modos de respuesta (directo/detallado/cavernícola)"
```

---

### Task 2: `runner.js` concatena la instrucción del modo al system prompt

**Files:**
- Modify: `src/runner.js:1-4` (imports), `src/runner.js:62-70` (`_start`)
- Test: `test/runner.test.js`

**Interfaces:**
- Consumes: `responseModeInstruction` de `src/response-modes.js` (Task 1).
- Consumes: `job.responseMode` (string|undefined) — nuevo campo del objeto `job` pasado a `runner.send(...)`, análogo a `job.model` que ya existe.

- [ ] **Step 1: Write the failing test**

Agregar a `test/runner.test.js` (después del test `'pasa --model cuando el job lo tiene, lo omite si no'`, línea 45):

```js
test('agrega --append-system-prompt con la instrucción del modo (default "directo" sin responseMode)', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  r.send({ convId: 'c1', sessionId: 's1', cwd: '/t', text: 'a' });
  const i = spawned[0].args.indexOf('--append-system-prompt');
  assert.ok(i >= 0);
  assert.match(spawned[0].args[i + 1], /Modo de respuesta: directo/);
});

test('modo "detallado" no agrega --append-system-prompt (sin selfPort)', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  r.send({ convId: 'c1', sessionId: 's1', cwd: '/t', text: 'a', responseMode: 'detallado' });
  assert.ok(!spawned[0].args.includes('--append-system-prompt'));
});

test('modo "cavernicola" agrega su propia instrucción', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  r.send({ convId: 'c1', sessionId: 's1', cwd: '/t', text: 'a', responseMode: 'cavernicola' });
  const i = spawned[0].args.indexOf('--append-system-prompt');
  assert.ok(i >= 0);
  assert.match(spawned[0].args[i + 1], /Modo de respuesta: cavernícola/);
});

test('con selfPort configurado, concatena aviso de infraestructura + instrucción del modo en un solo --append-system-prompt', () => {
  const spawned = [];
  const r = new Runner({
    maxConcurrent: 2,
    selfPort: 3777,
    spawnFn: (cmd, args, opts) => {
      const child = fakeChild();
      spawned.push({ cmd, args, opts, child });
      return child;
    },
  });
  r.send({ convId: 'c1', sessionId: 's1', cwd: '/t', text: 'a', responseMode: 'cavernicola' });
  const occurrences = spawned[0].args.filter(a => a === '--append-system-prompt').length;
  assert.equal(occurrences, 1);
  const i = spawned[0].args.indexOf('--append-system-prompt');
  assert.match(spawned[0].args[i + 1], /AVISO INFRAESTRUCTURA/);
  assert.match(spawned[0].args[i + 1], /Modo de respuesta: cavernícola/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/runner.test.js`
Expected: FAIL — los tests nuevos fallan porque `--append-system-prompt` no aparece (modo "directo" hoy no agrega nada sin `selfPort`), y el test de `detallado` pasa por accidente pero el resto no.

- [ ] **Step 3: Write minimal implementation**

En `src/runner.js:1-4`, agregar el require:

```js
const { spawn, execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const os = require('os');
const { CLAUDE_CMD } = require('./claude-cmd');
const { responseModeInstruction } = require('./response-modes');
```

En `src/runner.js`, reemplazar el bloque de `_start` que arma `--append-system-prompt` (líneas 62-70):

```js
  _start(job) {
    const args = ['-p', job.text, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
    const promptFragments = [];
    if (this.selfPort) {
      const host = this.selfHost || '127.0.0.1';
      promptFragments.push(
        `AVISO INFRAESTRUCTURA: te está ejecutando claude-chat-manager (Node/Express) en ${host}:${this.selfPort}. Ese proceso es tu propio transporte hacia el usuario — si lo matás perdés el stream a la mitad y el usuario ve tu respuesta cortada. NO ejecutes comandos que apunten a ese puerto ni a ese proceso: nada de kill/pkill/fuser/lsof -ti:${this.selfPort} -k, ss ... | xargs kill, systemctl stop, etc. Si el usuario te pide reiniciar el chat-manager, explicale que lo tiene que hacer él desde otra terminal (o via PM2/systemd) porque vos no podés matar tu propio host.`
      );
    }
    const modeInstruction = responseModeInstruction(job.responseMode);
    if (modeInstruction) promptFragments.push(modeInstruction);
    if (promptFragments.length > 0) {
      args.push('--append-system-prompt', promptFragments.join('\n\n'));
    }
    if (job.sessionId) args.push('--resume', job.sessionId);
    if (job.model) args.push('--model', job.model);
```

(El resto de `_start` — desde `const account = job.account || CURRENT_USER;` en adelante — no cambia.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/runner.test.js`
Expected: PASS (todos los tests, incluidos los preexistentes)

- [ ] **Step 5: Run full suite to check no regressions**

Run: `npm test`
Expected: PASS (todos los archivos de `test/`)

- [ ] **Step 6: Commit**

```bash
git add src/runner.js test/runner.test.js
git commit -m "feat: runner concatena instrucción de modo de respuesta al system prompt"
```

---

### Task 3: `server.js` expone y persiste `responseMode` por conversación

**Files:**
- Modify: `src/server.js:438-471` (`/api/tree`), `src/server.js:502-527` (`/api/search`), `src/server.js:588` (`/api/conversations/:id/message`), `src/server.js:656-668` (`PATCH /api/conversations/:id`)

**Interfaces:**
- Consumes: `job.responseMode` de `runner.send` (Task 2 ya lo soporta).
- Produces: campo `responseMode` en las respuestas JSON de `/api/tree` y `/api/search`, consumido por `app.js` en la Task 4.
- Produces: `PATCH /api/conversations/:id` acepta `responseMode` en el body, igual que ya acepta `model`.

- [ ] **Step 1: Modificar `/api/tree` para incluir `responseMode`**

En `src/server.js:447` (dentro del primer `convs.push({...})`, junto a `model: c.model || null,`):

```js
      model: c.model || null,
      responseMode: c.responseMode || null,
```

En `src/server.js:465` (segundo `convs.push({...})`, conversaciones sin entrada en `data.conversations`, junto a `model: null,`):

```js
      model: null,
      responseMode: null,
```

- [ ] **Step 2: Modificar `/api/search` para incluir `responseMode`**

En `src/server.js:522` (dentro del `.map(r => {...})` de `enriched`, junto a `model: conv ? conv.model : null,`):

```js
      model: conv ? conv.model : null,
      responseMode: conv ? conv.responseMode : null,
```

- [ ] **Step 3: Pasar `responseMode` al enviar un mensaje**

En `src/server.js:588`, reemplazar:

```js
  runner.send({ convId, sessionId: conv.currentSessionId, cwd, text: outgoing, model: conv.model, account: acc });
```

por:

```js
  runner.send({ convId, sessionId: conv.currentSessionId, cwd, text: outgoing, model: conv.model, responseMode: conv.responseMode, account: acc });
```

- [ ] **Step 4: Aceptar `responseMode` en el PATCH de conversación**

En `src/server.js:664`, después de la línea `if ('model' in req.body) conv.model = (req.body.model || '').trim() || undefined;`, agregar:

```js
  if ('responseMode' in req.body) conv.responseMode = (req.body.responseMode || '').trim() || undefined;
```

- [ ] **Step 5: Correr la suite completa (sin tests nuevos — `server.js` no está exportado para tests de integración, patrón ya existente en el repo)**

Run: `npm test`
Expected: PASS — estos cambios son de plomería directa (mismo patrón que `model` en las mismas líneas) y no rompen ningún test existente.

- [ ] **Step 6: Verificación manual con el server corriendo**

```bash
npm start
```

En otra terminal (reemplazar `<convId>` por un id real de `GET http://127.0.0.1:3777/api/tree`):

```bash
curl -s -X PATCH http://127.0.0.1:3777/api/conversations/<convId> \
  -H "Content-Type: application/json" \
  -d '{"responseMode":"cavernicola"}'
curl -s http://127.0.0.1:3777/api/tree | grep -o '"responseMode":"[^"]*"'
```

Expected: el PATCH devuelve `{"ok":true}` y el `GET /api/tree` muestra `"responseMode":"cavernicola"` para esa conversación.

- [ ] **Step 7: Commit**

```bash
git add src/server.js
git commit -m "feat: persistir y exponer responseMode por conversación en la API"
```

---

### Task 4: Selector de modo en la UI de Jarvis

**Files:**
- Modify: `public/index.html:54-58` (header del composer)
- Modify: `public/style.css:218-222` (estilos)
- Modify: `public/app.js:291-317` (`convElement`), `public/app.js:921-939` (`selectConv`), `public/app.js:1231-1241` (model-select onchange), `public/app.js:1293-1303` (`new-form` submit), `public/app.js:1372-1374` (`openSearchResult`), `public/app.js:1406-1422` (tab-switch handler)

**Interfaces:**
- Consumes: `responseMode` en los objetos de conversación devueltos por `/api/tree` y `/api/search` (Task 3).
- Consumes: `PATCH /api/conversations/:id` con `{ responseMode }` (Task 3).

- [ ] **Step 1: Agregar el `<select>` en `index.html`**

En `public/index.html`, después de la línea 58 (`</select>` de cierre de `#model-select`, antes de `<span id="cost-badge"...>`):

```html
        <select id="model-select" title="Modelo" aria-label="Modelo">
          <option value="sonnet">Sonnet</option>
          <option value="opus">Opus</option>
          <option value="haiku">Haiku</option>
        </select>
        <select id="response-mode-select" title="Modo de respuesta" aria-label="Modo de respuesta">
          <option value="detallado">Detallado</option>
          <option value="directo">Directo</option>
          <option value="cavernicola">Cavernícola</option>
        </select>
        <span id="cost-badge" title="Costo estimado" hidden></span>
```

- [ ] **Step 2: Agregar el estilo en `style.css`**

En `public/style.css`, después del bloque `#model-select` (línea 222):

```css
#model-select {
  background: var(--input-bg); color: var(--text2); border: 1px solid var(--border);
  border-radius: 6px; padding: 3px 6px; font-size: 12px; cursor: pointer;
  max-width: 110px; overflow: hidden; text-overflow: ellipsis;
}

#response-mode-select {
  background: var(--input-bg); color: var(--text2); border: 1px solid var(--border);
  border-radius: 6px; padding: 3px 6px; font-size: 12px; cursor: pointer;
  max-width: 110px; overflow: hidden; text-overflow: ellipsis;
}
```

- [ ] **Step 3: Setear el valor del selector al elegir una conversación**

En `public/app.js:922-928`, cambiar la firma de `selectConv` y agregar el seteo del select:

```js
async function selectConv(convId, name, model, lastModel, projectDir, responseMode) {
  if (currentConv) drafts.set(currentConv, $('input').value);
  currentConv = convId;
  $('input').value = drafts.get(convId) || '';
  autoResize($('input'));
  $('conv-title').textContent = name;
  $('model-select').value = model || 'sonnet';
  $('response-mode-select').value = responseMode || 'directo';
```

- [ ] **Step 4: Pasar `responseMode` en cada call site de `selectConv`**

En `public/app.js:314` (click en el tree):

```js
  div.onclick = () => selectConv(c.convId, c.name, c.model, c.lastModel, c.projectDir, c.responseMode);
```

En `public/app.js:1303` (después de crear conversación nueva — no hay picker en el diálogo de creación, así que se pasa `undefined` y cae al default `'directo'`):

```js
    await selectConv(convId, text ? text.slice(0, 60) : 'Nueva conversación', model, null, resolvedDir, undefined);
```

En `public/app.js:1374` (abrir resultado de búsqueda):

```js
  await selectConv(r.convId, r.displayName || r.name, r.model, r.lastModel, r.cwd, r.responseMode);
```

En `public/app.js:1421` (switch por Tab):

```js
  selectConv(c.convId, c.name, c.model, c.lastModel, c.projectDir, c.responseMode);
```

- [ ] **Step 5: Handler de cambio de modo**

En `public/app.js`, después del bloque `$('model-select').onchange = ...` (línea 1241, antes del comentario `// ── Rename ──`):

```js
// ── Response mode change ──
$('response-mode-select').onchange = async () => {
  if (!currentConv) return;
  try {
    await api(`/conversations/${currentConv}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(withAccountBody({ responseMode: $('response-mode-select').value })),
    });
  } catch (err) { addMsg('error', 'No se pudo cambiar el modo de respuesta: ' + err.message); }
};
```

- [ ] **Step 6: Verificación manual en el browser**

```bash
npm start
```

Abrir `http://127.0.0.1:3777` en el browser:
1. Abrir una conversación existente. El selector "Modo de respuesta" debe mostrar "Directo" si nunca se configuró (default), o el valor guardado si ya se cambió antes.
2. Cambiar a "Cavernícola", enviar un mensaje simple ("¿qué hora es en Argentina ahora?"). La respuesta debe llegar notablemente más corta/directa que en modo Detallado.
3. Cambiar a "Detallado" a mitad de la misma conversación, enviar otro mensaje. Debe volver al tono normal de Claude.
4. Recargar la página y volver a abrir la misma conversación — el selector debe recordar el último modo elegido (persistencia confirmada).
5. Abrir la conversación desde el buscador (Ctrl+K) — el selector debe reflejar el modo guardado también ahí.

- [ ] **Step 7: Commit**

```bash
git add public/index.html public/style.css public/app.js
git commit -m "feat: selector de modo de respuesta por conversación en la UI de Jarvis"
```

---

### Task 5: Actualizar memoria local del proyecto

**Files:**
- Modify: `CLAUDE.local.md`

**Interfaces:**
- Ninguna — documentación.

- [ ] **Step 1: Agregar sección sobre el sistema de modos de respuesta**

En `CLAUDE.local.md`, agregar una sección nueva (después de "Bug resuelto 2026-07-20", antes de "Relación con la PC Linux"):

```markdown
## Modos de respuesta (reemplazo de caveman, 2026-07-26)

El plugin caveman se eliminó por completo del sistema (settings.json, hooks, plugin cache — sin residuos). En su lugar, Jarvis tiene su propio selector de "modo de respuesta" por conversación: Detallado / Directo (default) / Cavernícola. Lógica en `src/response-modes.js`, aplicada en `runner.js` vía `--append-system-prompt` (concatenado con el aviso de infraestructura del puerto). Selector en el header del composer, junto al de modelo — mismo patrón de persistencia (`conv.responseMode` en meta.json, PATCH `/api/conversations/:id`).
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.local.md
git commit -m "docs: documentar sistema de modos de respuesta en memoria del proyecto"
```
