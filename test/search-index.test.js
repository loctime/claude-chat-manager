const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openIndex, buildMatchExpr } = require('../src/search-index');

// ── Fixtures ──

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const userEntry = (text, ts = '2026-08-01T10:00:00.000Z', cwd = '/home/x/Proyectos/demo') => JSON.stringify({
  type: 'user', cwd, timestamp: ts, message: { role: 'user', content: text },
});
const assistantEntry = (content, ts = '2026-08-01T10:00:05.000Z', cwd = '/home/x/Proyectos/demo') => JSON.stringify({
  type: 'assistant', cwd, timestamp: ts, message: { role: 'assistant', content },
});
const toolEntry = (name, input, ts = '2026-08-01T10:00:03.000Z') => assistantEntry(
  [{ type: 'tool_use', id: 't1', name, input }], ts,
);

// Arma un projectsDir con { 'carpeta-proyecto': { 'sesion.jsonl': [líneas] } }
function makeProjects(spec) {
  const base = tmpDir('ccm-idx-proj-');
  for (const [dir, files] of Object.entries(spec)) {
    const dirPath = path.join(base, dir);
    fs.mkdirSync(dirPath, { recursive: true });
    for (const [file, lines] of Object.entries(files)) {
      fs.writeFileSync(path.join(dirPath, file), lines.join('\n') + '\n');
    }
  }
  return base;
}

