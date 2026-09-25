// ── Sala (lista, mensajes, streaming, menciones y presencia) ──
// Extraído de app.js (split por dominio, sesión 15/09/2026).
// Script clásico (no ES module): comparte el scope global con el resto de los scripts.

let roomListLoaded = false;
let rooms = [];
let currentRoom = null; // {id, name} de la sala abierta, o null si estamos en la lista
let roomMessages = [];
// Refleja si la última llamada a /api/sala/* funcionó — controla el banner
// "sin conexión con la sala" y si se puede mandar un mensaje. Arranca en
// true (optimista) para no mostrar el banner antes de la primera carga.
let salaOnline = true;
let salaIdentities = null;
let salaBusy = false;
let salaEventSource = null;
let salaStreamConvId = null; // convId al que está suscripto ahora mismo, o null

// ── Sala: lista de salas ──
function roomElement(room) {
  // room.busy = ESTA instancia está generando un turno para esa sala ahora
  // mismo (server.js, GET /api/sala/rooms) — mismo ping-dot que ya usa la
  // lista de Chats (badge()), así se ve desde la lista sin tener que abrir
  // la sala. No hay forma de saber si el OTRO agente (del otro lado) está
  // procesando, eso vive en su propia PC.
  // Mismo criterio que convElement(): el badge de "procesando" tiene
  // prioridad visual sobre el punto de "no leído" (mientras corre, "no
  // leído" todavía no aplica).
  const b = badge(room.busy ? 'running' : null) || (room.unread ? '<span class="unread-dot" title="Sin leer"></span>' : '');
  const div = document.createElement('div');
  div.className = 'conv notebook-row';
  div.innerHTML = `
    <div class="conv-avatar">${avatarChar(room.name)}</div>
    <div class="conv-body">
      <div class="name"><span class="conv-name-text"></span></div>
      <div class="sub"><span class="conv-date"></span></div>
    </div>
    ${b}
  `;
  div.querySelector('.conv-name-text').textContent = room.name;
  div.querySelector('.conv-date').textContent = room.lastActivity
    ? new Date(room.lastActivity).toLocaleString('es', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : 'Sin mensajes todavía';
  div.onclick = () => openRoom(room.id, room.name);
  attachRoomGestures(div, room);
  return div;
}

// Click derecho / long-press en una fila de sala → 🙈 Ocultar. Mismo patrón
// que attachNotebookGestures/showNotebookMenu (sin arrastre horizontal, la
// sala no se archiva). "Ocultar" es una preferencia LOCAL de esta instancia
// (ver comentario en server.js, GET /api/sala/rooms) — no borra ni afecta la
// sala compartida del VPS, ni lo que ve Fernando/FerStark del otro lado.
function attachRoomGestures(el, room) {
  let touchTimer = null;
  let longPressed = false;
  let startX = 0, startY = 0;

  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    showRoomMenu(e.clientX, e.clientY, room);
  });

  el.addEventListener('touchstart', e => {
    longPressed = false;
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
    touchTimer = setTimeout(() => {
      longPressed = true;
      touchTimer = null;
      showRoomMenu(startX, startY, room);
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

  el.addEventListener('click', e => {
    if (longPressed) {
      longPressed = false;
      e.stopPropagation();
      e.preventDefault();
    }
  }, { capture: true });
}

function showRoomMenu(x, y, room) {
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
      await api(`/sala/rooms/${room.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: true }),
      });
      rooms = rooms.filter(r => r.id !== room.id);
      renderRoomList();
      if (currentRoom && currentRoom.id === room.id) closeChat();
      toast('Sala ocultada', 'info', 2500);
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

function renderRoomList() {
  const nav = $('room-list');
  nav.innerHTML = '';
  if (rooms.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'notes-empty';
    empty.textContent = 'No hay salas todavía — creá una con el botón + de arriba.';
    nav.appendChild(empty);
    return;
  }
  for (const room of rooms) nav.appendChild(roomElement(room));
}

async function loadRoomList() {
  const { rooms: list } = await api('/sala/rooms');
  rooms = list;
  renderRoomList();
  // Prende/apaga la pestaña "Sala" en la barra de arriba (mismo mecanismo
  // que Chats/Codex, ver setPaneUnread) — se llama tanto desde acá (sala
  // abierta) como desde el poll liviano global (pollTrees), así se entera
  // aunque nunca hayas entrado a la pestaña.
  setPaneUnread('5', list.some(r => r.unread));
}

async function safeLoadRoomList() {
  try { await loadRoomList(); }
  catch { /* noop: polling de fondo, se autocura en el próximo tick */ }
}

// Identidades configuradas en el servicio (Jarvis/FerStark) — no depende de
// que nadie haya hablado en ninguna sala todavía, a diferencia de
// salaMentionCandidates() (que arma sugerencias del historial). Se pide una
// sola vez por sesión: no cambia salvo que alguien reconfigure tokens en el
// VPS, no tiene sentido pollearlo cada 5s como la lista de salas.
async function ensureSalaIdentities() {
  if (salaIdentities) return salaIdentities;
  try {
    const { identities } = await api('/sala/identities');
    salaIdentities = identities;
  } catch { salaIdentities = []; } // sala no configurada, o el VPS no respondió — el autocompletar sigue andando con lo que haya en el historial
  return salaIdentities;
}

// ── Sala: abrir/cerrar una sala, reusando el panel/overlay del chat ──
function showSalaView(show) {
  $('chat-header').hidden = show;
  $('messages-wrap').hidden = show;
  $('composer-attachments').hidden = show;
  $('composer').hidden = show;
  $('sala-view').hidden = !show;
  if (!show) closeSalaStream(); // se cierra el stream en vivo (ver más abajo) — no tiene sentido seguir suscripto a una sala que no se está mirando
}

function updateSalaComposerLock() {
  $('sala-send').disabled = !salaOnline || salaBusy;
}

function setSalaOnline(online) {
  salaOnline = online;
  $('sala-offline-banner').hidden = online;
  updateSalaComposerLock();
}

const ROOM_AUTHOR_COLORS = ['#f2b134', '#4dabf7', '#f472b6', '#a78bfa'];
function assignAuthorColors(messages) {
  const map = new Map();
  for (const m of messages) {
    const match = m.text.match(/^([^:\n]{1,40}): /);
    const author = match ? match[1] : m.author;
    if (!map.has(author)) map.set(author, ROOM_AUTHOR_COLORS[map.size % ROOM_AUTHOR_COLORS.length]);
  }
  return map;
}

function roomMessageBubble(m) {
  const match = m.text.match(/^([^:\n]{1,40}): ([\s\S]*)$/);
  const author = match ? match[1] : m.author;
  const text = match ? match[2] : m.text;
  // `author` identifica la instancia (Jarvis/FerStark), no necesariamente a
  // la persona. El servicio ya marca quién habló realmente con kind: un
  // agente local puede llamarse Jarvis pero su burbuja nunca debe aparecer
  // como mensaje del usuario.
  const mine = m.kind === 'human'
    ? true
    : m.kind === 'agent'
      ? false
      // Compatibilidad con mensajes viejos, previos al campo kind: el nombre
      // de la instancia propia es un agente; USER_NAME sí es el humano local.
      : author === USER_NAME;
  return { author, text, role: mine ? 'user' : 'assistant' };
}

function renderRoomMessages() {
  const wrap = $('sala-messages');
  const STICK_THRESHOLD = 48;
  const wasStuck = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < STICK_THRESHOLD;
  const prevTop = wrap.scrollTop;
  wrap.innerHTML = '';
  if (roomMessages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'notes-empty';
    empty.textContent = 'Sin mensajes todavía — escribí algo para arrancar.';
    wrap.appendChild(empty);
    return;
  }
  const colors = assignAuthorColors(roomMessages);
  for (const m of roomMessages) {
    const { author, text, role } = roomMessageBubble(m);
    addMsg(role, text, { container: wrap, composerId: 'sala-input', author, authorColor: colors.get(author), ts: m.ts });
  }
  wrap.scrollTop = wasStuck ? wrap.scrollHeight : prevTop;
}

function setSalaBusy(busy) {
  salaBusy = busy;
  const el = $('sala-busy');
  el.innerHTML = busy ? badge('running') : '';
  el.hidden = !busy;
  $('sala-cancel-btn').hidden = !busy;
  updateSalaComposerLock();
}

async function loadRoomMessages() {
  const { messages, busy, convId } = await api(`/sala/rooms/${currentRoom.id}/messages`);
  roomMessages = messages;
  renderRoomMessages();
  setSalaBusy(busy);
  if (currentRoom) currentRoom.convId = convId;
  if (convId) openSalaStream(convId);
}

async function safeLoadRoomMessages() {
  if (!currentRoom) return;
  try { await loadRoomMessages(); setSalaOnline(true); }
  catch { setSalaOnline(false); }
}

async function openRoom(id, name) {
  currentRoom = { id, name, convId: null };
  $('sala-title').textContent = name;
  roomMessages = [];
  renderRoomMessages();
  setSalaBusy(false);
  closeSalaStream();
  closeSalaMentionMenu();
  if (typeof showNotebookView === 'function') showNotebookView(false);
  showSalaView(true);
  openChat();
  const roomRef = rooms.find(r => r.id === id);
  if (roomRef && roomRef.unread) {
    roomRef.unread = false;
    setPaneUnread('5', rooms.some(r => r.unread));
  }
  api(`/sala/rooms/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unread: false }),
  }).catch(() => {});
  try { await loadRoomMessages(); setSalaOnline(true); }
  catch (err) { setSalaOnline(false); toast('No se pudieron cargar los mensajes de la sala: ' + err.message); }
}

