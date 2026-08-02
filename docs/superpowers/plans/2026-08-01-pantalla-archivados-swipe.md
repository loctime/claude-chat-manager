# Pantalla de archivados por swipe (mobile) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reemplazar el toggle "Ver archivadas" por una segunda pantalla navegable con swipe (mobile) donde swipe-izquierda sobre la lista activa abre archivados, swipe-derecha vuelve, y swipe-derecha sobre una fila individual la archiva/desarchiva al instante con undo.

**Architecture:** `#tree-viewport` pasa a contener dos panes lado a lado (`#tree` activas, `#tree-archived` archivadas) dentro de un wrapper flex de doble ancho que se traslada con `transform: translateX()`. La navegación entre panes (`goToArchived()`/`goToActive()`) es una única función invocada tanto por el botón de desktop como por el gesto de swipe en mobile. El swipe por fila reusa el PATCH `archived` que ya existe, con animación optimista y toast con "Deshacer".

**Tech Stack:** Vanilla JS (`public/app.js`), CSS (`public/style.css`), HTML (`public/index.html`). Sin dependencias nuevas. Backend sin cambios (`src/server.js` ya expone `GET /tree?archived=1` y `PATCH /conversations/:id`).

## Global Constraints

- Gestos táctiles solo — sin soporte de mouse/drag en desktop (spec, sección "Fuera de alcance").
- No tocar `src/server.js`, `src/meta.js`, `src/scanner.js` (spec, sección "Compatibilidad").
- No agregar dependencias nuevas.
- Umbral de swipe de pantalla: 60px. Umbral de swipe de fila: 80px (spec, sección "Diseño").
- El botón "Ver archivadas" se oculta en mobile (breakpoint `max-width: 767px`, el mismo que ya usa `style.css`) y queda como único acceso a archivados en desktop.
- El long-press → menú contextual con "Archivar/Desarchivar" no cambia de comportamiento en ninguna plataforma.
- Tests existentes (`npm test`, 47 tests) deben seguir pasando después de cada task — son server-side y no deberían verse afectados, pero correrlos confirma que no se rompió nada por error.

---

### Task 1: Estructura de dos pantallas + navegación activas/archivadas (sin swipe todavía)

**Files:**
- Modify: `public/index.html` (estructura de `#panel-list`, ~L36-40)
- Modify: `public/style.css` (~L102-112, reglas de `#ptr-indicator`/`#tree`)
- Modify: `public/app.js` (estado global ~L1-10, `initPTR` ~L255-278, `loadTree`/toggle de archivadas ~L319-370, cuenta activa ~L40-49)

**Interfaces:**
- Produces: `loadTree()` (firma sin cambios, ahora siempre carga solo activas), `loadArchivedTree(): Promise<void>`, `safeLoadTree(): Promise<void>` (sin cambios de firma), `safeLoadArchivedTree(): Promise<void>`, `goToArchived(): Promise<void>`, `goToActive(): void`, variable global `viewingArchived: boolean`, variable global `archivedPaneLoaded: boolean`.
- Consumes: `api()`, `withAccountBody()`, `toast()`, `$()` — todas ya existentes, sin cambios.

- [ ] **Step 1: Reestructurar el HTML de `#panel-list`**

En `public/index.html`, reemplazar:

```html
      <div id="ptr-indicator" hidden>
        <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
        Actualizando…
      </div>
      <nav id="tree"></nav>
    </div>
```

por:

```html
      <div id="ptr-indicator" hidden>
        <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
        Actualizando…
      </div>
      <div id="tree-viewport">
        <div id="tree-viewport-inner">
          <nav id="tree" class="tree-pane"></nav>
          <nav id="tree-archived" class="tree-pane"></nav>
        </div>
      </div>
    </div>
```

- [ ] **Step 2: Actualizar el CSS del viewport**

En `public/style.css`, reemplazar:

```css
#tree { flex: 1; overflow-y: auto; }
#tree::-webkit-scrollbar { width: 4px; }
#tree::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
```

por:

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

Y en el bloque `@media (max-width: 767px)` (después de la regla de `#input`, ~L829), agregar:

```css
  .archived-toggle { display: none; }
```

- [ ] **Step 3: Agregar CSS del botón "Volver a activas" del pane archivado**

En `public/style.css`, después de la regla `.archived-toggle:hover` (~L849), agregar:

