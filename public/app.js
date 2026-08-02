let currentConv = null;
let eventSource = null;
let tree = [];
let treeLimit = 100;
let treeHasMore = false;
let treeTotal = 0;
let archivedTotal = 0;
let archivedTreeLimit = 100;
let archivedTreeHasMore = false;
let archivedTreeTotal = 0;
let viewingArchived = false;
let archivedPaneLoaded = false;
let activeAccount = null;
const drafts = new Map();

const $ = id => document.getElementById(id);
const messagesEl = $('messages');

// ── Selector de cuentas ──
async function loadAccounts() {
  try {
    const r = await fetch('/api/accounts');
    const { accounts, active, otherLocalUrl, otherPublicUrl, otherLabel } = await r.json();
    activeAccount = active;
    // Botón "ir a la otra instancia": elige URL local si estamos en 127.0.0.1/localhost,
    // pública en cualquier otro caso (celu vía Cloudflare tunnel).
    const sw = $('account-switch');
    if (sw && otherLabel && (otherLocalUrl || otherPublicUrl)) {
      const isLocal = /^(127\.0\.0\.1|localhost)$/.test(window.location.hostname);
      const url = isLocal
        ? (otherLocalUrl || otherPublicUrl)
        : (otherPublicUrl || otherLocalUrl);
      sw.textContent = `→ ${otherLabel}`;
      sw.href = url;
      sw.hidden = false;
    }
    const sel = $('account-select');
    // Modo single-user: ocultar el selector, no hay nada que elegir.
    if (accounts.length <= 1) { sel.hidden = true; return; }
    sel.hidden = false;
    sel.innerHTML = accounts.map(a =>
      `<option value="${a}" ${a === active ? 'selected' : ''}>${a}</option>`
    ).join('');
    sel.onchange = async () => {
      await fetch('/api/accounts/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: sel.value }),
      });
      activeAccount = sel.value;
      treeLimit = 100;
      resetArchivedPane();
      loadTree();
    };
  } catch {}
}

// ── Toast ──
function toast(msg, kind = 'error', ttl = 4000, action = null) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  const text = document.createElement('span');
  text.textContent = msg;
  t.appendChild(text);

  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    t.style.opacity = '0';
    t.style.transition = 'opacity .2s';
    setTimeout(() => t.remove(), 220);
  };

  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.type = 'button';
    btn.textContent = action.label;
    btn.onclick = () => { remove(); action.onClick(); };
    t.appendChild(btn);
  }

  container.appendChild(t);
  setTimeout(remove, ttl);
}

// ── PWA service worker + install ──
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

(function initPWA() {
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  if (isStandalone) return;

  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

  window.addEventListener('appinstalled', () => {
    $('install-bar').hidden = true;
    $('ios-tip').hidden = true;
  });

  if (isIOS) {
    $('ios-tip').hidden = false;
    $('ios-tip-close').onclick = () => { $('ios-tip').hidden = true; };
    return;
  }

  // Android/Chrome: mostrar el botón solo cuando el browser esté listo
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    $('install-bar').hidden = false;
  });

  $('install-btn').onclick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    $('install-bar').hidden = true;
  };
  $('install-dismiss').onclick = () => { $('install-bar').hidden = true; };
})();

// ── Forzar actualización del service worker ──
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.ready.then(reg => {
    reg.update(); // fuerza chequeo de nueva versión en cada carga
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      window.location.reload(); // nuevo SW activado → recarga automática
    });
  });
}

// ── Mobile nav + back button del celu ──
function isMobile() { return window.matchMedia('(max-width: 768px)').matches; }

function openChat() {
  const wasOpen = $('panel-chat').classList.contains('open');
  $('panel-chat').classList.add('open');
  if (isMobile() && !wasOpen) history.pushState({ view: 'chat' }, '');
}
function closeChat() {
  // Si estamos en el estado 'chat' de la history, delegar al popstate handler
  // vía history.back() para no romper la sincronización.
  if (isMobile() && history.state && history.state.view === 'chat') {
    history.back();
    return;
  }
  $('panel-chat').classList.remove('open');
}
$('back-btn').onclick = closeChat;

// Estado inicial: 'list' + varias entries de guarda para que popstate
// nunca dispare en el borde del historial (donde Android cierra el PWA sin dar tiempo a re-armar).
history.replaceState({ view: 'list' }, '');
for (let i = 0; i < 3; i++) history.pushState({ view: 'list-guard' }, '');

let _lastBackPress = 0;
let _exiting = false;
window.addEventListener('popstate', (e) => {
  if (_exiting) return; // salida en curso — dejamos que el browser cierre
  // Si estábamos en chat: cerrar y re-armar guarda
  if ($('panel-chat').classList.contains('open')) {
    $('panel-chat').classList.remove('open');
    history.pushState({ view: 'list-guard' }, '');
    return;
  }
  // Si hay algún menú/dialog abierto, cerrar y consumir el back
  const searchDlg = $('search-dialog');
  const newDlg = $('new-dialog');
  if (searchDlg.open) { searchDlg.close(); history.pushState({ view: 'list-guard' }, ''); return; }
  if (newDlg.open) { newDlg.close(); history.pushState({ view: 'list-guard' }, ''); return; }
  const ctxMenu = document.querySelector('.ctx-menu');
  if (ctxMenu) { ctxMenu.remove(); history.pushState({ view: 'list-guard' }, ''); return; }
  // Estamos en la lista raíz: doble click atrás para salir
  const now = Date.now();
  const DOUBLE_CLICK_MS = 600;
  if (now - _lastBackPress < DOUBLE_CLICK_MS) {
    // 2do press rápido — salir. Blastear a través de todas las guardas hasta 'list'
    // y dejar que el próximo back (o el mismo, si el browser lo agrupa) cierre el PWA.
    _exiting = true;
    setTimeout(() => { try { history.go(-10); } catch {} }, 0);
    return;
  }
  _lastBackPress = now;
  history.pushState({ view: 'list-guard' }, '');
  toast('Doble click atrás para salir', 'info', 1200);
});

// ── API ──
async function api(path, opts) {
  const res = await fetch('/api' + path, opts);
  if (!res.ok && res.status !== 202) throw new Error((await res.json()).error || res.statusText);
  return res.json();
}

