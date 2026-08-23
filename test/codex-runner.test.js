const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { CodexRunner } = require('../src/codex-runner');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  // pid + kill: cancel() en Windows revisa child.pid antes de intentar
  // taskkill, y cae a child.kill(...) si taskkill falla — sin estos dos
  // campos, cancelar un job "corriendo" en el test tira TypeError
  // (EventEmitter no tiene .kill). El pid es inventado: taskkill va a
  // fallar contra un PID inexistente, se cae al catch, y child.kill (acá
  // un no-op) absorbe el resto sin tocar ningún proceso real.
  child.pid = 999999;
  child.kill = () => {};
  return child;
}

function makeRunner(spawned, opts = {}) {
  return new CodexRunner({
    maxConcurrent: 2,
    command: 'codex',
    ...opts,
    spawnFn: (cmd, args, o) => {
      const child = fakeChild();
      spawned.push({ cmd, args, opts: o, child });
      return child;
    },
  });
}

test('mensaje nuevo: "exec" sin "resume", con -C y el prompt al final', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  r.send({ convId: 'c1', sessionId: null, cwd: 'C:\\p', text: 'hola' });
  const a = spawned[0].args;
  assert.equal(a[0], 'exec');
  assert.ok(!a.includes('resume'));
  assert.ok(a.includes('-C') && a[a.indexOf('-C') + 1] === 'C:\\p');
  assert.equal(a[a.length - 1], 'hola');
});

test('con sessionId: "exec resume <id>"', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  r.send({ convId: 'c1', sessionId: 's1', cwd: 'C:\\p', text: 'segundo mensaje' });
  const a = spawned[0].args;
  assert.equal(a[0], 'exec');
  assert.equal(a[1], 'resume');
  assert.equal(a[2], 's1');
  assert.ok(!a.includes('-C'), 'resume usa el cwd de spawn, sin -C incompatible');
});

test('con imagePath agrega -i', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  r.send({ convId: 'c1', sessionId: null, cwd: 'C:\\p', text: 'mirá esto', imagePath: 'C:\\img.png' });
  const a = spawned[0].args;
  assert.ok(a.includes('-i') && a[a.indexOf('-i') + 1] === 'C:\\img.png');
});

test('con selfPort, el prompt final incluye el aviso de infraestructura y el contrato de rutas', () => {
  const spawned = [];
  const r = makeRunner(spawned, { selfPort: 3777 });
  r.send({ convId: 'c1', sessionId: null, cwd: 'C:\\p', text: 'hola' });
  const prompt = spawned[0].args[spawned[0].args.length - 1];
  assert.match(prompt, /^hola/);
  assert.match(prompt, /AVISO INFRAESTRUCTURA/);
  assert.match(prompt, /CONTRATO DE RUTAS/);
});

test('command siempre incluye --dangerously-bypass-approvals-and-sandbox y --json', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  r.send({ convId: 'c1', sessionId: null, cwd: 'C:\\p', text: 'hola' });
  const a = spawned[0].args;
  assert.ok(a.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(a.includes('--json'));
});

test('parsea stdout JSONL y emite un evento por línea', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  const events = [];
  r.on('event', e => events.push(e));
  r.send({ convId: 'c1', sessionId: null, cwd: 'C:\\p', text: 'hola' });
  spawned[0].child.stdout.emit('data', '{"type":"thread.started","thread_id":"t1"}\n{"type":"turn.completed","usage":{}}\n');
  assert.equal(events.length, 2);
  assert.equal(events[0].event.type, 'thread.started');
  assert.equal(events[0].event.thread_id, 't1');
});

test('close con código 0 emite status idle', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  const statuses = [];
  r.on('status', s => statuses.push(s));
  r.send({ convId: 'c1', sessionId: null, cwd: 'C:\\p', text: 'hola' });
  spawned[0].child.emit('close', 0);
  const idle = statuses.find(s => s.status === 'idle');
  assert.equal(idle.code, 0);
  assert.equal(r.isBusy('c1'), false);
});

