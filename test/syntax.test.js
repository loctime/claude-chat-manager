const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

test('todos los archivos JS en src/ y public/ tienen sintaxis valida', () => {
  const root = path.resolve(__dirname, '..');
  function checkDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && e.name !== 'vendor') {
        checkDir(full);
      } else if (e.isFile() && e.name.endsWith('.js')) {
        assert.doesNotThrow(() => {
          execFileSync(process.execPath, ['-c', full]);
        }, `Error de sintaxis en ${full}`);
      }
    }
  }
  checkDir(path.join(root, 'src'));
  checkDir(path.join(root, 'public'));
});
