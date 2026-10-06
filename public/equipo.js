// ── Equipo FerStark (Fernando + Claude + Codex + AgY, todos en esta PC) ──
// Mismo patrón de panel/overlay que sala.js (ver ahí para el caso Jarvis↔
// FerStark, que sí necesita el VPS), pero más simple en dos puntos a
// propósito:
//  - Sin @menciones: acá responden los tres agentes solos, en cadena, según
//    la fase de la sala (rules/open) — ver routes/equipo.js.
//  - Sin streaming SSE en vivo: las tres respuestas de una ronda se arman en
//    el server una atrás de la otra: se muestran por polling cuando cada una
//    termina, no hay texto token-por-token que mostrar mientras tanto.
// Script clásico (no ES module): comparte el scope global con app.js/sala.js.

let equipoRoomListLoaded = false;
let equipoRooms = [];
let currentEquipoRoom = null; // {id, name} de la sala abierta, o null si estamos en la lista
let equipoMessages = [];
let equipoBusy = false;

const EQUIPO_AUTHOR_COLORS = { Claude: '#f2b134', Codex: '#10a37f', AgY: '#7c5cff' };

function equipoRoomElement(room) {
  const b = badge(room.busy ? 'running' : null);
  const div = document.createElement('div');
  div.className = 'conv notebook-row';
  div.innerHTML = `
    <div class="conv-avatar">${avatarChar(room.name)}</div>
    <div class="conv-body">
      <div class="name"><span class="conv-name-text"></span></div>
      <div class="sub"><span class="conv-date"></span></div>
    </div>
    ${b || ''}
  `;
  div.querySelector('.conv-name-text').textContent = room.name;
  div.querySelector('.conv-date').textContent = room.lastActivity
    ? new Date(room.lastActivity).toLocaleString('es', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : 'Sin mensajes todavía';
  div.onclick = () => openEquipoRoom(room.id, room.name);
  return div;
}

function renderEquipoRoomList() {
  const nav = $('equipo-room-list');
  nav.innerHTML = '';
  if (equipoRooms.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'notes-empty';
    empty.textContent = 'No hay salas de Equipo todavía — creá una con el botón + de arriba.';
    nav.appendChild(empty);
    return;
  }
  for (const room of equipoRooms) nav.appendChild(equipoRoomElement(room));
}

async function loadEquipoRoomList() {
  const { rooms } = await api('/equipo/rooms');
  equipoRooms = rooms;
  renderEquipoRoomList();
}

async function safeLoadEquipoRoomList() {
  try { await loadEquipoRoomList(); }
  catch { /* noop: polling de fondo, se autocura en el próximo tick */ }
}

function showEquipoView(show) {
  $('chat-header').hidden = show;
  $('messages-wrap').hidden = show;
  $('composer-attachments').hidden = show;
  $('composer').hidden = show;
  $('equipo-view').hidden = !show;
}

function updateEquipoComposerLock() {
  $('equipo-send').disabled = equipoBusy;
}

function setEquipoBusy(busy) {
  equipoBusy = busy;
  const el = $('equipo-busy');
  el.innerHTML = busy ? badge('running') : '';
  el.hidden = !busy;
  updateEquipoComposerLock();
}

function renderEquipoMessages() {
  const wrap = $('equipo-messages');
  const STICK_THRESHOLD = 48;
  const wasStuck = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < STICK_THRESHOLD;
  const prevTop = wrap.scrollTop;
  wrap.innerHTML = '';
  if (equipoMessages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'notes-empty';
    empty.textContent = 'Sin mensajes todavía — planteá el tema para arrancar.';
    wrap.appendChild(empty);
    return;
  }
  for (const m of equipoMessages) {
    const role = m.kind === 'human' ? 'user' : 'assistant';
    addMsg(role, m.text, {
      container: wrap, composerId: 'equipo-input', author: m.from,
      authorColor: EQUIPO_AUTHOR_COLORS[m.from], ts: m.ts,
    });
  }
  wrap.scrollTop = wasStuck ? wrap.scrollHeight : prevTop;
}

async function loadEquipoMessages() {
  const { messages, busy } = await api(`/equipo/rooms/${currentEquipoRoom.id}/messages`);
  equipoMessages = messages;
  renderEquipoMessages();
  setEquipoBusy(busy);
}

async function safeLoadEquipoMessages() {
  if (!currentEquipoRoom) return;
  try { await loadEquipoMessages(); }
  catch { /* noop: se reintenta en el próximo poll */ }
}

async function openEquipoRoom(id, name) {
  currentEquipoRoom = { id, name };
  $('equipo-title').textContent = name;
  equipoMessages = [];
  renderEquipoMessages();
  setEquipoBusy(false);
  if (typeof showNotebookView === 'function') showNotebookView(false);
  if (typeof showSalaView === 'function') showSalaView(false);
  showEquipoView(true);
  openChat();
  try { await loadEquipoMessages(); }
  catch (err) { toast('No se pudieron cargar los mensajes de la sala: ' + err.message); }
}

async function createEquipoRoom() {
  const name = (prompt('Nombre de la sala de Equipo (un tema nuevo):') || '').trim();
  if (!name) return;
  const room = await api('/equipo/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  equipoRooms.unshift(room);
  renderEquipoRoomList();
  await openEquipoRoom(room.id, room.name);
}

async function sendEquipoMessage() {
  const input = $('equipo-input');
  const text = input.value.trim();
  if (!text || !currentEquipoRoom || equipoBusy) return;
  input.value = '';
  autoResize(input);
  try {
    await api(`/equipo/rooms/${currentEquipoRoom.id}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    await loadEquipoMessages();
  } catch (err) {
    toast('No se pudo mandar el mensaje: ' + err.message);
    input.value = text;
    autoResize(input);
  }
}

$('equipo-back-btn').onclick = closeChat;

$('equipo-input').addEventListener('input', () => autoResize($('equipo-input')));
$('equipo-input').addEventListener('keydown', e => {
  if (isTouchDevice) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('equipo-composer').requestSubmit();
  }
});
$('equipo-composer').addEventListener('submit', e => {
  e.preventDefault();
  if ($('equipo-view').hidden) return;
  sendEquipoMessage();
});

// Poll más seguido que Sala (3s vs 5s): una ronda acá son hasta 3 turnos de
// agente encadenados, conviene que la UI se actualice apenas termina cada
// uno en vez de que Fernando vea "está pensando" durante toda la ronda.
function pollEquipoPane() {
  if (activePane !== 7) return;
  safeLoadEquipoRoomList();
  safeLoadEquipoMessages();
}

let equipoPollTimer = setInterval(pollEquipoPane, 3000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearInterval(equipoPollTimer);
  } else {
    pollEquipoPane();
    equipoPollTimer = setInterval(pollEquipoPane, 3000);
  }
});
