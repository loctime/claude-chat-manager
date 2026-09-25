'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

test('la recarga de Claude obtiene mensajes antes de vaciar la vista', () => {
  const load = app.slice(app.indexOf('async function loadMessages'), app.indexOf('// ── Respuestas sugeridas'));
  assert.ok(load.indexOf('const msgs = await api') < load.indexOf("messagesEl.innerHTML = '';"));
  assert.match(load, /messageLoadVersion/);
  assert.match(load, /No se pudo actualizar la conversación/);
});

test('al volver del background restaura scroll aun si la pausa fue breve', () => {
  assert.match(app, /if \(wasHiddenFor < 3000 && !force\) \{\s*restoreMessageScroll\(savedScroll\);/);
  assert.match(app, /requestAnimationFrame\(\(\) => requestAnimationFrame/);
  assert.match(app, /recoverVisibleConversation\(\{ force: true \}\)/);
});

test('Codex y Antigravity también cargan antes de limpiar la vista', () => {
  for (const file of ['codex.js', 'gemini.js']) {
    const source = fs.readFileSync(path.join(root, 'public', file), 'utf8');
    const fetchAt = source.indexOf('await codexApi') >= 0 ? source.indexOf('await codexApi') : source.indexOf('await geminiApi');
    const clearAt = source.indexOf("messagesEl.innerHTML = '';", fetchAt);
    assert.ok(fetchAt >= 0 && fetchAt < clearAt, file + ' debe obtener antes de limpiar');
  }
});
