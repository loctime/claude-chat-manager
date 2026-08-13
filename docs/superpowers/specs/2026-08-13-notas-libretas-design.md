# Notas: múltiples libretas — diseño

**Fecha:** 2026-08-13
**Estado:** aprobado, listo para plan de implementación

## Contexto

El feature "Notas" (anotador sin IA, ver `docs/superpowers/specs/2026-08-11-notas-jarvis-design.md`) hoy es una sola libreta global: todo el texto va a `~/.ccm-notes/notes.jsonl` y todos los adjuntos a `~/Desktop/Notas Jarvis/`. Diego quiere poder tener varias libretas separadas (como "conversaciones" de notas), elegibles desde una lista.

Las notas existentes (todas de prueba) se descartan — no hay migración de datos vieja que preservar.

## Modelo de datos

- `~/.ccm-notes/notebooks.json` — índice de libretas: `[{id, name, createdAt}]`. El orden del array es el orden en que se listan (las nuevas se agregan al final).
- `~/.ccm-notes/notebooks/<id>/notes.jsonl` — un archivo append-only por libreta, mismo formato de entrada que ya usa `src/notes.js` (id, ts, kind, text/filePath/etc.).
- Adjuntos: siguen todos juntos en `~/Desktop/Notas Jarvis/`, sin subcarpetas por libreta (decisión explícita: simple, todo junto).
- El `notes.jsonl` viejo (formato plano, sin libretas) se descarta en el deploy — no hay lógica de migración. Instalación nueva arranca con `notebooks.json` vacío (lista de libretas vacía); la primera libreta se crea a mano con el botón "+".

## Backend — endpoints

Reemplazan a los actuales `GET/POST /api/notes` y `POST /api/notes/upload` (que se eliminan):

- `GET /api/notebooks` — lista de libretas para pintar la pantalla de selección.
- `POST /api/notebooks` — crea una libreta nueva. Nombre por default `"Nueva libreta"`; si ya existe una con ese nombre exacto, `"Nueva libreta 2"`, `"Nueva libreta 3"`, etc. No pide nombre al usuario — se crea y se abre directo.
- `PATCH /api/notebooks/:id` — renombrar (mismo patrón que `PATCH /conversations/:id` ya usado para chats).
- `GET /api/notebooks/:id/notes` — reemplaza `GET /api/notes`, scopeado a la libreta.
- `POST /api/notebooks/:id/notes` — nota de texto, scopeada.
- `POST /api/notebooks/:id/notes/upload` — adjunto, scopeado (sigue usando `notes.FILES_DIR` compartido).

Todos cubiertos por el mismo middleware `ACCESS_PIN` que ya protege el resto de la API.

**Auto-nombre:** cuando se agrega la primera nota de texto a una libreta cuyo nombre todavía matchea el patrón default (`"Nueva libreta"` o `"Nueva libreta N"`), el server la renombra usando el principio de esa nota (mismo criterio que ya se usa para el título automático de un chat a partir del primer mensaje). Corre server-side en el `POST` de la nota, así aplica sin importar qué cliente la mandó. Si el usuario ya la renombró a mano, el nombre deja de matchear el patrón default y este auto-rename no la vuelve a tocar.

## Frontend — navegación

Reusa el mecanismo de lista+detalle que el chat normal ya tiene resuelto para mobile y desktop, en vez de inventar una interacción nueva:

- El pane "Notas" (una de las 3 pestañas/swipe existentes: Chats / Archivado / Notas) deja de abrir una libreta directo y pasa a mostrar una **lista de libretas** — mismo look que `#tree` (fila con nombre + fecha de la última nota), con un botón "+" en el header para crear una libreta nueva.
- Al tocar una libreta se abre reusando el **mismo overlay que ya usan para abrir un chat** (`#panel-chat` / clase `.open` / `history.pushState` para el botón atrás de Android): en mobile, pantalla completa con botón atrás; en desktop, panel fijo al lado de la lista, igual layout que Chats hoy.
- Adentro de la libreta abierta: el header muestra el nombre (doble-click para renombrar in-place, mismo patrón que `#conv-title` — `contentEditable` + `PATCH` al perder foco), y debajo el composer + mensajes que ya existen hoy (`renderNotes`, `notes-composer`, adjuntar archivo) prácticamente sin tocar — solo que ahora quedan scopeados a un `notebookId` en vez de un archivo único global.
- El polling de 5s pasa a refrescar según dónde esté parado el usuario: la lista de libretas (liviano: nombres + fecha) si está viendo la lista, o las notas de la libreta abierta si está adentro de una — mismo gateo por visibilidad (`activePane === 2` / `document.hidden`) que ya existe.

## Fuera de alcance (v1)

- Borrar libretas.
- Reordenar libretas manualmente.
- Subcarpetas de adjuntos por libreta.

## Testing

- Extender `test/notes.test.js` (o crear `test/notebooks.test.js`) para el módulo de storage de libretas: crear, listar, renombrar, auto-nombre desde primera nota, `notes.jsonl` por libreta aislado del resto.
- Tests de los endpoints nuevos en `server.js`.
- Verificación manual en vivo con Playwright del flujo mobile completo (lista de libretas → abrir una → escribir/adjuntar → volver con gesto atrás) antes de dar por cerrado, replicando el enfoque que ya destapó bugs reales en la v1 de Notas.
