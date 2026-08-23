// test/codex-scanner.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const scanner = require('../src/codex-scanner');

function makeTmpSessionsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-scanner-test-'));
}

function writeRollout(sessionsDir, sessionId, lines) {
  const dir = path.join(sessionsDir, '2026', '08', '22');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-08-22T00-00-00-${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

// Helper: arma un response_item/message tal como lo persiste Codex CLI de verdad
// (verificado en vivo, cli_version 0.149.0) — no el event_msg/user_message que
// tenía este test antes de confirmarlo contra un rollout real.
function msgItem(role, text, ts) {
  return {
    type: 'response_item',
    payload: { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] },
    timestamp: ts,
  };
}

test('toChatMessages: extrae solo response_item/message de role user/assistant', () => {
  const entries = [
    { type: 'session_meta', payload: { session_id: 's1', cwd: 'C:\\x' } },
    { type: 'event_msg', payload: { type: 'task_started' } }, // se ignora
    msgItem('user', 'hola', 't1'),
    msgItem('assistant', 'hola de vuelta', 't2'),
    { type: 'event_msg', payload: { type: 'token_count' } }, // se ignora
  ];
  const msgs = scanner.toChatMessages(entries);
  assert.deepEqual(msgs, [
    { role: 'user', text: 'hola', ts: 't1' },
    { role: 'assistant', text: 'hola de vuelta', ts: 't2' },
  ]);
});

test('toChatMessages: descarta el mensaje "user" de contexto que inyecta el CLI al arrancar la sesión', () => {
  const entries = [
    {
      type: 'response_item',
      payload: {
        type: 'message', role: 'user',
        content: [
          { type: 'input_text', text: '<recommended_plugins>\n...\n</recommended_plugins>' },
          { type: 'input_text', text: '# AGENTS.md instructions\n...' },
          { type: 'input_text', text: '<environment_context>...</environment_context>' },
        ],
      },
      timestamp: 't0',
    },
    msgItem('user', 'primer mensaje real', 't1'),
  ];
  const msgs = scanner.toChatMessages(entries);
  assert.deepEqual(msgs, [{ role: 'user', text: 'primer mensaje real', ts: 't1' }]);
});

test('toChatMessages: descarta el mensaje "developer" (prompt de sistema completo)', () => {
  const entries = [
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'sos Codex...' }] }, timestamp: 't0' },
    msgItem('user', 'hola', 't1'),
  ];
  const msgs = scanner.toChatMessages(entries);
  assert.deepEqual(msgs, [{ role: 'user', text: 'hola', ts: 't1' }]);
});

test('toChatMessages: corta el AVISO INFRAESTRUCTURA que codex-runner.js agrega a cada mensaje real', () => {
  const entries = [
    msgItem('user', 'respondé OK\n\nAVISO INFRAESTRUCTURA: te está ejecutando claude-chat-manager...\n\nCONTRATO DE RUTAS EN ESTE CHAT: ...', 't1'),
  ];
  const msgs = scanner.toChatMessages(entries);
  assert.deepEqual(msgs, [{ role: 'user', text: 'respondé OK', ts: 't1' }]);
});

test('listSessions: camina AAAA/MM/DD y arma snippet + cwd desde session_meta', () => {
  const dir = makeTmpSessionsDir();
  writeRollout(dir, 'abc-123', [
    { type: 'session_meta', payload: { session_id: 'abc-123', cwd: 'C:\\Users\\User' } },
    msgItem('user', 'primer mensaje de prueba', '2026-08-22T00:00:01Z'),
  ]);
  scanner._clearSessionInfoCache();
  const sessions = scanner.listSessions(dir);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, 'abc-123');
  assert.equal(sessions[0].cwd, 'C:\\Users\\User');
  assert.equal(sessions[0].snippet, 'primer mensaje de prueba');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('findSessionFile: matchea por sufijo del nombre de archivo', () => {
  const dir = makeTmpSessionsDir();
  const file = writeRollout(dir, 'xyz-789', [{ type: 'session_meta', payload: { session_id: 'xyz-789', cwd: 'C:\\p' } }]);
  assert.equal(scanner.findSessionFile('xyz-789', dir), file);
  assert.equal(scanner.findSessionFile('no-existe', dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getMessages: una línea corrupta no tira abajo el resto', () => {
  const dir = makeTmpSessionsDir();
  const file = path.join(dir, '2026', '08', '22');
  fs.mkdirSync(file, { recursive: true });
  const f = path.join(file, 'rollout-2026-08-22T00-00-00-corrupt-1.jsonl');
  fs.writeFileSync(f, JSON.stringify(msgItem('user', 'ok', 't1')) + '\nno es json\n');
  const msgs = scanner.getMessages(f);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, 'ok');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listSessions: session_meta sin payload no crashea', () => {
  const dir = makeTmpSessionsDir();
  writeRollout(dir, 'broken-1', [
    { type: 'session_meta' }, // sin payload: guard defensivo lo salta
    msgItem('user', 'mensaje de prueba', '2026-08-22T00:00:01Z'),
  ]);
  scanner._clearSessionInfoCache();
  const sessions = scanner.listSessions(dir);
  assert.equal(sessions.length, 1);
  // sin session_meta válido, usa fallback: sessionId de nombre de archivo
  assert.match(sessions[0].sessionId, /broken-1/);
  assert.equal(sessions[0].cwd, null); // sin session_meta válido, cwd es null
  assert.equal(sessions[0].snippet, 'mensaje de prueba');
  fs.rmSync(dir, { recursive: true, force: true });
});
