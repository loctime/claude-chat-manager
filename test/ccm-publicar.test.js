const test = require('node:test');
const assert = require('node:assert');
const P = require('../scripts/publicar/ccm-publicar.js');

test('validarNombre acepta nombres válidos y rechaza el resto', () => {
  assert.strictEqual(P.validarNombre('rrhh-admin'), null);
  assert.strictEqual(P.validarNombre('abc'), null);
  for (const mal of ['ab', 'Mayus', 'con espacio', 'a.b', '-ab', 'ab-', 'x'.repeat(31), '', null, '../etc', 'a/b']) {
    assert.ok(P.validarNombre(mal), `debería rechazar ${JSON.stringify(mal)}`);
  }
});

test('validarNombre rechaza nombres reservados', () => {
  for (const r of ['www', 'aprobar', 'chat', 'delpo', 'jarvis']) assert.ok(P.validarNombre(r), r);
});

test('tokenValido compara contra el hash y no acepta otra cosa', () => {
  const h = P.hashToken('secreto');
  assert.ok(P.tokenValido('secreto', h));
  assert.ok(!P.tokenValido('otro', h));
  assert.ok(!P.tokenValido('secreto', 'zz'));
  assert.ok(!P.tokenValido(undefined, h));
});

test('bloquesCaddy: privado lleva basic_auth, público no', () => {
  const out = P.bloquesCaddy([
    { nombre: 'rrhh-admin', privado: true, user: 'rrhh-admin', hash: '$2a$14$abc' },
    { nombre: 'landing', privado: false },
  ]);
  assert.match(out, /rrhh-admin\.controlapps\.ar \{[\s\S]*basic_auth \{\s+rrhh-admin \$2a\$14\$abc\s+\}[\s\S]*file_server/);
  const publico = out.split('landing.controlapps.ar')[1];
  assert.ok(!publico.includes('basic_auth'));
});

test('paginaSolicitud escapa el contenido y solo ofrece botones si está pendiente', () => {
  const meta = {
    cuenta: 'colab-x', nombre: 'sitio', privado: false, descripcion: '<script>alert(1)</script>',
    creada: Date.now(), totalArchivos: 1, totalBytes: 10, archivos: [{ ruta: '<b>.html', bytes: 10 }], avisos: ['a & b'],
  };
  const pend = P.paginaSolicitud(meta, 'pendiente', '/a/x/y');
  assert.ok(!pend.includes('<script>alert'));
  assert.ok(pend.includes('&lt;script&gt;'));
  assert.ok(pend.includes('value="aprobar"'));
  assert.ok(pend.includes('SIN CLAVE'));
  const hecho = P.paginaSolicitud(meta, 'publicado', '/a/x/y');
  assert.ok(!hecho.includes('value="aprobar"'));
});

test('archivos con pinta de secretos se detectan', () => {
  for (const f of ['.env', '.env.local', 'clave.pem', 'id_rsa', 'serviceAccount-prod.json', 'credentials.json']) {
    assert.ok(P.NOMBRE_ARCHIVO_PROHIBIDO.test(f), f);
  }
  for (const f of ['index.html', 'app.js', 'envio.html', 'monkey.png']) assert.ok(!P.NOMBRE_ARCHIVO_PROHIBIDO.test(f), f);
  assert.ok(P.PATRONES_CLAVE.some((re) => re.test('-----BEGIN RSA PRIVATE KEY-----')));
});
