const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Sandbox: HOME temporal y sin auth, ANTES de requerir el server.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-sse-test-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
delete process.env.ACCESS_PIN;
process.env.SINGLE_ACCOUNT = '1';

const { app, runner, sseHub } = require('../src/server');

// Stub: no spawnear claude real. Los jobs quedan registrados para asserts.
const sentJobs = [];
runner.send = job => { sentJobs.push(job); };

let srv;
let baseUrl;

test.before(async () => {
  await new Promise(resolve => { srv = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${srv.address().port}`;
});

test.after(() => { srv.close(); });

// Lector SSE: abre /api/stream y expone next() para esperar el próximo evento data:.
async function openSse() {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/api/stream`, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  const waiters = [];
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let i;
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const line = chunk.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue; // heartbeats y líneas vacías
          const ev = JSON.parse(line.slice(6));
          const w = waiters.shift();
          if (w) w(ev); else events.push(ev);
        }
      }
    } catch { /* abort esperado al cerrar */ }
  })();
  return {
    next(timeoutMs = 5000) {
      if (events.length > 0) return Promise.resolve(events.shift());
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout esperando evento SSE')), timeoutMs);
        waiters.push(ev => { clearTimeout(t); resolve(ev); });
      });
    },
    close() { controller.abort(); },
  };
}

test('GET /api/stream manda hello con las conversaciones ocupadas del runner', async () => {
  runner.running.set('conv-ocupada', {});
  const sse = await openSse();
  try {
    const hello = await sse.next();
    assert.equal(hello.kind, 'hello');
    assert.ok(hello.busy.includes('conv-ocupada'));
  } finally {
    sse.close();
    runner.running.delete('conv-ocupada');
  }
});