// Arma un notebooksDir y devuelve la lista de libretas como la espera syncNotes
function makeNotebooks(spec) {
  const base = tmpDir('ccm-idx-notes-');
  const notebooks = [];
  for (const [id, nb] of Object.entries(spec)) {
    const file = path.join(base, id, 'notes.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, nb.entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    notebooks.push({ id, name: nb.name, file });
  }
  return notebooks;
}

const noteEntry = (text, ts = Date.parse('2026-08-01T10:00:00.000Z')) => ({
  id: 'n-' + ts, ts, type: 'text', text,
});

async function indexOf(projectsSpec, account = 'locti') {
  const idx = openIndex(':memory:');
  await idx.syncChats(makeProjects(projectsSpec), account);
  return idx;
}

// ── buildMatchExpr ──

test('buildMatchExpr limita a la columna body salvo que se pidan herramientas', () => {
  assert.match(buildMatchExpr('hola', false), /^\{body\}/);
  assert.match(buildMatchExpr('hola', true), /^\{body tools\}/);
});

test('buildMatchExpr aplica prefijo al último término (búsqueda mientras se tipea)', () => {
  assert.equal(buildMatchExpr('bug log', false), '{body} : ("bug" AND "log"*)');
});

test('buildMatchExpr neutraliza la sintaxis FTS del usuario en vez de romper', () => {
  // Comillas, paréntesis y operadores son sintaxis MATCH: sin sanitizar, tiran SQL error.
  assert.doesNotThrow(() => buildMatchExpr('foo" OR bar (NEAR baz)', false));
  assert.equal(buildMatchExpr('  ', false), null);
  assert.equal(buildMatchExpr('!!! ???', false), null);
});

// ── Indexado y búsqueda de chats ──

test('encuentra un mensaje del usuario y devuelve sesión, snippet y rol', async () => {
  const idx = await indexOf({
    '-home-x-Proyectos-demo': { 'aaaa-1111.jsonl': [userEntry('arreglame el login por favor')] },
  });
  const [r] = idx.search('login', { kind: 'chat', account: 'locti' });
  assert.equal(r.sessionId, 'aaaa-1111');
  assert.equal(r.role, 'user');
  assert.equal(r.cwd, '/home/x/Proyectos/demo');
  assert.match(r.snippet, /login/);
  idx.close();
});

test('encuentra texto del assistant, no solo del usuario', async () => {
  const idx = await indexOf({
    p: { 's1.jsonl': [userEntry('hola'), assistantEntry([{ type: 'text', text: 'el deploy quedó andando' }])] },
  });
  const hits = idx.search('deploy', { kind: 'chat', account: 'locti' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].role, 'assistant');
  idx.close();
});

// El bug reportado: el buscador viejo comparaba substrings crudos, así que
// "facil" nunca encontraba "fácil" (ni al revés) — en español falla seguido.
test('ignora tildes en los dos sentidos', async () => {
  const idx = await indexOf({
    p: { 's1.jsonl': [userEntry('esto es muy fácil de resolver')] },
    q: { 's2.jsonl': [userEntry('la configuracion del server')] },
  });
  assert.equal(idx.search('facil', { kind: 'chat', account: 'locti' }).length, 1);
  assert.equal(idx.search('fácil', { kind: 'chat', account: 'locti' }).length, 1);
  assert.equal(idx.search('configuración', { kind: 'chat', account: 'locti' }).length, 1);
  idx.close();
});

test('ignora mayúsculas', async () => {
  const idx = await indexOf({ p: { 's1.jsonl': [userEntry('El Deploy de Producción')] } });
  assert.equal(idx.search('DEPLOY', { kind: 'chat', account: 'locti' }).length, 1);
  idx.close();
});

test('varios términos exigen que estén todos (AND), no cualquiera', async () => {
  const idx = await indexOf({
    p: { 's1.jsonl': [userEntry('el bug del login')] },
    q: { 's2.jsonl': [userEntry('el bug del deploy')] },
  });
  const hits = idx.search('bug login', { kind: 'chat', account: 'locti' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionId, 's1');
  idx.close();
});

// El otro bug de fondo: el scan viejo cortaba en `limit` mientras recorría las
// carpetas en orden de filesystem, así que un match en una carpeta tardía podía
// no aparecer nunca aunque fuera el mejor resultado. Con índice, el ranking es
// global y recién ahí se corta.
test('el límite corta después de rankear todo, no mientras recorre carpetas', async () => {
  const spec = {};
  for (let i = 0; i < 8; i++) {
    spec['proj-' + i] = { [`s${i}.jsonl`]: [userEntry('bug reportado', '2026-01-0' + (i + 1) + 'T10:00:00.000Z')] };
  }
  // El más reciente vive en la carpeta que se recorre última.
  spec['zzz-ultimo'] = { 'reciente.jsonl': [userEntry('bug reportado', '2026-08-15T10:00:00.000Z')] };
  const idx = await indexOf(spec);

  const top = idx.search('bug', { kind: 'chat', account: 'locti', limit: 2 });
  assert.equal(top.length, 2);
  assert.ok(top.some(r => r.sessionId === 'reciente'), 'el match más reciente tiene que entrar en el top pese a estar en la última carpeta');
  idx.close();
});

test('con relevancia pareja, lo más reciente rankea primero', async () => {
  const idx = await indexOf({
    p: { 'viejo.jsonl': [userEntry('rompecoco puntajes', '2026-01-01T10:00:00.000Z')] },
    q: { 'nuevo.jsonl': [userEntry('rompecoco puntajes', '2026-08-14T10:00:00.000Z')] },
  });
  const hits = idx.search('rompecoco', { kind: 'chat', account: 'locti' });
  assert.equal(hits[0].sessionId, 'nuevo');
  idx.close();
});

test('matchIndex apunta al mensaje real dentro de la conversación', async () => {
  const idx = await indexOf({
    p: {
      's1.jsonl': [
        userEntry('primero'),
        assistantEntry([{ type: 'text', text: 'segundo' }]),
        userEntry('tercero con la aguja'),
      ],
    },
  });
  const [r] = idx.search('aguja', { kind: 'chat', account: 'locti' });
  assert.equal(r.matchIndex, 2);
  idx.close();
});

test('no indexa sesiones de canal ni archivos sin mensajes', async () => {
  const idx = await indexOf({
    p: {
      'canal.jsonl': [assistantEntry([{ type: 'tool_use', id: 'x', name: 'mcp__plugin_telegram__send', input: { text: 'zanahoria' } }])],
      'vacio.jsonl': ['{"type":"summary","summary":"zanahoria"}'],
    },
  });
  assert.equal(idx.search('zanahoria', { kind: 'chat', account: 'locti', includeTools: true }).length, 0);
  idx.close();
});

// ── Filtro de herramientas ──

test('las herramientas quedan fuera por defecto y aparecen con includeTools', async () => {
  const idx = await indexOf({
    p: { 's1.jsonl': [userEntry('mirá esto'), toolEntry('Bash', { command: 'npm run migracion-postgres' })] },
  });
  assert.equal(idx.search('migracion-postgres', { kind: 'chat', account: 'locti' }).length, 0);
  const conTools = idx.search('migracion-postgres', { kind: 'chat', account: 'locti', includeTools: true });
  assert.equal(conTools.length, 1);
  assert.equal(conTools[0].role, 'tool');
  idx.close();
});

test('includeTools no tapa los resultados de mensajes normales', async () => {
  const idx = await indexOf({
    p: { 's1.jsonl': [userEntry('corré la migracion'), toolEntry('Bash', { command: 'npm run migracion' })] },
  });
  const hits = idx.search('migracion', { kind: 'chat', account: 'locti', includeTools: true });
  assert.equal(hits.length, 2);
  idx.close();
});

// ── Sincronización incremental ──

test('reindexa un archivo modificado sin duplicar sus mensajes', async () => {
  const base = makeProjects({ p: { 's1.jsonl': [userEntry('mensaje original')] } });
  const file = path.join(base, 'p', 's1.jsonl');
  const idx = openIndex(':memory:');
  await idx.syncChats(base, 'locti');
  assert.equal(idx.search('original', { kind: 'chat', account: 'locti' }).length, 1);

  fs.appendFileSync(file, userEntry('mensaje agregado despues') + '\n');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 2000));
  await idx.syncChats(base, 'locti');

  assert.equal(idx.search('original', { kind: 'chat', account: 'locti' }).length, 1, 'no debe duplicarse');
  assert.equal(idx.search('agregado', { kind: 'chat', account: 'locti' }).length, 1, 'lo nuevo debe estar');
  idx.close();
});

