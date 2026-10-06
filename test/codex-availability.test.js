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

test('un timeout NO se recuerda: el próximo chequeo vuelve a intentar', async () => {
  let spawns = 0;
  const hangs = () => { spawns++; const c = new EventEmitter(); c.kill = () => {}; return c; };
  const service = new CodexAvailability({ spawnFn: spawns => hangs(), timeoutMs: 20 });
  assert.equal((await service.get()).available, false);
  assert.equal((await service.get()).available, false);
  assert.equal(spawns, 2, 'cada get() relanzó el chequeo en vez de usar un falso negativo en caché');
});

test('un fallo al lanzar el CLI tampoco se recuerda', async () => {
  let spawns = 0;
  const service = new CodexAvailability({ spawnFn: () => { spawns++; const c = new EventEmitter(); c.kill = () => {}; process.nextTick(() => c.emit('error', new Error('ENOENT'))); return c; } });
  assert.equal((await service.get()).available, false);
  assert.equal((await service.get()).available, false);
  assert.equal(spawns, 2);
});

test('un veredicto real de login status sí se recuerda (true y false)', async () => {
  for (const code of [0, 1]) {
    let spawns = 0;
    const service = new CodexAvailability({ spawnFn: () => { spawns++; return childThatCloses(code); } });
    const a = await service.get();
    const b = await service.get();
    assert.equal(a.available, code === 0);
    assert.equal(b.available, code === 0);
    assert.equal(spawns, 1);
  }
});

test('varias consultas simultáneas comparten un solo chequeo', async () => {
  let spawns = 0;
  const service = new CodexAvailability({ spawnFn: () => { spawns++; return childThatCloses(0); } });
  const results = await Promise.all([service.get(), service.get(), service.get(), service.get()]);
  assert.ok(results.every(r => r.available === true));
  assert.equal(spawns, 1);
});
