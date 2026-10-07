const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const meta = require('../src/meta');
const { createCodexLiveRouter, voiceContext } = require('../src/routes/codex-live');

test('voice: backend key, context, tools, persistence, duplicate protection and immediate termination', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-live-test-'));
  const file = path.join(dir, 'meta.json');
  meta.save({ conversations: { c: { projectDir: dir, voiceMessages: [{ role: 'user', text: 'Recordá el proyecto' }] } }, superseded: [] }, file);
  let key = '';
  let config;
  let socket;
  const upstreamCalls = [];
  class Socket extends EventEmitter {
    constructor(url, options) { super(); this.readyState = 1; this.sent = []; socket = this; assert.equal(options.headers.Authorization, 'Bearer secret-backend'); setImmediate(() => this.emit('open')); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.readyState = 3; this.emit('close'); }
  }
  const runner = new EventEmitter();
  let job;
  runner.cancel = () => {};
  runner.send = j => {
    job = j;
    setImmediate(() => {
      runner.emit('event', { convId: j.convId, event: { type: 'item.completed', item: { type: 'agent_message', text: 'Archivo consultado' } } });
      runner.emit('status', { convId: j.convId, status: 'idle', code: 0 });
    });
  };
  const app = express(); app.use(express.json());
  app.use(createCodexLiveRouter({ codexMetaFile: file, getKey: () => key, Socket, toolRunner: runner,
    fetchFn: async (url, opts) => {
      upstreamCalls.push(url);
      if (url.endsWith('/hangup')) return new Response('', { status: 200 });
      config = JSON.parse(opts.body.get('session'));
      return new Response('v=0\r\nanswer', { status: 201, headers: { location: '/v1/realtime/calls/rtc_test' } });
    },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (suffix, body, headers = {}) => fetch(base + suffix, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post('/conversations/c/session', { sdp: 'v=0' })).status, 503);
  key = 'secret-backend';
  assert.equal((await post('/conversations/c/session', { sdp: 'v=0' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/conversations/missing/session', { sdp: 'v=0' })).status, 404);
  assert.equal((await post('/conversations/c/session', { sdp: 'bad' })).status, 400);
  const response = await post('/conversations/c/session', { sdp: 'v=0' });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(!JSON.stringify(result).includes(key));
  assert.match(config.instructions, /Recordá el proyecto/);
  assert.equal(config.audio.input.turn_detection.interrupt_response, true);
  assert.equal(config.tools.length, 1);
  assert.equal((await post('/conversations/c/session', { sdp: 'v=0' })).status, 409);
  const ev = { type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: 'Hola por voz' };
  socket.emit('message', JSON.stringify(ev)); socket.emit('message', JSON.stringify(ev));
  assert.equal(meta.load(file).conversations.c.voiceMessages.length, 2);
  assert.match(voiceContext(meta.load(file).conversations.c), /Hola por voz/);
  socket.emit('message', JSON.stringify({ type: 'response.function_call_arguments.done', name: 'consultar_codex', call_id: 'tool1', arguments: '{"question":"Leer el archivo"}' }));
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(job.readOnly, true);
  assert.equal(job.sessionId, undefined);
  assert.equal(socket.sent[0].item.output, 'Archivo consultado\n');
  assert.equal((await post(`/conversations/c/session/${result.id}/heartbeat`, {})).status, 204);
  assert.equal((await fetch(`${base}/conversations/c/session/${result.id}`, { method: 'DELETE' })).status, 204);
  assert.equal(socket.readyState, 3);
  assert.ok(upstreamCalls.some(url => url.endsWith('/hangup')));
  assert.equal((await post(`/conversations/c/session/${result.id}/heartbeat`, {})).status, 404);
});
