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
  clearEquipoAttachments();
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

// ── Equipo: adjuntar archivos ──
// Mismo mecanismo que el composer principal (uploadAttachment/addAttachmentChip
// en app.js): subir a /api/upload (genérico, no depende de conv) y mandar la
// ruta absoluta como texto — Claude/Codex/AgY la leen solos con su propio
// Read, no hace falta que el server la procese.
let pendingEquipoAttachments = []; // [{ path, name, file }]

function clearEquipoAttachments() {
  for (const chip of $('equipo-attachments').querySelectorAll('.attach-chip')) {
    if (chip._objUrl) URL.revokeObjectURL(chip._objUrl);
  }
  pendingEquipoAttachments = [];
  $('equipo-attachments').innerHTML = '';
}

function addEquipoAttachmentChip(name, filePath, localFile) {
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
    chip._objUrl = objUrl;
    chip.appendChild(img);
  } else if (isImg && filePath) {
    const img = document.createElement('img');
    img.className = 'attach-preview-img';
    img.alt = name;
    img.src = '/api/thumbnail?path=' + encodeURIComponent(filePath);
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
    const idx = pendingEquipoAttachments.findIndex(a => a.path === filePath);
    if (idx >= 0) pendingEquipoAttachments.splice(idx, 1);
    chip.remove();
  };

  chip.appendChild(nameSpan);
  chip.appendChild(removeBtn);
  $('equipo-attachments').appendChild(chip);
}

async function uploadEquipoFile(file) {
  if (!currentEquipoRoom) return;
  const displayName = file.name || `pegado-${Date.now()}.${(file.type.split('/')[1] || 'bin')}`;
  const loadingChip = document.createElement('div');
  loadingChip.className = 'attach-chip attach-chip-loading';
  loadingChip.innerHTML = `<span class="attach-spinner"></span><span class="attach-chip-name"></span>`;
  loadingChip.querySelector('.attach-chip-name').textContent = displayName;
  $('equipo-attachments').appendChild(loadingChip);

  const t0 = Date.now();
  let sentBytes = 0;
  try {
    const { blob, name: uploadName } = await prepareForUpload(file, displayName);
    file = blob;
    sentBytes = blob.size;
    const fd = new FormData();
    fd.append('file', blob, uploadName);
    const res = await netFetch('/api/upload', { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const { path: filePath, name } = await res.json();
    loadingChip.remove();
    pendingEquipoAttachments.push({ path: filePath, name, file });
    addEquipoAttachmentChip(name, filePath, file);
  } catch (err) {
    loadingChip.remove();
    const detalle = sentBytes
      ? ` [${(sentBytes / 1024 / 1024).toFixed(1)}MB, ${((Date.now() - t0) / 1000).toFixed(1)}s]`
      : ` [falló al preparar, ${((Date.now() - t0) / 1000).toFixed(1)}s]`;
    toast('No se pudo subir: ' + err.message + detalle);
  }
}

$('equipo-attach-btn').onclick = () => { $('equipo-file-input').click(); };
$('equipo-file-input').onchange = async () => {
  const files = Array.from($('equipo-file-input').files);
  $('equipo-file-input').value = '';
  for (const f of files) await uploadEquipoFile(f);
};

wireMic($('equipo-mic-btn'), $('equipo-input'), { container: $('equipo-messages') });

async function sendEquipoMessage() {
  const input = $('equipo-input');
  const rawText = input.value.trim();
  const attachments = [...pendingEquipoAttachments];
  if ((!rawText && attachments.length === 0) || !currentEquipoRoom || equipoBusy) return;
  const text = attachments.length > 0
    ? attachments.map(a => `[Archivo adjunto: ${a.path}]`).join('\n') + (rawText ? '\n\n' + rawText : '')
    : rawText;
  input.value = '';
  autoResize(input);
  clearEquipoAttachments();
  try {
    await api(`/equipo/rooms/${currentEquipoRoom.id}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    await loadEquipoMessages();
  } catch (err) {
    toast('No se pudo mandar el mensaje: ' + err.message);
    input.value = rawText;
    autoResize(input);
    for (const a of attachments) { pendingEquipoAttachments.push(a); addEquipoAttachmentChip(a.name, a.path, a.file); }
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
