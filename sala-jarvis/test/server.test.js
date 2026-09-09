const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.SALA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sala-server-test-'));
process.env.SALA_TOKENS = 'Jarvis:tok-diego,FerStark:tok-fernando';
const { app, parseTokens } = require('../src/server');

function listen(appInstance) {
  return new Promise(resolve => {
    const server = appInstance.listen(0, () => resolve(server));
  });
}

test('parseTokens arma un mapa token→nombre desde "Nombre:token,Nombre:token"', () => {
  const map = parseTokens('Jarvis:abc,FerStark:def');
  assert.equal(map.get('abc'), 'Jarvis');
  assert.equal(map.get('def'), 'FerStark');
  assert.equal(map.size, 2);
});

test('parseTokens ignora entradas vacías o mal formadas', () => {
  const map = parseTokens('Jarvis:abc,, :  ,FerStark:def');
  assert.equal(map.size, 2);
});

test('sin token válido, cualquier endpoint devuelve 401', async () => {
  const server = await listen(app);
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/rooms`);
  assert.equal(res.status, 401);
  server.close();
});

test('flujo completo: crear sala, postear mensajes de los dos, leer desde un cursor', async () => {
  const server = await listen(app);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const headers = (token) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

  const created = await fetch(`${base}/rooms`, {
    method: 'POST', headers: headers('tok-diego'), body: JSON.stringify({ name: 'Sala de prueba' }),
  }).then(r => r.json());
  assert.ok(created.id);

  const list = await fetch(`${base}/rooms`, { headers: headers('tok-diego') }).then(r => r.json());
  assert.equal(list.rooms.length, 1);

  await fetch(`${base}/rooms/${created.id}/messages`, {
    method: 'POST', headers: headers('tok-diego'), body: JSON.stringify({ text: 'hola desde Diego' }),
  });
  const posted = await fetch(`${base}/rooms/${created.id}/messages`, {
    method: 'POST', headers: headers('tok-fernando'), body: JSON.stringify({ text: 'hola desde Fernando' }),
  }).then(r => r.json());
  // El autor sale del token, no de lo que mande el body — nadie puede
  // publicar en nombre del otro aunque lo intente.
  assert.equal(posted.message.author, 'FerStark');

  const fromZero = await fetch(`${base}/rooms/${created.id}/messages?since=0`, { headers: headers('tok-diego') }).then(r => r.json());
  assert.deepEqual(fromZero.messages.map(m => m.author), ['Jarvis', 'FerStark']);
  assert.equal(fromZero.nextCursor, 2);

  const fromOne = await fetch(`${base}/rooms/${created.id}/messages?since=1`, { headers: headers('tok-diego') }).then(r => r.json());
  assert.deepEqual(fromOne.messages.map(m => m.text), ['hola desde Fernando']);

  server.close();
});

test('kind viaja del body a la respuesta, y a las lecturas posteriores; sin kind no queda el campo', async () => {
  const server = await listen(app);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer tok-diego' };
  const created = await fetch(`${base}/rooms`, { method: 'POST', headers, body: JSON.stringify({ name: 'X' }) }).then(r => r.json());

  const withKind = await fetch(`${base}/rooms/${created.id}/messages`, {
    method: 'POST', headers, body: JSON.stringify({ text: 'humano habló', kind: 'human' }),
  }).then(r => r.json());
  assert.equal(withKind.message.kind, 'human');

  const withoutKind = await fetch(`${base}/rooms/${created.id}/messages`, {
    method: 'POST', headers, body: JSON.stringify({ text: 'sin kind' }),
  }).then(r => r.json());
  assert.equal('kind' in withoutKind.message, false);

  const read = await fetch(`${base}/rooms/${created.id}/messages?since=0`, { headers }).then(r => r.json());
  assert.equal(read.messages[0].kind, 'human');
  assert.equal('kind' in read.messages[1], false);

  server.close();
});

test('kind con un valor arbitrario se ignora (no cualquier string pasa)', async () => {
  const server = await listen(app);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer tok-diego' };
  const created = await fetch(`${base}/rooms`, { method: 'POST', headers, body: JSON.stringify({ name: 'X' }) }).then(r => r.json());

  const posted = await fetch(`${base}/rooms/${created.id}/messages`, {
    method: 'POST', headers, body: JSON.stringify({ text: 'x', kind: 'lo-que-sea' }),
  }).then(r => r.json());
  assert.equal('kind' in posted.message, false);

  server.close();
});

test('GET /identities devuelve los nombres configurados en SALA_TOKENS, sin los tokens', async () => {
  const server = await listen(app);
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/identities`, { headers: { Authorization: 'Bearer tok-diego' } }).then(r => r.json());
  assert.deepEqual(res.identities.sort(), ['FerStark', 'Jarvis']);
  server.close();
});

test('sala inexistente devuelve 404 tanto en GET como en POST de mensajes', async () => {
  const server = await listen(app);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer tok-diego' };

  const get = await fetch(`${base}/rooms/no-existe/messages`, { headers });
  assert.equal(get.status, 404);

  const post = await fetch(`${base}/rooms/no-existe/messages`, { method: 'POST', headers, body: JSON.stringify({ text: 'x' }) });
  assert.equal(post.status, 404);

  server.close();
});

test('texto vacío al postear un mensaje devuelve 400', async () => {
  const server = await listen(app);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer tok-diego' };
  const created = await fetch(`${base}/rooms`, { method: 'POST', headers, body: JSON.stringify({ name: 'X' }) }).then(r => r.json());

  const res = await fetch(`${base}/rooms/${created.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ text: '   ' }) });
  assert.equal(res.status, 400);

  server.close();
});
