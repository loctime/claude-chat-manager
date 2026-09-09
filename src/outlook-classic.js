// Puente con Outlook clásico (Windows) vía COM/MAPI, por PowerShell — sin
// Graph, sin Azure, sin contraseña. Requiere que Outlook clásico (NO "Nuevo
// Outlook") esté abierto y logueado con la cuenta que se quiere leer/usar.
// Scripts portados 07/09/2026 desde maximia-mail-tasks/scripts/ (mismo
// mecanismo, ver src/services/outlook/classic.ts de ese proyecto).
//
// Mismo gotcha que /api/reveal (ver comentario ahí): bajo WSL el PATH del
// proceso no siempre trae el interop de Windows, así que usamos la ruta
// absoluta a powershell.exe en vez de confiar en que 'powershell.exe' se
// resuelva solo.
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const run = promisify(execFile);

const IS_WIN = process.platform === 'win32';
const WSL_POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

function powershellBin() {
  if (IS_WIN) return 'powershell.exe';
  return fs.existsSync(WSL_POWERSHELL) ? WSL_POWERSHELL : 'powershell.exe';
}

// Los .ps1 viven en scripts/ junto a la raíz del repo. Bajo WSL, PowerShell
// (proceso Windows) necesita la ruta en formato Windows (C:\...), no POSIX
// (/mnt/c/...) — mismo truco que classic.ts (scriptPath).
function scriptPath(name) {
  const p = path.join(__dirname, '..', 'scripts', name);
  if (!IS_WIN && p.startsWith('/mnt/')) {
    const drive = p[5].toUpperCase();
    return `${drive}:\\${p.slice(7).replace(/\//g, '\\')}`;
  }
  return p;
}

function runPs(scriptName, args, opts = {}) {
  return run(powershellBin(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath(scriptName), ...args], {
    windowsHide: true,
    timeout: opts.timeout || 30_000,
    maxBuffer: opts.maxBuffer || 20 * 1024 * 1024,
  });
}

// Lee la bandeja de entrada del perfil abierto en Outlook clásico.
// choice: '20' | '50' | '100' | '7d' | '30d'
async function readInbox(choice = '20') {
  const { stdout } = await runPs('read-outlook.ps1', ['-Choice', choice]);
  const parsed = JSON.parse(stdout.trim() || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}

// Abre el correo original en la ventana de Outlook (no hace nada más).
async function openItem(entryId) {
  await runPs('open-outlook-item.ps1', ['-EntryId', entryId], { timeout: 30_000 });
}

// Prepara una respuesta con el texto dado y la MUESTRA en Outlook para que el
// usuario la revise y la mande él mismo — este módulo nunca envía nada.
async function openReplyDraft(entryId, bodyText) {
  const draftFile = path.join(os.tmpdir(), `ccm-outlook-reply-${crypto.randomUUID()}.txt`);
  await fs.promises.writeFile(draftFile, bodyText, { encoding: 'utf8', mode: 0o600 });
  try {
    await runPs('reply-outlook-item.ps1', ['-EntryId', entryId, '-DraftFile', draftFile], { timeout: 30_000 });
  } finally {
    await fs.promises.unlink(draftFile).catch(() => {});
  }
}

// Busca en la bandeja el correo más reciente que matchee remitente y/o texto
// en el asunto (case-insensitive, substring). Sirve para el chequeo liviano
// tipo "¿Macarena ya contestó?" sin gastar tokens — es solo lectura vía COM.
async function findLatest(inboxChoice, { fromContains, subjectContains } = {}) {
  const items = await readInbox(inboxChoice);
  const from = (fromContains || '').toLowerCase();
  const subj = (subjectContains || '').toLowerCase();
  const match = items.filter(it => {
    const okFrom = !from || (it.senderEmail || '').toLowerCase().includes(from) || (it.senderName || '').toLowerCase().includes(from);
    const okSubj = !subj || (it.subject || '').toLowerCase().includes(subj);
    return okFrom && okSubj;
  });
  // items ya viene ordenado por ReceivedTime desc (ver read-outlook.ps1)
  return match[0] || null;
}

module.exports = { readInbox, openItem, openReplyDraft, findLatest };
