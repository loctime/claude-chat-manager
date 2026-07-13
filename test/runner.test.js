const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { Runner } = require('../src/runner');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function makeRunner(spawned) {
  return new Runner({
    maxConcurrent: 2,
    spawnFn: (cmd, args, opts) => {
      const child = fakeChild();
      spawned.push({ cmd, args, opts, child });
      return child;
    },
  });
}

test('arma los args correctos con y sin --resume', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  r.send({ convId: 'c1', sessionId: 's1', cwd: '/tmp/p', text: 'hola' });
  r.send({ convId: 'c2', sessionId: null, cwd: '/tmp/q', text: 'nueva' });
  assert.ok(spawned[0].args.includes('--resume') && spawned[0].args.includes('s1'));
  assert.ok(spawned[0].args.includes('--dangerously-skip-permissions'));
  assert.ok(spawned[0].args.includes('--verbose'));
  assert.equal(spawned[0].opts.cwd, '/tmp/p');
  assert.ok(!spawned[1].args.includes('--resume'));
});

test('pasa --model cuando el job lo tiene, lo omite si no', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  r.send({ convId: 'c1', sessionId: 's1', cwd: '/t', text: 'a', model: 'haiku' });
  r.send({ convId: 'c2', sessionId: 's2', cwd: '/t', text: 'b' });
  const i = spawned[0].args.indexOf('--model');
  assert.ok(i >= 0);
  assert.equal(spawned[0].args[i + 1], 'haiku');
  assert.ok(!spawned[1].args.includes('--model'));
});

test('semáforo de 2: el tercero queda en cola y arranca al liberarse un slot', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  const statuses = [];
  r.on('status', s => statuses.push(s));
  r.send({ convId: 'c1', sessionId: 's1', cwd: '/t', text: 'a' });
  r.send({ convId: 'c2', sessionId: 's2', cwd: '/t', text: 'b' });
  r.send({ convId: 'c3', sessionId: 's3', cwd: '/t', text: 'c' });
  assert.equal(spawned.length, 2);
  assert.ok(statuses.some(s => s.convId === 'c3' && s.status === 'queued'));
  assert.ok(r.isBusy('c3'));
  spawned[0].child.emit('close', 0);
  assert.equal(spawned.length, 3);
  assert.equal(spawned[2].args[1], 'c');
});

test('parsea stdout por líneas y emite eventos JSON', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  const events = [];
  r.on('event', e => events.push(e));
  r.send({ convId: 'c1', sessionId: 's1', cwd: '/t', text: 'a' });
  spawned[0].child.stdout.emit('data', '{"type":"assistant","message":{}}\n{"type":"res');
  spawned[0].child.stdout.emit('data', 'ult","session_id":"s2"}\nbasura no json\n');
  assert.equal(events.length, 2);
  assert.equal(events[1].event.type, 'result');
  assert.equal(events[1].event.session_id, 's2');
});

test('close con código != 0 emite idle con stderr', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  const statuses = [];
  r.on('status', s => statuses.push(s));
  r.send({ convId: 'c1', sessionId: 's1', cwd: '/t', text: 'a' });
  spawned[0].child.stderr.emit('data', 'explotó todo');
  spawned[0].child.emit('close', 1);
  const idle = statuses.find(s => s.status === 'idle');
  assert.equal(idle.code, 1);
  assert.match(idle.stderr, /explotó/);
  assert.equal(r.isBusy('c1'), false);
});

test('flushea buffer al cerrar si la última línea no tiene newline', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  const events = [];
  r.on('event', e => events.push(e));
  r.send({ convId: 'c1', sessionId: 's1', cwd: '/t', text: 'a' });
  // envía JSON sin trailing newline
  spawned[0].child.stdout.emit('data', '{"type":"result","session_id":"sX"}');
  assert.equal(events.length, 0); // aún no emite
  spawned[0].child.emit('close', 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].event.type, 'result');
  assert.equal(events[0].event.session_id, 'sX');
});

test('child.emit("error") emite idle con code -1 y drena cola', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  const statuses = [];
  r.on('status', s => statuses.push(s));
  r.send({ convId: 'c1', sessionId: 's1', cwd: '/t', text: 'a' });
  r.send({ convId: 'c2', sessionId: 's2', cwd: '/t', text: 'b' });
  r.send({ convId: 'c3', sessionId: 's3', cwd: '/t', text: 'c' });
  assert.equal(spawned.length, 2);
  // emite error en c1
  spawned[0].child.emit('error', new Error('spawn claude ENOENT'));
  // debe liberar slot y haber iniciado c3
  assert.equal(spawned.length, 3);
  assert.equal(r.isBusy('c1'), false);
  // debe emitir idle con code -1 y stderr del error
  const idle = statuses.find(s => s.convId === 'c1' && s.status === 'idle');
  assert.ok(idle);
  assert.equal(idle.code, -1);
  assert.match(idle.stderr, /ENOENT/);
  // luego emit('close') en el mismo child no debe emitir un segundo idle
  spawned[0].child.emit('close', 0);
  const idles = statuses.filter(s => s.convId === 'c1' && s.status === 'idle');
  assert.equal(idles.length, 1);
});
