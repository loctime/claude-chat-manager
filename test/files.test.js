const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { folderExceedsLimit, MAX_ZIP_BYTES } = require('../src/routes/files');

test('folderExceedsLimit detecta carpetas que superan el límite de bytes', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-files-test-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'file1.dat'), Buffer.alloc(100));
    fs.writeFileSync(path.join(tmpDir, 'file2.dat'), Buffer.alloc(150));

    // Límite 50 bytes -> supera
    assert.equal(folderExceedsLimit(tmpDir, 50), true);
    // Límite 200 bytes -> supera (100 + 150 = 250 > 200)
    assert.equal(folderExceedsLimit(tmpDir, 200), true);
    // Límite 500 bytes -> no supera
    assert.equal(folderExceedsLimit(tmpDir, 500), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('folderExceedsLimit maneja carpetas anidadas', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-files-nested-'));
  try {
    const sub = path.join(tmpDir, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'deep.dat'), Buffer.alloc(300));

    assert.equal(folderExceedsLimit(tmpDir, 200), true);
    assert.equal(folderExceedsLimit(tmpDir, 400), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
