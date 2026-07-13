# Claude Chat Manager — Diseño

**Fecha:** 2026-07-12
**Estado:** aprobado por Diego

## Qué es

Gestor web local de conversaciones de Claude Code, con interfaz tipo chat. Permite tener múltiples conversaciones separadas (agrupadas por proyecto), leerlas como un chat, y seguir chateando desde el browser sin tocar la terminal.

## Por qué

Diego está al límite de sesiones concurrentes del plan Max (los agentes del VPS consumen slots). Esta herramienta permite muchas conversaciones persistentes usando como máximo 2 slots concurrentes, saltando entre ellas desde una sola interfaz.

## Decisiones tomadas

| Decisión | Elección |
|---|---|
| Plataforma | Web local (Node.js + Express, frontend vanilla sin build step) |
| Concurrencia | Máximo 2 procesos `claude` a la vez; cola FIFO para el resto |
| Permisos | `--dangerously-skip-permissions` en todas las sesiones |
| Organización | Sidebar agrupada por proyecto |
| Nombres | Auto: primeras palabras del primer mensaje; editable inline (sidecar) |
| Vista del chat | Conversación + actividad de tools plegada (expandible al click) |
| Acceso | Bind a `127.0.0.1`; host/token configurables para red local a futuro |
| Streaming | SSE (Server-Sent Events) |
| Puerto | 3777 |

## Arquitectura

```
Browser (vanilla JS)
  │  GET /api/projects, /api/sessions/:id  (historial)
  │  POST /api/sessions/:id/message        (enviar)
  │  SSE /api/sessions/:id/stream          (respuesta en vivo)
  ▼
Server Node/Express
  ├── Scanner: lee ~/.claude/projects/*/[session].jsonl (solo lectura)
  ├── Sidecar: ~/.claude/session-manager/meta.json (nombres custom)
  └── Runner: spawn claude -p --resume ... --output-format stream-json
              semáforo de 2 + cola FIFO
```

**Principio clave:** el historial lo escribe Claude Code solo (en sus JSONL). El server nunca escribe historial — solo lo lee. Lo único que escribimos es `meta.json`.

## Componentes

### 1. Scanner de sesiones

- Lee `~/.claude/projects/*/` y arma el árbol proyecto → conversaciones.
- El nombre de carpeta hasheado se decodifica al path real del proyecto (el hash es el path con `/` → `-`).
- Parser de JSONL **tolerante a errores**: líneas corruptas se saltan, el resto se muestra.
- Por sesión extrae: snippet del primer mensaje de usuario, fecha de última actividad, cantidad de mensajes.

### 2. Metadata sidecar

- `~/.claude/session-manager/meta.json`: mapa `session-id → { name }`.
- Nombre por defecto = primeras palabras del primer mensaje. Si el usuario renombra, se guarda acá.
- Los JSONL de Claude no se tocan nunca.

### 3. Runner

- Al enviar un mensaje spawnea:
  ```bash
  claude -p "<mensaje>" --resume <session-id> \
    --output-format stream-json --dangerously-skip-permissions
  ```
  con `cwd` = carpeta del proyecto de esa conversación.
- Parsea el stream JSON del proceso y reenvía eventos por SSE al browser (texto incremental, tool calls, resultado final).
- **Semáforo de 2:** si ya hay 2 procesos corriendo, el mensaje entra en cola FIFO. La UI muestra "⏳ en cola".
- **Una respuesta a la vez por conversación:** el input de una conversación se deshabilita mientras su proceso corre. Las 2 concurrentes son entre conversaciones distintas.
- **Conversación nueva:** spawnea `claude -p` sin `--resume` con `cwd` = proyecto elegido; el primer evento del stream (init) trae el session-id nuevo, que se registra en el acto.

## UI

Layout de dos columnas:

**Sidebar izquierda:**
- Proyectos como grupos colapsables; adentro, conversaciones ordenadas por última actividad.
- Cada conversación: nombre, fecha, badge de estado (⚡ corriendo / ⏳ en cola / nada).
- Botón "+ nueva conversación": elegir proyecto existente o carpeta nueva.

**Panel principal (chat):**
- Mensajes del usuario a la derecha, Claude a la izquierda, markdown renderizado.
- Actividad de tools plegada entre medio: líneas grises tipo `▸ Bash: npm test` que expanden al click mostrando el output. Aparecen en vivo mientras corre.
- Renombrar: click en el nombre en el header → edición inline → guarda en `meta.json`.
- Input: textarea abajo; deshabilitado mientras esa conversación tiene proceso corriendo.

## Manejo de errores

- Proceso `claude` muere o sale con error → burbuja roja en el chat con el stderr; la conversación queda usable (se puede reintentar).
- Líneas JSONL corruptas → se saltan silenciosamente.
- Server reiniciado con procesos corriendo → los procesos huérfanos terminan solos y el JSONL queda íntegro (lo escribe Claude); al recargar se ve el historial completo, solo se pierde el streaming en vivo de esa respuesta.

## Testing

- Unit tests: parser de JSONL (líneas válidas, corruptas, vacías) y semáforo/cola (2 corriendo + encolar tercero, orden FIFO, liberación de slot).
- El resto: validación manual usando la herramienta.

## Fuera de alcance (por ahora)

- Acceso desde red local (queda preparado por config, no activado).
- Títulos generados por IA.
- Permisos granulares por conversación.
- Archivado/borrado de conversaciones.