// Anexa ?account=X o &account=X a un path GET, respetando el separador correcto.
function withAccount(path) {
  if (!activeAccount) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}account=${encodeURIComponent(activeAccount)}`;
}

// Devuelve el body con account: activeAccount agregado (para POST/PATCH).
function withAccountBody(body) {
  return activeAccount ? { ...body, account: activeAccount } : body;
}

// ── TTS (Web Speech API) ──
let ttsUtterance = null;
function speak(text, btn, kind = 'assistant') {
  if (!('speechSynthesis' in window)) return;
  if (ttsUtterance) {
    speechSynthesis.cancel();
    document.querySelectorAll('.msg-tts.playing').forEach(b => b.classList.remove('playing'));
    if (ttsUtterance._btn === btn) { ttsUtterance = null; return; }
  }
  const u = new SpeechSynthesisUtterance(text);
  const voiceName = kind === 'user' ? settings.voiceUser : settings.voiceAssistant;
  const voice = voiceName ? speechSynthesis.getVoices().find(v => v.name === voiceName) : null;
  if (voice) { u.voice = voice; u.lang = voice.lang; }
  else u.lang = 'es-AR';
  u._btn = btn;
  ttsUtterance = u;
  btn.classList.add('playing');
  u.onend = u.onerror = () => {
    btn.classList.remove('playing');
    if (ttsUtterance === u) ttsUtterance = null;
  };
  speechSynthesis.speak(u);
}

function cleanForTTS(text) {
  return text
    .replace(/\[Archivo adjunto:[^\]]+\]/g, '')
    .replace(/`?\/(?:home|tmp|root|var|opt|usr)[^\s`'"]+`?/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function makeTtsBtn(text, kind = 'assistant') {
  const clean = cleanForTTS(text);
  const btn = document.createElement('button');
  btn.className = 'msg-tts';
  btn.title = 'Reproducir';
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>';
  if (!clean) btn.style.display = 'none'; // no mostrar si no hay texto para leer
  btn.onclick = () => speak(clean, btn, kind);
  return btn;
}

// ── Refresh manual ──
async function refreshAll() {
  const btn = $('refresh-btn');
  btn.classList.add('spinning');
  try {
    await loadTree();
    if (archivedPaneLoaded) await loadArchivedTree();
    if (currentConv) await loadMessages(currentConv);
  } finally {
    btn.classList.remove('spinning');
  }
}
$('refresh-btn').onclick = refreshAll;

// ── Pull-to-refresh en el panel lista ──
function initPTR(navEl, loadFn) {
  const indicator = $('ptr-indicator');
  let startY = 0;
  let pulling = false;

  navEl.addEventListener('touchstart', e => {
    if (navEl.scrollTop === 0) { startY = e.touches[0].clientY; pulling = true; }
  }, { passive: true });

  navEl.addEventListener('touchmove', e => {
    if (!pulling) return;
    if (e.touches[0].clientY - startY > 60) indicator.hidden = false;
  }, { passive: true });

  navEl.addEventListener('touchend', async () => {
    if (!pulling) return;
    pulling = false;
    if (!indicator.hidden) {
      await loadFn();
      indicator.hidden = true;
    }
  });
}
initPTR($('tree'), safeLoadTree);
initPTR($('tree-archived'), safeLoadArchivedTree);

// ── Tree ──
function badge(status) {
  if (status === 'running') return '<span class="ping-dot active" title="Procesando…"><span class="ring"></span><span class="core"></span></span>';
  if (status === 'queued') return '<span class="conv-badge" title="En cola">⏳</span>';
  return '';
}

function avatarChar(name) {
  return (name || '?').trim()[0].toUpperCase();
}

function convElement(c) {
  const b = badge(c.status);
  const pin = c.pinned ? '<span class="conv-pin" title="Fijada">📌</span>' : '';
  const arch = c.archived ? '<span class="conv-arch" title="Archivada">📁</span>' : '';
  const ai = c.aiTitle ? '<span class="conv-ai" title="Título generado por IA">✨</span>' : '';
  const pct = c.contextPct || 0;
  const pctLabel = fmtCtxPct(pct);
  const ctxHtml = pctLabel
    ? `<span class="conv-ctx" data-tone="${ctxTone(pct)}" title="Contexto usado: ${(pct * 100).toFixed(1)}%">${pctLabel}</span>`
    : '';
  const div = document.createElement('div');
  div.className = 'conv' + (c.convId === currentConv ? ' active' : '') + (c.archived ? ' archived' : '');
  div.innerHTML = `
    <div class="conv-avatar">${avatarChar(c.name)}</div>
    <div class="conv-body">
      <div class="name">${pin}${arch}${ai}<span class="conv-name-text"></span></div>
      <div class="sub"><span class="conv-date"></span>${ctxHtml}</div>
    </div>
    ${b}
  `;
  div.querySelector('.conv-name-text').textContent = c.name;
  div.querySelector('.conv-date').textContent = (c.lastActivity || '').slice(0, 16).replace('T', ' ');
  div._conv = c;
  div.onclick = () => selectConv(c.convId, c.name, c.model, c.lastModel, c.currentDir || c.projectDir, c.responseMode);
  attachRowGestures(div, c);
  return div;
}

function buildTreePane(navEl, treeData) {
  navEl.innerHTML = '';
  for (const proj of treeData.tree) {
    const det = document.createElement('details');
    det.className = 'project';
    det.open = true;
    const sum = document.createElement('summary');
    sum.textContent = proj.projectDir.split('/').pop() || proj.projectDir;
    sum.title = proj.projectDir;
    det.appendChild(sum);
    for (const c of proj.conversations) det.appendChild(convElement(c));
    navEl.appendChild(det);
  }
}

async function loadTree() {
  const params = new URLSearchParams({ limit: String(treeLimit) });
  if (activeAccount) params.set('account', activeAccount);
  const resp = await api('/tree?' + params);
  tree = resp.tree;
  treeHasMore = resp.hasMore;
  treeTotal = resp.total;
  archivedTotal = resp.archivedTotal || 0;
  const nav = $('tree');
  buildTreePane(nav, resp);

  if (treeHasMore) {
    const more = document.createElement('button');
    more.id = 'load-more-btn';
    more.className = 'load-more';
    more.type = 'button';
    more.textContent = `Cargar más (${treeTotal - treeLimit} restantes)`;
    more.onclick = async () => {
      more.disabled = true;
      treeLimit += 100;
      try { await loadTree(); }
      catch (err) { toast('No se pudo cargar más: ' + err.message); more.disabled = false; }
    };
    nav.appendChild(more);
  }

  if (archivedTotal > 0) {
    const t = document.createElement('button');
    t.className = 'archived-toggle';
    t.type = 'button';
    t.textContent = `Ver archivadas (${archivedTotal})`;
    t.onclick = () => { goToArchived(); };
    nav.appendChild(t);
  }

  updateGlobalBusyIndicator();
}

async function loadArchivedTree() {
  const params = new URLSearchParams({ limit: String(archivedTreeLimit), archived: '1' });
  if (activeAccount) params.set('account', activeAccount);
  const resp = await api('/tree?' + params);
  archivedTreeHasMore = resp.hasMore;
  archivedTreeTotal = resp.total;
  const nav = $('tree-archived');
  buildTreePane(nav, resp);

  const back = document.createElement('button');
  back.className = 'archived-back';
  back.type = 'button';
  back.textContent = '← Volver a activas';
  back.onclick = () => { goToActive(); };
  nav.insertBefore(back, nav.firstChild);

  if (archivedTreeHasMore) {
    const more = document.createElement('button');
    more.id = 'load-more-archived-btn';
    more.className = 'load-more';
    more.type = 'button';
    more.textContent = `Cargar más (${archivedTreeTotal - archivedTreeLimit} restantes)`;
    more.onclick = async () => {
      more.disabled = true;
      archivedTreeLimit += 100;
      try { await loadArchivedTree(); }
      catch (err) { toast('No se pudo cargar más: ' + err.message); more.disabled = false; }
    };
    nav.appendChild(more);
  }
}

async function safeLoadArchivedTree() {
  try { await loadArchivedTree(); }
  catch (err) { toast('No se pudo actualizar archivadas: ' + err.message); }
}

async function goToArchived() {
  if (viewingArchived) return;
  if (!archivedPaneLoaded) {
    try {
      await loadArchivedTree();
      archivedPaneLoaded = true;
    } catch (err) {
      toast('No se pudo cargar archivadas: ' + err.message);
      return;
    }
  }
  viewingArchived = true;
  $('tree-viewport-inner').classList.add('showing-archived');
}

function goToActive() {
  viewingArchived = false;
  $('tree-viewport-inner').classList.remove('showing-archived');
}

function resetArchivedPane() {
  archivedPaneLoaded = false;
  archivedTreeLimit = 100;
  $('tree-archived').innerHTML = '';
  if (viewingArchived) goToActive();
}

// ── Indicador global de "procesando" (icono ping + título + badge de la app instalada) ──
let globalBusy = false;
function updateGlobalBusyIndicator() {
  const anyBusy = tree.some(proj => proj.conversations.some(c => c.status && c.status !== 'idle'));
  $('global-busy-dot').classList.toggle('active', anyBusy);
  document.title = anyBusy ? '● J.A.R.V.I.S' : 'J.A.R.V.I.S';
  if (anyBusy === globalBusy) return;
  globalBusy = anyBusy;
  if (!('setAppBadge' in navigator)) return;
  if (anyBusy) navigator.setAppBadge().catch(() => {});
  else navigator.clearAppBadge().catch(() => {});
}

function refreshVisibleTrees() {
  safeLoadTree();
  if (archivedPaneLoaded) safeLoadArchivedTree();
}

async function commitArchiveToggle(el, conv) {
  const wasArchived = !!conv.archived;
  const newArchived = !wasArchived;
  el.style.transition = 'transform .18s ease, opacity .18s ease';
  el.style.transform = 'translateX(100%)';
  el.style.opacity = '0';
  setTimeout(() => { el.remove(); }, 180);

  try {
    await api(`/conversations/${conv.convId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(withAccountBody({ archived: newArchived })),
    });
  } catch (err) {
    toast('No se pudo actualizar: ' + err.message);
    setTimeout(refreshVisibleTrees, 200);
    return;
  }

  const label = newArchived ? 'Conversación archivada' : 'Conversación desarchivada';
  toast(label, 'info', 4000, {
    label: 'Deshacer',
    onClick: async () => {
      try {
        await api(`/conversations/${conv.convId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(withAccountBody({ archived: wasArchived })),
        });
      } catch (err) {
        toast('No se pudo deshacer: ' + err.message);
      }
      refreshVisibleTrees();
    },
  });
  setTimeout(refreshVisibleTrees, 200);
}

// ── Menú contextual (click derecho + long-press mobile) + swipe-derecha para archivar ──
const ROW_SWIPE_THRESHOLD = 80;

