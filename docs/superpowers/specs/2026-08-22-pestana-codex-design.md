# Pestaña Codex — chat interactivo con Codex CLI dentro de Jarvis

**Fecha**: 2026-08-22
**Estado**: aprobado, pendiente de implementación

## Contexto

Diego ya usa Codex CLI standalone en esta PC (`reference_codex_cli_setup.md`, logueado, con su propio `AGENTS.md`). Quiere poder chatear con Codex desde el celu/browser igual que ya hace con Claude en Jarvis — sesión interactiva ida y vuelta, no delegación en background tipo `/codex:rescue`.

Investigación técnica previa (verificada en esta PC, 2026-08-22): Codex CLI tiene un perfil muy similar al de Claude Code para este propósito.

- `codex exec [-C <cwd>] [--json] "<prompt>"` — modo headless, equivalente a `claude -p`. `--json` imprime eventos JSONL a stdout (streaming), igual que Claude.
- `codex exec resume <sessionId> [--json] "<prompt>"` (o `--last`) — equivalente a `--resume`.
- `--dangerously-bypass-approvals-and-sandbox` — equivalente a `--dangerously-skip-permissions`.
- Sesiones persistidas en `~/.codex/sessions/AAAA/MM/DD/rollout-<ts>-<uuid>.jsonl` (cadena de eventos `session_meta`/`response_item`/etc., formato distinto al de Claude pero misma idea), más un índice plano `~/.codex/session_index.jsonl` (`{id, thread_name, updated_at}` por línea) — más simple de listar que el árbol por carpeta de Claude.
- `codex` en PATH es un shim `.cmd` de npm (`AppData\Roaming\npm\codex.cmd`), no spawneable directo en Windows — mismo gotcha que tuvo `claude`. El paquete real es `@openai/codex`, entry point `bin/codex.js` (Node puro, sin `.exe` vendoreado) — se invoca `node <ruta>\bin\codex.js <args>`.
- Ya autenticado en esta PC (`~/.codex/auth.json` existe) — no hace falta manejar login.

## Decisión de arquitectura

**Patrón espejo, no unificación.** Se evaluaron dos caminos:

1. **Unificar**: generalizar `runner.js`/`scanner.js`/`server.js` actuales con un concepto de "provider", reusando las mismas rutas para Claude y Codex.
2. **Espejo** (elegido): módulos y rutas nuevas, paralelas a las de Claude, sin tocar el código existente.

Se descartó unificar porque `runner.js`/`scanner.js` acumulan semanas de bugs de concurrencia ya resueltos y documentados (`--resume`+cwd, SSE que se pierde al reconectar, rewind, compact) — no vale la pena arriesgar esa estabilidad para evitar algo de código duplicado. El frontend sí reusa componentes visuales (composer, render de mensajes, file-cards, chips de copiar), parametrizados por a qué base de API le pegan según la pestaña activa.

## Alcance v1

Incluido: lista de conversaciones Codex, abrir una, mandar mensaje, ver la respuesta en streaming, cancelar, resumir sesión al volver a entrar, pin/archivar (reusa el mismo patrón de swipe que ya tiene Chats), adjuntar imágenes (Codex soporta `-i/--image` nativo).

Explícitamente fuera de v1 (se suman después si hacen falta, mismo criterio que ya se aplicó con Notas — no replicar de entrada features que a Claude le llevaron semanas de iteración):
- Notas-para-Codex.
- Rewind / edición de historial.
- Compact manual.
- Adjuntar archivos no-imagen.
- Selección de modelo Codex desde la UI (usa el default de `~/.codex/config.toml`).

## Componentes backend

