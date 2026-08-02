# Pantalla de archivados por swipe (mobile)

**Fecha:** 2026-08-01
**Estado:** aprobado por Diego (diseño conversado en sesión)

## Objetivo

Reemplazar el toggle actual "Ver archivadas" (que hoy pisa la lista activa con un click) por una navegación por gestos en el celular, al estilo WhatsApp: swipe hacia la izquierda sobre la lista abre una segunda pantalla con las conversaciones archivadas, swipe hacia la derecha en esa pantalla vuelve a la lista activa, y swipe hacia la derecha sobre una fila individual la archiva al instante con opción de deshacer.

**Fuera de alcance (decidido explícitamente):**
- Soporte de estos gestos con mouse/drag en desktop — solo táctil. En desktop se mantiene el botón "Ver archivadas" como fallback.
- Cambios en `server.js` o `meta.js` — el campo `archived` y el endpoint `PATCH /api/conversations/:id` ya existen y se reusan tal cual.
- Reordenar o paginar la lista de archivados distinto a como ya pagina la lista activa (mismo `loadTree` con `archived=1`).

## Estado actual (diagnóstico)

- `archived` es un boolean en meta.json por conversación, ya soportado por `PATCH /conversations/:id` (`src/server.js` ~L680) y por `GET /tree?archived=1` (`src/server.js` ~L484-486).
- El toggle "Ver archivadas" (`public/app.js` ~L357-367) es un botón que cambia `showArchived` y recarga el árbol completo, reemplazando la lista en el mismo contenedor.
- El menú de long-press por fila (`public/app.js` ~L396-421 detección, ~L436-468 acciones) ya tiene la opción "Archivar/Desarchivar" contra el mismo PATCH.
- El contenedor de la lista (`#tree`) ya usa `touchstart`/`touchmove`/`touchend` para pull-to-refresh vertical (`initPTR`, ~L255-278) — un gesto horizontal nuevo no lo pisa porque mide ejes distintos.
- Cada fila `.conv` ya usa `touchstart`/`touchmove`/`touchend` para detectar long-press (~L396-419), cancelando el timer si el dedo se mueve más de 10px en cualquier eje — el swipe horizontal de fila tiene que integrarse ahí para no gatillar el menú contextual a mitad de un arrastre.

## Diseño

### Navegación entre pantallas (swipe izquierda/derecha a nivel lista)

- Dos vistas dentro del mismo contenedor `#tree`: "activas" y "archivadas", montadas una al lado de la otra (flex row, ancho 200%) y desplazadas con `transform: translateX()` según cuál esté visible.
- Gesto detectado sobre el fondo de la lista (no sobre una fila, ver más abajo): si el arrastre horizontal supera un umbral (~60px) y es predominantemente horizontal (eje X > eje Y), se anima la transición a la pantalla correspondiente; si no supera el umbral, vuelve a su posición (igual criterio que el indicator de pull-to-refresh).
- Izquierda desde "activas" → "archivadas". Derecha desde "archivadas" → "activas". No hay gesto para volver desde "activas" (ya está en su posición de reposo).
- Al entrar a "archivadas" por primera vez en la sesión, se dispara `loadTree` con `archived=1` si no está cacheada; el resto del tiempo reusa el DOM ya armado (no re-fetch en cada swipe).
- El pull-to-refresh vertical sigue funcionando igual en ambas pantallas, sin cambios.

### Swipe por fila para archivar

- Igual criterio de predominancia de eje que el gesto de pantalla: si el movimiento es horizontal, se le resta el touchmove al long-press (ya pasa hoy porque mueve más de 10px) y en cambio se traduce la fila con `transform: translateX()` siguiendo el dedo, solo hacia la derecha (clamp en 0 hacia la izquierda).
- Si al soltar el desplazamiento superó un umbral (~80px), la fila se anima fuera de la lista, se llama al mismo `PATCH /conversations/:id` con `{ archived: true }` que ya usa el menú, y se muestra un toast "Conversación archivada" con acción "Deshacer" (~4s, reusa el sistema de `toast()` existente).
- "Deshacer" hace el PATCH inverso (`archived: false`) y re-inserta la fila donde estaba (o al tope si ya se recargó el árbol).
- Si no supera el umbral, la fila vuelve a su posición con transición.
- Esta interacción convive con el long-press existente: swipe horizontal cancela el timer de long-press (ya lo hace), y el long-press solo dispara si no hubo movimiento horizontal significativo — no se toca esa lógica, solo se aprovecha.
- En la pantalla de "archivadas", el mismo swipe-derecha por fila desarchiva (mismo componente de fila, cambia solo qué PATCH dispara según de qué pantalla viene).

### Botón y menú existentes

- El botón "Ver archivadas" deja de mostrarse en viewport mobile (mismo criterio que ya usa el código para detectar mobile, `isMobile()`), pero se mantiene visible en desktop como único acceso a la pantalla de archivados ahí (sin swipe).
- La opción "Archivar/Desarchivar" del menú de long-press no cambia — queda como acceso alternativo en ambas pantallas y en ambas plataformas.

## Errores y edge cases

- **Swipe de fila iniciado pero la conversación se abre igual (tap corto):** se distingue por umbral de distancia, igual que hoy distingue tap de long-press.
- **Archivar la conversación actualmente abierta:** el chat abierto no se cierra solo; sigue mostrable hasta que el usuario navegue, igual que hoy con el botón del menú.
- **Deshacer después de que el árbol ya se recargó por otro evento (SSE, poll):** el PATCH de deshacer igual aplica sobre el `convId`; el re-render la vuelve a mostrar en la posición que le toque, no necesariamente donde estaba.
- **Swipe de pantalla iniciado sobre una fila:** si el movimiento arranca sobre `.conv`, gana la lógica de fila (archivar), no la de navegación entre pantallas — el swipe de pantalla solo aplica si arranca sobre el fondo del contenedor (fuera de cualquier `.conv`).

## Testing

- No aplica testing automatizado de gestos táctiles (no hay infraestructura de test de UI en el proyecto, los 47 tests actuales son de `server.js`/`meta.js`/`scanner.js`).
- Verificación manual en celular real (o devtools con emulación táctil) contra `http://127.0.0.1:3777`: swipe entre pantallas, swipe de fila con archivar/desarchivar/deshacer, y que el long-press siga andando sin falsos positivos.

## Compatibilidad

- Cambio 100% en `public/app.js` y `public/style.css`. No toca `server.js`, `meta.js`, `scanner.js` ni guards `IS_WIN`.
- Pushear a master y hacer `git pull` en la PC Linux alcanza, igual que el resto del frontend.