function attachRowGestures(el, conv) {
  let touchTimer = null;
  let longPressed = false;
  let startX = 0, startY = 0;
  let axisLocked = null;
  let rowDragging = false;
  let currentDx = 0;
  let redirectedToPane = false;

  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    showConvMenu(e.clientX, e.clientY, conv);
  });

  el.addEventListener('touchstart', e => {
    longPressed = false;
    axisLocked = null;
    rowDragging = false;
    currentDx = 0;
    redirectedToPane = false;
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
    touchTimer = setTimeout(() => {
      longPressed = true;
      touchTimer = null;
      showConvMenu(startX, startY, conv);
      if (navigator.vibrate) { try { navigator.vibrate(30); } catch {} }
    }, 500);
  }, { passive: true });

  el.addEventListener('touchmove', e => {
    if (longPressed) return; // el menú ya abrió para este gesto: no arrastrar la fila
    const t = e.touches[0];

    if (redirectedToPane) {
      if (paneSwipeMove(t.clientX, t.clientY)) e.preventDefault();
      return;
    }

    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (axisLocked === null) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      axisLocked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
      if (axisLocked === 'x' && dx < 0) {
        // Arrastre hacia la izquierda: nunca archiva (solo la derecha lo
        // hace) — se lo cedemos al swipe de pantalla, porque en una lista
        // llena casi no queda fondo tocable fuera de las filas.
        redirectedToPane = true;
        if (paneSwipeStart(startX, startY) && paneSwipeMove(t.clientX, t.clientY)) e.preventDefault();
        return;
      }
    }
    if (axisLocked !== 'x') return;
    e.preventDefault();
    rowDragging = true;
    currentDx = Math.max(0, dx);
    el.style.transform = `translateX(${currentDx}px)`;
    el.style.opacity = String(Math.max(0.3, 1 - currentDx / 200));
  }, { passive: false });

  function resetRow() {
    el.style.transition = 'transform .2s ease, opacity .2s ease';
    el.style.transform = '';
    el.style.opacity = '';
    setTimeout(() => { el.style.transition = ''; }, 200);
  }

  el.addEventListener('touchend', async () => {
    if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
    if (redirectedToPane) {
      await paneSwipeEnd();
    } else if (rowDragging && !longPressed) {
      if (currentDx > ROW_SWIPE_THRESHOLD) commitArchiveToggle(el, conv);
      else resetRow();
    }
    redirectedToPane = false;
    rowDragging = false;
    axisLocked = null;
  });

  el.addEventListener('touchcancel', () => {
    if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
    if (redirectedToPane) {
      paneSwipeEnd();
    } else if (rowDragging) {
      resetRow();
    }
    redirectedToPane = false;
    rowDragging = false;
    axisLocked = null;
  });

  // Bloquear el click sintético que dispara touchend después del long-press
  // (si no, selecciona la conversación y cierra el menú)
  el.addEventListener('click', e => {
    if (longPressed) {
      longPressed = false;
      e.stopPropagation();
      e.preventDefault();
    }
  }, { capture: true });
}

function showConvMenu(x, y, conv) {
  document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.innerHTML = `
    <button data-action="pin">${conv.pinned ? '📌 Desfijar' : '📌 Fijar'}</button>
    <button data-action="archive">${conv.archived ? '📂 Desarchivar' : '📁 Archivar'}</button>
    <button data-action="compact">🗜️ Compactar</button>
  `;
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 8;
  const maxY = window.innerHeight - rect.height - 8;
  menu.style.left = Math.min(x, maxX) + 'px';
  menu.style.top = Math.min(y, maxY) + 'px';

  const doAction = async (action) => {
    menu.remove();
    document.removeEventListener('click', dismiss, true);
    document.removeEventListener('touchstart', dismiss, true);
    if (action === 'compact') {
      if (!confirm('Compactar la conversación?\n\nSe genera un resumen y la sesión actual queda archivada. La próxima respuesta arranca sesión nueva con el resumen inyectado.')) return;
      try {
        toast('Compactando…', 'info', 2000);
        const r = await api(`/conversations/${conv.convId}/compact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(withAccountBody({})),
        });
        toast(`Compactado (${r.messagesCompacted} mensajes resumidos)`, 'info', 3000);
        refreshVisibleTrees();
      } catch (err) { toast('No se pudo compactar: ' + err.message); }
      return;
    }
    const patch = action === 'pin'
      ? { pinned: !conv.pinned }
      : { archived: !conv.archived };
    try {
      await api(`/conversations/${conv.convId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(withAccountBody(patch)),
      });
      refreshVisibleTrees();
    } catch (err) { toast('No se pudo actualizar: ' + err.message); }
  };

  // Usar touchend/click en los botones directamente, con stopPropagation
  // para que no burbujee y dispare el dismiss.
  menu.addEventListener('click', e => {
    e.stopPropagation();
    const action = e.target.dataset && e.target.dataset.action;
    if (action) doAction(action);
  });
  menu.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });

  function dismiss(e) {
    if (menu.contains(e.target)) return;
    menu.remove();
    document.removeEventListener('click', dismiss, true);
    document.removeEventListener('touchstart', dismiss, true);
  }
  // Delay para saltear el click sintético del touchend que abrió el menú
  setTimeout(() => {
    document.addEventListener('click', dismiss, true);
    document.addEventListener('touchstart', dismiss, true);
  }, 350);
}

// ── Messages ──
function now() {
  return new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}

// ── Lightbox ──
(function initLightbox() {
  const lb = document.createElement('div');
  lb.id = 'lightbox';
  lb.innerHTML = `
    <div id="lightbox-backdrop"></div>
    <div id="lightbox-inner">
      <button id="lightbox-close" aria-label="Cerrar">✕</button>
      <img id="lightbox-img" alt="">
      <a id="lightbox-dl" download>⬇ Descargar</a>
    </div>
  `;
  document.body.appendChild(lb);

  function closeLightbox() { lb.classList.remove('open'); }
  lb.querySelector('#lightbox-backdrop').onclick = closeLightbox;
  lb.querySelector('#lightbox-close').onclick = closeLightbox;
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });

  window.openLightbox = function(src, downloadHref, filename) {
    const img = lb.querySelector('#lightbox-img');
    const dl = lb.querySelector('#lightbox-dl');
    img.src = src;
    dl.href = downloadHref;
    dl.download = filename || 'imagen';
    lb.classList.add('open');
  };
})();

const IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','webp','svg']);
const AUDIO_EXTS = new Set(['mp3','wav','ogg','m4a','webm']);
const VIDEO_EXTS = new Set(['mp4','mov','avi','mkv','webm']);

function fileIcon(ext) {
  if (IMAGE_EXTS.has(ext)) return '🖼';
  if (ext === 'pdf') return '📄';
  if (AUDIO_EXTS.has(ext)) return '🎵';
  if (VIDEO_EXTS.has(ext)) return '🎬';
  return '📎';
}

// Crea una card de archivo inline (para PDFs y otros no-imagen)
function makeFileCard(filePath) {
  const name = filePath.split('/').pop();
  const ext = name.split('.').pop().toLowerCase();
  const downloadHref = '/api/files?path=' + encodeURIComponent(filePath);
  const isPdf = ext === 'pdf';

  const card = document.createElement('div');
  card.className = 'file-card';

  if (isPdf) {
    // Intentar cargar thumbnail
    const thumb = document.createElement('img');
    thumb.className = 'file-thumb';
    thumb.alt = 'PDF';
    thumb.src = '/api/thumbnail?path=' + encodeURIComponent(filePath);
    thumb.onerror = () => { thumb.replaceWith(iconEl()); };
    card.appendChild(thumb);
  } else {
    card.appendChild(iconEl());
  }

  function iconEl() {
    const span = document.createElement('span');
    span.className = 'file-card-icon';
    span.textContent = fileIcon(ext);
    return span;
  }

  const info = document.createElement('div');
  info.className = 'file-card-info';
  const nameEl = document.createElement('span');
  nameEl.className = 'file-card-name';
  nameEl.textContent = name;
  nameEl.title = filePath;
  const dl = document.createElement('a');
  dl.className = 'file-card-dl';
  dl.href = downloadHref;
  dl.download = name;
  dl.textContent = 'Descargar';
  info.appendChild(nameEl);
  info.appendChild(dl);
  card.appendChild(info);
  return card;
}

