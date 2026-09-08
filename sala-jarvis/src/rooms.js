const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Mismo patrón que src/notes.js del repo principal (notebooks): un índice
// JSON chico con la lista de salas + un jsonl append-only por sala con sus
// mensajes. No comparte código con notes.js porque este servicio se deploya
// solo (sala-jarvis es un paquete npm aparte, sin acceso al resto del repo).
const DATA_DIR = path.join(__dirname, '..', 'data');
const ROOMS_INDEX_FILE = path.join(DATA_DIR, 'rooms.json');
const ROOMS_DIR = path.join(DATA_DIR, 'rooms');

function readIndex(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return []; }
  try { return JSON.parse(raw); }
  catch (e) { console.error('[rooms] rooms.json corrupto, se ignora:', e.message); return []; }
}

function writeIndex(list, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, file);
}

function roomMessagesFile(id, roomsDir) {
  return path.join(roomsDir, id, 'messages.jsonl');
}

function readAllMessages(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); }
    catch (e) { console.error('[rooms] línea corrupta salteada:', e.message); }
  }
  return out;
}

function listRooms(indexFile = ROOMS_INDEX_FILE, roomsDir = ROOMS_DIR) {
  return readIndex(indexFile).map(room => {
    const messages = readAllMessages(roomMessagesFile(room.id, roomsDir));
    const last = messages[messages.length - 1];
    return { ...room, lastActivity: last ? last.ts : room.createdAt };
  });
}

function createRoom(name, indexFile = ROOMS_INDEX_FILE) {
  const list = readIndex(indexFile);
  const entry = { id: crypto.randomUUID(), name, createdAt: Date.now() };
  list.push(entry);
  writeIndex(list, indexFile);
  return entry;
}

function getRoom(id, indexFile = ROOMS_INDEX_FILE) {
  return readIndex(indexFile).find(r => r.id === id) || null;
}

function appendMessage(id, author, text, roomsDir = ROOMS_DIR) {
  const file = roomMessagesFile(id, roomsDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const message = { author, text, ts: Date.now() };
  fs.appendFileSync(file, JSON.stringify(message) + '\n');
  const total = readAllMessages(file).length;
  return { message, total };
}

function readMessagesSince(id, since, roomsDir = ROOMS_DIR) {
  const all = readAllMessages(roomMessagesFile(id, roomsDir));
  return { messages: all.slice(since), nextCursor: all.length };
}

module.exports = {
  listRooms, createRoom, getRoom, appendMessage, readMessagesSince,
  ROOMS_INDEX_FILE, ROOMS_DIR,
};
