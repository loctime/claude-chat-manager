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
let activePane = 0; // 0=chats 1=archived 2=notas 3=escaner 4=codex
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
  // esta fila no llama a attachRowGestures() como sí hacen las de chat (no
  // tiene swipe-to-archive: las libretas no se archivan), así que el guard
  // de initPaneSwipe() la deja pasar explícitamente para que el swipe de
  // pantalla (Chats/Libretas/Archivado) siga funcionando arrancando sobre
  // ella — si no, con la lista llena de libretas no queda fondo tocable
  // para ese gesto. Ver Finding 2 del review final. Sí tiene su propio menú
  // contextual (attachNotebookGestures, solo click derecho/long-press — sin
  // arrastre horizontal — así no compite con ese swipe de pantalla).
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
  attachNotebookGestures(div, nb);
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

// El botón "+" ya no crea la libreta al toque — abre este borrador (mismo
// panel/overlay, currentNotebook en null) para que tocar "+" y arrepentirse
// sin escribir nada no deje una "Nueva libreta" vacía tirada en la lista
// (era justo lo que pasaba antes: cada toque, aunque fuera por error o para
// mirar, ya la creaba server-side). La libreta recién se crea de verdad en
// ensureNotebookCreated(), llamado desde el composer/upload al primer
// contenido real.
function openNotebookDraft() {
  currentNotebook = null;
  $('notebook-title').textContent = 'Nueva nota';
  notesData = [];
  renderNotes();
  showNotebookView(true);
  openChat();
  $('notes-input').value = '';
  autoResize($('notes-input'));
  $('notes-input').focus();
}

// Crea la libreta recién en el momento en que hay contenido real que
// guardar (primera nota de texto o primer archivo adjunto) — ver
// openNotebookDraft(). Si ya existe (libreta real abierta, o ya se creó en
// un envío anterior de este mismo borrador), no vuelve a crear nada.
async function ensureNotebookCreated() {
  if (currentNotebook) return currentNotebook.id;
  const nb = await api('/notebooks', { method: 'POST' });
  notebooks.push(nb);
  currentNotebook = { id: nb.id, name: nb.name };
  $('notebook-title').textContent = nb.name;
  renderNotebookList();
  return currentNotebook.id;
}

let archivedPaneLoaded = false;
let codexTreeLoaded = false;
let activeAccount = null;
const drafts = new Map();
// Nombre de la app configurado del lado del server (CCM_APP_NAME) — index.html
// y manifest.json ya vienen con el nombre correcto server-rendered; esto es
// solo para los pedacitos que arma el JS después (título dinámico, toasts).
let APP_NAME = 'J.A.R.V.I.S';
// Color de identidad server-side (ídem APP_NAME) — se usa solo para
// precargar el input de Configuración; el pintado real ya viene hecho por el
// <style> inline server-rendered de index.html.
let APP_COLOR = '#25d366';
// Tu propio nombre (ídem APP_NAME, mismo origen server-side) — se usa como
// etiqueta de tus mensajes al copiar una conversación en "modo conversación".
let USER_NAME = 'Vos';
// Si hay una API key de Groq guardada en el server (nunca se manda la key en
// sí al cliente, solo este booleano — ver /api/accounts y /api/config).
let GROQ_KEY_SET = false;

const $ = id => document.getElementById(id);
const messagesEl = $('messages');

