const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || os.homedir();
const NOTES_DIR = path.join(HOME_DIR, '.ccm-notes');
const NOTES_FILE = path.join(NOTES_DIR, 'notes.jsonl');
const FILES_DIR = path.join(HOME_DIR, 'Desktop', 'Notas Jarvis');

// Agrega una entrada al final del jsonl. No genera id/ts — el caller (server.js)
// ya los arma, así este módulo queda testeable con objetos arbitrarios.
function append(entry, file = NOTES_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  return entry;
}

// Lee todas las entradas en orden de inserción (el archivo es append-only, así
// que el orden del archivo ES el orden cronológico). Una línea corrupta no
// tira abajo el resto: se salta y se loguea.
function readAll(file = NOTES_FILE) {
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

module.exports = { append, readAll, ensureFilesDir, resolveDestName, NOTES_DIR, NOTES_FILE, FILES_DIR };
