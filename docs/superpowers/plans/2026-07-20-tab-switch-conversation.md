# Atajo TAB para alternar entre las 2 primeras conversaciones — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Presionar `Tab` en la pantalla principal de Jarvis alterna entre la conversación en posición 1 y posición 2 del sidebar, dejando el cursor listo para escribir en el input.

**Architecture:** Todo el cambio vive en `public/app.js` (frontend puro, sin dependencias de sistema operativo). Se guarda una referencia al objeto de cada conversación en su nodo DOM al construirlo, y un listener global de `keydown` decide a cuál de las dos primeras saltar y reutiliza la función `selectConv()` ya existente para hacer el cambio (carga mensajes, reabre el stream, guarda el borrador, enfoca el input).

**Tech Stack:** JavaScript vanilla (sin build step, sin framework), tal como el resto de `public/app.js`.

## Global Constraints

- Spec de referencia: `docs/superpowers/specs/2026-07-20-tab-switch-conversation-design.md`.
- Solo tocar `public/app.js` y `public/index.html` (cache-busting). No tocar `src/runner.js` ni `src/server.js` — no hay lógica de servidor involucrada.
- Sin dialog abierto (`<dialog open>`) el TAB no se intercepta — debe comportarse como el navegador por defecto.
- Sin conversación abierta (`currentConv` null) o con menos de 2 conversaciones en el sidebar, el TAB no hace nada.
- Toggle simple: si la conversación abierta es la #1 del sidebar, pasa a la #2; en cualquier otro caso (#2 o cualquier otra), pasa a la #1.
- Este repo no tiene infraestructura de test de DOM/frontend (no hay jsdom ni similar; `npm test` con `node --test` solo cubre `src/*.js` de backend — ver `test/*.test.js`). No se agrega una dependencia nueva solo para esta feature chica: la verificación de este plan es manual, con Playwright contra el server corriendo, siguiendo el mismo patrón ya usado para validar el fix de SSE de esta sesión.

---

### Task 1: Guardar referencia de conversación en el DOM + atajo TAB

**Files:**
- Modify: `public/app.js:292-317` (función `convElement`)
- Modify: `public/app.js:1458-1463` (zona de listeners `keydown` globales — se agrega uno nuevo a continuación)
- Modify: `public/index.html:190` (bump de cache-busting `app.js?v=20` → `app.js?v=21`)

**Interfaces:**
- Consumes: `selectConv(convId, name, model, lastModel)` (ya existe, `public/app.js:919`) — no cambia su firma.
- Consumes: `currentConv` (variable global ya existente, `public/app.js:1`).
- Produces: cada nodo `.conv` del sidebar queda con una propiedad `_conv` (el objeto `c` completo tal como lo devuelve `/api/tree`) para que el nuevo listener pueda leer `convId`, `name`, `model`, `lastModel` sin volver a pedirlos al servidor.

- [ ] **Step 1: Guardar el objeto conversación en el nodo DOM**

En `public/app.js`, dentro de `convElement(c)`, agregar la asignación justo antes del `onclick` (que es lo próximo que usa `c`):

Reemplazar:
```js
  div.querySelector('.conv-name-text').textContent = c.name;
  div.querySelector('.conv-date').textContent = (c.lastActivity || '').slice(0, 16).replace('T', ' ');
  div.onclick = () => selectConv(c.convId, c.name, c.model, c.lastModel);
```

Por:
```js
  div.querySelector('.conv-name-text').textContent = c.name;
  div.querySelector('.conv-date').textContent = (c.lastActivity || '').slice(0, 16).replace('T', ' ');
  div._conv = c;
  div.onclick = () => selectConv(c.convId, c.name, c.model, c.lastModel);
```

- [ ] **Step 2: Agregar el listener de TAB**

En `public/app.js`, ubicar el listener de Ctrl/Cmd+K (búsqueda):

```js
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openSearchDialog();
  }
});
```

Agregar inmediatamente después (misma zona de atajos globales, antes de `async function safeLoadTree() {`):

