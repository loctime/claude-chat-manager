// ── Notas (libretas, notas, subida de archivos y polling) ──
// Extraído de app.js (split por dominio, sesión 15/09/2026).
// Script clásico (no ES module): comparte el scope global con el resto de los scripts.

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
  if (typeof showSalaView === 'function') showSalaView(false); // si había una sala abierta, se cierra — ver bug reportado por Diego
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
  if (typeof showSalaView === 'function') showSalaView(false); // si había una sala abierta, se cierra — ver bug reportado por Diego
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

// ── Renombrar libreta (doble click en el título, mismo patrón que #conv-title) ──
$('notebook-back-btn').onclick = closeChat;

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
  if (activePane !== 3) return;
  // En mobile #notebook-view y la lista son mutuamente excluyentes (overlay),
  // así que alcanza con pollear la que esté a la vista. En desktop las dos
  // conviven en pantalla a la vez — si solo se pollea la que "está visible"
  // según notebookIsVisible(), la lista deja de refrescarse para siempre en
  // cuanto se abre la primera libreta (no hay forma de "cerrarla" en desktop,
  // el botón atrás es mobile-only). Ver Finding 1 del review final.
  if (notebookIsVisible()) safeLoadNotes();
  if (!isMobile() || !notebookIsVisible()) safeLoadNotebookList();
}

// Mismo criterio que treePollTimer arriba: en segundo plano no tiene sentido
// seguir pinchando cada 5s, aunque el trabajo real esté gateado por
// activePane — el poll en sí (y el eventual fetch si estás en Notas) sigue
// siendo un despertar de red evitable con la pantalla apagada.
let notesPollTimer = setInterval(pollNotesPane, 5000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearInterval(notesPollTimer);
  } else {
    pollNotesPane();
    notesPollTimer = setInterval(pollNotesPane, 5000);
  }
});
