const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseJsonl, sessionInfo, listSessions, toChatMessages, findSessionFile, getMessagesIncremental, sumUsage, _clearSessionInfoCache, _clearTailCache } = require('../src/scanner');

function tmpFile(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-'));
  const file = path.join(dir, 'aaaa-1111.jsonl');
  fs.writeFileSync(file, lines.join('\n'));
  return { dir, file };
}

const userEntry = (text, extra = {}) => JSON.stringify({
  type: 'user', cwd: '/home/loctime/Proyectos/demo', sessionId: 'aaaa-1111',
  timestamp: '2026-07-12T10:00:00.000Z', message: { role: 'user', content: text }, ...extra,
});
const assistantEntry = (content) => JSON.stringify({
  type: 'assistant', cwd: '/home/loctime/Proyectos/demo', sessionId: 'aaaa-1111',
  timestamp: '2026-07-12T10:00:05.000Z', message: { role: 'assistant', content },
});

test('parseJsonl saltea líneas corruptas y vacías', () => {
  const { file } = tmpFile([userEntry('hola'), '{{{roto', '', assistantEntry([{ type: 'text', text: 'buenas' }])]);
  const entries = parseJsonl(file);
  assert.equal(entries.length, 2);
});

test('parseJsonl devuelve [] si el archivo no existe', () => {
  assert.deepEqual(parseJsonl('/no/existe.jsonl'), []);
});

test('sessionInfo extrae snippet, cwd y messageCount', () => {
  const { file } = tmpFile([userEntry('arreglame el bug del login por favor'), assistantEntry([{ type: 'text', text: 'dale' }])]);
  const info = sessionInfo(file);
  assert.equal(info.sessionId, 'aaaa-1111');
  assert.equal(info.cwd, '/home/loctime/Proyectos/demo');
  assert.ok(info.snippet.startsWith('arreglame el bug'));
  assert.equal(info.messageCount, 2);
});

test('sessionInfo devuelve null para archivo sin mensajes', () => {
  const { file } = tmpFile(['{"type":"summary","summary":"x"}']);
  assert.equal(sessionInfo(file), null);
});

test('listSessions recorre subdirectorios de projectsDir', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-projects-'));
  const projDir = path.join(base, '-home-loctime-Proyectos-demo');
  fs.mkdirSync(projDir);
  fs.writeFileSync(path.join(projDir, 'bbbb-2222.jsonl'), userEntry('hola'));
  const sessions = listSessions(base);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, 'bbbb-2222');
});

test('findSessionFile encuentra el path por sessionId', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-find-'));
  const projDir = path.join(base, '-home-x');
  fs.mkdirSync(projDir);
  fs.writeFileSync(path.join(projDir, 'cccc-3333.jsonl'), userEntry('hola'));
  assert.equal(findSessionFile('cccc-3333', base), path.join(projDir, 'cccc-3333.jsonl'));
  assert.equal(findSessionFile('zzzz', base), null);
});

test('toChatMessages arma burbujas y tool calls con su output', () => {
  const entries = [
    JSON.parse(userEntry('corré los tests')),
    JSON.parse(assistantEntry([
      { type: 'text', text: 'Voy a correrlos.' },
      { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } },
    ])),
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '5 passing' }] } },
    JSON.parse(assistantEntry([{ type: 'text', text: 'Todo verde.' }])),
  ];
  const msgs = toChatMessages(entries);
  assert.deepEqual(msgs.map(m => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(msgs[2].name, 'Bash');
  assert.equal(msgs[2].output, '5 passing');
});

test('toChatMessages ignora entradas meta y tool_results como mensajes de usuario', () => {
  const entries = [
    { type: 'user', isMeta: true, message: { role: 'user', content: 'meta interna' } },
    JSON.parse(userEntry('hola')),
  ];
  const msgs = toChatMessages(entries);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, 'hola');
});

test('sessionInfo cachea por mtime: dos llamadas consecutivas devuelven el mismo objeto', () => {
  _clearSessionInfoCache();
  const { file } = tmpFile([userEntry('primer mensaje')]);
  const info1 = sessionInfo(file);
  const info2 = sessionInfo(file);
  assert.equal(info1.messageCount, 1);
  // identidad de referencia: si vino del cache es el mismo objeto
  assert.strictEqual(info2, info1, 'debería venir del cache (misma referencia)');
});

test('sessionInfo invalida el cache cuando cambia mtime', () => {
  _clearSessionInfoCache();
  const { file } = tmpFile([userEntry('uno')]);
  assert.equal(sessionInfo(file).messageCount, 1);

  // Reescribir con 2 mensajes y forzar mtime nuevo
  fs.writeFileSync(file, [userEntry('uno'), assistantEntry([{ type: 'text', text: 'dos' }])].join('\n'));
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(file, future, future);

  assert.equal(sessionInfo(file).messageCount, 2);
});

