// ── Codex (árbol, mensajes, stream y composer) ──
// Extraído de app.js (split por dominio, sesión 15/09/2026).
// Script clásico (no ES module): comparte el scope global con el resto de los scripts.

// currentCodexConv: {id, name} de la conversación Codex abierta en #codex-chat,
// o null si no hay ninguna. Se declara acá (no en app.js) porque este archivo
// es el primero en referenciarla en ejecución — codex.js carga después de
// app.js en index.html, así que la declaración tiene que vivir donde carga.
let currentCodexConv = null;
let codexStream = null;
let codexMainBusy = false;

async function codexApi(path, opts) {
  const method = (opts && opts.method) || 'GET';
  const res = method === 'GET'
    ? await netFetch('/api/codex' + path, opts)
    : await fetch('/api/codex' + path, opts).catch(err => { throw netError(err); });
  if (!res.ok && res.status !== 202) throw new Error((await res.json()).error || res.statusText);
  return res.json();
}

async function loadCodexAvailability() {
  codexAvailable = false;
  try {
    const res = await fetch('/api/codex/status');
    const data = await res.json();
    codexAvailable = Boolean(res.ok && data.available);
  } catch { /* Codex no está configurado en esta instalación */ }
}

async function codexTogglePin(convId, pinned) {
  await codexApi(`/conversations/${convId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned }),
  });
  codexLoadTree();
}

async function codexToggleArchive(convId, archived) {
  await codexApi(`/conversations/${convId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archived }),
  });
  codexLoadTree();
}

function codexConvElement(c) {
  const div = document.createElement('div');
  div.className = 'tree-row';
  div.dataset.convId = c.convId;
  const badgeEl = badge(c.status) || (c.unread ? '<span class="unread-dot"></span>' : '');
  const main = document.createElement('div');
  main.className = 'tree-row-main';
  const nameEl = document.createElement('span');
  nameEl.className = 'tree-row-name';
  nameEl.textContent = c.name;
  main.appendChild(nameEl);
  if (badgeEl) main.insertAdjacentHTML('beforeend', badgeEl);
  const snippet = document.createElement('div');
  snippet.className = 'tree-row-snippet';
  snippet.textContent = c.snippet;
  const pinBtn = document.createElement('button');
  pinBtn.type = 'button';
  pinBtn.className = 'tree-row-action';
  pinBtn.textContent = c.pinned ? '📌' : '📍';
  pinBtn.title = c.pinned ? 'Desanclar' : 'Anclar';
  pinBtn.onclick = ev => { ev.stopPropagation(); codexTogglePin(c.convId, !c.pinned); };
  const archiveBtn = document.createElement('button');
  archiveBtn.type = 'button';
  archiveBtn.className = 'tree-row-action';
  archiveBtn.textContent = c.archived ? '↩️' : '🗄️';
  archiveBtn.title = c.archived ? 'Desarchivar' : 'Archivar';
  archiveBtn.onclick = ev => { ev.stopPropagation(); codexToggleArchive(c.convId, !c.archived); };
  div.appendChild(main);
  div.appendChild(snippet);
  div.appendChild(pinBtn);
  div.appendChild(archiveBtn);
  div.onclick = () => codexSelectConv(c.convId, c.name);
  return div;
}

let codexShowingArchived = false;

async function codexLoadTree() {
  const { conversations, archivedTotal: codexArchivedTotal } = await codexApi(`/tree${codexShowingArchived ? '?archived=1' : ''}`);
  const nav = $('codex-tree-list');
  nav.innerHTML = '';
  if (conversations.length === 0) {
    nav.innerHTML = `<div class="empty-state">${codexShowingArchived ? 'Sin conversaciones archivadas' : 'Sin conversaciones de Codex todavía'}</div>`;
  } else {
    for (const c of conversations) nav.appendChild(codexConvElement(c));
  }
  $('codex-archived-toggle').textContent = codexShowingArchived ? '← Volver a activas' : `Ver archivadas (${codexArchivedTotal})`;
}

function codexToggleArchivedView() {
  codexShowingArchived = !codexShowingArchived;
  codexLoadTree();
}

