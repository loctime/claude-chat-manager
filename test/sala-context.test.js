const test = require('node:test');
const assert = require('node:assert');
const { buildContextBlock } = require('../src/sala-context');

test('array vacío devuelve string vacío', () => {
  assert.equal(buildContextBlock([]), '');
});

test('un mensaje se arma como [Autor dijo:] texto', () => {
  const block = buildContextBlock([{ author: 'Fernando', text: 'che, revisá el deploy', ts: 1 }]);
  assert.equal(block, '[Fernando dijo:]\nche, revisá el deploy');
});

test('varios mensajes quedan uno debajo del otro, en orden', () => {
  const block = buildContextBlock([
    { author: 'Fernando', text: 'che, revisá el deploy', ts: 1 },
    { author: 'FerStark', text: 'ya lo revisé, está OK', ts: 2 },
  ]);
  assert.equal(
    block,
    '[Fernando dijo:]\nche, revisá el deploy\n\n[FerStark dijo:]\nya lo revisé, está OK'
  );
});
