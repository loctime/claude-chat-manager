const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const slots = require('../src/slots');

function tmpFile() {
  return path.join(os.tmpdir(), `ccm-slots-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test('createSlot genera id y pin, y los slots nuevos no colisionan', () => {
  const file = tmpFile();
  const a = slots.createSlot({ label: 'Fernando', osUser: 'colab-fernando', projectPath: '/home/colab-fernando/proyecto', engine: 'claude' }, file);
  const b = slots.createSlot({ label: 'Otra', osUser: 'colab-otra', projectPath: '/home/colab-otra/proyecto', engine: 'codex' }, file);
  assert.notStrictEqual(a.id, b.id);
  assert.notStrictEqual(a.pin, b.pin);
  assert.strictEqual(a.activeConversationId, null);
  assert.deepStrictEqual(a.archivedConversationIds, []);
  fs.unlinkSync(file);
});

test('createSlot rechaza un engine invalido', () => {
  const file = tmpFile();
  assert.throws(() => slots.createSlot({ label: 'X', osUser: 'colab-x', projectPath: '/home/colab-x/p', engine: 'gpt5' }, file));
});

test('createSlot rechaza un osUser repetido', () => {
  const file = tmpFile();
  slots.createSlot({ label: 'Fernando', osUser: 'colab-fernando', projectPath: '/a', engine: 'claude' }, file);
  assert.throws(() => slots.createSlot({ label: 'Otro', osUser: 'colab-fernando', projectPath: '/b', engine: 'claude' }, file));
  fs.unlinkSync(file);
});

test('resolveByPin encuentra el slot correcto y ninguno para un pin inexistente', () => {
  const file = tmpFile();
  const a = slots.createSlot({ label: 'Fernando', osUser: 'colab-fernando', projectPath: '/a', engine: 'claude' }, file);
  const found = slots.resolveByPin(a.pin, file);
  assert.strictEqual(found.id, a.id);
  assert.strictEqual(slots.resolveByPin('no-existe-este-pin', file), null);
  fs.unlinkSync(file);
});

test('switchEngine archiva la conversacion activa y arranca una nueva', () => {
  const file = tmpFile();
  const a = slots.createSlot({ label: 'Fernando', osUser: 'colab-fernando', projectPath: '/a', engine: 'claude' }, file);
  slots.setActiveConversation(a.id, 'conv-1', file);
  const updated = slots.switchEngine(a.id, 'codex', file);
  assert.strictEqual(updated.engine, 'codex');
  assert.strictEqual(updated.activeConversationId, null);
  assert.deepStrictEqual(updated.archivedConversationIds, ['conv-1']);
  fs.unlinkSync(file);
});

test('switchEngine sobre un slot sin conversacion activa no agrega null a archivedConversationIds', () => {
  const file = tmpFile();
  const a = slots.createSlot({ label: 'Fernando', osUser: 'colab-fernando', projectPath: '/a', engine: 'claude' }, file);
  const updated = slots.switchEngine(a.id, 'gemini', file);
  assert.deepStrictEqual(updated.archivedConversationIds, []);
  fs.unlinkSync(file);
});

test('switchEngine tira si el slot no existe', () => {
  const file = tmpFile();
  slots.save({ slots: [] }, file);
  assert.throws(() => slots.switchEngine('no-existe', 'claude', file));
  fs.unlinkSync(file);
});