// Detecta paths absolutos en texto y los convierte en links/previews
function renderTextWithPaths(container, text) {
  // Primero reemplazar [Archivo adjunto: PATH] con preview directo (Unix y Windows)
  const ATTACH_RE = /\[Archivo adjunto:\s*([^\]]+)\]/g;
  let processed = text;
  const attachMatches = [];
  let am;
  while ((am = ATTACH_RE.exec(text)) !== null) attachMatches.push({ full: am[0], path: am[1].trim(), index: am.index });

  if (attachMatches.length > 0) {
    let pos = 0;
    for (const att of attachMatches) {
      if (att.index > pos) renderTextWithPaths(container, text.slice(pos, att.index));
      const ext = att.path.split('.').pop().toLowerCase();
      if (IMAGE_EXTS.has(ext)) {
        const wrap = document.createElement('div');
        wrap.className = 'inline-img-wrap';
        const img = document.createElement('img');
        img.className = 'inline-thumb';
        img.src = '/api/thumbnail?path=' + encodeURIComponent(att.path);
        img.alt = att.path.split('/').pop();
        const dlHref = '/api/files?path=' + encodeURIComponent(att.path);
        img.onclick = () => openLightbox(dlHref, dlHref, img.alt);
        img.onerror = () => { wrap.innerHTML = ''; wrap.appendChild(document.createTextNode(att.path)); };
        wrap.appendChild(img);
        container.appendChild(wrap);
      } else {
        container.appendChild(makeFileCard(att.path));
      }
      pos = att.index + att.full.length;
    }
    if (pos < text.length) renderTextWithPaths(container, text.slice(pos));
    return;
  }

  // Paths sueltos — Unix (/home/...) y Windows (C:\... o C:/...)
  const PATH_RE = /(`?)((?:[A-Za-z]:[\\\/]|\/(?:home|tmp|root|var|opt|usr))[^\s`'"(){}<>\[\]]+)\1/g;
  let last = 0;
  let match;
  while ((match = PATH_RE.exec(text)) !== null) {
    if (match.index > last) {
      container.appendChild(document.createTextNode(text.slice(last, match.index)));
    }
    const filePath = match[2];
    const name = filePath.split('/').pop();
    const ext = filePath.split('.').pop().toLowerCase();
    const isImage = IMAGE_EXTS.has(ext);
    const isMedia = isImage || ext === 'pdf' || AUDIO_EXTS.has(ext) || VIDEO_EXTS.has(ext);

    if (isImage) {
      // Mostrar thumbnail clicable + link de descarga
      const wrap = document.createElement('span');
      wrap.className = 'inline-img-wrap';
      const img = document.createElement('img');
      img.className = 'inline-thumb';
      img.alt = name;
      img.src = '/api/thumbnail?path=' + encodeURIComponent(filePath);
      img.title = filePath;
      const downloadHref = '/api/files?path=' + encodeURIComponent(filePath);
      img.onclick = () => openLightbox(img.src.replace('/api/thumbnail', '/api/files').replace('?path=', '?path=') /* usa full src */, downloadHref, name);
      // Para abrir imagen completa en lightbox usar la src original (thumbnail puede ser suficiente visualmente, pero abrimos el archivo real)
      img.onclick = () => openLightbox(downloadHref, downloadHref, name);
      img.onerror = () => {
        // Fallback a link
        img.remove();
        const a = document.createElement('a');
        a.href = downloadHref;
        a.download = name;
        a.textContent = filePath;
        a.className = 'path-link';
        wrap.appendChild(a);
      };
      const dl = document.createElement('a');
      dl.href = downloadHref;
      dl.download = name;
      dl.textContent = name;
      dl.className = 'path-link';
      wrap.appendChild(img);
      wrap.appendChild(document.createElement('br'));
      wrap.appendChild(dl);
      container.appendChild(wrap);
    } else if (ext === 'pdf' || AUDIO_EXTS.has(ext) || VIDEO_EXTS.has(ext)) {
      container.appendChild(makeFileCard(filePath));
    } else if (isMedia) {
      const a = document.createElement('a');
      a.href = '/api/files?path=' + encodeURIComponent(filePath);
      a.download = name;
      a.textContent = filePath;
      a.className = 'path-link';
      container.appendChild(a);
    } else {
      const code = document.createElement('code');
      code.textContent = filePath;
      container.appendChild(code);
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    container.appendChild(document.createTextNode(text.slice(last)));
  }
}

// Detecta adjuntos/paths sueltos que quedaron como texto plano dentro del HTML
// ya parseado por marked, sin tocar lo que esté dentro de <code>/<pre>/<a>
// (ahí un path es código o ya es un link, no queremos "enriquecerlo" de nuevo).
function enrichPlainTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p = node.parentElement;
      while (p && p !== root) {
        if (p.tagName === 'CODE' || p.tagName === 'PRE' || p.tagName === 'A') return NodeFilter.FILTER_REJECT;
        p = p.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  for (const node of nodes) {
    const t = node.textContent;
    if (!t || !/\[Archivo adjunto:|[A-Za-z]:[\\/]|\/(?:home|tmp|root|var|opt|usr)\S/.test(t)) continue;
    const frag = document.createDocumentFragment();
    renderTextWithPaths(frag, t);
    node.replaceWith(frag);
  }
}

// Mensajes del asistente: markdown real (negrita, listas, tablas, código) +
// sanitizado, con el auto-linkeo de paths/adjuntos aplicado encima.
function renderAssistantText(container, text) {
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
    renderTextWithPaths(container, text);
    return;
  }
  const html = DOMPurify.sanitize(marked.parse(text, { breaks: true, gfm: true }));
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  tpl.content.querySelectorAll('a[href]').forEach(a => {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });
  enrichPlainTextNodes(tpl.content);
  container.appendChild(tpl.content);
}

// ── Auto-scroll pegado al fondo ──
// Solo bajamos solos si el usuario ya estaba al fondo. Si subió a leer algo
// mientras Claude sigue escribiendo, respetamos dónde está parado.
const STICK_THRESHOLD = 120; // px de tolerancia para considerar "al fondo"
let stickToBottom = true;
let suppressAutoScroll = false; // activo mientras loadMessages() reconstruye la lista

function isNearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= STICK_THRESHOLD;
}
function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
// Botón "ir al final": aparece solo cuando estás despegado del fondo.
// .new = llegó contenido mientras leías · .done = terminó el turno.
const jumpBtn = $('jump-bottom');

function syncJumpBtn() {
  if (stickToBottom) {
    jumpBtn.hidden = true;
    jumpBtn.classList.remove('new', 'done');
  } else {
    jumpBtn.hidden = false;
  }
}
function flagJumpBtn(kind) {
  if (stickToBottom) return;
  jumpBtn.hidden = false;
  jumpBtn.classList.toggle('new', kind === 'new');
  jumpBtn.classList.toggle('done', kind === 'done');
}
jumpBtn.addEventListener('click', () => {
  stickToBottom = true;
  syncJumpBtn();
  messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
});

function autoScroll() {
  if (suppressAutoScroll) return;
  if (stickToBottom) scrollToBottom();
  else flagJumpBtn('new');
}
messagesEl.addEventListener('scroll', () => {
  if (suppressAutoScroll) return;
  stickToBottom = isNearBottom();
  syncJumpBtn();
});

function addMsg(role, text, opts = {}) {
  const existing = document.getElementById('empty-state');
  if (existing) existing.remove();

  const div = document.createElement('div');
  div.className = 'msg ' + role;
  if (opts.compacted) div.classList.add('compacted');
  if (role !== 'error') {
    const span = document.createElement('div');
    span.className = 'msg-text';
    if (role === 'assistant') renderAssistantText(span, text);
    else renderTextWithPaths(span, text);
    const ttsBtn = makeTtsBtn(text, role === 'user' ? 'user' : 'assistant');
    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = now();
    div.appendChild(span);
    div.appendChild(ttsBtn);
    div.appendChild(time);
  } else {
    div.textContent = text;
  }
  messagesEl.appendChild(div);
  autoScroll();
  return div;
}

function addTool(name, input, output, opts = {}) {
  const det = document.createElement('details');
  det.className = 'tool';
  if (opts.compacted) det.classList.add('compacted');
  const rawSummary = typeof input === 'object' && input && input.command
    ? input.command
    : JSON.stringify(input || '').slice(0, 120);
  const summary = String(rawSummary).replace(/\s+/g, ' ').trim();
  det.innerHTML = '<summary></summary><pre class="in"></pre><pre class="out"></pre>';
  det.querySelector('summary').textContent = `▸ ${name}: ${summary}`;
  det.querySelector('.in').textContent = JSON.stringify(input, null, 2);
  det.querySelector('.out').textContent = output || '';

  // Botón descarga / preview para tool Write / Edit
  if ((name === 'Write' || name === 'Edit') && input && input.file_path) {
    const filePath = input.file_path;
    const fname = filePath.split('/').pop();
    const ext = fname.split('.').pop().toLowerCase();
    const downloadHref = '/api/files?path=' + encodeURIComponent(filePath);

    if (IMAGE_EXTS.has(ext)) {
      // Thumbnail clicable
      const thumbWrap = document.createElement('div');
      thumbWrap.className = 'tool-img-wrap';
      const img = document.createElement('img');
      img.className = 'tool-thumb';
      img.alt = fname;
      img.src = '/api/thumbnail?path=' + encodeURIComponent(filePath);
      img.onclick = () => openLightbox(downloadHref, downloadHref, fname);
      img.onerror = () => thumbWrap.remove();
      const dl = document.createElement('a');
      dl.className = 'tool-download';
      dl.href = downloadHref;
      dl.download = fname;
      dl.innerHTML = '⬇ ' + fname;
      thumbWrap.appendChild(img);
      thumbWrap.appendChild(dl);
      det.appendChild(thumbWrap);
    } else if (ext === 'pdf') {
      // Card PDF con thumbnail
      const card = makeFileCard(filePath);
      card.style.margin = '6px 0 0 0';
      det.appendChild(card);
    } else {
      const a = document.createElement('a');
      a.className = 'tool-download';
      a.href = downloadHref;
      a.download = fname;
      a.innerHTML = '⬇ ' + fname;
      det.appendChild(a);
    }
  }

  messagesEl.appendChild(det);
  autoScroll();
}

