const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { GeminiRunner } = require('../src/gemini-runner');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 999999;
  child.kill = () => {};
  return child;
}

function makeRunner(spawned, opts = {}) {
  return new GeminiRunner({
    command: 'agy',
    ...opts,
    spawnFn: (cmd, args, o) => {
      const child = fakeChild();
      spawned.push({ cmd, args, opts: o, child });
      return child;
    },
  });
}

function emitLines(child, lines) {
  for (const line of lines) child.stdout.emit('data', Buffer.from(JSON.stringify(line) + '\n'));
}

test('arma --print-timeout generoso por default y --conversation con sessionId', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  r.send({ convId: 'c1', sessionId: 's1', cwd: 'C:\\p', text: 'hola' });
  const a = spawned[0].args;
  assert.ok(a.includes('--print-timeout') && a[a.indexOf('--print-timeout') + 1] === '20m');
  assert.ok(a.includes('--conversation') && a[a.indexOf('--conversation') + 1] === 's1');
});

test('arma --model si job.model viene definido', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  r.send({ convId: 'c1', sessionId: 's1', cwd: 'C:\\p', text: 'hola', model: 'gemini-3.8-flash-high' });
  const a = spawned[0].args;
  assert.ok(a.includes('--model') && a[a.indexOf('--model') + 1] === 'gemini-3.8-flash-high');
});

test('turno normal: result con status SUCCESS no es incomplete', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  const statuses = [];
  r.on('status', s => statuses.push(s));
  r.send({ convId: 'c1', sessionId: null, cwd: 'C:\\p', text: 'hola' });
  const { child } = spawned[0];
  emitLines(child, [
    { event: 'result', result: { status: 'SUCCESS', response: 'todo bien', conversation_id: 'conv1' } },
  ]);
  child.emit('close', 0);
  const final = statuses.find(s => s.status === 'idle');
  assert.equal(final.incomplete, false);
  assert.equal(final.response, 'todo bien');
  assert.equal(final.conversationId, 'conv1');
});

// Bug real 2026-09-14: resumir una sesión larga devolvió result con
// status:"ERROR" ("The stream was interrupted...") pero con texto parcial en
// response — antes gemini-runner lo trataba como éxito silencioso.
test('result con status ERROR se marca incomplete aunque traiga texto parcial', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  const statuses = [];
  r.on('status', s => statuses.push(s));
  r.send({ convId: 'c1', sessionId: 's1', cwd: 'C:\\p', text: 'segui' });
  const { child } = spawned[0];
  emitLines(child, [
    { event: 'result', result: { status: 'ERROR', response: 'OK\n', error: 'The stream was interrupted. Please continue the task you were working on.' } },
  ]);
  child.emit('close', 0);
  const final = statuses.find(s => s.status === 'idle');
  assert.equal(final.incomplete, true);
  assert.equal(final.stderr, 'The stream was interrupted. Please continue the task you were working on.');
});

// Bug real 2026-09-14: el turno original de Diego se cortó (probablemente
// el timeout interno del CLI) sin emitir NUNCA un evento 'result' — antes
// eso solo se detectaba como incomplete si code===0; un proceso que además
// sale con código de error quedaba sin ninguna marca.
test('sin evento result y código de error: incomplete igual (antes se perdía)', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  const statuses = [];
  r.on('status', s => statuses.push(s));
  r.send({ convId: 'c1', sessionId: 's1', cwd: 'C:\\p', text: 'hace un montón de cosas' });
  const { child } = spawned[0];
  child.stderr.emit('data', Buffer.from('algo raro paso'));
  child.emit('close', 1);
  const final = statuses.find(s => s.status === 'idle');
  assert.equal(final.incomplete, true);
  assert.equal(final.response, '');
});

test('sin evento result y código 0 (límite de herramientas): incomplete', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  const statuses = [];
  r.on('status', s => statuses.push(s));
  r.send({ convId: 'c1', sessionId: null, cwd: 'C:\\p', text: 'hola' });
  const { child } = spawned[0];
  child.emit('close', 0);
  const final = statuses.find(s => s.status === 'idle');
  assert.equal(final.incomplete, true);
});

test('spawn falla directo: status idle+incomplete, no cuelga sin avisar', () => {
  const spawned = [];
  const r = new GeminiRunner({ command: 'agy', spawnFn: () => { throw new Error('ENOENT'); } });
  const statuses = [];
  r.on('status', s => statuses.push(s));
  r.send({ convId: 'c1', sessionId: null, cwd: 'C:\\p', text: 'hola' });
  const final = statuses.find(s => s.status === 'idle');
  assert.equal(final.incomplete, true);
  assert.equal(final.stderr, 'ENOENT');
});

test('cancelar turno en curso: emite idle con cancelled true y incomplete false', () => {
  const spawned = [];
  const r = makeRunner(spawned);
  const statuses = [];
  r.on('status', s => statuses.push(s));
  r.send({ convId: 'c1', sessionId: 's1', cwd: 'C:\\p', text: 'algo largo' });
  const { child } = spawned[0];
  const cancelled = r.cancel('c1');
  assert.equal(cancelled, true);
  child.emit('close', 1);
  const final = statuses.find(s => s.status === 'idle');
  assert.equal(final.cancelled, true);
  assert.equal(final.incomplete, false);
  assert.equal(final.stderr, 'Cancelado por el usuario.');
});

