const express = require('express');
const os = require('os');
const crypto = require('crypto');
const meta = require('../meta');
const codexScanner = require('../codex-scanner');
const gitSync = require('../git-sync');
const { CodexAvailability } = require('../codex-availability');
const { CodexUsageService } = require('../codex-usage');

function createCodexRouter({
  codexRunner,
  codexSseClients,
  codexMetaFile,
  resolveConversationGitRepo,
  inferRepoFromMessage,
  registerProject,
  getHiddenProjectNames,
}) {
  const router = express.Router();
  const codexAvailability = new CodexAvailability();
  const codexUsage = new CodexUsageService();

  function codexConvStatus(convId) {
    return codexRunner.running.has(convId) ? 'running' : codexRunner.isBusy(convId) ? 'queued' : 'idle';
  }

  // Límites de la cuenta ChatGPT con la que está logueado Codex. Se lee del
  // App Server local oficial, no de los límites de Claude ni de una API key.
  router.get('/status', async (req, res) => {
    res.json(await codexAvailability.get());
  });

  router.get('/usage', async (req, res) => {
    try {
      res.json(await codexUsage.get({ force: req.query.force === '1' }));
    } catch (err) {
      res.status(503).json({ error: 'No se pudo consultar el uso de Codex: ' + err.message });
    }
  });

  router.post('/conversations', (req, res) => {
    const projectDir = process.env.CCM_DEFAULT_PROJECT_DIR || os.homedir();
    const convId = crypto.randomUUID();
    const data = meta.load(codexMetaFile);
    const project = (req.body.project || '').trim() || undefined;
    data.conversations[convId] = { currentSessionId: null, projectDir, project };
    if (project && typeof registerProject === 'function') registerProject(project);
    meta.save(data, codexMetaFile);
    res.status(201).json({ convId, projectDir, project });
  });

  router.get('/tree', async (req, res) => {
    const data = meta.load(codexMetaFile);
    const convs = [];
    let metadataChanged = false;
    const projectFilter = req.query.project;
    for (const [convId, c] of Object.entries(data.conversations)) {
      if (c.hidden) continue;
      if (projectFilter && (projectFilter === '__none__' ? !!c.project : c.project !== projectFilter)) continue;
      // Evitar listSessions(): escanea y parsea CADA rollout bajo ~/.codex/sessions/
      // (todo el uso histórico de Codex CLI en la máquina, no solo lo de Jarvis) para
      // descartar casi todo — acá solo hace falta la sesión de esta conv puntual.
      // findSessionFile() es barato (readdir), sessionInfo() cachea por mtime.
      const file = c.currentSessionId ? codexScanner.findSessionFile(c.currentSessionId) : null;
      const s = (file && codexScanner.sessionInfo(file)) || {};
      // Charlas creadas antes de la asociación automática no tienen gitRepo
      // todavía. Resolverlo una vez al listarlas permite mostrar el proyecto en
      // el título sin obligar a abrir cada conversación.
      if (!c.gitRepo && file) {
        const repo = await resolveConversationGitRepo(c, file, codexScanner.parseJsonl, codexScanner.toChatMessages);
        if (repo) {
          c.gitRepo = repo;
          metadataChanged = true;
        }
      }
      convs.push({
        convId,
        projectDir: c.projectDir || null,
        gitRepo: c.gitRepo || null,
        project: c.project || null,
        name: c.name || s.snippet || '(nueva conversación)',
        snippet: s.snippet || '',
        lastActivity: s.lastActivity || null,
        messageCount: s.messageCount || 0,
        pinned: !!c.pinned,
        archived: !!c.archived,
        unread: !!c.unread,
        aiTitle: !!c.aiTitle,
        // currentSessionId: NO se manda en la respuesta (el cliente no lo usa),
        // pero hace falta acá adentro — el filtro de unreadTotal más abajo lo
        // exige, y como nunca se agregaba a este objeto, esa condición daba
        // falso SIEMPRE: la pestaña Codex jamás se prendía, para ninguna
        // conversación, desde que existe esta función. Bug real, no de caché.
        currentSessionId: c.currentSessionId || null,
        status: codexConvStatus(convId),
      });
    }
    if (metadataChanged) meta.save(data, codexMetaFile);
    const showArchived = req.query.archived === '1';
    let filtered = showArchived ? convs.filter(c => c.archived) : convs.filter(c => !c.archived);
    if (projectFilter) {
      filtered = projectFilter === '__none__'
        ? filtered.filter(c => !c.project)
        : filtered.filter(c => c.project === projectFilter);
    } else {
      const hidden = typeof getHiddenProjectNames === 'function' ? getHiddenProjectNames() : new Set();
      if (hidden && hidden.size > 0) filtered = filtered.filter(c => !c.project || !hidden.has(c.project));
    }
    filtered.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.lastActivity || '').localeCompare(a.lastActivity || '');
    });
    res.json({
      conversations: filtered,
      archivedTotal: convs.filter(c => c.archived).length,
      // Solo una sesión real puede tener una respuesta pendiente. Ignoramos
      // flags huérfanos de borradores antiguos que nunca llegaron a iniciarse.
      unreadTotal: convs.filter(c => !c.archived && c.currentSessionId && c.unread).length,
    });
  });

  router.patch('/conversations/:id', (req, res) => {
    const data = meta.load(codexMetaFile);
    const conv = data.conversations[req.params.id];
    if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
    if ('name' in req.body) {
      conv.name = (req.body.name || '').trim() || undefined;
      conv.aiTitle = false;
    }
    if ('pinned' in req.body) conv.pinned = !!req.body.pinned;
    if ('archived' in req.body) conv.archived = !!req.body.archived;
    if ('unread' in req.body) conv.unread = !!req.body.unread;
    if ('project' in req.body) {
      conv.project = (req.body.project || '').trim() || undefined;
      if (conv.project && typeof registerProject === 'function') registerProject(conv.project);
    }
    // hidden: saca la conversación de las dos listas (activas y archivadas) sin
    // tocar el .jsonl real — a diferencia de un borrado, es reversible a mano
    // editando meta.json si hiciera falta.
    if ('hidden' in req.body) conv.hidden = !!req.body.hidden;
    meta.save(data, codexMetaFile);
    res.json({ ok: true });
  });

  router.get('/conversations/:id/messages', (req, res) => {
    const data = meta.load(codexMetaFile);
    const conv = data.conversations[req.params.id];
    if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
    if (!conv.currentSessionId) return res.json([]);
    const file = codexScanner.findSessionFile(conv.currentSessionId);
    res.json(file ? codexScanner.getMessages(file) : []);
  });

  router.post('/conversations/:id/message', async (req, res) => {
    const convId = req.params.id;
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'mensaje vacío' });
    const data = meta.load(codexMetaFile);
    const conv = data.conversations[convId];
    if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
    const wasRunning = codexRunner.running.has(convId);
    if (!conv.gitRepo) {
      const inferredRepo = await inferRepoFromMessage(text);
      if (inferredRepo) {
        conv.gitRepo = inferredRepo;
        meta.save(data, codexMetaFile);
      }
    }
    let outgoing = text;
    if (conv.project && !conv.currentSessionId && !conv.projectAnnounced) {
      if (!conv.gitRepo && typeof inferRepoFromMessage === 'function') {
        const inferredRepo = await inferRepoFromMessage(conv.project);
        if (inferredRepo) conv.gitRepo = inferredRepo;
      }
      const folderNote = conv.gitRepo ? `, carpeta: ${conv.gitRepo}` : '';
      outgoing = `[Estamos trabajando en el proyecto "${conv.project}"${folderNote}]\n\n${outgoing}`;
      conv.projectAnnounced = true;
      meta.save(data, codexMetaFile);
    }
    const cwd = conv.projectDir || os.homedir();
    const imagePath = req.body.imagePath || undefined;
    // Cuando el thread ya existe, usar la cola nativa de Codex: lo recibe el
    // proceso que está trabajando, sin interrumpirlo. En el primer turno aún
    // no hay thread_id; el runner lo retiene y lo ejecuta serialmente.
    if (wasRunning && conv.currentSessionId && codexRunner.queueFollowup({ sessionId: conv.currentSessionId, cwd, text: outgoing, imagePath })) {
      return res.status(202).json({ queued: true, nativeQueue: true });
    }
    codexRunner.send({
      convId, sessionId: conv.currentSessionId, cwd, text: outgoing, imagePath,
      resolveSessionId: () => meta.load(codexMetaFile).conversations[convId]?.currentSessionId,
    });
    res.status(202).json({ queued: true, nativeQueue: false });
  });

  // /compact es un comando nativo de Codex CLI. Conserva la sesión y reduce
  // el contexto que arrastra, no genera un resumen como respuesta normal.
  router.post('/conversations/:id/compact', (req, res) => {
    const convId = req.params.id;
    if (codexRunner.isBusy(convId)) return res.status(409).json({ error: 'esa conversación está procesando una tarea' });
    const data = meta.load(codexMetaFile);
    const conv = data.conversations[convId];
    if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
    if (!conv.currentSessionId) return res.status(400).json({ error: 'todavía no hay contexto para compactar' });
    codexRunner.send({ convId, sessionId: conv.currentSessionId, cwd: conv.projectDir || os.homedir(), text: '/compact', rawPrompt: true });
    res.status(202).json({ queued: true });
  });

  router.post('/conversations/:id/git-sync', async (req, res) => {
    const convId = req.params.id;
    if (codexRunner.isBusy(convId)) return res.status(409).json({ error: 'esa conversación está procesando una tarea' });
    const data = meta.load(codexMetaFile);
    const conv = data.conversations[convId];
    if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
    const file = conv.currentSessionId ? codexScanner.findSessionFile(conv.currentSessionId) : null;
    const repo = await resolveConversationGitRepo(conv, file, codexScanner.parseJsonl, codexScanner.toChatMessages);
    if (!repo) return res.status(400).json({ error: 'no encontré un repositorio Git asociado a esta conversación' });
    if (conv.gitRepo !== repo) {
      conv.gitRepo = repo;
      meta.save(data, codexMetaFile);
    }
    try {
      res.json(await gitSync.syncRepo(repo));
    } catch (err) {
      const detail = (err.stderr || err.stdout || err.message || 'falló Git').trim().slice(0, 1000);
      res.status(409).json({ error: detail });
    }
  });

  router.get('/conversations/:id/repo', async (req, res) => {
    const data = meta.load(codexMetaFile);
    const conv = data.conversations[req.params.id];
    if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
    const file = conv.currentSessionId ? codexScanner.findSessionFile(conv.currentSessionId) : null;
    const repo = await resolveConversationGitRepo(conv, file, codexScanner.parseJsonl, codexScanner.toChatMessages);
    if (repo && conv.gitRepo !== repo) {
      conv.gitRepo = repo;
      meta.save(data, codexMetaFile);
    }
    res.json({ repo: repo || null });
  });

  router.delete('/conversations/:id/message', (req, res) => {
    res.json({ cancelled: codexRunner.cancel(req.params.id) });
  });

  router.get('/conversations/:id/stream', (req, res) => {
    const convId = req.params.id;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('\n');
    if (!codexSseClients.has(convId)) codexSseClients.set(convId, new Set());
    codexSseClients.get(convId).add(res);
    const st = codexConvStatus(convId);
    // Send "idle" on connect too. If SSE misses the last event of a turn,
    // EventSource reconnects after the runner has stopped and used to receive
    // no status at all, leaving the composer incorrectly locked.
    res.write(`data: ${JSON.stringify({ kind: 'status', status: st })}\n\n`);
    // Cloudflare Tunnel corta conexiones SSE inactivas (~100s de idle).
    // Sin este ping, un turno largo de Claude sin output deja el stream mudo
    // y el edge lo mata a mitad de camino, perdiendo el evento 'idle' final.
    const heartbeat = setInterval(() => res.write(':heartbeat\n\n'), 20000);
    req.on('close', () => {
      clearInterval(heartbeat);
      const set = codexSseClients.get(convId);
      if (!set) return;
      set.delete(res);
      if (set.size === 0) codexSseClients.delete(convId);
    });
  });

  return router;
}

module.exports = { createCodexRouter };