function closeSalaStream() {
  if (salaEventSource) { salaEventSource.close(); salaEventSource = null; }
  salaStreamConvId = null;
}

function openSalaStream(convId) {
  if (salaStreamConvId === convId) return;
  closeSalaStream();
  salaStreamConvId = convId;
  const roomId = currentRoom ? currentRoom.id : null;
  salaEventSource = new EventSource(`/api/conversations/${convId}/stream`);
  salaEventSource.onmessage = e => {
    if (!currentRoom || currentRoom.id !== roomId || salaStreamConvId !== convId) return;
    const payload = JSON.parse(e.data);
    if (payload.kind === 'claude') {
      const ev = payload.event;
      if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
        const wrap = $('sala-messages');
        for (const b of ev.message.content) {
          if (b.type === 'text' && b.text.trim()) {
            addMsg('assistant', b.text, {
              container: wrap,
              composerId: 'sala-input',
              author: APP_NAME,
              authorColor: ROOM_AUTHOR_COLORS[0],
            });
          }
          else if (b.type === 'tool_use') addTool(b.name, b.input, '', { container: wrap });
        }
      }
    } else if (payload.kind === 'status') {
      setSalaBusy(payload.status !== 'idle');
      if (payload.status === 'idle') loadRoomMessages().catch(() => {});
    }
  };
  salaEventSource.onerror = () => {
    if (!currentRoom || currentRoom.id !== roomId) return;
    setTimeout(() => { if (currentRoom && currentRoom.id === roomId) loadRoomMessages().catch(() => {}); }, 1500);
  };
}

