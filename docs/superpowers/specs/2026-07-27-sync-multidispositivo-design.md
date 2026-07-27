# Sincronización multi-dispositivo (desktop + celular en simultáneo)

**Fecha:** 2026-07-27
**Estado:** aprobado por Diego (diseño conversado en sesión)

## Objetivo

Usar Jarvis desde el desktop y el celular al mismo tiempo sobre las mismas conversaciones, con handoff fluido: mandar un mensaje desde la PC, salir, y seguir la misma conversación desde el celu (y viceversa), viendo ambos dispositivos el mismo estado en vivo.

**Fuera de alcance (decidido explícitamente):**
- Sincronizar borradores sin enviar del composer (siguen siendo locales por dispositivo).
- Notificaciones push del celular (Web Push) — se evaluó y se pospuso.
- Replay de eventos SSE perdidos (Last-Event-ID / event log) — el refresh al reconectar ya cubre ese hueco.

## Problemas actuales (diagnóstico)

1. El mensaje del usuario enviado desde un dispositivo no se emite por SSE: el otro dispositivo ve "escribiendo…" y respuestas de Claude sin el mensaje que las causó, hasta que el turno termina y recarga todo.
2. Al abrir una conversación que el otro dispositivo puso a procesar, `selectConv` asume idle (`setBusy(false)` incondicional) → el input queda habilitado y enviar da 409.
3. Cambios de meta (nombre, modelo, responseMode, pin, archivado) solo llegan al otro dispositivo vía el poll del árbol cada 15s, y los selectores del header de una conversación abierta no se actualizan nunca.
4. Costo: cada dispositivo pollea `/api/tree` cada 15s, lo que re-parsea completo el JSONL de toda sesión activa (el cache de `sessionInfo` es por mtime y una sesión en curso cambia siempre) y re-renderiza el sidebar entero.

## Diseño

### Canal SSE global

- Nuevo endpoint `GET /api/stream` (global, sin convId). Reemplaza a `GET /api/conversations/:id/stream` y al `setInterval(safeLoadTree, 15000)`.
- Cada cliente abre **un** `EventSource` al iniciar la app, independiente de qué conversación esté abierta.
- Todos los payloads llevan `convId` para que el cliente rutee: si es la conversación abierta → render inline; si no → actualización de sidebar/estado.
- Tipos de evento (`kind`): `claude` (eventos del CLI), `status` (queued/running/idle), `user` (mensaje de usuario nuevo), `meta` (cambios de metadata), `compacted`, y `hello` (snapshot inicial).
- Se mantiene el heartbeat `:heartbeat` cada 20s (gotcha del túnel de Cloudflare que corta SSE con ~100s de idle).
- El endpoint viejo por conversación se elimina (no hay clientes externos que lo usen).

### Broadcast del mensaje de usuario + dedupe por clientId

- El cliente genera un `clientId` (UUID) al cargar la app y lo incluye en el body de `POST /api/conversations/:id/message` (y en el POST de crear conversación con texto inicial).
- El server, al encolar el mensaje, emite `{ kind: 'user', convId, text, clientId }` por el canal global.
- El dispositivo cuyo `clientId` coincide ignora el evento (ya renderizó su mensaje localmente); los demás lo appendean al chat si tienen esa conversación abierta.
- El texto emitido es el `text` crudo del usuario (con los `[Archivo adjunto: ...]` si los hay) — el render existente de adjuntos ya sabe dibujarlos.

### Estado ocupado consistente

- Al conectarse el SSE (incluye reconexiones), el server manda primero `{ kind: 'hello', busy: [convId, ...] }` con las conversaciones actualmente running o en cola (derivado del `Runner`).
- El cliente mantiene un `Map` convId → busy, alimentado por `hello` y por los eventos `status` siguientes.
- `selectConv` setea `setBusy()` desde ese Map en vez de asumir idle.
- El input deshabilitado mientras el otro dispositivo tiene un turno corriendo es el comportamiento deseado (la cola del runner es por conversación); no se encola desde el cliente.

### Meta sincronizada

- `PATCH /api/conversations/:id` emite `{ kind: 'meta', convId, ...camposCambiados }` (name, model, responseMode, pinned, archived).
- El otro dispositivo actualiza el sidebar y, si esa conversación está abierta, también título, selector de modelo y selector de modo de respuesta del header.
- El título autogenerado por Groq ya emitía `meta`; se unifica al mismo formato con `convId`.

### Actualización del árbol (reemplazo del poll)

- El sidebar se recarga (`loadTree`) cuando llega un evento que lo afecta: `status`, `meta`, `user`, `compacted`.
- Queda un poll de respaldo **lento (60s)** para detectar sesiones creadas por fuera de Jarvis (uso directo del CLI), que no generan eventos. Barato: con el cache por mtime, un tick sin cambios son solo `stat()`s.
- El render del sidebar sigue siendo rebuild completo (simple y suficiente a esta frecuencia menor).

### Reconexión

- `EventSource.onerror` del canal global: al reconectar, refrescar árbol + mensajes de la conversación abierta (mismo patrón que hoy). El evento `hello` de la reconexión re-sincroniza el estado busy.

## Errores y edge cases

- **409 al enviar:** sigue existiendo como guarda del server, pero el cliente ya no debería producirlo en uso normal. Si igual ocurre (carrera entre hello y un send), se muestra el error como hoy.
- **Evento `user` para una conversación no abierta:** solo dispara `loadTree` (badge de actividad); no se acumula nada.
- **SSE caído en uno de los dispositivos:** ese dispositivo queda como hoy (refresh al reconectar); el otro no se ve afectado.
- **Cuentas (Linux multi-account):** los eventos ya llevan `account` desde el runner; el canal global es único y el cliente filtra por su `activeAccount` igual que hoy filtra por conversación. En Windows es single-account y no cambia nada.

## Testing

- Tests nuevos (node --test, mismo estilo que los 47 existentes):
  - `POST /message` emite evento `user` con `clientId` por el canal global.
  - Conexión a `/api/stream` recibe `hello` con las conversaciones busy del runner.
  - `PATCH /conversations/:id` emite evento `meta` con los campos cambiados.
- Los 47 tests existentes deben seguir pasando (los que toquen el endpoint SSE viejo se migran al global).

## Compatibilidad

- Código común multiplataforma: no toca guards `IS_WIN` ni nada específico de Windows. Pushear a master y hacer pull en la PC Linux alcanza.
- Sin dependencias nuevas.
