# Limpieza de sesiones — diseño

**Fecha:** 2026-08-20
**Estado:** aprobado, listo para plan de implementación

## Contexto

`~/.claude/projects/**/*.jsonl` acumula sesiones de Claude Code sin límite — en la cuenta
Windows `User` ya son ~4,1 GB. Hoy la app solo puede archivar/ocultar conversaciones
(`conv.archived`/`conv.hidden` en `meta.json`), lo cual nunca borra el `.jsonl` real: cero
espacio liberado. Diego quiere una pantalla para ver todas las sesiones con filtros/orden/
clasificación y borrarlas de verdad quirúrgico, sin perder lo importante.

**Alcance explícito, decisión de Diego:** cada instalación de la app limpia solo la cuenta de
Windows bajo la que corre su propio proceso — no hay lectura/escritura cross-cuenta. Hoy desde
`locti` no hay permiso sobre `C:\Users\User\.claude\projects`; resolver eso (ACL o correr esta
misma app parada en `User`) queda fuera de esta feature.

## Clasificación

Una etiqueta por sesión, primera que matchea en este orden:

1. `channel` — sesión de canal/plugin (MCP). Hoy `scanner.isChannelSession()` hace que
   `sessionInfo()` devuelva `null` para estas y quedan invisibles en toda la app, incluida esta
   pantalla nueva si reusáramos `listSessions()` tal cual — por eso hace falta un camino de
   lectura aparte (ver Backend).
2. `app` — el `sessionId` está referenciado por alguna `conv.currentSessionId` (o en
   `data.superseded`) de `meta.json` de esa cuenta.
3. `trivial` — no referenciada, `messageCount <= 2`. Huele a sesión abortada o de prueba.
4. `orphan` — no referenciada, con contenido real. Sesión abierta por fuera de la app
   (`claude` corrido directo en terminal).

## Protección (bloquea el borrado, calculada server-side)

Una sesión es `protected` si **cualquiera** de estas es cierta:

- Es `app` y su conversación tiene `archived: true` o `pinned: true`.
- Está corriendo ahora (`status` `running`/`queued`, mismo cálculo que ya usa `convStatus()`).
- `lastActivity` cae dentro de los últimos 5 días.

Se muestra igual en la lista (para que Diego vea que existe y por qué no se puede tocar), pero
no es seleccionable. El motivo se manda al cliente como texto corto (`pinned` / `archived` /
`running` / `recent`) para pintar el badge, y **se recalcula en el servidor al momento del
borrado** — nunca se confía en un filtro viejo del browser.

## Backend

No se toca `scanner.listSessions()`/`sessionInfo()` (los usa el chat en vivo) — se agrega una
función nueva y aislada:

- **`scanner.listForCleanup(projectsDir)`** — mismo recorrido de carpetas que `listSessions()`,
  pero sin descartar sesiones de canal ni vacías. Por archivo devuelve
  `{ sessionId, filePath, sizeBytes, cwd, messageCount, lastActivity, isChannel, snippet }`.
  Reusa `_computeSessionInfo`/`isChannelSession` internamente en vez de duplicar el parseo.

Dos endpoints nuevos en `server.js` (junto a los demás `/api/conversations*`, mismo middleware
`ACCESS_PIN`):

- **`GET /api/cleanup/sessions?account=`** — junta `scanner.listForCleanup()` con `meta.json`
  de esa cuenta: clasifica, calcula `protected`+motivo, suma `convId`/nombre/pin/archived cuando
  aplica. Devuelve la lista completa más agregados (`totalBytes`, conteos por clasificación) para
  pintar los chips de filtro sin que el cliente tenga que recalcularlos.
- **`POST /api/cleanup/delete`** — body `{ account, sessionIds: [...] }`. Por cada id: recalcula
  protección; si está protegida o el archivo ya no existe, va a `skipped` con motivo; si no,
  `fs.unlinkSync` del `.jsonl` y, si era `app`, borra también la entrada de `data.conversations`
  (y de `data.superseded` si estuviera) y guarda `meta.json`. Un fallo puntual (permisos, archivo
  en uso) no aborta el lote — sigue con el resto. Al final dispara
  `syncSearchIndex(account, { reason: 'cleanup' })` (ya existe, reindexa por diff contra disco así
  que las filas de las sesiones borradas salen solas del índice FTS5) y responde
  `{ deleted: [...], skipped: [{id, reason}], freedBytes }`.

## Frontend

Nuevo archivo `public/sessions-cleanup.js`, cargado como `<script>` clásico después de
`app.js` — mismo patrón que ya se usó para `toast.js`/`pwa.js`/`tts.js`/`search.js` en el split
en curso (scope global compartido, sin bundler). No se toca el `app.js` monolítico salvo para
sumar el botón de la pestaña nueva al switcher existente.

- **Pestaña "Sesiones"** nueva en el switcher (Chats / Archivado / Notas / **Sesiones**), mismo
  mecanismo de swipe/click ya existente entre panes.
- **Tabla**: nombre/snippet, carpeta (`cwd`, basename), badge de clasificación, tamaño (MB),
  última actividad. Fila protegida: checkbox disabled + badge del motivo.
- **Filtros**: chips de clasificación (multi-select), dropdown de carpeta (poblado con las
  carpetas presentes en la respuesta), rango de tamaño, rango de fecha.
- **Orden**: tamaño descendente por default; toggle a última actividad o cantidad de mensajes.
- **Selección**: checkbox por fila + "seleccionar todo lo visible" (ignora protegidas). Barra
  fija inferior: "N seleccionadas · X MB" + botón "Borrar".
- **Confirmación**: modal con el resumen antes de pegarle a `/api/cleanup/delete`.
- **Resultado**: toast con lo borrado/liberado y lo salteado de último momento; refresca la
  lista (`GET /api/cleanup/sessions` de nuevo).

## Manejo de errores

- Backend: errores de archivo por-item (permisos, lock) no abortan el lote, van a `skipped`.
- Race entre listar y borrar (la sesión pasó a `running` en el medio, o se archivó): la
  revalidación server-side en el delete la agarra igual.
- Frontend: fallo de red en el borrado en bloque → toast de error, la lista solo se actualiza
  con lo que el server confirmó (nunca se asume optimista qué se borró).

## Fuera de alcance (v1)

- Limpieza cross-cuenta / arreglo de permisos sobre `C:\Users\User\.claude\projects`.
- Papelera/soft-delete con expiración — el borrado es permanente e inmediato tras confirmar.
- Confirmación reforzada para sesiones con nombre puesto por Groq — la mayoría lo tiene, no es
  señal de importancia (ver protección arriba, que es por estado, no por nombre).

## Testing

- `test/cleanup.test.js` (nuevo): `listForCleanup` (incluye canal/vacías, tamaños correctos),
  clasificación (los 4 casos, orden de prioridad), protección (`pinned`, `archived`, `running`,
  frontera exacta de 5 días), endpoint de borrado (mock de `fs`+`meta`: borra lo esperado, saltea
  lo protegido, no aborta el lote ante un fallo individual, `freedBytes` correcto, dispara el
  resync del índice).
- Sin e2e Playwright obligatorio para esta v1 — se puede sumar un smoke test del pane después si
  hace falta.
