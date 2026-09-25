const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const sala = fs.readFileSync(path.join(__dirname, '..', 'public', 'sala.js'), 'utf8');

test('Sala da prioridad a kind para no mostrar agentes como mensajes propios', () => {
  assert.match(sala, /m\.kind === 'human'\s*\? true/);
  assert.match(sala, /m\.kind === 'agent'\s*\? false/);
  assert.doesNotMatch(sala, /const mine = author === USER_NAME \|\| author === APP_NAME/);
});

test('el streaming de Sala etiqueta el texto parcial con el autor agente', () => {
  assert.match(sala, /author: APP_NAME/);
});
