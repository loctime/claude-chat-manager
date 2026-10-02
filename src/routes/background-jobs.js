const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const meta = require('../meta');
const { workerPrompt } = require('../background-jobs');

function createBackgroundJobsRouter({ jobs, runner, accountMetaFile, getActiveAccount, defaultCwd, launch, token } = {}) {
  const router = express.Router();

  // El helper que usan los turnos de Claude no tiene la cookie del navegador.
  // El token vive solo en el entorno de esos procesos y cambia en cada arranque.
  router.use((req, res, next) => {
    const supplied = req.get('authorization') || '';
    if (token && supplied !== `Bearer ${token}`) return res.status(401).json({ error: 'worker no autorizado' });
    next();
  });

  function publicJob(job) {
    if (!job) return job;
    const { prompt, ...safe } = job;
    return safe;
  }

  router.get('/', (req, res) => res.json({ jobs: jobs.list().map(publicJob) }));

  router.post('/', (req, res) => {
    const prompt = String(req.body.prompt || '').trim();
    const title = String(req.body.title || '').trim();
    const requestedCwd = String(req.body.cwd || defaultCwd || '').trim();
    if (!title) return res.status(400).json({ error: 'falta título' });
    if (!prompt) return res.status(400).json({ error: 'falta instrucción del trabajo' });
    if (prompt.length > 300_000) return res.status(413).json({ error: 'la instrucción supera 300.000 caracteres' });
    const cwd = path.resolve(requestedCwd);
    try {
      if (!fs.statSync(cwd).isDirectory()) throw new Error('no es carpeta');
    } catch {
      return res.status(400).json({ error: 'la carpeta de trabajo no existe o no es válida' });
    }
    const account = req.body.account || getActiveAccount();
    const job = jobs.create({ title, prompt, cwd, project: req.body.project, account });
    const data = meta.load(accountMetaFile(account));
    const convId = crypto.randomUUID();
    data.conversations[convId] = {
      currentSessionId: null,
      projectDir: cwd,
      project: req.body.project || undefined,
      name: `⚙️ ${job.title}`,
      backgroundJobId: job.id,
      backgroundJob: true,
    };
    meta.save(data, accountMetaFile(account));
    const prepared = jobs.update(job.id, { conversationId: convId });
    launch(prepared, { resumed: false });
    res.status(201).json({ job: publicJob(jobs.get(job.id)) });
  });

  router.post('/:id/resume', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'trabajo no encontrado' });
    if (!['interrupted', 'failed'].includes(job.status)) return res.status(409).json({ error: 'solo se puede reanudar un trabajo interrumpido o fallido' });
    if (runner.isBusy(job.conversationId)) return res.status(409).json({ error: 'el worker todavía está ocupado' });
    const updated = jobs.update(job.id, { status: 'queued', error: undefined, finishedAt: undefined });
    launch(updated, { resumed: true });
    res.status(202).json({ job: publicJob(jobs.get(job.id)) });
  });

  router.delete('/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'trabajo no encontrado' });
    const cancelled = runner.cancel(job.conversationId);
    jobs.update(job.id, { status: 'cancelled', cancelledAt: new Date().toISOString() });
    res.json({ cancelled });
  });

  return router;
}

function launchBackgroundJob(runner, jobs, accountMetaFile, job, { resumed = false } = {}) {
  runner.send({
    convId: job.conversationId,
    cwd: job.cwd,
    account: job.account,
    text: workerPrompt(job.prompt, { resumed }),
    resolveSessionId: () => meta.load(accountMetaFile(job.account)).conversations[job.conversationId]?.currentSessionId,
  });
}

module.exports = { createBackgroundJobsRouter, launchBackgroundJob };