async function codexNewConversation() {
  try {
    const body = {};
    const p = activeProjectFilter && activeProjectFilter !== '__none__' ? activeProjectFilter : undefined;
    if (p) body.project = p;
    const { convId } = await codexApi('/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (typeof invalidateUnifiedTreeCache === 'function') invalidateUnifiedTreeCache();
    codexSelectConv(convId, 'Nueva conversación');
  } catch (err) {
    toast('No se pudo crear la conversación de Codex: ' + err.message);
  }
}

async function codexLoadMessages(convId) {
  const container = $('codex-messages');
  container.innerHTML = '';
  const msgs = await codexApi(`/conversations/${convId}/messages`);
  for (const m of msgs) {
    if (m.role === 'tool') addTool(m.name, m.input, m.output, { container, ts: m.ts });
    else addMsg(m.role, m.text, { container, ts: m.ts });
  }
  if (msgs.length === 0) container.innerHTML = '<div id="empty-state" class="empty-state">Escribile algo a Codex</div>';
}

function codexOpenStream(convId) {
  const es = new EventSource(`/api/codex/conversations/${convId}/stream`);
  es.onmessage = e => {
    if (!currentCodexConv || convId !== currentCodexConv.id) return;
    const data = JSON.parse(e.data);
    const container = $('codex-messages');
    if (data.kind === 'status') {
      if (data.status === 'idle') {
        setCodexBusy(false);
        codexLoadMessages(convId).then(() => {
          if (data.code !== 0 && data.stderr) addMsg('error', 'Error: ' + data.stderr, { container });
        });
      } else {
        setCodexBusy(true);
      }
      return;
    }
    if (data.kind !== 'codex') return;
    const ev = data.event;
    if (ev.type === 'item.completed' && ev.item) {
      if (ev.item.type === 'agent_message' && ev.item.text) {
        addMsg('assistant', ev.item.text, { container });
      } else if (ev.item.type === 'command_execution') {
        addTool('command_execution', { command: ev.item.command }, ev.item.aggregated_output || '', { container });
      }
    }
  };
  es.onerror = () => {
    if (!currentCodexConv || convId !== currentCodexConv.id) return;
    setTimeout(() => {
      if (!currentCodexConv || convId !== currentCodexConv.id) return;
      codexLoadMessages(convId);
    }, 1500);
  };
  return es;
}

function codexShowChat() {
  $('codex-tree').style.display = 'none';
  $('codex-chat').style.display = '';
}

function codexShowTreeList() {
  if (codexStream) { codexStream.close(); codexStream = null; }
  currentCodexConv = null;
  $('codex-chat').style.display = 'none';
  $('codex-tree').style.display = '';
  codexLoadTree();
}

async function codexSelectConv(convId, name) {
  currentCodexConv = { id: convId, name };
  $('codex-chat-title').textContent = name;
  codexShowChat();
  if (codexStream) { codexStream.close(); codexStream = null; }
  codexApi(`/conversations/${convId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unread: false }),
  }).catch(() => {});
  await codexLoadMessages(convId);
  codexStream = codexOpenStream(convId);
}

function setCodexBusy(b) {
  $('codex-send-btn').disabled = b;
  $('codex-cancel-btn').style.display = b ? '' : 'none';
}

async function codexCancel() {
  if (!currentCodexConv) return;
  try {
    await codexApi(`/conversations/${currentCodexConv.id}/message`, { method: 'DELETE' });
  } catch (err) {
    addMsg('error', 'No se pudo cancelar: ' + err.message, { container: $('codex-messages') });
  }
}

async function codexPerformSend(convId, text, imagePath) {
  addMsg('user', text, { container: $('codex-messages'), composerId: 'codex-composer-text' });
  setCodexBusy(true);
  try {
    await codexApi(`/conversations/${convId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, imagePath }),
    });
  } catch (err) {
    addMsg('error', 'No se pudo enviar: ' + err.message, { container: $('codex-messages') });
    setCodexBusy(false);
  }
}

async function codexUploadImage(file) {
  const { blob, name } = await prepareForUpload(file, file.name);
  const fd = new FormData();
  fd.append('file', blob, name);
  const res = await netFetch('/api/upload', { method: 'POST', body: fd });
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  const { path: filePath } = await res.json();
  return filePath;
}

async function codexSubmitComposer() {
  const textEl = $('codex-composer-text');
  const text = textEl.value.trim();
  if (!text || !currentCodexConv) return;
  const imageInput = $('codex-image-input');
  let imagePath;
  try {
    if (imageInput.files[0]) {
      imagePath = await codexUploadImage(imageInput.files[0]);
      imageInput.value = '';
    }
  } catch (err) {
    addMsg('error', 'No se pudo subir la imagen: ' + err.message, { container: $('codex-messages') });
    return;
  }
  textEl.value = '';
  await codexPerformSend(currentCodexConv.id, text, imagePath);
}

