const test = require('node:test');
const assert = require('node:assert');
const { responseModeInstruction, RESPONSE_MODES } = require('../src/response-modes');

test('sin modo (undefined) devuelve la instrucción de "directo"', () => {
  assert.equal(responseModeInstruction(undefined), RESPONSE_MODES.directo);
});

test('modo "directo" explícito devuelve la misma instrucción', () => {
  assert.equal(responseModeInstruction('directo'), RESPONSE_MODES.directo);
});

test('modo "detallado" no agrega ninguna instrucción', () => {
  assert.equal(responseModeInstruction('detallado'), null);
});

test('modo "cavernicola" devuelve su propia instrucción', () => {
  assert.equal(responseModeInstruction('cavernicola'), RESPONSE_MODES.cavernicola);
  assert.notEqual(RESPONSE_MODES.cavernicola, RESPONSE_MODES.directo);
});

test('modo desconocido no agrega ninguna instrucción', () => {
  assert.equal(responseModeInstruction('algo-que-no-existe'), null);
});
