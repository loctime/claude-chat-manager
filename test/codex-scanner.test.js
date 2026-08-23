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

test('toChatMessages: extrae solo user_message y agent_message', () => {
  const entries = [
    { type: 'session_meta', payload: { session_id: 's1', cwd: 'C:\\x' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'hola' }, timestamp: 't1' },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'hola de vuelta' }, timestamp: 't2' },
    { type: 'event_msg', payload: { type: 'token_count' } }, // se ignora
  ];
  const msgs = scanner.toChatMessages(entries);
  assert.deepEqual(msgs, [
    { role: 'user', text: 'hola', ts: 't1' },
    { role: 'assistant', text: 'hola de vuelta', ts: 't2' },
  ]);
});

test('listSessions: camina AAAA/MM/DD y arma snippet + cwd desde session_meta', () => {
  const dir = makeTmpSessionsDir();
  writeRollout(dir, 'abc-123', [
    { type: 'session_meta', payload: { session_id: 'abc-123', cwd: 'C:\\Users\\User' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'primer mensaje de prueba' }, timestamp: '2026-08-22T00:00:01Z' },
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
  fs.writeFileSync(f, '{"type":"event_msg","payload":{"type":"user_message","message":"ok"},"timestamp":"t1"}\nno es json\n');
  const msgs = scanner.getMessages(f);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, 'ok');
  fs.rmSync(dir, { recursive: true, force: true });
});
