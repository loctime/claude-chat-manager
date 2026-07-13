const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseJsonl, sessionInfo, listSessions, toChatMessages, findSessionFile } = require('../src/scanner');

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