function codexProjectName(conv) {
  const repo = String(conv.gitRepo || '').replace(/[\\/]+$/, '');
  return repo ? repo.split(/[\\/]/).pop() : '';
}

function codexConversationLabel(conv) {
  if (conv.name) return conv.name;
  const project = codexProjectName(conv);
  return project || 'Sin proyecto';
}

function codexSharedRow(c) {
  const label = codexConversationLabel(c);
  const div = document.createElement('div');
  div.className = 'conv conv-engine-codex' + (currentCodexConv && c.convId === currentCodexConv.id ? ' active' : '');
  const pin = c.pinned ? '<span class="conv-pin" title="Fijada">📌</span>' : '';
  const ai = c.aiTitle ? '<span class="conv-ai" title="Título generado por IA">✨</span>' : '';
  div.innerHTML = `<div class="conv-avatar"></div><div class="conv-body"><div class="name">${pin}${ai}<span class="conv-name-text"></span></div><div class="sub"><span class="conv-project-tag"></span><span class="conv-date"></span></div></div>${badge(c.status) || (c.unread ? '<span class="unread-dot" title="Sin leer"></span>' : '')}`;
  div.querySelector('.conv-avatar').textContent = avatarChar(label);
  div.querySelector('.conv-name-text').textContent = label;
  const tagEl = div.querySelector('.conv-project-tag');
  if (c.project && c.project !== activeProjectFilter) {
    tagEl.textContent = c.project;
    tagEl.hidden = false;
    tagEl.onclick = (e) => {
      e.stopPropagation();
      setActiveProject(c.project);
    };
    if (typeof attachProjectItemGestures === 'function') attachProjectItemGestures(tagEl, c.project);
  } else {
    tagEl.hidden = true;
  }
  div.querySelector('.conv-date').textContent = c.snippet || (c.lastActivity || '').slice(0, 16).replace('T', ' ');
  div._codexConv = c;
  div.onclick = () => selectCodexShared(c.convId, label, c.gitRepo || c.projectDir, c.project);
  attachCodexRowGestures(div, c);
  return div;
}

async function loadCodexSharedTree({ skipAvailability = false } = {}) {
  const nav = $('codex-pane');
  if (!skipAvailability) await loadCodexAvailability();
  if (!skipAvailability && !codexAvailable) {
    nav.innerHTML = '<div id="empty-state"><p>Codex no está configurado en esta instalación.</p><p>En la PC que ejecuta J.A.R.V.I.S, iniciá sesión con <code>codex login</code> y actualizá esta página.</p></div>';
    return false;
  }
  if (activeProjectFilter && activeProjectFilter !== '__none__') {
    const data = typeof fetchUnifiedProjectTreeData === 'function' ? await fetchUnifiedProjectTreeData(activeProjectFilter) : null;
    if (data) {
      setPaneUnread('2', data.codexUnread > 0);
      setPaneProcessing('2', data.codexConvs.some(c => c.status && c.status !== 'idle'));
      if (typeof renderUnifiedProjectTree === 'function') {
        renderUnifiedProjectTree(nav, data, 'codex');
      }
      return true;
    }
  }
  const params = new URLSearchParams();
  if (activeProjectFilter) params.set('project', activeProjectFilter);
  const qs = params.toString() ? '?' + params.toString() : '';
  const { conversations, unreadTotal } = await codexApi('/tree' + qs);
  setPaneUnread('2', unreadTotal > 0);
  setPaneProcessing('2', conversations.some(conversation => conversation.status && conversation.status !== 'idle'));
  const next = document.createDocumentFragment();
  if (!conversations.length) {
    const empty = document.createElement('div');
    empty.id = 'empty-state';
    empty.innerHTML = `<p>${activeProjectFilter ? 'Sin conversaciones para este proyecto' : 'Sin conversaciones de Codex todavía'}</p>`;
    next.appendChild(empty);
  } else {
    conversations.forEach(c => next.appendChild(codexSharedRow(c)));
  }
  nav.replaceChildren(next);
  return true;
}

