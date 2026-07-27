const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { SseHub } = require('../src/sse');

function fakeRes() {
  return {
    headers: null,
    chunks: [],
    writeHead(code, headers) { this.code = code; this.headers = headers; },
    write(s) { this.chunks.push(s); },
  };
}

test('handle escribe headers SSE y el evento hello', () => {
  const hub = new SseHub({ heartbeatMs: 60_000 });
  const req = new EventEmitter();
  const res = fakeRes();
  hub.handle(req, res, { kind: 'hello', busy: ['c1'] });
  assert.equal(res.code, 200);
  assert.equal(res.headers['Content-Type'], 'text/event-stream');
  const helloChunk = res.chunks.find(c => c.startsWith('data: '));
  assert.deepEqual(JSON.parse(helloChunk.slice(6)), { kind: 'hello', busy: ['c1'] });
  assert.equal(hub.size, 1);
  req.emit('close');
  assert.equal(hub.size, 0);
});

test('broadcast llega a todos los clientes conectados', () => {
  const hub = new SseHub({ heartbeatMs: 60_000 });
  const reqA = new EventEmitter(); const resA = fakeRes();
  const reqB = new EventEmitter(); const resB = fakeRes();
  hub.handle(reqA, resA, { kind: 'hello', busy: [] });
  hub.handle(reqB, resB, { kind: 'hello', busy: [] });
  hub.broadcast({ convId: 'c1', kind: 'status', status: 'running' });
  for (const res of [resA, resB]) {
    const last = res.chunks[res.chunks.length - 1];
    assert.deepEqual(JSON.parse(last.slice(6)), { convId: 'c1', kind: 'status', status: 'running' });
  }
  reqA.emit('close'); reqB.emit('close');
});

test('el heartbeat arranca con el primer cliente y se apaga con el último', () => {
  const hub = new SseHub({ heartbeatMs: 60_000 });
  assert.equal(hub._timer, null);
  const req = new EventEmitter(); const res = fakeRes();
  hub.handle(req, res, { kind: 'hello', busy: [] });
  assert.notEqual(hub._timer, null);
  req.emit('close');
  assert.equal(hub._timer, null);
});

test('un cliente que tira error no impide que otros clientes reciban el broadcast', () => {
  const hub = new SseHub({ heartbeatMs: 60_000 });
  const reqA = new EventEmitter(); const resA = fakeRes();
  const reqB = new EventEmitter(); const resB = fakeRes();
  const reqC = new EventEmitter(); const resC = fakeRes();
  hub.handle(reqA, resA, { kind: 'hello', busy: [] });
  hub.handle(reqB, resB, { kind: 'hello', busy: [] });
  hub.handle(reqC, resC, { kind: 'hello', busy: [] });
  assert.equal(hub.size, 3);
  // Hacer que resB lance error en write.
  resB.write = () => { throw new Error('socket destroyed'); };
  hub.broadcast({ convId: 'c1', kind: 'status', status: 'running' });
  // Verificar que resA y resC recibieron el broadcast.
  const lastA = resA.chunks[resA.chunks.length - 1];
  const lastC = resC.chunks[resC.chunks.length - 1];
  assert.deepEqual(JSON.parse(lastA.slice(6)), { convId: 'c1', kind: 'status', status: 'running' });
  assert.deepEqual(JSON.parse(lastC.slice(6)), { convId: 'c1', kind: 'status', status: 'running' });
  // Verificar que resB fue removido (hub.size pasó de 3 a 2).
  assert.equal(hub.size, 2);
  reqA.emit('close'); reqC.emit('close');
});