test('un sync sin cambios no re-parsea archivos', async () => {
  const base = makeProjects({ p: { 's1.jsonl': [userEntry('hola')] } });
  const idx = openIndex(':memory:');
  const first = await idx.syncChats(base, 'locti');
  const second = await idx.syncChats(base, 'locti');
  assert.equal(first.indexed, 1);
  assert.equal(second.indexed, 0);
  assert.equal(second.skipped, 1);
  idx.close();
});

test('saca del índice las sesiones borradas del disco', async () => {
  const base = makeProjects({ p: { 's1.jsonl': [userEntry('efimero')], 's2.jsonl': [userEntry('persistente')] } });
  const idx = openIndex(':memory:');
  await idx.syncChats(base, 'locti');
  fs.unlinkSync(path.join(base, 'p', 's1.jsonl'));
  const res = await idx.syncChats(base, 'locti');

  assert.equal(res.removed, 1);
  assert.equal(idx.search('efimero', { kind: 'chat', account: 'locti' }).length, 0);
  assert.equal(idx.search('persistente', { kind: 'chat', account: 'locti' }).length, 1);
  idx.close();
});

// ── Notas ──

test('indexa notas y las devuelve con su libreta', async () => {
  const idx = openIndex(':memory:');
  await idx.syncNotes(makeNotebooks({
    'nb-1': { name: 'Ideas', entries: [noteEntry('comprar dominio para el marketplace')] },
  }), 'locti');

  const [r] = idx.search('dominio', { kind: 'note', account: 'locti' });
  assert.equal(r.refId, 'nb-1');
  assert.equal(r.name, 'Ideas');
  assert.equal(r.role, 'note');
  assert.match(r.snippet, /dominio/);
  idx.close();
});

test('las notas adjuntas se indexan por nombre de archivo', async () => {
  const idx = openIndex(':memory:');
  await idx.syncNotes(makeNotebooks({
    'nb-1': { name: 'Ideas', entries: [{ id: 'f1', ts: Date.now(), type: 'file', fileName: 'presupuesto-maximia.pdf' }] },
  }), 'locti');
  assert.equal(idx.search('maximia', { kind: 'note', account: 'locti' }).length, 1);
  idx.close();
});

// El scope pedido: parado en chats busca chats, parado en libretas busca notas.
test('el scope aísla chats de notas', async () => {
  const idx = openIndex(':memory:');
  await idx.syncChats(makeProjects({ p: { 's1.jsonl': [userEntry('presupuesto del chat')] } }), 'locti');
  await idx.syncNotes(makeNotebooks({
    'nb-1': { name: 'Ideas', entries: [noteEntry('presupuesto de la nota')] },
  }), 'locti');

  const chats = idx.search('presupuesto', { kind: 'chat', account: 'locti' });
  const notas = idx.search('presupuesto', { kind: 'note', account: 'locti' });
  assert.equal(chats.length, 1);
  assert.equal(notas.length, 1);
  assert.match(chats[0].snippet, /del chat/);
  assert.match(notas[0].snippet, /de la nota/);
  idx.close();
});

