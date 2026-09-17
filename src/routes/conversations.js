const express = require('express');
const crypto = require('crypto');
const { spawn } = require('child_process');
const meta = require('../meta');
const scanner = require('../scanner');
const gitSync = require('../git-sync');
const { CLAUDE_CMD } = require('../claude-cmd');

// Busca los cwd más recientes que la sesión registró. El cwd inicial suele ser
// HOME, pero cada tool call conserva el subproyecto donde realmente se trabajó;
// así el botón Git apunta al repo de la charla sin pedirle nada al agente.
function gitCwdsForSession(file, fallback, parse = scanner.parseJsonl) {
  const cwds = [];
  if (file) {
    for (const entry of parse(file).reverse()) {
      if (typeof entry.cwd === 'string' && entry.cwd) cwds.push(entry.cwd);
      if (entry.payload && typeof entry.payload.cwd === 'string' && entry.payload.cwd) cwds.push(entry.payload.cwd);
    }
  }
  if (fallback) cwds.push(fallback);
  return cwds;
}

// Da el mismo texto que rewindSessionFile dejaría como aviso pendiente — lo usan
// tanto el preview (antes de confirmar) como el rewind real (para guardarlo).
function formatRewindNotice(effects) {
  const lines = effects.map(e => {
    const tag = e.reversible === true ? ' [reversible]' : e.reversible === false ? ' [IRREVERSIBLE]' : '';
    return `- ${e.summary}${tag}${e.hint ? ' — ' + e.hint : ''}`;
  });
  return `[Aviso: se rebobinó la charla]\nEntre el punto al que se volvió y el estado anterior se habían ejecutado estas acciones fuera de la charla. Rebobinar NO las deshace — si siguen aplicadas en el sistema, tenelo en cuenta antes de asumir el estado actual:\n${lines.join('\n')}`;
}

// Compact nativo vía `claude --resume <id> -p "/compact"` (deja un entry real
// type:"system", subtype:"compact_boundary" en su jsonl) en vez de generar un
// resumen aparte que había que reinyectar a mano en el próximo mensaje.
function claudeCompact(sessionId, cwd, cmd = CLAUDE_CMD) {
  return new Promise((resolve, reject) => {
    const args = ['--resume', sessionId, '-p', '/compact', '--dangerously-skip-permissions', '--output-format', 'json'];
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('timeout (5min) compactando con claude'));
    }, 300_000);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => {
      clearTimeout(timer);
      console.error('[compact] spawn claude error:', err.message);
      reject(new Error('no se pudo lanzar claude: ' + err.message));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        console.error('[compact] claude exit', code, 'stderr:', stderr.slice(0, 500));
        return reject(new Error(`claude salió con código ${code}: ${(stderr || '').slice(0, 200)}`));
      }
      resolve();
    });
  });
}

// Lee el jsonl recién compactado y devuelve la metadata del último boundary —
// para mostrarle al usuario "de Xk a Yk tokens" en vez de un simple "listo".
function lastCompactMetadata(file) {
  const entries = scanner.parseJsonl(file);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'system' && e.subtype === 'compact_boundary') return e.compactMetadata || null;
  }
  return null;
}

async function resolveConversationGitRepo(conv, file, { inferRepoFromMessages, parse = scanner.parseJsonl, messages = scanner.toChatMessages } = {}) {
  let repo = await gitSync.resolveRepo([conv.gitRepo, ...gitCwdsForSession(file, conv.projectDir, parse)]);
  if (!repo && file && typeof inferRepoFromMessages === 'function') {
    repo = await inferRepoFromMessages(messages(parse(file)));
  }
  return repo;
}