function addCompactDivider() {
  const div = document.createElement('div');
  div.className = 'compact-divider';
  div.innerHTML = `<span>🗜️ Conversación compactada — arranca sesión nueva desde acá</span><button class="compact-toggle" data-collapsed="0">Ocultar historial</button>`;
  const btn = div.querySelector('.compact-toggle');
  btn.addEventListener('click', () => {
    const collapsed = btn.dataset.collapsed === '1';
    document.querySelectorAll('#messages .compacted').forEach(el => {
      el.style.display = collapsed ? '' : 'none';
    });
    btn.dataset.collapsed = collapsed ? '0' : '1';
    btn.textContent = collapsed ? 'Ocultar historial' : 'Mostrar historial';
  });
  messagesEl.appendChild(div);
}

async function loadMessages(convId) {
  // Esta función vacía y reconstruye toda la lista (la llama el evento `idle`
  // del stream). Sin esto, el rebuild resetea el scroll y te tira al fondo
  // aunque estuvieras leyendo más arriba.
  const wasStuck = stickToBottom;
  const prevTop = messagesEl.scrollTop;
  suppressAutoScroll = true;
  try {
    messagesEl.innerHTML = '';
    const msgs = await api(withAccount(`/conversations/${convId}/messages`));
    if (msgs.length === 0) {
      messagesEl.innerHTML = '<div id="empty-state"><p>Sin mensajes aún</p></div>';
      return;
    }
    let inCompacted = false;
    let dividerPlaced = false;
    for (const m of msgs) {
      if (m.compacted && !inCompacted) inCompacted = true;
      if (!m.compacted && inCompacted && !dividerPlaced) {
        addCompactDivider();
        dividerPlaced = true;
        inCompacted = false;
      }
      const opts = { compacted: !!m.compacted };
      if (m.role === 'tool') addTool(m.name, m.input, m.output, opts);
      else addMsg(m.role, m.text, opts);
    }
    if (inCompacted && !dividerPlaced) addCompactDivider();
  } finally {
    suppressAutoScroll = false;
    if (wasStuck) scrollToBottom();
    else messagesEl.scrollTop = prevTop;
  }
}

// ── Status ──
function setStatus(text) {
  $('conv-status').textContent = text;
}

function setBusy(busy) {
  $('input').disabled = busy || !currentConv;
  $('send').disabled = busy || !currentConv;
  $('attach-btn').disabled = busy || !currentConv;
  $('mic-btn').disabled = busy || !currentConv;
  $('cancel-btn').hidden = !busy || !currentConv;
  setStatus(busy ? 'escribiendo…' : '');
}

// ── Stream ──
function openStream(convId) {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/conversations/${convId}/stream`);
  eventSource.onmessage = e => {
    if (convId !== currentConv) return;
    const payload = JSON.parse(e.data);
    if (payload.kind === 'claude') {
      const ev = payload.event;
      if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
        for (const b of ev.message.content) {
          if (b.type === 'text' && b.text.trim()) addMsg('assistant', b.text);
          else if (b.type === 'tool_use') addTool(b.name, b.input, '');
        }
      }
    } else if (payload.kind === 'status') {
      if (payload.status === 'idle') {
        setBusy(false);
        // Recargar ANTES de mostrar el error: loadMessages() reemplaza todo
        // messagesEl.innerHTML, así que si el addMsg('error', ...) va primero
        // queda tapado al instante por el reload.
        loadMessages(convId).then(() => {
          if (payload.code !== 0 && payload.stderr) addMsg('error', 'Error: ' + payload.stderr);
          // Turno terminado: si estás leyendo más arriba, el botón pasa a verde.
          flagJumpBtn('done');
        });
        refreshVisibleTrees();
        refreshCostBadge(convId);
      } else {
        setBusy(true);
        refreshVisibleTrees();
      }
    } else if (payload.kind === 'meta') {
      if (payload.name) $('conv-title').textContent = payload.name;
      refreshVisibleTrees();
    }
  };
  eventSource.onerror = () => {
    if (convId !== currentConv) return;
    // El tunnel de Cloudflare puede cortar el stream SSE en turnos largos;
    // EventSource reconecta solo pero cualquier evento emitido durante el
    // corte se pierde (el servidor no los reenvía). Al reconectar, refrescar
    // por las dudas para no dejar la conversación "colgada" con el mensaje
    // enviado sin respuesta visible.
    setTimeout(() => {
      if (convId !== currentConv) return;
      loadMessages(convId);
      refreshVisibleTrees();
    }, 1500);
  };
}

// ── Cost badge ──
function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}
function fmtCtxPct(pct) {
  if (!pct) return '';
  const p = pct * 100;
  return p < 1 ? '<1%' : Math.round(p) + '%';
}
function ctxTone(pct) {
  if (pct >= 0.8) return 'hot';
  if (pct >= 0.5) return 'warm';
  return '';
}
async function refreshCostBadge(convId) {
  const badge = $('cost-badge');
  try {
    const usage = await api(withAccount(`/conversations/${convId}/usage`));
    const t = usage.total;
    const totalTokens = (t.input || 0) + (t.output || 0) + (t.cacheCreate || 0) + (t.cacheRead || 0);
    if (totalTokens === 0) { badge.hidden = true; return; }
    const cost = usage.costUSD || 0;
    const pct = usage.contextPct || 0;
    const ctx = usage.contextTokens || 0;
    const win = usage.contextWindow || 200000;
    badge.hidden = false;
    badge.dataset.tone = ctxTone(pct);
    const pctLabel = fmtCtxPct(pct);
    // Compacto: solo el % (o los tokens si todavía no hay % calculado) — el
    // detalle completo se ve al tocar el badge, no hace falta hover en mobile.
    badge.textContent = pctLabel || fmtTokens(totalTokens);
    badge.title = `contexto: ${ctx.toLocaleString()} / ${win.toLocaleString()} tokens (${(pct * 100).toFixed(1)}%)\n` +
                  `in: ${t.input.toLocaleString()}  out: ${t.output.toLocaleString()}\n` +
                  `cache write: ${t.cacheCreate.toLocaleString()}  cache read: ${t.cacheRead.toLocaleString()}\n` +
                  `costo estimado: US$ ${cost.toFixed(4)}`;
  } catch {
    badge.hidden = true;
  }
}
$('cost-badge').onclick = () => toast($('cost-badge').title, 'info', 5000);

// ── Select conversation ──
async function selectConv(convId, name, model, lastModel, projectDir) {
  if (currentConv) drafts.set(currentConv, $('input').value);
  currentConv = convId;
  $('input').value = drafts.get(convId) || '';
  autoResize($('input'));
  $('conv-title').textContent = name;
  $('model-select').value = model || 'sonnet';
  const folderEl = $('conv-folder');
  const dirName = (projectDir || '').split(/[\\/]/).filter(Boolean).pop();
  folderEl.textContent = dirName || '';
  folderEl.title = projectDir || '';
  folderEl.hidden = !dirName;
  setBusy(false);
  clearAttachments();
  openChat();
  // Al abrir otra conversación siempre arrancamos abajo, sin heredar la
  // posición de scroll de la anterior.
  stickToBottom = true;
  syncJumpBtn();
  await loadMessages(convId);
  openStream(convId);
  loadTree();
  refreshCostBadge(convId);
  // En mobile no autofocuseamos porque dispararía el teclado en pantalla apenas tocás la lista.
  if (!isMobile()) {
    const input = $('input');
    input.focus();
    const len = input.value.length;
    input.setSelectionRange(len, len);
  }
}

// ── Textarea auto-resize ──
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}
$('input').addEventListener('input', () => autoResize($('input')));

// ── Keyboard ──
// En móvil el Enter del teclado virtual hace punto aparte (no envía) — para enviar
// está el botón. En desktop se mantiene Enter=enviar / Shift+Enter=nueva línea.
const isTouchDevice = window.matchMedia('(hover: none) and (pointer: coarse)').matches;

$('input').addEventListener('keydown', e => {
  if (isTouchDevice) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!$('send').disabled) $('composer').requestSubmit();
  }
});

// ── Cancel ──
$('cancel-btn').onclick = async () => {
  if (!currentConv) return;
  try { await api(`/conversations/${currentConv}/message`, { method: 'DELETE' }); }
  catch (err) { addMsg('error', 'No se pudo cancelar: ' + err.message); }
};

// ── Attachments ──
const pendingAttachments = []; // [{ path, name }]

function clearAttachments() {
  pendingAttachments.length = 0;
  $('composer-attachments').innerHTML = '';
}

function addAttachmentChip(name, filePath, localFile) {
  const ext = name.split('.').pop().toLowerCase();
  const isImg = IMAGE_EXTS.has(ext);

  const chip = document.createElement('div');
  chip.className = 'attach-chip' + (isImg ? ' attach-chip-img' : '');

  if (isImg && localFile) {
    const objUrl = URL.createObjectURL(localFile);
    const img = document.createElement('img');
    img.className = 'attach-preview-img';
    img.alt = name;
    img.src = objUrl;
    img.onload = () => {}; // keep object URL alive until chip removed
    chip._objUrl = objUrl;
    chip.appendChild(img);
  } else {
    chip.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5a2.5 2.5 0 0 1 5 0v10.5c0 .83-.67 1.5-1.5 1.5s-1.5-.67-1.5-1.5V6H9v9.5a2.5 2.5 0 0 0 5 0V5c0-2.21-1.79-4-4-4S6 2.79 6 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>`;
  }

  const nameSpan = document.createElement('span');
  nameSpan.className = 'attach-chip-name';
  nameSpan.title = name;
  nameSpan.textContent = name;

  const removeBtn = document.createElement('button');
  removeBtn.className = 'attach-chip-remove';
  removeBtn.type = 'button';
  removeBtn.setAttribute('aria-label', 'Quitar');
  removeBtn.textContent = '✕';
  removeBtn.onclick = () => {
    if (chip._objUrl) URL.revokeObjectURL(chip._objUrl);
    const idx = pendingAttachments.findIndex(a => a.path === filePath);
    if (idx >= 0) pendingAttachments.splice(idx, 1);
    chip.remove();
  };

  chip.appendChild(nameSpan);
  chip.appendChild(removeBtn);
  $('composer-attachments').appendChild(chip);
}

