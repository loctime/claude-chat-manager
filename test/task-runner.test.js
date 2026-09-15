const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runTaskScript } = require('../src/task-runner');

function writeScript(dir, name, code) { fs.writeFileSync(path.join(dir, name), code); }

test('runTaskScript llama run y devuelve state/ui', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-tasks-'));
  writeScript(dir, 'ok.js', "module.exports = { run: async ({ state, input }) => ({ state: { ...state, visto: input }, ui: { type: 'accion', boton: 'Seguir' } }) };");
  assert.deepEqual(await runTaskScript({ scriptModule: 'ok.js' }, { state: {}, input: 'hola', dryRun: true }, dir), { state: { visto: 'hola' }, ui: { type: 'accion', boton: 'Seguir' } });
});

test('runTaskScript pasa dryRun al script', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-tasks-dryrun-'));
  writeScript(dir, 'dryrun.js', "module.exports = { run: async ({ dryRun }) => ({ state: {}, ui: { type: 'accion', boton: dryRun ? 'Prueba' : 'Real' } }) };");
  assert.equal((await runTaskScript({ scriptModule: 'dryrun.js' }, { state: {}, dryRun: true }, dir)).ui.boton, 'Prueba');
});

test('runTaskScript rechaza un módulo inexistente o inválido', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-tasks-invalid-'));
  await assert.rejects(() => runTaskScript({ scriptModule: 'no-existe.js' }, { state: {} }, dir), /No se pudo cargar el script/);
  writeScript(dir, 'bad.js', 'module.exports = { run: async () => ({ algo: 1 }) };');
  await assert.rejects(() => runTaskScript({ scriptModule: 'bad.js' }, { state: {} }, dir), /debe devolver \{ state, ui/);
});

test('runTaskScript corta con timeout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-tasks-timeout-'));
  writeScript(dir, 'slow.js', 'module.exports = { run: async () => new Promise(() => {}) };');
  await assert.rejects(() => runTaskScript({ scriptModule: 'slow.js' }, { state: {} }, dir, 50), /tardó más de/);
});
