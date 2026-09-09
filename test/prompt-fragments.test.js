const test = require('node:test');
const assert = require('node:assert');
const { infraNotice, pathContract, salaNotice } = require('../src/prompt-fragments');

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

test('salaNotice incluye el nombre de la instancia y aclara que el otro agente corre en otra PC', () => {
  const s = salaNotice('Jarvis');
  assert.match(s, /SALA COMPARTIDA/);
  assert.match(s, /vos sos Jarvis/);
  assert.match(s, /PC DISTINTA/);
  assert.match(s, /no asumas que algo cambió acá/);
});
