const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load, save } = require('../src/config');

function archivoTemporal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-config-'));
  return { dir, file: path.join(dir, 'config.json') };
}

test.describe('config', () => {
  test('load devuelve un objeto vacío si el archivo no existe', () => {
    const { file } = archivoTemporal();

    assert.deepEqual(load(file), {});
  });

  test('load devuelve un objeto vacío si el JSON está roto', () => {
    const { file } = archivoTemporal();
    fs.writeFileSync(file, '{ json roto');

    assert.deepEqual(load(file), {});
  });

  for (const [nombre, contenido] of [
    ['un array', '[]'],
    ['un string', '"configuración"'],
    ['null', 'null'],
  ]) {
    test(`load devuelve un objeto vacío si el JSON válido es ${nombre}`, () => {
      const { file } = archivoTemporal();
      fs.writeFileSync(file, contenido);

      assert.deepEqual(load(file), {});
    });
  }

  test('save y load conservan los datos', () => {
    const { file } = archivoTemporal();
    const config = { appName: 'Jarvis', tema: 'oscuro' };

    save(config, file);

    assert.deepEqual(load(file), config);
  });

  test('save no deja archivos temporales huérfanos', () => {
    const { dir, file } = archivoTemporal();

    save({ appName: 'Jarvis' }, file);

    assert.deepEqual(
      fs.readdirSync(dir).filter(nombre => nombre.includes('.tmp-')),
      [],
    );
  });
});
