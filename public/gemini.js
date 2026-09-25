// ── Antigravity (AgY / Gemini) ──
// Extraído de app.js (split por dominio, sesión 15/09/2026).
// Script clásico (no ES module): comparte el scope global con el resto de los scripts.

async function geminiApi(path, opts) {
  const method = (opts && opts.method) || 'GET';
  const res = method === 'GET'
    ? await netFetch('/api/gemini' + path, opts)
    : await fetch('/api/gemini' + path, opts).catch(err => { throw netError(err); });
  if (!res.ok && res.status !== 202) throw new Error((await res.json()).error || res.statusText);
  return res.json();
}

const AGY_MODELS = [
  { value: 'claude-sonnet-4-6', label: 'Sonnet' },
  { value: 'gemini-3.8-flash-high', label: 'Flash High' },
  { value: 'gemini-3.8-flash-medium', label: 'Flash Medium' },
];

function setGeminiBusy(value) {
  geminiMainBusy = value;
  // Se puede seguir escribiendo: el runner conserva el orden de esta charla.
  $('input').disabled = !currentGeminiConv;
  $('send').disabled = !currentGeminiConv;
  $('attach-btn').disabled = !currentGeminiConv;
  $('cancel-btn').hidden = !value;
  $('conv-status').textContent = value ? 'escribiendo…' : '';
}

let geminiMessagesLoadVersion = 0;
async function loadGeminiMessages(id) {
  const loadVersion = ++geminiMessagesLoadVersion;
  let messages;
  try {
    messages = await geminiApi(`/conversations/${id}/messages`);
  } catch (err) {
    // Mantener lo que ya se estaba leyendo si el regreso de background pierde
    // momentáneamente la red o el stream.
    if (loadVersion === geminiMessagesLoadVersion && currentGeminiConv?.id === id) toast('No se pudo actualizar Antigravity. Reintentaremos al reconectar.', 'error', 4000);
    return false;
  }
  if (loadVersion !== geminiMessagesLoadVersion || currentGeminiConv?.id !== id) return false;
  messagesEl.innerHTML = '';
  if (!messages.length) {
    messagesEl.innerHTML = '<div id="empty-state"><p>Escribile algo a Antigravity</p></div>';
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
    if (lastAssistantDiv && !geminiMainBusy) {
      maybeShowReplySuggestions(id, lastAssistantDiv, lastAssistantMsg.text, lastAssistantMsg.uuid || lastAssistantMsg.id, 'gemini');
    }
  }
  scrollToBottom();
  return true;
}

