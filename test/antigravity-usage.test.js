const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { AntigravityUsageService, parseAntigravityUsage, toUsageWindow, findBucket } = require('../src/antigravity-usage');

test('toUsageWindow calcula el porcentaje de uso y normaliza etiquetas', () => {
  const window5h = toUsageWindow({
    id: 'gemini-5h',
    window: '5h',
    remaining_fraction: 0.85,
    reset_time: '2026-09-15T02:26:11Z',
  });
  assert.equal(window5h.label, '5h');
  assert.equal(window5h.window, '5h');
  assert.equal(Math.round(window5h.pct), 15);
  assert.equal(window5h.resetsAt, '2026-09-15T02:26:11Z');

  const windowWeekly = toUsageWindow({
    id: 'gemini-weekly',
    window: 'weekly',
    remaining_fraction: 0.995,
    reset_time: '2026-09-21T21:26:11Z',
  });
  assert.equal(windowWeekly.label, 'Semana');
  assert.equal(windowWeekly.window, 'weekly');
  assert.equal(Math.round(windowWeekly.pct * 10) / 10, 0.5);
  assert.equal(windowWeekly.resetsAt, '2026-09-21T21:26:11Z');
});

test('parseAntigravityUsage asigna 5h a primary y semanal a secondary', () => {
  const mockResult = {
    status: 'SUCCESS',
    command: {
      data: {
        description: 'Within each group, models share a weekly limit and a 5-hour limit.',
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.99, reset_time: '2026-09-21T21:00:00Z' },
              { id: 'gemini-5h', window: '5h', remaining_fraction: 0.80, reset_time: '2026-09-15T02:00:00Z' },
            ],
          },
          {
            name: 'Claude and GPT models',
            buckets: [
              { id: '3p-weekly', window: 'weekly', remaining_fraction: 1, reset_time: '2026-09-21T21:00:00Z' },
              { id: '3p-5h', window: '5h', remaining_fraction: 1, reset_time: '2026-09-15T02:00:00Z' },
            ],
          },
        ],
      },
    },
  };

  const parsed = parseAntigravityUsage(mockResult);
  assert.equal(parsed.provider, 'antigravity');
  assert.equal(parsed.plan, 'Pro');
  assert.equal(parsed.primary.label, '5h');
  assert.equal(parsed.primary.window, '5h');
  assert.equal(Math.round(parsed.primary.pct), 20);
  assert.equal(parsed.secondary.label, 'Semana');
  assert.equal(parsed.secondary.window, 'weekly');
  assert.equal(Math.round(parsed.secondary.pct), 1);
  assert.ok(parsed.thirdParty);
  assert.equal(parsed.thirdParty.name, 'Claude and GPT models');
  assert.equal(parsed.thirdParty.primary.label, '5h');
  assert.equal(parsed.thirdParty.secondary.label, 'Semana');
});

test('AntigravityUsageService consulta /usage y cachea la respuesta', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};

  const spawnFn = () => {
    process.nextTick(() => {
      child.stdout.write(JSON.stringify({
        status: 'SUCCESS',
        command: {
          data: {
            plan_tier: 'Pro',
            groups: [
              {
                name: 'Gemini Models',
                buckets: [
                  { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.95, reset_time: '2026-09-21T21:00:00Z' },
                  { id: 'gemini-5h', window: '5h', remaining_fraction: 0.90, reset_time: '2026-09-15T02:00:00Z' },
                ],
              },
            ],
          },
        },
      }));
      child.emit('close', 0);
    });
    return child;
  };

  const service = new AntigravityUsageService({ command: 'agy', spawnFn });
  const data = await service.get();
  assert.equal(data.provider, 'antigravity');
  assert.equal(data.plan, 'Pro');
  assert.equal(data.primary.label, '5h');
  assert.equal(Math.round(data.primary.pct), 10);
  assert.equal(data.secondary.label, 'Semana');
  assert.equal(Math.round(data.secondary.pct), 5);

  // Segunda llamada debe salir de cache sin re-spawnear
  const cached = await service.get();
  assert.equal(cached.fetchedAt, data.fetchedAt);
});
