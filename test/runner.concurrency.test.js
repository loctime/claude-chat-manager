const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { Runner } = require('../src/runner');

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = () => {};
  return c;
}

function makeRunner({ max = 2 } = {}) {
  const spawned = [];
  const r = new Runner({
    maxConcurrent: max,
    spawnFn: (cmd, args, opts) => {
      const child = fakeChild();
      spawned.push({ cmd, args, opts, child });
      return child;
    },
  });
  const statuses = [];
  r.on('status', s => statuses.push({ ...s }));
  return { r, spawned, statuses };
}

test('3 jobs con max=2: los primeros 2 corren, el 3ro queda en cola', () => {
  const { r, spawned, statuses } = makeRunner();
  r.send({ convId: 'c1', sessionId: 's1', cwd: '/t', text: 'a' });
  r.send({ convId: 'c2', sessionId: 's2', cwd: '/t', text: 'b' });
  r.send({ convId: 'c3', sessionId: 's3', cwd: '/t', text: 'c' });

  assert.equal(spawned.length, 2);
  assert.equal(r.running.size, 2);
  assert.ok(r.running.has('c1'));
  assert.ok(r.running.has('c2'));
  assert.equal(r.isBusy('c3'), true);
  assert.equal(r.running.has('c3'), false);

  // el 3ro tiene status queued pero no running
  const c3Statuses = statuses.filter(s => s.convId === 'c3');
  assert.deepEqual(c3Statuses.map(s => s.status), ['queued']);
});

test('al cerrar un job, arranca el siguiente en orden FIFO', () => {
  const { r, spawned } = makeRunner();
  r.send({ convId: 'c1', sessionId: 's1', cwd: '/t', text: 'a' });
  r.send({ convId: 'c2', sessionId: 's2', cwd: '/t', text: 'b' });
  r.send({ convId: 'c3', sessionId: 's3', cwd: '/t', text: 'c' });
  r.send({ convId: 'c4', sessionId: 's4', cwd: '/t', text: 'd' });

  assert.equal(spawned.length, 2);
  spawned[0].child.emit('close', 0);
  assert.equal(spawned.length, 3);
  assert.equal(r.running.has('c3'), true);
  assert.equal(r.running.has('c1'), false);
  assert.equal(r.isBusy('c4'), true);
  assert.equal(r.running.has('c4'), false);

  spawned[1].child.emit('close', 0);
  assert.equal(spawned.length, 4);
  assert.equal(r.running.has('c4'), true);
});

test('cancelar un job que está en cola lo saca sin afectar los running', () => {
  const { r, spawned, statuses } = makeRunner();
  r.send({ convId: 'c1', sessionId: 's1', cwd: '/t', text: 'a' });
  r.send({ convId: 'c2', sessionId: 's2', cwd: '/t', text: 'b' });
  r.send({ convId: 'c3', sessionId: 's3', cwd: '/t', text: 'c' });

  assert.equal(r.cancel('c3'), true);
  assert.equal(r.isBusy('c3'), false);

  const cancelledIdle = statuses.find(s => s.convId === 'c3' && s.status === 'idle');
  assert.ok(cancelledIdle);
  assert.equal(cancelledIdle.cancelled, true);

  // los 2 corriendo siguen ahí, no se spawneó un 3ro
  assert.equal(spawned.length, 2);
  assert.equal(r.running.size, 2);
});

test('cerrar múltiples jobs seguidos drena la cola sin quedar atascada', () => {
  const { r, spawned } = makeRunner();
  for (let i = 0; i < 5; i++) {
    r.send({ convId: `c${i}`, sessionId: `s${i}`, cwd: '/t', text: 't' + i });
  }
  assert.equal(spawned.length, 2);

  // cerrar los dos primeros en cascada
  spawned[0].child.emit('close', 0);
  spawned[1].child.emit('close', 0);
  assert.equal(spawned.length, 4);

  // cerrar los siguientes dos
  spawned[2].child.emit('close', 0);
  spawned[3].child.emit('close', 0);
  assert.equal(spawned.length, 5);

  spawned[4].child.emit('close', 0);
  assert.equal(r.running.size, 0);
  assert.equal(r.queue.length, 0);
});

test('max=1 serializa completamente los jobs', () => {
  const { r, spawned } = makeRunner({ max: 1 });
  r.send({ convId: 'c1', sessionId: 's1', cwd: '/t', text: 'a' });
  r.send({ convId: 'c2', sessionId: 's2', cwd: '/t', text: 'b' });
  r.send({ convId: 'c3', sessionId: 's3', cwd: '/t', text: 'c' });

  assert.equal(spawned.length, 1);
  spawned[0].child.emit('close', 0);
  assert.equal(spawned.length, 2);
  spawned[1].child.emit('close', 0);
  assert.equal(spawned.length, 3);
});

test('un job que falla libera el slot para el siguiente', () => {
  const { r, spawned } = makeRunner();
  r.send({ convId: 'c1', sessionId: 's1', cwd: '/t', text: 'a' });
  r.send({ convId: 'c2', sessionId: 's2', cwd: '/t', text: 'b' });
  r.send({ convId: 'c3', sessionId: 's3', cwd: '/t', text: 'c' });

  spawned[0].child.emit('error', new Error('boom'));
  assert.equal(spawned.length, 3);
  assert.equal(r.running.has('c3'), true);
});

test('cancelar un running mata el child pero no arranca el próximo hasta close', () => {
  const { r, spawned } = makeRunner();
  let killed = false;
  r.send({ convId: 'c1', sessionId: 's1', cwd: '/t', text: 'a' });
  r.send({ convId: 'c2', sessionId: 's2', cwd: '/t', text: 'b' });
  r.send({ convId: 'c3', sessionId: 's3', cwd: '/t', text: 'c' });

  spawned[0].child.kill = () => { killed = true; };
  assert.equal(r.cancel('c1'), true);
  assert.equal(killed, true);
  // c1 sigue en running hasta que el child emita close
  assert.equal(r.running.has('c1'), true);
  assert.equal(spawned.length, 2);

  // al cerrar, se libera el slot y arranca c3
  spawned[0].child.emit('close', -1);
  assert.equal(r.running.has('c1'), false);
  assert.equal(spawned.length, 3);
  assert.equal(spawned[2].args[1], 'c');
});
