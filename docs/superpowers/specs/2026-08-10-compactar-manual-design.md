# Compactar manual — Diseño

**Fecha:** 2026-08-10
**Estado:** aprobado por Diego

## Qué es

Pantalla para eliminar turnos arbitrarios (no solo la cola) de una sesión de Claude Code real, de a varios por vez. Segunda mitad de lo que quedó pendiente del diseño de "Rebobinar" (2026-08-09) — ese cubre "cortar todo lo que sigue a un punto"; esto cubre "sacar intercambios sueltos del medio, elegidos a mano".

## Por qué

Diego quiere poder limpiar tangentes o preguntas fuera de tema que metió en medio de una charla de trabajo, sin perder todo lo que vino después (a diferencia de rebobinar, que sí corta la cola entera). El caso de uso original: un plan largo donde en el medio se le ocurren un par de preguntas sueltas que no tienen que ver, y quiere que Claude las "olvide" de verdad sin rearmar la conversación desde cero.

## Contexto técnico (heredado de rewind, 2026-08-09)

Un `.jsonl` de sesión es una cadena estilo git: cada entrada `user`/`assistant` tiene `uuid` + `parentUuid`, y el CLI arma el contexto caminando esa cadena hacia atrás desde el último mensaje del archivo (verificado empíricamente con 4 experimentos en una sesión descartable — ver `CLAUDE.local.md`). Ya existe `scanner.rewindCutIndex`/`rewindSessionFile`, que cortan la **cola**: todo lo posterior a un turno elegido. Esta feature generaliza el mismo primitivo (probado en el laboratorio como "Test D": borrar un turno del medio + reconectar el `parentUuid` del hijo al abuelo) a **múltiples turnos, no necesariamente contiguos, en cualquier posición**.

## Decisiones tomadas

| Decisión | Elección |
|---|---|
| Cómo se arman los "bloques" | **Mecánico, sin IA** (opción B de las dos evaluadas): 1 bloque = 1 turno real (tu pregunta + todo lo que generó). Sin resumen por IA — se descartó por costo/latencia de un llamado a Claude cada vez que se abre la pantalla. Si en el uso real la lista turno-por-turno se siente insuficiente en charlas largas, agrupar temas con IA queda como mejora futura. |
| Punto de entrada | Menú contextual de la conversación (el mismo donde ya está "🗜️ Compactar"), opción nueva "🧹 Compactar manual" |
| Layout | Pantalla completa, mismo patrón swipe/volver que la pantalla de "Archivadas" (2026-08-01) |
| Contenido de cada fila | Primera línea de la pregunta (truncada ~60-80 caracteres) + ícono 🔧 si el turno usó herramientas + hora. Sin fragmento de la respuesta de Claude (mantiene la lista rápida de escanear) |
| Selección | Checkboxes multi-select + barra inferior fija con contador y botón "Eliminar seleccionados (N)" |
| Deshacer | Sí — toast "N turnos eliminados — Deshacer" que restaura el backup automático al tocarlo (mismo patrón que ya existe para archivar conversaciones) |

## Backend

### `scanner.pruneTurns(entries, uuids)`

Generaliza `rewindCutIndex`:

1. Segmenta el archivo completo en turnos reales, con el mismo criterio que ya usa `toChatMessages` para decidir qué es una pregunta tuya de verdad (descarta los `user` sintéticos que arma el CLI para devolver resultados de herramientas — esos no son turnos independientes, son parte del turno que los generó).
2. Cada turno = su plomería previa (mismo `TURN_PRELUDE_TYPES` que ya usa el rewind: `queue-operation`/`attachment`/`mode`/`permission-mode`/`file-history-snapshot`) + todo lo que generó, hasta el arranque del turno siguiente (o EOF).
3. Las entradas `type: "system"` (p.ej. un `compact_boundary`) **siempre sobreviven**, sin importar en qué rango estructural cayeron — para no perder silenciosamente ese historial si el turno vecino se borra.
4. Valida: todos los `uuid` pedidos existen como turnos reales, y no se está pidiendo vaciar la sesión entera (debe sobrevivir al menos un turno).
5. Arma la lista final concatenando los turnos sobrevivientes en orden; el primer entry real (`user`/`assistant`) de cada turno sobreviviente que quedó justo después de uno eliminado se re-parenta (`parentUuid`) al último entry real del turno sobreviviente inmediato anterior — o a `null` si pasa a ser el primer turno del archivo. Es el mismo rebase validado a mano en el laboratorio (Test D), aplicado turno por turno.

### `scanner.pruneSessionFile(filePath, uuids)`

Mismo patrón que `rewindSessionFile`: backup (`<archivo>.bak-prune-<timestamp>`) antes de escribir, invalida `_tailCache`/`_sessionInfoCache`. Devuelve `{ removed, backup }` o `null` si la validación falla.

### Endpoints

- `POST /api/conversations/:id/prune { uuids: [...] }` — mismos guards que `/rewind` (busy/compacting/sesión inexistente/archivo no encontrado). Responde sincrónico (operación local rápida, no necesita el baile 202+SSE del compact).
- `POST /api/conversations/:id/restore-backup { backup }` — restaura un backup puntual sobre el archivo activo. Valida que el `backup` pedido efectivamente pertenezca a la sesión actual de esa conversación (mismo directorio, mismo `sessionId` en el nombre) antes de tocar nada, para no abrir una vía de sobrescribir un archivo arbitrario.

## Frontend

- Menú contextual de conversación: nuevo botón "🧹 Compactar manual" al lado de "🗜️ Compactar".
- Pantalla nueva (mismo mecanismo de panes que `#tree-viewport`/archivadas): lista los turnos de la conversación actual vía los mismos `uuid` que ya expone `toChatMessages` para mensajes `user`.
- **Solo la sesión activa** (`conv.currentSessionId`): si la conversación viene de una compactación vieja (`conv.compactedFromSession`), esos mensajes históricos no aparecen en la lista — igual que el rewind, esta feature opera nada más sobre el archivo de sesión que el CLI puede seguir resumiendo hoy.
- Cada fila: checkbox + texto truncado + 🔧 condicional + hora.
- Barra inferior: contador + "Eliminar seleccionados (N)" — deshabilitado en 0 seleccionados, y también si la selección cubre *todos* los turnos (no se llega a mandar la request que el server rechazaría igual, pero se evita el viaje y el error confuso).
- Confirmación nativa (mismo estilo que rewind) antes de ejecutar.
- Al completar: toast con conteo + acción "Deshacer" (llama a `/restore-backup`), vuelve a la vista de chat normal, recarga mensajes y refresca el badge de costo/contexto.

## Testing

En `test/scanner.test.js`:
- Borrar un turno del medio → relink correcto del turno siguiente.
- Borrar el turno inicial → el turno que queda primero pasa a `parentUuid: null`.
- Borrar varios turnos no contiguos en una sola operación.
- Plomería y entradas `system` intercaladas se preservan según la regla de arriba (no se pierden silenciosamente).
- Rechazo si algún `uuid` pedido no existe.
- Rechazo si la selección vaciaría la sesión entera.
- El backup generado contiene el archivo original completo, sin tocar.

## Fuera de alcance (por ahora)

- Agrupar temas relacionados en un solo bloque vía resumen por IA (opción A descartada en el brainstorming; queda como mejora futura si la lista turno-por-turno resulta insuficiente).
- Deshacer más allá del toast inicial (una vez que expira o se navega a otro lado, el backup sigue en disco pero ya no hay un botón de un toque — habría que restaurarlo a mano).
