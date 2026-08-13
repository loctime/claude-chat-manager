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
let activePane = 0; // 0=chats 1=archived 2=notas
let notebookListLoaded = false;
let notebooks = [];
let currentNotebook = null; // {id, name} de la libreta abierta, o null si estamos en la lista
let notesData = [];

function noteTimeLabel(ts) {
  return new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}

function renderNoteBubble(entry) {
  const div = document.createElement('div');
  div.className = 'note-bubble';

  if (entry.type === 'file') {
    div.classList.add('note-bubble-file');
    const ext = (entry.fileName.split('.').pop() || '').toLowerCase();
    if (IMAGE_EXTS.has(ext)) {
      const img = document.createElement('img');
      img.className = 'note-file-thumb';
      img.alt = entry.fileName;
      img.src = '/api/thumbnail?path=' + encodeURIComponent(entry.filePath);
      div.appendChild(img);
    }
    const name = document.createElement('div');
    name.className = 'note-file-name';
    name.textContent = entry.fileName;
    div.appendChild(name);
    const meta = document.createElement('div');
    meta.className = 'note-file-meta';
    meta.textContent = (entry.size ? (entry.size / 1024).toFixed(0) + ' KB · ' : '') + entry.filePath;
    div.appendChild(meta);
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'note-copy-btn';
    copyBtn.textContent = 'Copiar ruta';
    copyBtn.onclick = () => copyToClipboard(entry.filePath);
    div.appendChild(copyBtn);
  } else {
    div.classList.add('note-bubble-text');
    const text = document.createElement('div');
    text.className = 'note-text';
    text.textContent = entry.text;
    div.appendChild(text);
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'note-copy-btn';
    copyBtn.textContent = 'Copiar';
    copyBtn.onclick = () => copyToClipboard(entry.text);
    div.appendChild(copyBtn);
  }

  const time = document.createElement('div');
  time.className = 'note-time';
  time.textContent = noteTimeLabel(entry.ts);
  div.appendChild(time);

  return div;
}

function renderNotes(scrollToBottom = true) {
  const wrap = $('notes-messages');
  wrap.innerHTML = '';
  if (notesData.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'notes-empty';
    empty.textContent = 'No hay notas todavía — escribí algo o adjuntá un archivo.';
    wrap.appendChild(empty);
  } else {
    for (const entry of notesData) wrap.appendChild(renderNoteBubble(entry));
  }
  if (scrollToBottom) wrap.scrollTop = wrap.scrollHeight;
}

// Combina lo que devuelve el server con lo que ya tenemos en memoria: un push
// optimista (composer de texto / upload) puede no estar todavía en la
// respuesta de un poll que salió antes de que el POST terminara. Si lo
// pisáramos sin más, la nota recién mandada desaparece hasta el próximo poll.
// Une por id (así una entrada optimista se reemplaza por la del server en
// cuanto aparece ahí, sin quedar duplicada) y ordena por ts.
function mergeNotes(incoming, current) {
  const byId = new Map(incoming.map(n => [n.id, n]));
  for (const entry of current) {
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }
  return Array.from(byId.values()).sort((a, b) => a.ts - b.ts);
}

async function loadNotes() {
  if (!currentNotebook) return;
  const notebookId = currentNotebook.id;
  const { notes } = await api(`/notebooks/${notebookId}/notes`);
  // Mientras esperábamos la respuesta el usuario puede haber abierto otra
  // libreta (o vuelto a la lista): un poll lento de la libreta anterior que
  // resuelve tarde mergearía SUS notas adentro de la que está abierta ahora,
  // y como mergeNotes conserva lo que ya había en memoria, esas notas ajenas
  // quedan pegadas hasta cerrar y reabrir. Descartar la respuesta tardía.
  if (!currentNotebook || currentNotebook.id !== notebookId) return;
  const merged = mergeNotes(notes, notesData);

  // Nada cambió (mismo largo y mismo último id): no tocar el DOM ni el
  // scroll. Evita que el poll de 5s le arruine al usuario una selección de
  // texto o lo empuje al final si estaba leyendo notas viejas más arriba.
  const prevLast = notesData[notesData.length - 1];
  const mergedLast = merged[merged.length - 1];
  const unchanged = merged.length === notesData.length &&
    (!mergedLast || (prevLast && mergedLast.id === prevLast.id));
  if (unchanged) return;

  const wrap = $('notes-messages');
  const wasNearBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80;

  notesData = merged;
  renderNotes(wasNearBottom);
}

let notesPolling = false;
async function safeLoadNotes() {
  if (notesPolling) return; // ya hay un poll en vuelo, no pisarlo con otro
  notesPolling = true;
  try { await loadNotes(); }
  // Falla silenciosa: es polling de fondo, el próximo tick a los 5s se
  // autocura. El error SÍ se muestra en la carga inicial (openNotebook, con
  // su propio try/catch).
  catch { /* noop */ }
  finally { notesPolling = false; }
}

