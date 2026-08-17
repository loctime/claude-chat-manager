const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { isValidColor, circleDrawArgs, iconFileName, regenerateIcons } = require('../src/icon');

test('isValidColor acepta #rrggbb y rechaza el resto', () => {
  assert.equal(isValidColor('#25d366'), true);
  assert.equal(isValidColor('#FFF'), false); // formato corto no soportado por <input type=color>
  assert.equal(isValidColor('25d366'), false); // sin #
  assert.equal(isValidColor('red'), false); // nombre css, no hex
  assert.equal(isValidColor(''), false);
  assert.equal(isValidColor(undefined), false);
});

test('circleDrawArgs mantiene el mismo diseño (círculo centrado) en cualquier tamaño', () => {
  const args512 = circleDrawArgs(512, '#25d366');
  assert.deepEqual(args512, ['-size', '512x512', 'xc:#0b141a', '-fill', '#25d366', '-draw', 'circle 256,256 256,127']);
  const args192 = circleDrawArgs(192, '#ff5c5c');
  assert.deepEqual(args192, ['-size', '192x192', 'xc:#0b141a', '-fill', '#ff5c5c', '-draw', 'circle 96,96 96,48']);
});

test('iconFileName da el nombre esperado por tamaño', () => {
  assert.equal(iconFileName(192), 'icon-192.png');
  assert.equal(iconFileName(512), 'icon-512.png');
});

test('regenerateIcons rechaza color inválido sin tocar disco', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-icon-'));
  assert.throws(() => regenerateIcons('not-a-color', dir), /color inválido/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('regenerateIcons crea el cacheDir e invoca magick una vez por tamaño con los args correctos', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-icon-')), 'sub', 'icons');
  const calls = [];
  const files = regenerateIcons('#25d366', dir, {
    magickCmd: 'fake-magick',
    sizes: [192, 512],
    exec: (cmd, args) => calls.push({ cmd, args }),
  });
  assert.equal(fs.existsSync(dir), true); // mkdirSync recursive
  assert.equal(calls.length, 2);
  assert.equal(calls[0].cmd, 'fake-magick');
  assert.deepEqual(files, [path.join(dir, 'icon-192.png'), path.join(dir, 'icon-512.png')]);
  assert.ok(calls[0].args.includes(path.join(dir, 'icon-192.png')));
  assert.ok(calls[1].args.includes(path.join(dir, 'icon-512.png')));
});

test('regenerateIcons aplica magickArgs (ej. el prefijo "convert" que usa Windows)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-icon-'));
  const calls = [];
  regenerateIcons('#25d366', dir, {
    magickArgs: a => ['convert', ...a],
    exec: (cmd, args) => calls.push(args),
  });
  assert.equal(calls[0][0], 'convert');
});
