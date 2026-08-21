# Escáner de documentos (tipo CamScanner) — diseño y estado actual

**Fecha**: 2026-08-17 (última actualización: 2026-08-21 — script vendorizado + documento multi-página)
**Estado**: implementado y activo (no está gateado detrás de ningún flag)

## Contexto

Pestaña nueva en el sidebar (`Chats / Archivado / Notas / Mail / Escáner`, ver `header-scan-btn` en
`index.html`) para sacarle o subirle una foto a un documento (remito, factura, formulario en papel
carbónico, etc.) y recibir de vuelta una versión enderezada y limpia — mismo caso de uso que venía
resolviéndose a mano con `mejora-imagen/mejorar_imagen.py` (carpeta suelta fuera de este repo, ver
su `CLAUDE.md`), pero ahora integrado a la PWA en vez de tener que pasarle el archivo a Claude por
chat.

⚠️ **Corregido 2026-08-21:** hasta esa fecha `server.js` apuntaba al script con una ruta relativa
hacia esa carpeta hermana (`../../mejora-imagen/mejorar_imagen.py`), que **no está en git** — vivía
solo en la PC de Fernando. El feature funcionaba para él pero se habría roto en cualquier otro
checkout del repo (Diego incluido) apenas alguien tocara `/api/scan`. Fix: el script se copió
("vendorizó") adentro del repo en `scripts/mejora-imagen/` (ver su propio `README.md`), y
`SCAN_SCRIPT` en `server.js` ahora apunta ahí. La carpeta original sigue existiendo aparte para uso
suelto (remitos, facturas por chat) — son dos copias sin symlink, hay que replicar a mano si se
corrige un bug de detección en una y no en la otra.

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
   python(3) scripts/mejora-imagen/mejorar_imagen.py <original> <scanDir> --json
   ```
   El script vive adentro del repo (`scripts/mejora-imagen/`, vendorizado desde 2026-08-21 — ver
   más abajo), así que no depende de ninguna carpeta fuera de `claude-chat-manager/`.
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

## Documento de varias páginas + descartar (agregado 2026-08-21)

Pedido de Fernando: poder escanear varias hojas seguidas y juntarlas en un solo PDF, más un botón
para descartar una página puntual que salió mal sin perder las demás ya escaneadas.

**Estado del cliente (`public/doc-scanner.js`):** array en memoria `scanPages` — cada `processScan`
exitoso sigue mostrando el mismo panel de siempre (2 variantes + Guardar/Descargar), pero ahora con
dos botones más: **"🗑 Descartar"** (limpia el panel sin guardar nada, equivalente a lo que antes
hacía "Escanear otra") y **"+ Agregar a documento"** (empuja `{id, recortada, limpia}` a
`scanPages` y limpia el panel). Apenas `scanPages.length > 0` aparece una cola nueva debajo
(`#scan-queue` / `renderScanQueue()`): una tira de miniaturas (variante `recortada` de cada página)
con número de página y **su propio botón ✕** para sacar esa página puntual del array — literalmente
"los botones descartar" que pidió Fernando, uno por página en cola. Desde la cola: "+ Escanear otra
página" (dispara el mismo file input de siempre) y dos botones para terminar: **"✅ Terminar
(color)"** / **"✅ Terminar (blanco y negro)"** — la variante se elige una sola vez para todo el
documento, no por página, para no mezclar color y blanco y negro en un mismo PDF.

**Server — `POST /api/scan/pdf`:** recibe `{ pages: [{id, variant}] }` (variant: `recortada` |
`limpia`, máx. 50 páginas), resuelve cada página a su archivo real en `SCANS_DIR` (mismo lookup por
sufijo que ya usaba `/api/scan/:id/keep` — valida **todas** las páginas antes de tocar el PDF, para
no generar un documento a medio armar si una sola página tiene un id inválido) y arma un PDF con
**pdf-lib** (`PDFDocument.create()` + `embedJpg` + una página del tamaño exacto de cada imagen en
píxeles — evita deformar o dejar márgenes). El PDF resultante queda en
`~/.ccm-notes/scan-pdfs/<uuid>.pdf` (mismo patrón sin purga que `SCANS_DIR`) y la respuesta
(`{id, path, pageCount}`) alimenta un panel igual al de una página suelta: **"Guardar en Notas"**
(`POST /api/scan/pdf/:id/keep`, mismo patrón que el `keep` de una imagen pero con `mime:
application/pdf`) o **"Descargar"** directo.

Probado end-to-end (curl contra una instancia de prueba en otro puerto, con fotos reales de
escaneos previos): PDF de 2 y de 3 páginas, tamaños de página correctos, variante mezclada y
uniforme, y el caso de error (id inexistente → 404 claro, sin generar nada).

## Vendorizado del script (2026-08-21)

`scripts/mejora-imagen/` — copia de `mejorar_imagen.py` + `setup.sh` adentro de este repo (con su
propio `README.md`). Antes el server llamaba a una carpeta hermana fuera de git
(`../../mejora-imagen/`) que solo existía en la PC de Fernando — el feature entero se habría roto en
cualquier otro checkout (Diego incluido). La carpeta original sigue existiendo aparte, para uso
suelto fuera del escáner (remitos, facturas sueltas por chat) — son dos copias sin symlink ni
submódulo, hay que replicar a mano un fix de detección si aplica a ambas.

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

Python 3 + OpenCV (`cv2`) instalados en el PATH que use el server (`PYTHON_CMD` = `python` en
Windows, `python3` en Linux/macOS). Si el server corre en una máquina donde no se corrió
`scripts/mejora-imagen/setup.sh` todavía, `/api/scan` va a fallar con el stderr del `execFile`
visible en la respuesta de error (recortado a 300 caracteres) — no hay chequeo previo de que
OpenCV esté disponible antes de aceptar la foto. Con el script ahora adentro del repo (fix
2026-08-21), este es el único requisito real — ya no hace falta que exista ninguna carpeta hermana
fuera de `claude-chat-manager/`.
