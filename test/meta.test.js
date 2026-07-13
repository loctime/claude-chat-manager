const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { load, save, advanceSession } = require('../src/meta');

const tmpMeta = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-meta-')), 'sub', 'meta.json');

test('load devuelve estructura vacía si el archivo no existe', () => {
  const data = load('/no/existe/meta.json');
  assert.deepEqual(data, { conversations: {}, superseded: [] });
});

test('save crea directorios y load lo lee de vuelta', () => {
  const file = tmpMeta();
  const data = { conversations: { c1: { name: 'mi charla', currentSessionId: 's1', projectDir: '/tmp/p' } }, superseded: [] };
  save(data, file);
  assert.deepEqual(load(file), data);
});

test('advanceSession mueve el id viejo a superseded', () => {
  const data = { conversations: { c1: { currentSessionId: 's1', projectDir: '/tmp/p' } }, superseded: [] };
  advanceSession(data, 'c1', 's2');
  assert.equal(data.conversations.c1.currentSessionId, 's2');
  assert.deepEqual(data.superseded, ['s1']);
});

test('advanceSession con mismo id no duplica en superseded', () => {
  const data = { conversations: { c1: { currentSessionId: 's1', projectDir: '/tmp/p' } }, superseded: [] };
  advanceSession(data, 'c1', 's1');
  assert.deepEqual(data.superseded, []);
});

test('advanceSession con currentSessionId null solo setea el nuevo', () => {
  const data = { conversations: { c1: { currentSessionId: null, projectDir: '/tmp/p' } }, superseded: [] };
  advanceSession(data, 'c1', 's9');
  assert.equal(data.conversations.c1.currentSessionId, 's9');
  assert.deepEqual(data.superseded, []);
});

test('load con JSON corrupto no lo pisa: hace backup y devuelve vacío', () => {
  const file = tmpMeta();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ esto no es json }');

  const data = load(file);
  assert.deepEqual(data, { conversations: {}, superseded: [] });

  // Debe existir al menos un backup meta.json.bak-*
  const dir = path.dirname(file);
  const backups = fs.readdirSync(dir).filter(f => f.startsWith('meta.json.bak-'));
  assert.ok(backups.length >= 1, 'debería haberse creado un backup');
  const backup = fs.readFileSync(path.join(dir, backups[0]), 'utf8');
  assert.equal(backup, '{ esto no es json }');
});

test('load rechaza shape inválido y hace backup', () => {
  const file = tmpMeta();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ wrong: 'shape' }));

  const data = load(file);
  assert.deepEqual(data, { conversations: {}, superseded: [] });

  const backups = fs.readdirSync(path.dirname(file)).filter(f => f.startsWith('meta.json.bak-'));
  assert.ok(backups.length >= 1);
});

test('save es atómico: no queda archivo .tmp tras completarse', () => {
  const file = tmpMeta();
  const data = { conversations: { c1: { currentSessionId: 's1', projectDir: '/tmp/p' } }, superseded: [] };
  save(data, file);
  const leftover = fs.readdirSync(path.dirname(file)).filter(f => f.includes('.tmp-'));
  assert.deepEqual(leftover, []);
  assert.deepEqual(load(file), data);
});
