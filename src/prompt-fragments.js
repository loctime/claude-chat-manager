// Fragmentos de --append-system-prompt / cola de prompt compartidos entre
// runner.js (Claude) y codex-runner.js (Codex) — ver CLAUDE.local.md,
// "Modos de respuesta: probados y eliminados" para el porqué de que esto
// tenga que ser regla mecánica y no de estilo.
function infraNotice(host, port) {
  return `AVISO INFRAESTRUCTURA: te está ejecutando claude-chat-manager (Node/Express) en ${host}:${port}. Ese proceso es tu propio transporte hacia el usuario — si lo matás perdés el stream a la mitad y el usuario ve tu respuesta cortada. NO ejecutes comandos que apunten a ese puerto ni a ese proceso: nada de kill/pkill/fuser/lsof -ti:${port} -k, ss ... | xargs kill, systemctl stop, etc. Si el usuario te pide reiniciar el chat-manager, explicale que lo tiene que hacer él desde otra terminal (o via PM2/systemd) porque vos no podés matar tu propio host.`;
}

function pathContract() {
  return `CONTRATO DE RUTAS EN ESTE CHAT: cuando compartas un archivo o carpeta por su ruta, para que aparezca como tarjeta clickeable (descargar / abrir en la PC / bajar zip de una carpeta) escribí la ruta ABSOLUTA en texto plano dentro del mensaje — NUNCA entre backticks ni dentro de un bloque de código \`\`\`, ahí no se detecta. Ejemplos correctos: C:\\Users\\User\\Desktop\\informe.pdf (Windows) o /home/user/carpeta (Linux) — nunca una ruta relativa. Las carpetas con espacios en el nombre no se detectan solas (limitación conocida del detector) — si el nombre tiene espacios, decilo en prosa en vez de mandar la ruta pelada.`;
}

// Solo se agrega en turnos de Sala compartida (ver server.js, checkSalaMentions
// y POST /api/sala/rooms/:id/message) — explica el sistema una vez por turno,
// mismo criterio que infraNotice/pathContract: cada turno es un proceso nuevo
// del CLI, nada de esto "queda pegado" solo por haberlo mandado antes, así
// que se repite siempre en vez de mandarlo solo la primera vez.
function salaNotice(appName) {
  return `SALA COMPARTIDA: este turno es parte de un canal de coordinación compartido entre dos personas y sus dos agentes — vos sos ${appName}, corriendo en ESTA PC. Del otro lado hay OTRA persona con SU PROPIO agente de Claude Code corriendo en UNA PC DISTINTA, con su propio filesystem, sus propios proyectos y sus propias herramientas — no tenés ningún acceso a lo que hay ahí, ni ellos al de acá. Los bloques "[Fulano dijo:]" que ves más abajo son la ÚNICA fuente de verdad de lo que se habló en la sala — no hay memoria compartida entre turnos más allá de eso. Si el otro agente dice "ya lo hice" o similar, se refiere a SU PC, no a esta — no asumas que algo cambió acá salvo que vos mismo lo hayas hecho.`;
}

// Solo se agrega cuando el turno de Sala se disparó por la mención de OTRA
// persona (no el propio humano de esta instancia) — ver runner.js,
// job.restrictedTools, y server.js checkSalaMentions. La restricción real
// es --disallowedTools (un límite de la CLI, no una promesa del modelo);
// esto es solo para que Jarvis ENTIENDA por qué de golpe no tiene Bash/
// Edit/Write/NotebookEdit y pueda explicarlo en la sala en vez de quedar
// confundido si intenta usar una y le falla.
function restrictedToolsNotice() {
  return `HERRAMIENTAS LIMITADAS EN ESTE TURNO: te mencionaron en la sala pero tu propio humano no escribió nada ahora mismo — es una decisión de seguridad, no un error: no tenés Bash, Edit, Write ni NotebookEdit disponibles en este turno puntual, así que no podés ejecutar comandos ni modificar nada. Podés leer, investigar (Read/Grep/Glob) y contestar en la sala con lo que encuentres. Si te piden hacer algo que requiera ejecutar o escribir, explicá que hace falta que tu propio humano lo pida directamente desde su chat — recién ahí corre sin esta restricción.`;
}

module.exports = { infraNotice, pathContract, salaNotice, restrictedToolsNotice };
