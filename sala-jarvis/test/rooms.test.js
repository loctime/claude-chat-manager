const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  listRooms, createRoom, getRoom, appendMessage, readMessagesSince,
} = require('../src/rooms');

const tmpIndexFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sala-index-')), 'rooms.json');
const tmpRoomsDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sala-rooms-'));

test('createRoom crea una sala con id y la lista la devuelve', () => {
  const indexFile = tmpIndexFile();
  const roomsDir = tmpRoomsDir();
  const room = createRoom('ControlDoc', indexFile);
  assert.ok(room.id);
  assert.equal(room.name, 'ControlDoc');
  assert.ok(room.createdAt);
  const list = listRooms(indexFile, roomsDir);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, room.id);
});

test('listRooms calcula lastActivity del último mensaje, o createdAt si no hay ninguno', () => {
  const indexFile = tmpIndexFile();
  const roomsDir = tmpRoomsDir();
  const room = createRoom('Sin mensajes', indexFile);
  let list = listRooms(indexFile, roomsDir);
  assert.equal(list[0].lastActivity, room.createdAt);

  appendMessage(room.id, 'Jarvis', 'hola', roomsDir);
  list = listRooms(indexFile, roomsDir);
  assert.notEqual(list[0].lastActivity, room.createdAt);
});

test('getRoom devuelve null si no existe', () => {
  assert.equal(getRoom('no-existe', tmpIndexFile()), null);
});

test('appendMessage acumula y readMessagesSince respeta el cursor', () => {
  const indexFile = tmpIndexFile();
  const roomsDir = tmpRoomsDir();
  const room = createRoom('Test', indexFile);

  appendMessage(room.id, 'Diego', 'primero', roomsDir);
  const { message, total } = appendMessage(room.id, 'Jarvis', 'segundo', roomsDir);
  assert.equal(message.author, 'Jarvis');
  assert.equal(message.text, 'segundo');
  assert.equal(total, 2);

  const fromStart = readMessagesSince(room.id, 0, roomsDir);
  assert.equal(fromStart.messages.length, 2);
  assert.equal(fromStart.nextCursor, 2);

  const fromOne = readMessagesSince(room.id, 1, roomsDir);
  assert.deepEqual(fromOne.messages.map(m => m.text), ['segundo']);
  assert.equal(fromOne.nextCursor, 2);
});

test('readMessagesSince sobre una sala sin mensajes todavía devuelve vacío', () => {
  const indexFile = tmpIndexFile();
  const roomsDir = tmpRoomsDir();
  const room = createRoom('Vacía', indexFile);
  const { messages, nextCursor } = readMessagesSince(room.id, 0, roomsDir);
  assert.deepEqual(messages, []);
  assert.equal(nextCursor, 0);
});
