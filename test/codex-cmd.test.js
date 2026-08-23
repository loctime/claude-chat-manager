const test = require('node:test');
const assert = require('node:assert');

test('en plataformas no-Windows devuelve "codex" tal cual', () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  delete require.cache[require.resolve('../src/codex-cmd')];
  const { resolveCodexCommand } = require('../src/codex-cmd');
  assert.equal(resolveCodexCommand(), 'codex');
  Object.defineProperty(process, 'platform', original);
  delete require.cache[require.resolve('../src/codex-cmd')];
});

test('CODEX_CMD env var tiene prioridad en Windows', () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  process.env.CODEX_CMD = 'C:\\fake\\codex.js';
  delete require.cache[require.resolve('../src/codex-cmd')];
  const { resolveCodexCommand } = require('../src/codex-cmd');
  assert.equal(resolveCodexCommand(), 'C:\\fake\\codex.js');
  delete process.env.CODEX_CMD;
  Object.defineProperty(process, 'platform', original);
  delete require.cache[require.resolve('../src/codex-cmd')];
});
