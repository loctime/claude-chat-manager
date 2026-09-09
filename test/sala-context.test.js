const test = require('node:test');
const assert = require('node:assert');
const { buildContextBlock, normalizeMentionName, extractMentions, isMentioned, mentionNotice } = require('../src/sala-context');

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

test('usa el nombre real del prefijo "Nombre: texto", no el author (que es la instancia, no quién habló)', () => {
  // Diego reportó el bug real: Fernando (humano) y FerStark (agente) publican
  // los dos con author:"FerStark" (misma instancia/token) — sin esto, a
  // Claude le llegaban ambos como "[FerStark dijo:]", indistinguibles.
  const block = buildContextBlock([
    { author: 'FerStark', text: 'Vos: hola aca estamos con ferstark!', ts: 1, kind: 'human' },
    { author: 'FerStark', text: 'FerStark: ¡Hola! ¿En qué te ayudo?', ts: 2, kind: 'agent' },
  ]);
  assert.equal(
    block,
    '[Vos (persona) dijo:]\nhola aca estamos con ferstark!\n\n[FerStark (agente de IA) dijo:]\n¡Hola! ¿En qué te ayudo?'
  );
});

test('sin kind (mensajes viejos, de antes de que existiera el campo) no agrega la aclaración de rol', () => {
  const block = buildContextBlock([{ author: 'Jarvis', text: 'Diego: hola', ts: 1 }]);
  assert.equal(block, '[Diego dijo:]\nhola');
});

test('si el texto no tiene el prefijo "Nombre: " (formato viejo o roto), cae al author tal cual', () => {
  const block = buildContextBlock([{ author: 'FerStark', text: 'texto sin prefijo de nombre', ts: 1, kind: 'human' }]);
  assert.equal(block, '[FerStark (persona) dijo:]\ntexto sin prefijo de nombre');
});

// ── normalizeMentionName / extractMentions / isMentioned ──

test('normalizeMentionName reduce a minúsculas y saca todo lo que no sea letra/número', () => {
  assert.equal(normalizeMentionName('FerStark'), 'ferstark');
  assert.equal(normalizeMentionName('J.A.R.V.I.S'), 'jarvis');
  assert.equal(normalizeMentionName('Fer_Stark'), 'ferstark');
});

test('extractMentions saca los tokens @algo de un texto, sin la puntuación final', () => {
  assert.deepEqual(extractMentions('che @FerStark, revisá esto'), ['FerStark']);
  assert.deepEqual(extractMentions('@jarvis y @ferstark opinen'), ['jarvis', 'ferstark']);
  assert.deepEqual(extractMentions('sin menciones acá'), []);
  assert.deepEqual(extractMentions('mi mail es diego@ejemplo.com'), ['ejemplo.com']); // limitación conocida, no distingue email de mención
});

test('isMentioned matchea sin importar mayúsculas/puntos/guiones bajos', () => {
  assert.equal(isMentioned('che @ferstark, mirá esto', 'FerStark'), true);
  assert.equal(isMentioned('@FERSTARK!', 'FerStark'), true);
  assert.equal(isMentioned('@Fer_Stark', 'FerStark'), true);
  assert.equal(isMentioned('@jarvis', 'FerStark'), false);
  assert.equal(isMentioned('sin menciones', 'FerStark'), false);
});

test('mentionNotice arma el marcador mecánico con el nombre de la instancia', () => {
  assert.equal(
    mentionNotice('J.A.R.V.I.S'),
    '[Te mencionaron con @J.A.R.V.I.S en este hilo — respondé si corresponde a lo que se está hablando]'
  );
});
