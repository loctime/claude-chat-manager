let currentConv = null;
let eventSource = null;
let tree = [];
let treeLimit = 100;
let treeHasMore = false;
let treeTotal = 0;
let archivedTotal = 0;
let showArchived = false;
let lastUserText = '';
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
      loadTree();
    };
  } catch {}
}

// ── Toast ──
function toast(msg, kind = 'error', ttl = 4000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transition = 'opacity .2s';
    setTimeout(() => t.remove(), 220);
  }, ttl);
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
  closeChatMenu();
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
    closeChatMenu();
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
    if (currentConv) await loadMessages(currentConv);
  } finally {
    btn.classList.remove('spinning');
  }
}
$('refresh-btn').onclick = refreshAll;

// ── Pull-to-refresh en el panel lista ──
(function initPTR() {
  const nav = $('tree');
  const indicator = $('ptr-indicator');
  let startY = 0;
  let pulling = false;

  nav.addEventListener('touchstart', e => {
    if (nav.scrollTop === 0) { startY = e.touches[0].clientY; pulling = true; }
  }, { passive: true });

  nav.addEventListener('touchmove', e => {
    if (!pulling) return;
    if (e.touches[0].clientY - startY > 60) indicator.hidden = false;
  }, { passive: true });

  nav.addEventListener('touchend', async () => {
    if (!pulling) return;
    pulling = false;
    if (!indicator.hidden) {
      await loadTree();
      indicator.hidden = true;
    }
  });
})();

// ── Tree ──
function badge(status) {
  return status === 'running' ? '⚡' : status === 'queued' ? '⏳' : '';
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
    ${b ? `<span class="conv-badge">${b}</span>` : ''}
  `;
  div.querySelector('.conv-name-text').textContent = c.name;
  div.querySelector('.conv-date').textContent = (c.lastActivity || '').slice(0, 16).replace('T', ' ');
  div.onclick = () => selectConv(c.convId, c.name, c.model, c.lastModel);
  attachContextMenu(div, c);
  return div;
}

async function loadTree() {
  const params = new URLSearchParams({ limit: String(treeLimit) });
  if (showArchived) params.set('archived', '1');
  if (activeAccount) params.set('account', activeAccount);
  const resp = await api('/tree?' + params);
  tree = resp.tree;
  treeHasMore = resp.hasMore;
  treeTotal = resp.total;
  archivedTotal = resp.archivedTotal || 0;
  const nav = $('tree');
  nav.innerHTML = '';
  for (const proj of tree) {
    const det = document.createElement('details');
    det.className = 'project';
    det.open = true;
    const sum = document.createElement('summary');
    sum.textContent = proj.projectDir.split('/').pop() || proj.projectDir;
    sum.title = proj.projectDir;
    det.appendChild(sum);
    for (const c of proj.conversations) det.appendChild(convElement(c));
    nav.appendChild(det);
  }

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

  // Toggle archivadas
  if (archivedTotal > 0 || showArchived) {
    const t = document.createElement('button');
    t.className = 'archived-toggle';
    t.type = 'button';
    t.textContent = showArchived
      ? `← Volver a activas`
      : `Ver archivadas (${archivedTotal})`;
    t.onclick = () => { showArchived = !showArchived; treeLimit = 100; safeLoadTree(); };
    nav.appendChild(t);
  }
}

// ── Menú contextual (click derecho + long-press mobile) ──
function attachContextMenu(el, conv) {
  let touchTimer = null;
  let longPressed = false;
  let startX = 0, startY = 0;

  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    showConvMenu(e.clientX, e.clientY, conv);
  });

  el.addEventListener('touchstart', e => {
    longPressed = false;
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
    if (!touchTimer) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) {
      clearTimeout(touchTimer);
      touchTimer = null;
    }
  }, { passive: true });

  el.addEventListener('touchend', () => {
    if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
  }, { passive: true });

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
        safeLoadTree();
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
      safeLoadTree();
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

function addMsg(role, text, opts = {}) {
  const existing = document.getElementById('empty-state');
  if (existing) existing.remove();

  const div = document.createElement('div');
  div.className = 'msg ' + role;
  if (opts.compacted) div.classList.add('compacted');
  if (role !== 'error') {
    const span = document.createElement('span');
    span.className = 'msg-text';
    renderTextWithPaths(span, text);
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
  messagesEl.scrollTop = messagesEl.scrollHeight;
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
  messagesEl.scrollTop = messagesEl.scrollHeight;
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
  messagesEl.innerHTML = '';
  const msgs = await api(withAccount(`/conversations/${convId}/messages`));
  lastUserText = '';
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user' && (msgs[i].text || '').trim() && !msgs[i].compacted) {
      lastUserText = msgs[i].text;
      break;
    }
  }
  updateRetryBtn();
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
}

function updateRetryBtn() {
  $('menu-retry').disabled = !currentConv || !lastUserText;
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
        if (payload.code !== 0 && payload.stderr) addMsg('error', 'Error: ' + payload.stderr);
        loadMessages(convId);
        loadTree();
        refreshCostBadge(convId);
      } else {
        setBusy(true);
        loadTree();
      }
    } else if (payload.kind === 'meta') {
      if (payload.name) $('conv-title').textContent = payload.name;
      loadTree();
    }
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
    badge.textContent = (pctLabel ? `ctx ${pctLabel} · ` : '') + `${fmtTokens(totalTokens)} · $${cost.toFixed(cost < 0.01 ? 4 : 2)}`;
    badge.title = `contexto: ${ctx.toLocaleString()} / ${win.toLocaleString()} tokens (${(pct * 100).toFixed(1)}%)\n` +
                  `in: ${t.input.toLocaleString()}  out: ${t.output.toLocaleString()}\n` +
                  `cache write: ${t.cacheCreate.toLocaleString()}  cache read: ${t.cacheRead.toLocaleString()}\n` +
                  `costo estimado: US$ ${cost.toFixed(4)}`;
  } catch {
    badge.hidden = true;
  }
}

// ── Select conversation ──
async function selectConv(convId, name, model, lastModel) {
  if (currentConv) drafts.set(currentConv, $('input').value);
  currentConv = convId;
  $('input').value = drafts.get(convId) || '';
  autoResize($('input'));
  $('conv-title').textContent = name;
  $('model-select').options[0].textContent = lastModel || 'auto';
  $('model-select').value = model || '';
  $('menu-btn').hidden = false;
  setBusy(false);
  clearAttachments();
  openChat();
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

// ── Menú "..." del chat ──
function closeChatMenu() { $('chat-menu').hidden = true; }
function toggleChatMenu() {
  const m = $('chat-menu');
  m.hidden = !m.hidden;
}
$('menu-btn').onclick = e => { e.stopPropagation(); toggleChatMenu(); };
$('chat-menu').addEventListener('click', e => e.stopPropagation());
document.addEventListener('click', e => {
  if (!$('chat-menu').hidden && !$('chat-menu').contains(e.target) && e.target !== $('menu-btn')) {
    closeChatMenu();
  }
});
$('menu-export').onclick = () => {
  closeChatMenu();
  if (!currentConv) return;
  const url = `/api${withAccount(`/conversations/${currentConv}/export?format=md`)}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
};

