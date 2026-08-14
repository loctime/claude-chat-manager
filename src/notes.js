const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || os.homedir();
const NOTES_DIR = path.join(HOME_DIR, '.ccm-notes');
const NOTEBOOKS_FILE = path.join(NOTES_DIR, 'notebooks.json');
const NOTEBOOKS_DIR = path.join(NOTES_DIR, 'notebooks');
// No se ata a CCM_APP_NAME a propósito: el nombre de marca (J.A.R.V.I.S,
// FerStark, lo que sea) y el nombre "amigable" de esta carpeta ya eran
// strings distintos antes de esto (J.A.R.V.I.S/Jarvis) — atarlos movería
// la carpeta cada vez que alguien cambie su nombre de marca, perdiendo el
// rastro de las notas ya guardadas ahí.
const FILES_DIR = path.join(HOME_DIR, 'Desktop', 'Notas Jarvis');

// Nombre por default de una libreta recién creada, y su patrón de detección
// (para saber si el auto-nombre por primera nota todavía puede pisarlo, o si
// el usuario ya la renombró a mano y hay que dejarla en paz).
const DEFAULT_NAME_RE = /^Nueva libreta( \d+)?$/;

// Agrega una entrada al final del jsonl de una libreta. No genera id/ts — el
// caller (server.js) ya los arma, así este módulo queda testeable con
// objetos arbitrarios.
function append(entry, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  return entry;
}

// Lee todas las entradas en orden de inserción (el archivo es append-only, así
// que el orden del archivo ES el orden cronológico). Una línea corrupta no
// tira abajo el resto: se salta y se loguea.
function readAll(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); }
    catch (e) { console.error('[notes] línea corrupta salteada:', e.message); }
  }
  return out;
}

function ensureFilesDir(dir = FILES_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Evita pisar un archivo existente: si ya hay uno con ese nombre, antepone el
// timestamp. path.basename además descarta cualquier separador de carpeta que
// venga en el nombre original (defensa ante un originalname tipo '../../x').
function resolveDestName(dir, originalName) {
  const safeName = path.basename(originalName);
  if (!fs.existsSync(path.join(dir, safeName))) return safeName;
  return `${Date.now()}-${safeName}`;
}

// ── Índice de libretas (~/.ccm-notes/notebooks.json) ──

function readNotebooksIndex(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return []; }
  try { return JSON.parse(raw); }
  catch (e) { console.error('[notes] notebooks.json corrupto, se ignora:', e.message); return []; }
}

function writeNotebooksIndex(list, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list, null, 2));
}

// Ruta del jsonl de notas de una libreta puntual — cada libreta vive en su
// propio subdirectorio, aislada de las demás.
function notebookNotesFile(id, notebooksDir = NOTEBOOKS_DIR) {
  return path.join(notebooksDir, id, 'notes.jsonl');
}

// Arma "Nueva libreta" o, si ya existe, "Nueva libreta 2", "Nueva libreta 3"…
function nextDefaultName(existingNames) {
  if (!existingNames.includes('Nueva libreta')) return 'Nueva libreta';
  let n = 2;
  while (existingNames.includes(`Nueva libreta ${n}`)) n++;
  return `Nueva libreta ${n}`;
}

// Lista de libretas con su actividad más reciente calculada al vuelo (ts de
// la última nota, o createdAt si todavía no tiene ninguna) — así el cliente
// puede ordenar/mostrar "última vez" sin tener que mantener ese dato
// duplicado y potencialmente desincronizado en el índice.
function listNotebooks(indexFile = NOTEBOOKS_FILE, notebooksDir = NOTEBOOKS_DIR) {
  return readNotebooksIndex(indexFile).map(nb => {
    const entries = readAll(notebookNotesFile(nb.id, notebooksDir));
    const last = entries[entries.length - 1];
    return { ...nb, lastActivity: last ? last.ts : nb.createdAt };
  });
}

function createNotebook(indexFile = NOTEBOOKS_FILE) {
  const list = readNotebooksIndex(indexFile);
  const name = nextDefaultName(list.map(nb => nb.name));
  const entry = { id: crypto.randomUUID(), name, createdAt: Date.now() };
  list.push(entry);
  writeNotebooksIndex(list, indexFile);
  return entry;
}

function renameNotebook(id, name, indexFile = NOTEBOOKS_FILE) {
  const list = readNotebooksIndex(indexFile);
  const nb = list.find(n => n.id === id);
  if (!nb) return null;
  nb.name = name;
  writeNotebooksIndex(list, indexFile);
  return nb;
}

function getNotebook(id, indexFile = NOTEBOOKS_FILE) {
  return readNotebooksIndex(indexFile).find(n => n.id === id) || null;
}

module.exports = {
  append, readAll, ensureFilesDir, resolveDestName,
  listNotebooks, createNotebook, renameNotebook, getNotebook,
  notebookNotesFile, nextDefaultName, DEFAULT_NAME_RE,
  NOTES_DIR, NOTEBOOKS_FILE, NOTEBOOKS_DIR, FILES_DIR,
};