async function uploadAttachment(file) {
  if (!currentConv) { addMsg('error', 'Elegí una conversación antes de adjuntar'); return; }
  const displayName = file.name || `pegado-${Date.now()}.${(file.type.split('/')[1] || 'bin')}`;
  const loadingChip = document.createElement('div');
  loadingChip.className = 'attach-chip attach-chip-loading';
  loadingChip.innerHTML = `<span class="attach-spinner"></span><span class="attach-chip-name"></span>`;
  loadingChip.querySelector('.attach-chip-name').textContent = displayName;
  $('composer-attachments').appendChild(loadingChip);

  try {
    const fd = new FormData();
    fd.append('file', file, displayName);
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const { path: filePath, name } = await res.json();
    loadingChip.remove();
    pendingAttachments.push({ path: filePath, name });
    addAttachmentChip(name, filePath, file);
  } catch (err) {
    loadingChip.remove();
    addMsg('error', 'No se pudo subir: ' + err.message);
  }
}

async function uploadFiles(files) {
  for (const f of files) await uploadAttachment(f);
}

$('attach-btn').onclick = () => { $('file-input').click(); };
$('file-input').onchange = async () => {
  const files = Array.from($('file-input').files);
  $('file-input').value = '';
  await uploadFiles(files);
};

// ── Paste (imágenes/archivos del portapapeles) ──
$('input').addEventListener('paste', (e) => {
  if (!e.clipboardData) return;
  const files = Array.from(e.clipboardData.files || []);
  if (files.length === 0) return;
  e.preventDefault();
  uploadFiles(files);
});

// ── Drag & drop sobre el panel de chat ──
(function setupDragDrop() {
  const zone = document.getElementById('panel-chat');
  let depth = 0;
  const show = () => { zone.classList.add('drag-over'); };
  const hide = () => { zone.classList.remove('drag-over'); depth = 0; };

  // Los eventos "dragenter"/"dragleave" se disparan por cada hijo que atraviesa el cursor,
  // por eso contamos profundidad en vez de togglear crudo.
  zone.addEventListener('dragenter', (e) => {
    if (!currentConv || !e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    depth++;
    show();
  });
  zone.addEventListener('dragover', (e) => {
    if (!currentConv || !e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  zone.addEventListener('dragleave', (e) => {
    if (depth === 0) return;
    depth--;
    if (depth === 0) hide();
  });
  zone.addEventListener('drop', (e) => {
    if (!currentConv) return;
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (files.length === 0) return;
    e.preventDefault();
    hide();
    uploadFiles(files);
  });
  // Evitar que el browser abra el archivo si el drop cae fuera de la zona
  window.addEventListener('dragover', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault(); });
})();

// ── Mic / Grabación ──
let mediaRecorder = null;
let audioChunks = [];

$('mic-btn').onclick = async () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      $('mic-btn').classList.remove('recording');
      setStatus('transcribiendo…');
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      const fd = new FormData();
      fd.append('audio', blob, 'audio.webm');
      try {
        const res = await fetch('/api/transcribe', { method: 'POST', body: fd });
        if (!res.ok) throw new Error((await res.json()).error || res.statusText);
        const { text } = await res.json();
        if (text) {
          const input = $('input');
          input.value = (input.value ? input.value + ' ' : '') + text;
          autoResize(input);
        }
      } catch (err) {
        addMsg('error', 'Error transcripción: ' + err.message);
      } finally {
        setStatus('');
      }
    };
    mediaRecorder.start();
    $('mic-btn').classList.add('recording');
    $('mic-btn').title = 'Detener grabación';
  } catch (err) {
    addMsg('error', 'No se pudo acceder al micrófono: ' + err.message);
  }
};

// ── Mensaje de usuario con adjuntos inline ──
function addUserMsgWithFiles(text, attachments) {
  const existing = document.getElementById('empty-state');
  if (existing) existing.remove();

  const div = document.createElement('div');
  div.className = 'msg user';

  // Previews de adjuntos encima del texto
  for (const a of attachments) {
    const ext = a.name.split('.').pop().toLowerCase();
    if (IMAGE_EXTS.has(ext)) {
      const wrap = document.createElement('div');
      wrap.className = 'inline-img-wrap';
      const img = document.createElement('img');
      img.className = 'inline-thumb';
      img.src = '/api/thumbnail?path=' + encodeURIComponent(a.path);
      img.alt = a.name;
      img.onclick = () => openLightbox(
        '/api/files?path=' + encodeURIComponent(a.path),
        '/api/files?path=' + encodeURIComponent(a.path),
        a.name
      );
      img.onerror = () => { wrap.remove(); };
      wrap.appendChild(img);
      div.appendChild(wrap);
    } else {
      div.appendChild(makeFileCard(a.path));
    }
  }

  if (text) {
    const span = document.createElement('div');
    span.className = 'msg-text';
    span.textContent = text;
    div.appendChild(span);
  }

  const ttsBtn = makeTtsBtn(text || '', 'user');
  const time = document.createElement('span');
  time.className = 'msg-time';
  time.textContent = now();
  div.appendChild(ttsBtn);
  div.appendChild(time);

  messagesEl.appendChild(div);
  // Mensaje propio: siempre bajamos y volvemos a "pegarnos" al fondo.
  stickToBottom = true;
  syncJumpBtn();
  scrollToBottom();
}

// ── Send ──
$('composer').onsubmit = async e => {
  e.preventDefault();
  const rawText = $('input').value.trim();
  if ((!rawText && pendingAttachments.length === 0) || !currentConv) return;

  let text = rawText;
  if (pendingAttachments.length > 0) {
    const paths = pendingAttachments.map(a => `[Archivo adjunto: ${a.path}]`).join('\n');
    text = paths + (rawText ? '\n\n' + rawText : '');
  }

  // Mostrar mensaje con previews de archivos adjuntos
  addUserMsgWithFiles(rawText, [...pendingAttachments]);
  $('input').value = '';
  autoResize($('input'));
  drafts.delete(currentConv);
  clearAttachments();
  setBusy(true);
  try {
    await api(`/conversations/${currentConv}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(withAccountBody({ text })),
    });
  } catch (err) {
    addMsg('error', err.message);
    setBusy(false);
  }
};

// ── Model change ──
$('model-select').onchange = async () => {
  if (!currentConv) return;
  try {
    await api(`/conversations/${currentConv}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(withAccountBody({ model: $('model-select').value })),
    });
  } catch (err) { addMsg('error', 'No se pudo cambiar el modelo: ' + err.message); }
};

