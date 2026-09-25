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

const AGY_CONTEXT_WINDOW_TABLE = [
  { prefix: 'gemini-3.1-pro', tokens: 2_000_000 },
  { prefix: 'gemini-1.5-pro', tokens: 2_000_000 },
  { prefix: 'gemini-2.0-pro', tokens: 2_000_000 },
  { prefix: 'gemini-', tokens: 1_000_000 },
  { prefix: 'claude-sonnet-4-6', tokens: 1_000_000 },
  { prefix: 'claude-opus-4-6', tokens: 1_000_000 },
  { prefix: 'claude-', tokens: 200_000 },
  { prefix: 'gpt-', tokens: 128_000 },
];

function agyContextWindowFor(model) {
  if (!model) return 1_000_000;
  const row = AGY_CONTEXT_WINDOW_TABLE.find(p => model.startsWith(p.prefix));
  return row ? row.tokens : 1_000_000;
}

function resolveContextTokens(c, s) {
  if (s && typeof s.contextTokens === 'number' && s.contextTokens > 0) return s.contextTokens;
  if (c && c.currentSessionId) {
    const sInfo = geminiScanner.sessionInfo(c.currentSessionId);
    if (sInfo && typeof sInfo.contextTokens === 'number' && sInfo.contextTokens > 0) {
      return sInfo.contextTokens;
    }
  }
  const window = agyContextWindowFor(c?.model);
  if (c && typeof c.contextTokens === 'number' && c.contextTokens > 0 && c.contextTokens <= window) {
    return c.contextTokens;
  }
  if (c && Array.isArray(c.messages) && c.messages.length > 0) {
    let totalChars = 0;
    for (const m of c.messages) {
      totalChars += (m.text || '').length;
      if (m.input) totalChars += typeof m.input === 'string' ? m.input.length : JSON.stringify(m.input).length;
      if (m.output) totalChars += typeof m.output === 'string' ? m.output.length : String(m.output).length;
    }
    return 12000 + Math.round(totalChars / 4);
  }
  return 0;
}

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
  registerProject,
  getHiddenProjectNames,
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
    const project = (req.body.project || '').trim() || undefined;
    data.conversations[convId] = {
      currentSessionId: null,
      projectDir,
      model,
      messages: [],
      lastActivity: null,
      project,
    };
    if (project && typeof registerProject === 'function') registerProject(project);
    meta.save(data, geminiMetaFile);
    res.status(201).json({ convId, projectDir, model, project });
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
          if (!canonical.project && dup.project) canonical.project = dup.project;
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
    const projectFilter = req.query.project;
    const shouldDiscover = (!projectFilter || projectFilter === '__none__' || pendingConvId);

    if (shouldDiscover) {
      for (const session of geminiScanner.listSessions()) {
        if (knownSessions.has(session.sessionId)) continue;

        if (pendingConvId) {
          const pendingConv = data.conversations[pendingConvId];
          pendingConv.currentSessionId = session.sessionId;
          knownSessions.add(session.sessionId);
          metadataChanged = true;
          continue;
        }

        let discoveredProject = undefined;
        if (session.snippet) {
          const m = session.snippet.match(/^\[Estamos trabajando en el proyecto "([^"]+)"/);
          if (m) discoveredProject = m[1];
        }
        const convId = crypto.randomUUID();
        data.conversations[convId] = {
          currentSessionId: session.sessionId,
          projectDir: session.workspace || process.env.CCM_DEFAULT_PROJECT_DIR || os.homedir(),
          name: session.snippet || '(conversación externa)',
          messages: [],
          lastActivity: session.lastActivity,
          model: 'gemini-3.8-flash-high',
          ...(discoveredProject ? { project: discoveredProject } : {}),
        };
        if (discoveredProject && typeof registerProject === 'function') registerProject(discoveredProject);
        knownSessions.add(session.sessionId);
        metadataChanged = true;
      }
    }

    const conversations = [];
    const seenSessions = new Set();
    for (const [convId, c] of Object.entries(data.conversations)) {
      if (c.hidden) continue;
      if (!c.project && (c.name || '').startsWith('[Estamos trabajando en el proyecto "')) {
        const m = c.name.match(/^\[Estamos trabajando en el proyecto "([^"]+)"/);
        if (m) {
          c.project = m[1];
          metadataChanged = true;
          if (typeof registerProject === 'function') registerProject(c.project);
        }
      }
      if (c.name && c.name.startsWith('[Estamos trabajando en el proyecto "')) {
        const userMsg = c.messages?.find(m => m.role === 'user')?.text;
        if (userMsg) {
          c.name = userMsg.slice(0, 60);
          metadataChanged = true;
        }
      }
      if (projectFilter) {
        if (projectFilter === '__none__') {
          if (c.project) continue;
        } else if (!c.project || c.project.toLowerCase() !== projectFilter.toLowerCase()) {
          continue;
        }
      }
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
      const model = c.model || 'gemini-3.8-flash-high';
      const window = agyContextWindowFor(model);
      const contextTokens = resolveContextTokens(c, s);
      const contextPct = window > 0 ? Math.min(1, contextTokens / window) : 0;
      if (c.contextTokens !== contextTokens) {
        c.contextTokens = contextTokens;
        metadataChanged = true;
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
        project: c.project || null,
        model,
        contextTokens,
        contextWindow: window,
        contextPct,
      });
    }

    if (metadataChanged) meta.save(data, geminiMetaFile);

    conversations.sort((a, b) => Number(b.pinned) - Number(a.pinned) || String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
    const unreadTotal = conversations.filter(c => c.unread).length;
    let filtered = conversations;
    if (projectFilter) {
      filtered = projectFilter === '__none__'
        ? filtered.filter(c => !c.project)
        : filtered.filter(c => c.project && c.project.toLowerCase() === projectFilter.toLowerCase());
    } else {
      const hidden = typeof getHiddenProjectNames === 'function' ? getHiddenProjectNames() : new Set();
      if (hidden && hidden.size > 0) filtered = filtered.filter(c => !c.project || !hidden.has(c.project));
    }
    res.json({ conversations: filtered, unreadTotal });
  });

  router.patch('/conversations/:id', (req, res) => {
    const data = meta.load(geminiMetaFile);
    const { conv: c } = resolveGeminiConv(data, req.params.id);
    if (!c) return res.status(404).json({ error: 'conversación no encontrada' });
    for (const key of ['pinned', 'unread', 'hidden']) {
      if (key in req.body) c[key] = !!req.body[key];
    }
    for (const key of ['model', 'projectDir', 'gitRepo', 'name', 'project']) {
      if (key in req.body) {
        c[key] = (typeof req.body[key] === 'string' ? req.body[key].trim() : '') || undefined;
        if (key === 'name') c.aiTitle = false;
        if (key === 'project' && c.project && typeof registerProject === 'function') registerProject(c.project);
      }
    }
    meta.save(data, geminiMetaFile);
    res.json({ ok: true });
  });

  router.get('/conversations/:id/usage', (req, res) => {
    const data = meta.load(geminiMetaFile);
    const { conv: c } = resolveGeminiConv(data, req.params.id);
    if (!c) return res.status(404).json({ error: 'conversación no encontrada' });
    const s = (c.currentSessionId && geminiScanner.sessionInfo(c.currentSessionId)) || {};
    const model = c.model || 'gemini-3.8-flash-high';
    const window = agyContextWindowFor(model);
    const contextTokens = resolveContextTokens(c, s);
    const contextPct = window > 0 ? Math.min(1, contextTokens / window) : 0;
    const usage = c.lastUsage || {};
    res.json({
      model,
      contextTokens,
      contextWindow: window,
      contextPct,
      input_tokens: usage.input_tokens != null ? usage.input_tokens : contextTokens,
      output_tokens: usage.output_tokens || 0,
      thinking_tokens: usage.thinking_tokens || 0,
      cache_read_tokens: usage.cache_read_tokens || 0,
      total_tokens: usage.total_tokens || contextTokens,
    });
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
    if (!c.gitRepo) {
      const inferredRepo = await inferRepoFromMessage(text);
      if (inferredRepo) {
        c.gitRepo = inferredRepo;
        meta.save(data, geminiMetaFile);
      }
    }
    let outgoing = text;
    if (c.project && !c.currentSessionId && !c.projectAnnounced) {
      if (!c.gitRepo && typeof inferRepoFromMessage === 'function') {
        const inferredRepo = await inferRepoFromMessage(c.project);
        if (inferredRepo) c.gitRepo = inferredRepo;
      }
      const folderNote = c.gitRepo ? `, carpeta: ${c.gitRepo}` : '';
      outgoing = `[Estamos trabajando en el proyecto "${c.project}"${folderNote}]\n\n${outgoing}`;
      c.projectAnnounced = true;
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
      text: outgoing,
      model: c.model || 'gemini-3.8-flash-high',
      resolveSessionId: () => meta.load(geminiMetaFile).conversations[convId]?.currentSessionId,
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

module.exports = {
  createGeminiRouter,
  createAntigravityRouter,
  agyContextWindowFor,
  resolveContextTokens,
};