```js
document.addEventListener('keydown', e => {
  if (e.key !== 'Tab') return;
  if (document.querySelector('dialog[open]')) return;
  if (!currentConv) return;
  const top2 = [...document.querySelectorAll('#tree .conv')].slice(0, 2);
  if (top2.length < 2) return;
  e.preventDefault();
  const target = top2[0]._conv.convId === currentConv ? top2[1] : top2[0];
  const c = target._conv;
  selectConv(c.convId, c.name, c.model, c.lastModel);
});
```

- [ ] **Step 3: Bump del cache-busting**

En `public/index.html:190`, cambiar:
```html
  <script src="app.js?v=20"></script>
```
Por:
```html
  <script src="app.js?v=21"></script>
```

- [ ] **Step 4: Reiniciar el server local y verificar manualmente con Playwright**

Jarvis no tiene hot-reload; hay que reiniciar el proceso para que sirva el `app.js` nuevo. Server real corriendo en `C:\Users\User\Desktop\Proyectos\claude-chat-manager`, puerto 3777, expuesto en `https://jarvis.controlapps.ar`.

```bash
# matar el proceso node actual del server (ver PID con: netstat -ano | grep 3777)
taskkill //PID <pid> //F
# levantar de nuevo con log
cd "C:\Users\User\Desktop\Proyectos\claude-chat-manager"
node -e "require('./src/server.js')" > "$TEMP/jarvis-server.log" 2>&1 &
disown
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3777/
# esperar: 302 (redirect a login)
```

Con el MCP de Playwright (`mcp__playwright__browser_navigate` a `https://jarvis.controlapps.ar`, ya autenticado por cookie de la sesión anterior):

1. Abrir la conversación que está en la posición 1 del sidebar (la más reciente). Confirmar con `browser_snapshot` que quedó marcada como activa.
2. Presionar `Tab` (`browser_press_key` con `key: "Tab"`). Confirmar que la conversación abierta pasó a ser la de posición 2 (el título del chat cambió, y en el sidebar la posición 2 ahora tiene la clase `active`).
3. Presionar `Tab` de nuevo. Confirmar que vuelve a la posición 1.
4. Con una conversación abierta, hacer foco en el input de mensaje (`#input`) y escribir un texto de prueba sin enviarlo (ej. "borrador de prueba"). Presionar `Tab`. Confirmar que: (a) cambió de conversación, (b) el input quedó vacío o con el borrador de la conversación destino (no con "borrador de prueba"), (c) el input tiene el foco (compará `document.activeElement` vía `browser_evaluate`, o simplemente escribí un caracter después del Tab y confirmá que aparece en el input sin haber hecho click).
5. Volver a la conversación de posición 1 (Tab) y confirmar que el borrador "borrador de prueba" seguía ahí (`browser_snapshot` del input).
6. Abrir el diálogo de Búsqueda (Ctrl/Cmd+K o el botón de lupa). Con el diálogo abierto, presionar `Tab`. Confirmar que la conversación NO cambió (el título del chat de fondo sigue siendo el mismo) — el TAB debe haber navegado el foco dentro del diálogo, no disparado el atajo.
7. Cerrar el diálogo. Sin ninguna conversación seleccionada (recargar la página para volver a la pantalla "Elegí una conversación" si hace falta), presionar `Tab`. Confirmar que sigue en esa pantalla (no se abrió ninguna conversación).

Expected: los 7 puntos se cumplen. Si alguno falla, no continuar al Step 5 — diagnosticar con `browser_console_messages` (nivel error) antes de tocar más código.

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\User\Desktop\Proyectos\claude-chat-manager"
git add public/app.js public/index.html
git commit -m "$(cat <<'EOF'
feat(ui): TAB alterna entre las 2 primeras conversaciones del sidebar

Reusa selectConv() para el cambio (guarda borrador, recarga mensajes,
reabre el stream, deja el cursor listo en el input). Se desactiva con
cualquier <dialog> abierto para no romper la navegación normal de
formularios.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