// ── Multi-cuenta ──

test('cada cuenta ve solo sus propias sesiones', async () => {
  const idx = openIndex(':memory:');
  await idx.syncChats(makeProjects({ p: { 'a.jsonl': [userEntry('secreto de locti')] } }), 'locti');
  await idx.syncChats(makeProjects({ p: { 'b.jsonl': [userEntry('secreto de fernando')] } }), 'fernando');

  assert.equal(idx.search('secreto', { kind: 'chat', account: 'locti' }).length, 1);
  assert.equal(idx.search('secreto', { kind: 'chat', account: 'fernando' })[0].sessionId, 'b');
  idx.close();
});

test('sincronizar una cuenta no borra el índice de la otra', async () => {
  const idx = openIndex(':memory:');
  const baseLocti = makeProjects({ p: { 'a.jsonl': [userEntry('cosa de locti')] } });
  await idx.syncChats(baseLocti, 'locti');
  await idx.syncChats(makeProjects({ p: { 'b.jsonl': [userEntry('cosa de fernando')] } }), 'fernando');
  await idx.syncChats(baseLocti, 'locti');

  assert.equal(idx.search('cosa', { kind: 'chat', account: 'fernando' }).length, 1);
  idx.close();
});

// ── Snippet ──

test('el snippet marca el término encontrado aunque difiera en tildes', async () => {
  const idx = await indexOf({ p: { 's1.jsonl': [userEntry('esto es muy fácil de resolver')] } });
  const [r] = idx.search('facil', { kind: 'chat', account: 'locti' });
  assert.ok(r.snippet.includes('fácil'), `snippet sin marcas: ${JSON.stringify(r.snippet)}`);
  idx.close();
});

test('búsqueda vacía o sin términos válidos devuelve vacío', async () => {
  const idx = await indexOf({ p: { 's1.jsonl': [userEntry('hola')] } });
  assert.deepEqual(idx.search('', { kind: 'chat', account: 'locti' }), []);
  assert.deepEqual(idx.search('   ', { kind: 'chat', account: 'locti' }), []);
  idx.close();
});

// El borrado por rango de rowid asume que las filas de cada archivo son
// contiguas. Si esa suposición se rompiera, reindexar un archivo del medio se
// llevaría puestas filas de sus vecinos — este test es el que lo detectaría.
test('reindexar un archivo no toca las filas de los demás', async () => {
  const base = makeProjects({
    p: {
      'uno.jsonl': [userEntry('alfa vecino de arriba')],
      'dos.jsonl': [userEntry('beta el del medio')],
      'tres.jsonl': [userEntry('gamma vecino de abajo')],
    },
  });
  const idx = openIndex(':memory:');
  await idx.syncChats(base, 'locti');

  const medio = path.join(base, 'p', 'dos.jsonl');
  fs.writeFileSync(medio, userEntry('beta reescrito por completo') + '\n');
  fs.utimesSync(medio, new Date(), new Date(Date.now() + 2000));
  await idx.syncChats(base, 'locti');

  const buscar = q => idx.search(q, { kind: 'chat', account: 'locti' }).length;
  assert.equal(buscar('alfa'), 1, 'el vecino de arriba tiene que seguir indexado');
  assert.equal(buscar('gamma'), 1, 'el vecino de abajo tiene que seguir indexado');
  assert.equal(buscar('beta'), 1, 'el reescrito tiene que estar una sola vez');
  assert.equal(buscar('medio'), 0, 'el contenido viejo del reescrito tiene que desaparecer');
  idx.close();
});

test('un archivo reindexado dos veces no deja filas huérfanas', async () => {
  const base = makeProjects({ p: { 'a.jsonl': [userEntry('version uno')] } });
  const file = path.join(base, 'p', 'a.jsonl');
  const idx = openIndex(':memory:');
  await idx.syncChats(base, 'locti');
  for (const texto of ['version dos', 'version tres']) {
    fs.writeFileSync(file, userEntry(texto) + '\n');
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    await idx.syncChats(base, 'locti');
  }
  assert.equal(idx.search('version', { kind: 'chat', account: 'locti' }).length, 1);
  assert.equal(idx.search('uno', { kind: 'chat', account: 'locti' }).length, 0);
  assert.equal(idx.search('tres', { kind: 'chat', account: 'locti' }).length, 1);
  idx.close();
});
