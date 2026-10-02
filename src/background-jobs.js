const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function empty() { return { version: 1, jobs: [] }; }

function read(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || !Array.isArray(value.jobs)) throw new Error('formato inválido');
    return value;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[background-jobs] no se pudo leer el registro:', err.message);
    return empty();
  }
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

class BackgroundJobs {
  constructor(file) {
    this.file = file;
  }

  list() { return read(this.file).jobs.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  get(id) { return read(this.file).jobs.find(job => job.id === id) || null; }

  create({ title, prompt, cwd, project, account }) {
    const data = read(this.file);
    const now = new Date().toISOString();
    const job = {
      id: crypto.randomUUID(),
      title: String(title || '').trim().slice(0, 160),
      prompt: String(prompt || ''),
      cwd,
      project: project || undefined,
      account,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      conversationId: null,
    };
    data.jobs.push(job);
    write(this.file, data);
    return job;
  }

  update(id, patch) {
    const data = read(this.file);
    const job = data.jobs.find(candidate => candidate.id === id);
    if (!job) return null;
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    write(this.file, data);
    return job;
  }

  findByConversation(convId) {
    return read(this.file).jobs.find(job => job.conversationId === convId) || null;
  }

  recoverAfterRestart() {
    const data = read(this.file);
    let changed = false;
    for (const job of data.jobs) {
      if (job.status === 'running') {
        job.status = 'interrupted';
        job.error = 'Jarvis se reinició mientras este trabajo estaba corriendo. Podés reanudarlo: el worker revisará el estado real antes de continuar.';
        job.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) write(this.file, data);
  }
}

function workerPrompt(prompt, { resumed = false } = {}) {
  const continuation = resumed
    ? 'Este trabajo fue interrumpido por un reinicio de Jarvis. Revisá primero el filesystem y el estado real para retomar sin duplicar ni deshacer avances.'
    : 'Este es un trabajo independiente de larga duración.';
  return `[TRABAJO DE FONDO DE JARVIS]\n${continuation}\n\nNo uses la herramienta Agent, no delegues a subagentes y no crees otro trabajo de fondo: los subagentes nativos dependen de un proceso temporal y no sobreviven fuera de este worker. Hacé el trabajo directamente en este proceso, persistí los cambios necesarios, verificá el resultado y terminá con un reporte breve y concreto.\n\n[Tarea]\n${prompt}`;
}

module.exports = { BackgroundJobs, workerPrompt };
