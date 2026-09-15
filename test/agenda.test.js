const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const agenda = require('../src/agenda');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-agenda-')), 'sub', 'agenda.json');

test('addCustomTask con execution chat (default) no agrega scriptModule/verified', () => {
  const task = agenda.addCustomTask({ title: 'Rutina X', group: 'Grupo' }, tmpFile());
  assert.equal(task.execution, 'chat');
  assert.equal(task.scriptModule, undefined);
  assert.equal(task.verified, undefined);
});

test('addCustomTask con execution script arranca verified:false', () => {
  const task = agenda.addCustomTask({ title: 'Facturar X', group: 'Facturación', execution: 'script', scriptModule: 'facturar_x.js' }, tmpFile());
  assert.equal(task.execution, 'script');
  assert.equal(task.scriptModule, 'facturar_x.js');
  assert.equal(task.verified, false);
});

test('addCustomTask conserva autoPrompt para una tarea chat aprendida', () => {
  const task = agenda.addCustomTask({ title: 'Rutina guiada', autoPrompt: 'Hacé la rutina con cuidado.' }, tmpFile());
  assert.equal(task.execution, 'chat');
  assert.equal(task.autoPrompt, 'Hacé la rutina con cuidado.');
});

test('list expone defaults de corrida para una tarea script', () => {
  const file = tmpFile();
  agenda.addCustomTask({ title: 'Facturar Y', execution: 'script', scriptModule: 'facturar_y.js' }, file);
  const [task] = agenda.list(file);
  assert.equal(task.execution, 'script');
  assert.equal(task.scriptModule, 'facturar_y.js');
  assert.equal(task.verified, false);
  assert.equal(task.runStatus, 'idle');
  assert.equal(task.runUi, null);
  assert.equal(task.runError, null);
});

test('setTaskVerified activa solo una tarea script', () => {
  const file = tmpFile();
  const task = agenda.addCustomTask({ title: 'Facturar Z', execution: 'script', scriptModule: 'facturar_z.js' }, file);
  assert.equal(agenda.setTaskVerified(task.id, true, file).verified, true);
  assert.equal(agenda.list(file)[0].verified, true);
  assert.equal(agenda.setTaskVerified('no-existe', true, file), null);
  const chat = agenda.addCustomTask({ title: 'Charla normal' }, file);
  assert.equal(agenda.setTaskVerified(chat.id, true, file), null);
});

test('saveRunResult guarda estado y marca hecha al terminar', () => {
  const file = tmpFile();
  const task = agenda.addCustomTask({ title: 'Facturar W', execution: 'script', scriptModule: 'facturar_w.js' }, file);
  agenda.saveRunResult(task.id, { state: { paso: 1 }, ui: { type: 'pedir-dato', pregunta: '¿Código?' } }, file);
  let listed = agenda.list(file)[0];
  assert.equal(listed.runStatus, 'waiting');
  assert.deepEqual(agenda.getRunState(task.id, file), { paso: 1 });
  agenda.saveRunResult(task.id, { state: { paso: 2 }, ui: { type: 'listo' } }, file);
  listed = agenda.list(file)[0];
  assert.equal(listed.state, 'hecho');
  assert.equal(listed.runStatus, 'done');
});

test('saveRunError preserva estado y resetRun limpia solo la corrida', () => {
  const file = tmpFile();
  const task = agenda.addCustomTask({ title: 'Facturar U', execution: 'script', scriptModule: 'facturar_u.js' }, file);
  agenda.saveRunResult(task.id, { state: { paso: 1 }, ui: { type: 'accion', boton: 'Seguir' } }, file);
  agenda.saveRunError(task.id, 'El portal no respondió', file);
  let listed = agenda.list(file)[0];
  assert.equal(listed.runStatus, 'error');
  assert.equal(listed.runError, 'El portal no respondió');
  assert.deepEqual(agenda.getRunState(task.id, file), { paso: 1 });
  agenda.resetRun(task.id, file);
  listed = agenda.list(file)[0];
  assert.equal(listed.runStatus, 'idle');
  assert.equal(listed.runUi, null);
  assert.deepEqual(agenda.getRunState(task.id, file), {});
});

test('markDone sigue funcionando con un archivo explícito', () => {
  const file = tmpFile();
  const task = agenda.addCustomTask({ title: 'Tarea vieja' }, file);
  agenda.markDone(task.id, true, file);
  assert.equal(agenda.list(file)[0].state, 'hecho');
});
