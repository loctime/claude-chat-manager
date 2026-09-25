'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('el carrusel acepta swipes iniciados sobre filas que no manejan el gesto', () => {
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(app, /e\.target\.closest\('\.conv-engine-claude'\)/);
  assert.doesNotMatch(app, /e\.target\.closest\('\.conv:not\(\.notebook-row\)'\)/);
});

test('la fila de Codex entrega ambas coordenadas al carrusel', () => {
  const codex = fs.readFileSync(path.join(root, 'public', 'codex.js'), 'utf8');
  assert.match(codex, /paneSwipeStart\(startX, startY\)/);
  assert.match(codex, /paneSwipeMove\(touch\.clientX, touch\.clientY\)/);
});

test('las pestañas conservan el orden visual elegido', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const nav = html.match(/<nav id="pane-tabs">([\s\S]*?)<\/nav>/)[1];
  const panes = [...nav.matchAll(/data-pane="(\d+)"/g)].map(m => Number(m[1]));
  assert.deepStrictEqual(panes, [0, 1, 6, 3, 4, 5, 2]);

  const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
  assert.doesNotMatch(css, /\.pane-tab\[data-pane="2"\]\s*\{\s*order:/);
});

test('el swipe usa el mismo orden que las pestañas visibles y deja Archivado afuera', () => {
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(app, /const PANE_SWIPE_ORDER = \[0, 6, 3, 4, 5, 2\]/);
  assert.match(app, /await goToPane\(order\[currentIndex \+ 1\]\)/);
  assert.match(app, /await goToPane\(order\[currentIndex - 1\]\)/);
});
