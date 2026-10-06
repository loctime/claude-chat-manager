const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Bug real (06/10/2026): al abrir una conversación se veía un instante la anterior. El panel se
// abría (openChat) antes de que llegaran los mensajes y todavía tenía los de la charla previa.
// Toda función que abre una conversación tiene que vaciar el panel (prepareMessagesForOpen) ANTES
// de abrirlo; y si se suma un motor nuevo, este test obliga a hacerlo igual.
const PUBLIC = path.join(__dirname, '..', 'public');
const ABRIDORES = [
  ['app.js', 'selectConv'],
  ['codex.js', 'selectCodexShared'],
  ['gemini.js', 'selectGemini'],
];

function cuerpo(src, nombre) {
  const ini = src.indexOf(`async function ${nombre}(`);
  assert.ok(ini >= 0, `no encontré ${nombre}`);
  const fin = src.indexOf('\n}\n', ini);
  return src.slice(ini, fin);
}

for (const [file, fn] of ABRIDORES) {
  test(`${fn} vacía el panel antes de abrirlo`, () => {
    const body = cuerpo(fs.readFileSync(path.join(PUBLIC, file), 'utf8'), fn);
    const prepara = body.indexOf('prepareMessagesForOpen(');
    const abre = body.indexOf('openChat();');
    assert.ok(prepara >= 0, `${fn} no llama a prepareMessagesForOpen`);
    assert.ok(abre >= 0, `${fn} no llama a openChat`);
    assert.ok(prepara < abre, `${fn} abre el panel antes de vaciarlo`);
  });
}

test('si una carga falla, los tres cargadores sacan el "Cargando…" en vez de dejarlo colgado', () => {
  for (const [file, fn] of [['app.js', 'loadMessages'], ['codex.js', 'loadCodexSharedMessages'], ['gemini.js', 'loadGeminiMessages']]) {
    const body = cuerpo(fs.readFileSync(path.join(PUBLIC, file), 'utf8'), fn);
    assert.match(body, /showMessagesLoadFailed\(\)/, `${fn} no llama a showMessagesLoadFailed en su catch`);
  }
});

test('el "Cargando…" no se ve en las cargas rápidas (aparece con retraso por CSS)', () => {
  const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8');
  assert.match(css, /#messages \.loading-messages\s*\{[^}]*opacity:\s*0[^}]*animation:[^}]*\.35s/);
});
