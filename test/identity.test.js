const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const slotsLib = require('../src/slots');
const { resolveIdentity, isSlotAllowedPath } = require('../src/identity');

function tmpFile() {
  return path.join(os.tmpdir(), `ccm-identity-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test('resolveIdentity reconoce el ACCESS_PIN como admin', () => {
  const result = resolveIdentity('el-pin-admin', 'el-pin-admin', tmpFile());
  assert.deepStrictEqual(result, { kind: 'admin' });
});

test('resolveIdentity reconoce el pin de un slot como ese slot', () => {
  const file = tmpFile();
  const slot = slotsLib.createSlot({ label: 'Fernando', osUser: 'colab-fernando', projectPath: '/home/colab-fernando/a', engine: 'claude' }, file);
  const result = resolveIdentity(slot.pin, 'el-pin-admin', file);
  assert.strictEqual(result.kind, 'slot');
  assert.strictEqual(result.slot.id, slot.id);
  fs.unlinkSync(file);
});

test('resolveIdentity no reconoce un valor que no es ni el admin ni ningun slot', () => {
  const file = tmpFile();
  slotsLib.createSlot({ label: 'Fernando', osUser: 'colab-fernando', projectPath: '/home/colab-fernando/a', engine: 'claude' }, file);
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


test('isSlotAllowedPath deja pasar solo lo propio de un slot', () => {
  assert.strictEqual(isSlotAllowedPath('/slot.html'), true);
  assert.strictEqual(isSlotAllowedPath('/slot.js'), true);
  assert.strictEqual(isSlotAllowedPath('/api/slot/message'), true);
  assert.strictEqual(isSlotAllowedPath('/api/slot/stream'), true);
  assert.strictEqual(isSlotAllowedPath('/api/slot/archived/abc'), true);
});

test('isSlotAllowedPath bloquea cualquier ruta preexistente de admin', () => {
  assert.strictEqual(isSlotAllowedPath('/'), false);
  assert.strictEqual(isSlotAllowedPath('/app.js'), false);
  assert.strictEqual(isSlotAllowedPath('/index.html'), false);
  assert.strictEqual(isSlotAllowedPath('/api/accounts/switch'), false);
  assert.strictEqual(isSlotAllowedPath('/api/conversations'), false);
  assert.strictEqual(isSlotAllowedPath('/api/restart'), false);
  assert.strictEqual(isSlotAllowedPath('/api/cleanup/delete'), false);
});

test('isSlotAllowedPath distingue el plural /api/slots (admin) del singular /api/slot/ (colaborador)', () => {
  assert.strictEqual(isSlotAllowedPath('/api/slots'), false);
  assert.strictEqual(isSlotAllowedPath('/api/slots/abc123/engine'), false);
});

// Hallazgo del re-review de la tanda de fixes: express.static resuelve ".."
// antes de servir, asi que un ".." (crudo o codificado) textualmente dentro
// del prefijo permitido no debia dejarse pasar.
test('isSlotAllowedPath rechaza .. crudo y codificado, aunque el texto matchee el prefijo permitido', () => {
  assert.strictEqual(isSlotAllowedPath('/api/slot/../../app.js'), false);
  assert.strictEqual(isSlotAllowedPath('/api/slot/%2e%2e/%2e%2e/app.js'), false);
  assert.strictEqual(isSlotAllowedPath('/api/slot/%2E%2E/admin-slots.js'), false);
});
