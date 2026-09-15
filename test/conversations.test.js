const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  formatRewindNotice,
  gitCwdsForSession,
  lastCompactMetadata,
} = require('../src/routes/conversations');

test('formatRewindNotice formatea efectos reversibles e irreversibles', () => {
  const effects = [
    { summary: 'git commit realizado', reversible: true, hint: 'usar git reset' },
    { summary: 'rm -rf archivo borrado', reversible: false },
  ];
  const notice = formatRewindNotice(effects);
  assert.match(notice, /\[Aviso: se rebobinó la charla\]/);
  assert.match(notice, /- git commit realizado \[reversible\] — usar git reset/);
  assert.match(notice, /- rm -rf archivo borrado \[IRREVERSIBLE\]/);
});

test('gitCwdsForSession extrae cwds únicos preservando el orden inverso', () => {
  const file = 'dummy.jsonl';
  const mockParse = () => [
    { cwd: '/home/user/projectA' },
    { cwd: '/home/user/projectB' },
    { notCwd: true },
    { cwd: '/home/user/projectA' },
  ];
  const cwds = gitCwdsForSession(file, '/home/user/fallback', mockParse);
  assert.deepEqual(cwds, ['/home/user/projectA', '/home/user/projectB', '/home/user/projectA', '/home/user/fallback']);
});

test('lastCompactMetadata devuelve metadata del último compact boundary', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-conv-test-'));
  const sessionFile = path.join(tmpDir, 'session.jsonl');
  try {
    const lines = [
      JSON.stringify({ type: 'user', message: { text: 'hola' } }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 10000, postTokens: 2000 } }),
      JSON.stringify({ type: 'assistant', message: { text: 'chau' } }),
    ];
    fs.writeFileSync(sessionFile, lines.join('\n'));
    const meta = lastCompactMetadata(sessionFile);
    assert.deepEqual(meta, { preTokens: 10000, postTokens: 2000 });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