// ── Textarea auto-resize ──
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}
$('input').addEventListener('input', () => autoResize($('input')));

// ── Keyboard ──
$('input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!$('send').disabled) $('composer').requestSubmit();
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && currentConv && !$('cancel-btn').hidden) $('cancel-btn').click();
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
    const span = document.createElement('span');
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
  messagesEl.scrollTop = messagesEl.scrollHeight;
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
  lastUserText = text;
  updateRetryBtn();
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

// ── Retry último mensaje ──
$('menu-retry').onclick = async () => {
  closeChatMenu();
  if (!currentConv || !lastUserText) return;
  const btn = $('menu-retry');
  btn.disabled = true;
  try {
    // Si hay una ejecución en curso, cancelar primero
    if (!$('cancel-btn').hidden) {
      try { await api(`/conversations/${currentConv}/message`, { method: 'DELETE' }); } catch {}
    }
    // Reintentar POST hasta que el runner esté libre (max 5s)
    const deadline = Date.now() + 5000;
    const rawUserText = lastUserText.replace(/^\[Archivo adjunto:[^\]]+\]\n*/gm, '').trim();
    addUserMsgWithFiles(rawUserText, []);
    setBusy(true);
    while (Date.now() < deadline) {
      try {
        await api(`/conversations/${currentConv}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(withAccountBody({ text: lastUserText })),
        });
        return;
      } catch (err) {
        if (/procesando/i.test(err.message)) {
          await new Promise(r => setTimeout(r, 200));
          continue;
        }
        throw err;
      }
    }
    throw new Error('timeout esperando que termine la ejecución anterior');
  } catch (err) {
    addMsg('error', 'No se pudo reintentar: ' + err.message);
    setBusy(false);
  } finally {
    updateRetryBtn();
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
  const projectDir = $('project-custom').value.trim() || $('project-select').value;
  const text = $('first-message').value.trim();
  const model = $('new-model').value;
  if (!projectDir || !text) return;
  const submitBtn = e.submitter;
  if (submitBtn) submitBtn.disabled = true;
  try {
    const { convId } = await api('/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(withAccountBody({ projectDir, text, model: model || undefined })),
    });
    $('new-dialog').close();
    $('first-message').value = '';
    $('project-custom').value = '';
    $('new-model').value = '';
    await selectConv(convId, text.slice(0, 60), model);
    addMsg('user', text);
    setBusy(true);
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
  await selectConv(r.convId, r.displayName || r.name, null, null);
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

async function safeLoadTree() {
  try { await loadTree(); }
  catch (err) { toast('No se pudo actualizar la lista: ' + err.message); }
}
loadAccounts().then(() => safeLoadTree());
setInterval(safeLoadTree, 15000);

// ── Configuración ──
const SETTINGS_KEY = 'ccm.settings';
const DEFAULT_SETTINGS = {
  showTools: true,
  voiceAssistant: '',
  voiceUser: '',
  colorAccent: '',
  colorMe: '',
  colorAi: '',
};
const settings = { ...DEFAULT_SETTINGS, ...loadSettings() };

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
  catch { return {}; }
}
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
function applySettings() {
  document.body.classList.toggle('hide-tools', !settings.showTools);
  const root = document.documentElement;
  const vars = { '--accent': settings.colorAccent, '--bubble-me': settings.colorMe, '--bubble-ai': settings.colorAi };
  for (const [k, v] of Object.entries(vars)) {
    if (v) root.style.setProperty(k, v);
    else root.style.removeProperty(k);
  }
}
applySettings();

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

$('cfg-reset').onclick = () => {
  Object.assign(settings, DEFAULT_SETTINGS);
  applySettings(); saveSettings();
  openSettings();
  toast('Configuración restaurada', 'info', 2000);
};