test('sessionInfo cachea también resultados null (sin mensajes) para no re-parsear basura', () => {
  _clearSessionInfoCache();
  const { file } = tmpFile(['{"type":"summary","summary":"x"}']);
  assert.equal(sessionInfo(file), null);
  // No cambio el archivo — segunda llamada debe salir del cache y seguir siendo null
  assert.equal(sessionInfo(file), null);
});

test('sessionInfo devuelve null y limpia cache si el archivo desaparece', () => {
  _clearSessionInfoCache();
  const { file } = tmpFile([userEntry('borrame')]);
  assert.equal(sessionInfo(file).messageCount, 1);
  fs.unlinkSync(file);
  assert.equal(sessionInfo(file), null);
});

test('getMessagesIncremental lee todo la primera vez', () => {
  _clearTailCache();
  const { file } = tmpFile([userEntry('hola'), assistantEntry([{ type: 'text', text: 'hey' }])]);
  const msgs = getMessagesIncremental(file);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[1].role, 'assistant');
});

test('getMessagesIncremental sólo parsea el sufijo nuevo al appendear al archivo', () => {
  _clearTailCache();
  const { file } = tmpFile([userEntry('hola')]);
  assert.equal(getMessagesIncremental(file).length, 1);

  // Append de una línea nueva
  fs.appendFileSync(file, '\n' + assistantEntry([{ type: 'text', text: 'nueva' }]));
  // Forzar mtime distinto para que se dispare la relectura
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(file, future, future);

  const msgs = getMessagesIncremental(file);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].text, 'nueva');
});

test('getMessagesIncremental invalida el cache si el archivo se achica (truncate/rewrite)', () => {
  _clearTailCache();
  const { file } = tmpFile([userEntry('viejo1'), userEntry('viejo2'), userEntry('viejo3')]);
  assert.equal(getMessagesIncremental(file).length, 3);

  // Reescribir con menos contenido (simula que Claude Code truncó/reescribió el archivo)
  fs.writeFileSync(file, userEntry('flamante'));
  const msgs = getMessagesIncremental(file);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, 'flamante');
});

test('getMessagesIncremental es idempotente si nada cambió (misma referencia en toChatMessages)', () => {
  _clearTailCache();
  const { file } = tmpFile([userEntry('idle')]);
  const m1 = getMessagesIncremental(file);
  const m2 = getMessagesIncremental(file);
  assert.deepEqual(m1, m2);
});

test('getMessagesIncremental devuelve [] si el archivo no existe', () => {
  _clearTailCache();
  assert.deepEqual(getMessagesIncremental('/no/existe.jsonl'), []);
});

test('sumUsage acumula tokens por modelo y en total', () => {
  const entries = [
    { type: 'assistant', message: { model: 'claude-opus-4-7', usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 100, cache_read_input_tokens: 200 } } },
    { type: 'assistant', message: { model: 'claude-opus-4-7', usage: { input_tokens: 5,  output_tokens: 15, cache_creation_input_tokens: 50,  cache_read_input_tokens: 100 } } },
    { type: 'assistant', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    { type: 'user', message: { content: 'ignorame' } }, // no debe sumar
  ];
  const u = sumUsage(entries);
  assert.deepEqual(u.total, { input: 16, output: 37, cacheCreate: 150, cacheRead: 300 });
  assert.deepEqual(u.byModel['claude-opus-4-7'], { input: 15, output: 35, cacheCreate: 150, cacheRead: 300 });
  assert.deepEqual(u.byModel['claude-sonnet-4-6'], { input: 1, output: 2, cacheCreate: 0, cacheRead: 0 });
});

test('sumUsage devuelve ceros si no hay usage events', () => {
  const u = sumUsage([{ type: 'user', message: { content: 'hola' } }]);
  assert.deepEqual(u.total, { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 });
  assert.deepEqual(u.byModel, {});
});

test('sessionInfo incluye usage acumulado', () => {
  _clearSessionInfoCache();
  const usageLine = JSON.stringify({
    type: 'assistant',
    cwd: '/x',
    timestamp: '2026-07-13T10:00:00.000Z',
    message: { role: 'assistant', model: 'claude-opus-4-7', content: [{ type: 'text', text: 'ok' }],
               usage: { input_tokens: 7, output_tokens: 11, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  });
  const { file } = tmpFile([userEntry('hola'), usageLine]);
  const info = sessionInfo(file);
  assert.ok(info.usage);
  assert.equal(info.usage.total.input, 7);
  assert.equal(info.usage.total.output, 11);
});
