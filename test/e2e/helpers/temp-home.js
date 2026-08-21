// Fabrica un HOME de prueba aislado (temp dir) con una conversación de fixture
// ya en disco — mismo formato .jsonl que lee src/scanner.js — para que los
// tests e2e tengan algo real para abrir/buscar sin depender de tu instalación
// de Claude Code ni de tus datos reales.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function encodeProjectDir(p) { return String(p).replace(/[^a-zA-Z0-9]/g, '-'); }

// Término elegido a propósito raro (no aparece en texto normal) para que el
// test del buscador no dependa de que el resto del fixture no lo contenga
// por casualidad.
const SEARCH_TERM = 'murcielagovolador';

function seedTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-e2e-'));
  const projectDir = path.join(dir, 'proyecto-fixture');
  fs.mkdirSync(projectDir, { recursive: true });

  const projRoot = path.join(dir, '.claude', 'projects', encodeProjectDir(projectDir));
  fs.mkdirSync(projRoot, { recursive: true });

  const sessionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const lines = [
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: `¿Qué es un ${SEARCH_TERM}?` },
      uuid: crypto.randomUUID(),
      timestamp: now,
      cwd: projectDir,
    }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Es el término de prueba de este fixture — no existe de verdad.' }], model: 'claude-sonnet-5' },
      timestamp: now,
      cwd: projectDir,
    }),
  ];
  fs.writeFileSync(path.join(projRoot, `${sessionId}.jsonl`), lines.join('\n') + '\n');

  return { dir, projectDir, sessionId, searchTerm: SEARCH_TERM };
}

module.exports = { seedTempHome, encodeProjectDir, SEARCH_TERM };
