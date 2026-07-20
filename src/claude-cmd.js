const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// En Windows `claude` instalado por npm es un shim .cmd que Node no puede
// spawnear sin shell:true (EINVAL desde Node 18.20+), y shell:true rompe el
// quoting de prompts largos. Resolvemos el binario .exe real una sola vez.
function resolveClaudeCommand() {
  if (process.platform !== 'win32') return 'claude';
  if (process.env.CLAUDE_CMD) return process.env.CLAUDE_CMD;
  let candidates = [];
  try {
    candidates = execFileSync('where', ['claude'], { encoding: 'utf8' })
      .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch {}
  // Un .exe directo en el PATH sirve tal cual
  for (const c of candidates) {
    if (c.toLowerCase().endsWith('.exe')) return c;
  }
  // Shim de npm: el exe real vive en node_modules/@anthropic-ai/claude-code/bin
  for (const c of candidates) {
    const exe = path.join(path.dirname(c), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return 'claude';
}

module.exports = { CLAUDE_CMD: resolveClaudeCommand() };