```css
.archived-back {
  display: block;
  width: calc(100% - 20px);
  margin: 8px 10px 4px;
  padding: 8px;
  background: transparent;
  color: var(--text2);
  border: none;
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  cursor: pointer;
  font-size: 13px;
  text-align: left;
}
.archived-back:hover { background: var(--input-bg); color: var(--text); }
```

- [ ] **Step 4: Reescribir el estado global y el bloque de la lista en `app.js`**

En `public/app.js`, reemplazar las líneas 1-8:

```js
let currentConv = null;
let eventSource = null;
let tree = [];
let treeLimit = 100;
let treeHasMore = false;
let treeTotal = 0;
let archivedTotal = 0;
let showArchived = false;
```

por:

```js
let currentConv = null;
let eventSource = null;
let tree = [];
let treeLimit = 100;
let treeHasMore = false;
let treeTotal = 0;
let archivedTotal = 0;
let archivedTree = [];
let archivedTreeLimit = 100;
let archivedTreeHasMore = false;
let archivedTreeTotal = 0;
let viewingArchived = false;
let archivedPaneLoaded = false;
```

- [ ] **Step 5: Reemplazar `loadTree()` por `buildTreePane` + `loadTree`/`loadArchivedTree`**

En `public/app.js`, reemplazar la función `loadTree()` completa (~L319-370, desde `async function loadTree() {` hasta el `}` que cierra antes del comentario `// ── Indicador global`) por:

```js
function buildTreePane(navEl, treeData) {
  navEl.innerHTML = '';
  for (const proj of treeData.tree) {
    const det = document.createElement('details');
    det.className = 'project';
    det.open = true;
    const sum = document.createElement('summary');
    sum.textContent = proj.projectDir.split('/').pop() || proj.projectDir;
    sum.title = proj.projectDir;
    det.appendChild(sum);
    for (const c of proj.conversations) det.appendChild(convElement(c));
    navEl.appendChild(det);
  }
}

async function loadTree() {
  const params = new URLSearchParams({ limit: String(treeLimit) });
  if (activeAccount) params.set('account', activeAccount);
  const resp = await api('/tree?' + params);
  tree = resp.tree;
  treeHasMore = resp.hasMore;
  treeTotal = resp.total;
  archivedTotal = resp.archivedTotal || 0;
  const nav = $('tree');
  buildTreePane(nav, resp);

  if (treeHasMore) {
    const more = document.createElement('button');
    more.id = 'load-more-btn';
    more.className = 'load-more';
    more.type = 'button';
    more.textContent = `Cargar más (${treeTotal - treeLimit} restantes)`;
    more.onclick = async () => {
      more.disabled = true;
      treeLimit += 100;
      try { await loadTree(); }
      catch (err) { toast('No se pudo cargar más: ' + err.message); more.disabled = false; }
    };
    nav.appendChild(more);
  }

  if (archivedTotal > 0) {
    const t = document.createElement('button');
    t.className = 'archived-toggle';
    t.type = 'button';
    t.textContent = `Ver archivadas (${archivedTotal})`;
    t.onclick = () => { goToArchived(); };
    nav.appendChild(t);
  }

  updateGlobalBusyIndicator();
}

async function loadArchivedTree() {
  const params = new URLSearchParams({ limit: String(archivedTreeLimit), archived: '1' });
  if (activeAccount) params.set('account', activeAccount);
  const resp = await api('/tree?' + params);
  archivedTree = resp.tree;
  archivedTreeHasMore = resp.hasMore;
  archivedTreeTotal = resp.total;
  const nav = $('tree-archived');
  buildTreePane(nav, resp);

  const back = document.createElement('button');
  back.className = 'archived-back';
  back.type = 'button';
  back.textContent = '← Volver a activas';
  back.onclick = () => { goToActive(); };
  nav.insertBefore(back, nav.firstChild);

  if (archivedTreeHasMore) {
    const more = document.createElement('button');
    more.id = 'load-more-archived-btn';
    more.className = 'load-more';
    more.type = 'button';
    more.textContent = `Cargar más (${archivedTreeTotal - archivedTreeLimit} restantes)`;
    more.onclick = async () => {
      more.disabled = true;
      archivedTreeLimit += 100;
      try { await loadArchivedTree(); }
      catch (err) { toast('No se pudo cargar más: ' + err.message); more.disabled = false; }
    };
    nav.appendChild(more);
  }
}

async function safeLoadArchivedTree() {
  try { await loadArchivedTree(); }
  catch (err) { toast('No se pudo actualizar archivadas: ' + err.message); }
}

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
  archivedTree = [];
  $('tree-archived').innerHTML = '';
  if (viewingArchived) goToActive();
}
```

