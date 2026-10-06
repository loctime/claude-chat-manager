const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { createFilesRouter } = require('../src/routes/files');

// Bug real (05/10/2026): llegaban audios de 0 bytes y nadie se enteraba. El server aceptaba
// un archivo vacío como adjunto normal (devolvía size:0 y el chat quedaba con una ruta a un
// archivo vacío). Ahora se rechaza con un mensaje claro y no deja basura en el disco.
async function start() {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-upload-empty-'));
  const app = express();
  app.use('/api', createFilesRouter({ uploadDir, getGroqApiKey: () => '' }));
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  return { base, uploadDir, stop() { server.close(); fs.rmSync(uploadDir, { recursive: true, force: true }); } };
}

function form(field, bytes, name, type) {
  const fd = new FormData();
  fd.append(field, new Blob([bytes], { type }), name);
  return fd;
}

test('un adjunto de 0 bytes se rechaza con 400, mensaje claro y sin dejar archivos', async () => {
  const t = await start();
  try {
    const r = await fetch(t.base + '/upload', { method: 'POST', body: form('file', Buffer.alloc(0), 'audio.mp3', 'audio/mpeg') });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.match(body.error, /vacío \(0 bytes\)/);
    assert.match(body.error, /WhatsApp/);
    await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(fs.readdirSync(t.uploadDir), [], 'el archivo temporal vacío se borró');
  } finally { t.stop(); }
});

test('un adjunto con contenido sigue subiendo normal y reporta su tamaño real', async () => {
  const t = await start();
  try {
    const bytes = Buffer.alloc(2048, 7);
    const r = await fetch(t.base + '/upload', { method: 'POST', body: form('file', bytes, 'audio.mp3', 'audio/mpeg') });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.size, 2048);
    assert.equal(fs.statSync(body.path).size, 2048);
    assert.equal(body.name, 'audio.mp3');
  } finally { t.stop(); }
});

test('un audio vacío para transcribir se rechaza antes de pedir la clave o llamar a Groq', async () => {
  const t = await start();
  try {
    const r = await fetch(t.base + '/transcribe', { method: 'POST', body: form('audio', Buffer.alloc(0), 'audio.webm', 'audio/webm') });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /audio llegó vacío/);
    await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(fs.readdirSync(t.uploadDir), []);
  } finally { t.stop(); }
});

test('sin archivo sigue respondiendo el error de siempre', async () => {
  const t = await start();
  try {
    const r = await fetch(t.base + '/upload', { method: 'POST', body: new FormData() });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /no se recibió archivo/);
  } finally { t.stop(); }
});
