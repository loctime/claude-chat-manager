// test/notes.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { append, readAll, resolveDestName, ensureFilesDir } = require('../src/notes');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-notes-')), 'sub', 'notes.jsonl');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-notes-dir-'));

test('readAll devuelve [] si el archivo no existe', () => {
  assert.deepEqual(readAll('/no/existe/notes.jsonl'), []);
});

test('append crea el directorio y readAll lo lee de vuelta', () => {
  const file = tmpFile();
  const entry = { id: '1', ts: 1000, type: 'text', text: 'hola' };
  append(entry, file);
  assert.deepEqual(readAll(file), [entry]);
});

test('append es acumulativo: preserva el orden de inserción', () => {
  const file = tmpFile();
  const a = { id: '1', ts: 1000, type: 'text', text: 'primero' };
  const b = { id: '2', ts: 2000, type: 'text', text: 'segundo' };
  append(a, file);
  append(b, file);
  assert.deepEqual(readAll(file), [a, b]);
});

test('readAll saltea líneas corruptas sin tirar abajo el resto', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const good1 = { id: '1', ts: 1000, type: 'text', text: 'ok' };
  const good2 = { id: '2', ts: 2000, type: 'text', text: 'también ok' };
  fs.writeFileSync(file, JSON.stringify(good1) + '\n{ esto no es json }\n' + JSON.stringify(good2) + '\n');
  assert.deepEqual(readAll(file), [good1, good2]);
});

test('resolveDestName devuelve el nombre original si no hay colisión', () => {
  const dir = tmpDir();
  assert.equal(resolveDestName(dir, 'foto.jpg'), 'foto.jpg');
});

test('resolveDestName antepone timestamp si el nombre ya existe', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'foto.jpg'), 'x');
  const resolved = resolveDestName(dir, 'foto.jpg');
  assert.notEqual(resolved, 'foto.jpg');
  assert.match(resolved, /^\d+-foto\.jpg$/);
});

test('resolveDestName sanitiza separadores de path del nombre original', () => {
  const dir = tmpDir();
  assert.equal(resolveDestName(dir, '../../etc/passwd'), 'passwd');
});

test('ensureFilesDir crea el directorio si no existe', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-notes-ensure-')), 'Notas Jarvis');
  assert.ok(!fs.existsSync(dir));
  ensureFilesDir(dir);
  assert.ok(fs.existsSync(dir));
});