Nota: esto elimina la variable `showArchived` (ya no existe en el nuevo estado del Step 4) y el comportamiento de reemplazar `#tree` in-place — el pane `#tree` ahora **siempre** muestra activas.

- [ ] **Step 6: Generalizar el pull-to-refresh a ambos panes**

En `public/app.js`, reemplazar el IIFE `initPTR` completo (~L255-278):

```js
(function initPTR() {
  const nav = $('tree');
  const indicator = $('ptr-indicator');
  let startY = 0;
  let pulling = false;

  nav.addEventListener('touchstart', e => {
    if (nav.scrollTop === 0) { startY = e.touches[0].clientY; pulling = true; }
  }, { passive: true });

  nav.addEventListener('touchmove', e => {
    if (!pulling) return;
    if (e.touches[0].clientY - startY > 60) indicator.hidden = false;
  }, { passive: true });

  nav.addEventListener('touchend', async () => {
    if (!pulling) return;
    pulling = false;
    if (!indicator.hidden) {
      await loadTree();
      indicator.hidden = true;
    }
  });
})();
```

por:

```js
function initPTR(navEl, loadFn) {
  const indicator = $('ptr-indicator');
  let startY = 0;
  let pulling = false;

  navEl.addEventListener('touchstart', e => {
    if (navEl.scrollTop === 0) { startY = e.touches[0].clientY; pulling = true; }
  }, { passive: true });

  navEl.addEventListener('touchmove', e => {
    if (!pulling) return;
    if (e.touches[0].clientY - startY > 60) indicator.hidden = false;
  }, { passive: true });

  navEl.addEventListener('touchend', async () => {
    if (!pulling) return;
    pulling = false;
    if (!indicator.hidden) {
      await loadFn();
      indicator.hidden = true;
    }
  });
}
initPTR($('tree'), safeLoadTree);
initPTR($('tree-archived'), safeLoadArchivedTree);
```

- [ ] **Step 7: Invalidar el pane archivado al cambiar de cuenta**

En `public/app.js`, dentro de `loadAccounts()`, reemplazar (~L40-49):

```js
    sel.onchange = async () => {
      await fetch('/api/accounts/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: sel.value }),
      });
      activeAccount = sel.value;
      treeLimit = 100;
      loadTree();
    };
```

por:

```js
    sel.onchange = async () => {
      await fetch('/api/accounts/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: sel.value }),
      });
      activeAccount = sel.value;
      treeLimit = 100;
      resetArchivedPane();
      loadTree();
    };
```

- [ ] **Step 8: Correr los tests existentes**

Run: `cd "C:\Users\User\Desktop\Proyectos\claude-chat-manager" && npm test`
Expected: los 47 tests pasan igual que antes (este task no toca `src/`).

- [ ] **Step 9: Verificación manual**

Levantar el server (`start.bat` o `node src/server.js`), abrir `http://127.0.0.1:3777` en el browser (desktop). Confirmar: la lista activa se ve igual que antes; si hay conversaciones archivadas, aparece el botón "Ver archivadas (N)" al fondo de la lista; al clickearlo, la vista desliza (animación CSS) mostrando las archivadas con un botón "← Volver a activas" arriba; al clickearlo, vuelve a activas. Confirmar que "Cargar más" sigue funcionando en ambas pantallas si hay más de 100 conversaciones.

- [ ] **Step 10: Commit**

```bash
git add public/index.html public/style.css public/app.js
git commit -m "feat: pantallas separadas para activas/archivadas (navegación por botón)"
```

---

### Task 2: Swipe de pantalla (mobile) entre activas y archivadas

**Files:**
- Modify: `public/app.js` (nueva función al final del archivo, antes de `loadAccounts().then(...)`)

**Interfaces:**
- Consumes: `goToArchived()`, `goToActive()`, `viewingArchived` (de Task 1).
- Produces: ninguna interfaz nueva consumida por otro task.

- [ ] **Step 1: Agregar el gesto de swipe de pantalla**

En `public/app.js`, agregar antes de la línea `async function safeLoadTree() {` (~L1543 antes del refactor de Task 1, buscar por el comentario o por la función):