function createConversationsRouter({
  getActiveAccount,
  accountMetaFile,
  accountProjectsDir,
  accountHomeDir,
  homeDir,
  runner,
  compacting,
  broadcast,
  convStatus,
  contextWindowFor,
  usageCost,
  inferRepoFromMessage,
  inferRepoFromMessages,
  registerProject,
  sseClients,
  claudeCmd = CLAUDE_CMD,
  defaultProjectDir = process.env.CCM_DEFAULT_PROJECT_DIR,
} = {}) {
  const router = express.Router();

  function resolveConv(convId, acc = getActiveAccount()) {
    const metaFile = accountMetaFile(acc);
    const projDir = accountProjectsDir(acc);
    const data = meta.load(metaFile);
    if (data.conversations[convId]) return { data, conv: data.conversations[convId], metaFile };
    const file = scanner.findSessionFile(convId, projDir);
    if (!file) return { data, conv: null, metaFile };
    const info = scanner.sessionInfo(file);
    data.conversations[convId] = { currentSessionId: convId, projectDir: (info && info.cwd) || homeDir };
    return { data, conv: data.conversations[convId], metaFile };
  }

  const resolveRepo = (conv, file) => resolveConversationGitRepo(conv, file, { inferRepoFromMessages });

  router.get('/:id/usage', (req, res) => {
    const empty = { total: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, byModel: {}, costUSD: 0, contextTokens: 0, contextWindow: 200_000, contextPct: 0 };
    const acc = req.query.account || getActiveAccount();
    const { conv } = resolveConv(req.params.id, acc);
    if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
    if (!conv.currentSessionId) return res.json(empty);
    const file = scanner.findSessionFile(conv.currentSessionId, accountProjectsDir(acc));
    if (!file) return res.json(empty);
    const info = scanner.sessionInfo(file);
    if (!info || !info.usage) return res.json(empty);
    const window = contextWindowFor(info.lastModel);
    const contextTokens = info.contextTokens || 0;
    res.json({
      ...usageCost(info.usage),
      contextTokens,
      contextWindow: window,
      contextPct: window > 0 ? contextTokens / window : 0,
    });
  });

  router.get('/:id/messages', (req, res) => {
    const acc = req.query.account || getActiveAccount();
    const projDir = accountProjectsDir(acc);
    const { conv } = resolveConv(req.params.id, acc);
    if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
    const out = [];
    if (conv.compactedFromSession) {
      const oldFile = scanner.findSessionFile(conv.compactedFromSession, projDir);
      if (oldFile) {
        for (const m of scanner.getMessagesIncremental(oldFile)) out.push({ ...m, compacted: true });
      }
    }
    if (conv.currentSessionId) {
      const file = scanner.findSessionFile(conv.currentSessionId, projDir);
      if (file) {
        for (const m of scanner.getMessagesIncremental(file)) out.push(m);
      }
    }
    res.json(out);
  });

  router.post('/:id/message', async (req, res) => {
    const convId = req.params.id;
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'mensaje vacío' });
    if (runner.isBusy(convId)) return res.status(409).json({ error: 'esa conversación ya está procesando un mensaje' });
    if (compacting.has(convId)) return res.status(409).json({ error: 'esa conversación se está compactando' });
    const acc = req.body.account || getActiveAccount();
    const { data, conv, metaFile } = resolveConv(convId, acc);
    if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
    let outgoing = text;
    // Read-once: si el turno anterior rebobinó ignorando acciones con efecto real,
    // esta nota va antepuesta al primer mensaje que se manda después — así entra
    // al contexto real de Claude en vez de quedar en una notificación que nadie lee.
    if (conv.pendingRewindNotice) {
      outgoing = `${conv.pendingRewindNotice}\n\n[Mensaje actual del usuario]\n${outgoing}`;
      delete conv.pendingRewindNotice;
    }
    if (conv.compactedSummary && !conv.currentSessionId) {
      outgoing = `[Resumen del contexto previo — la conversación fue compactada]\n${conv.compactedSummary}\n\n[Mensaje actual del usuario]\n${outgoing}`;
      delete conv.compactedSummary;
      delete conv.compactedAt;
    }
    // Charla nueva creada con un proyecto etiquetado (#project-bar): avisamos
    // una sola vez, antes del primer mensaje real, en qué proyecto estamos
    // trabajando — así Claude no depende de que el usuario lo escriba a mano
    // ("trabajemos en X") y el chip de carpeta queda resuelto de entrada si el
    // tag matchea una carpeta real bajo PROJECT_SEARCH_ROOTS.
    if (conv.project && !conv.currentSessionId && !conv.projectAnnounced && typeof inferRepoFromMessage === 'function') {
      const resolvedRepo = await inferRepoFromMessage(conv.project);
      if (resolvedRepo) conv.gitRepo = resolvedRepo;
      const folderNote = resolvedRepo ? `, carpeta: ${resolvedRepo}` : '';
      outgoing = `[Estamos trabajando en el proyecto "${conv.project}"${folderNote}]\n\n${outgoing}`;
      conv.projectAnnounced = true;
    }
    // La asociación puede llegar en cualquier mensaje (no necesariamente el
    // primero): queda pendiente hasta que el texto nombra un proyecto válido.
    if (!conv.gitRepo && typeof inferRepoFromMessage === 'function') {
      const inferredRepo = await inferRepoFromMessage(text);
      if (inferredRepo) conv.gitRepo = inferredRepo;
    }
    // El primer mensaje de una charla nueva (o cualquiera que quede en cola
    // detrás de las `maxConcurrent` que ya están corriendo) no tiene todavía
    // sesión ni archivo .jsonl — s.lastActivity en /tree queda null hasta que
    // el CLI arranca de verdad. Sin este fallback, /tree ordena por
    // lastActivity desc y la charla se va al fondo de la lista (después de
    // TODAS las demás, con actividad real) mientras espera turno: para el
    // usuario "no aparece" hasta que se libera un slot y el proceso arranca.
    conv.lastMessageAt = new Date().toISOString();
    meta.save(data, metaFile);
    // Las conversaciones "VPS: <proyecto>" no tienen una carpeta local real —
    // conv.projectDir ahí es solo metadata para agrupar/mostrar, no un cwd válido.
    // Para el resto, no confiamos ciegamente en conv.projectDir: si Claude entró a un
    // git worktree a mitad de charla, la sesión quedó reubicada a otra carpeta de
    // proyecto y projectDir quedó desactualizado — resolveCwd busca dónde vive
    // realmente la sesión ahora.
    const cwd = (conv.projectDir || '').startsWith('VPS: ') ? accountHomeDir(acc) : scanner.resolveCwd(conv, accountProjectsDir(acc));
    runner.send({ convId, sessionId: conv.currentSessionId, cwd, text: outgoing, model: conv.model, account: acc });
    res.status(202).json({ queued: true });
  });

  // Sincronización Git directa desde el menú de una charla. No se interpreta un
  // comando del navegador: el server invoca `git` con argv fijos y el repo se
  // deduce de los cwd ya guardados por la sesión de Claude Code.
  router.post('/:id/git-sync', async (req, res) => {
    const convId = req.params.id;
    if (runner.isBusy(convId) || compacting.has(convId)) return res.status(409).json({ error: 'esa conversación está procesando una tarea' });
    const acc = req.body.account || getActiveAccount();
    const projectsDir = accountProjectsDir(acc);
    const { data, conv, metaFile } = resolveConv(convId, acc);
    if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
    const file = conv.currentSessionId ? scanner.findSessionFile(conv.currentSessionId, projectsDir) : null;
    const repo = await resolveRepo(conv, file);
    if (!repo) return res.status(400).json({ error: 'no encontré un repositorio Git asociado a esta conversación' });
    if (conv.gitRepo !== repo) {
      conv.gitRepo = repo;
      meta.save(data, metaFile);
    }
    try {
      res.json(await gitSync.syncRepo(repo));
    } catch (err) {
      const detail = (err.stderr || err.stdout || err.message || 'falló Git').trim().slice(0, 1000);
      res.status(409).json({ error: detail });
    }
  });

  // El chip del header pide el repo al abrir una conversación. También migra en
  // forma perezosa los chats creados antes de guardar gitRepo en la metadata.
  router.get('/:id/repo', async (req, res) => {
    const acc = req.query.account || getActiveAccount();
    const projectsDir = accountProjectsDir(acc);
    const { data, conv, metaFile } = resolveConv(req.params.id, acc);
    if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
    const file = conv.currentSessionId ? scanner.findSessionFile(conv.currentSessionId, projectsDir) : null;
    const repo = await resolveRepo(conv, file);
    if (repo && conv.gitRepo !== repo) {
      conv.gitRepo = repo;
      meta.save(data, metaFile);
    }
    res.json({ repo: repo || null });
  });

  router.post('/:id/compact', (req, res) => {
    const convId = req.params.id;
    if (runner.isBusy(convId)) return res.status(409).json({ error: 'esa conversación está procesando un mensaje' });
    if (compacting.has(convId)) return res.status(409).json({ error: 'ya se está compactando esta conversación' });
    const acc = req.body.account || getActiveAccount();
    const projDir = accountProjectsDir(acc);
    const { conv } = resolveConv(convId, acc);
    if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
    if (!conv.currentSessionId) return res.status(400).json({ error: 'la conversación no tiene sesión activa' });
    const file = scanner.findSessionFile(conv.currentSessionId, projDir);
    if (!file) return res.status(404).json({ error: 'archivo de sesión no encontrado' });
    const messages = scanner.getMessagesIncremental(file).filter(m => m.role === 'user' || m.role === 'assistant');
    if (messages.length < 2) return res.status(400).json({ error: 'nada útil para compactar (menos de 2 mensajes)' });

    // La compactación real puede tardar bastante en sesiones largas — justo el
    // caso que más lo necesita — y una respuesta HTTP colgada esperando eso corre
    // el mismo riesgo que ya documentamos para /stream: el túnel Cloudflare corta
    // conexiones idle. Por eso responde 202 al toque y hace el trabajo en
    // background, avisando por el mismo canal SSE que ya usan los mensajes
    // normales (heartbeat cada 20s incluido).
    const cwd = (conv.projectDir || '').startsWith('VPS: ') ? accountHomeDir(acc) : scanner.resolveCwd(conv, projDir);
    compacting.add(convId);
    broadcast(convId, { kind: 'status', status: 'running' });
    claudeCompact(conv.currentSessionId, cwd, claudeCmd)
      .then(() => {
        compacting.delete(convId);
        const cm = lastCompactMetadata(file);
        if (!cm) console.warn('[compact] terminó sin error pero no encontré el compact_boundary en el jsonl:', file);
        broadcast(convId, { kind: 'compacted', ...cm });
        broadcast(convId, { kind: 'status', status: 'idle', code: 0 });
      })
      .catch(err => {
        compacting.delete(convId);
        console.error('[compact] falló:', err.message);
        broadcast(convId, { kind: 'status', status: 'idle', code: -1, stderr: 'No se pudo compactar: ' + err.message });
      });
    res.status(202).json({ queued: true });
  });

  // Preview de qué se perdería al rebobinar hasta `uuid`, sin tocar el archivo.
  // Pensado para mostrar la advertencia ANTES de que el usuario confirme.
  router.get('/:id/rewind-preview', (req, res) => {
    const convId = req.params.id;
    const uuid = (req.query.uuid || '').trim();
    if (!uuid) return res.status(400).json({ error: 'falta uuid del mensaje' });
    const acc = req.query.account || getActiveAccount();
    const { conv } = resolveConv(convId, acc);
    if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
    if (!conv.currentSessionId) return res.status(400).json({ error: 'la conversación no tiene sesión activa' });
    const file = scanner.findSessionFile(conv.currentSessionId, accountProjectsDir(acc));
    if (!file) return res.status(404).json({ error: 'archivo de sesión no encontrado' });
    const preview = scanner.previewRewindEffects(file, uuid);
    if (!preview) return res.status(400).json({ error: 'no se puede rebobinar ahí (mensaje no encontrado en la sesión actual, o dejaría la conversación vacía)' });
    res.json(preview);
  });

  // Rebobinar: elimina un turno user y todo lo posterior del jsonl de la sesión.
  // Ver scanner.rewindSessionFile para el porqué de que esto es seguro (cadena
  // parentUuid estilo git, cortada en borde de turno). Es rápido (reescritura
  // local del archivo), así que responde sincrónico — no necesita el baile de
  // 202+SSE del compact.
  router.post('/:id/rewind', (req, res) => {
    const convId = req.params.id;
    const uuid = (req.body.uuid || '').trim();
    if (!uuid) return res.status(400).json({ error: 'falta uuid del mensaje' });
    if (runner.isBusy(convId)) return res.status(409).json({ error: 'esa conversación está procesando un mensaje' });
    if (compacting.has(convId)) return res.status(409).json({ error: 'esa conversación se está compactando' });
    const acc = req.body.account || getActiveAccount();
    const { data, conv, metaFile } = resolveConv(convId, acc);
    if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
    if (!conv.currentSessionId) return res.status(400).json({ error: 'la conversación no tiene sesión activa' });
    const file = scanner.findSessionFile(conv.currentSessionId, accountProjectsDir(acc));
    if (!file) return res.status(404).json({ error: 'archivo de sesión no encontrado' });
    let result;
    try { result = scanner.rewindSessionFile(file, uuid); }
    catch (err) { return res.status(500).json({ error: 'no se pudo rebobinar: ' + err.message }); }
    if (!result) return res.status(400).json({ error: 'no se puede rebobinar ahí (mensaje no encontrado en la sesión actual, o dejaría la conversación vacía)' });
    // Si se perdieron acciones con efecto real, dejamos una nota que se antepone
    // sola al próximo mensaje que se mande — así Claude la ve en su contexto de
    // verdad en vez de depender de que alguien la lea a mano en algún lado.
    if (result.effects && result.effects.length) {
      conv.pendingRewindNotice = formatRewindNotice(result.effects);
    } else {
      delete conv.pendingRewindNotice;
    }
    meta.save(data, metaFile);
    broadcast(convId, { kind: 'status', status: 'idle', code: 0 });
    res.json({ ok: true, removed: result.removed, effects: result.effects || [] });
  });

  router.post('/', (req, res) => {
    const { model } = req.body;
    // Etiqueta de proyecto (texto libre, ver /api/projects) — NO es una carpeta,
    // no toca projectDir/cwd. Si el selector de proyecto está activo en el
    // front, la nueva charla nace ya clasificada ahí.
    const project = (req.body.project || '').trim() || undefined;
    const acc = req.body.account || getActiveAccount();
    // No se elige carpeta por conversación — siempre arranca en la carpeta
    // configurada para esta cuenta (CCM_DEFAULT_PROJECT_DIR si está seteado,
    // si no accountHomeDir), así lee el CLAUDE.md y la memoria de esa carpeta
    // igual que una sesión interactiva normal.
    const projectDir = defaultProjectDir || accountHomeDir(acc);
    const metaFile = accountMetaFile(acc);
    const convId = crypto.randomUUID();
    const data = meta.load(metaFile);
    data.conversations[convId] = { currentSessionId: null, projectDir, model: model || undefined, project };
    if (typeof registerProject === 'function') registerProject(data, project);
    meta.save(data, metaFile);
    res.status(201).json({ convId, projectDir, project });
  });

  router.patch('/:id', (req, res) => {
    const acc = req.body.account || getActiveAccount();
    const { data, conv, metaFile } = resolveConv(req.params.id, acc);
    if (!conv) return res.status(404).json({ error: 'conversación no encontrada' });
    if ('name' in req.body) {
      conv.name = (req.body.name || '').trim() || undefined;
      conv.aiTitle = false;
    }
    if ('model' in req.body) conv.model = (req.body.model || '').trim() || undefined;
    // Etiqueta de proyecto: string vacío/null la borra (vuelve a "Sin proyecto").
    if ('project' in req.body) {
      conv.project = (req.body.project || '').trim() || undefined;
      if (typeof registerProject === 'function') registerProject(data, conv.project);
    }
    if ('pinned' in req.body) conv.pinned = !!req.body.pinned;
    if ('archived' in req.body) conv.archived = !!req.body.archived;
    if ('unread' in req.body) conv.unread = !!req.body.unread;
    // hidden: saca la conversación de las dos listas (activas y archivadas) sin
    // tocar el .jsonl real — a diferencia de un borrado, es reversible a mano
    // editando meta.json si hiciera falta.
    if ('hidden' in req.body) conv.hidden = !!req.body.hidden;
    meta.save(data, metaFile);
    res.json({ ok: true });
  });

  router.delete('/:id/message', (req, res) => {
    const cancelled = runner.cancel(req.params.id);
    res.json({ cancelled });
  });

  router.get('/:id/stream', (req, res) => {
    const convId = req.params.id;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('\n');
    if (!sseClients.has(convId)) sseClients.set(convId, new Set());
    sseClients.get(convId).add(res);
    // Snapshot siempre, incluso idle. Si el SSE se cortó justo antes del
    // broadcast final (común al volver del background en móvil), el cliente
    // puede haber quedado con busy=true. En una reconexión, omitir idle lo
    // dejaba permanentemente en "mensaje pendiente" hasta salir y volver a
    // entrar a la conversación.
    const st = convStatus(convId);
    res.write(`data: ${JSON.stringify({ kind: 'status', status: st })}\n\n`);
    // Cloudflare Tunnel corta conexiones SSE inactivas (~100s de idle).
    // Sin este ping, un turno largo de Claude sin output deja el stream mudo
    // y el edge lo mata a mitad de camino, perdiendo el evento 'idle' final.
    const heartbeat = setInterval(() => res.write(':heartbeat\n\n'), 20000);
    req.on('close', () => {
      clearInterval(heartbeat);
      const set = sseClients.get(convId);
      if (!set) return;
      set.delete(res);
      if (set.size === 0) sseClients.delete(convId);
    });
  });

  return router;
}

module.exports = {
  gitCwdsForSession,
  formatRewindNotice,
  claudeCompact,
  lastCompactMetadata,
  resolveConversationGitRepo,
  createConversationsRouter,
};
