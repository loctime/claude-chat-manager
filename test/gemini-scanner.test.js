const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  cleanUserText,
  normalizeArgs,
  toChatMessages,
  findSessionTranscript,
  getMessages,
  sessionInfo,
  _clearSessionInfoCache,
} = require('../src/gemini-scanner');

test('cleanUserText: extrae el texto limpio removiendo USER_REQUEST y avisos de infraestructura', () => {
  const raw = `<USER_REQUEST>
conoces claude-chat-manager?

CONTEXTO JARVIS COMPARTIDO: sos un asistente que trabaja en la PC de Diego Bertosi junto a Claude Code.
AVISO INFRAESTRUCTURA: te está ejecutando claude-chat-manager en 127.0.0.1:3777.
CONTRATO DE RUTAS EN ESTE CHAT: cuando compartas un archivo...
</USER_REQUEST>`;

  assert.strictEqual(cleanUserText(raw), 'conoces claude-chat-manager?');
  assert.strictEqual(cleanUserText('hola como estas?'), 'hola como estas?');
  assert.strictEqual(cleanUserText(null), '');
});

test('normalizeArgs: parsea strings JSON anidados en argumentos de herramientas', () => {
  const args = {
    AbsolutePath: '"C:\\\\Users\\\\User\\\\CLAUDE.md"',
    num: 123,
    plain: 'simple',
  };
  const normalized = normalizeArgs(args);
  assert.strictEqual(normalized.AbsolutePath, 'C:\\Users\\User\\CLAUDE.md');
  assert.strictEqual(normalized.num, 123);
  assert.strictEqual(normalized.plain, 'simple');
});

test('toChatMessages: traduce steps de transcript en formato estándar de mensajes y herramientas', () => {
  const entries = [
    {
      step_index: 0,
      type: 'USER_INPUT',
      created_at: '2026-09-14T18:00:00Z',
      content: '<USER_REQUEST>\nque hora es?\n\nCONTEXTO JARVIS COMPARTIDO: ...\n</USER_REQUEST>',
    },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-09-14T18:00:01Z',
      tool_calls: [
        {
          name: 'run_command',
          args: { CommandLine: '"time /t"' },
        },
      ],
    },
    {
      step_index: 2,
      type: 'GENERIC',
      created_at: '2026-09-14T18:00:02Z',
      content: '18:00',
    },
    {
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-09-14T18:00:03Z',
      content: 'Son las 18:00 hs.',
    },
  ];

  const messages = toChatMessages(entries);
  assert.strictEqual(messages.length, 3);
  assert.deepStrictEqual(messages[0], {
    role: 'user',
    text: 'que hora es?',
    ts: '2026-09-14T18:00:00Z',
  });
  assert.deepStrictEqual(messages[1], {
    role: 'tool',
    name: 'run_command',
    input: { CommandLine: 'time /t' },
    output: '18:00',
    ts: '2026-09-14T18:00:01Z',
  });
  assert.deepStrictEqual(messages[2], {
    role: 'assistant',
    text: 'Son las 18:00 hs.',
    ts: '2026-09-14T18:00:03Z',
  });
});

test('findSessionTranscript y getMessages leen desde directorio mock', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-scanner-test-'));
  const sessionId = 'test-session-123';
  const logsDir = path.join(tmp, 'brain', sessionId, '.system_generated', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const transcriptFile = path.join(logsDir, 'transcript.jsonl');
  fs.writeFileSync(
    transcriptFile,
    JSON.stringify({
      step_index: 0,
      type: 'USER_INPUT',
      created_at: '2026-09-14T19:00:00Z',
      content: '<USER_REQUEST>\nhola agy\n</USER_REQUEST>',
    }) +
      '\n' +
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-09-14T19:00:01Z',
        content: 'Hola Diego!',
      }) +
      '\n'
  );

  const found = findSessionTranscript(sessionId, tmp);
  assert.strictEqual(found, transcriptFile);

  const msgs = getMessages(sessionId, tmp);
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].role, 'user');
  assert.strictEqual(msgs[0].text, 'hola agy');
  assert.strictEqual(msgs[1].role, 'assistant');
  assert.strictEqual(msgs[1].text, 'Hola Diego!');

  _clearSessionInfoCache();
  const info = sessionInfo(sessionId, tmp);
  assert.strictEqual(info.sessionId, sessionId);
  assert.strictEqual(info.snippet, 'hola agy');
  assert.strictEqual(info.messageCount, 2);
  assert.ok(info.contextTokens > 0);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('sessionInfo: calcula approxTokens si la sesion tiene mensajes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-scanner-tokens-'));
  const sessionId = 'test-tokens-session';
  const logsDir = path.join(tmp, 'brain', sessionId, '.system_generated', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const transcriptFile = path.join(logsDir, 'transcript.jsonl');
  fs.writeFileSync(
    transcriptFile,
    JSON.stringify({
      step_index: 0,
      type: 'USER_INPUT',
      created_at: '2026-09-14T19:00:00Z',
      content: '<USER_REQUEST>\n' + 'a'.repeat(400) + '\n</USER_REQUEST>',
    }) + '\n' +
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-09-14T19:00:01Z',
      content: 'b'.repeat(400),
    }) + '\n'
  );

  _clearSessionInfoCache();
  const info = sessionInfo(sessionId, tmp);
  // 12000 base + Math.round(800 / 4) = 12200
  assert.strictEqual(info.contextTokens, 12200);

  fs.rmSync(tmp, { recursive: true, force: true });
});

