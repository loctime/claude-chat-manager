const express = require('express');
const crypto = require('crypto');
const path = require('path');
const scanner = require('./scanner');
const meta = require('./meta');
const { Runner } = require('./runner');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3777);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const runner = new Runner();
const sseClients = new Map(); // convId → Set<res>

function broadcast(convId, payload) {
  const set = sseClients.get(convId);
  if (!set) return;
  for (const res of set) res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

runner.on('event', ({ convId, event }) => {
  // --resume crea un session-id nuevo: al verlo, avanzar la conversación
  const sid = event.session_id;
  if (sid) {
    const data = meta.load();
    if (data.conversations[convId] && data.conversations[convId].currentSessionId !== sid) {
      meta.advanceSession(data, convId, sid);
      meta.save(data);
    }
  }
  broadcast(convId, { kind: 'claude', event });
});

runner.on('status', s => broadcast(s.convId, { kind: 'status', ...s }));

// Conversación: entrada en meta.json, o sesión suelta de disco (convId = sessionId)
function resolveConv(convId) {
  const data = meta.load();
  if (data.conversations[convId]) return { data, conv: data.conversations[convId] };
  const file = scanner.findSessionFile(convId);
  if (!file) return { data, conv: null };
  const info = scanner.sessionInfo(file);
  data.conversations[convId] = { currentSessionId: convId, projectDir: (info && info.cwd) || process.env.HOME };
  return { data, conv: data.conversations[convId] };
}

app.get('/api/tree', (req, res) => {
  const data = meta.load();
  const sessions = scanner.listSessions();
  const referenced = new Set(data.superseded);
  for (const c of Object.values(data.conversations)) referenced.add(c.currentSessionId);
  const byId = new Map(sessions.map(s => [s.sessionId, s]));
  const convs = [];
  for (const [convId, c] of Object.entries(data.conversations)) {
    const s = byId.get(c.currentSessionId) || {};
    convs.push({
      convId,
      projectDir: c.projectDir,
      name: c.name || s.snippet || '(nueva conversación)',
      snippet: s.snippet || '',
      lastActivity: s.lastActivity || null,
      messageCount: s.messageCount || 0,
      model: c.model || null,
      lastModel: s.lastModel || null,
      status: runner.running.has(convId) ? 'running' : (runner.isBusy(convId) ? 'queued' : 'idle'),
    });
  }
  for (const s of sessions) {
    if (referenced.has(s.sessionId) || data.conversations[s.sessionId]) continue;
    convs.push({
      convId: s.sessionId,
      projectDir: s.cwd || '(desconocido)',
      name: s.snippet,
      snippet: s.snippet,
      lastActivity: s.lastActivity,
      messageCount: s.messageCount,
      model: null,
      lastModel: s.lastModel || null,
      status: runner.running.has(s.sessionId) ? 'running' : (runner.isBusy(s.sessionId) ? 'queued' : 'idle'),
    });
  }
  const groups = new Map();
  for (const c of convs) {
    if (!groups.has(c.projectDir)) groups.set(c.projectDir, []);
    groups.get(c.projectDir).push(c);
  }
  const tree = [...groups.entries()].map(([projectDir, conversations]) => ({
    projectDir,
    conversations: conversations.sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || '')),
  }));
  res.json(tree);
});

app.get('/api/conversations/:id/messages', (req, res) => {
  const { conv } = resolveConv(req.params.id);
  if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
  if (!conv.currentSessionId) return res.json([]);
  const file = scanner.findSessionFile(conv.currentSessionId);
  if (!file) return res.json([]);
  res.json(scanner.toChatMessages(scanner.parseJsonl(file)));
});

app.post('/api/conversations/:id/message', (req, res) => {
  const convId = req.params.id;
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'mensaje vacío' });
  if (runner.isBusy(convId)) return res.status(409).json({ error: 'esa conversación ya está procesando un mensaje' });
  const { data, conv } = resolveConv(convId);
  if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
  meta.save(data);
  runner.send({ convId, sessionId: conv.currentSessionId, cwd: conv.projectDir, text, model: conv.model });
  res.status(202).json({ queued: true });
});

app.post('/api/conversations', (req, res) => {
  const { projectDir, text, model } = req.body;
  if (!projectDir || !(text || '').trim()) return res.status(400).json({ error: 'faltan projectDir o text' });
  const convId = crypto.randomUUID();
  const data = meta.load();
  data.conversations[convId] = { currentSessionId: null, projectDir, model: model || undefined };
  meta.save(data);
  runner.send({ convId, sessionId: null, cwd: projectDir, text: text.trim(), model: model || undefined });
  res.status(201).json({ convId });
});

app.patch('/api/conversations/:id', (req, res) => {
  const { data, conv } = resolveConv(req.params.id);
  if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
  if ('name' in req.body) conv.name = (req.body.name || '').trim() || undefined;
  if ('model' in req.body) conv.model = (req.body.model || '').trim() || undefined;
  meta.save(data);
  res.json({ ok: true });
});

app.delete('/api/conversations/:id/message', (req, res) => {
  const cancelled = runner.cancel(req.params.id);
  res.json({ cancelled });
});

app.get('/api/conversations/:id/stream', (req, res) => {
  const convId = req.params.id;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');
  if (!sseClients.has(convId)) sseClients.set(convId, new Set());
  sseClients.get(convId).add(res);
  req.on('close', () => {
    const set = sseClients.get(convId);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) sseClients.delete(convId);
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Claude Chat Manager en http://${HOST}:${PORT}`);
});
