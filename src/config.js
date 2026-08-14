const fs = require('fs');
const path = require('path');
const os = require('os');

// Config chica de instancia (hoy solo appName, pensado para sumar más). Vive
// en un JSON aparte de meta.json/notes.jsonl porque es config de la app en
// sí, no datos de usuario — mismo patrón atómico tmp+rename que meta.js para
// no dejar el archivo a medio escribir si el proceso muere en el medio.
const HOME_DIR = process.env.HOME || process.env.USERPROFILE || os.homedir();
const CONFIG_FILE = path.join(HOME_DIR, '.ccm-config.json');

function load(file = CONFIG_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {};
  }
}

function save(data, file = CONFIG_FILE) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = { load, save, CONFIG_FILE };
