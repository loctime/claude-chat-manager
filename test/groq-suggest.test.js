const test = require('node:test');
const assert = require('node:assert');
const { getReplySuggestions } = require('../src/groq-suggest');

test('sin apiKey no llama a fetch y devuelve []', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  const result = await getReplySuggestions('¿Querés que arranque?', { fetchImpl });
  assert.deepEqual(result, []);
  assert.equal(called, false);
});

test('sin texto (vacío o solo espacios) no llama a fetch y devuelve []', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  const result = await getReplySuggestions('   ', { apiKey: 'gsk_x', fetchImpl });
  assert.deepEqual(result, []);
  assert.equal(called, false);
});

test('pega a la API de Groq con el texto y la key, devuelve las sugerencias parseadas', async () => {
  let seenUrl, seenOpts;
  const fetchImpl = async (url, opts) => {
    seenUrl = url;
    seenOpts = opts;
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ suggestions: ['Sí, dale', 'Esperá'] }) } }],
      }),
    };
  };
  const result = await getReplySuggestions('¿Querés que arranque por el backend?', { apiKey: 'gsk_x', fetchImpl });
  assert.deepEqual(result, ['Sí, dale', 'Esperá']);
  assert.match(seenUrl, /groq\.com/);
  assert.equal(seenOpts.headers.Authorization, 'Bearer gsk_x');
  const body = JSON.parse(seenOpts.body);
  assert.equal(body.messages[1].content, '¿Querés que arranque por el backend?');
});

test('recorta a un máximo de 3 sugerencias y descarta entradas no-string o vacías', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ suggestions: ['A', '', '  ', 42, 'B', 'C', 'D'] }) } }],
    }),
  });
  const result = await getReplySuggestions('¿Seguimos?', { apiKey: 'gsk_x', fetchImpl });
  assert.deepEqual(result, ['A', 'B', 'C']);
});

test('mensaje sin nada que confirmar (suggestions vacío) devuelve []', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ suggestions: [] }) } }] }),
  });
  const result = await getReplySuggestions('Ya quedó todo commiteado.', { apiKey: 'gsk_x', fetchImpl });
  assert.deepEqual(result, []);
});

test('respuesta HTTP no-ok devuelve [] sin tirar excepción', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const result = await getReplySuggestions('¿Todo bien?', { apiKey: 'gsk_x', fetchImpl });
  assert.deepEqual(result, []);
});

test('contenido que no es JSON válido devuelve [] sin tirar excepción', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: 'esto no es json' } }] }),
  });
  const result = await getReplySuggestions('¿Todo bien?', { apiKey: 'gsk_x', fetchImpl });
  assert.deepEqual(result, []);
});

test('fetch que tira (timeout/red) devuelve [] sin tirar excepción', async () => {
  const fetchImpl = async () => { throw new Error('boom'); };
  const result = await getReplySuggestions('¿Todo bien?', { apiKey: 'gsk_x', fetchImpl });
  assert.deepEqual(result, []);
});
