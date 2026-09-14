const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Antigravity instala un binario nativo. El proceso actual de Jarvis puede no
// haber refrescado PATH, por eso se prioriza su ruta oficial por usuario.
function resolveGeminiCommand() {
  if (process.platform !== 'win32') return process.env.ANTIGRAVITY_CMD || 'agy';
  if (process.env.ANTIGRAVITY_CMD) return process.env.ANTIGRAVITY_CMD;
  const installed = path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe');
  if (fs.existsSync(installed)) return installed;
  try {
    return execFileSync('where', ['agy'], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).map(x => x.trim()).find(Boolean) || 'agy';
  } catch { return 'agy'; }
}

module.exports = { GEMINI_CMD: resolveGeminiCommand(), resolveGeminiCommand };