function attachCodexRowGestures(el, conv) {
  let touchTimer = null, longPressed = false, startX = 0, startY = 0;
  let axisLocked = null, rowDragging = false, currentDx = 0, redirectedToPane = false;
  const resetRow = () => {
    el.style.transition = 'transform .2s ease, opacity .2s ease';
    el.style.transform = ''; el.style.opacity = '';
    setTimeout(() => { el.style.transition = ''; }, 200);
  };
  el.addEventListener('contextmenu', e => { e.preventDefault(); showCodexConvMenu(e.clientX, e.clientY, conv); });
  el.addEventListener('touchstart', e => {
    longPressed = false; axisLocked = null; rowDragging = false; currentDx = 0; redirectedToPane = false;
    const touch = e.touches[0]; startX = touch.clientX; startY = touch.clientY;
    touchTimer = setTimeout(() => {
      longPressed = true; touchTimer = null; showCodexConvMenu(startX, startY, conv);
      if (navigator.vibrate) { try { navigator.vibrate(30); } catch {} }
    }, 500);
  }, { passive: true });
  el.addEventListener('touchmove', e => {
    if (longPressed) return;
    const touch = e.touches[0];
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    if (!axisLocked) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      axisLocked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (axisLocked === 'x' && touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
    }
    if (axisLocked !== 'x') return;
    if (e.cancelable) e.preventDefault();
    if (dx > 0) {
      if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
      if (rowDragging) resetRow();
      rowDragging = false;
      if (!redirectedToPane) { redirectedToPane = true; paneSwipeStart(startX, startY); }
      paneSwipeMove(touch.clientX, touch.clientY);
      return;
    }
    if (redirectedToPane) return;
    rowDragging = true;
    currentDx = Math.min(0, Math.max(-80, dx));
    el.style.transform = `translateX(${currentDx}px)`;
    el.style.opacity = `${1 - Math.abs(currentDx) / 160}`;
  }, { passive: false });
  el.addEventListener('touchend', async () => {
    if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
    if (redirectedToPane) await paneSwipeEnd();
    else if (rowDragging && !longPressed) resetRow();
    redirectedToPane = false; rowDragging = false; axisLocked = null;
  });
  el.addEventListener('touchcancel', () => {
    if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
    if (redirectedToPane) paneSwipeEnd(); else if (rowDragging) resetRow();
    redirectedToPane = false; rowDragging = false; axisLocked = null;
  });
  el.addEventListener('click', e => {
    if (longPressed) { longPressed = false; e.stopPropagation(); e.preventDefault(); }
  }, { capture: true });
}

