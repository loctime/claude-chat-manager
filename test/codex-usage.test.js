const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { CodexUsageService, windowLabel, toUsageWindow } = require('../src/codex-usage');

test('etiqueta correctamente las ventanas de Codex', () => {
  assert.equal(windowLabel(300), '5h');
  assert.equal(windowLabel(10_080), 'Semana');
  assert.deepEqual(toUsageWindow({ usedPercent: 42, windowDurationMins: 300, resetsAt: 1_800_000_000 }), {
    label: '5h', pct: 42, resetsAt: 1_800_000_000_000,
  });
});

test('consulta account/rateLimits/read y normaliza las ventanas', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit('close', 0);
  const sent = [];
  child.stdin.on('data', data => {
    const request = JSON.parse(data.toString());
    sent.push(request);
    if (request.id === 1) {
      child.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n');
    }
    if (request.id === 2) {
      child.stdout.write(JSON.stringify({ id: 2, result: { rateLimits: {
        planType: 'plus',
        primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 60, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
      } } }) + '\n');
    }
  });
  const service = new CodexUsageService({ command: 'codex', spawnFn: () => child });
  const data = await service.get();
  assert.equal(data.plan, 'plus');
  assert.deepEqual(data.primary, { label: '5h', pct: 12.5, resetsAt: 1_800_000_000_000 });
  assert.deepEqual(data.secondary, { label: 'Semana', pct: 60, resetsAt: 1_800_500_000_000 });
  assert.equal(sent.some(req => req.method === 'account/rateLimits/read'), true);
});
