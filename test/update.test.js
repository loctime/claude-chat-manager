const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { createUpdateRouter, gitArgs, RESUME_TTL_MS } = require('../src/update');

test('git se invoca con safe.directory para poder leer un checkout de otro dueño', () => {
  assert.deepEqual(gitArgs('/opt/app', ['rev-parse', 'HEAD']), ['-c', 'safe.directory=/opt/app', 'rev-parse', 'HEAD']);
});

test('con el git real, un repo de este mismo dueño devuelve su HEAD', async () => {
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-update-git-'));
  try {
    const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'pipe' }).toString().trim();
    g('init', '-q'); fs.writeFileSync(path.join(dir, 'a.txt'), 'x'); g('add', '.'); g('commit', '-qm', 'uno');
    const head = g('rev-parse', 'HEAD');
    const router = createUpdateRouter({ repoRoot: dir, engines: {}, canSelfRestart: true, restart() {}, resumeFile: path.join(dir, 'r.json') });
    const app = express(); app.use('/api', router);
    const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
      const body = await (await fetch(`http://127.0.0.1:${server.address().port}/api/version`)).json();
      assert.equal(body.running, head);
      assert.equal(body.available, head);
      assert.equal(body.updateAvailable, false);
    } finally { server.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function fakeRunner({ running = [], queue = [] } = {}) {
  const cancelled = [];
  return {
    running: new Map(running.map(id => [id, {}])),
    queue: queue.map(convId => ({ convId })),
    cancel(id) { cancelled.push(id); },
    cancelled,
  };
}

// git falso: responde según los argumentos
function fakeGit({ running = 'aaa', available = 'aaa', changed = '' } = {}) {
  let first = true;
  return async args => {
    if (args[0] === 'rev-parse') { if (first) { first = false; return running; } return available; }
    if (args[0] === 'diff') return changed;
    return null;
  };
}

async function start(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-update-test-'));
  const restarts = [];
  const engines = opts.engines || { claude: fakeRunner(), codex: fakeRunner(), agy: fakeRunner() };
  const router = createUpdateRouter({
    repoRoot: dir,
    engines,
    canSelfRestart: opts.canSelfRestart ?? true,
    restart: () => restarts.push(1),
    resumeFile: path.join(dir, 'sub', 'resume.json'),
    git: opts.git || fakeGit(),
    canPull: opts.canPull,
    pull: opts.pull,
    now: opts.now || Date.now,
    graceMs: 5,
  });
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const stop = () => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { base, engines, restarts, dir, stop };
}

const json = async (url, opts) => { const r = await fetch(url, opts); return { status: r.status, body: await r.json() }; };
const post = (url, body) => json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const wait = ms => new Promise(r => setTimeout(r, ms));

test('sin cambios: no hay actualización disponible', async () => {
  const t = await start({ git: fakeGit({ running: 'aaa', available: 'aaa' }) });
  try {
    const { body } = await json(t.base + '/version');
    assert.equal(body.updateAvailable, false);
    assert.equal(body.running, 'aaa');
    assert.deepEqual(body.busy, []);
  } finally { t.stop(); }
});

test('HEAD distinto pero solo docs/scripts: no cuenta como actualización', async () => {
  const t = await start({ git: fakeGit({ running: 'aaa', available: 'bbb', changed: '' }) });
  try {
    const { body } = await json(t.base + '/version');
    assert.equal(body.updateAvailable, false);
    assert.equal(body.available, 'bbb');
  } finally { t.stop(); }
});

test('cambió código que corre (src/public): hay actualización', async () => {
  const t = await start({ git: fakeGit({ running: 'aaa', available: 'bbb', changed: 'public/app.js' }) });
  try {
    const { body } = await json(t.base + '/version');
    assert.equal(body.updateAvailable, true);
  } finally { t.stop(); }
});

test('si no se puede comparar commits, avisa igual', async () => {
  const t = await start({ git: fakeGit({ running: 'aaa', available: 'bbb', changed: null }) });
  try {
    assert.equal((await json(t.base + '/version')).body.updateAvailable, true);
  } finally { t.stop(); }
});

test('la lista de ocupados junta lo que corre y lo que está en cola, por motor', async () => {
  const t = await start({ engines: {
    claude: fakeRunner({ running: ['c1'] }),
    codex: fakeRunner({ running: ['x1'], queue: ['x1', 'x2'] }),
    agy: fakeRunner(),
  } });
  try {
    const { body } = await json(t.base + '/version');
    assert.deepEqual(body.busy, [
      { engine: 'claude', id: 'c1' },
      { engine: 'codex', id: 'x1' },
      { engine: 'codex', id: 'x2' },
    ]);
  } finally { t.stop(); }
});

test('update-now sin trabajo en curso reinicia y no deja nada para retomar', async () => {
  const t = await start();
  try {
    const r = await post(t.base + '/update-now');
    assert.equal(r.status, 200);
    assert.equal(r.body.interrupted, 0);
    await wait(500);
    assert.equal(t.restarts.length, 1);
    assert.deepEqual((await json(t.base + '/update-resume')).body.items, []);
  } finally { t.stop(); }
});

test('update-now con trabajo en curso y sin force responde 409 y no toca nada', async () => {
  const agy = fakeRunner({ running: ['g1'] });
  const t = await start({ engines: { claude: fakeRunner(), codex: fakeRunner(), agy } });
  try {
    const r = await post(t.base + '/update-now');
    assert.equal(r.status, 409);
    assert.deepEqual(r.body.busy, [{ engine: 'agy', id: 'g1' }]);
    await wait(100);
    assert.equal(t.restarts.length, 0);
    assert.deepEqual(agy.cancelled, []);
    assert.equal(fs.existsSync(path.join(t.dir, 'sub', 'resume.json')), false);
  } finally { t.stop(); }
});

test('update-now con force corta lo que corre, anota qué retomar y reinicia', async () => {
  const codex = fakeRunner({ running: ['x1'] });
  const agy = fakeRunner({ running: ['g1'] });
  const t = await start({ engines: { claude: fakeRunner(), codex, agy } });
  try {
    const r = await post(t.base + '/update-now', { force: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.interrupted, 2);
    assert.deepEqual(codex.cancelled, ['x1']);
    assert.deepEqual(agy.cancelled, ['g1']);
    await wait(500);
    assert.equal(t.restarts.length, 1);
    const resume = (await json(t.base + '/update-resume')).body;
    assert.deepEqual(resume.items, [{ engine: 'codex', id: 'x1' }, { engine: 'agy', id: 'g1' }]);
  } finally { t.stop(); }
});

test('update-resume se lee una sola vez', async () => {
  const t = await start({ engines: { claude: fakeRunner(), codex: fakeRunner({ running: ['x1'] }), agy: fakeRunner() } });
  try {
    await post(t.base + '/update-now', { force: true });
    assert.equal((await json(t.base + '/update-resume')).body.items.length, 1);
    assert.deepEqual((await json(t.base + '/update-resume')).body.items, []);
  } finally { t.stop(); }
});

test('update-resume ignora lo que quedó viejo (no tiene sentido pedir continuar horas después)', async () => {
  let clock = 1_000_000;
  const t = await start({ now: () => clock, engines: { claude: fakeRunner(), codex: fakeRunner({ running: ['x1'] }), agy: fakeRunner() } });
  try {
    await post(t.base + '/update-now', { force: true });
    clock += RESUME_TTL_MS + 1000;
    assert.deepEqual((await json(t.base + '/update-resume')).body.items, []);
  } finally { t.stop(); }
});

test('instancia que no puede reiniciarse sola rechaza update-now', async () => {
  const t = await start({ canSelfRestart: false });
  try {
    const v = await json(t.base + '/version');
    assert.equal(v.body.canUpdate, false);
    assert.equal((await post(t.base + '/update-now')).status, 400);
    await wait(100);
    assert.equal(t.restarts.length, 0);
  } finally { t.stop(); }
});

test('dos pedidos seguidos de update-now reinician una sola vez', async () => {
  const t = await start();
  try {
    await post(t.base + '/update-now');
    await post(t.base + '/update-now');
    await wait(500);
    assert.equal(t.restarts.length, 1);
  } finally { t.stop(); }
});

// git falso con un remoto adelantado: HEAD..@{upstream} = 2 commits que tocan src/
function fakeGitBehind({ changed = 'src/server.js' } = {}) {
  const calls = [];
  const fn = async args => {
    calls.push(args.join(' '));
    if (args[0] === 'rev-parse') return 'aaa';
    if (args[0] === 'rev-list') return '2';
    if (args[0] === 'diff') return args.includes('HEAD') ? changed : '';
    return ''; // fetch
  };
  fn.calls = calls;
  return fn;
}

test('canPull: si GitHub tiene código nuevo que todavía no está en el disco, avisa', async () => {
  const git = fakeGitBehind();
  const t = await start({ canPull: true, git });
  try {
    const v = await json(t.base + '/version');
    assert.equal(v.body.updateAvailable, true);
    assert.equal(v.body.pullAvailable, true);
    assert.ok(git.calls.some(c => c.startsWith('fetch')));
  } finally { t.stop(); }
});

test('canPull: si lo nuevo es solo docs no molesta con el aviso', async () => {
  const t = await start({ canPull: true, git: fakeGitBehind({ changed: '' }) });
  try {
    assert.equal((await json(t.base + '/version')).body.updateAvailable, false);
  } finally { t.stop(); }
});

test('sin canPull no consulta GitHub', async () => {
  const git = fakeGitBehind();
  const t = await start({ git });
  try {
    const v = await json(t.base + '/version');
    assert.equal(v.body.pullAvailable, false);
    assert.ok(!git.calls.some(c => c.startsWith('fetch')));
  } finally { t.stop(); }
});

test('update-now con canPull baja el código y recién después reinicia', async () => {
  let pulled = 0;
  const t = await start({ canPull: true, git: fakeGitBehind(), pull: async () => { pulled++; return { ok: true }; } });
  try {
    const r = await post(t.base + '/update-now');
    assert.equal(r.status, 200);
    assert.equal(pulled, 1);
    await wait(400);
    assert.equal(t.restarts.length, 1);
  } finally { t.stop(); }
});

test('update-now: si el pull falla responde 500, no reinicia y no corta el trabajo', async () => {
  const claude = fakeRunner({ running: ['c1'] });
  const t = await start({
    canPull: true, git: fakeGitBehind(),
    engines: { claude, codex: fakeRunner(), agy: fakeRunner() },
    pull: async () => ({ ok: false, error: 'divergent branches' }),
  });
  try {
    const r = await post(t.base + '/update-now', { force: true });
    assert.equal(r.status, 500);
    assert.match(r.body.error, /divergent branches/);
    await wait(100);
    assert.equal(t.restarts.length, 0);
    assert.deepEqual(claude.cancelled, []);
  } finally { t.stop(); }
});