test('cancelar en cola vs. corriendo', () => {
  const spawned = [];
  const r = makeRunner(spawned, { maxConcurrent: 1 });
  r.send({ convId: 'c1', sessionId: null, cwd: 'C:\\p', text: 'a' });
  r.send({ convId: 'c2', sessionId: null, cwd: 'C:\\p', text: 'b' });
  assert.equal(r.cancel('c2'), true); // en cola
  assert.equal(r.isBusy('c2'), false);
  assert.equal(r.cancel('c1'), true); // corriendo → taskkill contra el pid falso falla, cae a child.kill() (no-op en el fake)
});

test('línea JSON corrupta en stdout no rompe el parseo', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  const events = [];
  r.on('event', e => events.push(e));
  r.send({ convId: 'c1', sessionId: null, cwd: 'C:\\p', text: 'hola' });
  spawned[0].child.stdout.emit('data', '{"type":"thread.started","thread_id":"t1"}\nbasura no json\n{"type":"turn.completed"}\n');
  assert.equal(events.length, 2);
  assert.equal(events[0].event.type, 'thread.started');
  assert.equal(events[1].event.type, 'turn.completed');
});

test('close con código != 0 emite idle con stderr', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  const statuses = [];
  r.on('status', s => statuses.push(s));
  r.send({ convId: 'c1', sessionId: null, cwd: 'C:\\p', text: 'hola' });
  spawned[0].child.stderr.emit('data', 'error message aquí');
  spawned[0].child.emit('close', 1);
  const idle = statuses.find(s => s.status === 'idle');
  assert.equal(idle.code, 1);
  assert.match(idle.stderr, /error message aquí/);
});

test('flushea buffer al cerrar si la última línea no tiene newline', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  const events = [];
  r.on('event', e => events.push(e));
  r.send({ convId: 'c1', sessionId: null, cwd: 'C:\\p', text: 'hola' });
  spawned[0].child.stdout.emit('data', '{"type":"thread.started","thread_id":"t1"}');
  // no newline al final, pero emit close debe flusear el buffer
  spawned[0].child.emit('close', 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].event.type, 'thread.started');
});

test('child.emit(\'error\', ...) emite status idle con code -1 y libera el slot', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  const statuses = [];
  r.on('status', s => statuses.push(s));
  r.send({ convId: 'c1', sessionId: null, cwd: 'C:\\p', text: 'hola' });
  spawned[0].child.emit('error', new Error('spawn failed'));
  // el error debe emitir idle y liberar el slot
  const idle = statuses.find(s => s.status === 'idle' && s.code === -1);
  assert.ok(idle);
  assert.match(idle.stderr, /spawn failed/);
  assert.equal(r.isBusy('c1'), false);
  // un segundo close() no debe emitir otro idle (guard 'done')
  const beforeClose = statuses.length;
  spawned[0].child.emit('close', 0);
  assert.equal(statuses.length, beforeClose);
});

test('semáforo de maxConcurrent: el tercer job queda en cola y arranca al liberarse un slot', () => {
  const spawned = [];
  const r = makeRunner(spawned, { maxConcurrent: 2 });
  r.send({ convId: 'c1', sessionId: null, cwd: 'C:\\p', text: 'a' });
  r.send({ convId: 'c2', sessionId: null, cwd: 'C:\\p', text: 'b' });
  r.send({ convId: 'c3', sessionId: null, cwd: 'C:\\p', text: 'c' });
  // solo 2 jobs spawnearon; el tercero está en cola
  assert.equal(spawned.length, 2);
  assert.ok(r.isBusy('c3'));
  // al cerrar el primero, el tercero debe arrancar
  spawned[0].child.emit('close', 0);
  assert.equal(spawned.length, 3);
  assert.equal(spawned[2].cmd, 'codex'); // se spawneó el comando
});

test('por defecto no limita los turnos de conversaciones Codex distintas', () => {
  const spawned = [];
  const r = new CodexRunner({
    command: 'codex',
    spawnFn: (cmd, args, opts) => {
      const child = fakeChild();
      spawned.push({ cmd, args, opts, child });
      return child;
    },
  });
  r.send({ convId: 'c1', cwd: 'C:\\p', text: 'a' });
  r.send({ convId: 'c2', cwd: 'C:\\p', text: 'b' });
  r.send({ convId: 'c3', cwd: 'C:\\p', text: 'c' });
  assert.equal(spawned.length, 3);
});
