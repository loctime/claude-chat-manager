const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || os.homedir();
const MAIL_DIR = path.join(HOME_DIR, '.ccm-notes');
const MAIL_FILE = path.join(MAIL_DIR, 'mail.json');

const EMPTY = { updatedAt: null, scanning: false, items: [] };

// Snapshot completo (no append-only como notes.jsonl): cada escaneo pisa el
// archivo entero, así que acá solo hace falta leer/escribir el JSON tal cual.
function read(file = MAIL_FILE) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return { ...EMPTY }; }
  try {
    const data = JSON.parse(raw);
    return { updatedAt: data.updatedAt ?? null, scanning: !!data.scanning, items: Array.isArray(data.items) ? data.items : [] };
  } catch (e) {
    console.error('[mail] archivo corrupto, devuelvo vacío:', e.message);
    return { ...EMPTY };
  }
}

function write(data, file = MAIL_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return data;
}

// Actualiza el estado de un item por id. Devuelve el item ya actualizado, o
// null si no existe (para que el caller responda 404).
function setState(id, state, file = MAIL_FILE) {
  const data = read(file);
  const item = data.items.find(i => i.id === id);
  if (!item) return null;
  item.state = state;
  write(data, file);
  return item;
}

// Prende/apaga el flag de escaneo en curso preservando items/updatedAt — lo
// usa server.js tanto al arrancar el job como al terminar (incluso si el job
// murió/crasheó, así el flag no queda trabado en true para siempre).
function setScanning(scanning, file = MAIL_FILE) {
  const data = read(file);
  data.scanning = !!scanning;
  write(data, file);
  return data;
}

// Busca un item por id sin exponer toda la data — usado internamente y por
// server.js cuando solo hace falta leer, no escribir.
function getItem(id, file = MAIL_FILE) {
  const data = read(file);
  return data.items.find(i => i.id === id) || null;
}

// Mergea campos del hilo de conversación de un mail (draft, draftPending,
// threadSessionId, sendResult, sentAt) sobre el item existente. Solo pisa las
// claves presentes en `patch` — el resto del item queda intacto. Devuelve el
// item actualizado, o null si no existe (para que el caller responda 404).
function setDraft(id, patch, file = MAIL_FILE) {
  const data = read(file);
  const item = data.items.find(i => i.id === id);
  if (!item) return null;
  Object.assign(item, patch);
  write(data, file);
  return item;
}

module.exports = { read, write, setState, setScanning, getItem, setDraft, MAIL_DIR, MAIL_FILE };
