const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRepo, syncRepo } = require('../src/git-sync');

test('resolveRepo usa el cwd Git más reciente que resulte válido', async () => {
  const calls = [];
  const run = async (args, cwd) => {
    calls.push([args, cwd]);
    if (cwd === 'C:/proyecto') return 'C:/proyecto';
    throw new Error('no es repo');
  };
  assert.equal(await resolveRepo(['C:/home', 'C:/proyecto', 'C:/proyecto'], run), 'C:/proyecto');
  assert.deepEqual(calls, [
    [['rev-parse', '--show-toplevel'], 'C:/home'],
    [['rev-parse', '--show-toplevel'], 'C:/proyecto'],
  ]);
});

test('syncRepo commitea antes de pull --rebase cuando hay cambios', async () => {
  const calls = [];
  const outputs = [' M app.js', '', '', 'a1b2c3d', 'Already up to date.', 'Everything up-to-date'];
  const run = async (args, cwd) => { calls.push([args, cwd]); return outputs.shift(); };
  const result = await syncRepo('C:/repo', { run, message: 'chore: sync changes' });
  assert.equal(result.commit, 'a1b2c3d');
  assert.deepEqual(calls.map(([args]) => args), [
    ['status', '--porcelain'], ['add', '-A'], ['commit', '-m', 'chore: sync changes'],
    ['rev-parse', '--short', 'HEAD'], ['pull', '--rebase'], ['push'],
  ]);
});

test('syncRepo hace pull y push aunque no haya cambios para commitear', async () => {
  const calls = [];
  const run = async (args, cwd) => { calls.push([args, cwd]); return ''; };
  const result = await syncRepo('C:/repo', { run });
  assert.equal(result.committed, false);
  assert.deepEqual(calls.map(([args]) => args), [['status', '--porcelain'], ['pull', '--rebase'], ['push']]);
});
