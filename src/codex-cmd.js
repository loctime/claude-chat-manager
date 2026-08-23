const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// codex en PATH es un shim .cmd de npm (igual que claude, ver claude-cmd.js) —
// Node no puede spawnearlo sin shell:true. A diferencia de Claude, el paquete
// @openai/codex no vendorea un .exe: el entry point real es bin/codex.js, un
// script Node puro. Se invoca con `node <ruta> <args>` (ver isNodeScript en
// codex-runner.js). Verificado en esta PC: where codex → codex.cmd, real en
// AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js.
function resolveCodexCommand() {
  if (process.platform !== 'win32') return 'codex';
  if (process.env.CODEX_CMD) return process.env.CODEX_CMD;
  let candidates = [];
  try {
    candidates = execFileSync('where', ['codex'], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch {}
  for (const c of candidates) {
    const dir = path.dirname(c);
    const entry = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (fs.existsSync(entry)) return entry;
  }
  return 'codex';
}

module.exports = { CODEX_CMD: resolveCodexCommand(), resolveCodexCommand };
