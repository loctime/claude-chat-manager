const express = require('express');
const path = require('path');
const rooms = require('./rooms');

// SALA_DATA_DIR: override para tests (hermético, sin tocar sala-jarvis/data/
// real) y para poder apuntar el servicio en el VPS a un disco/ruta distinta
// si hiciera falta. Sin la env var, rooms.js usa sus defaults (sala-jarvis/data/).
const dataDir = process.env.SALA_DATA_DIR;
const indexFile = dataDir ? path.join(dataDir, 'rooms.json') : rooms.ROOMS_INDEX_FILE;
const roomsDir = dataDir ? path.join(dataDir, 'rooms') : rooms.ROOMS_DIR;

const PORT = Number(process.env.PORT || 3410);

// "Nombre1:token1,Nombre2:token2" → Map<token, nombre>. Entradas vacías o
// sin ":" se ignoran en silencio (config a mano en el VPS, más vale
// tolerante que tirar el server por una coma de más).
function parseTokens(raw) {
  const map = new Map();
  for (const pair of (raw || '').split(',')) {
    const [name, token] = pair.split(':').map(s => (s || '').trim());
    if (name && token) map.set(token, name);
  }
  return map;
}

const TOKENS = parseTokens(process.env.SALA_TOKENS || '');

const app = express();
app.use(express.json());

// El autor de cada mensaje sale del token, nunca de lo que mande el cliente
// en el body — así ninguna de las dos instancias puede publicar en nombre
// de la otra, ni por bug ni a propósito.
app.use((req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const senderName = TOKENS.get(token);
  if (!senderName) return res.status(401).json({ error: 'token inválido' });
  req.senderName = senderName;
  next();
});

app.get('/rooms', (req, res) => {
  res.json({ rooms: rooms.listRooms(indexFile, roomsDir) });
});

app.post('/rooms', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'nombre vacío' });
  res.status(201).json(rooms.createRoom(name, indexFile));
});

app.get('/rooms/:id/messages', (req, res) => {
  if (!rooms.getRoom(req.params.id, indexFile)) return res.status(404).json({ error: 'sala no encontrada' });
  const since = Number(req.query.since || 0);
  res.json(rooms.readMessagesSince(req.params.id, since, roomsDir));
});

app.post('/rooms/:id/messages', (req, res) => {
  if (!rooms.getRoom(req.params.id, indexFile)) return res.status(404).json({ error: 'sala no encontrada' });
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'texto vacío' });
  const kind = req.body.kind === 'human' || req.body.kind === 'agent' ? req.body.kind : undefined;
  res.status(201).json(rooms.appendMessage(req.params.id, req.senderName, text, roomsDir, kind));
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`sala-jarvis escuchando en :${PORT}`));
}

module.exports = { app, parseTokens };
