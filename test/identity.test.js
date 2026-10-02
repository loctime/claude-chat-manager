const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const slotsLib = require('../src/slots');
const { resolveIdentity } = require('../src/identity');

function tmpFile() {
  return path.join(os.tmpdir(), `ccm-identity-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test('resolveIdentity reconoce el ACCESS_PIN como admin', () => {
  const result = resolveIdentity('el-pin-admin', 'el-pin-admin', tmpFile());
  assert.deepStrictEqual(result, { kind: 'admin' });
});

test('resolveIdentity reconoce el pin de un slot como ese slot', () => {
  const file = tmpFile();
  const slot = slotsLib.createSlot({ label: 'Fernando', osUser: 'colab-fernando', projectPath: '/a', engine: 'claude' }, file);
  const result = resolveIdentity(slot.pin, 'el-pin-admin', file);
  assert.strictEqual(result.kind, 'slot');
  assert.strictEqual(result.slot.id, slot.id);
  fs.unlinkSync(file);
});

test('resolveIdentity no reconoce un valor que no es ni el admin ni ningun slot', () => {
  const file = tmpFile();
  slotsLib.createSlot({ label: 'Fernando', osUser: 'colab-fernando', projectPath: '/a', engine: 'claude' }, file);
  const result = resolveIdentity('cualquier-otra-cosa', 'el-pin-admin', file);
  assert.deepStrictEqual(result, { kind: 'none' });
  fs.unlinkSync(file);
});

test('resolveIdentity prioriza admin si por error un slot tuviera el mismo pin que ACCESS_PIN', () => {
  // createSlot nunca deberia permitir esto (ver Task 1 / Review Focus), pero
  // la resolucion en si debe preferir admin de todas formas, nunca filtrar
  // datos de un slot bajo el pin admin.
  const file = tmpFile();
  const data = slotsLib.load(file);
  data.slots.push({ id: 'x', label: 'x', osUser: 'x', projectPath: '/x', engine: 'claude', pin: 'el-pin-admin', activeConversationId: null, archivedConversationIds: [] });
  slotsLib.save(data, file);
  const result = resolveIdentity('el-pin-admin', 'el-pin-admin', file);
  assert.deepStrictEqual(result, { kind: 'admin' });
  fs.unlinkSync(file);
});
