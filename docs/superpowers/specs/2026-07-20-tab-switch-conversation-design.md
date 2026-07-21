# Atajo TAB para alternar entre las 2 primeras conversaciones

## Contexto

El sidebar de Jarvis lista las conversaciones ordenadas por último mensaje (más reciente primero), agrupadas por proyecto. Diego suele tener 1-2 conversaciones activas en paralelo y quiere poder saltar entre las dos más recientes sin usar el mouse/touch, con el cursor listo para escribir apenas cambia.

## Comportamiento

- Tecla `Tab` en la pantalla principal alterna entre la conversación en posición 1 y la posición 2 del sidebar (los dos primeros elementos `.conv` en el DOM, ya vienen ordenados por último mensaje).
- Toggle simple: si la conversación abierta es la #1, pasa a la #2. Si es la #2 (o cualquier otra conversación distinta a esas dos), pasa a la #1.
- Al cambiar, reutiliza `selectConv()` — guarda el borrador del mensaje actual, carga los mensajes de la conversación destino, reabre el stream SSE, y deja el foco + cursor en el input del mensaje (comportamiento que `selectConv()` ya tiene en desktop).

## Casos borde

- **Ningún diálogo abierto** es requisito: si hay un `<dialog open>` (Nueva conversación, Buscar, Configuración), el TAB no se intercepta — se comporta normal, navegando entre campos del formulario.
- **Sin conversación abierta todavía** (pantalla "Elegí una conversación"): no hace nada.
- **Menos de 2 conversaciones en el sidebar**: no hace nada, no hay a dónde alternar.

## Implementación

- `convElement(c)` en `public/app.js` guarda una referencia al objeto `c` en el propio nodo DOM (`div._conv = c`) para no tener que volver a pedirle datos al servidor al alternar.
- Un listener de `keydown` en `document` escucha `Tab`, valida los casos borde de arriba, y si corresponde hace `preventDefault()` + llama a `selectConv(...)` con los datos de la conversación destino.

## Alcance

Solo `public/app.js` (frontend puro, corre en el navegador). Aplica igual en el deploy de Windows y en el de Linux sin cambios adicionales — no toca `src/runner.js` ni `src/server.js`, que son los únicos con lógica específica de sistema operativo.

## Fuera de alcance

- No se agrega indicador visual de "conversación activa/procesando" nuevo — ya existe el badge ⚡/⏳.
- No se cambia el comportamiento de Shift+Tab (al ser un toggle de 2 elementos, ambas direcciones producen el mismo resultado, así que no necesita manejo especial).
- No aplica en mobile (no hay tecla Tab física en el uso típico táctil; `selectConv()` ya evita el autofocus en mobile para no disparar el teclado en pantalla).