- **`codex-cmd.js`**: resuelve el path real del entry point (`bin/codex.js` bajo `AppData\Roaming\npm\node_modules\@openai\codex\`) y devuelve el comando armado como `node <ruta> <args>`. Override por env `CODEX_CMD`, mismo patrón que `CLAUDE_CMD` en `claude-cmd.js`.
- **`codex-runner.js`**: spawnea `codex exec --json [-C <cwd>] "<prompt>"` (conversación nueva) o `codex exec resume <id> --json [-C <cwd>] "<prompt>"` (continuar), con `--dangerously-bypass-approvals-and-sandbox`. Traduce los eventos JSONL de stdout al mismo canal SSE que ya expone `runner.js` para Claude (`status:'running'/'idle'` + contenido de mensaje). Cancelar: `taskkill /pid X /T /F`, igual que hoy. Estado busy/queue completamente independiente del de Claude — son árboles de procesos distintos, pueden correr a la vez sin pisarse. El `session_id` que devuelve el primer evento de una conversación nueva se guarda como id de esa conversación.
- **`codex-scanner.js`**: lee `~/.codex/session_index.jsonl` para la lista (ya viene plana, no requiere resolver cwd por carpeta como Claude), y el rollout `.jsonl` correspondiente bajo `~/.codex/sessions/AAAA/MM/DD/` para los mensajes de una conversación — traduce las entradas `response_item` (role/content) al mismo formato de mensaje que ya consume `app.js`.
- **`codex-meta.json`**: mismo store que `meta.json` (pinned/archived/unread), pero archivo separado, keyeado por sessionId de Codex.
- **Rutas nuevas en `server.js`**, todas bajo `/api/codex/...`, sin tocar las rutas existentes de Claude:
  - `GET /api/codex/tree`
  - `GET /api/codex/conversations/:id/messages`
  - `POST /api/codex/conversations/:id/message` (crea conversación si `:id` es nuevo)
  - `GET /api/codex/conversations/:id/stream` (SSE, mismo heartbeat de 20s que ya mitiga el corte de conexiones idle de Cloudflare Tunnel)
  - `POST /api/codex/conversations/:id/cancel`
  - `PATCH /api/codex/conversations/:id` (pin/archive/unread)

## Frontend

- El selector de nivel superior pasa de `Chats / Notas` a `Chats / Codex / Notas` — mismo mecanismo de tabs (desktop) + swipe (mobile) que ya existe para Notas, extendido a un panel más.
- Adentro de la pestaña "Codex" se reusa el mismo layout de árbol + botón "Ver archivadas" que tiene Chats hoy, apuntando a `/api/codex/...` en vez de `/api/conversations/...`.
- Composer, render de mensajes (burbujas, markdown, chips de copiar), file-cards y el contrato de rutas (paths detectables en texto plano) se reusan tal cual — no hay UI nueva que inventar, solo el endpoint destino cambia según la pestaña activa.

## Flujo

1. **Conversación nueva**: primer mensaje → `codex exec --json -C <cwd> "<prompt>"`. El `session_id` del evento inicial se guarda como id de la conversación en `codex-meta.json`.
2. **Reabrir/continuar**: `codex exec resume <id> --json -C <cwd> "<prompt>"`.
3. **Punto a confirmar durante la implementación** (no bloquea el diseño): si Codex exige el `-C <cwd>` correcto para poder resolver la sesión al resumir, igual que el gotcha de cwd que tuvo Claude Code (documentado en `CLAUDE.local.md`, "Bug 'No conversation found with session ID'") — verificar con una prueba real antes de asumir que alcanza con el id.

## Manejo de errores

- Mismo patrón ya probado para Claude: heartbeat SSE de 20s, estado inicial no-idle si hay una corrida en curso al reconectar el stream (mismo fix que ya se aplicó para el bug de la X que desaparecía).
- Si el binario no resuelve (`codex-cmd.js` no encuentra `bin/codex.js`) o Codex no está logueado: error visible en toast, no crashea el proceso de Jarvis.
- Línea corrupta en un rollout `.jsonl` al leer: se salta esa línea, no tira abajo el resto de la conversación (mismo criterio que ya usa Notas para su `.jsonl`).

## Testing

`node --test` sobre los módulos puros — `codex-scanner.js` parseando rollouts de ejemplo (fixtures, no sesiones reales) y `codex-runner.js` parseando eventos JSONL de muestra — sin pegarle al binario real. No hay test de integración de SSE/server, mismo criterio que ya se usa para el resto del repo.

## Explícitamente fuera de alcance (v1)

- Notas-para-Codex, rewind, compact manual (ver "Alcance v1" arriba).
- Adjuntar archivos no-imagen.
- Selección de modelo desde la UI.
- Unificar el código de Claude y Codex bajo una sola abstracción de "provider" (se evalúa más adelante si el patrón espejo demuestra tener demasiada duplicación real).
