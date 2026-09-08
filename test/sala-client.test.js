const test = require('node:test');
const assert = require('node:assert');
const { listRooms, createRoom, fetchMessages, postMessage } = require('../src/sala-client');

const OPTS = { baseUrl: 'https://sala.controlapps.ar', token: 'tok-x' };

test('listRooms pega a GET /rooms con el bearer token', async () => {
  let seenUrl, seenOpts;
  const fetchImpl = async (url, opts) => {
    seenUrl = url; seenOpts = opts;
    return { ok: true, json: async () => ({ rooms: [{ id: '1', name: 'X' }] }) };
  };
  const rooms = await listRooms({ ...OPTS, fetchImpl });
  assert.equal(seenUrl, 'https://sala.controlapps.ar/rooms');
  assert.equal(seenOpts.headers.Authorization, 'Bearer tok-x');
  assert.deepEqual(rooms, [{ id: '1', name: 'X' }]);
});

test('createRoom pega a POST /rooms con el nombre', async () => {
  let seenOpts;
  const fetchImpl = async (url, opts) => {
    seenOpts = opts;
    return { ok: true, json: async () => ({ id: '1', name: 'Nueva' }) };
  };
  const room = await createRoom({ ...OPTS, name: 'Nueva', fetchImpl });
  assert.equal(seenOpts.method, 'POST');
  assert.deepEqual(JSON.parse(seenOpts.body), { name: 'Nueva' });
  assert.equal(room.name, 'Nueva');
});

test('fetchMessages agrega ?since= a la URL', async () => {
  let seenUrl;
  const fetchImpl = async (url) => {
    seenUrl = url;
    return { ok: true, json: async () => ({ messages: [], nextCursor: 5 }) };
  };
  await fetchMessages({ ...OPTS, roomId: 'r1', since: 5, fetchImpl });
  assert.equal(seenUrl, 'https://sala.controlapps.ar/rooms/r1/messages?since=5');
});

test('postMessage pega a POST /rooms/:id/messages con el texto', async () => {
  let seenUrl, seenOpts;
  const fetchImpl = async (url, opts) => {
    seenUrl = url; seenOpts = opts;
    return { ok: true, json: async () => ({ message: { author: 'Jarvis', text: 'hola', ts: 1 }, total: 1 }) };
  };
  const result = await postMessage({ ...OPTS, roomId: 'r1', text: 'hola', fetchImpl });
  assert.equal(seenUrl, 'https://sala.controlapps.ar/rooms/r1/messages');
  assert.deepEqual(JSON.parse(seenOpts.body), { text: 'hola' });
  assert.equal(result.message.author, 'Jarvis');
});

test('una respuesta no-ok tira un Error con el mensaje del body', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: 'token inválido' }) });
  await assert.rejects(() => listRooms({ ...OPTS, fetchImpl }), /token inválido/);
});

test('una respuesta no-ok sin body JSON parseable tira un Error genérico con el status', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => { throw new Error('no json'); } });
  await assert.rejects(() => listRooms({ ...OPTS, fetchImpl }), /500/);
});
