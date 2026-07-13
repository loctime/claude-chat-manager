const fs = require('fs');
const path = require('path');
const os = require('os');

const META_FILE = path.join(os.homedir(), '.claude', 'session-manager', 'meta.json');

function load(file = META_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { conversations: {}, superseded: [] }; }
}

function save(data, file = META_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function advanceSession(data, convId, newSessionId) {
  const conv = data.conversations[convId];
  const old = conv.currentSessionId;
  if (old && old !== newSessionId && !data.superseded.includes(old)) data.superseded.push(old);
  conv.currentSessionId = newSessionId;
  return data;
}

module.exports = { load, save, advanceSession, META_FILE };
