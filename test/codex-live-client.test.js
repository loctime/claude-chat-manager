const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function client(response) {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { hidden: true, disabled: false, textContent: '', setAttribute() {}, classList: { contains: () => true } });
    return elements.get(id);
  };
  let micRequests = 0;
  const messages = [];
  const context = {
    document: { getElementById: get }, currentCodexConv: { id: 'conv' },
    window: { isSecureContext: true, addEventListener() {} },
    navigator: { mediaDevices: { getUserMedia() { micRequests++; throw Error('Unexpected microphone access'); } } },
    MutationObserver: class { observe() {} }, Audio: class { pause() {} },
    AbortController, clearInterval, clearTimeout, setTimeout,
    fetch: async () => response, toast: message => messages.push(message),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/codex-live.js'), 'utf8'), context);
  return { get, messages, micRequests: () => micRequests };
}

test('missing backend route shows restart instructions instead of parsing HTML', async () => {
  const c = client(new Response('<!DOCTYPE html><html>Cannot GET /api/codex-live/status</html>', { status: 404, headers: { 'content-type': 'text/html' } }));
  await c.get('codex-live-btn').onclick();
  assert.match(c.messages[0], /Reiniciá Claude Chat Manager desde otra terminal/);
  assert.equal(c.micRequests(), 0);
  assert.equal(c.get('codex-live-end').hidden, true);
  assert.equal(c.get('codex-live-btn').disabled, false);
});

test('HTML proxy response and authentication failures produce useful messages', async () => {
  for (const status of [200, 401, 403]) {
    const c = client(new Response('<!DOCTYPE html>', { status, headers: { 'content-type': 'text/html' } }));
    await c.get('codex-live-btn').onclick();
    assert.match(c.messages[0], status === 200 ? /página en lugar/ : /iniciar sesión/);
    assert.equal(c.micRequests(), 0);
  }
});

test('API errors and malformed JSON never leak a parser error', async () => {
  for (const [body, status, expected] of [
    ['{"error":"Clave no configurada"}', 503, /Clave no configurada/],
    ['broken', 200, /respuesta de voz inválida/],
    ['{}', 200, /backend de voz no está actualizado/],
    ['{"configured":false}', 200, /OPENAI_API_KEY/],
  ]) {
    const c = client(new Response(body, { status, headers: { 'content-type': 'application/json' } }));
    await c.get('codex-live-btn').onclick();
    assert.match(c.messages[0], expected);
    assert.equal(c.micRequests(), 0);
  }
});
