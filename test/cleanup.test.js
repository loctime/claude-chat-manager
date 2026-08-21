const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  listForCleanup, classifySession, isProtectedSession, RECENT_PROTECTION_MS,
} = require('../src/scanner');

function tmpProjectsDir() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-cleanup-'));
  const dir = path.join(base, '-home-x-demo');
  fs.mkdirSync(dir);
  return dir;
}

function writeSession(dir, id, lines) {
  fs.writeFileSync(path.join(dir, id + '.jsonl'), lines.join('\n'));
}

const userMsg = (text) => JSON.stringify({
  type: 'user', cwd: '/home/x/demo',
  timestamp: '2026-08-01T10:00:00.000Z', message: { role: 'user', content: text },
});
const assistantMsg = (text) => JSON.stringify({
  type: 'assistant', cwd: '/home/x/demo',
  timestamp: '2026-08-01T10:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const channelMsg = () => JSON.stringify({
  type: 'assistant', cwd: '/home/x/demo',
  timestamp: '2026-08-01T10:00:05.000Z',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'mcp__plugin_x__algo', input: {} }] },
});

test('listForCleanup incluye sesiones de canal y vacías (a diferencia de listSessions)', () => {
  const dir = tmpProjectsDir();
  writeSession(dir, 'canal-1', [userMsg('hola'), channelMsg()]);
  writeSession(dir, 'vacia-1', ['{"type":"summary","summary":"x"}']);
  writeSession(dir, 'normal-1', [userMsg('arreglame el login'), assistantMsg('dale')]);
  const out = listForCleanup(path.dirname(dir));
  const ids = out.map(s => s.sessionId).sort();
  assert.deepEqual(ids, ['canal-1', 'normal-1', 'vacia-1']);
  const canal = out.find(s => s.sessionId === 'canal-1');
  assert.equal(canal.isChannel, true);
  const normal = out.find(s => s.sessionId === 'normal-1');
  assert.equal(normal.isChannel, false);
  assert.equal(normal.messageCount, 2);
  assert.ok(normal.sizeBytes > 0);
});

test('classifySession: prioridad channel > app > trivial > orphan', () => {
  assert.equal(classifySession({ isChannel: true, messageCount: 10 }, { referencedAsApp: true }), 'channel');
  assert.equal(classifySession({ isChannel: false, messageCount: 10 }, { referencedAsApp: true }), 'app');
  assert.equal(classifySession({ isChannel: false, messageCount: 2 }, { referencedAsApp: false }), 'trivial');
  assert.equal(classifySession({ isChannel: false, messageCount: 3 }, { referencedAsApp: false }), 'orphan');
});

test('isProtectedSession: pinned/archived ganan aunque no esté corriendo ni sea reciente', () => {
  const vieja = { lastActivity: '2020-01-01T00:00:00.000Z' };
  const r1 = isProtectedSession(vieja, { conv: { archived: true }, running: false, now: Date.parse('2026-08-20') });
  assert.deepEqual(r1, { protected: true, reason: 'archived' });
  const r2 = isProtectedSession(vieja, { conv: { pinned: true }, running: false, now: Date.parse('2026-08-20') });
  assert.deepEqual(r2, { protected: true, reason: 'pinned' });
});

test('isProtectedSession: activa protege aunque sea vieja y sin conv', () => {
  const vieja = { lastActivity: '2020-01-01T00:00:00.000Z' };
  const r = isProtectedSession(vieja, { conv: null, running: true, now: Date.parse('2026-08-20') });
  assert.deepEqual(r, { protected: true, reason: 'running' });
});

test('isProtectedSession: frontera exacta de 5 días', () => {
  const now = Date.parse('2026-08-20T00:00:00.000Z');
  const justoAdentro = new Date(now - (RECENT_PROTECTION_MS - 1)).toISOString();
  const justoAfuera = new Date(now - RECENT_PROTECTION_MS).toISOString();
  assert.equal(isProtectedSession({ lastActivity: justoAdentro }, { conv: null, running: false, now }).protected, true);
  assert.equal(isProtectedSession({ lastActivity: justoAfuera }, { conv: null, running: false, now }).protected, false);
});

test('isProtectedSession: sin conv, sin running, vieja -> no protegida', () => {
  const r = isProtectedSession({ lastActivity: '2020-01-01T00:00:00.000Z' }, { conv: null, running: false, now: Date.parse('2026-08-20') });
  assert.deepEqual(r, { protected: false, reason: null });
});
