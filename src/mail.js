const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || os.homedir();
const MAIL_DIR = path.join(HOME_DIR, '.ccm-notes');
const MAIL_FILE = path.join(MAIL_DIR, 'mail.json');
// Archivo de staging: acá escribe el job de escaneo (LLM + tools MCP) su
// resultado crudo, SIN tocar mail.json directo. mergeScan() después combina
// esto con lo que ya había — ver comentario ahí sobre por qué el merge es
// código determinístico y no una instrucción más del prompt.
const SCAN_FILE = path.join(MAIL_DIR, 'mail.scan.json');

const EMPTY = { updatedAt: null, scanning: false, items: [], lastScanError: null, lastScanErrorAt: null };

// Campos que vienen del mail real y se refrescan en cada escaneo (el asunto
// no cambia, pero por ej. puede aparecer el cuerpo completo de un mail que
// la vez anterior se había guardado truncado o solo con el summary). Todo lo
// que NO está en esta lista es estado local del panel (state, draft,
// draftPending, threadSessionId, sendResult, sentAt) y un escaneo nuevo
// nunca lo toca.
const SCAN_FIELDS = ['from', 'subject', 'summary', 'body', 'project', 'urgent', 'receivedAt', 'messageId', 'threadId', 'account'];

// Snapshot completo (no append-only como notes.jsonl): cada escaneo pisa el
// archivo entero, así que acá solo hace falta leer/escribir el JSON tal cual.
function read(file = MAIL_FILE) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return { ...EMPTY }; }
  try {
    const data = JSON.parse(raw);
    return {
      updatedAt: data.updatedAt ?? null,
      scanning: !!data.scanning,
      items: Array.isArray(data.items) ? data.items : [],
      // Último intento de escaneo que NO pudo escribir resultados (MCP caído,
      // sesión sin las tools, etc.) — null si el último intento salió bien.
      // Se lee/escribe siempre junto con el resto para no perderlo en el
      // próximo write() de cualquier otra función (setState, setDraft...).
      lastScanError: data.lastScanError ?? null,
      lastScanErrorAt: data.lastScanErrorAt ?? null,
    };
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

// Combina el resultado crudo de un escaneo (SCAN_FILE) con lo que ya había
// en mail.json, en vez de que el escaneo pise el archivo entero. Antes de
// esto el prompt del escaneo escribía mail.json directo con
// `state: siempre "pendiente"` — cada "Actualizar bandeja" volvía todo a
// Pendiente y borraba los borradores en curso, porque el LLM reescribía el
// archivo de cero. El merge queda en código, no en el prompt: así es
// determinístico y no depende de que el LLM se acuerde de mergear bien.
//
// - Mail que ya estaba (mismo id): se actualizan solo los SCAN_FIELDS (por
//   si ahora hay body completo, cambió urgent, etc.) — state/draft/
//   draftPending/threadSessionId/sendResult/sentAt quedan intactos.
// - Mail nuevo: entra tal cual con state 'pendiente'.
// - Mail que ya estaba pero no salió en este escaneo (se fue de la ventana
//   de "no leídos + últimos 3 días"): se conserva sin tocar, no desaparece.
//
// Devuelve el mail.json ya mergeado y escrito. Si SCAN_FILE no existe o está
// corrupto (el job de escaneo falló, o la sesión no tenía las tools MCP
// disponibles y nunca llegó a escribir), no toca items/updatedAt y en cambio
// deja registrado `lastScanError` — server.js lo completa después con el
// último mensaje del LLM (más útil que este genérico) vía setScanError().
// Sin esto, un escaneo fallido quedaba indistinguible de "no había nada
// nuevo": el panel no mostraba ninguna diferencia y parecía que todo estaba
// al día cuando en realidad ni se había intentado leer el correo.
function mergeScan(file = MAIL_FILE, scanFile = SCAN_FILE) {
  let scanned;
  try {
    scanned = JSON.parse(fs.readFileSync(scanFile, 'utf8'));
  } catch (e) {
    console.error('[mail] no se pudo leer el resultado del escaneo, dejo mail.json como está:', e.message);
    const data = read(file);
    data.scanning = false;
    data.lastScanError = 'El escaneo terminó sin traer resultados (revisá si el MCP de Gmail/Outlook está conectado).';
    data.lastScanErrorAt = new Date().toISOString();
    write(data, file);
    return data;
  }
  const scanItems = Array.isArray(scanned.items) ? scanned.items : [];

  const data = read(file);
  const byId = new Map(data.items.map(i => [i.id, i]));
  for (const scanItem of scanItems) {
    const existing = byId.get(scanItem.id);
    if (existing) {
      for (const field of SCAN_FIELDS) {
        if (scanItem[field] !== undefined) existing[field] = scanItem[field];
      }
    } else {
      byId.set(scanItem.id, { ...scanItem, state: 'pendiente' });
    }
  }

  data.items = Array.from(byId.values());
  data.updatedAt = new Date().toISOString();
  data.scanning = false;
  data.lastScanError = null;
  data.lastScanErrorAt = null;
  write(data, file);
  try { fs.unlinkSync(scanFile); } catch { /* no pasa nada si no estaba */ }
  return data;
}

// Reemplaza el texto de lastScanError (p.ej. con el último mensaje real del
// LLM, más informativo que el genérico que pone mergeScan) sin tocar el
// resto de mail.json. No hace nada si ya no hay error registrado — evita
// pisar un éxito posterior si esto corre tarde por alguna razón.
function setScanError(message, file = MAIL_FILE) {
  const data = read(file);
  if (!data.lastScanError) return data;
  data.lastScanError = message;
  write(data, file);
  return data;
}

module.exports = { read, write, setState, setScanning, getItem, setDraft, mergeScan, setScanError, MAIL_DIR, MAIL_FILE, SCAN_FILE };
