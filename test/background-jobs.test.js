const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BackgroundJobs, workerPrompt } = require('../src/background-jobs');

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-background-jobs-')), 'jobs.json');
}

test('un trabajo persiste y se puede actualizar sin exponer el prompt en listados', () => {
  const jobs = new BackgroundJobs(tempFile());
  const created = jobs.create({ title: 'Migrar módulo', prompt: 'instrucción privada', cwd: 'C:/repo', account: 'User' });
  assert.equal(created.status, 'queued');
  jobs.update(created.id, { status: 'running', conversationId: 'conv-1' });
  const restored = new BackgroundJobs(jobs.file).get(created.id);
  assert.equal(restored.status, 'running');
  assert.equal(restored.conversationId, 'conv-1');
  assert.equal(restored.prompt, 'instrucción privada');
});

test('un reinicio no declara terminado un worker que quedó en vuelo', () => {
  const jobs = new BackgroundJobs(tempFile());
  const created = jobs.create({ title: 'Largo', prompt: 'hacer', cwd: 'C:/repo' });
  jobs.update(created.id, { status: 'running' });
  jobs.recoverAfterRestart();
  const recovered = jobs.get(created.id);
  assert.equal(recovered.status, 'interrupted');
  assert.match(recovered.error, /reinició/i);
});

test('el prompt del worker prohíbe el Agent nativo y conserva la tarea', () => {
  const prompt = workerPrompt('Portá el componente completo.');
  assert.match(prompt, /No uses la herramienta Agent/);
  assert.match(prompt, /Portá el componente completo/);
  assert.match(workerPrompt('x', { resumed: true }), /interrumpido/i);
});
