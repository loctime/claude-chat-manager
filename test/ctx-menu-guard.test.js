const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Bug real (05/10/2026): el menú contextual de AgY cerraba con un listener global de
// `click`/`touchstart` en captura SIN mirar si el toque era dentro del menú. En pantalla táctil,
// apoyar el dedo en un botón borraba el menú antes del click y la acción caía sobre la
// conversación de atrás. Todo `dismiss` de un menú tiene que ignorar los toques dentro de él.
const PUBLIC = path.join(__dirname, '..', 'public');

test('todo `dismiss` de menú ignora los toques dentro del menú (menu.contains)', () => {
  const sinGuarda = [];
  let total = 0;
  for (const file of fs.readdirSync(PUBLIC).filter(f => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    const re = /(?:const|function)\s+dismiss\b/g;
    let m;
    while ((m = re.exec(src))) {
      total++;
      const cuerpo = src.slice(m.index, m.index + 400);
      if (!/\.contains\(/.test(cuerpo)) sinGuarda.push(`${file}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.ok(total >= 10, `se esperaban varios dismiss en public/*.js, se encontraron ${total}`);
  assert.deepEqual(sinGuarda, [], 'estos dismiss no tienen guarda contra toques dentro del menú: ' + sinGuarda.join(', '));
});

test('el menú de AgY frena touchstart dentro del menú y cierra solo desde fuera', () => {
  const src = fs.readFileSync(path.join(PUBLIC, 'gemini.js'), 'utf8');
  const fn = src.slice(src.indexOf('function showGeminiConvMenu'), src.indexOf('async function refreshGeminiCostBadge'));
  assert.match(fn, /menu\.addEventListener\('touchstart', e => e\.stopPropagation\(\)/);
  assert.match(fn, /if \(menu\.contains\(e\.target\)\) return;/);
});