function openGeminiStream(id) {
  let live = '', bubble = null;
  const seenTools = new Set();
  const stream = new EventSource(`/api/gemini/conversations/${id}/stream`);
  stream.onmessage = e => {
    if (!currentGeminiConv || currentGeminiConv.id !== id) return;
    const payload = JSON.parse(e.data);
    if (payload.kind === 'gemini') {
      const step = payload.event?.step_update;
      const delta = step?.text_delta;
      if (typeof delta === 'string') {
        live += delta;
        if (!bubble) bubble = addMsg('assistant', '');
        const text = bubble.querySelector('.msg-text');
        if (text) text.textContent = live;
        autoScroll();
      }
      const tool = step?.tool_info;
      const toolKey = step?.step_index ?? step?.id;
      const toolName = tool ? (tool.name || step.tool_name || step.step_type) : null;
      if (window.Mascot) Mascot.setState('working', toolName);
      if (tool && (step?.state === 'DONE' || step?.state === 'ERROR') && !seenTools.has(toolKey)) {
        seenTools.add(toolKey);
        addTool(toolName || 'herramienta', tool.parameters || tool.args || {}, tool.output || tool.error?.message || tool.result || '');
        autoScroll();
      }
      if (payload.event?.event === 'result' && payload.event?.result?.usage) {
        refreshGeminiCostBadge(id);
      }
      return;
    }
    if (payload.kind === 'status') {
      setGeminiBusy(payload.status !== 'idle');
      if (payload.status === 'idle') {
        if (window.Mascot) Mascot.setState('done');
        if (payload.incomplete && !payload.cancelled) {
          toast(payload.stderr || 'Antigravity no entregó una respuesta final.', 'error', 0, {
            label: 'Continuar',
            onClick: async () => {
              try {
                await geminiApi(`/conversations/${id}/message`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ text: 'Continuá el trabajo anterior desde donde se cortó y dame la respuesta final.' }),
                });
                toast('Antigravity continúa el trabajo…', 'info', 3000);
              } catch (err) {
                toast('No se pudo continuar: ' + err.message);
              }
            },
          });
        }
        loadGeminiMessages(id);
        refreshGeminiCostBadge(id);
      }
      // El runner ya está marcado como busy cuando emite este evento. Sin este
      // refresh el composer decía “escribiendo”, pero la fila AgY podía quedar
      // sin su ping hasta el final de la respuesta.
      loadGeminiTree();
      return;
    }
    if (payload.kind === 'usage') {
      refreshGeminiCostBadge(id);
      loadGeminiTree();
      return;
    }
    if (payload.kind === 'meta') {
      if (payload.name) {
        if (currentGeminiConv && currentGeminiConv.id === id) {
          currentGeminiConv.name = payload.name;
          $('conv-title').textContent = payload.name;
        }
        loadGeminiTree();
      }
      return;
    }
  };
  stream.onerror = () => setTimeout(() => {
    if (currentGeminiConv?.id === id) {
      loadGeminiMessages(id);
      refreshGeminiCostBadge(id);
    }
  }, 1500);
  return stream;
}

function geminiRow(c) {
  const div = document.createElement('div');
  div.className = 'conv conv-engine-gemini' + (currentGeminiConv?.id === c.convId ? ' active' : '');
  const label = c.name || c.snippet || '(nueva conversación)';
  const pin = c.pinned ? '<span class="conv-pin" title="Fijada">📌</span>' : '';
  const ai = c.aiTitle ? '<span class="conv-ai" title="Título generado por IA">✨</span>' : '';
  const pct = Math.min(1, c.contextPct || 0);
  const pctLabel = fmtCtxPct(pct);
  const ctxTitle = c.contextTokens
    ? `Contexto usado: ${(c.contextTokens).toLocaleString()} / ${(c.contextWindow || 1_000_000).toLocaleString()} tokens (${(pct * 100).toFixed(1)}%)`
    : `Contexto usado: ${(pct * 100).toFixed(1)}%`;
  const ctxHtml = pctLabel
    ? `<span class="conv-ctx" data-tone="${ctxTone(pct)}" title="${ctxTitle}">${pctLabel}</span>`
    : '';
  div.innerHTML = `<div class="conv-avatar">A</div><div class="conv-body"><div class="name">${pin}${ai}<span class="conv-name-text"></span></div><div class="sub"><span class="conv-project-tag"></span><span class="conv-date"></span>${ctxHtml}</div></div>${badge(c.status) || (c.unread ? '<span class="unread-dot"></span>' : '')}`;
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
  div.querySelector('.conv-date').textContent = c.snippet || '';
  div.onclick = () => {
    currentGeminiConv = { id: c.convId, name: label, model: c.model || 'gemini-3.8-flash-high', project: c.project };
    selectGemini(c.convId, label, c.gitRepo || c.projectDir, c.project);
  };
  attachGeminiRowGestures(div, c);
  return div;
}

