// Registro de dispositivos que entraron con el PIN — solo para que Diego
// vea en Configuración "quién anda usando esto" y note algo raro. No es
// control de acceso: ccm_auth es el PIN literal (ver server.js), así que no
// hay sesión por dispositivo que revocar acá. "Eliminar" en la UI borra la
// fila (si el dispositivo sigue mandando esa cookie, reaparece solo); la
// acción real para cortarle el paso a algo es rotar el PIN. Pedido por Diego
// 2026-10-06.
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEVICES_FILE = path.join(os.homedir(), '.claude', 'session-manager', 'devices.json');
const MIN_REWRITE_INTERVAL_MS = 5 * 60 * 1000;

function load() {
  try { return JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8')); }
  catch { return {}; }
}

function save(data) {
  fs.mkdirSync(path.dirname(DEVICES_FILE), { recursive: true });
  const tmp = `${DEVICES_FILE}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DEVICES_FILE);
}

// En memoria, aparte del archivo: evita leer+escribir disco en cada request
// autenticado (incluye el long-poll de /stream). Se resetea si se reinicia
// el server; en el peor caso un dispositivo activo reaparece con lastSeen
// desactualizado por hasta 5 minutos, no es grave para esto.
const lastTrackedAt = new Map(); // deviceId -> ms

function track(deviceId, { ip, userAgent } = {}) {
  if (!deviceId) return;
  const now = Date.now();
  const last = lastTrackedAt.get(deviceId);
  if (last && now - last < MIN_REWRITE_INTERVAL_MS) return;
  lastTrackedAt.set(deviceId, now);

  const data = load();
  const existing = data[deviceId];
  data[deviceId] = {
    ip: ip || (existing && existing.ip) || '',
    userAgent: userAgent || (existing && existing.userAgent) || '',
    firstSeen: (existing && existing.firstSeen) || now,
    lastSeen: now,
  };
  save(data);
}

function list() {
  const data = load();
  return Object.entries(data)
    .map(([id, d]) => ({ id, ...d }))
    .sort((a, b) => b.lastSeen - a.lastSeen);
}

function remove(id) {
  const data = load();
  if (!(id in data)) return false;
  delete data[id];
  save(data);
  // Si sigue mandando la cookie, que vuelva a aparecer apenas pegue el
  // próximo request, no que el throttle de 5min lo esconda un rato.
  lastTrackedAt.delete(id);
  return true;
}

module.exports = { track, list, remove, DEVICES_FILE };