// ── Selector de cuentas ──
async function loadAccounts() {
  try {
    const r = await fetch('/api/accounts');
    const { accounts, active, otherLocalUrl, otherPublicUrl, otherLabel, appName, appColor, userName, groqApiKeySet } = await r.json();
    activeAccount = active;
    if (appName) { APP_NAME = appName; updateGlobalBusyIndicator(); }
    if (appColor) APP_COLOR = appColor;
    if (userName) USER_NAME = userName;
    GROQ_KEY_SET = !!groqApiKeySet;
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

// ── Estado de cuenta: email logueado + uso 5h/semanal ──
// El server cachea /api/usage ~1h de su lado (la API de Anthropic está muy
// rate-limiteada), así que este poll acá adentro es solo para refrescar la
// UI cuando ese cache avanza — no pega directo contra Anthropic.
function usageTone(pct) {
  if (pct >= 90) return 'hot';
  if (pct >= 70) return 'warm';
  return '';
}
// "2 : 30 min" — lo que falta para el reinicio de la ventana, formato reloj.
// Horas sin tope en 24 (la semanal puede llegar a mostrar "36 : 15 min").
// Redondeado a favor del usuario (floor) para no mostrar "0 : 00 min" un
// instante antes de que en realidad reinicie.
function formatCountdown(ms) {
  if (ms == null || ms <= 0) return '¡ya!';
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h} : ${String(m).padStart(2, '0')} min`;
}
// El label ("5h" / "Semana") se reemplaza por la cuenta regresiva al reinicio
// mientras haya resetsAt guardado en el dataset — se recalcula solo (ver
// setInterval más abajo) sin esperar al próximo loadUsage(), así el número
// baja solo entre polls en vez de quedar pegado al valor de la última carga.
function updateCountdownLabel(el) {
  const label = el.querySelector('.usage-bar-label');
  const resetsAt = el.dataset.resetsAt ? Number(el.dataset.resetsAt) : null;
  label.textContent = resetsAt ? formatCountdown(resetsAt - Date.now()) : label.dataset.staticLabel;
}
function renderUsageBar(el, info) {
  if (!info || info.pct == null) { el.hidden = true; return; }
  el.hidden = false;
  const pct = Math.max(0, Math.min(100, info.pct));
  const tone = usageTone(pct);
  const fill = el.querySelector('.usage-bar-fill');
  fill.style.width = pct + '%';
  if (tone) fill.dataset.tone = tone; else delete fill.dataset.tone;
  el.querySelector('.usage-bar-pct').textContent = Math.round(pct) + '%';
  const resets = info.resetsAt ? new Date(info.resetsAt) : null;
  if (resets) el.dataset.resetsAt = String(resets.getTime()); else delete el.dataset.resetsAt;
  updateCountdownLabel(el);
  el.title = resets ? `Reinicia ${resets.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : '';
}
// Tick liviano cada 30s para que la cuenta regresiva baje sola entre polls
// reales (loadUsage corre cada 10min + con cada mensaje, no cada 30s).
setInterval(() => {
  const b5 = $('usage-5h'), b7 = $('usage-7d');
  if (b5 && !b5.hidden) updateCountdownLabel(b5);
  if (b7 && !b7.hidden) updateCountdownLabel(b7);
}, 30000);
async function loadUsage() {
  try {
    const d = await api(withAccount('/usage'));
    const box = $('account-status');
    if (!d.email && !d.fiveHour && !d.sevenDay) { box.hidden = true; return; }
    box.hidden = false;
    $('account-status-email').textContent = d.email || '';
    renderUsageBar($('usage-5h'), d.fiveHour);
    renderUsageBar($('usage-7d'), d.sevenDay);
  } catch {}
}

// ── Toast: ver toast.js ──
// ── PWA (service worker + install): ver pwa.js ──

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

// Flash momentáneo en la fila de la lista al volver de un chat — en mobile la
// lista queda tapada por #panel-chat mientras estás adentro, así que .active
// (pensado para desktop, donde lista y chat se ven juntos) no alcanza como
// pista de "esta era la conversación que tenías abierta". Busca en ambos
// paneles (Chats/Archivado) porque no sabemos de cuál vino sin guardar más
// estado del que hace falta.
function flashConvRow(convId) {
  if (!convId) return;
  const row = [...document.querySelectorAll('#tree .conv, #tree-archived .conv')]
    .find(el => el._conv && el._conv.convId === convId);
  if (!row) return;
  row.classList.remove('flash');
  void row.offsetWidth; // forzar reflow: permite re-disparar la animación si ya corrió hace poco (p.ej. entrar y salir rápido)
  row.classList.add('flash');
  row.addEventListener('animationend', () => row.classList.remove('flash'), { once: true });
}

// ── Swipe hacia la derecha en el chat abierto (mobile): volver a la lista ──
// Mismo patrón que initPaneSwipe de más abajo (axis-lock para no competir con
// el scroll vertical de los mensajes, sigue el dedo en vivo, umbral al soltar)
// pero de un solo sentido: acá no hay "página siguiente", solo cerrar.
const CHAT_SWIPE_THRESHOLD = 80;
let chatStartX = 0, chatStartY = 0, chatAxisLocked = null, chatDragging = false, chatCurrentTranslate = 0;

function closeChatAfterSwipe() {
  const panel = $('panel-chat');
  // Se saca la clase y el estilo inline en el mismo tick (no en dos pasos)
  // para que la transición CSS de .25s arranque desde donde el dedo lo soltó
  // hacia afuera, en vez de "saltar" primero de vuelta al centro.
  panel.classList.remove('open');
  panel.style.transition = '';
  panel.style.transform = '';
  flashConvRow(currentConv);
  // history.back() solo para mantener sincronizado el historial (mismo motivo
  // que closeChat() de arriba) — chatClosedBySwipe le avisa al popstate que
  // esto ya lo resolvimos acá (ver su declaración, más abajo).
  if (isMobile() && history.state && history.state.view === 'chat') {
    chatClosedBySwipe = true;
    history.back();
  }
}

function initChatSwipe() {
  const panel = $('panel-chat');

  panel.addEventListener('touchstart', e => {
    if (!isMobile() || !panel.classList.contains('open')) return;
    // No competir con el scroll horizontal propio de un bloque de código, ni
    // con el modo selección múltiple de mensajes (ahí el tap ya hace otra cosa).
    if (e.target.closest('pre') || selectMode) return;
    const t = e.touches[0];
    chatStartX = t.clientX; chatStartY = t.clientY;
    chatAxisLocked = null;
    chatDragging = true;
    chatCurrentTranslate = 0;
    panel.style.transition = 'none';
  }, { passive: true });

  panel.addEventListener('touchmove', e => {
    if (!chatDragging) return;
    const t = e.touches[0];
    const dx = t.clientX - chatStartX;
    const dy = t.clientY - chatStartY;
    if (chatAxisLocked === null) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      chatAxisLocked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    if (chatAxisLocked !== 'x' || dx < 0) return; // solo se sigue el dedo hacia la derecha
    chatCurrentTranslate = dx;
    panel.style.transform = `translateX(${dx}px)`;
    e.preventDefault();
  }, { passive: false });

  function chatSwipeEnd() {
    if (!chatDragging) return;
    chatDragging = false;
    if (chatAxisLocked === 'x' && chatCurrentTranslate > CHAT_SWIPE_THRESHOLD) {
      closeChatAfterSwipe();
    } else {
      // No llegó al umbral (o el gesto terminó siendo vertical): vuelve a su
      // lugar con la misma transición CSS de siempre, no con un salto.
      panel.style.transition = '';
      panel.style.transform = '';
    }
    chatAxisLocked = null;
    chatCurrentTranslate = 0;
  }
  panel.addEventListener('touchend', chatSwipeEnd);
  panel.addEventListener('touchcancel', chatSwipeEnd);
}
initChatSwipe();

// Estado inicial: 'list' + varias entries de guarda para que popstate
// nunca dispare en el borde del historial (donde Android cierra el PWA sin dar tiempo a re-armar).
history.replaceState({ view: 'list' }, '');
for (let i = 0; i < 3; i++) history.pushState({ view: 'list-guard' }, '');

let _lastBackPress = 0;
let _exiting = false;
// El swipe hacia la derecha (initChatSwipe, más arriba) ya cierra el panel y
// dispara el flash por su cuenta antes de llamar a history.back() — solo para
// mantener sincronizado el conteo del historial (así el botón atrás de
// Android no queda "un paso atrasado"). Sin esta bandera, el popstate que
// dispara ese history.back() volvería a entrar al branch de abajo y, como ya
// no encuentra la clase 'open' (la sacamos nosotros), lo tomaría como si ya
// estuviéramos en la lista raíz — pisando el conteo de "doble atrás para salir".
let chatClosedBySwipe = false;
window.addEventListener('popstate', (e) => {
  if (_exiting) return; // salida en curso — dejamos que el browser cierre
  if (chatClosedBySwipe) { chatClosedBySwipe = false; return; } // ya lo resolvimos nosotros, solo faltaba este pop
  // Si estábamos en chat: cerrar y re-armar guarda
  if ($('panel-chat').classList.contains('open')) {
    $('panel-chat').classList.remove('open');
    flashConvRow(currentConv);
    history.pushState({ view: 'list-guard' }, '');
    return;
  }
  // Si hay algún menú/dialog abierto, cerrar y consumir el back
  const searchDlg = $('search-dialog');
  if (searchDlg.open) { searchDlg.close(); history.pushState({ view: 'list-guard' }, ''); return; }
  const ctxMenu = document.querySelector('.ctx-menu');
  if (ctxMenu) { ctxMenu.remove(); history.pushState({ view: 'list-guard' }, ''); return; }
  // Si estamos en Archivado o Notas: volver a Chats en vez de ofrecer salir
  if (activePane !== 0) {
    goToPane(0);
    history.pushState({ view: 'list-guard' }, '');
    return;
  }
  // Estamos en la lista raíz de chats: doble click atrás para salir
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
    : `No se pudo contactar a ${APP_NAME} (conexión caída o server sin responder)`);
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

// ── TTS (Web Speech API): speak/cleanForTTS/makeTtsBtn → ver tts.js ──

// Botón de copiar mensaje, mismo tamaño/estilo que el de TTS (msg-tts) —
// Diego lo pidió duplicado (arriba y abajo de la burbuja), a diferencia del
// TTS que solo va arriba.
function makeCopyMsgBtn(text) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msg-copy';
  btn.title = 'Copiar mensaje';
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
  if (!text || !text.trim()) btn.style.display = 'none';
  btn.onclick = e => {
    e.preventDefault();
    e.stopPropagation();
    copyToClipboard(text);
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1200);
  };
  return btn;
}

// ── Refresh manual: recarga dura, no solo re-pedir los datos por API ──
// Antes esto era un refreshAll() que solo volvía a pedir /tree y los mensajes
// del chat abierto — no bajaba index.html/app.js/style.css de cero, así que
// no servía para forzar una versión nueva (para eso había que ir a buscar
// Ctrl+Shift+R a mano). Navegar a una URL con querystring nuevo no puede
// venir de la caché del navegador (es una URL distinta), así que fuerza
// exactamente eso: baja todo de nuevo, mismo efecto que un hard refresh.
// Trade-off asumido: perdés el chat abierto (volvés a la lista) y un mensaje
// sin enviar en el composer — las conversaciones guardadas no se tocan.
$('refresh-btn').onclick = () => {
  location.href = location.pathname + '?_r=' + Date.now();
};

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
  // El badge de estado (procesando/en cola) tiene prioridad visual sobre el
  // punto de no leído — mientras corre, "no leído" todavía no aplica.
  const b = badge(c.status) || (c.unread ? '<span class="unread-dot" title="Sin leer"></span>' : '');
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

// ── Codex: árbol de conversaciones (pane 4) ──
// Codex es single-account (no hay withAccount/withAccountBody acá) y su
// árbol no tiene ni de lejos la complejidad del de Claude (sin proyectos
// anidados, sin badges de modelo/costo) — wrapper y fila propios en vez de
// reusar api()/convElement().
async function codexApi(path, opts) {
  const method = (opts && opts.method) || 'GET';
  const res = method === 'GET'
    ? await netFetch('/api/codex' + path, opts)
    : await fetch('/api/codex' + path, opts).catch(err => { throw netError(err); });
  if (!res.ok && res.status !== 202) throw new Error((await res.json()).error || res.statusText);
  return res.json();
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
  nameEl.textContent = c.name; // textContent, no innerHTML — mismo criterio de escape que convElement()
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
    const { convId } = await codexApi('/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    codexSelectConv(convId, 'Nueva conversación');
  } catch (err) {
    toast('No se pudo crear la conversación de Codex: ' + err.message);
  }
}

// currentCodexConv: {id, name} de la conversación Codex abierta en #codex-chat,
// o null si estamos viendo la lista.
let currentCodexConv = null;
// EventSource activo del stream de la conversación Codex abierta, o null.
let codexStream = null;

async function codexLoadMessages(convId) {
  const container = $('codex-messages');
  container.innerHTML = '';
  const msgs = await codexApi(`/conversations/${convId}/messages`);
  for (const m of msgs) addMsg(m.role, m.text, { container, ts: m.ts });
  if (msgs.length === 0) container.innerHTML = '<div id="empty-state" class="empty-state">Escribile algo a Codex</div>';
}

function codexOpenStream(convId) {
  const es = new EventSource(`/api/codex/conversations/${convId}/stream`);
  es.onmessage = e => {
    const data = JSON.parse(e.data);
    const container = $('codex-messages');
    if (data.kind === 'status') {
      setCodexBusy(data.status === 'running' || data.status === 'queued');
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
  es.onerror = () => { /* EventSource reintenta solo; nada que hacer acá */ };
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
  // Limpiar "no leído" al abrir, en paralelo con la carga de mensajes — mismo
  // orden que usa selectConv() para Claude (PATCH antes de refrescar el árbol,
  // evita que el punto quede pegado un instante de más por una carrera).
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
  await codexApi(`/conversations/${currentCodexConv.id}/message`, { method: 'DELETE' });
}

async function codexPerformSend(convId, text, imagePath) {
  addMsg('user', text, { container: $('codex-messages') });
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

// Sube una imagen a /api/upload (mismo endpoint genérico que ya usa el
// composer de Chats, no es Codex-específico) y devuelve la ruta local.
// No se reusa uploadAttachment() tal cual: esa función está acoplada al DOM
// del composer de Claude (escribe en #composer-attachments, empuja a
// pendingAttachments, y aborta si currentConv es null) — para Codex hace
// falta solo la subida, sin esos efectos secundarios. Sí se reusa
// prepareForUpload(), que es genérica (File → Blob, sin tocar el DOM).
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
  if (index === 4 && !codexTreeLoaded) {
    try {
      await codexLoadTree();
      codexTreeLoaded = true;
    } catch (err) {
      toast('No se pudo cargar Codex: ' + err.message);
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
$('scan-back').onclick = () => goToPane(0);
// Acceso directo al Escáner desde el header — en mobile #pane-tabs está
// oculto (solo aparece en pantallas >=768px, ver style.css) y la única forma
// de llegar a una pestaña es haciendo swipe, poco descubrible. Este botón
// evita depender del gesto para una acción tan frecuente como escanear.
$('header-scan-btn').onclick = () => goToPane(3);

$('notebook-back-btn').onclick = closeChat;

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
  document.title = anyBusy ? `● ${APP_NAME}` : APP_NAME;
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
    <button data-action="hide" class="ctx-danger">🙈 Ocultar</button>
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
    if (action === 'hide') {
      try {
        await api(`/conversations/${conv.convId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(withAccountBody({ hidden: true })),
        });
        if (conv.convId === currentConv) {
          // No hay una vista "vacía" dedicada — recargar deja la app en el
          // estado inicial (sin conversación abierta), simple y sin bugs de
          // estado a mano.
          location.reload();
          return;
        }
        refreshVisibleTrees();
        toast('Conversación ocultada', 'info', 2500);
      } catch (err) { toast('No se pudo ocultar: ' + err.message); }
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

// ── Menú contextual de libretas (click derecho + long-press mobile) ──
// A diferencia de attachRowGestures (chats), sin arrastre horizontal: las
// libretas no se archivan, solo se ocultan desde el menú — así el gesto no
// compite con el swipe de pantalla que initPaneSwipe deja pasar sobre estas
// filas (ver comentario en notebookElement).
function attachNotebookGestures(el, nb) {
  let touchTimer = null;
  let longPressed = false;
  let startX = 0, startY = 0;

  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    showNotebookMenu(e.clientX, e.clientY, nb);
  });

  el.addEventListener('touchstart', e => {
    longPressed = false;
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
    touchTimer = setTimeout(() => {
      longPressed = true;
      touchTimer = null;
      showNotebookMenu(startX, startY, nb);
      if (navigator.vibrate) { try { navigator.vibrate(30); } catch {} }
    }, 500);
  }, { passive: true });

  el.addEventListener('touchmove', e => {
    if (!touchTimer) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) {
      clearTimeout(touchTimer); touchTimer = null;
    }
  }, { passive: true });

  el.addEventListener('touchend', () => {
    if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
  });

  // Bloquear el click sintético que dispara touchend después del long-press
  // (si no, abre la libreta y cierra el menú)
  el.addEventListener('click', e => {
    if (longPressed) {
      longPressed = false;
      e.stopPropagation();
      e.preventDefault();
    }
  }, { capture: true });
}

function showNotebookMenu(x, y, nb) {
  document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.innerHTML = `<button data-action="hide" class="ctx-danger">🙈 Ocultar</button>`;
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
    if (action !== 'hide') return;
    try {
      await api(`/notebooks/${nb.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: true }),
      });
      notebooks = notebooks.filter(n => n.id !== nb.id);
      renderNotebookList();
      if (currentNotebook && currentNotebook.id === nb.id) closeChat();
      toast('Libreta ocultada', 'info', 2500);
    } catch (err) { toast('No se pudo ocultar: ' + err.message); }
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
  // Antes de confirmar, nos fijamos si en el tramo que se va a olvidar hubo
  // acciones con efecto fuera de la charla (Bash/Edit/Write/...). Rebobinar
  // NO las deshace — solo hace que la charla "olvide" que pasaron.
  let effects = [];
  try {
    const preview = await api(withAccount(`/conversations/${currentConv}/rewind-preview?uuid=${encodeURIComponent(ctx.uuid)}`));
    effects = preview.effects || [];
  } catch { /* si el preview falla no bloqueamos el rebobinado por eso */ }

  let msg = 'Rebobinar hasta acá?\n\nElimina esta pregunta y TODO lo que vino después — Claude lo olvida de verdad, como si nunca hubiera pasado. La conversación sigue desde la respuesta anterior.\n\n(Queda un backup del archivo de sesión por las dudas.)';
  if (effects.length) {
    const lines = effects.map(e => `• ${e.summary}${e.reversible === false ? '  (IRREVERSIBLE)' : ''}`).join('\n');
    msg = `⚠️ En ese tramo se ejecutaron ${effects.length} acción(es) con efecto real fuera de la charla:\n\n${lines}\n\nRebobinar NO las deshace — el archivo/comando/commit sigue aplicado tal cual, solo se olvida que pasó en la charla. Convendría revisarlo antes de seguir.\n\n¿Rebobinar igual?`;
  }
  const ok = confirm(msg);
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
    <button data-action="multiselect">☑️ Seleccionar mensajes</button>
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
    else if (action === 'multiselect') enterMultiSelectMode(ctx.el);
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

// ── Selección múltiple de mensajes (marcar varias burbujas y copiarlas
// juntas) — separado del modo enterSelectionMode de arriba, que es selección
// nativa de texto DENTRO de una sola burbuja. msgCtxByEl guarda el {role,
// text} de cada burbuja para poder armar la copia sin volver a tocar el DOM.
const msgCtxByEl = new WeakMap();
let selectMode = false;
const selectedMsgs = new Set(); // elementos .msg marcados, en el orden en que se tocaron (no importa: se copian en orden de DOM)

function updateSelectBar() {
  const count = selectedMsgs.size;
  $('select-count').textContent = count === 1 ? '1 seleccionado' : `${count} seleccionados`;
  $('select-bar').hidden = !selectMode;
}

function toggleMsgSelection(el) {
  if (selectedMsgs.has(el)) {
    selectedMsgs.delete(el);
    el.classList.remove('msg-selected');
  } else {
    selectedMsgs.add(el);
    el.classList.add('msg-selected');
  }
  updateSelectBar();
}

function enterMultiSelectMode(startEl) {
  if (_endSelectionMode) _endSelectionMode(); // no mezclar con el modo de selección de texto nativo
  selectMode = true;
  if (startEl) toggleMsgSelection(startEl);
  else updateSelectBar();
}

function exitMultiSelectMode() {
  selectMode = false;
  selectedMsgs.forEach(el => el.classList.remove('msg-selected'));
  selectedMsgs.clear();
  const bar = $('select-bar');
  if (bar) bar.hidden = true;
}

// Los mensajes marcados en orden real de aparición en el chat (no en el orden
// en que los tocaste) — así "Copiar" siempre da una transcripción cronológica.
function orderedSelection() {
  return Array.from(messagesEl.children)
    .filter(el => selectedMsgs.has(el))
    .map(el => msgCtxByEl.get(el))
    .filter(Boolean);
}

function copySelectionAsConversation() {
  const items = orderedSelection();
  if (!items.length) return;
  const text = items
    .map(m => `${m.role === 'user' ? USER_NAME : APP_NAME}:\n${m.text}`)
    .join('\n\n');
  copyToClipboard(text);
}

function copySelectionAsSimple() {
  const items = orderedSelection();
  if (!items.length) return;
  copyToClipboard(items.map(m => m.text).join('\n\n'));
}

$('select-cancel').onclick = exitMultiSelectMode;
$('select-copy-conv').onclick = copySelectionAsConversation;
$('select-copy-simple').onclick = copySelectionAsSimple;

function attachMsgGestures(el, ctx) {
  ctx.el = el; // referencia para poder habilitar la selección de texto desde el menú
  msgCtxByEl.set(el, ctx); // referencia inversa: de la burbuja al {role, text} para el modo selección múltiple
  let touchTimer = null;
  let longPressed = false;
  let startX = 0, startY = 0;

  // Modo selección múltiple activo: un click en cualquier parte de la burbuja
  // (incluidos los botones de copiar/tts de adentro) la marca/desmarca en vez
  // de disparar su acción normal. Capture-phase para ganarle a esos botones.
  el.addEventListener('click', e => {
    if (!selectMode) return;
    e.preventDefault();
    e.stopPropagation();
    toggleMsgSelection(el);
  }, { capture: true });

  el.addEventListener('contextmenu', e => {
    if (el.classList.contains('selecting')) return; // dejamos el nativo (copiar/etc) mandar
    if (selectMode) { e.preventDefault(); toggleMsgSelection(el); return; }
    e.preventDefault();
    showMsgMenu(e.clientX, e.clientY, ctx);
  });

  el.addEventListener('touchstart', e => {
    // En modo selección de texto no reabrimos el menú: dejamos que el usuario
    // arrastre los handles nativos tranquilo (ver enterSelectionMode). En modo
    // selección múltiple tampoco: el tap normal (click) ya marca/desmarca.
    if (el.classList.contains('selecting') || selectMode) return;
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
// Con ts (viene del jsonl real, historial cargado) muestra esa fecha/hora;
// sin ts (mensaje recién mandado u optimista) usa el momento actual.
function now(ts) {
  return new Date(ts || Date.now()).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}

// Fecha centrada arriba de la burbuja, separada de la hora (que va en la
// esquina) para no confundir las dos — Diego lo pidió después de ver ambas
// pegadas. Color por antigüedad: hoy=azul, ayer/anteayer=blanco, 3+ días=rojo.
function dateLabel(ts) {
  const d = new Date(ts || Date.now());
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = new Date();
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diffDays = Math.round((todayDay - day) / 86400000);
  const cls = diffDays <= 0 ? 'msg-date-today' : diffDays <= 2 ? 'msg-date-recent' : 'msg-date-old';
  const text = d.toLocaleDateString('es', { day: 'numeric', month: 'long' });
  return { text, cls };
}

// ── Lightbox: ver lightbox.js (expone window.openLightbox) ──
// Lo que sigue de acá para abajo (íconos de archivo, revealInFolder, cards de
// adjuntos...) es del dominio grande de mensajes/adjuntos, no del lightbox en
// sí — se queda en app.js para otra vuelta.

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

// "Mostrar en carpeta"/"Abrir carpeta" siempre abre el Explorador en la PC
// donde corre Jarvis, sea cual sea el dominio desde el que se navegue
// (local o túnel público) — decisión de Diego: lo usa siempre por dominio,
// y quiere que Fernando (que entra por otro dominio) también lo tenga.
async function revealInFolder(filePath) {
  try {
    const r = await fetch('/api/reveal?path=' + encodeURIComponent(filePath));
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      toast(body.error || 'No se pudo abrir la carpeta', 'error', 2500);
      return;
    }
    toast('Abriendo carpeta…', 'info', 1200);
  } catch {
    toast('No se pudo contactar a Jarvis', 'error', 2500);
  }
}

function makeRevealBtn(filePath) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'reveal-btn';
  btn.title = 'Mostrar en carpeta';
  btn.textContent = '📂';
  btn.onclick = e => {
    e.preventDefault();
    e.stopPropagation();
    revealInFolder(filePath);
  };
  return btn;
}

// Descarga una carpeta como .zip. Va por fetch (no un <a href> plano) para
// poder mostrar el toast de error de tamaño en vez de que el navegador
// intente "descargar" el JSON de error — el server rechaza con 413 antes
// de armar nada si la carpeta pasa los 200MB (ver server.js).
async function downloadFolderZip(folderPath) {
  const name = folderPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'carpeta';
  try {
    const r = await fetch('/api/folder-zip?path=' + encodeURIComponent(folderPath));
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      toast(body.error || 'No se pudo descargar la carpeta', 'error', 3000);
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name + '.zip';
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    toast('No se pudo contactar a Jarvis', 'error', 2500);
  }
}

function makeZipDownloadBtn(folderPath) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'file-card-dl file-card-dl-btn';
  btn.title = 'Descargar carpeta (.zip, hasta 200MB)';
  btn.textContent = '⬇️ Descargar';
  btn.onclick = e => {
    e.preventDefault();
    e.stopPropagation();
    toast('Armando zip…', 'info', 1200);
    downloadFolderZip(folderPath);
  };
  return btn;
}

// Botón genérico "copiar" — mismo ⧉/✓ que ya usan los bloques de código
// y los comandos de tools, reusado acá para copiar la ruta completa.
function makeCopyBtn(text, title) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'reveal-btn';
  btn.title = title || 'Copiar';
  btn.textContent = '⧉';
  btn.onclick = e => {
    e.preventDefault();
    e.stopPropagation();
    copyToClipboard(text);
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = '⧉'; }, 1200);
  };
  return btn;
}

// Fila de "ruta completa" reusada por file/folder/image cards: la ruta se
// ve truncada con ellipsis (title con la ruta entera si no entra) y clickear
// el texto la copia directo — antes solo copiaba el botón ⧉ chiquito al
// lado, que en el celu es un blanco de click incómodo. El botón se deja
// igual como affordance visual explícita de "esto se copia".
function makePathRow(fullPath) {
  const pathRow = document.createElement('div');
  pathRow.className = 'file-card-path-row';
  const pathEl = document.createElement('span');
  pathEl.className = 'file-card-path';
  pathEl.textContent = fullPath;
  pathEl.title = 'Click para copiar la ruta';
  pathEl.onclick = e => {
    e.preventDefault();
    e.stopPropagation();
    copyToClipboard(fullPath);
  };
  pathRow.appendChild(pathEl);
  pathRow.appendChild(makeCopyBtn(fullPath, 'Copiar ruta'));
  return pathRow;
}

// Mención chica de una ruta que ya se mostró completa (thumbnail/ícono +
// acciones) antes en el mismo mensaje — un chip con marco, toda la ruta es
// el blanco de click, para no repetir la card entera en medio de una frase.
function makePathChip(fullPath) {
  const chip = document.createElement('span');
  chip.className = 'path-chip';
  chip.textContent = fullPath;
  chip.title = 'Click para copiar la ruta';
  chip.onclick = e => {
    e.preventDefault();
    e.stopPropagation();
    copyToClipboard(fullPath);
  };
  return chip;
}

// Crea una card de archivo inline (para PDFs y otros no-imagen)
function makeFileCard(filePath) {
  // split('/') solo no alcanza: en rutas de Windows el separador es '\' y
  // "name" terminaba siendo la ruta completa disfrazada de nombre de archivo.
  const name = filePath.split(/[\\/]/).pop();
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
  info.appendChild(nameEl);

  info.appendChild(makePathRow(filePath));

  const actions = document.createElement('div');
  actions.className = 'file-card-actions';
  const dl = document.createElement('a');
  dl.className = 'file-card-dl';
  dl.href = downloadHref;
  dl.download = name;
  dl.textContent = 'Descargar';
  actions.appendChild(dl);
  actions.appendChild(makeRevealBtn(filePath));
  info.appendChild(actions);
  card.appendChild(info);
  return card;
}

// Card para una carpeta detectada en el texto (sin extensión) — dos
// acciones: abrirla en la PC, o bajarla como .zip (para cuando no estás
// frente a la PC y "abrir" no te sirve de nada).
function makeFolderCard(folderPath) {
  const name = folderPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folderPath;

  const card = document.createElement('div');
  card.className = 'file-card file-card-folder';

  const icon = document.createElement('span');
  icon.className = 'file-card-icon';
  icon.textContent = '📁';
  card.appendChild(icon);

  const info = document.createElement('div');
  info.className = 'file-card-info';
  const nameEl = document.createElement('span');
  nameEl.className = 'file-card-name';
  nameEl.textContent = name;
  nameEl.title = folderPath;
  info.appendChild(nameEl);

  info.appendChild(makePathRow(folderPath));

  const actions = document.createElement('div');
  actions.className = 'file-card-actions';
  actions.appendChild(makeRevealBtn(folderPath));
  actions.appendChild(makeZipDownloadBtn(folderPath));
  info.appendChild(actions);

  card.appendChild(info);
  return card;
}

// Preview de imagen inline: thumbnail + ruta completa (con botón copiar) +
// acciones (descargar / mostrar en carpeta). Reusado tanto para
// "[Archivo adjunto: PATH]" como para paths sueltos detectados en el texto —
// antes cada rama armaba su propio <div> a mano y ninguna mostraba la ruta.
function makeImagePreview(filePath) {
  const name = filePath.split(/[\\/]/).pop();
  const downloadHref = '/api/files?path=' + encodeURIComponent(filePath);

  const wrap = document.createElement('div');
  wrap.className = 'inline-img-wrap';

  const img = document.createElement('img');
  img.className = 'inline-thumb';
  img.alt = name;
  img.src = '/api/thumbnail?path=' + encodeURIComponent(filePath);
  img.onclick = () => openLightbox(downloadHref, downloadHref, name);
  img.onerror = () => {
    img.replaceWith((() => {
      const a = document.createElement('a');
      a.href = downloadHref;
      a.download = name;
      a.textContent = filePath;
      a.className = 'path-link';
      return a;
    })());
  };
  wrap.appendChild(img);
  wrap.appendChild(makePathRow(filePath));

  const actions = document.createElement('div');
  actions.className = 'file-card-actions';
  const dl = document.createElement('a');
  dl.className = 'file-card-dl';
  dl.href = downloadHref;
  dl.download = name;
  dl.textContent = 'Descargar';
  actions.appendChild(dl);
  actions.appendChild(makeRevealBtn(filePath));
  wrap.appendChild(actions);

  return wrap;
}

// Detecta paths absolutos en texto y los convierte en links/previews.
// `seen` viaja por todas las llamadas recursivas de un mismo mensaje (ver
// renderAssistantText/enrichPlainTextNodes) — la primera vez que aparece una
// ruta se arma la card completa (thumbnail/ícono + acciones); si la misma
// ruta vuelve a aparecer más adelante en el mismo mensaje (típico: se manda
// como adjunto y después se la nombra de nuevo en una oración) ya no se
// duplica la card entera — queda un chip chico con marco, clickeable para
// copiar, que no rompe el flujo del párrafo.
function renderTextWithPaths(container, text, seen = new Set()) {
  // Primero reemplazar [Archivo adjunto: PATH] con preview directo (Unix y Windows)
  const ATTACH_RE = /\[Archivo adjunto:\s*([^\]]+)\]/g;
  let processed = text;
  const attachMatches = [];
  let am;
  while ((am = ATTACH_RE.exec(text)) !== null) attachMatches.push({ full: am[0], path: am[1].trim(), index: am.index });

  if (attachMatches.length > 0) {
    let pos = 0;
    for (const att of attachMatches) {
      if (att.index > pos) renderTextWithPaths(container, text.slice(pos, att.index), seen);
      const key = att.path.toLowerCase();
      if (seen.has(key)) {
        container.appendChild(makePathChip(att.path));
      } else {
        seen.add(key);
        const ext = att.path.split('.').pop().toLowerCase();
        if (IMAGE_EXTS.has(ext)) {
          container.appendChild(makeImagePreview(att.path));
        } else {
          container.appendChild(makeFileCard(att.path));
        }
      }
      pos = att.index + att.full.length;
    }
    if (pos < text.length) renderTextWithPaths(container, text.slice(pos), seen);
    return;
  }

  // Paths sueltos — Unix (/home/...) y Windows (C:\... o C:/...)
  // Los nombres de archivo pueden tener espacios (screenshots de Windows,
  // "Captura de pantalla ....png", reportes "Balance Agosto 2026.csv") —
  // se permite hasta 6 palabras extra siempre que termine en una extensión
  // de archivo genérica (letras/dígitos, 1-8 chars: cualquier tipo, no solo
  // imagen/pdf/audio/video), y se excluye ":" de esas palabras extra para
  // no fusionar dos paths distintos en el mismo mensaje
  // (ej. "C:\a\foto A.png y C:\b\foto B.png"). Un path relativo tipo
  // "server.js:445" no matchea — falta el prefijo absoluto.
  // Carpetas (sin extensión) también matchean vía la segunda alternativa
  // del regex, pero solo si el path no tiene espacios — una carpeta con
  // espacios en el nombre (ej. "Notas Jarvis") no se detecta acá, mismo
  // límite que ya existía antes para no confundir prosa con path.
  // "mnt" incluido para WSL: ahí el filesystem de Windows se ve montado en
  // /mnt/c/... (Jarvis puede correr dentro de WSL, no solo en Windows nativo
  // ni en el /home de un Linux normal).
  const PATH_WORD = "[^\\s`'\"(){}<>\\[\\]:]";
  // (?<![A-Za-z]) antes de la letra de unidad: sin esto, "https://..." matchea
  // como ruta — la "s" de "https" seguida de "://" cumple [A-Za-z]:[\\/] igual
  // que "C:\". Bug real (16/08/2026): un link de SharePoint se detectaba como
  // archivo local descargable y el botón "Descargar" tiraba 404 ("el sitio no
  // estaba disponible"). El lookbehind exige que la letra de unidad no esté
  // pegada a otra letra (arranque de string, espacio, etc.) — mismo criterio
  // para /home|tmp|... con un lookahead: tiene que seguir "/" o fin de string,
  // si no "/homepage" en una URL también matchearía.
  const PATH_RE = new RegExp(
    "(`?)((?:(?<![A-Za-z])[A-Za-z]:[\\\\/]|/(?:home|tmp|root|var|opt|usr|mnt)(?=[\\\\/]|$))" +
      "(?:" + PATH_WORD + "+(?:[ \\t]" + PATH_WORD + "+){0,6}\\.[A-Za-z0-9]{1,8}" +
      "|" + "[^\\s`'\"(){}<>\\[\\]]+" +
      "))\\1",
    "g"
  );
  let last = 0;
  let match;
  while ((match = PATH_RE.exec(text)) !== null) {
    if (match.index > last) {
      container.appendChild(document.createTextNode(text.slice(last, match.index)));
    }
    const filePath = match[2];
    const key = filePath.toLowerCase();
    if (seen.has(key)) {
      container.appendChild(makePathChip(filePath));
      last = match.index + match[0].length;
      continue;
    }
    seen.add(key);
    // Heurística file vs. carpeta: si el último segmento no termina en
    // ".ext" lo tratamos como carpeta (mismo criterio que ya usa el resto
    // del regex para exigir extensión en paths con espacios).
    const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(filePath);
    const ext = hasExt ? filePath.split('.').pop().toLowerCase() : '';
    const isImage = hasExt && IMAGE_EXTS.has(ext);

    if (isImage) {
      container.appendChild(makeImagePreview(filePath));
    } else if (hasExt) {
      // Cualquier otra extensión (pdf/audio/video con preview especial,
      // y cualquier tipo de archivo — html, docx, csv, zip, etc. — con
      // ícono genérico) — makeFileCard ya resuelve ambos casos.
      container.appendChild(makeFileCard(filePath));
    } else {
      // Sin extensión → lo tratamos como carpeta, no hay nada para descargar.
      container.appendChild(makeFolderCard(filePath));
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
// `seen` se comparte con renderAssistantText: markdown separa el mensaje en
// varios nodos de texto (uno por párrafo) y sin pasarlo de largo cada
// párrafo dedupearía solo contra sí mismo, no contra el resto del mensaje.
function enrichPlainTextNodes(root, seen) {
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
    if (!t || !/\[Archivo adjunto:|[A-Za-z]:[\\/]|\/(?:home|tmp|root|var|opt|usr|mnt)\S/.test(t)) continue;
    const frag = document.createDocumentFragment();
    renderTextWithPaths(frag, t, seen);
    node.replaceWith(frag);
  }
}

// Mensajes del asistente: markdown real (negrita, listas, tablas, código) +
// sanitizado, con el auto-linkeo de paths/adjuntos aplicado encima.
function renderAssistantText(container, text) {
  // Una sola ruta "vista" por mensaje — ver comentario en renderTextWithPaths.
  const seen = new Set();
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
    renderTextWithPaths(container, text, seen);
    return;
  }
  const html = DOMPurify.sanitize(marked.parse(text, { breaks: true, gfm: true }));
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  tpl.content.querySelectorAll('a[href]').forEach(a => {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });
  enrichPlainTextNodes(tpl.content, seen);
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
// Al cambiar de conversación (Tab o click) no queremos el fondo del todo
// (te tira al final del último mensaje, ya leído) sino el PRINCIPIO del
// último mensaje, para poder arrancar a leerlo. `pendingScrollToLastStart`
// lo activa selectConv() antes de loadMessages() y loadMessages() lo
// consume una sola vez (no pisa el comportamiento normal de "seguir
// pegado al fondo" mientras el turno sigue en curso).
let pendingScrollToLastStart = false;
function scrollToLastMessageStart() {
  const last = messagesEl.lastElementChild;
  if (last) last.scrollIntoView({ block: 'start' });
  else scrollToBottom();
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
let pinRafScheduled = false;
messagesEl.addEventListener('scroll', () => {
  if (suppressAutoScroll) return;
  stickToBottom = isNearBottom();
  syncJumpBtn();
  // rAF-throttled: updateLastUserPin() lee getBoundingClientRect de cada
  // burbuja propia, no hace falta correrlo en cada tick de scroll.
  if (!pinRafScheduled) {
    pinRafScheduled = true;
    requestAnimationFrame(() => { pinRafScheduled = false; updateLastUserPin(); });
  }
});

// Barra fija arriba de #messages con una vista previa de TU último mensaje
// (#last-user-pin, HTML). En una tanda larga (varios tool calls + respuesta
// larga) tu propio mensaje queda muy arriba del scroll y se pierde de vista
// — esto lo deja siempre visible, con click para volver a él. Se llama al
// terminar loadMessages() (recarga completa) y apenas se manda un mensaje
// nuevo (addUserMsgWithFiles, burbuja optimista, antes de que loadMessages
// la reemplace por la versión con uuid del jsonl).
function msgText(el) {
  const t = el.querySelector('.msg-text');
  return t ? t.textContent.trim() : '';
}

// Configura una fila del pin (botón) para que muestre `text` (recortado a
// `limit`) y, al tocarla, salte a `el` con el mismo scrollIntoView+highlight
// que usa el buscador.
function setPinRow(btn, el, text, limit) {
  const raw = text || '📎 Adjunto';
  const preview = raw.length > limit ? raw.slice(0, limit) + '…' : raw;
  btn.querySelector('.last-user-pin-text').textContent = preview;
  btn.title = text || 'Adjunto sin texto';
  btn.onclick = () => {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('search-hit');
    setTimeout(() => el.classList.remove('search-hit'), 2000);
  };
}

function updateLastUserPin() {
  const wrap = $('last-user-pin');
  const userMsgs = Array.from(messagesEl.querySelectorAll('.msg.user'));
  if (!userMsgs.length) { wrap.hidden = true; return; }

  // El mensaje que se muestra no es siempre el último: si estás scrolleado
  // más arriba mirando una parte vieja de la conversación, mostramos el
  // tuyo más cercano a esa parte — el último que ya "pasó" el borde de
  // arriba del scroll, mismo criterio que un header sticky. Al fondo del
  // todo (el caso de siempre) esto da el mismo resultado que "el último
  // mensaje", porque ese es el último en pasar ese borde.
  const msgsRect = messagesEl.getBoundingClientRect();
  let current = userMsgs[0];
  for (const el of userMsgs) {
    if (el.getBoundingClientRect().top - msgsRect.top <= 4) current = el;
    else break; // están en orden cronológico, no hace falta seguir mirando
  }

  // Si ese mensaje ya está completo a la vista (ej: recién abriste la
  // conversación y estás viendo el primer mensaje), el pin no suma nada —
  // sería un atajo para volver a algo que ya estás mirando. Se esconde en
  // vez de mostrarse redundante.
  const elRect = current.getBoundingClientRect();
  const fullyVisible = elRect.top >= msgsRect.top - 2 && elRect.bottom <= msgsRect.bottom + 2;
  if (fullyVisible) { wrap.hidden = true; return; }

  const idx = userMsgs.indexOf(current);
  const isLast = idx === userMsgs.length - 1;

  const currentText = msgText(current);
  const lastBtn = $('last-user-pin-last');
  lastBtn.querySelector('.last-user-pin-label').textContent = isLast ? 'Tu mensaje' : 'Este mensaje';
  setPinRow(lastBtn, current, currentText, 200);

  // Un mensaje muy corto ("si", "dale", "ok"...) no alcanza para acordarse
  // de qué se estaba hablando — sumamos arriba, más chico, el mensaje
  // propio anterior a ese como contexto (o más arriba si scrolleaste hasta
  // ahí, no siempre el último).
  const isShort = currentText.length <= 20 || currentText.split(/\s+/).filter(Boolean).length <= 3;
  const prevRow = $('last-user-pin-prev');
  const prev = isShort && idx > 0 ? userMsgs[idx - 1] : null;
  if (prev) {
    setPinRow(prevRow, prev, msgText(prev), 70);
    prevRow.hidden = false;
  } else {
    prevRow.hidden = true;
  }
  wrap.hidden = false;
}

function addMsg(role, text, opts = {}) {
  const container = opts.container || messagesEl;
  const existing = container.querySelector('#empty-state') || (container === messagesEl ? document.getElementById('empty-state') : null);
  if (existing) existing.remove();

  const div = document.createElement('div');
  div.className = 'msg ' + role;
  if (opts.compacted) div.classList.add('compacted');
  if (role !== 'error') {
    const kind = role === 'user' ? 'user' : 'assistant';

    // Barra arriba: copiar + escuchar, uno en cada punta.
    const topBar = document.createElement('div');
    topBar.className = 'msg-toolbar-top';
    topBar.appendChild(makeCopyMsgBtn(text));
    topBar.appendChild(makeTtsBtn(text, kind));

    const span = document.createElement('div');
    span.className = 'msg-text';
    if (role === 'assistant') {
      renderAssistantText(span, text);
      span.querySelectorAll('pre').forEach(addCodeCopyChip);
    } else {
      renderTextWithPaths(span, text);
    }

    // Barra abajo: una sola fila con copiar + escuchar a la izquierda, fecha
    // al medio y hora a la derecha (antes eran dos filas separadas).
    const date = dateLabel(opts.ts);
    const dateEl = document.createElement('span');
    dateEl.className = 'msg-date ' + date.cls;
    dateEl.textContent = date.text;
    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = now(opts.ts);
    const bottomIcons = document.createElement('span');
    bottomIcons.className = 'msg-bottom-icons';
    bottomIcons.appendChild(makeCopyMsgBtn(text));
    bottomIcons.appendChild(makeTtsBtn(text, kind));
    const bottomBar = document.createElement('div');
    bottomBar.className = 'msg-bottom-bar';
    bottomBar.appendChild(bottomIcons);
    bottomBar.appendChild(dateEl);
    bottomBar.appendChild(time);

    div.appendChild(topBar);
    div.appendChild(span);
    div.appendChild(bottomBar);
    attachMsgGestures(div, { role, text, uuid: opts.uuid, compacted: !!opts.compacted });
  } else {
    div.textContent = text;
  }
  container.appendChild(div);
  if (container === messagesEl) autoScroll();
  else container.scrollTop = container.scrollHeight; // autoScroll()/jumpBtn son estado del pane de Claude — un container ajeno (p.ej. #codex-messages) solo necesita quedar pegado al final
  return div;
}

function addTool(name, input, output, opts = {}) {
  const container = opts.container || messagesEl;
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

  container.appendChild(det);
  if (container === messagesEl) autoScroll();
  else container.scrollTop = container.scrollHeight;
}

// Marcador inline para un boundary de /compact real (mismo session_id antes y
// después — a diferencia de addCompactDivider(), que es el remanente del
// sistema viejo por resumen-y-sesión-nueva). Se muestra tanto si lo disparó el
// botón "Compactar" (trigger:'manual') como si el CLI lo hizo solo por límite
// de contexto (trigger:'auto') — antes esto último era invisible acá.
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
    // Se van pisando en cada vuelta; al salir del for solo quedan con algo
    // si el ÚLTIMO mensaje de la conversación es de Claude (cualquier tool/
    // user/error después los vuelve a null) — ver maybeShowReplySuggestions.
    let lastAssistantDiv = null;
    let lastAssistantMsg = null;
    for (const m of msgs) {
      if (m.compacted && !inCompacted) inCompacted = true;
      if (!m.compacted && inCompacted && !dividerPlaced) {
        addCompactDivider();
        dividerPlaced = true;
        inCompacted = false;
      }
      if (m.role === 'system-compact') { addCompactBoundary(m); lastAssistantDiv = null; continue; }
      const opts = { compacted: !!m.compacted, uuid: m.uuid, ts: m.ts };
      if (m.role === 'tool') {
        addTool(m.name, m.input, m.output, opts);
        lastAssistantDiv = null;
      } else {
        const div = addMsg(m.role, m.text, opts);
        if (m.role === 'assistant') { lastAssistantDiv = div; lastAssistantMsg = m; }
        else lastAssistantDiv = null;
      }
    }
    if (inCompacted && !dividerPlaced) addCompactDivider();
    if (lastAssistantDiv && !busy) {
      maybeShowReplySuggestions(convId, lastAssistantDiv, lastAssistantMsg.text, lastAssistantMsg.uuid);
    }
  } finally {
    suppressAutoScroll = false;
    if (pendingScrollToLastStart) {
      pendingScrollToLastStart = false;
      scrollToLastMessageStart();
    } else if (wasStuck) scrollToBottom();
    else messagesEl.scrollTop = prevTop;
    updateLastUserPin();
  }
}

// ── Respuestas sugeridas por IA (Groq) ──
// Se dispara solo para el ÚLTIMO mensaje de la conversación, cuando es de
// Claude y el turno no sigue en curso (ver el llamado en loadMessages más
// arriba). El server decide si corresponde sugerir algo — puede devolver []
// (mensaje informativo, nada que confirmar) y ahí no se pinta nada. Sin
// GROQ_KEY_SET ni siquiera pega al server.
const suggestionCache = new Map(); // uuid -> string[] — vive mientras dure la pestaña, no se persiste

async function maybeShowReplySuggestions(convId, div, text, uuid) {
  if (!GROQ_KEY_SET || !text || !text.trim()) return;
  let suggestions = suggestionCache.get(uuid);
  if (suggestions === undefined) {
    try {
      const r = await api('/suggest-replies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      suggestions = r.suggestions || [];
    } catch {
      suggestions = []; // nunca rompe el chat por esto
    }
    suggestionCache.set(uuid, suggestions);
  }
  // Puede haber pasado tiempo real esperando a Groq: si te fuiste de la
  // conversación, o ese mensaje ya no es el último (llegó una respuesta
  // nueva, por ejemplo el disparo automático de un mensaje en cola),
  // no pintamos botones desactualizados.
  if (convId !== currentConv || div !== messagesEl.lastElementChild || !suggestions.length) return;
  renderReplySuggestions(div, suggestions);
}

function renderReplySuggestions(div, suggestions) {
  const bar = document.createElement('div');
  bar.className = 'reply-suggestions';
  suggestions.forEach(text => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'reply-suggestion';
    btn.textContent = text;
    btn.addEventListener('click', () => sendSuggestedReply(text, bar));
    bar.appendChild(btn);
  });
  div.appendChild(bar);
}

// Un toque = mandado directo (no rellena el composer) — mismo camino que un
// submit normal, respetando la cola si justo hay otro turno en curso.
async function sendSuggestedReply(text, bar) {
  if (!currentConv) return;
  const convId = currentConv;
  bar.remove();
  if (busy) {
    queueMessage(convId, text, []);
    renderQueuedBar();
    updateComposerLock();
    return;
  }
  await performSend(convId, text, []);
}

// ── Status ──
function setStatus(text) {
  $('conv-status').textContent = text;
}

// ── Cola de un mensaje adicional ──
// Con el turno en curso el composer ya NO se bloquea entero: podés escribir
// (y adjuntar) un mensaje más, que queda "en cola" —tope de uno por
// conversación— y se dispara solo apenas termina el turno actual. Si ese
// turno lo cancelaste vos, o si terminó en error, el mensaje en cola se
// descarta sin perderlo: vuelve al cuadro de texto para que decidas.
const queuedMessages = new Map(); // convId -> { text, attachments }
let busy = false;

function queueMessage(convId, text, attachments) {
  queuedMessages.set(convId, { text, attachments });
}

function dequeueMessage(convId) {
  const q = queuedMessages.get(convId);
  queuedMessages.delete(convId);
  return q;
}

function renderQueuedBar() {
  const bar = $('queued-bar');
  const q = currentConv && queuedMessages.get(currentConv);
  bar.innerHTML = '';
  bar.hidden = !q;
  if (!q) return;
  const label = document.createElement('span');
  label.className = 'queued-bar-text';
  const preview = q.text ? (q.text.length > 90 ? q.text.slice(0, 90) + '…' : q.text) : '';
  const attCount = q.attachments.length;
  label.textContent = '⏳ En cola: ' + (preview || `${attCount} adjunto${attCount === 1 ? '' : 's'}`);
  label.title = q.text || '';
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'queued-bar-remove';
  removeBtn.setAttribute('aria-label', 'Sacar mensaje de la cola');
  removeBtn.textContent = '✕';
  removeBtn.onclick = () => {
    const removed = dequeueMessage(currentConv);
    renderQueuedBar();
    updateComposerLock();
    if (removed) restoreComposer(removed.text, removed.attachments);
  };
  bar.appendChild(label);
  bar.appendChild(removeBtn);
}

function updateComposerLock() {
  // Solo se bloquea si no hay conversación abierta, o si ya hay un mensaje
  // en cola (tope de uno) — con el turno corriendo pero la cola vacía, se
  // puede seguir escribiendo/adjuntando normalmente.
  const locked = !currentConv || (busy && queuedMessages.has(currentConv));
  $('input').disabled = locked;
  $('send').disabled = locked;
  $('attach-btn').disabled = locked;
  $('mic-btn').disabled = locked;
  $('cancel-btn').hidden = !busy || !currentConv;
}

function setBusy(b) {
  busy = b;
  updateComposerLock();
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
        // queda tapado al instante por el reload. El disparo del mensaje en
        // cola también espera a este reload, por la misma razón: si lo
        // mandáramos antes, la burbuja optimista que agrega quedaría tapada
        // (o directamente borrada) apenas termine de recargar.
        loadMessages(convId).then(() => {
          if (payload.code !== 0 && payload.stderr) addMsg('error', 'Error: ' + payload.stderr);
          // Turno terminado: si estás leyendo más arriba, el botón pasa a verde.
          flagJumpBtn('done');
          if (convId !== currentConv) return; // te fuiste a otra conversación mientras recargaba
          // Mensaje en cola esperando este turno: se dispara solo, salvo que
          // el turno anterior lo hayas cancelado o haya terminado en error
          // — ahí se descarta el envío pero se devuelve al composer, no se pierde.
          const queued = dequeueMessage(convId);
          if (queued) {
            renderQueuedBar();
            if (payload.cancelled) {
              restoreComposer(queued.text, queued.attachments);
              toast('Cancelaste el turno — también se descartó el mensaje en cola', 'info', 5000);
            } else if (payload.code !== 0) {
              restoreComposer(queued.text, queued.attachments);
              toast('El turno anterior terminó con error — no se mandó el mensaje en cola', 'info', 5000);
            } else {
              performSend(convId, queued.text, queued.attachments);
            }
          }
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
  exitMultiSelectMode(); // los elementos marcados quedan del chat anterior, no tiene sentido arrastrarlos
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
  renderQueuedBar();
  // Si esta conversación tenía un mensaje en cola y el turno terminó mientras
  // no la mirabas, el reconnect de abajo (dentro de openChat→openStream) solo
  // avisa si SIGUE ocupada — si ya terminó, el server no manda ningún evento
  // y la cola quedaría "colgada" sin que nadie la dispare nunca. A los 1.5s
  // sin señal de que está ocupada, asumimos que ya terminó y devolvemos el
  // mensaje al composer en vez de dejarlo esperando para siempre.
  if (queuedMessages.has(convId)) {
    setTimeout(() => {
      if (currentConv !== convId || busy) return;
      const queued = dequeueMessage(convId);
      if (queued) {
        restoreComposer(queued.text, queued.attachments);
        renderQueuedBar();
        toast('Ese turno ya había terminado mientras no mirabas — te devolvimos el mensaje en cola al cuadro de texto', 'info', 6000);
      }
    }, 1500);
  }
  showNotebookView(false);
  openChat();
  // Al abrir otra conversación no heredamos la posición de scroll de la
  // anterior: arrancamos mostrando el PRINCIPIO del último mensaje (no el
  // fondo del todo), para poder leerlo desde el principio. `stickToBottom`
  // sigue en true aparte, para que si la conversación sigue en curso
  // (streaming) el auto-scroll normal continúe pegado al fondo como siempre.
  stickToBottom = true;
  pendingScrollToLastStart = true;
  syncJumpBtn();
  // Abrir la conversación cuenta como "leída" — se lanza en paralelo con
  // loadMessages y se espera antes de refrescar el árbol, así el punto de no
  // leído no queda pegado un instante de más por una carrera con loadTree().
  const markReadPromise = api(`/conversations/${convId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withAccountBody({ unread: false })),
  }).catch(() => {});
  await loadMessages(convId);
  await markReadPromise;
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

  const topBar = document.createElement('div');
  topBar.className = 'msg-toolbar-top';
  topBar.appendChild(makeCopyMsgBtn(text || ''));
  topBar.appendChild(makeTtsBtn(text || '', 'user'));
  div.appendChild(topBar);

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

  const date = dateLabel();
  const dateEl = document.createElement('span');
  dateEl.className = 'msg-date ' + date.cls;
  dateEl.textContent = date.text;
  const time = document.createElement('span');
  time.className = 'msg-time';
  time.textContent = now();
  const bottomIcons = document.createElement('span');
  bottomIcons.className = 'msg-bottom-icons';
  bottomIcons.appendChild(makeCopyMsgBtn(text || ''));
  bottomIcons.appendChild(makeTtsBtn(text || '', 'user'));
  const bottomBar = document.createElement('div');
  bottomBar.className = 'msg-bottom-bar';
  bottomBar.appendChild(bottomIcons);
  bottomBar.appendChild(dateEl);
  bottomBar.appendChild(time);
  div.appendChild(bottomBar);
  // Burbuja optimista: todavía no tiene uuid en el jsonl (aparece recién al
  // recargar en el idle), así que el menú ofrece copiar/citar pero no rebobinar.
  if (text) attachMsgGestures(div, { role: 'user', text, uuid: null, compacted: false });

  messagesEl.appendChild(div);
  // Mensaje propio: siempre bajamos y volvemos a "pegarnos" al fondo.
  stickToBottom = true;
  syncJumpBtn();
  scrollToBottom();
  updateLastUserPin();
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

// Arma el texto final (con los prefijos [Archivo adjunto: ...]), muestra la
// burbuja optimista y postea al server. Lo usan tanto un submit normal como
// el disparo automático de un mensaje que estaba en cola.
async function performSend(convId, rawText, attachments) {
  let text = rawText;
  if (attachments.length > 0) {
    const paths = attachments.map(a => `[Archivo adjunto: ${a.path}]`).join('\n');
    text = paths + (rawText ? '\n\n' + rawText : '');
  }
  const bubble = addUserMsgWithFiles(rawText, attachments);
  setBusy(true);
  try {
    await sendMessage(convId, text);
  } catch (err) {
    setBusy(false);
    if (err.isNetwork) {
      // No se envió: sacamos la burbuja optimista y devolvemos todo al composer.
      if (bubble) bubble.remove();
      updateLastUserPin();
      restoreComposer(rawText, attachments);
      addMsg('error', err.message + ' — tocá enviar de nuevo');
    } else {
      addMsg('error', err.message);
    }
  }
}

$('composer').onsubmit = async e => {
  e.preventDefault();
  const rawText = $('input').value.trim();
  if ((!rawText && pendingAttachments.length === 0) || !currentConv) return;

  const convId = currentConv;
  const attachments = [...pendingAttachments];
  $('input').value = '';
  autoResize($('input'));
  drafts.delete(convId);
  clearAttachments();

  if (busy) {
    // Ya hay un turno corriendo: no pega al server, lo deja en cola (tope 1)
    // y se dispara solo cuando ese turno termine (ver el handler de 'idle').
    queueMessage(convId, rawText, attachments);
    renderQueuedBar();
    updateComposerLock();
    return;
  }
  await performSend(convId, rawText, attachments);
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

// ── Nueva conversación / nueva libreta ──
// Ya no se elige carpeta acá (ni local ni VPS) — cada cuenta siempre arranca
// en su carpeta configurada del lado del server (accountHomeDir o
// CCM_DEFAULT_PROJECT_DIR si está seteado). Tampoco se elige modelo (queda el
// default) — el botón crea y entra directo, sin modal de por medio.
// En el pane de Notas este mismo botón crea una libreta nueva en vez de una
// conversación — ya no hay un "+" propio ahí (ver notebookElement/goToPane).
$('new-conv').onclick = async () => {
  const btn = $('new-conv');
  btn.disabled = true;
  try {
    if (activePane === 2) {
      // No crea la libreta acá — abre un borrador que recién se persiste en
      // ensureNotebookCreated() al mandar la primera nota (ver comentario ahí).
      openNotebookDraft();
      return;
    }
    const { convId, projectDir } = await api('/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(withAccountBody({})),
    });
    await selectConv(convId, 'Nueva conversación', undefined, null, projectDir);
    // Crear conversación es una acción explícita (no un tap en la lista),
    // así que acá sí autofocuseamos el campo aunque estemos en mobile.
    $('input').focus();
  } catch (err) {
    toast('No se pudo crear: ' + err.message);
  } finally {
    btn.disabled = false;
  }
};

// ── Búsqueda global: ver search.js ──

// Atajo Tab (saltar entre las 2 conversaciones de arriba) — se queda acá,
// vivía pegado a la búsqueda en el archivo viejo pero no tiene nada que ver.
document.addEventListener('keydown', e => {
  if (e.key !== 'Tab') return;
  if (document.querySelector('dialog[open]')) return;
  if (!currentConv) return;
  const top2 = [...document.querySelectorAll('#tree .conv')]
    .filter(el => !el._conv.pinned)
    .slice(0, 2);
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

const PANE_COUNT = 5; // Chats/Archivado/Notas/Escáner/Codex

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

// Aviso pendiente de un reinicio anterior (ej. "se saltó git pull porque
// había cambios sin commitear") — el server lo guarda una sola vez y lo
// borra al leerlo, así que esto no vuelve a mostrar nada en el próximo
// refresh. No abre conversación, solo un toast.
(async function checkRestartNotice() {
  try {
    const r = await fetch('/api/restart-notice');
    const data = await r.json();
    if (data && data.text) toast(data.text, data.kind || 'info', 10000);
  } catch { /* silencioso: no es crítico perderse este aviso */ }
})();
loadUsage();
setInterval(loadUsage, 10 * 60 * 1000);

// ── Configuración ──
const SETTINGS_KEY = 'ccm.settings';
const DEFAULT_SETTINGS = {
  showTools: true,
  voice: '', // una sola voz para mensajes propios y del agente (antes voiceAssistant/voiceUser separados)
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

// El <select> de tipografía queda oculto (ver index.html) — un <option> con
// font-family inline no se renderiza en la mayoría de los pickers nativos
// mobile (Android ignora el CSS del option), así que la vista previa real
// vive en este botón + el menú de showFontMenu(), no en el <select> nativo.
// El <select> se sigue usando como fuente de verdad del valor (dispara
// "change" como siempre) para no tocar el resto de applySettings/saveSettings.
function updateFontTrigger() {
  const val = $('cfg-font-family').value;
  const opt = FONT_FAMILY_OPTIONS.find(f => f.value === val) || FONT_FAMILY_OPTIONS[0];
  const btn = $('cfg-font-family-btn');
  btn.textContent = opt.label;
  btn.style.fontFamily = opt.stack;
}
function showFontMenu() {
  document.querySelectorAll('.ctx-menu.font-menu').forEach(m => m.remove());
  const trigger = $('cfg-font-family-btn');
  const current = $('cfg-font-family').value;
  const menu = document.createElement('div');
  menu.className = 'ctx-menu font-menu';
  menu.innerHTML = FONT_FAMILY_OPTIONS.map(f => `
    <button type="button" data-value="${f.value}" class="${f.value === current ? 'active' : ''}" style="font-family:${f.stack.replace(/"/g, '&quot;')}">${f.label}</button>
  `).join('');
  // Colgado del propio <dialog>, no de document.body: un <dialog> abierto
  // con showModal() pinta en el "top layer" del navegador, por encima de
  // TODO el resto del documento sin importar z-index — un menú colgado de
  // document.body quedaría tapado detrás del modal. Adentro del dialog sí
  // se ve, y position:fixed lo saca igual del scroll del body.
  $('settings-dialog').appendChild(menu);
  const rect = trigger.getBoundingClientRect();
  menu.style.width = rect.width + 'px';
  const menuRect = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - menuRect.width - 8)) + 'px';
  menu.style.top = Math.min(rect.bottom + 4, window.innerHeight - menuRect.height - 8) + 'px';

  menu.addEventListener('click', e => {
    e.stopPropagation();
    const btn = e.target.closest('button[data-value]');
    if (!btn) return;
    const sel = $('cfg-font-family');
    sel.value = btn.dataset.value;
    sel.dispatchEvent(new Event('change'));
    updateFontTrigger();
    menu.remove();
  });
  menu.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });

  function dismiss(e) {
    if (menu.contains(e.target)) return;
    menu.remove();
    document.removeEventListener('click', dismiss, true);
    document.removeEventListener('touchstart', dismiss, true);
  }
  // Delay para saltear el click sintético del touchend que abrió el menú.
  setTimeout(() => {
    document.addEventListener('click', dismiss, true);
    document.addEventListener('touchstart', dismiss, true);
  }, 350);
}
$('cfg-font-family-btn').onclick = showFontMenu;

const settings = { ...DEFAULT_SETTINGS, ...loadSettings() };
// Migración desde los ajustes viejos voiceAssistant/voiceUser (separados) al
// nuevo settings.voice (único) — se sacaba de DEFAULT_SETTINGS, pero puede
// seguir viviendo en el localStorage de quien ya tenía configuración guardada.
if (!settings.voice && (settings.voiceAssistant || settings.voiceUser)) {
  settings.voice = settings.voiceAssistant || settings.voiceUser;
}
delete settings.voiceAssistant;
delete settings.voiceUser;

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
  const sel = $('cfg-voice');
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

// Puntito + nombre del header de Configuración, coloreado en vivo con lo
// que se está eligiendo/escribiendo — el guardado real de Nombre/Color de
// identidad es server-side (ver los .onchange de abajo) y pide reiniciar el
// server para verse de verdad en el ícono/tema, así que esto es solo una
// vista previa a ojo mientras se elige, no reemplaza esa aplicación real.
function updateNamePreview() {
  const name = $('cfg-app-name').value.trim() || APP_NAME;
  const color = $('cfg-app-color').value || APP_COLOR;
  $('cfg-name-preview-dot').style.background = color;
  $('cfg-name-preview-text').textContent = name;
}

function openSettings() {
  $('cfg-app-name').value = APP_NAME;
  $('cfg-user-name').value = USER_NAME;
  $('cfg-app-color').value = APP_COLOR;
  updateNamePreview();
  $('cfg-show-tools').checked = settings.showTools;
  $('cfg-voice').value = settings.voice;
  $('cfg-color-accent').value = settings.colorAccent || readComputedColor('--accent');
  $('cfg-color-me').value = settings.colorMe || readComputedColor('--bubble-me');
  $('cfg-color-ai').value = settings.colorAi || readComputedColor('--bubble-ai');
  $('cfg-font-family').value = settings.fontFamily;
  updateFontTrigger();
  $('cfg-font-size').value = settings.fontSize;
  // La key en sí nunca vuelve del server (solo el booleano groqApiKeySet) —
  // el campo arranca siempre vacío para no exponerla ni pisarla por
  // accidente, y updateGroqKeyStatus() avisa si ya hay una guardada.
  $('cfg-groq-key').value = '';
  updateGroqKeyStatus();
  $('settings-dialog').showModal();
}

// Placeholder + badge "✓ Configurada" junto al label — dos señales para lo
// mismo porque el placeholder solo (gris, desaparece al enfocar el campo)
// no alcanzaba para que se notara a simple vista si ya había una key.
function updateGroqKeyStatus() {
  $('cfg-groq-key').placeholder = GROQ_KEY_SET ? '•••••••• (guardada)' : 'gsk_...';
  $('cfg-groq-key-status').hidden = !GROQ_KEY_SET;
}

$('settings-btn').onclick = openSettings;
$('cfg-app-name').addEventListener('input', updateNamePreview);
$('cfg-app-color').addEventListener('input', updateNamePreview);
// Cerrar tocando afuera (el backdrop): un click que cae en el propio
// <dialog> (no en un descendiente) solo puede venir del backdrop, porque
// #settings-form ocupa 100% de la caja del dialog — no queda "aire" propio
// del dialog para clickear. En mobile el dialog es pantalla completa (no
// hay backdrop visible), así que ahí este listener simplemente nunca dispara.
$('settings-dialog').addEventListener('click', e => {
  if (e.target === e.currentTarget) $('settings-dialog').close();
});

// Nombre: no es localStorage como el resto de esta pantalla — vive en el
// server (~/.ccm-config.json), así que el título/manifest de la PWA sale
// igual para cualquier dispositivo que entre a esta misma instancia. Guarda
// al perder foco (blur/Enter), mismo patrón que el rename de conversación.
$('cfg-app-name').onchange = async e => {
  const name = e.target.value.trim();
  try {
    const { appName } = await api('/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appName: name }),
    });
    APP_NAME = appName;
    e.target.value = appName;
    updateGlobalBusyIndicator();
    toast('Nombre guardado — recargá para verlo en el título de la pestaña y reinstalá la PWA para el ícono/nombre de app instalada', 'info', 5000);
  } catch (err) {
    toast('No se pudo guardar el nombre: ' + err.message);
  }
};

// Tu nombre: mismo patrón que cfg-app-name (server-side, guarda al perder
// foco). Se usa como etiqueta de tus mensajes en "Copiar conversación".
$('cfg-user-name').onchange = async e => {
  const name = e.target.value.trim();
  try {
    const { userName } = await api('/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: name }),
    });
    USER_NAME = userName;
    e.target.value = userName;
    toast('Nombre guardado', 'info', 2000);
  } catch (err) {
    toast('No se pudo guardar tu nombre: ' + err.message);
  }
};

// API key de Groq (respuestas sugeridas): mismo patrón server-side que los
// dos de arriba. Vacío = apaga la feature (config.js borra el campo). No
// hace falta reiniciar el server — se lee del archivo en cada request.
$('cfg-groq-key').onchange = async e => {
  const key = e.target.value.trim();
  try {
    const { groqApiKeySet } = await api('/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groqApiKey: key }),
    });
    GROQ_KEY_SET = !!groqApiKeySet;
    e.target.value = '';
    updateGroqKeyStatus();
    toast(GROQ_KEY_SET ? 'Key guardada' : 'Key borrada — respuestas sugeridas apagadas', 'info', 2500);
  } catch (err) {
    toast('No se pudo guardar la key de Groq: ' + err.message);
  }
};

// Color de identidad: mismo patrón server-side que el nombre de arriba (no
// localStorage, vive en ~/.ccm-config.json) — a diferencia del "Acento" de
// más abajo, que es un ajuste personal por dispositivo. Este además
// regenera los íconos de la PWA en el server (ver /api/config en server.js).
$('cfg-app-color').onchange = async e => {
  const color = e.target.value;
  try {
    const { appColor, iconOk } = await api('/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appColor: color }),
    });
    APP_COLOR = appColor;
    e.target.value = appColor;
    if (iconOk) {
      toast('Color guardado — recargá para verlo en la interfaz y reinstalá la PWA para el ícono', 'info', 5000);
    } else {
      // ImageMagick no encontrado en el PATH de esta cuenta de Windows (u
      // otro fallo al regenerar el PNG) — el color de la interfaz sí quedó
      // guardado, pero el ícono de la PWA se va a seguir viendo con el
      // verde default hasta que se resuelva del lado del server.
      toast('Color guardado, pero no se pudo generar el ícono nuevo (¿ImageMagick instalado en esta cuenta?) — la interfaz sí cambia', 'error', 8000);
    }
  } catch (err) {
    toast('No se pudo guardar el color: ' + err.message);
  }
};

$('cfg-show-tools').onchange = e => {
  settings.showTools = e.target.checked;
  applySettings(); saveSettings();
};
// Una sola voz para mensajes propios y del agente. Elegirla reproduce sola
// una muestra corta (previewVoice, tts.js) — no hace falta un botón aparte.
$('cfg-voice').onchange = e => {
  settings.voice = e.target.value; saveSettings();
  previewVoice(e.target);
};
$('cfg-color-accent').oninput = e => { settings.colorAccent = e.target.value; applySettings(); saveSettings(); };
$('cfg-color-me').oninput = e => { settings.colorMe = e.target.value; applySettings(); saveSettings(); };
$('cfg-color-ai').oninput = e => { settings.colorAi = e.target.value; applySettings(); saveSettings(); };
$('cfg-font-family').onchange = e => { settings.fontFamily = e.target.value; applySettings(); saveSettings(); };
$('cfg-font-size').onchange = e => { settings.fontSize = e.target.value; applySettings(); saveSettings(); };

// Reinicio del server (toma código nuevo tras un git pull) — ver /api/restart
// en server.js. netFetch/api normal no sirve acá: el server responde igual,
// pero se muere unos milisegundos después de mandar la respuesta, así que la
// conexión puede leerse como error de red aunque el restart haya salido bien
// — por eso el catch de abajo no muestra error, solo el then es best-effort.
$('cfg-restart-btn').onclick = async () => {
  if (!confirm('Reiniciar el server?\n\nHace git pull y reinicia con el código nuevo. Si el pull no se puede (cambios sin commitear o falla), reinicia igual con el código actual y te deja una conversación nueva contándote qué pasó. Se corta la conexión unos segundos y después hay que recargar la página a mano.')) return;
  toast('Reiniciando server…', 'info', 6000);
  try {
    await fetch('/api/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  } catch {
    // Esperado: el server puede cerrar la conexión antes de que el fetch
    // termine de leer la respuesta. No es un error real, ver comentario arriba.
  }
};

$('cfg-reset').onclick = () => {
  // Confirm agregado al pasar el botón a ícono (perdió el texto "Restaurar"
  // que antes avisaba qué hacía) — pierde voz, colores, tipografía, todo.
  if (!confirm('Restaurar la configuración a los valores por defecto?\n\nSe pierden la voz, los colores, la tipografía y el tamaño de letra elegidos.')) return;
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
  // notebook-view oculto = ni libreta real ni borrador abiertos (estamos en
  // la lista) — nada que guardar acá.
  if ($('notebook-view').hidden) return;
  const input = $('notes-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  autoResize(input);
  try {
    // Con un borrador (currentNotebook todavía null) esto crea la libreta
    // recién ahora, con esta nota como la primera — ver ensureNotebookCreated().
    const notebookId = await ensureNotebookCreated();
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
  // notebook-view oculto = ni libreta real ni borrador abiertos.
  if ($('notebook-view').hidden) return;
  const displayName = file.name || `pegado-${Date.now()}.${(file.type.split('/')[1] || 'bin')}`;
  const loadingChip = document.createElement('div');
  loadingChip.className = 'attach-chip attach-chip-loading';
  loadingChip.innerHTML = `<span class="attach-spinner"></span><span class="attach-chip-name"></span>`;
  loadingChip.querySelector('.attach-chip-name').textContent = displayName;
  $('notes-attachments').appendChild(loadingChip);

  const t0 = Date.now();
  let sentBytes = 0;
  try {
    // Con un borrador, adjuntar un archivo también cuenta como contenido
    // real — crea la libreta acá si todavía no existe (ver ensureNotebookCreated).
    const notebookId = await ensureNotebookCreated();
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

// ── Escáner de documentos: ver doc-scanner.js ──

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