// ── Rename ──
$('conv-title').ondblclick = () => {
  if (!currentConv) return;
  const el = $('conv-title');
  el.contentEditable = 'true';
  el.focus();
  el.onblur = async () => {
    el.contentEditable = 'false';
    try {
      await api(`/conversations/${currentConv}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(withAccountBody({ name: el.textContent.trim() })),
      });
      loadTree();
    } catch (err) { addMsg('error', 'No se pudo renombrar: ' + err.message); }
  };
  el.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); el.blur(); } };
};

// ── Nueva conversación ──
$('new-conv').onclick = () => {
  const sel = $('project-select');
  sel.innerHTML = '';
  const home = document.createElement('option');
  home.value = '';
  home.textContent = '— seguir en casa (sin mensaje inicial) —';
  sel.appendChild(home);
  for (const proj of tree) {
    const opt = document.createElement('option');
    opt.value = proj.projectDir;
    opt.textContent = proj.projectDir;
    sel.appendChild(opt);
  }
  $('new-dialog').showModal();
};

$('new-form').onsubmit = async e => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  const vpsProject = $('vps-project-custom').value.trim() || $('vps-project').value;
  const localDir = $('project-custom').value.trim() || $('project-select').value;
  // Sin VPS ni carpeta local elegida: se queda en casa, sin mensaje inicial
  // (ya arranca ahí, no hace falta pedirle que "vaya" a ningún lado).
  const projectDir = vpsProject ? `VPS: ${vpsProject}` : (localDir || undefined);
  const text = vpsProject ? `Vamos a trabajar en ${vpsProject} en el VPS.` : (localDir ? `Vamos a trabajar en ${localDir}.` : '');
  const model = $('new-model').value;
  const submitBtn = e.submitter;
  if (submitBtn) submitBtn.disabled = true;
  try {
    const { convId, projectDir: resolvedDir } = await api('/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(withAccountBody({ projectDir, text, model: model || undefined })),
    });
    $('new-dialog').close();
    $('project-custom').value = '';
    $('vps-project').value = '';
    $('vps-project-custom').value = '';
    $('new-model').value = '';
    await selectConv(convId, text ? text.slice(0, 60) : 'Nueva conversación', model, null, resolvedDir);
    if (text) {
      addMsg('user', text);
      setBusy(true);
    }
  } catch (err) {
    toast('No se pudo crear la conversación: ' + err.message);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
};

// ── Búsqueda global ──
let searchDebounce = null;
let searchLastQuery = '';
let searchResults = [];

function highlightSnippet(snippet, query) {
  const q = query.trim();
  if (!q) return snippet;
  const idx = snippet.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return snippet;
  const before = document.createTextNode(snippet.slice(0, idx));
  const hit = document.createElement('mark');
  hit.textContent = snippet.slice(idx, idx + q.length);
  const after = document.createTextNode(snippet.slice(idx + q.length));
  const frag = document.createDocumentFragment();
  frag.appendChild(before); frag.appendChild(hit); frag.appendChild(after);
  return frag;
}

async function runSearch(q) {
  const box = $('search-results');
  if (!q.trim()) { box.innerHTML = ''; searchResults = []; return; }
  box.innerHTML = '<div class="search-loading">Buscando…</div>';
  try {
    const { results } = await api(withAccount('/search?limit=50&q=' + encodeURIComponent(q)));
    searchResults = results;
    searchLastQuery = q;
    box.innerHTML = '';
    if (results.length === 0) {
      box.innerHTML = '<div class="search-empty">Sin resultados</div>';
      return;
    }
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'search-result';
      row.dataset.idx = String(i);
      const name = document.createElement('div');
      name.className = 'search-name';
      name.textContent = r.displayName || r.name || '(sin título)';
      const snip = document.createElement('div');
      snip.className = 'search-snippet';
      snip.appendChild(highlightSnippet(r.snippet || '', q));
      const meta = document.createElement('div');
      meta.className = 'search-meta';
      meta.textContent = r.role + ' · ' + (r.cwd || '').split('/').pop() + ' · ' + (r.lastActivity || '').slice(0, 16).replace('T', ' ');
      row.appendChild(name); row.appendChild(snip); row.appendChild(meta);
      row.onclick = () => openSearchResult(r);
      box.appendChild(row);
    }
  } catch (err) {
    box.innerHTML = '';
    toast('Error buscando: ' + err.message);
  }
}

async function openSearchResult(r) {
  $('search-dialog').close();
  await selectConv(r.convId, r.displayName || r.name, r.model, r.lastModel, r.cwd);
  // Scroll al match — buscamos por índice de mensaje
  requestAnimationFrame(() => {
    const nodes = messagesEl.querySelectorAll('.msg, details.tool');
    const target = nodes[r.matchIndex];
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('search-hit');
      setTimeout(() => target.classList.remove('search-hit'), 2000);
    }
  });
}

function openSearchDialog() {
  const dlg = $('search-dialog');
  const input = $('search-input');
  input.value = '';
  $('search-results').innerHTML = '';
  dlg.showModal();
  input.focus();
}

$('search-btn').onclick = openSearchDialog;
$('search-input').addEventListener('input', () => {
  clearTimeout(searchDebounce);
  const v = $('search-input').value;
  searchDebounce = setTimeout(() => runSearch(v), 250);
});
$('search-form').onsubmit = e => {
  e.preventDefault();
  if (searchResults[0]) openSearchResult(searchResults[0]);
};
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openSearchDialog();
  }
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Tab') return;
  if (document.querySelector('dialog[open]')) return;
  if (!currentConv) return;
  const top2 = [...document.querySelectorAll('#tree .conv')].slice(0, 2);
  if (top2.length < 2) return;
  e.preventDefault();
  const target = top2[0]._conv.convId === currentConv ? top2[1] : top2[0];
  const c = target._conv;
  selectConv(c.convId, c.name, c.model, c.lastModel, c.currentDir || c.projectDir);
});

// ── Swipe de pantalla (activas ↔ archivadas, solo táctil) ──
// Expuesto como funciones (no IIFE) porque attachRowGestures también las
// invoca cuando detecta un arrastre hacia la izquierda que empieza sobre
// una fila (ver Finding 2 del review final: con la lista llena de filas,
// casi no queda fondo tocable para iniciar el swipe de pantalla).
const PANE_SWIPE_THRESHOLD = 60;
let paneStartX = 0, paneStartY = 0, paneAxisLocked = null, paneDragging = false, paneCurrentTranslate = 0, paneNavigating = false;

function paneViewportWidth() {
  return $('tree-viewport').getBoundingClientRect().width;
}

function paneSwipeStart(clientX, clientY) {
  if (paneNavigating) return false; // no arrancar un gesto nuevo con una navegación en curso
  paneStartX = clientX; paneStartY = clientY;
  paneAxisLocked = null;
  paneDragging = true;
  $('tree-viewport-inner').style.transition = 'none';
  return true;
}

function paneSwipeMove(clientX, clientY) {
  if (!paneDragging) return false;
  const dx = clientX - paneStartX;
  const dy = clientY - paneStartY;
  if (paneAxisLocked === null) {
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return false;
    paneAxisLocked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
  }
  if (paneAxisLocked !== 'x') return false;
  const base = viewingArchived ? -paneViewportWidth() : 0;
  paneCurrentTranslate = Math.min(0, Math.max(-paneViewportWidth(), base + dx));
  $('tree-viewport-inner').style.transform = `translateX(${paneCurrentTranslate}px)`;
  return true;
}

async function paneSwipeEnd() {
  if (!paneDragging) return;
  paneDragging = false;
  const inner = $('tree-viewport-inner');

  try {
    if (paneAxisLocked === 'x') {
      const base = viewingArchived ? -paneViewportWidth() : 0;
      const delta = paneCurrentTranslate - base;
      // Navigate first (await if async), THEN clear inline styles so CSS class transform can take over
      if (!viewingArchived && delta < -PANE_SWIPE_THRESHOLD) {
        paneNavigating = true;
        await goToArchived();
      } else if (viewingArchived && delta > PANE_SWIPE_THRESHOLD) {
        paneNavigating = true;
        goToActive();
      }
    }
  } finally {
    inner.style.transition = '';
    inner.style.transform = '';
    paneAxisLocked = null;
    paneNavigating = false;
  }
}

function initPaneSwipe() {
  const viewport = $('tree-viewport');

  viewport.addEventListener('touchstart', e => {
    if (e.target.closest('.conv')) return; // una fila maneja su propio gesto (ver attachRowGestures)
    const t = e.touches[0];
    paneSwipeStart(t.clientX, t.clientY);
  }, { passive: true });

  viewport.addEventListener('touchmove', e => {
    const t = e.touches[0];
    if (paneSwipeMove(t.clientX, t.clientY)) e.preventDefault();
  }, { passive: false });

  viewport.addEventListener('touchend', paneSwipeEnd);
  viewport.addEventListener('touchcancel', paneSwipeEnd);
}
initPaneSwipe();

async function safeLoadTree() {
  try { await loadTree(); }
  catch (err) { toast('No se pudo actualizar la lista: ' + err.message); }
}
function pollTrees() {
  safeLoadTree();
  if (archivedPaneLoaded) safeLoadArchivedTree();
}
loadAccounts().then(() => safeLoadTree());
setInterval(pollTrees, 15000);

// ── Configuración ──
const SETTINGS_KEY = 'ccm.settings';
const DEFAULT_SETTINGS = {
  showTools: true,
  voiceAssistant: '',
  voiceUser: '',
  colorAccent: '',
  colorMe: '',
  colorAi: '',
  fontFamily: '',
  fontSize: '',
  chatZoom: 1,
  sidebarWidth: '',
  sidebarHidden: false,
};
// Stacks 100% de fuentes de sistema (sin descargar nada, offline-friendly).
// El label es el nombre real de la fuente para poder mostrar cada <option>
// escrita en su propia tipografía y elegir a ojo.
const FONT_FAMILY_OPTIONS = [
  { value: '', label: 'Sistema', stack: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" },
  { value: 'arial', label: 'Arial', stack: "Arial, Helvetica, sans-serif" },
  { value: 'verdana', label: 'Verdana', stack: "Verdana, Geneva, sans-serif" },
  { value: 'tahoma', label: 'Tahoma', stack: "Tahoma, Geneva, sans-serif" },
  { value: 'trebuchet', label: 'Trebuchet MS', stack: "'Trebuchet MS', sans-serif" },
  { value: 'century', label: 'Century Gothic', stack: "'Century Gothic', CenturyGothic, Futura, sans-serif" },
  { value: 'georgia', label: 'Georgia', stack: "Georgia, serif" },
  { value: 'times', label: 'Times New Roman', stack: "'Times New Roman', Times, serif" },
  { value: 'garamond', label: 'Garamond', stack: "Garamond, 'Palatino Linotype', serif" },
  { value: 'mono', label: 'Consolas', stack: "Consolas, 'SFMono-Regular', Menlo, 'Courier New', monospace" },
  { value: 'comic', label: 'Comic Sans MS', stack: "'Comic Sans MS', 'Comic Sans', cursive" },
  { value: 'impact', label: 'Impact', stack: "Impact, 'Arial Narrow Bold', sans-serif" },
];
const FONT_FAMILY_MAP = Object.fromEntries(FONT_FAMILY_OPTIONS.map(f => [f.value, f.stack]));
const FONT_SIZE_MAP = { sm: '13px', '': '14.5px', lg: '16.5px', xl: '19px' };

function populateFontOptions() {
  const sel = $('cfg-font-family');
  sel.innerHTML = '';
  for (const f of FONT_FAMILY_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = f.value;
    opt.textContent = f.label;
    opt.style.fontFamily = f.stack;
    sel.appendChild(opt);
  }
}
populateFontOptions();
const settings = { ...DEFAULT_SETTINGS, ...loadSettings() };

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
  catch { return {}; }
}
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
function contrastTextColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#111b21' : '#e9edef';
}

function applySettings() {
  document.body.classList.toggle('hide-tools', !settings.showTools);
  const root = document.documentElement;
  const vars = { '--accent': settings.colorAccent, '--bubble-me': settings.colorMe, '--bubble-ai': settings.colorAi };
  for (const [k, v] of Object.entries(vars)) {
    if (v) root.style.setProperty(k, v);
    else root.style.removeProperty(k);
  }
  const textVars = { '--bubble-me-text': settings.colorMe, '--bubble-ai-text': settings.colorAi };
  for (const [k, v] of Object.entries(textVars)) {
    const textColor = contrastTextColor(v);
    if (textColor) root.style.setProperty(k, textColor);
    else root.style.removeProperty(k);
  }
  root.style.setProperty('--chat-font', FONT_FAMILY_MAP[settings.fontFamily] || FONT_FAMILY_MAP['']);
  const baseSize = parseFloat(FONT_SIZE_MAP[settings.fontSize] || FONT_SIZE_MAP['']);
  const zoom = +settings.chatZoom || 1;
  root.style.setProperty('--chat-size', (baseSize * zoom) + 'px');
  root.style.setProperty('--chat-zoom', zoom);
  if (settings.sidebarWidth) root.style.setProperty('--sidebar-width', settings.sidebarWidth);
  document.body.classList.toggle('sidebar-hidden', !!settings.sidebarHidden);
}
applySettings();

// ── Zoom del chat con Ctrl/Cmd + scroll (solo el contenido, no el sidebar) ──
$('panel-chat').addEventListener('wheel', e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  const cur = +settings.chatZoom || 1;
  const next = Math.min(1.8, Math.max(0.7, +(cur + (e.deltaY > 0 ? -0.05 : 0.05)).toFixed(2)));
  if (next === cur) return;
  settings.chatZoom = next;
  applySettings(); saveSettings();
}, { passive: false });

// ── Sidebar: ancho arrastrable + ocultar/mostrar (solo desktop) ──
$('sidebar-toggle-btn').onclick = () => {
  settings.sidebarHidden = !settings.sidebarHidden;
  applySettings(); saveSettings();
};

(() => {
  const resizer = $('panel-resizer');
  let dragging = false;
  resizer.addEventListener('mousedown', e => {
    dragging = true;
    resizer.classList.add('dragging');
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const w = Math.min(640, Math.max(220, e.clientX));
    document.documentElement.style.setProperty('--sidebar-width', w + 'px');
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.style.userSelect = '';
    settings.sidebarWidth = getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width').trim();
    saveSettings();
  });
})();

function populateVoices() {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return;
  const sorted = [...voices].sort((a, b) => {
    const aEs = a.lang.startsWith('es') ? 0 : 1;
    const bEs = b.lang.startsWith('es') ? 0 : 1;
    return aEs - bEs || a.name.localeCompare(b.name);
  });
  for (const selId of ['cfg-voice-assistant', 'cfg-voice-user']) {
    const sel = $(selId);
    const current = sel.value;
    sel.innerHTML = '<option value="">Default del sistema</option>';
    for (const v of sorted) {
      const opt = document.createElement('option');
      opt.value = v.name;
      opt.textContent = `${v.name} (${v.lang})`;
      sel.appendChild(opt);
    }
    sel.value = current;
  }
}
if ('speechSynthesis' in window) {
  populateVoices();
  speechSynthesis.onvoiceschanged = populateVoices;
}

function readComputedColor(varName) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  // <input type="color"> exige formato #rrggbb
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  if (/^#[0-9a-f]{3}$/i.test(v)) return '#' + v.slice(1).split('').map(c => c + c).join('');
  return '#000000';
}

function openSettings() {
  $('cfg-show-tools').checked = settings.showTools;
  $('cfg-voice-assistant').value = settings.voiceAssistant;
  $('cfg-voice-user').value = settings.voiceUser;
  $('cfg-color-accent').value = settings.colorAccent || readComputedColor('--accent');
  $('cfg-color-me').value = settings.colorMe || readComputedColor('--bubble-me');
  $('cfg-color-ai').value = settings.colorAi || readComputedColor('--bubble-ai');
  $('cfg-font-family').value = settings.fontFamily;
  $('cfg-font-size').value = settings.fontSize;
  $('settings-dialog').showModal();
}

$('settings-btn').onclick = openSettings;

$('cfg-show-tools').onchange = e => {
  settings.showTools = e.target.checked;
  applySettings(); saveSettings();
};
$('cfg-voice-assistant').onchange = e => { settings.voiceAssistant = e.target.value; saveSettings(); };
$('cfg-voice-user').onchange = e => { settings.voiceUser = e.target.value; saveSettings(); };
$('cfg-color-accent').oninput = e => { settings.colorAccent = e.target.value; applySettings(); saveSettings(); };
$('cfg-color-me').oninput = e => { settings.colorMe = e.target.value; applySettings(); saveSettings(); };
$('cfg-color-ai').oninput = e => { settings.colorAi = e.target.value; applySettings(); saveSettings(); };
$('cfg-font-family').onchange = e => { settings.fontFamily = e.target.value; applySettings(); saveSettings(); };
$('cfg-font-size').onchange = e => { settings.fontSize = e.target.value; applySettings(); saveSettings(); };

$('cfg-reset').onclick = () => {
  Object.assign(settings, DEFAULT_SETTINGS);
  applySettings(); saveSettings();
  openSettings();
  toast('Configuración restaurada', 'info', 2000);
};
