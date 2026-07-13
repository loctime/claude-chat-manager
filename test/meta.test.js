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
