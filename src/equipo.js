// Sala local "Equipo FerStark": Fernando + Claude + Codex + AgY (Gemini),
// los tres corriendo en la misma PC — a diferencia de sala-jarvis (que
// necesita el VPS porque coordina con una PC distinta, la de Diego), acá no
// hace falta red ni tokens: todo vive en un JSON local. Mismo patrón de
// módulo que sala-client.js+sala-context.js, pero sin HTTP.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const STORE_FILE = path.join(os.homedir(), '.claude', 'session-manager', 'equipo-rooms.json');

const EMPTY = () => ({ rooms: {} });

function load(file = STORE_FILE) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return EMPTY(); }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.rooms || typeof parsed.rooms !== 'object') throw new Error('shape inválido');
    return parsed;
  } catch (e) {
    const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try { fs.copyFileSync(file, backup); } catch {}
    console.error(`[equipo] archivo corrupto (${e.message}), backup en ${backup}`);
    return EMPTY();
  }
}

function save(data, file = STORE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function listRooms(file = STORE_FILE) {
  const data = load(file);
  return Object.values(data.rooms).sort((a, b) => (b.lastActivity || b.createdAt).localeCompare(a.lastActivity || a.createdAt));
}

function getRoom(id, file = STORE_FILE) {
  return load(file).rooms[id] || null;
}

// phase 'rules': todavía no se definieron las reglas del tema — solo
// responde Claude, proponiéndolas y preguntándole a Fernando si están bien.
// phase 'open': ya están definidas — responden los tres en cadena, charla
// libre, sin necesidad de arrobar a nadie (ver POST /rooms/:id/message en
// routes/equipo.js). Una sala nueva siempre arranca en 'rules'.
function createRoom(name, file = STORE_FILE) {
  const data = load(file);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  data.rooms[id] = { id, name, phase: 'rules', createdAt: now, lastActivity: now, messages: [] };
  save(data, file);
  return data.rooms[id];
}

function appendMessage(roomId, { from, kind, text }, file = STORE_FILE) {
  const data = load(file);
  const room = data.rooms[roomId];
  if (!room) return null;
  const msg = { id: crypto.randomUUID(), from, kind, text, ts: new Date().toISOString() };
  room.messages.push(msg);
  room.lastActivity = msg.ts;
  save(data, file);
  return msg;
}

function setPhase(roomId, phase, file = STORE_FILE) {
  const data = load(file);
  if (data.rooms[roomId]) { data.rooms[roomId].phase = phase; save(data, file); }
}

function setAgentConv(roomId, agentKey, convId, file = STORE_FILE) {
  const data = load(file);
  if (data.rooms[roomId]) { data.rooms[roomId][`${agentKey}ConvId`] = convId; save(data, file); }
}

function setBusy(roomId, busy, file = STORE_FILE) {
  const data = load(file);
  if (data.rooms[roomId]) { data.rooms[roomId].busy = !!busy; save(data, file); }
}

// Mismo criterio mecánico de corchetes que sala-context.js buildContextBlock
// (ver ahí el porqué: instrucciones de tono se pierden en el system prompt,
// un marcador mecánico concreto se respeta) — acá no hace falta parsear
// "Nombre: texto" porque los campos ya vienen separados (from/kind), nunca
// se publicó nada por HTTP a una sala remota.
function buildContextBlock(messages) {
  if (!messages || messages.length === 0) return '';
  return messages.map(m => {
    const role = m.kind === 'human' ? ' (persona)' : m.kind === 'agent' ? ' (agente de IA)' : '';
    return `[${m.from}${role} dijo:]\n${m.text}`;
  }).join('\n\n');
}

module.exports = { STORE_FILE, listRooms, getRoom, createRoom, appendMessage, setPhase, setAgentConv, setBusy, buildContextBlock };
