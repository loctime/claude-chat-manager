const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { CodexAvailability } = require('../src/codex-availability');

function childThatCloses(code) {
  const child = new EventEmitter();
  child.kill = () => {};
  process.nextTick(() => child.emit('close', code));
  return child;
}

test('habilita Codex si `login status` termina correctamente', async () => {
  let received;
  const service = new CodexAvailability({ command: 'codex', spawnFn: (...args) => {
    received = args;
    return childThatCloses(0);
  } });
  const result = await service.get();
  assert.equal(result.available, true);
  assert.equal(received[0], 'codex');
  assert.deepEqual(received[1], ['login', 'status']);
});

test('oculta Codex si el CLI no está autenticado o falla', async () => {
  const service = new CodexAvailability({ spawnFn: () => childThatCloses(1) });
  assert.equal((await service.get()).available, false);
});

test('para un entrypoint .js invoca Node con el script de Codex', async () => {
  let received;
  const service = new CodexAvailability({ command: 'C:\\codex.js', spawnFn: (...args) => {
    received = args;
    return childThatCloses(0);
  } });
  await service.get();
  assert.equal(received[0], process.execPath);
  assert.deepEqual(received[1], ['C:\\codex.js', 'login', 'status']);
});