```js
// ── Swipe de pantalla (activas ↔ archivadas, solo táctil) ──
(function initPaneSwipe() {
  const viewport = $('tree-viewport');
  const inner = $('tree-viewport-inner');
  const SWIPE_THRESHOLD = 60;
  let startX = 0, startY = 0, axisLocked = null, dragging = false, currentTranslate = 0;

  const paneWidth = () => viewport.getBoundingClientRect().width;

  viewport.addEventListener('touchstart', e => {
    if (e.target.closest('.conv')) return;
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
    axisLocked = null;
    dragging = true;
    inner.style.transition = 'none';
  }, { passive: true });

  viewport.addEventListener('touchmove', e => {
    if (!dragging) return;
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (axisLocked === null) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      axisLocked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    if (axisLocked !== 'x') return;
    e.preventDefault();
    const base = viewingArchived ? -paneWidth() : 0;
    currentTranslate = Math.min(0, Math.max(-paneWidth(), base + dx));
    inner.style.transform = `translateX(${currentTranslate}px)`;
  }, { passive: false });

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    inner.style.transition = '';
    inner.style.transform = '';
    if (axisLocked === 'x') {
      const base = viewingArchived ? -paneWidth() : 0;
      const delta = currentTranslate - base;
      if (!viewingArchived && delta < -SWIPE_THRESHOLD) goToArchived();
      else if (viewingArchived && delta > SWIPE_THRESHOLD) goToActive();
    }
    axisLocked = null;
  }

  viewport.addEventListener('touchend', endDrag);
  viewport.addEventListener('touchcancel', endDrag);
})();

```

- [ ] **Step 2: Correr los tests existentes**

Run: `cd "C:\Users\User\Desktop\Proyectos\claude-chat-manager" && npm test`
Expected: los 47 tests siguen pasando (cambio 100% frontend).

- [ ] **Step 3: Verificación manual con emulación táctil**

En Chrome DevTools, activar "Toggle device toolbar" (Ctrl+Shift+M) para simular touch, recargar la página. Sobre el fondo de la lista activa (no sobre una fila — por ejemplo debajo de la última conversación, o sobre el encabezado de un proyecto), arrastrar hacia la izquierda más de 60px: debe animarse a la pantalla de archivados. Arrastrar hacia la derecha desde ahí: debe volver. Un arrastre corto (<60px) debe volver a la posición original sin navegar. Verificar también en un celular real conectado a `http://127.0.0.1:3777` (o la URL de `jarvis.controlapps.ar`) si es posible.

- [ ] **Step 4: Commit**

```bash
git add public/app.js
git commit -m "feat: swipe horizontal entre lista activa y archivados (mobile)"
```

---

### Task 3: Toast con acción "Deshacer"

**Files:**
- Modify: `public/app.js` (función `toast()`, ~L53-70)
- Modify: `public/style.css` (reglas `.toast`, ~L1000-1015)

**Interfaces:**
- Produces: `toast(msg: string, kind?: string, ttl?: number, action?: { label: string, onClick: () => void }): void` (firma retrocompatible — `action` es opcional y por default `null`).

- [ ] **Step 1: Extender `toast()`**

En `public/app.js`, reemplazar la función `toast()` completa (~L53-70):

```js
// ── Toast ──
function toast(msg, kind = 'error', ttl = 4000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transition = 'opacity .2s';
    setTimeout(() => t.remove(), 220);
  }, ttl);
}
```

por:

```js
// ── Toast ──
function toast(msg, kind = 'error', ttl = 4000, action = null) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  const text = document.createElement('span');
  text.textContent = msg;
  t.appendChild(text);

  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    t.style.opacity = '0';
    t.style.transition = 'opacity .2s';
    setTimeout(() => t.remove(), 220);
  };

  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.type = 'button';
    btn.textContent = action.label;
    btn.onclick = () => { remove(); action.onClick(); };
    t.appendChild(btn);
  }

  container.appendChild(t);
  setTimeout(remove, ttl);
}
```

- [ ] **Step 2: CSS del layout con botón de acción**

En `public/style.css`, reemplazar la regla `.toast` (~L1000-1014):

```css
.toast {
  background: var(--header);
  color: var(--text);
  border: 1px solid var(--border);
  border-left: 3px solid var(--danger);
  padding: 10px 14px;
  border-radius: var(--radius);
  box-shadow: 0 4px 12px rgba(0,0,0,.4);
  font-size: 14px;
  max-width: 380px;
  word-wrap: break-word;
  white-space: pre-line;
  pointer-events: auto;
  animation: toast-in .18s ease-out;
}
```

