# Modos de respuesta por conversación

## Contexto

Jarvis (claude-chat-manager) invocaba `caveman`, un plugin global de Claude Code, para acortar las respuestas. El usuario lo sacó del sistema por completo (desinstalado, sin hooks ni residuos) porque quería control propio, no una herramienta de terceros con un único nivel de verbosidad fijo.

Reemplazo: un selector de "modo de respuesta" propio de Jarvis, por conversación, con tres niveles.

## Modos

1. **Detallado** — comportamiento normal de Claude, sin restricción agregada. No se inyecta ninguna instrucción extra de estilo.
2. **Directo** (default en conversaciones nuevas) — respuesta + por qué + recomendación. Sin fragmentos de código ni explicaciones largas, salvo que el usuario las pida explícitamente en el mensaje.
3. **Cavernícola** — máxima brevedad, al grano, redacción propia (no reutiliza texto del plugin caveman eliminado). El texto exacto de la instrucción se termina de redactar durante la implementación.

## UI

Nuevo `<select id="response-mode-select">` en el header del composer de `index.html`, al lado de `#model-select`, mismo patrón visual y de interacción (`style.css` reusa las reglas de `#model-select`).

Se guarda por conversación y es cambiable en cualquier momento — el cambio aplica al próximo mensaje enviado, no reescribe respuestas previas (mismo comportamiento que ya tiene el cambio de modelo).

## Persistencia y backend

Mirror exacto del flujo ya existente para `conv.model`:

- `meta.json` (vía `src/meta.js`) guarda `conv.responseMode` por conversación. Sin valor guardado → `'directo'`.
- El PATCH de conversación en `src/server.js` (el mismo que hoy acepta `model` en el body) se extiende para aceptar también `responseMode`.
- `runner.send(...)` (`src/server.js`) pasa `responseMode` igual que ya pasa `model`.
- `src/runner.js`, en `_start(job)`: el `--append-system-prompt` que ya arma (aviso de infraestructura del puerto) se extiende concatenando el bloque de instrucciones del modo elegido. Para `'detallado'` no se agrega nada — el string queda igual que hoy.

## Fuera de alcance

- No aplica a la consola de Claude Code fuera de Jarvis (solo a mensajes que pasan por `runner.js`).
- No hay modo "automático por contexto" — los tres modos son elección manual del usuario.
- No se migra el texto de las reglas del plugin caveman eliminado; "Cavernícola" es contenido nuevo, propio de Jarvis.
