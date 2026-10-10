const express = require('express');
const { execFile } = require('child_process');
const { CLAUDE_CMD } = require('../claude-cmd');

// Actualiza los CLIs que usa la app como motores (Claude Code, AgY, Codex).
// Cada turno de chat lanza un proceso nuevo, así que no hace falta reiniciar nada:
// el próximo mensaje ya usa el binario nuevo.
const TIMEOUT_MS = 5 * 60 * 1000;

const TOOLS = [
  { id: 'claude', label: 'Claude', cmd: CLAUDE_CMD, version: ['--version'], update: ['update'] },
  { id: 'agy', label: 'AgY', cmd: 'agy', version: ['--version'], update: ['update'] },
  { id: 'codex', label: 'Codex', cmd: 'codex', version: ['--version'], update: null,
    updateCmd: 'npm', updateArgs: ['install', '-g', '@openai/codex@latest'] },
];

function run(cmd, args, timeout = 30000) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024, shell: process.platform === 'win32' }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}`.trim(), error: err && err.message });
    });
  });
}

const firstLine = s => (s || '').split(/\r?\n/).find(l => l.trim()) || '';

function createCliUpdateRouter() {
  const router = express.Router();
  let running = false;

  router.post('/cli-update', async (req, res) => {
    if (running) return res.status(409).json({ error: 'Ya hay una actualización en curso.' });
    running = true;
    try {
      const results = [];
      for (const t of TOOLS) {
        const before = firstLine((await run(t.cmd, t.version)).out);
        const up = t.update
          ? await run(t.cmd, t.update, TIMEOUT_MS)
          : await run(t.updateCmd, t.updateArgs, TIMEOUT_MS);
        const after = firstLine((await run(t.cmd, t.version)).out);
        results.push({
          id: t.id, label: t.label, ok: up.ok, before, after,
          changed: !!before && !!after && before !== after,
          detail: up.ok ? firstLine(up.out) : firstLine(up.out) || up.error,
        });
      }
      res.json({ results });
    } finally {
      running = false;
    }
  });

  return router;
}

module.exports = { createCliUpdateRouter };