por:

```css
.toast {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--header);
  color: var(--text);
  border: 1px solid var(--border);
  border-left: 3px solid var(--danger);
  padding: 10px 14px;
  border-radius: var(--radius);
  box-shadow: 0 4px 12px rgba(0,0,0,.4);
  font-size: 14px;
  max-width: 380px;
  word-wrap: break-word;
  white-space: pre-line;
  pointer-events: auto;
  animation: toast-in .18s ease-out;
}
.toast span { flex: 1; }
.toast-action {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--accent);
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
  padding: 4px;
}
.toast-action:hover { text-decoration: underline; }
```

- [ ] **Step 3: Correr los tests existentes**

Run: `cd "C:\Users\User\Desktop\Proyectos\claude-chat-manager" && npm test`
Expected: los 47 tests siguen pasando.

- [ ] **Step 4: Verificación manual**

Con el server corriendo, abrir la consola del browser en `http://127.0.0.1:3777` y ejecutar `toast('Conversación archivada', 'info', 8000, { label: 'Deshacer', onClick: () => console.log('undo!') })`. Confirmar que aparece el toast con el botón "Deshacer" a la derecha, que clickearlo lo cierra y loguea `undo!` en consola, y que un toast sin `action` (ej. `toast('probando', 'info')`) se ve igual que antes (sin botón).

- [ ] **Step 5: Commit**

```bash
git add public/app.js public/style.css
git commit -m "feat: toast con acción opcional (deshacer)"
```

---

### Task 4: Swipe por fila para archivar/desarchivar con undo

