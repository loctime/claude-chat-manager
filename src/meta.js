const fs = require('fs');
const path = require('path');
const os = require('os');

const META_FILE = path.join(os.homedir(), '.claude', 'session-manager', 'meta.json');
const EMPTY = () => ({ conversations: {}, superseded: [] });

function isValidShape(obj) {
  return obj
    && typeof obj === 'object'
    && obj.conversations && typeof obj.conversations === 'object' && !Array.isArray(obj.conversations)
    && Array.isArray(obj.superseded);
}

function load(file = META_FILE) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return EMPTY(); }

  try {
    const parsed = JSON.parse(raw);
    if (!isValidShape(parsed)) throw new Error('shape inválido');
    return parsed;
  } catch (e) {
    // JSON roto o shape inválido: hacer backup y arrancar limpio en vez de pisar.
    const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try { fs.copyFileSync(file, backup); } catch {}
    console.error(`[meta] archivo corrupto (${e.message}), backup en ${backup}`);
    return EMPTY();
  }
}

function save(data, file = META_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function advanceSession(data, convId, newSessionId) {
  const conv = data.conversations[convId];
  const old = conv.currentSessionId;
  if (old && old !== newSessionId && !data.superseded.includes(old)) data.superseded.push(old);
  conv.currentSessionId = newSessionId;
  return data;
}

module.exports = { load, save, advanceSession, META_FILE };
