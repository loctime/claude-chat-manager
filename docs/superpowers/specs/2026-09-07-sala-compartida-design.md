# Sala compartida Jarvis ↔ FerStark — Design

## Contexto

Diego (Jarvis) y Fernando (FerStark) comparten casi todos sus proyectos y hoy coordinan por fuera de Jarvis. La idea: una pestaña nueva en claude-chat-manager, "Sala", donde cualquiera de los dos escribe un mensaje, su propio agente responde, y el otro humano + su agente lo leen y siguen la conversación cuando vuelven. Es asincrónico — no un chat en vivo con los cuatro participantes escribiendo a la vez.

Cada uno tiene su propio Jarvis (instancia de claude-chat-manager) corriendo en su propia PC, con su propio plan Claude Max y sus propias sesiones de Claude Code locales. Esto NO cambia: el agente que responde siempre corre en la máquina de su dueño, con su acceso local de siempre (archivos, comandos, Playwright, etc.). Lo único que se centraliza es el *buzón* de la sala — dónde quedan guardados los mensajes para que sobrevivan aunque una de las dos PCs esté apagada.

## Decisiones tomadas en brainstorming

- **Opción de infraestructura**: cada agente sigue siendo 100% personal y local (plan Max propio, PC propia, acceso a archivos propio). Se descartó centralizar Jarvis entero en el VPS — eso es un cambio de producto aparte, no esta feature.
- **Quién responde a un mensaje**: solo el agente del que escribió. Vos hablás → responde Jarvis. Fernando habla → responde FerStark. Cada agente lee todo el hilo (los cuatro participantes) como contexto antes de responder, pero no se dispara solo porque el otro humano escribió. Extensión futura, no ahora: mencionar `@FerStark`/`@Jarvis` para pedirle opinión puntual al otro agente sin que sea su humano quien escribió.
- **Qué se publica del trabajo de un agente**: solo el texto final de la respuesta. El rastro de herramientas (archivos leídos, comandos corridos, ediciones) queda local en la máquina de cada uno, igual que en un chat normal — si es relevante para el otro, el agente lo cuenta en el texto.
- **Alcance de "Codex Shared"**: no reutilizable. Es un mecanismo distinto (conversaciones de Codex CLI sincronizadas entre dispositivos de la *misma* cuenta), no aplica a multi-usuario.
- **Fuera de alcance**: la feature de agenda/turnos de facturación que Fernando está armando es un sistema aparte, no vive en esta pestaña.

## Arquitectura

### 1. Servicio "sala" en el VPS (Contabo)

Nuevo proyecto chico, `/opt/sala-jarvis`, PM2 app `sala-jarvis`, puerto interno libre (convención 3xxx), subdominio `sala.controlapps.ar` vía Caddy — mismo patrón de deploy que el resto del VPS (ver `project_vps_ecosystem.md`).

Storage: un `.jsonl` append-only por sala, mismo patrón que `src/notes.js` de este repo. Sin base de datos nueva.

Endpoints:
- `GET /rooms` — lista de salas (id, nombre, creada).
- `POST /rooms` — crea una sala (body: nombre).
- `GET /rooms/:id/messages?since=<cursor>` — mensajes nuevos desde un cursor (timestamp o índice de línea).
- `POST /rooms/:id/messages` — publica un mensaje (body: autor, texto).

Auth: token fijo por instancia en header (`Authorization: Bearer <token>`), uno para Jarvis y uno para FerStark, configurados a mano en el server del VPS. Sin usuarios/roles — con dos instancias de confianza alcanza.

### 2. Integración en Jarvis (mismo código para las dos instancias)

Pestaña nueva "Sala", al lado de "📝 Notas" en `#pane-tabs` (mismo patrón de panes que ya existe: `tree-pane` + `goToPane`).

Cada sala es una conversación con su propia sesión de Claude local — reusa `runner.send()` tal cual, sin tocar `runner.js`. Flujo al mandar un mensaje:

1. El cliente pide al servicio del VPS los mensajes nuevos desde el último cursor guardado para esa sala (guardado en `meta.json`, mismo archivo que ya trackea `currentSessionId` por conversación).
2. Se arma un bloque de contexto mecánico, mismo patrón entre corchetes que `pendingRewindNotice`/citas (`app.js` `quoteIntoComposer`, `server.js` `pendingRewindNotice`): `[Fernando dijo:] ...` / `[FerStark dijo:] ...` por cada mensaje nuevo, antepuesto al mensaje del usuario.
3. Se manda a `runner.send()` como cualquier mensaje normal — mismo runner, mismo `--append-system-prompt` de infraestructura, mismo acceso local.
4. Al terminar (`status: idle`, code 0), el texto final de la respuesta se publica al servicio del VPS como autor "Jarvis"/"FerStark" (según instancia — ya existe `getAppName()` en `server.js` para esto) y se guarda local igual que cualquier chat.

Un polling de 15s (mismo intervalo que ya usa `/tree`) refresca la sala mientras está abierta, para mostrar lo que fue llegando de los otros tres participantes sin que haga falta escribir para verlo.

### 3. Crear una sala

Botón "+ Nueva sala" en la pestaña. Se crea en el VPS con un id; ambas instancias ven todas las salas existentes (no hay unirse/invitar — con dos instancias de confianza, todo es compartido). Si en el futuro se suma un tercer participante, ahí se evalúan permisos por sala; fuera de alcance ahora.

### 4. Manejo de errores — VPS caído

La pestaña muestra el último estado cacheado localmente más un aviso ("sin conexión con la sala"). Mandar un mensaje queda deshabilitado con el motivo a la vista mientras el servicio no responde — no se manda nada sin el contexto de lo que dijeron los demás.

### 5. Testing

- Servicio del VPS: `node --test`, funciones puras + fixtures (mismo patrón que `notes.js`/`meta.js` de este repo), sin servidor HTTP real levantado en el test.
- Jarvis: el armado del bloque de contexto (`[Fernando dijo:] ...`) como función pura testeada con `node --test`. Polling y UI verificados en vivo con Playwright contra el server real, mismo criterio que el resto de features de este proyecto (no hay harness de servidor+SSE en los tests automáticos).

## Fuera de alcance (v1)

- Menciones `@FerStark`/`@Jarvis` para invocar al otro agente puntualmente.
- Adjuntos/archivos en la sala.
- Más de dos instancias / permisos por sala.
- Rastro de herramientas visible para el otro humano.
- Mudar Jarvis completo al VPS (proyecto aparte, no evaluado acá).