async function loadGeminiTree() {
  if (activeProjectFilter && activeProjectFilter !== '__none__') {
    const data = typeof fetchUnifiedProjectTreeData === 'function' ? await fetchUnifiedProjectTreeData(activeProjectFilter) : null;
    if (data) {
      setPaneUnread('6', data.geminiUnread > 0);
      setPaneProcessing('6', data.geminiConvs.some(c => c.status && c.status !== 'idle'));
      const pane = $('gemini-pane');
      if (typeof renderUnifiedProjectTree === 'function') {
        renderUnifiedProjectTree(pane, data, 'gemini');
      }
      geminiTreeLoaded = true;
      return;
    }
  }
  const params = new URLSearchParams();
  if (activeProjectFilter) params.set('project', activeProjectFilter);
  const qs = params.toString() ? '?' + params.toString() : '';
  const { conversations, unreadTotal } = await geminiApi('/tree' + qs);
  setPaneUnread('6', unreadTotal > 0);
  setPaneProcessing('6', conversations.some(conversation => conversation.status && conversation.status !== 'idle'));
  const pane = $('gemini-pane');
  if (!conversations.length) {
    pane.innerHTML = `<div id="empty-state"><p>${activeProjectFilter ? 'Sin conversaciones para este proyecto' : 'Sin conversaciones de Antigravity todavía'}</p></div>`;
  } else {
    pane.replaceChildren(...conversations.map(geminiRow));
  }
  geminiTreeLoaded = true;
}

function attachGeminiRowGestures(el, conv) {
  let timer = null, longPressed = false;
  const show = (x, y) => showGeminiConvMenu(x, y, conv);
  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    show(e.clientX, e.clientY);
  });
  el.addEventListener('touchstart', e => {
    const t = e.touches[0];
    longPressed = false;
    timer = setTimeout(() => {
      longPressed = true;
      show(t.clientX, t.clientY);
      if (navigator.vibrate) navigator.vibrate(30);
    }, 500);
  }, { passive: true });
  el.addEventListener('touchmove', () => {
    if (timer) { clearTimeout(timer); timer = null; }
  }, { passive: true });
  el.addEventListener('touchend', () => {
    if (timer) clearTimeout(timer);
    timer = null;
  });
  el.addEventListener('click', e => {
    if (longPressed) {
      longPressed = false;
      e.preventDefault();
      e.stopPropagation();
    }
  }, { capture: true });
}

