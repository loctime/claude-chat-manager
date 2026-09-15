const express = require('express');
const os = require('os');
const crypto = require('crypto');
const meta = require('../meta');
const geminiScanner = require('../gemini-scanner');
const gitSync = require('../git-sync');
const { AntigravityUsageService } = require('../antigravity-usage');

const AGY_MODELS = [
  { id: 'claude-sonnet-4-6', name: 'Sonnet' },
  { id: 'gemini-3.8-flash-high', name: 'Flash High' },
  { id: 'gemini-3.8-flash-medium', name: 'Flash Medium' },
];

function createAntigravityRouter() {
  const router = express.Router();
  const antigravityUsage = new AntigravityUsageService();

  router.get('/models', (req, res) => {
    res.json({ models: AGY_MODELS });
  });

  router.get('/usage', async (req, res) => {
    try {
      res.json(await antigravityUsage.get({ force: req.query.force === '1' }));
    } catch (err) {
      res.status(503).json({ error: 'No se pudo consultar el uso de Antigravity: ' + err.message });
    }
  });

  return router;
}

function createGeminiRouter({
  geminiRunner,
  geminiSseClients,
  geminiMetaFile,
  geminiTurnStartedAt,
  inferRepoFromMessage,
  inferRepoFromMessages,
}) {
  const router = express.Router();

  function geminiConvStatus(convId) {
    return geminiRunner.isBusy(convId) ? 'running' : 'idle';
  }

  function resolveGeminiConv(data, id) {
    if (data.conversations[id]) return { convId: id, conv: data.conversations[id] };
    if (data.merged && data.merged[id] && data.conversations[data.merged[id]]) {
      return { convId: data.merged[id], conv: data.conversations[data.merged[id]] };
    }
    return { convId: id, conv: null };
  }

  router.post('/conversations', (req, res) => {
    const convId = crypto.randomUUID(), data = meta.load(geminiMetaFile);
    const projectDir = req.body.projectDir || process.env.CCM_DEFAULT_PROJECT_DIR || os.homedir();
    const model = req.body.model || 'gemini-3.8-flash-high';
    data.conversations[convId] = {
      currentSessionId: null,
      projectDir,
      model,
      messages: [],
      lastActivity: null,
    };
    meta.save(data, geminiMetaFile);
    res.status(201).json({ convId, projectDir, model });
  });

  router.get('/tree', async (req, res) => {
    const data = meta.load(geminiMetaFile);
    let metadataChanged = false;

    // 1. Limpiar borradores vacíos abandonados y deduplicar conversaciones por currentSessionId
    const bySession = new Map(); // sessionId -> [convId]
    for (const [convId, c] of Object.entries(data.conversations)) {
      // Si es un borrador vacío abandonado (sin sesión, sin mensajes y no está corriendo ahora mismo)
      if (!c.currentSessionId && (!c.messages || c.messages.length === 0) && !geminiRunner.isBusy(convId)) {
        delete data.conversations[convId];
        metadataChanged = true;
        continue;
      }
      if (c.currentSessionId) {
        if (!bySession.has(c.currentSessionId)) bySession.set(c.currentSessionId, []);
        bySession.get(c.currentSessionId).push(convId);
      }
    }

    for (const [sessionId, convIds] of bySession) {
      if (convIds.length > 1) {
        // Elegir la entrada canónica: más mensajes primero, luego actividad más reciente
        convIds.sort((a, b) => {
          const ca = data.conversations[a], cb = data.conversations[b];
          const msgsA = ca.messages?.length || 0, msgsB = cb.messages?.length || 0;
          if (msgsB !== msgsA) return msgsB - msgsA;
          return String(cb.lastActivity || '').localeCompare(String(ca.lastActivity || ''));
        });
        const canonicalId = convIds[0];
        const canonical = data.conversations[canonicalId];
        data.merged = data.merged || {};
        for (let i = 1; i < convIds.length; i++) {
          const dupId = convIds[i];
          const dup = data.conversations[dupId];
          if (!canonical.name && dup.name) canonical.name = dup.name;
          if (!canonical.gitRepo && dup.gitRepo) canonical.gitRepo = dup.gitRepo;
          if (dup.pinned) canonical.pinned = true;
          if (dup.unread) canonical.unread = true;
          data.merged[dupId] = canonicalId;
          delete data.conversations[dupId];
        }
        metadataChanged = true;
      }
    }

    // 2. Auto-descubrir sesiones creadas en Antigravity CLI que no estén registradas en gemini-meta.json
    const knownSessions = new Set(Object.values(data.conversations).map(c => c.currentSessionId).filter(Boolean));
    for (const sId of geminiRunner.getActiveSessionIds()) knownSessions.add(sId);

    // Si hay una conversación en vuelo que arrancó sin sessionId, cualquier sesión nueva en disco le pertenece
    const pendingConvId = Object.keys(data.conversations).find(id => geminiRunner.isBusy(id) && !data.conversations[id].currentSessionId);

    for (const session of geminiScanner.listSessions()) {
      if (knownSessions.has(session.sessionId)) continue;

      if (pendingConvId) {
        const pendingConv = data.conversations[pendingConvId];
        pendingConv.currentSessionId = session.sessionId;
        knownSessions.add(session.sessionId);
        metadataChanged = true;
        continue;
      }

      const convId = crypto.randomUUID();
      data.conversations[convId] = {
        currentSessionId: session.sessionId,
        projectDir: session.workspace || process.env.CCM_DEFAULT_PROJECT_DIR || os.homedir(),
        name: session.snippet || '(conversación externa)',
        messages: [],
        lastActivity: session.lastActivity,
        model: 'gemini-3.8-flash-high',
      };
      knownSessions.add(session.sessionId);
      metadataChanged = true;
    }

    const conversations = [];
    const seenSessions = new Set();
    for (const [convId, c] of Object.entries(data.conversations)) {
      if (c.hidden) continue;
      if (c.currentSessionId) {
        if (seenSessions.has(c.currentSessionId)) continue;
        seenSessions.add(c.currentSessionId);
      }
      const s = (c.currentSessionId && geminiScanner.sessionInfo(c.currentSessionId)) || {};
      if (!c.gitRepo && (c.projectDir || s.workspace)) {
        const candidateDir = c.projectDir || s.workspace;
        const repo = await gitSync.resolveRepo([candidateDir]);
        if (repo) {
          c.gitRepo = repo;
          metadataChanged = true;
        }
      }
      const snippet = s.snippet || c.messages?.at(-1)?.text.slice(0, 90) || '';
      conversations.push({
        convId,
        name: c.name || s.snippet || c.messages?.find(m => m.role === 'user')?.text.slice(0, 60) || '(nueva conversación)',
        snippet,
        lastActivity: s.lastActivity || c.lastActivity || null,
        messageCount: s.messageCount || c.messages?.length || 0,
        pinned: !!c.pinned,
        unread: !!c.unread,
        aiTitle: !!c.aiTitle,
        status: geminiConvStatus(convId),
        projectDir: c.projectDir || s.workspace || null,
        gitRepo: c.gitRepo || null,
        model: c.model || 'gemini-3.8-flash-high',
      });
    }

    if (metadataChanged) meta.save(data, geminiMetaFile);

    conversations.sort((a, b) => Number(b.pinned) - Number(a.pinned) || String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
    res.json({ conversations, unreadTotal: conversations.filter(c => c.unread).length });
  });

  router.patch('/conversations/:id', (req, res) => {
    const data = meta.load(geminiMetaFile);
    const { conv: c } = resolveGeminiConv(data, req.params.id);
    if (!c) return res.status(404).json({ error: 'conversación no encontrada' });
    for (const key of ['pinned', 'unread', 'hidden']) {
      if (key in req.body) c[key] = !!req.body[key];
    }
    for (const key of ['model', 'projectDir', 'gitRepo', 'name']) {
      if (key in req.body && typeof req.body[key] === 'string') {
        c[key] = req.body[key];
        if (key === 'name') c.aiTitle = false;
      }
    }
    meta.save(data, geminiMetaFile);
    res.json({ ok: true });
  });

  router.get('/conversations/:id/messages', (req, res) => {
    const data = meta.load(geminiMetaFile);
    const { conv: c } = resolveGeminiConv(data, req.params.id);
    if (!c) return res.status(404).json({ error: 'conversación no encontrada' });
    if (c.currentSessionId) {
      const realMessages = geminiScanner.getMessages(c.currentSessionId);
      if (realMessages && realMessages.length > 0) {
        return res.json(realMessages);
      }
    }
    res.json(c.messages || []);
  });

  router.get('/conversations/:id/repo', async (req, res) => {
    const data = meta.load(geminiMetaFile);
    const { conv } = resolveGeminiConv(data, req.params.id);
    if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
    let repo = conv.gitRepo || null;
    if (!repo && conv.projectDir) {
      repo = await gitSync.resolveRepo([conv.projectDir]);
    }
    if (!repo && conv.currentSessionId) {
      const ws = geminiScanner.findSessionWorkspace(conv.currentSessionId);
      if (ws) repo = await gitSync.resolveRepo([ws]);
    }
    if (!repo) {
      const msgs = (conv.currentSessionId && geminiScanner.getMessages(conv.currentSessionId)) || conv.messages || [];
      repo = await inferRepoFromMessages(msgs);
    }
    if (repo && conv.gitRepo !== repo) {
      conv.gitRepo = repo;
      meta.save(data, geminiMetaFile);
    }
    res.json({ repo: repo || conv.projectDir || null });
  });

  router.post('/conversations/:id/message', async (req, res) => {
    const text = String(req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'mensaje vacío' });
    const data = meta.load(geminiMetaFile);
    const { convId, conv: c } = resolveGeminiConv(data, req.params.id);
    if (!c) return res.status(404).json({ error: 'conversación no encontrada' });
    if (geminiRunner.isBusy(convId)) return res.status(409).json({ error: 'esa conversación ya está procesando un mensaje' });
    if (!c.gitRepo) {
      const inferredRepo = await inferRepoFromMessage(text);
      if (inferredRepo) {
        c.gitRepo = inferredRepo;
        meta.save(data, geminiMetaFile);
      }
    }
    c.messages.push({ role: 'user', text, ts: new Date().toISOString() });
    c.lastActivity = new Date().toISOString();
    meta.save(data, geminiMetaFile);
    const cwd = c.projectDir || os.homedir();
    if (geminiTurnStartedAt) geminiTurnStartedAt.set(convId, Date.now());
    geminiRunner.send({
      convId,
      sessionId: c.currentSessionId,
      cwd,
      text,
      model: c.model || 'gemini-3.8-flash-high',
    });
    res.status(202).json({ queued: true });
  });

  router.delete('/conversations/:id/message', (req, res) => {
    const data = meta.load(geminiMetaFile);
    const { convId } = resolveGeminiConv(data, req.params.id);
    res.json({ cancelled: geminiRunner.cancel(convId) });
  });

  router.get('/conversations/:id/stream', (req, res) => {
    const data = meta.load(geminiMetaFile);
    const { convId: id } = resolveGeminiConv(data, req.params.id);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    if (!geminiSseClients.has(id)) geminiSseClients.set(id, new Set());
    geminiSseClients.get(id).add(res);
    res.write(`data: ${JSON.stringify({ kind: 'status', status: geminiConvStatus(id) })}\n\n`);
    const heartbeat = setInterval(() => res.write(':heartbeat\n\n'), 20000);
    req.on('close', () => {
      clearInterval(heartbeat);
      const set = geminiSseClients.get(id);
      if (set) {
        set.delete(res);
        if (!set.size) geminiSseClients.delete(id);
      }
    });
  });

  return router;
}

module.exports = { createGeminiRouter, createAntigravityRouter };
