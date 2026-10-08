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

function resolveMemoryFiles(cwd) {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  const home = os.homedir();
  const projectsDir = path.join(home, '.claude', 'projects');

  let primaryMemory = null;
  try {
    if (fs.existsSync(projectsDir)) {
      const entries = fs.readdirSync(projectsDir);
      let bestScore = -1;
      for (const entry of entries) {
        const mem = path.join(projectsDir, entry, 'memory', 'MEMORY.md');
        try {
          if (fs.existsSync(mem)) {
            const stat = fs.statSync(mem);
            const cwdSlug = cwd ? cwd.replace(/[\/\\:]/g, '-') : '';
            const isMatch = cwdSlug && entry.includes(cwdSlug);
            const score = stat.size + (isMatch ? 1000000 : 0);
            if (score > bestScore) {
              bestScore = score;
              primaryMemory = mem;
            }
          }
        } catch {}
      }
    }
  } catch {}

  const claudeCandidates = [
    cwd ? path.join(cwd, 'CLAUDE.md') : null,
    path.join(home, '.claude', 'CLAUDE.md'),
    path.join(home, 'CLAUDE.md'),
  ].filter(Boolean);

  let primaryClaude = null;
  for (const c of claudeCandidates) {
    if (fs.existsSync(c)) {
      primaryClaude = c;
      break;
    }
  }

  if (!primaryClaude) {
    primaryClaude = path.join(home, '.claude', 'CLAUDE.md');
  }
  if (!primaryMemory) {
    const slug = path.basename(home) ? `projects-${path.basename(home)}` : 'default';
    primaryMemory = path.join(projectsDir, slug, 'memory', 'MEMORY.md');
  }

  return { claudeMd: primaryClaude, memoryMd: primaryMemory };
}

function memoryProtocol({ appName, userName, cwd } = {}) {
  const os = require('os');
  const config = require('./config');

  const cfg = config.load();
  const resolvedApp = (appName || cfg.appName || process.env.CCM_APP_NAME || 'Jarvis').trim();
  let resolvedUser = (userName || cfg.userName || process.env.CCM_USER_NAME || '').trim();

  if (!resolvedUser || resolvedUser === 'Vos') {
    let systemUser = '';
    try { systemUser = os.userInfo().username.toLowerCase(); } catch {}
    if (resolvedApp.toLowerCase().includes('ferstark') || systemUser === 'fernando') {
      resolvedUser = 'Fernando';
    } else {
      resolvedUser = 'Diego Bertosi';
    }
  }

  const marker = resolvedApp ? `CONTEXTO ${resolvedApp.toUpperCase()} COMPARTIDO:` : 'CONTEXTO COMPARTIDO:';
  const { claudeMd, memoryMd } = resolveMemoryFiles(cwd);

  return `${marker} sos un asistente que trabaja en la PC de ${resolvedUser} junto a Claude Code. Leé siempre de entrada ${claudeMd}, ${memoryMd} y todos los archivos de reglas y feedbacks de esa carpeta de memoria. Es fundamental entender todas las reglas de entrada antes de actuar, priorizando el contexto completo por sobre la velocidad inicial de respuesta. Esa memoria es fuente de verdad: no la reescribas ni la dupliques. Si trabajás dentro de un proyecto, leé también su CLAUDE.local.md. Usá español argentino sin signos de apertura y fechas DD/MM/AAAA.`;
}

function backgroundJobsNotice(scriptPath) {
  return `TRABAJOS DE FONDO: esta app ejecuta cada turno de chat como un proceso temporal. Por eso NO uses Agent/subagentes nativos para delegar trabajo en background: se pausan al terminar tu turno. Si necesitás delegar una tarea larga y autónoma, escribí la instrucción completa en un archivo temporal y ejecutá: node "${scriptPath}" create --title "título corto" --cwd "carpeta absoluta" --prompt-file "ruta del archivo" [--project "nombre"]. Eso crea un worker durable, visible como una conversación ⚙️ en Chats. Avisale al usuario que quedó encolado; no afirmes resultados hasta que ese worker termine.`;
}

module.exports = { infraNotice, pathContract, salaNotice, restrictedToolsNotice, memoryProtocol, resolveMemoryFiles, backgroundJobsNotice };