**Files:**
- Modify: `public/app.js` (`attachContextMenu` → `attachRowGestures`, ~L385-430; su call site en `convElement`, ~L315; `showConvMenu`'s `doAction`, ~L466-476)
- Modify: `public/style.css` (agregar `touch-action: pan-y` a `.conv`, ~L127-138)

**Interfaces:**
- Consumes: `toast()` con `action` (Task 3), `api()`, `withAccountBody()`, `safeLoadTree()`, `safeLoadArchivedTree()`, `archivedPaneLoaded` (Task 1).
- Produces: `attachRowGestures(el: HTMLElement, conv: object): void` (reemplaza `attachContextMenu`, mismo rol), `commitArchiveToggle(el: HTMLElement, conv: object): Promise<void>`, `refreshAfterArchiveChange(): void`.

- [ ] **Step 1: `touch-action` en las filas**

En `public/style.css`, en la regla `.conv` (~L127-138), agregar la línea `touch-action: pan-y;` dentro de las declaraciones existentes (junto a `-webkit-touch-callout: none;`).

- [ ] **Step 2: Agregar `refreshAfterArchiveChange` y `commitArchiveToggle`**

En `public/app.js`, agregar estas dos funciones inmediatamente antes de `function attachContextMenu(el, conv) {` (~L386):

```js
function refreshAfterArchiveChange() {
  safeLoadTree();
  if (archivedPaneLoaded) safeLoadArchivedTree();
}

async function commitArchiveToggle(el, conv) {
  const wasArchived = !!conv.archived;
  const newArchived = !wasArchived;
  el.style.transition = 'transform .18s ease, opacity .18s ease';
  el.style.transform = 'translateX(100%)';
  el.style.opacity = '0';
  setTimeout(() => { el.remove(); }, 180);

  try {
    await api(`/conversations/${conv.convId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(withAccountBody({ archived: newArchived })),
    });
  } catch (err) {
    toast('No se pudo actualizar: ' + err.message);
    refreshAfterArchiveChange();
    return;
  }

  const label = newArchived ? 'Conversación archivada' : 'Conversación desarchivada';
  toast(label, 'info', 4000, {
    label: 'Deshacer',
    onClick: async () => {
      try {
        await api(`/conversations/${conv.convId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(withAccountBody({ archived: wasArchived })),
        });
      } catch (err) {
        toast('No se pudo deshacer: ' + err.message);
      }
      refreshAfterArchiveChange();
    },
  });
  refreshAfterArchiveChange();
}
```

- [ ] **Step 3: Reescribir `attachContextMenu` como `attachRowGestures` con swipe**

En `public/app.js`, reemplazar la función completa `attachContextMenu` (~L386-430):

```js
// ── Menú contextual (click derecho + long-press mobile) ──
function attachContextMenu(el, conv) {
  let touchTimer = null;
  let longPressed = false;
  let startX = 0, startY = 0;

  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    showConvMenu(e.clientX, e.clientY, conv);
  });

  el.addEventListener('touchstart', e => {
    longPressed = false;
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
    touchTimer = setTimeout(() => {
      longPressed = true;
      touchTimer = null;
      showConvMenu(startX, startY, conv);
      if (navigator.vibrate) { try { navigator.vibrate(30); } catch {} }
    }, 500);
  }, { passive: true });

  el.addEventListener('touchmove', e => {
    if (!touchTimer) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) {
      clearTimeout(touchTimer);
      touchTimer = null;
    }
  }, { passive: true });

  el.addEventListener('touchend', () => {
    if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
  }, { passive: true });

  // Bloquear el click sintético que dispara touchend después del long-press
  // (si no, selecciona la conversación y cierra el menú)
  el.addEventListener('click', e => {
    if (longPressed) {
      longPressed = false;
      e.stopPropagation();
      e.preventDefault();
    }
  }, { capture: true });
}
```

por:

```js
// ── Menú contextual (click derecho + long-press mobile) + swipe-derecha para archivar ──
const ROW_SWIPE_THRESHOLD = 80;

function attachRowGestures(el, conv) {
  let touchTimer = null;
  let longPressed = false;
  let startX = 0, startY = 0;
  let axisLocked = null;
  let rowDragging = false;
  let currentDx = 0;

  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    showConvMenu(e.clientX, e.clientY, conv);
  });

  el.addEventListener('touchstart', e => {
    longPressed = false;
    axisLocked = null;
    rowDragging = false;
    currentDx = 0;
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
    touchTimer = setTimeout(() => {
      longPressed = true;
      touchTimer = null;
      showConvMenu(startX, startY, conv);
      if (navigator.vibrate) { try { navigator.vibrate(30); } catch {} }
    }, 500);
  }, { passive: true });

  el.addEventListener('touchmove', e => {
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (axisLocked === null) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      axisLocked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
    }
    if (axisLocked !== 'x') return;
    e.preventDefault();
    rowDragging = true;
    currentDx = Math.max(0, dx);
    el.style.transform = `translateX(${currentDx}px)`;
    el.style.opacity = String(Math.max(0.3, 1 - currentDx / 200));
  }, { passive: false });

  function resetRow() {
    el.style.transition = 'transform .2s ease, opacity .2s ease';
    el.style.transform = '';
    el.style.opacity = '';
    setTimeout(() => { el.style.transition = ''; }, 200);
  }

  el.addEventListener('touchend', () => {
    if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
    if (rowDragging) {
      if (currentDx > ROW_SWIPE_THRESHOLD) commitArchiveToggle(el, conv);
      else resetRow();
    }
    rowDragging = false;
    axisLocked = null;
  });

  el.addEventListener('touchcancel', () => {
    if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
    if (rowDragging) resetRow();
    rowDragging = false;
    axisLocked = null;
  });

  // Bloquear el click sintético que dispara touchend después del long-press
  // (si no, selecciona la conversación y cierra el menú)
  el.addEventListener('click', e => {
    if (longPressed) {
      longPressed = false;
      e.stopPropagation();
      e.preventDefault();
    }
  }, { capture: true });
}
```

- [ ] **Step 4: Actualizar el call site en `convElement`**

En `public/app.js`, dentro de `convElement(c)` (~L315), reemplazar:

```js
  attachContextMenu(div, c);
```

por:

```js
  attachRowGestures(div, c);
```

- [ ] **Step 5: Reusar `refreshAfterArchiveChange` en el menú contextual**

En `public/app.js`, dentro de `showConvMenu`'s `doAction` (~L466-476), reemplazar:

```js
    const patch = action === 'pin'
      ? { pinned: !conv.pinned }
      : { archived: !conv.archived };
    try {
      await api(`/conversations/${conv.convId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(withAccountBody(patch)),
      });
      safeLoadTree();
    } catch (err) { toast('No se pudo actualizar: ' + err.message); }
```

por:

```js
    const patch = action === 'pin'
      ? { pinned: !conv.pinned }
      : { archived: !conv.archived };
    try {
      await api(`/conversations/${conv.convId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(withAccountBody(patch)),
      });
      if (action === 'archive') refreshAfterArchiveChange(); else safeLoadTree();
    } catch (err) { toast('No se pudo actualizar: ' + err.message); }
```

- [ ] **Step 6: Correr los tests existentes**

Run: `cd "C:\Users\User\Desktop\Proyectos\claude-chat-manager" && npm test`
Expected: los 47 tests siguen pasando.

- [ ] **Step 7: Verificación manual con emulación táctil**

Con "Toggle device toolbar" activo, sobre una fila de la lista activa, arrastrar hacia la derecha más de 80px y soltar: la fila debe deslizarse fuera y desaparecer, y debe aparecer el toast "Conversación archivada" con botón "Deshacer". Clickear "Deshacer": debe volver a aparecer en la lista activa tras el refresh. Repetir el gesto y esta vez NO deshacer: cambiar a la pantalla de archivados (Task 2) y confirmar que la conversación aparece ahí; arrastrarla hacia la derecha ahí también: debe desarchivarse y volver a activas. Confirmar que el long-press (mantener sin mover el dedo) sigue abriendo el menú contextual normalmente, sin disparar el swipe.

- [ ] **Step 8: Commit**

```bash
git add public/app.js public/style.css
git commit -m "feat: swipe por fila para archivar/desarchivar con undo"
```

---

### Task 5: Verificación end-to-end y limpieza de memoria del proyecto

**Files:**
- Modify: `C:\Users\User\Desktop\Proyectos\claude-chat-manager\CLAUDE.local.md` (agregar entrada nueva)

**Interfaces:** Ninguna (task de verificación y documentación, no agrega código).

- [ ] **Step 1: Recorrido manual completo en celular real**

Con el server corriendo y accesible desde el celu (`https://jarvis.controlapps.ar` o la IP local), probar en orden: abrir la app, swipe izquierda sobre la lista activa para ver archivados, swipe derecha para volver, swipe derecha sobre una fila activa para archivarla, deshacer desde el toast, volver a archivarla sin deshacer, entrar a archivados y desarchivarla con swipe, confirmar que vuelve a aparecer en activas. Probar también el long-press normal (pin/archivar/compactar) en ambas pantallas. Probar en desktop (mouse, sin swipe) que el botón "Ver archivadas" y "← Volver a activas" siguen funcionando.

- [ ] **Step 2: Confirmar que no quedaron referencias muertas**

Run: `grep -rn "showArchived\|attachContextMenu" "C:\Users\User\Desktop\Proyectos\claude-chat-manager\public"`
Expected: sin resultados (ambos fueron reemplazados en los tasks anteriores).

- [ ] **Step 3: Correr la suite completa una última vez**

Run: `cd "C:\Users\User\Desktop\Proyectos\claude-chat-manager" && npm test`
Expected: 47/47 tests pasan.

- [ ] **Step 4: Documentar en la memoria local del proyecto**

En `C:\Users\User\Desktop\Proyectos\claude-chat-manager\CLAUDE.local.md`, agregar una sección nueva después de la sección "## Bug \"No conversation found with session ID\" — resuelto 2026-07-27" (antes de "## Relación con la PC Linux"):

```markdown
## Pantalla de archivados por swipe — 2026-08-01

`#tree-viewport` contiene dos panes lado a lado (`#tree` activas, `#tree-archived` archivadas) que se navegan con `goToArchived()`/`goToActive()` (toggle de clase `.showing-archived` sobre `#tree-viewport-inner`, transform CSS). En mobile se dispara por swipe horizontal (solo táctil, sin soporte de mouse); en desktop, por el botón "Ver archivadas"/"← Volver a activas" (el botón se oculta en mobile vía CSS `max-width: 767px`). El swipe por fila (`attachRowGestures`, ex `attachContextMenu`) archiva/desarchiva con animación optimista + `PATCH /conversations/:id` + toast "Deshacer" (`toast()` ahora acepta un 4to parámetro `action`). Diseño completo en `docs/superpowers/specs/2026-08-01-pantalla-archivados-swipe-design.md`.

Gotcha resuelto durante el diseño: el pane de archivados quedaba con datos de la cuenta vieja al cambiar de cuenta (multi-account, solo Linux) — se invalida con `resetArchivedPane()` en el `onchange` del selector de cuentas.
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.local.md
git commit -m "docs: registrar pantalla de archivados por swipe en memoria local"
```