async function createSalaRoom() {
  const name = (prompt('Nombre de la sala:') || '').trim();
  if (!name) return;
  const room = await api('/sala/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  rooms.push(room);
  renderRoomList();
  await openRoom(room.id, room.name);
}

$('sala-cancel-btn').onclick = async () => {
  if (!currentRoom || !currentRoom.convId) return;
  try { await api(`/conversations/${currentRoom.convId}/message`, { method: 'DELETE' }); }
  catch (err) { toast('No se pudo cancelar: ' + err.message); }
};

async function sendRoomMessage() {
  if (!salaOnline) return;
  const input = $('sala-input');
  const text = input.value.trim();
  if (!text || !currentRoom) return;
  input.value = '';
  autoResize(input);
  closeSalaMentionMenu();
  try {
    await api(`/sala/rooms/${currentRoom.id}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    await loadRoomMessages();
  } catch (err) {
    toast('No se pudo mandar el mensaje: ' + err.message);
    input.value = text;
    autoResize(input);
  }
}

$('sala-back-btn').onclick = closeChat;

function salaMentionCandidates() {
  const seen = new Set();
  for (const name of (salaIdentities || [])) {
    if (name !== USER_NAME && name !== APP_NAME) seen.add(name);
  }
  for (const m of roomMessages) {
    const match = m.text.match(/^([^:\n]{1,40}): /);
    const author = match ? match[1] : m.author;
    if (author !== USER_NAME && author !== APP_NAME) seen.add(author);
  }
  return [...seen];
}

const salaMention = { active: false, start: -1, items: [], highlighted: 0 };

function closeSalaMentionMenu() {
  salaMention.active = false;
  $('sala-mention-menu').hidden = true;
  $('sala-mention-menu').innerHTML = '';
}

function renderSalaMentionMenu() {
  const menu = $('sala-mention-menu');
  menu.innerHTML = '';
  salaMention.items.forEach((name, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '@' + name;
    btn.className = i === salaMention.highlighted ? 'active' : '';
    btn.onclick = () => selectSalaMention(name);
    menu.appendChild(btn);
  });
  menu.hidden = salaMention.items.length === 0;
}

function updateSalaMentionMenu() {
  const input = $('sala-input');
  const upToCursor = input.value.slice(0, input.selectionStart);
  const match = upToCursor.match(/(?:^|\s)@(\w*)$/);
  if (!match) { closeSalaMentionMenu(); return; }
  const query = match[1].toLowerCase();
  const all = salaMentionCandidates();
  const items = query ? all.filter(n => n.toLowerCase().includes(query)) : all;
  salaMention.active = items.length > 0;
  salaMention.start = upToCursor.length - match[1].length - 1;
  salaMention.items = items;
  salaMention.highlighted = 0;
  if (!salaMention.active) { closeSalaMentionMenu(); return; }
  renderSalaMentionMenu();
}

function selectSalaMention(name) {
  const input = $('sala-input');
  const before = input.value.slice(0, salaMention.start);
  const after = input.value.slice(input.selectionStart);
  input.value = `${before}@${name} ${after}`;
  const caret = before.length + name.length + 2;
  input.focus();
  input.selectionStart = input.selectionEnd = caret;
  autoResize(input);
  closeSalaMentionMenu();
}

$('sala-input').addEventListener('input', () => {
  autoResize($('sala-input'));
  updateSalaMentionMenu();
});

$('sala-input').addEventListener('keydown', e => {
  if (salaMention.active) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      salaMention.highlighted = (salaMention.highlighted + 1) % salaMention.items.length;
      renderSalaMentionMenu();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      salaMention.highlighted = (salaMention.highlighted - 1 + salaMention.items.length) % salaMention.items.length;
      renderSalaMentionMenu();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      selectSalaMention(salaMention.items[salaMention.highlighted]);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSalaMentionMenu();
      return;
    }
  }
  if (isTouchDevice) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('sala-composer').requestSubmit();
  }
});

$('sala-composer').addEventListener('submit', e => {
  e.preventDefault();
  if ($('sala-view').hidden) return;
  sendRoomMessage();
});

function pollSalaPane() {
  if (activePane !== 5) return;
  safeLoadRoomList();
  safeLoadRoomMessages();
}

let salaPollTimer = setInterval(pollSalaPane, 5000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearInterval(salaPollTimer);
  } else {
    pollSalaPane();
    salaPollTimer = setInterval(pollSalaPane, 5000);
  }
});