function showGeminiConvMenu(x, y, conv) {
  document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  const newInProjectBtn = (conv && conv.project)
    ? `<button data-action="new-in-project" title="Crear nueva conversación en ${String(conv.project).replace(/"/g, '&quot;')}">➕ Nueva conversación</button>`
    : '';
  menu.innerHTML = `${newInProjectBtn}<button data-action="copy">📋 Copiar conversación</button><button data-action="pin">${conv.pinned ? '📌 Desfijar' : '📌 Fijar'}</button><button data-action="project">🏷️ ${conv.project ? 'Cambiar proyecto…' : 'Asignar proyecto…'}</button><button data-action="hide" class="ctx-danger">🙈 Ocultar</button>`;
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
  const dismiss = () => {
    menu.remove();
    document.removeEventListener('click', dismiss, true);
    document.removeEventListener('touchstart', dismiss, true);
  };
  menu.addEventListener('click', async e => {
    const action = e.target.dataset.action;
    if (!action) return;
    dismiss();
    if (action === 'new-in-project') {
      try {
        if (activePane !== 6) await goToPane(6);
        if (activeProjectFilter !== conv.project) {
          setActiveProject(conv.project);
        }
        await selectGemini(null, 'Nueva conversación', '', conv.project);
        $('input').focus();
      } catch (err) {
        toast('No se pudo crear la conversación: ' + err.message);
      }
      return;
    }
    if (action === 'project') {
      await loadProjects().catch(() => {});
      showAssignProjectMenu(x, y, conv, 'gemini');
      return;
    }
    try {
      if (action === 'copy') {
        await copyConversationMessages(() => geminiApi(`/conversations/${conv.convId}/messages`));
      } else {
        await geminiApi(`/conversations/${conv.convId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(action === 'pin' ? { pinned: !conv.pinned } : { hidden: true }),
        });
        if (action === 'hide' && currentGeminiConv?.id === conv.convId) closeChat();
        loadGeminiTree();
      }
    } catch (err) {
      toast('No se pudo actualizar: ' + err.message);
    }
  });
  setTimeout(() => {
    document.addEventListener('click', dismiss, true);
    document.addEventListener('touchstart', dismiss, true);
  }, 250);
}

async function refreshGeminiCostBadge(convId) {
  const badge = $('cost-badge');
  if (!convId || (currentGeminiConv && currentGeminiConv.id !== convId)) return;
  try {
    const usage = await geminiApi(`/conversations/${convId}/usage`);
    if (!currentGeminiConv || currentGeminiConv.id !== convId) return;
    const pct = Math.min(1, usage.contextPct || 0);
    const ctx = usage.contextTokens || 0;
    const win = usage.contextWindow || 1_000_000;
    if (ctx === 0 && !pct) { badge.hidden = true; return; }
    badge.hidden = false;
    badge.dataset.tone = ctxTone(pct);
    const pctLabel = fmtCtxPct(pct);
    badge.textContent = pctLabel || fmtTokens(ctx);
    let details = `contexto: ${ctx.toLocaleString()} / ${win.toLocaleString()} tokens (${(pct * 100).toFixed(1)}%)`;
    if (usage.input_tokens != null || usage.output_tokens != null) {
      details += `\nconsumo del turno: in: ${(usage.input_tokens || 0).toLocaleString()}  out: ${(usage.output_tokens || 0).toLocaleString()}`;
      if (usage.thinking_tokens) details += `  thinking: ${usage.thinking_tokens.toLocaleString()}`;
      if (usage.cache_read_tokens) details += `  cache read: ${usage.cache_read_tokens.toLocaleString()}`;
    }
    if (usage.model) details += `\nmodelo: ${usage.model}`;
    badge.title = details;
  } catch {
    if (currentGeminiConv && currentGeminiConv.id === convId) badge.hidden = true;
  }
}

async function selectGemini(id, name, projectDir = '', project = undefined) {
  saveCurrentDraft();
  if (window.Mascot) Mascot.setState('idle'); // ver mismo comentario en selectConv (app.js)
  if (eventSource) { eventSource.close(); eventSource = null; }
  if (codexStream) codexStream.close();
  if (geminiStream) geminiStream.close();
  currentConv = null;
  currentCodexConv = null;
  const currentModel = (id ? currentGeminiConv?.model : 'gemini-3.8-flash-high') || 'gemini-3.8-flash-high';
  const resolvedProject = project !== undefined
    ? project
    : (!id ? (activeProjectFilter && activeProjectFilter !== '__none__' ? activeProjectFilter : undefined) : currentGeminiConv?.project);
  currentGeminiConv = { id, name, model: currentModel, project: resolvedProject };
  $('panel-chat').classList.remove('codex-chat-theme');
  $('panel-chat').classList.add('antigravity-chat-theme');
  $('conv-title').textContent = name;
  $('input').placeholder = 'Escribile a Antigravity…';
  setModelSelectOptions(AGY_MODELS, currentModel);
  $('model-select').hidden = false;
  setConversationRepoChip(projectDir);
  $('mic-btn').hidden = true;
  if (id) {
    refreshGeminiCostBadge(id);
  } else {
    $('cost-badge').hidden = true;
  }
  $('attach-btn').hidden = false;
  $('file-input').accept = 'image/*,text/*,application/*,audio/*,video/*';
  restoreDraft(antigravityDrafts.get(id || '__new__'));
  setGeminiBusy(false);
  showNotebookView(false);
  showSalaView(false);
  openChat();
  if (id) {
    await geminiApi(`/conversations/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unread: false }) });
    geminiApi(`/conversations/${id}/repo`).then(({ repo }) => {
      if (currentGeminiConv?.id === id && repo) setConversationRepoChip(repo);
    }).catch(() => {});
    await loadGeminiMessages(id);
    refreshGeminiCostBadge(id);
    geminiStream = openGeminiStream(id);
    loadGeminiTree();
  } else {
    messagesEl.innerHTML = '<div id="empty-state"><p>Escribile algo a Antigravity</p></div>';
  }
  if (!isMobile()) $('input').focus();
}

async function createGeminiConversation() {
  saveCurrentDraft();
  const p = activeProjectFilter && activeProjectFilter !== '__none__' ? activeProjectFilter : undefined;
  await selectGemini(null, 'Nueva conversación', '', p);
}
