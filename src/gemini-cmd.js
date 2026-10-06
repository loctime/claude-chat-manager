const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Antigravity instala un binario nativo. El proceso actual de Jarvis puede no
// haber refrescado PATH, por eso se prioriza su ruta oficial por usuario.
function resolveGeminiCommand() {
  if (process.env.ANTIGRAVITY_CMD) return process.env.ANTIGRAVITY_CMD;
  if (process.platform === 'win32') {
    const installed = path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe');
    if (fs.existsSync(installed)) return installed;
    try {
      return execFileSync('where', ['agy'], { encoding: 'utf8', windowsHide: true })
        .split(/\r?\n/).map(x => x.trim()).find(Boolean) || 'agy';
    } catch { return 'agy'; }
  }
  // El instalador oficial de Linux/Mac deja el binario en ~/.local/bin, que
  // solo entra al PATH en una shell interactiva (via .bashrc/.profile) -- un
  // proceso lanzado por pm2 (o por sudo -u sin shell de login) no lo hereda,
  // y spawn('agy', ...) tira ENOENT aunque el binario exista. Mismo patrón
  // que el caso Windows: ruta oficial primero, `which` como respaldo.
  const installed = path.join(os.homedir(), '.local', 'bin', 'agy');
  if (fs.existsSync(installed)) return installed;
  try {
    return execFileSync('which', ['agy'], { encoding: 'utf8' }).trim() || 'agy';
  } catch { return 'agy'; }
}

module.exports = { GEMINI_CMD: resolveGeminiCommand(), resolveGeminiCommand };
