# Notas — anotador sin IA dentro de Jarvis

**Fecha**: 2026-08-11
**Estado**: aprobado, pendiente de implementación

## Contexto

Existía un proyecto separado, `control-Chat` ("SELF CHAT", `chat.controldoc.app`), una PWA standalone con Firebase (Auth+Firestore+Storage) para mandarse mensajes/archivos a uno mismo, sincronizada entre dispositivos. Se decidió **no migrar nada de ese proyecto** — no tiene datos ni código útil para traer — y construir la misma idea de cero, pero integrada dentro de Jarvis (`claude-chat-manager`) en vez de mantener una app + dominio + Firebase aparte.

Casos de uso que debe cubrir:
1. Anotador personal (notas de texto rápidas), accesible desde cualquier dispositivo donde abras Jarvis.
2. Enviar archivos del celular a la PC (u otro dispositivo) cuando están en redes distintas — el archivo tiene que aparecer en una carpeta real del disco, no solo "visible en el navegador".
3. Copiar contenido de texto fácil para pegarlo en la PC.

Fuera de alcance para v1 (anotado para más adelante, no se diseña acá): mapas mentales.

## Decisión de arquitectura

Jarvis ya resuelve "acceso multi-dispositivo" (mismo server, misma URL, cualquier navegador) y ya tiene los componentes visuales de chat (burbujas, composer, adjuntar archivo, botón "copiar" en bloques de código). Lo único que falta es un tipo de hilo que **no** dependa de la infraestructura de sesiones de Claude Code (scanner, `cwd`/`resume`, runner) — esa lógica es específica de sesiones reales del CLI y bastante delicada (ver gotchas documentados en `CLAUDE.local.md` del proyecto).

Se descartó meter "Notas" como un tipo más de conversación existente (Opción A) por el riesgo de tocar esa lógica. Se eligió un **módulo separado y liviano** dentro del mismo server/UI (Opción B), sin runner, sin scanner, con su propio storage.

## Navegación

Se generaliza el mecanismo de paneles que ya existe para Chats/Archivadas (`#tree-viewport`, hoy pensado como toggle de 2 estados vía la clase `.showing-archived`) a **3 paneles en fila**: `Chats — Archivado — Notas`. Este cambio de paso resuelve que hoy "Archivado" no tenga acceso visible en desktop.

- **Desktop**: pestañas fijas debajo del header (`Chats` / `Archivado` / `Notas`). Reemplazan el botón actual "Ver archivadas". Clic cambia de panel.
- **Mobile**: sin pestañas (no hay lugar en el header). Se mantiene el swipe horizontal ya implementado, ahora recorriendo las 3 en orden: desde Chats, un swipe → Archivado, dos swipes → Notas.

Implica generalizar `goToArchived()`/`goToActive()` y la clase `.showing-archived` a un índice de panel activo (0/1/2) en vez de un booleano.

## Almacenamiento

- **Mensajes de texto**: `~/.ccm-notes/notes.jsonl`, append-only. Cada línea:
  ```json
  {"id": "...", "ts": 172..., "type": "text" | "file", "text": "...", "fileName": "...", "filePath": "...", "mime": "..."}
  ```
  Sin ninguna relación con el scanner de sesiones de Claude Code.
- **Archivos adjuntos**: carpeta **visible** en el Escritorio, `C:\Users\User\Desktop\Notas Jarvis\` (a diferencia de `~/.ccm-uploads`, que es oculta y hoy se usa para adjuntos de chat con IA). Se crea sola si no existe, mismo patrón que `UPLOAD_DIR` actual. Nombre de archivo repetido → se antepone timestamp para no pisar el anterior.

## Interfaz

Reusa componentes visuales existentes:

- **Lista de mensajes**: burbujas todas del mismo estilo (no hay "otro lado", no hay IA). Orden cronológico.
  - Texto: contenido + botón "Copiar" (mismo patrón que los chips de copiar en bloques de código markdown).
  - Archivo: nombre + tamaño + ícono según tipo + ruta guardada (ej. `Notas Jarvis\archivo.pdf`) + botón "Copiar ruta". Si es imagen, thumbnail.
- **Composer**: input de texto + botón enviar + botón adjuntar (mismo flujo de subida que ya existe, pero escribiendo en la carpeta visible en vez de `.ccm-uploads`).

v1 no incluye acciones adicionales sobre archivos (ej. "abrir carpeta" disparado desde el server) — nombre + ruta + copiar alcanza.

## Endpoints

- `GET /api/notes` — devuelve todos los mensajes del `.jsonl`.
- `POST /api/notes` — agrega un mensaje de texto.
- `POST /api/notes/upload` — sube un archivo (multer) directo a `Desktop\Notas Jarvis\`, agrega la entrada `type:"file"` al `.jsonl`.

Todos detrás del mismo `ACCESS_PIN` que ya protege el resto de la app — no se agrega autenticación nueva.

## Sincronización entre dispositivos

Sin SSE ni websockets nuevos, para no repetir el problema de conexiones idle ya documentado con el túnel de Cloudflare en `/stream`. En cambio:

- Al abrir la pantalla de Notas: `GET /api/notes` y pinta todo.
- Mientras está abierta: **polling cada 5s** (se prioriza la inmediatez porque uno de los usos centrales es "mandar un archivo del celu y pasar a la PC a buscarlo enseguida"), más un refresh al volver el foco/visibility a la pestaña.
- Enviar (texto o archivo) actualiza al toque en el dispositivo que envía, sin esperar el poll.

## Manejo de errores

- Falla un upload (disco lleno, permiso denegado): toast de error, no se agrega la entrada al `.jsonl`.
- Carpeta `Notas Jarvis` no existe: se crea sola al primer archivo.
- Línea corrupta en el `.jsonl` al leer: se salta esa línea, no tira abajo el resto de la lista.

## Testing

`node --test` para el módulo de notas: append/lectura del `.jsonl`, y que un nombre de archivo repetido no pise al archivo anterior en `Notas Jarvis\`.

## Explícitamente fuera de alcance (v1)

- Migrar nada de `control-Chat` (se descarta el proyecto entero, no aporta nada reusable).
- Múltiples libretas/hilos — una sola libreta de Notas alcanza.
- Mapas mentales (idea para más adelante, sin diseñar todavía).
- Acciones remotas sobre archivos desde el server (abrir carpeta, etc.).
- Auth/permisos distintos al `ACCESS_PIN` ya existente.
