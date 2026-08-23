const test = require('node:test');
const assert = require('node:assert');
const { infraNotice, pathContract } = require('../src/prompt-fragments');

test('infraNotice incluye host:puerto y menciona el riesgo de auto-matarse', () => {
  const s = infraNotice('127.0.0.1', 3777);
  assert.match(s, /127\.0\.0\.1:3777/);
  assert.match(s, /AVISO INFRAESTRUCTURA/);
});

test('pathContract menciona rutas absolutas y el límite de carpetas con espacios', () => {
  const s = pathContract();
  assert.match(s, /CONTRATO DE RUTAS/);
  assert.match(s, /espacios/);
});
