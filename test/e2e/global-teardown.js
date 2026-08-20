// Corre UNA vez después de toda la suite — para el server de prueba (nunca el
// real: el pid es el que anotó global-setup.js para ESTE run) y borra la
// carpeta HOME temporal. Lee de disco (no de process.env/memoria) porque
// Playwright puede correr esto en un proceso de Node distinto al del setup.
'use strict';
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '.e2e-state.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } // signal 0: solo chequea, no mata
  catch { return false; }
}

// process.kill() en Windows dispara la terminación pero no espera a que el SO
// libere sus file handles (el .ccm-search.db, sobre todo) — borrar la carpeta
// enseguida puede pisarse con eso y fallar en silencio. Se espera a que el
// proceso deje de existir (o un tope de 3s) antes de intentar el rmSync.
async function waitForExit(pid, timeoutMs = 3000) {
  const start = Date.now();
  while (isAlive(pid) && Date.now() - start < timeoutMs) await sleep(100);
}

async function removeWithRetries(dir, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return true; }
    catch { await sleep(200); }
  }
  return false;
}

module.exports = async function globalTeardown() {
  let state;
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return; } // nada que limpiar (setup no llegó a escribir el archivo)

  if (state.pid) {
    try { process.kill(state.pid); } catch { /* ya no existe, no pasa nada */ }
    await waitForExit(state.pid);
  }
  if (state.homeDir) {
    const ok = await removeWithRetries(state.homeDir);
    if (!ok) console.warn(`[e2e] no se pudo borrar el HOME temporal de prueba: ${state.homeDir} (no es fatal, pero queda basura en el temp)`);
  }
  try { fs.rmSync(STATE_FILE, { force: true }); } catch {}
};