// ── Notas: lista de libretas ──
function notebookElement(nb) {
  const div = document.createElement('div');
  // .notebook-row (además de .conv, para heredar el estilo visual de fila):
  // esta fila nunca llama a attachRowGestures() como sí hacen las de chat
  // (no tiene swipe-to-archive ni long-press), así que el guard de
  // initPaneSwipe() la deja pasar explícitamente para que el swipe de
  // pantalla (Chats/Libretas/Archivado) siga funcionando arrancando sobre
  // ella — si no, con la lista llena de libretas no queda fondo tocable
  // para ese gesto. Ver Finding 2 del review final.
  div.className = 'conv notebook-row';
  div.innerHTML = `
    <div class="conv-avatar">${avatarChar(nb.name)}</div>
    <div class="conv-body">
      <div class="name"><span class="conv-name-text"></span></div>
      <div class="sub"><span class="conv-date"></span></div>
    </div>
  `;
  div.querySelector('.conv-name-text').textContent = nb.name;
  div.querySelector('.conv-date').textContent = nb.lastActivity
    ? new Date(nb.lastActivity).toLocaleString('es', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : 'Sin notas todavía';
  div.onclick = () => openNotebook(nb.id, nb.name);
  return div;
}

function renderNotebookList() {
  const nav = $('notebook-list');
  nav.innerHTML = '';
  // Sin libretas la lista quedaría como un panel completamente en blanco, sin
  // ninguna pista de qué pasó ni de cómo seguir — y ese es justo el estado de
  // una instalación nueva (arranca sin ninguna libreta) o el de alguien que
  // borró notebooks.json a mano. Mismo tratamiento que renderNotes().
  if (notebooks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'notes-empty';
    empty.textContent = 'No hay libretas todavía — creá una con el botón + de arriba.';
    nav.appendChild(empty);
    return;
  }
  for (const nb of notebooks) nav.appendChild(notebookElement(nb));
}

async function loadNotebookList() {
  const { notebooks: list } = await api('/notebooks');
  notebooks = list;
  renderNotebookList();
}

async function safeLoadNotebookList() {
  try { await loadNotebookList(); }
  catch { /* noop: polling de fondo, se autocura en el próximo tick */ }
}

// ── Notas: abrir/cerrar una libreta reusando el panel/overlay del chat ──
// Mismo mecanismo que ya usan los chats (#panel-chat, clase .open,
// history.pushState para el botón atrás de Android) — ver el diseño en
// docs/superpowers/specs/2026-08-13-notas-libretas-design.md. show=true
// oculta la vista de chat y muestra la de libreta; show=false es lo inverso
// (lo usa selectConv al abrir un chat real, por si había una libreta abierta).
function showNotebookView(show) {
  $('chat-header').hidden = show;
  $('messages-wrap').hidden = show;
  $('composer-attachments').hidden = show;
  $('composer').hidden = show;
  $('notebook-view').hidden = !show;
}

async function openNotebook(id, name) {
  currentNotebook = { id, name };
  $('notebook-title').textContent = name;
  notesData = [];
  renderNotes();
  showNotebookView(true);
  openChat();
  try { await loadNotes(); }
  catch (err) { toast('No se pudieron cargar las notas: ' + err.message); }
}

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
// ttl = 0 → toast persistente, no se autodescarta (usalo para operaciones
// largas como compactar: mostrás "en curso…" y vos mismo lo cerrás cuando
// llega el resultado). Devuelve { remove } para eso.
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
  if (ttl > 0) setTimeout(remove, ttl);
  return { remove };
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
// ── Red ──
// En el celu la PWA se suspende cada vez que salís de la app — y salís siempre
// que adjuntás una foto, porque se abre la galería/cámara. Al volver, la
// conexión TLS/HTTP2 con el túnel de Cloudflare puede estar muerta: el primer
// fetch revienta con TypeError "Failed to fetch" sin que la request llegue
// nunca al server (por eso no aparece en ningún log). Reintentar una vez fuerza
// una conexión nueva y pasa.
function isNetworkError(err) {
  return err instanceof TypeError;
}

// Traduce el TypeError críptico del browser a algo que se entienda.
function netError(err) {
  if (!isNetworkError(err)) return err;
  const e = new Error(navigator.onLine === false
    ? 'Sin conexión — no salió'
    : 'No se pudo contactar a Jarvis (conexión caída o server sin responder)');
  e.isNetwork = true;
  return e;
}

// fetch con un reintento ante fallo de red. Solo para requests seguras de
// repetir (GET o subidas, que a lo sumo dejan un archivo huérfano).
async function netFetch(url, opts) {
  try {
    return await fetch(url, opts);
  } catch (err) {
    if (!isNetworkError(err)) throw err;
    await new Promise(r => setTimeout(r, 600));
    try {
      return await fetch(url, opts);
    } catch (err2) {
      throw netError(err2);
    }
  }
}

async function api(path, opts) {
  const method = (opts && opts.method) || 'GET';
  // Los POST/PATCH que mutan no se reintentan solos acá: no sabemos si el
  // primer intento llegó. El envío de mensaje lo maneja aparte sendMessage().
  const res = method === 'GET'
    ? await netFetch('/api' + path, opts)
    : await fetch('/api' + path, opts).catch(err => { throw netError(err); });
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
  let plain = text;
  // Pasar por el mismo parser Markdown que usa el render visual y quedarnos
  // solo con el texto: así el TTS nunca ve *, `, #, [](), etc. y no los lee
  // como si fueran palabras ("asterisco", "numeral", "comillas").
  if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
    const html = DOMPurify.sanitize(marked.parse(text, { breaks: true, gfm: true }));
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    plain = tpl.content.textContent || '';
  }
  return plain
    .replace(/\[Archivo adjunto:[^\]]+\]/g, '')
    .replace(/`?\/(?:home|tmp|root|var|opt|usr)[^\s`'"]+`?/g, '')
    .replace(/["""«»'']/g, '')
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

  const archTab = document.querySelector('.pane-tab[data-pane="1"]');
  if (archTab) archTab.textContent = archivedTotal > 0 ? `Archivado (${archivedTotal})` : 'Archivado';

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
  back.onclick = () => { goToPane(0); };
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

let paneNavGeneration = 0;
let paneNavTarget = 0; // pane que debe quedar activo una vez termine la navegación en curso

async function goToPane(index) {
  if (index === paneNavTarget) return;
  // paneNavTarget (no activePane) es lo que compara el guard de arriba: activePane
  // recién se actualiza al final, así que si hay una navegación en vuelo (p.ej.
  // click rápido Archivado→Notas→Chats) activePane todavía dice "0" aunque ya
  // vamos camino a otro pane. paneNavGeneration hace que solo la llamada más
  // nueva pueda escribir el estado final tras su await; las anteriores se abortan.
  paneNavTarget = index;
  const myGeneration = ++paneNavGeneration;
  if (index === 1 && !archivedPaneLoaded) {
    try {
      await loadArchivedTree();
      archivedPaneLoaded = true;
    } catch (err) {
      toast('No se pudo cargar archivadas: ' + err.message);
      // Solo limpiar paneNavTarget si nadie navegó de nuevo mientras esperábamos;
      // si no, dejarlo como está para no pisar el target de esa llamada más nueva.
      if (myGeneration === paneNavGeneration) paneNavTarget = activePane;
      return;
    }
  }
  if (index === 2 && !notebookListLoaded) {
    try {
      await loadNotebookList();
      notebookListLoaded = true;
    } catch (err) {
      toast('No se pudieron cargar las libretas: ' + err.message);
      if (myGeneration === paneNavGeneration) paneNavTarget = activePane;
      return;
    }
  }
  if (myGeneration !== paneNavGeneration) return; // otra navegación más nueva ya tomó el control
  activePane = index;
  $('tree-viewport-inner').dataset.pane = String(index);
  document.querySelectorAll('.pane-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.pane === String(index));
  });
}

function resetArchivedPane() {
  archivedPaneLoaded = false;
  archivedTreeLimit = 100;
  $('tree-archived').innerHTML = '';
  if (activePane === 1) goToPane(0);
}

document.querySelectorAll('.pane-tab').forEach(btn => {
  btn.onclick = () => goToPane(Number(btn.dataset.pane));
});
$('notes-back').onclick = () => goToPane(0);

$('notebook-back-btn').onclick = closeChat;

$('notebook-new-btn').onclick = async () => {
  try {
    const nb = await api('/notebooks', { method: 'POST' });
    notebooks.push(nb);
    renderNotebookList();
    openNotebook(nb.id, nb.name);
  } catch (err) { toast('No se pudo crear la libreta: ' + err.message); }
};

// ── Renombrar libreta (doble click en el título, mismo patrón que #conv-title) ──
$('notebook-title').ondblclick = () => {
  if (!currentNotebook) return;
  const el = $('notebook-title');
  el.contentEditable = 'true';
  el.focus();
  el.onblur = async () => {
    el.contentEditable = 'false';
    const name = el.textContent.trim();
    if (!name || name === currentNotebook.name) { el.textContent = currentNotebook.name; return; }
    const notebookId = currentNotebook.id;
    try {
      const nb = await api(`/notebooks/${notebookId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      // Mismo guard que loadNotes()/el submit de notas: si mientras esperábamos
      // se cambió o cerró la libreta, no pisar el título ni currentNotebook
      // con la respuesta tardía de esta.
      if (!currentNotebook || currentNotebook.id !== notebookId) return;
      currentNotebook.name = nb.name;
      el.textContent = nb.name;
      const idx = notebooks.findIndex(n => n.id === nb.id);
      if (idx !== -1) notebooks[idx] = { ...notebooks[idx], ...nb };
      renderNotebookList();
    } catch (err) {
      if (currentNotebook && currentNotebook.id === notebookId) el.textContent = currentNotebook.name;
      toast('No se pudo renombrar: ' + err.message);
    }
  };
  el.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); el.blur(); } };
};

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
      if (!confirm('Compactar la conversación?\n\nEjecuta el /compact nativo de Claude Code sobre la sesión actual — reduce el contexto sin perder la sesión. Puede tardar bastante en charlas largas.')) return;
      try {
        await api(`/conversations/${conv.convId}/compact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(withAccountBody({})),
        });
        // El resultado real llega por SSE (kind:'compacted') si esta conversación
        // está abierta ahí mismo. Si no, el ping-dot del árbol (poblado por
        // refreshVisibleTrees) es el único indicador hasta que la abras.
        toast('Compactando… puede tardar, corre en background', 'info', 4000);
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

// ── Menú contextual de mensajes (click derecho / long-press en burbujas) ──

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback para contextos sin Clipboard API (http plano, browsers viejos)
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } finally { ta.remove(); }
  }
  toast('Copiado', 'info', 1500);
}

// Cita el texto en el composer estilo chat: "> línea" por línea, tope de 500
// caracteres para no inundar el input con una respuesta larga de Claude.
function quoteIntoComposer(text) {
  const input = $('input');
  let t = text.trim();
  if (t.length > 500) t = t.slice(0, 500) + '…';
  const quoted = t.split('\n').map(l => '> ' + l).join('\n') + '\n\n';
  input.value = quoted + input.value;
  autoResize(input);
  if (currentConv) drafts.set(currentConv, input.value);
  input.focus();
  input.selectionStart = input.selectionEnd = input.value.length;
}

async function doRewind(ctx) {
  const ok = confirm('Rebobinar hasta acá?\n\nElimina esta pregunta y TODO lo que vino después — Claude lo olvida de verdad, como si nunca hubiera pasado. La conversación sigue desde la respuesta anterior.\n\n(Queda un backup del archivo de sesión por las dudas.)');
  if (!ok) return;
  try {
    const r = await api(`/conversations/${currentConv}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(withAccountBody({ uuid: ctx.uuid })),
    });
    toast(`Rebobinado (${r.removed} entradas eliminadas)`, 'info', 3000);
    await loadMessages(currentConv);
    refreshCostBadge(currentConv);
    refreshVisibleTrees();
  } catch (err) {
    toast('No se pudo rebobinar: ' + err.message);
  }
}

// Mobile tiene user-select:none en las burbujas (si no, el long-press pelea
// entre nuestro menú y la selección nativa — ver CSS). Esta función habilita
// la selección puntualmente en UNA burbuja y arranca con todo el texto ya
// seleccionado, para que el usuario solo tenga que arrastrar los handles
// nativos hasta la parte que quiere y copiar con el menú del sistema.
let _endSelectionMode = null;
function enterSelectionMode(el) {
  if (_endSelectionMode) _endSelectionMode();
  const textEl = el.querySelector('.msg-text');
  if (!textEl) return;
  el.classList.add('selecting');
  try {
    const range = document.createRange();
    range.selectNodeContents(textEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } catch { /* Selection API no disponible: igual queda seleccionable a mano */ }

  const exit = () => {
    el.classList.remove('selecting');
    document.removeEventListener('pointerdown', onOutside, true);
    if (_endSelectionMode === exit) _endSelectionMode = null;
  };
  // Tocar fuera de la burbuja sale del modo selección. Adentro no: así se
  // puede arrastrar los handles nativos sin que se cierre solo.
  const onOutside = e => { if (!el.contains(e.target)) exit(); };
  // Delay para no comerse el mismo tap que abrió el menú y disparó esto.
  setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 300);
  _endSelectionMode = exit;
}

function showMsgMenu(x, y, ctx) {
  document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  const canRewind = ctx.role === 'user' && ctx.uuid && !ctx.compacted;
  menu.innerHTML = `
    <button data-action="copy">📋 Copiar</button>
    <button data-action="select">🔤 Seleccionar texto</button>
    <button data-action="quote">↩️ Citar</button>
    ${canRewind ? '<button data-action="rewind" class="ctx-danger">⏪ Rebobinar hasta acá</button>' : ''}
  `;
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';

  const doAction = (action) => {
    menu.remove();
    document.removeEventListener('click', dismiss, true);
    document.removeEventListener('touchstart', dismiss, true);
    if (action === 'copy') copyToClipboard(ctx.text);
    else if (action === 'select') enterSelectionMode(ctx.el);
    else if (action === 'quote') quoteIntoComposer(ctx.text);
    else if (action === 'rewind') doRewind(ctx);
  };

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
  // Mismo delay que showConvMenu: saltear el click sintético del long-press
  setTimeout(() => {
    document.addEventListener('click', dismiss, true);
    document.addEventListener('touchstart', dismiss, true);
  }, 350);
}

function attachMsgGestures(el, ctx) {
  ctx.el = el; // referencia para poder habilitar la selección de texto desde el menú
  let touchTimer = null;
  let longPressed = false;
  let startX = 0, startY = 0;

  el.addEventListener('contextmenu', e => {
    if (el.classList.contains('selecting')) return; // dejamos el nativo (copiar/etc) mandar
    e.preventDefault();
    showMsgMenu(e.clientX, e.clientY, ctx);
  });

  el.addEventListener('touchstart', e => {
    // En modo selección no reabrimos el menú: dejamos que el usuario arrastre
    // los handles nativos tranquilo (ver enterSelectionMode).
    if (el.classList.contains('selecting')) return;
    longPressed = false;
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
    touchTimer = setTimeout(() => {
      longPressed = true;
      touchTimer = null;
      showMsgMenu(startX, startY, ctx);
      if (navigator.vibrate) { try { navigator.vibrate(30); } catch {} }
    }, 500);
  }, { passive: true });

  el.addEventListener('touchmove', e => {
    if (!touchTimer) return;
    const t = e.touches[0];
    // Se movió: es scroll, no long-press
    if (Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) {
      clearTimeout(touchTimer); touchTimer = null;
    }
  }, { passive: true });

  el.addEventListener('touchend', () => {
    if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
  });
  el.addEventListener('touchcancel', () => {
    if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
  });

  // Bloquear el click sintético post-long-press (mismo truco que las filas)
  el.addEventListener('click', e => {
    if (longPressed) {
      longPressed = false;
      e.stopPropagation();
      e.preventDefault();
    }
  }, { capture: true });
}

// Chip "copiar" flotante sobre un bloque de código del markdown. El pre es su
// propio scroll container horizontal, así que un absolute adentro se iría con
// el scroll — se envuelve en un wrapper relative y el chip cuelga del wrapper.
function addCodeCopyChip(pre) {
  const wrap = document.createElement('div');
  wrap.className = 'code-wrap';
  pre.parentNode.insertBefore(wrap, pre);
  wrap.appendChild(pre);
  const btn = document.createElement('button');
  btn.className = 'code-copy';
  btn.title = 'Copiar código';
  btn.textContent = '⧉';
  btn.onclick = e => {
    e.stopPropagation();
    const code = pre.querySelector('code');
    copyToClipboard((code || pre).innerText.replace(/\n$/, ''));
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = '⧉'; }, 1200);
  };
  wrap.appendChild(btn);
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
    if (role === 'assistant') {
      renderAssistantText(span, text);
      span.querySelectorAll('pre').forEach(addCodeCopyChip);
    } else {
      renderTextWithPaths(span, text);
    }
    const ttsBtn = makeTtsBtn(text, role === 'user' ? 'user' : 'assistant');
    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = now();
    div.appendChild(span);
    div.appendChild(ttsBtn);
    div.appendChild(time);
    attachMsgGestures(div, { role, text, uuid: opts.uuid, compacted: !!opts.compacted });
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

  // Copiar el comando entero (los summaries se truncan a 120 chars): botón en
  // el summary que no togglea el details.
  if (typeof input === 'object' && input && typeof input.command === 'string' && input.command.trim()) {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'tool-copy';
    copyBtn.title = 'Copiar comando entero';
    copyBtn.textContent = '⧉';
    copyBtn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      copyToClipboard(input.command);
    });
    det.querySelector('summary').appendChild(copyBtn);
  }

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

// Marcador inline para un boundary de /compact real (mismo session_id antes y
// después — a diferencia de addCompactDivider(), que es el remanente del
// sistema viejo por resumen-y-sesión-nueva). Se muestra tanto si lo disparó el
// botón "Compactar" (trigger:'manual') como si el CLI lo hizo solo por límite
// de contexto (trigger:'auto') — antes esto último era invisible en Jarvis.
function addCompactBoundary(m) {
  const div = document.createElement('div');
  div.className = 'compact-divider';
  const label = m.trigger === 'auto' ? 'Contexto compactado automáticamente' : 'Contexto compactado';
  div.innerHTML = `<span>🗜️ ${label} — ${fmtTokens(m.preTokens)} → ${fmtTokens(m.postTokens)} tokens</span>`;
  messagesEl.appendChild(div);
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
      if (m.role === 'system-compact') { addCompactBoundary(m); continue; }
      const opts = { compacted: !!m.compacted, uuid: m.uuid };
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
    } else if (payload.kind === 'compacted') {
      // El 'status':'idle' que sigue a esto ya dispara loadMessages/refreshCostBadge
      // (así aparece el divider de /compact en el historial) — acá solo avisamos
      // el resultado numérico, que no viaja en el evento de status.
      const pre = fmtTokens(payload.preTokens || 0);
      const post = fmtTokens(payload.postTokens || 0);
      toast(`Compactado: ${pre} → ${post} tokens`, 'info', 4000);
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

// Volver del background (en el celu pasa cada vez que abrís la galería para
// adjuntar una foto) deja el stream SSE muerto y la conexión con el túnel
// posiblemente también. Reabrirlo apenas volvés reestablece la conexión antes
// de que toques enviar, y de paso recupera lo que Claude haya respondido
// mientras no mirabas. Solo si estuvo oculta un rato, para no recargar el
// historial cada vez que cambiás de ventana en la compu.
let hiddenSince = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { hiddenSince = Date.now(); return; }
  const wasHiddenFor = hiddenSince ? Date.now() - hiddenSince : 0;
  hiddenSince = 0;
  if (wasHiddenFor < 3000 || !currentConv) return;
  openStream(currentConv);
  loadMessages(currentConv);
  refreshVisibleTrees();
});

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
  showNotebookView(false);
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

// Un File que sale del selector de fotos del celu no es un archivo en memoria:
// es un handle a algo del sistema (content:// en Android, la fototeca en iOS).
// Si subís los 6MB crudos, el handle tiene que seguir vivo el minuto largo que
// tarda el uplink móvil — y si el sistema lo invalida antes (la app pasó a
// background, presión de memoria, permiso temporal del picker vencido), el
// stream se corta y fetch tira TypeError. El reintento falla igual, porque el
// File ya está muerto.
//
// Solución: materializar el archivo en memoria antes de subirlo, y si es una
// foto grande, reducirla acá mismo. El server la iba a comprimir a 2048px/q82
// igual, así que no perdemos calidad final y la subida pasa de ~60s a ~3s.
const MAX_UPLOAD_DIM = 2048;
const CLIENT_COMPRESS_BYTES = 1.5 * 1024 * 1024; // mismo umbral que el server
const CLIENT_COMPRESS_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;      // límite de multer en el server
const MATERIALIZE_MAX_BYTES = 25 * 1024 * 1024; // arriba de esto no copiamos a RAM

async function prepareForUpload(file, displayName) {
  // El server rechaza arriba de 50MB: mejor avisar acá que subir varios minutos
  // por el uplink del celu para terminar en un error.
  if (file.size > MAX_UPLOAD_BYTES) {
    const e = new Error(`pesa ${(file.size / 1048576).toFixed(0)}MB y el máximo es 50MB`);
    e.isTooBig = true;
    throw e;
  }

  const materialize = async () => {
    // Falla acá = el archivo ya no se puede leer, y eso no lo arregla ningún
    // reintento: hay que volver a elegir la foto.
    try {
      return new Blob([await file.arrayBuffer()], { type: file.type || 'application/octet-stream' });
    } catch {
      const e = new Error('no se pudo leer el archivo desde el celu — volvé a elegirlo');
      e.isUnreadable = true;
      throw e;
    }
  };

  // Un video de decenas de MB copiado a memoria puede tumbar la pestaña en el
  // celu. Esos van derecho desde el archivo, asumiendo el riesgo del handle.
  if (file.size > MATERIALIZE_MAX_BYTES) return { blob: file, name: displayName };

  if (!CLIENT_COMPRESS_TYPES.has(file.type) || file.size <= CLIENT_COMPRESS_BYTES) {
    return { blob: await materialize(), name: displayName };
  }

  try {
    // imageOrientation respeta el EXIF: sin esto las fotos verticales del celu
    // se suben rotadas.
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX_UPLOAD_DIM / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
    if (!blob) throw new Error('toBlob vacío');
    const name = displayName.replace(/\.[^.]+$/, '') + '.jpg';
    return { blob, name };
  } catch {
    // Cualquier problema del canvas: seguimos con el archivo tal cual.
    return { blob: await materialize(), name: displayName };
  }
}

async function uploadAttachment(file) {
  if (!currentConv) { addMsg('error', 'Elegí una conversación antes de adjuntar'); return; }
  const displayName = file.name || `pegado-${Date.now()}.${(file.type.split('/')[1] || 'bin')}`;
  const loadingChip = document.createElement('div');
  loadingChip.className = 'attach-chip attach-chip-loading';
  loadingChip.innerHTML = `<span class="attach-spinner"></span><span class="attach-chip-name"></span>`;
  loadingChip.querySelector('.attach-chip-name').textContent = displayName;
  $('composer-attachments').appendChild(loadingChip);

  const t0 = Date.now();
  let sentBytes = 0;
  try {
    const { blob, name: uploadName } = await prepareForUpload(file, displayName);
    file = blob; // a partir de acá el preview también usa la copia en memoria
    sentBytes = blob.size;
    const fd = new FormData();
    fd.append('file', blob, uploadName);
    const res = await netFetch('/api/upload', { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const { path: filePath, name } = await res.json();
    loadingChip.remove();
    pendingAttachments.push({ path: filePath, name, file });
    addAttachmentChip(name, filePath, file);
  } catch (err) {
    loadingChip.remove();
    // Dejamos rastro de tamaño y duración: si falla al instante es el archivo o
    // la conexión; si falla tras decenas de segundos, se cortó a mitad de la
    // subida. Sin esto el error no dice nada y volvemos a quedar adivinando.
    const detalle = sentBytes
      ? ` [${(sentBytes / 1024 / 1024).toFixed(1)}MB, ${((Date.now() - t0) / 1000).toFixed(1)}s]`
      : ` [falló al preparar, ${((Date.now() - t0) / 1000).toFixed(1)}s]`;
    addMsg('error', 'No se pudo subir: ' + err.message + detalle);
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

  // #panel-chat aloja tanto el chat como la libreta abierta de Notas, así que
  // un archivo soltado acá puede ser para cualquiera de los dos. Sin
  // distinguirlos, con una libreta abierta el archivo se adjuntaba igual al
  // composer del chat — que en ese momento está hidden —, o sea que
  // desaparecía sin dejar rastro visible.
  const notebookOpen = () => !$('notebook-view').hidden;
  const canDrop = () => (notebookOpen() ? !!currentNotebook : !!currentConv);
  const acceptDrop = (files) => {
    if (notebookOpen()) return (async () => { for (const f of files) await uploadNoteFile(f); })();
    return uploadFiles(files);
  };

  // Los eventos "dragenter"/"dragleave" se disparan por cada hijo que atraviesa el cursor,
  // por eso contamos profundidad en vez de togglear crudo.
  zone.addEventListener('dragenter', (e) => {
    if (!canDrop() || !e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    depth++;
    show();
  });
  zone.addEventListener('dragover', (e) => {
    if (!canDrop() || !e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  zone.addEventListener('dragleave', (e) => {
    if (depth === 0) return;
    depth--;
    if (depth === 0) hide();
  });
  zone.addEventListener('drop', (e) => {
    if (!canDrop()) return;
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (files.length === 0) return;
    e.preventDefault();
    hide();
    acceptDrop(files);
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
  // Burbuja optimista: todavía no tiene uuid en el jsonl (aparece recién al
  // recargar en el idle), así que el menú ofrece copiar/citar pero no rebobinar.
  if (text) attachMsgGestures(div, { role: 'user', text, uuid: null, compacted: false });

  messagesEl.appendChild(div);
  // Mensaje propio: siempre bajamos y volvemos a "pegarnos" al fondo.
  stickToBottom = true;
  syncJumpBtn();
  scrollToBottom();
  return div;
}

// ── Send ──
// Un fallo de red acá significa "no hubo respuesta", no "no llegó": la request
// pudo haber entrado igual. Por eso el reintento mira el 409 — si el server
// dice que la conversación ya está procesando, es que el primer intento sí
// llegó y Claude ya está trabajando, así que lo damos por enviado.
async function sendMessage(convId, text) {
  const url = `/api/conversations/${convId}/message`;
  const opts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withAccountBody({ text })),
  };
  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    if (!isNetworkError(err)) throw err;
    await new Promise(r => setTimeout(r, 600));
    try {
      res = await fetch(url, opts);
    } catch (err2) {
      throw netError(err2);
    }
    if (res.status === 409) return; // el primer intento entró
  }
  if (!res.ok && res.status !== 202) throw new Error((await res.json()).error || res.statusText);
}

// Devuelve texto y adjuntos al composer para poder reintentar sin volver a
// elegir las fotos (lo más molesto de que falle el envío desde el celu).
function restoreComposer(text, attachments) {
  const input = $('input');
  if (text) {
    input.value = input.value ? text + '\n' + input.value : text;
    autoResize(input);
    if (currentConv) drafts.set(currentConv, input.value);
  }
  for (const a of attachments) {
    if (pendingAttachments.some(p => p.path === a.path)) continue;
    pendingAttachments.push(a);
    addAttachmentChip(a.name, a.path, a.file);
  }
}

$('composer').onsubmit = async e => {
  e.preventDefault();
  const rawText = $('input').value.trim();
  if ((!rawText && pendingAttachments.length === 0) || !currentConv) return;

  const attachments = [...pendingAttachments];
  let text = rawText;
  if (attachments.length > 0) {
    const paths = attachments.map(a => `[Archivo adjunto: ${a.path}]`).join('\n');
    text = paths + (rawText ? '\n\n' + rawText : '');
  }

  // Mostrar mensaje con previews de archivos adjuntos
  const bubble = addUserMsgWithFiles(rawText, attachments);
  $('input').value = '';
  autoResize($('input'));
  drafts.delete(currentConv);
  clearAttachments();
  setBusy(true);
  try {
    await sendMessage(currentConv, text);
  } catch (err) {
    setBusy(false);
    if (err.isNetwork) {
      // No se envió: sacamos la burbuja optimista y devolvemos todo al composer.
      if (bubble) bubble.remove();
      restoreComposer(rawText, attachments);
      addMsg('error', err.message + ' — tocá enviar de nuevo');
    } else {
      addMsg('error', err.message);
    }
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

const PANE_COUNT = 3;

function paneSwipeMove(clientX, clientY) {
  if (!paneDragging) return false;
  const dx = clientX - paneStartX;
  const dy = clientY - paneStartY;
  if (paneAxisLocked === null) {
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return false;
    paneAxisLocked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
  }
  if (paneAxisLocked !== 'x') return false;
  const base = -activePane * paneViewportWidth();
  const min = -(PANE_COUNT - 1) * paneViewportWidth();
  paneCurrentTranslate = Math.min(0, Math.max(min, base + dx));
  $('tree-viewport-inner').style.transform = `translateX(${paneCurrentTranslate}px)`;
  return true;
}

async function paneSwipeEnd() {
  if (!paneDragging) return;
  paneDragging = false;
  const inner = $('tree-viewport-inner');

  try {
    if (paneAxisLocked === 'x') {
      const base = -activePane * paneViewportWidth();
      const delta = paneCurrentTranslate - base;
      // Navigate first (await if async), THEN clear inline styles so CSS attribute transform can take over
      if (delta < -PANE_SWIPE_THRESHOLD && activePane < PANE_COUNT - 1) {
        paneNavigating = true;
        await goToPane(activePane + 1);
      } else if (delta > PANE_SWIPE_THRESHOLD && activePane > 0) {
        paneNavigating = true;
        await goToPane(activePane - 1);
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
    // Las filas de libreta (.notebook-row) no tienen attachRowGestures propio
    // (ver notebookElement) — se excluyen del bail-out para que el swipe de
    // pantalla siga andando sobre ellas (Finding 2 del review final).
    if (e.target.closest('.conv:not(.notebook-row)')) return; // una fila de chat maneja su propio gesto (ver attachRowGestures)
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

// ── Notas: composer de texto ──
$('notes-input').addEventListener('input', () => autoResize($('notes-input')));
$('notes-input').addEventListener('keydown', e => {
  if (isTouchDevice) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('notes-composer').requestSubmit();
  }
});

$('notes-composer').addEventListener('submit', async e => {
  e.preventDefault();
  if (!currentNotebook) return;
  const input = $('notes-input');
  const text = input.value.trim();
  if (!text) return;
  const notebookId = currentNotebook.id;
  input.value = '';
  autoResize(input);
  try {
    const { entry, notebook } = await api(`/notebooks/${notebookId}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    // La nota ya quedó guardada server-side; si mientras tanto se cambió de
    // libreta, no pintarla acá (iría en la libreta equivocada). El próximo
    // poll la muestra cuando se vuelva a abrir la suya. Mismo criterio que
    // el guard de loadNotes().
    if (!currentNotebook || currentNotebook.id !== notebookId) return;
    notesData.push(entry);
    renderNotes();
    // El objeto notebook que devuelve el server (creado/renombrado) no trae
    // lastActivity — lo seteamos acá con el ts de la nota recién posteada
    // para que la lista no quede mostrando "Sin notas todavía" o una fecha
    // vieja hasta el próximo reload.
    const idx = notebooks.findIndex(n => n.id === currentNotebook.id);
    if (idx !== -1) notebooks[idx].lastActivity = entry.ts;
    if (notebook && notebook.name !== currentNotebook.name) {
      currentNotebook.name = notebook.name;
      $('notebook-title').textContent = notebook.name;
      if (idx !== -1) notebooks[idx] = { ...notebooks[idx], ...notebook };
    }
    renderNotebookList();
  } catch (err) {
    input.value = text;
    autoResize(input);
    toast('No se pudo guardar la nota: ' + err.message);
  }
});

// ── Notas: adjuntar archivos ──
// Mismo problema ya resuelto para el composer de chat y para la v1 de Notas:
// un File que sale del picker de galería del celu es un handle a content://
// (Android) o a la fototeca (iOS), no bytes en memoria — subirlo crudo
// funciona con una foto recién sacada de la cámara pero falla con una
// elegida de la galería si el uplink tarda y el sistema invalida el handle a
// mitad de camino. prepareForUpload ya resuelve esto (materializa a Blob +
// comprime fotos grandes) — reusarlo acá en vez de mandar `file` directo.
async function uploadNoteFile(file) {
  if (!currentNotebook) return;
  const notebookId = currentNotebook.id;
  const displayName = file.name || `pegado-${Date.now()}.${(file.type.split('/')[1] || 'bin')}`;
  const loadingChip = document.createElement('div');
  loadingChip.className = 'attach-chip attach-chip-loading';
  loadingChip.innerHTML = `<span class="attach-spinner"></span><span class="attach-chip-name"></span>`;
  loadingChip.querySelector('.attach-chip-name').textContent = displayName;
  $('notes-attachments').appendChild(loadingChip);

  const t0 = Date.now();
  let sentBytes = 0;
  try {
    const { blob, name: uploadName } = await prepareForUpload(file, displayName);
    sentBytes = blob.size;
    const fd = new FormData();
    fd.append('file', blob, uploadName);
    const res = await netFetch(`/api/notebooks/${notebookId}/notes/upload`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const { entry } = await res.json();
    // Una subida puede tardar varios segundos con uplink móvil, tiempo de
    // sobra para volver e ir a otra libreta — mismo guard que loadNotes().
    if (!currentNotebook || currentNotebook.id !== notebookId) return;
    notesData.push(entry);
    renderNotes();
  } catch (err) {
    const detalle = sentBytes
      ? ` [${(sentBytes / 1024 / 1024).toFixed(1)}MB, ${((Date.now() - t0) / 1000).toFixed(1)}s]`
      : ` [falló al preparar, ${((Date.now() - t0) / 1000).toFixed(1)}s]`;
    toast('No se pudo subir el archivo: ' + err.message + detalle);
  } finally {
    loadingChip.remove();
  }
}

$('notes-attach-btn').onclick = () => { $('notes-file-input').click(); };
$('notes-file-input').onchange = async () => {
  const files = Array.from($('notes-file-input').files);
  $('notes-file-input').value = '';
  for (const f of files) await uploadNoteFile(f);
};

// ── Notas: sincronización entre dispositivos por polling ──
// 5s (no los 15s del árbol de chats) porque un uso central es "mandar un
// archivo del celu y pasar a la PC a buscarlo enseguida". Sin SSE nuevo: ver
// razones documentadas en la spec (mismo problema de conexiones idle que ya
// se resolvió a los ponchazos para /stream).
//
// notebookIsVisible() distingue si lo que se está mirando ahora mismo es la
// libreta abierta o la lista: en mobile #notebook-view solo cuenta si el
// overlay #panel-chat está .open (si no, aunque currentNotebook siga seteado
// de la última libreta vista, lo que hay en pantalla es la lista); en
// desktop el panel de detalle no es un overlay — su visibilidad depende
// solo de qué contenido tiene cargado ahora.
function notebookIsVisible() {
  if (isMobile()) return $('panel-chat').classList.contains('open') && !$('notebook-view').hidden;
  return !$('notebook-view').hidden;
}

function pollNotesPane() {
  if (activePane !== 2) return;
  // En mobile #notebook-view y la lista son mutuamente excluyentes (overlay),
  // así que alcanza con pollear la que esté a la vista. En desktop las dos
  // conviven en pantalla a la vez — si solo se pollea la que "está visible"
  // según notebookIsVisible(), la lista deja de refrescarse para siempre en
  // cuanto se abre la primera libreta (no hay forma de "cerrarla" en desktop,
  // el botón atrás es mobile-only). Ver Finding 1 del review final.
  if (notebookIsVisible()) safeLoadNotes();
  if (!isMobile() || !notebookIsVisible()) safeLoadNotebookList();
}

setInterval(pollNotesPane, 5000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) pollNotesPane();
});