function showCodexConvMenu(x, y, conv) {
  document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  const newInProjectBtn = (conv && conv.project)
    ? `<button data-action="new-in-project" title="Crear nueva conversación en ${String(conv.project).replace(/"/g, '&quot;')}">➕ Nueva conversación</button>`
    : '';
  menu.innerHTML = `${newInProjectBtn}<button data-action="copy-conversation">📋 Copiar conversación</button><button data-action="pin">${conv.pinned ? '📌 Desfijar' : '📌 Fijar'}</button><button data-action="project">🏷️ ${conv.project ? 'Cambiar proyecto…' : 'Asignar proyecto…'}</button><button data-action="git-sync">⬆️ Git: commit + pull + push</button><button data-action="hide" class="ctx-danger">🙈 Ocultar</button>`;
  document.body.appendChild(menu);
  // El menú se comparte visualmente con acciones que sí son propias de Codex;
  // insertar esto separado evita que la acción nativa quede mezclada con Git.
  menu.querySelector('[data-action="git-sync"]').insertAdjacentHTML('beforebegin', '<button data-action="compact">🗜️ Compactar contexto</button>');
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
  const dismiss = e => {
    if (menu.contains(e.target)) return;
    menu.remove(); document.removeEventListener('click', dismiss, true); document.removeEventListener('touchstart', dismiss, true);
  };
  menu.addEventListener('click', async e => {
    e.stopPropagation();
    const action = e.target.dataset && e.target.dataset.action;
    if (!action) return;
    menu.remove(); document.removeEventListener('click', dismiss, true); document.removeEventListener('touchstart', dismiss, true);
    if (action === 'new-in-project') {
      try {
        if (activePane !== 2) await goToPane(2);
        const body = { project: conv.project };
        const { convId } = await codexApi('/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (typeof invalidateUnifiedTreeCache === 'function') invalidateUnifiedTreeCache();
        if (activeProjectFilter !== conv.project) {
          setActiveProject(conv.project);
        }
        await selectCodexShared(convId, 'Nueva conversación', '', conv.project);
        $('input').focus();
      } catch (err) {
        toast('No se pudo crear la conversación: ' + err.message);
      }
      return;
    }
    if (action === 'copy-conversation') {
      try {
        await copyConversationMessages(() => codexApi(`/conversations/${conv.convId}/messages`));
      } catch (err) {
        toast('No se pudo copiar la conversación: ' + err.message);
      }
      return;
    }
    if (action === 'project') {
      await loadProjects().catch(() => {});
      showAssignProjectMenu(x, y, conv, 'codex');
      return;
    }
    if (action === 'compact') {
      if (!confirm('Compactar el contexto de Codex?\n\nEjecuta el /compact nativo. La conversación y sus archivos se conservan; solo reduce el contexto que Codex arrastra.')) return;
      try {
        await codexApi(`/conversations/${conv.convId}/compact`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        toast('Compactando el contexto de Codex…', 'info', 4000);
        loadCodexSharedTree();
      } catch (err) {
        toast('No se pudo compactar: ' + err.message);
      }
      return;
    }
    if (action === 'git-sync') {
      if (!confirm('Sincronizar Git en el repo de esta conversación?\n\nEjecuta directo: commit de cambios pendientes, pull con rebase y push. No hace force push ni descarta cambios.')) return;
      try {
        const result = await codexApi(`/conversations/${conv.convId}/git-sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        toast(gitSyncToast(result), 'info', 5000);
      } catch (err) {
        toast('No se pudo sincronizar Git: ' + err.message);
      }
      return;
    }
    try {
      const patch = action === 'pin' ? { pinned: !conv.pinned } : { hidden: true };
      await codexApi(`/conversations/${conv.convId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      if (action === 'hide' && currentCodexConv && currentCodexConv.id === conv.convId) closeChat();
      loadCodexSharedTree();
      if (action === 'hide') toast('Conversación ocultada', 'info', 2500);
    } catch (err) { toast('No se pudo actualizar: ' + err.message); }
  });
  menu.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
  setTimeout(() => {
    document.addEventListener('click', dismiss, true);
    document.addEventListener('touchstart', dismiss, true);
  }, 350);
}

function setCodexMainBusy(value) {
  codexMainBusy = value;
  // Codex registra el follow-up en su cola nativa mientras el turno corre.
  $('input').disabled = !currentCodexConv;
  $('send').disabled = !currentCodexConv;
  $('attach-btn').disabled = !currentCodexConv;
  $('cancel-btn').hidden = !value;
  $('conv-status').textContent = value ? 'escribiendo…' : '';
}

async function loadCodexSharedMessages(convId) {
  messagesEl.innerHTML = '';
  const messages = await codexApi(`/conversations/${convId}/messages`);
  if (!messages.length) {
    messagesEl.innerHTML = '<div id="empty-state"><p>Escribile algo a Codex</p></div>';
  } else {
    let lastAssistantDiv = null;
    let lastAssistantMsg = null;
    for (const m of messages) {
      if (m.role === 'tool') {
        addTool(m.name, m.input, m.output);
        lastAssistantDiv = null;
      } else {
        const div = addMsg(m.role, m.text, { ts: m.ts });
        if (m.role === 'assistant') {
          lastAssistantDiv = div;
          lastAssistantMsg = m;
        } else {
          lastAssistantDiv = null;
        }
      }
    }
    if (lastAssistantDiv && !codexMainBusy) {
      maybeShowReplySuggestions(convId, lastAssistantDiv, lastAssistantMsg.text, lastAssistantMsg.uuid || lastAssistantMsg.id, 'codex');
    }
  }
  scrollToBottom();
}

function openCodexSharedStream(convId) {
  const stream = new EventSource(`/api/codex/conversations/${convId}/stream`);
  stream.onmessage = e => {
    if (!currentCodexConv || currentCodexConv.id !== convId) return;
    const payload = JSON.parse(e.data);
    if (payload.kind === 'status') {
      setCodexMainBusy(payload.status !== 'idle');
      if (payload.status === 'idle') loadCodexSharedMessages(convId);
      loadCodexSharedTree();
      return;
    }
    if (payload.kind === 'meta') {
      if (payload.name) {
        if (currentCodexConv && currentCodexConv.id === convId) {
          currentCodexConv.name = payload.name;
          $('conv-title').textContent = payload.name;
        }
        loadCodexSharedTree();
      }
      return;
    }
    if (payload.kind !== 'codex') return;
    const item = payload.event && payload.event.item;
    if (!item || payload.event.type !== 'item.completed') return;
    if (item.type === 'agent_message' && item.text) addMsg('assistant', item.text);
    if (item.type === 'command_execution') addTool('command_execution', { command: item.command }, item.aggregated_output || '');
  };
  stream.onerror = () => setTimeout(() => {
    if (currentCodexConv && currentCodexConv.id === convId) loadCodexSharedMessages(convId);
  }, 1500);
  return stream;
}

async function selectCodexShared(convId, name, projectDir = '', project = undefined) {
  saveCurrentDraft();
  $('panel-chat').classList.add('codex-chat-theme');
  $('panel-chat').classList.remove('antigravity-chat-theme');
  if (eventSource) { eventSource.close(); eventSource = null; }
  if (codexStream) codexStream.close();
  if (geminiStream) { geminiStream.close(); geminiStream = null; }
  currentGeminiConv = null;
  currentConv = null;
  const resolvedProject = project !== undefined
    ? project
    : (!convId ? (activeProjectFilter && activeProjectFilter !== '__none__' ? activeProjectFilter : undefined) : currentCodexConv?.project);
  currentCodexConv = { id: convId, name, project: resolvedProject };
  $('conv-title').textContent = name;
  $('input').placeholder = 'Escribile a Codex…';
  restoreDraft(codexDrafts.get(convId));
  $('model-select').hidden = true;
  setConversationRepoChip(projectDir);
  $('cost-badge').hidden = true;
  $('mic-btn').hidden = true;
  $('attach-btn').hidden = false;
  $('file-input').accept = 'image/*,text/*,application/*,audio/*,video/*';
  $('queued-bar').hidden = true;
  $('last-user-pin').hidden = true;
  setCodexMainBusy(false);
  showNotebookView(false);
  showSalaView(false);
  openChat();
  const markRead = codexApi(`/conversations/${convId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unread: false }) }).catch(() => {});
  await loadCodexSharedMessages(convId);
  await markRead;
  codexStream = openCodexSharedStream(convId);
  loadCodexSharedTree();
  codexApi(`/conversations/${convId}/repo`).then(({ repo }) => {
    if (currentCodexConv && currentCodexConv.id === convId && repo) setConversationRepoChip(repo);
  }).catch(() => {});
  if (!isMobile()) $('input').focus();
}

async function createCodexSharedConversation() {
  await loadCodexAvailability();
  if (!codexAvailable) {
    await loadCodexSharedTree();
    return;
  }
  saveCurrentDraft();
  if (eventSource) { eventSource.close(); eventSource = null; }
  if (codexStream) { codexStream.close(); codexStream = null; }
  const p = activeProjectFilter && activeProjectFilter !== '__none__' ? activeProjectFilter : undefined;
  const body = p ? { project: p } : {};
  const { convId } = await codexApi('/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  currentConv = null;
  currentGeminiConv = null;
  $('panel-chat').classList.add('codex-chat-theme');
  currentCodexConv = { id: convId, name: 'Nueva conversación', project: p };
  $('conv-title').textContent = currentCodexConv.name;
  $('input').placeholder = 'Escribile a Codex…';
  restoreDraft(null);
  $('model-select').hidden = true;
  $('conv-folder').hidden = true;
  $('cost-badge').hidden = true;
  $('mic-btn').hidden = true;
  $('attach-btn').hidden = false;
  $('file-input').accept = 'image/*,text/*,application/*,audio/*,video/*';
  $('queued-bar').hidden = true;
  $('last-user-pin').hidden = true;
  messagesEl.innerHTML = '<div id="empty-state"><p>Escribile algo a Codex</p></div>';
  setCodexMainBusy(false);
  showNotebookView(false);
  showSalaView(false);
  openChat();
  if (typeof invalidateUnifiedTreeCache === 'function') invalidateUnifiedTreeCache();
  loadCodexSharedTree();
}

// Movido acá desde el final de app.js: la llamada original se ejecutaba
// antes de que este script cargara (app.js va primero en index.html) y
// tiraba ReferenceError, cortando el resto del arranque de app.js.
loadCodexAvailability();
