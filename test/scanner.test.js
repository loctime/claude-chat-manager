const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseJsonl, sessionInfo, listSessions, toChatMessages, findSessionFile, getMessagesIncremental, sumUsage, searchSessions, resolveCwd, _clearSessionInfoCache, _clearTailCache } = require('../src/scanner');

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

test('toChatMessages no muestra la plomería que deja /compact (resumen crudo, command-name, local-command-stdout)', () => {
  // Forma real tomada de una sesión compactada de verdad (2026-08-06).
  const entries = [
    JSON.parse(userEntry('hola')),
    JSON.parse(assistantEntry([{ type: 'text', text: 'hola de vuelta' }])),
    { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual', preTokens: 100, postTokens: 10 } },
    {
      type: 'user', isVisibleInTranscriptOnly: true, isCompactSummary: true,
      message: { role: 'user', content: 'This session is being continued from a previous conversation...' },
    },
    { type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>Caveat: ...</local-command-caveat>' } },
    { type: 'user', message: { role: 'user', content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>' } },
    { type: 'user', message: { role: 'user', content: '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>' } },
    JSON.parse(userEntry('seguimos')),
  ];
  const msgs = toChatMessages(entries);
  assert.deepEqual(msgs.map(m => m.role), ['user', 'assistant', 'system-compact', 'user']);
  assert.equal(msgs[0].text, 'hola');
  assert.equal(msgs[3].text, 'seguimos');
});

test('toChatMessages expone el compact_boundary (manual o automático) como item system-compact', () => {
  const entries = [
    JSON.parse(userEntry('hola')),
    JSON.parse(assistantEntry([{ type: 'text', text: 'hola de vuelta' }])),
    {
      type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted',
      compactMetadata: { trigger: 'manual', preTokens: 44409, postTokens: 5239 },
    },
    JSON.parse(userEntry('seguimos')),
  ];
  const msgs = toChatMessages(entries);
  assert.deepEqual(msgs.map(m => m.role), ['user', 'assistant', 'system-compact', 'user']);
  assert.equal(msgs[2].trigger, 'manual');
  assert.equal(msgs[2].preTokens, 44409);
  assert.equal(msgs[2].postTokens, 5239);
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

test('searchSessions encuentra matches en texto de mensajes y devuelve snippet+índice', () => {
  _clearSessionInfoCache();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-search-'));
  const projDir = path.join(base, '-home-x');
  fs.mkdirSync(projDir);
  fs.writeFileSync(path.join(projDir, 'sess-abc.jsonl'), [
    userEntry('acordate del refactor de auth para mañana'),
    assistantEntry([{ type: 'text', text: 'listo, quedó en la lista' }]),
    userEntry('pasame el link del PR'),
  ].join('\n'));
  fs.writeFileSync(path.join(projDir, 'sess-def.jsonl'), [
    userEntry('esto no tiene nada'),
  ].join('\n'));

  const results = searchSessions('refactor', { projectsDir: base });
  assert.equal(results.length, 1);
  assert.equal(results[0].sessionId, 'sess-abc');
  assert.equal(results[0].matchIndex, 0);
  assert.equal(results[0].role, 'user');
  assert.match(results[0].snippet, /refactor de auth/);
});

test('searchSessions es case-insensitive y respeta limit', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-search-'));
  const projDir = path.join(base, '-home-x');
  fs.mkdirSync(projDir);
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(path.join(projDir, `s-${i}.jsonl`), userEntry('DEPLOY número ' + i));
  }
  const results = searchSessions('deploy', { projectsDir: base, limit: 3 });
  assert.equal(results.length, 3);
});

test('searchSessions devuelve [] con query vacío', () => {
  assert.deepEqual(searchSessions(''), []);
  assert.deepEqual(searchSessions('   '), []);
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

test('sessionInfo.contextTokens = tokens del último turno assistant (input+cache_read+cache_create)', () => {
  _clearSessionInfoCache();
  const turn1 = JSON.stringify({
    type: 'assistant', cwd: '/x', timestamp: '2026-07-13T10:00:00.000Z',
    message: { role: 'assistant', model: 'claude-opus-4-7', content: [{ type: 'text', text: 'a' }],
               usage: { input_tokens: 100, output_tokens: 5, cache_creation_input_tokens: 200, cache_read_input_tokens: 300 } },
  });
  const turn2 = JSON.stringify({
    type: 'assistant', cwd: '/x', timestamp: '2026-07-13T10:00:10.000Z',
    message: { role: 'assistant', model: 'claude-opus-4-7', content: [{ type: 'text', text: 'b' }],
               usage: { input_tokens: 400, output_tokens: 6, cache_creation_input_tokens: 500, cache_read_input_tokens: 600 } },
  });
  const { file } = tmpFile([userEntry('hola'), turn1, userEntry('otra'), turn2]);
  const info = sessionInfo(file);
  assert.equal(info.contextTokens, 400 + 500 + 600);
});

test('sessionInfo.contextTokens = 0 si no hay usage', () => {
  _clearSessionInfoCache();
  const { file } = tmpFile([userEntry('hola'), assistantEntry([{ type: 'text', text: 'ok' }])]);
  const info = sessionInfo(file);
  assert.equal(info.contextTokens, 0);
});

// Helper: arma un projectsDir falso con una sesión adentro de la carpeta `folder`
// (que en la realidad es el cwd con todo lo no alfanumérico reemplazado por "-").
function tmpProjects(folder, sessionId, lines) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-resolvecwd-'));
  const projDir = path.join(base, folder);
  fs.mkdirSync(projDir);
  fs.writeFileSync(path.join(projDir, `${sessionId}.jsonl`), lines.join('\n'));
  return base;
}

const entryWithCwd = (cwd, text, ts = '2026-07-12T10:05:00.000Z') => JSON.stringify({
  type: 'assistant', cwd, sessionId: 'sess-x', timestamp: ts,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

test('sessionInfo.cwd = el cwd que codifica a la carpeta donde vive el archivo, no el último que Claude tocó', () => {
  _clearSessionInfoCache();
  // Sesión lanzada en /home/loctime; Claude después trabajó dentro de un proyecto.
  // El archivo sigue indexado bajo la carpeta de /home/loctime → ése es el cwd para --resume.
  const base = tmpProjects('-home-loctime', 'sess-x', [
    entryWithCwd('/home/loctime', 'arrancamos en home', '2026-07-12T10:00:00.000Z'),
    entryWithCwd('/home/loctime/Proyectos/demo', 'ahora miro el proyecto'),
  ]);
  const info = sessionInfo(path.join(base, '-home-loctime', 'sess-x.jsonl'));
  assert.equal(info.cwd, '/home/loctime');
});

test('sessionInfo.cwd sigue el archivo cuando EnterWorktree lo reubica a la carpeta del worktree', () => {
  _clearSessionInfoCache();
  const folder = '-home-loctime-Proyectos-demo--claude-worktrees-feature';
  const base = tmpProjects(folder, 'sess-x', [
    entryWithCwd('/home/loctime', 'arrancamos en home', '2026-07-12T10:00:00.000Z'),
    entryWithCwd('/home/loctime/Proyectos/demo/.claude/worktrees/feature', 'ya en el worktree'),
  ]);
  const info = sessionInfo(path.join(base, folder, 'sess-x.jsonl'));
  assert.equal(info.cwd, '/home/loctime/Proyectos/demo/.claude/worktrees/feature');
});

test('sessionInfo.cwd cae al cwd más reciente si ninguno codifica a la carpeta contenedora', () => {
  _clearSessionInfoCache();
  const base = tmpProjects('-carpeta-que-no-corresponde', 'sess-x', [
    entryWithCwd('/home/loctime', 'hola', '2026-07-12T10:00:00.000Z'),
    entryWithCwd('/home/loctime/otro', 'chau'),
  ]);
  const info = sessionInfo(path.join(base, '-carpeta-que-no-corresponde', 'sess-x.jsonl'));
  assert.equal(info.cwd, '/home/loctime/otro');
});

test('resolveCwd devuelve el cwd donde Claude Code va a encontrar la sesión, no el projectDir guardado', () => {
  _clearSessionInfoCache();
  const folder = '-home-loctime-Proyectos-demo--claude-worktrees-feature';
  const base = tmpProjects(folder, 'sess-relocated', [
    entryWithCwd('/home/loctime', 'arrancamos en home', '2026-07-12T10:00:00.000Z'),
    entryWithCwd('/home/loctime/Proyectos/demo/.claude/worktrees/feature', 'reubicado'),
  ]);
  const conv = { currentSessionId: 'sess-relocated', projectDir: '/stale/home/dir' };
  assert.equal(resolveCwd(conv, base), '/home/loctime/Proyectos/demo/.claude/worktrees/feature');
});

test('resolveCwd NO se deja llevar por las subcarpetas que Claude visitó durante la charla', () => {
  _clearSessionInfoCache();
  // El caso que rompía el 2do mensaje: la sesión vive bajo el cwd de arranque (home),
  // pero el último cwd del jsonl apunta a un proyecto → --resume ahí no la encuentra.
  const base = tmpProjects('-home-loctime', 'sess-y', [
    entryWithCwd('/home/loctime', 'hola', '2026-07-12T10:00:00.000Z'),
    entryWithCwd('/home/loctime/Proyectos/demo/frontend', 'trabajando en el frontend'),
  ]);
  const conv = { currentSessionId: 'sess-y', projectDir: '/home/loctime' };
  assert.equal(resolveCwd(conv, base), '/home/loctime');
});

test('resolveCwd cae al projectDir guardado cuando la conversación todavía no tiene sesión (mensaje inicial)', () => {
  const conv = { currentSessionId: null, projectDir: '/elegido/por/el/usuario' };
  assert.equal(resolveCwd(conv, '/no/existe'), '/elegido/por/el/usuario');
});

// ── Rewind ──
const { rewindCutIndex, rewindSessionFile } = require('../src/scanner');

// Cadena estilo lab 2026-08-09: user T1 → assistant T1 → plomería → user T2 → assistant T2
function rewindFixtureLines() {
  const mk = o => JSON.stringify(o);
  return [
    mk({ type: 'queue-operation', operation: 'enqueue' }),
    mk({ type: 'user', uuid: 'u1', parentUuid: null, sessionId: 's1', message: { role: 'user', content: 'primera pregunta' } }),
    mk({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 's1', message: { role: 'assistant', content: [{ type: 'text', text: 'primera respuesta' }] } }),
    mk({ type: 'last-prompt', leafUuid: 'a1', lastPrompt: 'primera pregunta', sessionId: 's1' }),
    mk({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 10, postTokens: 5 } }),
    mk({ type: 'mode', mode: 'normal' }),
    mk({ type: 'queue-operation', operation: 'enqueue' }),
    mk({ type: 'attachment', parentUuid: 'a1', attachment: { type: 'hook_success' } }),
    mk({ type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId: 's1', message: { role: 'user', content: 'pregunta fuera de tema' } }),
    mk({ type: 'assistant', uuid: 'a2', parentUuid: 'u2', sessionId: 's1', message: { role: 'assistant', content: [{ type: 'text', text: 'respuesta fuera de tema' }] } }),
    mk({ type: 'last-prompt', leafUuid: 'a2', lastPrompt: 'pregunta fuera de tema', sessionId: 's1' }),
  ];
}

test('rewindCutIndex corta antes del user y arrastra la plomería previa, sin tocar system', () => {
  const parsed = rewindFixtureLines().map(l => JSON.parse(l));
  // El corte para u2 debe caer justo después del compact_boundary (system se conserva),
  // llevándose mode + queue-operation + attachment + u2 + a2 + last-prompt.
  assert.equal(rewindCutIndex(parsed, 'u2'), 5);
});

test('rewindCutIndex rechaza uuid inexistente y rebobinar el primer mensaje', () => {
  const parsed = rewindFixtureLines().map(l => JSON.parse(l));
  assert.equal(rewindCutIndex(parsed, 'no-existe'), -1);
  // u1 es el primer turno: cortarlo dejaría la sesión sin mensajes
  assert.equal(rewindCutIndex(parsed, 'u1'), -1);
});

test('rewindSessionFile trunca el archivo, deja backup e invalida caches', () => {
  const { file } = tmpFile(rewindFixtureLines());
  const result = rewindSessionFile(file, 'u2');
  assert.equal(result.removed, 6);
  assert.ok(fs.existsSync(result.backup));
  const kept = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(kept.length, 5);
  assert.equal(kept[kept.length - 1].subtype, 'compact_boundary');
  // El backup conserva el contenido original completo
  assert.equal(fs.readFileSync(result.backup, 'utf8').trim().split('\n').length, 11);
  // La vista de chat post-rewind ya no incluye el turno cortado
  const msgs = toChatMessages(kept);
  assert.ok(!msgs.some(m => m.text && m.text.includes('fuera de tema')));
});

test('rewindSessionFile devuelve null si el uuid no está', () => {
  const { file } = tmpFile(rewindFixtureLines());
  assert.equal(rewindSessionFile(file, 'nope'), null);
  // y no dejó backup huérfano
  assert.ok(!fs.readdirSync(path.dirname(file)).some(f => f.includes('bak-rewind')));
});

test('toChatMessages expone uuid en los mensajes user', () => {
  const { file } = tmpFile(rewindFixtureLines());
  const msgs = toChatMessages(parseJsonl(file));
  const users = msgs.filter(m => m.role === 'user');
  assert.deepEqual(users.map(u => u.uuid), ['u1', 'u2']);
});
