const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  append, readAll, resolveDestName, ensureFilesDir,
  listNotebooks, createNotebook, renameNotebook, hideNotebook, getNotebook,
  notebookNotesFile, nextDefaultName, DEFAULT_NAME_RE,
} = require('../src/notes');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-notes-')), 'sub', 'notes.jsonl');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-notes-dir-'));
const tmpIndexFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-notebooks-')), 'notebooks.json');
const tmpNotebooksDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-notebooks-dir-'));

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

test('listNotebooks devuelve [] si no hay índice todavía', () => {
  assert.deepEqual(listNotebooks(tmpIndexFile(), tmpNotebooksDir()), []);
});

test('createNotebook arma el primer nombre default y lo persiste', () => {
  const indexFile = tmpIndexFile();
  const nb = createNotebook(indexFile);
  assert.equal(nb.name, 'Nueva libreta');
  assert.ok(nb.id);
  assert.ok(nb.createdAt);
  const list = listNotebooks(indexFile, tmpNotebooksDir());
  assert.equal(list.length, 1);
  assert.equal(list[0].id, nb.id);
});

test('createNotebook numera libretas default sucesivas para no chocar de nombre', () => {
  const indexFile = tmpIndexFile();
  const a = createNotebook(indexFile);
  const b = createNotebook(indexFile);
  const c = createNotebook(indexFile);
  assert.equal(a.name, 'Nueva libreta');
  assert.equal(b.name, 'Nueva libreta 2');
  assert.equal(c.name, 'Nueva libreta 3');
});

test('renameNotebook actualiza el nombre y devuelve la entrada actualizada', () => {
  const indexFile = tmpIndexFile();
  const nb = createNotebook(indexFile);
  const renamed = renameNotebook(nb.id, 'Recetas', indexFile);
  assert.equal(renamed.name, 'Recetas');
  assert.equal(getNotebook(nb.id, indexFile).name, 'Recetas');
});

test('renameNotebook devuelve null si el id no existe', () => {
  const indexFile = tmpIndexFile();
  assert.equal(renameNotebook('no-existe', 'x', indexFile), null);
});

test('getNotebook devuelve null si el id no existe', () => {
  assert.equal(getNotebook('no-existe', tmpIndexFile()), null);
});

test('hideNotebook marca hidden y devuelve la entrada actualizada', () => {
  const indexFile = tmpIndexFile();
  const nb = createNotebook(indexFile);
  const hidden = hideNotebook(nb.id, true, indexFile);
  assert.equal(hidden.hidden, true);
  assert.equal(getNotebook(nb.id, indexFile).hidden, true);
});

test('hideNotebook devuelve null si el id no existe', () => {
  assert.equal(hideNotebook('no-existe', true, tmpIndexFile()), null);
});

test('hideNotebook(false) revierte la ocultación', () => {
  const indexFile = tmpIndexFile();
  const nb = createNotebook(indexFile);
  hideNotebook(nb.id, true, indexFile);
  hideNotebook(nb.id, false, indexFile);
  assert.equal(getNotebook(nb.id, indexFile).hidden, false);
});

test('listNotebooks no incluye libretas ocultas', () => {
  const indexFile = tmpIndexFile();
  const notebooksDir = tmpNotebooksDir();
  const a = createNotebook(indexFile);
  const b = createNotebook(indexFile);
  hideNotebook(a.id, true, indexFile);
  const list = listNotebooks(indexFile, notebooksDir);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, b.id);
});

test('listNotebooks calcula lastActivity desde la última nota de cada libreta', () => {
  const indexFile = tmpIndexFile();
  const notebooksDir = tmpNotebooksDir();
  const nb = createNotebook(indexFile);
  const file = notebookNotesFile(nb.id, notebooksDir);
  append({ id: '1', ts: 1000, type: 'text', text: 'a' }, file);
  append({ id: '2', ts: 5000, type: 'text', text: 'b' }, file);
  const [entry] = listNotebooks(indexFile, notebooksDir);
  assert.equal(entry.lastActivity, 5000);
});

test('listNotebooks usa createdAt como lastActivity si la libreta todavía no tiene notas', () => {
  const indexFile = tmpIndexFile();
  const nb = createNotebook(indexFile);
  const [entry] = listNotebooks(indexFile, tmpNotebooksDir());
  assert.equal(entry.lastActivity, nb.createdAt);
});

test('nextDefaultName arma el primer nombre libre entre libretas ya default', () => {
  assert.equal(nextDefaultName([]), 'Nueva libreta');
  assert.equal(nextDefaultName(['Nueva libreta']), 'Nueva libreta 2');
  assert.equal(nextDefaultName(['Nueva libreta', 'Nueva libreta 2']), 'Nueva libreta 3');
  assert.equal(nextDefaultName(['Recetas']), 'Nueva libreta');
});

test('DEFAULT_NAME_RE matchea nombres default y no matchea nombres puestos a mano', () => {
  assert.ok(DEFAULT_NAME_RE.test('Nueva libreta'));
  assert.ok(DEFAULT_NAME_RE.test('Nueva libreta 12'));
  assert.ok(!DEFAULT_NAME_RE.test('Recetas'));
  assert.ok(!DEFAULT_NAME_RE.test('Nueva libretas'));
});

test('notebookNotesFile arma la ruta jsonl de una libreta dentro de su propio directorio', () => {
  const dir = tmpNotebooksDir();
  const file = notebookNotesFile('abc-123', dir);
  assert.equal(file, path.join(dir, 'abc-123', 'notes.jsonl'));
});
