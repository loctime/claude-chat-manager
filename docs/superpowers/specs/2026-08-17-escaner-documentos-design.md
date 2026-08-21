# Escáner de documentos (tipo CamScanner) — diseño y estado actual

**Fecha**: 2026-08-17
**Estado**: implementado y activo (no está gateado detrás de ningún flag)

## Contexto

Pestaña nueva en el sidebar (`Chats / Archivado / Notas / Mail / Escáner`, ver `header-scan-btn` en
`index.html`) para sacarle o subirle una foto a un documento (remito, factura, formulario en papel
carbónico, etc.) y recibir de vuelta una versión enderezada y limpia — mismo caso de uso que venía
resolviéndose a mano con `mejora-imagen/mejorar_imagen.py` (ver su `CLAUDE.md`), pero ahora
integrado a la PWA en vez de tener que pasarle el archivo a Claude por chat.

**Todo el procesamiento corre local con OpenCV, vía ese mismo script Python. No pasa por Claude,
no gasta tokens.**

## Flujo

1. El usuario toca "📷 Escanear documento" (`scan-start-btn`) → dispara un `<input type=file
   accept=image/* capture=environment>` (`scan-file-input`), que en mobile abre la cámara directo
   (atributo `capture`) y en desktop el picker de archivos normal.
2. El cliente pasa el archivo por `prepareForUpload()` — el mismo helper que ya usaba el composer
   de chat y el de Notas para materializar el handle del picker de galería a un `Blob` real y
   comprimir fotos grandes antes de subir (ver comentarios en `app.js` sobre por qué hace falta:
   un `File` de `content://`/fototeca puede invalidarse a mitad de un upload lento).
3. `POST /api/scan` (multipart, campo `photo`) — el server guarda el original en
   `~/.ccm-notes/scans/<uuid>/original.<ext>` (multer con `diskStorage`, el `uuid` se genera en el
   momento y queda colgado del `req` para el resto del handler) y corre:
   ```
   python(3) mejora-imagen/mejorar_imagen.py <original> <scanDir> --json
   ```
   La ruta al script se arma con `CCM_DEFAULT_PROJECT_DIR` (o `../..` desde `src/` si no está
   seteada) + `mejora-imagen/mejorar_imagen.py` — asume que esa carpeta vive al lado de
   `claude-chat-manager/` en el vault, igual que hoy.
4. El script devuelve JSON (`--json`) con `detectado` (bool) y las rutas de las 3 variantes que ya
   generaba para el caso de remitos: recortada (color, enderezada), `1x` (blanco y negro limpia) y
   `2x` (blanco y negro ampliada, pensada para OCR — hoy no se usa en la UI pero el server la deja
   pasar por si hace falta después).
5. El cliente muestra 2 de las 3 variantes (color enderezada + blanco y negro) lado a lado, con
   badge de si se detectó el borde del documento o si se usó la foto completa (fallback cuando el
   algoritmo no encuentra un contorno razonable — ver los hallazgos de detección en el `CLAUDE.md`
   de `mejora-imagen/`), y por variante: **"Guardar en Notas"** o **"Descargar"** directo.

## Guardado ("Guardar en Notas")

`POST /api/scan/:id/keep` con `{ variant }` (`recortada` | `limpia` | `limpia2x`):

- Busca el archivo procesado dentro de `~/.ccm-notes/scans/<id>/` por sufijo
  (`_recortada.jpg` / `_limpia.jpg` / `_limpia_2x.jpg`). El `id` de la URL es el mismo `uuid` que
  generó el server en el paso 3 — nunca un path controlado por el cliente, así que no hay riesgo de
  path traversal aunque alguien mande cualquier cosa ahí (el `readdirSync` sobre un id que no
  matchea ninguna carpeta real simplemente da 404).
- Copia el archivo a `notes.FILES_DIR` (mismo storage que usan los adjuntos de Notas) con nombre
  `escaneo-<id corto>.jpg`, resolviendo colisiones con `notes.resolveDestName`.
- Crea (o reutiliza) una libreta fija llamada **"Escaneos"** (`findOrCreateScanNotebook`) y le
  agrega el archivo como entrada tipo `file` — reusa 100% el modelo de datos de Notas/Libretas
  (`2026-08-13-notas-libretas`, feature de Diego), no hay estructura nueva.
- Dispara `syncSearchIndex` para que el archivo aparezca en el buscador global (Ctrl+K) igual que
  cualquier otra nota.

Los originales y variantes intermedias quedan en `~/.ccm-notes/scans/<id>/` sin limpiarse — no hay
todavía un job de purga para escaneos viejos que el usuario decidió no guardar (queda como pendiente
si el directorio crece mucho con el tiempo).

## Acceso directo desde el header (mobile)

`50bc83d` agregó `header-scan-btn` — accesible con un toque desde cualquier pantalla en mobile, sin
tener que abrir el sidebar primero y buscar la pestaña. Mismo patrón que el resto de los botones
del header.

## Por qué no toca Claude para nada

A diferencia del panel de Mail (que si depende de un job de Claude Code porque las credenciales de
Gmail/Outlook solo existen dentro de una sesión autenticada), acá el server tiene todo lo que
necesita de forma directa: un binario de Python con OpenCV instalado localmente. No hay
credenciales de terceros de por medio, así que no hay razón para pasar por un LLM — es
determinístico y gratis en tokens, corre en <1s en el caso normal (hasta ~7s más si el fallback de
GrabCut se dispara, ver `CLAUDE.md` de `mejora-imagen/`).

## Requisito de entorno

Igual que `mejora-imagen/` standalone: Python 3 + OpenCV (`cv2`) instalados en el PATH que use el
server (`PYTHON_CMD` = `python` en Windows, `python3` en Linux/macOS). Si el server corre en una
máquina donde no se corrió `mejora-imagen/setup.sh` todavía, `/api/scan` va a fallar con el stderr
del `execFile` visible en la respuesta de error (recortado a 300 caracteres) — no hay chequeo
previo de que OpenCV esté disponible antes de aceptar la foto.
