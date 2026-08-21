// ── Limpieza de sesiones ──
// Extraído como dominio propio desde el arranque (no hay código viejo que
// mover — nace ya separado, sigue el mismo patrón que search.js/doc-scanner.js:
// script clásico cargado después de app.js, mismo scope global compartido.
// Ver docs/superpowers/specs/2026-08-20-limpieza-sesiones-design.md.

let cleanupSessions = [];      // último reporte crudo del server
let cleanupActiveClasses = new Set(); // clasificaciones activas en los chips (vacío = todas)
let cleanupFolder = '';
let cleanupMinSize = 0;       // bytes; 0 = sin filtro de tamaño
let cleanupDateFilter = '0';  // '0' | '7' | '30' | 'older30'
let cleanupSort = 'size';
let cleanupSelected = new Set(); // sessionIds seleccionados (nunca incluye protegidas)

const CLEANUP_CLASS_LABELS = { app: 'App', orphan: 'Suelta', trivial: 'Trivial', channel: 'Canal' };
const CLEANUP_REASON_LABELS = { archived: '🔒 archivada', pinned: '🔒 pineada', running: '🔒 activa', recent: '🔒 reciente' };

function cleanupFolderName(cwd) {
  return (cwd || '').split(/[\\/]/).filter(Boolean).pop() || cwd || '(desconocido)';
}

function cleanupFormatMB(bytes) {
  return (bytes / 1e6).toFixed(1) + ' MB';
}

async function loadCleanupSessions() {
  $('cleanup-list').textContent = 'Cargando…';
  const resp = await api(withAccount('/cleanup/sessions'));
  cleanupSessions = resp.sessions;
  // No alcanza con que el sessionId siga existiendo: si se volvió protegida entre
  // recargas (p.ej. su conv se pineó/archivó desde otro lado) hay que sacarla de
  // la selección — si no, su fila renderiza tildada-y-deshabilitada y sus bytes
  // siguen contados en la barra de abajo.
  cleanupSelected = new Set([...cleanupSelected].filter(id => {
    const s = cleanupSessions.find(x => x.sessionId === id);
    return s && !s.protected;
  }));
  renderCleanupChips(resp.byClassification);
  renderCleanupFolders();
  renderCleanupList();
  updateCleanupTotals(resp.totalBytes);
  updateCleanupToolbar();
}

function renderCleanupChips(byClassification) {
  const box = $('cleanup-class-filters');
  box.innerHTML = '';
  for (const key of Object.keys(CLEANUP_CLASS_LABELS)) {
    const count = byClassification[key] || 0;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'cleanup-chip' + (cleanupActiveClasses.has(key) ? ' active' : '');
    chip.textContent = `${CLEANUP_CLASS_LABELS[key]} (${count})`;
    chip.onclick = () => {
      if (cleanupActiveClasses.has(key)) cleanupActiveClasses.delete(key);
      else cleanupActiveClasses.add(key);
      renderCleanupChips(byClassification);
      renderCleanupList();
    };
    box.appendChild(chip);
  }
}

function renderCleanupFolders() {
  const select = $('cleanup-folder-filter');
  const prev = select.value;
  const folders = [...new Set(cleanupSessions.map(s => s.cwd))].sort();
  // Construcción por DOM, no innerHTML con template string: cwd viene del filesystem
  // (no confiable) y cleanupFolderName lo devuelve como texto plano — nunca como HTML.
  select.innerHTML = '';
  const allOpt = document.createElement('option');
  allOpt.value = '';
  allOpt.textContent = 'Todas las carpetas';
  select.appendChild(allOpt);
  for (const f of folders) {
    const opt = document.createElement('option');
    opt.value = f;
    opt.textContent = cleanupFolderName(f);
    select.appendChild(opt);
  }
  select.value = folders.includes(prev) ? prev : '';
  cleanupFolder = select.value;
}

function cleanupFilteredSorted() {
  let list = cleanupSessions;
  if (cleanupActiveClasses.size) list = list.filter(s => cleanupActiveClasses.has(s.classification));
  if (cleanupFolder) list = list.filter(s => s.cwd === cleanupFolder);
  if (cleanupMinSize) list = list.filter(s => s.sizeBytes > cleanupMinSize);
  if (cleanupDateFilter !== '0') {
    const now = Date.now();
    const ageMs = (sess) => now - new Date(sess.lastActivity || 0).getTime();
    list = cleanupDateFilter === 'older30'
      ? list.filter(s => ageMs(s) > 30 * 86400000)
      : list.filter(s => ageMs(s) <= Number(cleanupDateFilter) * 86400000);
  }
  const sorted = [...list];
  if (cleanupSort === 'size') sorted.sort((a, b) => b.sizeBytes - a.sizeBytes);
  else if (cleanupSort === 'lastActivity') sorted.sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));
  else if (cleanupSort === 'messageCount') sorted.sort((a, b) => b.messageCount - a.messageCount);
  return sorted;
}

function renderCleanupList() {
  const box = $('cleanup-list');
  box.innerHTML = '';
  const list = cleanupFilteredSorted();
  for (const s of list) {
    const row = document.createElement('div');
    row.className = 'session-row' + (s.protected ? ' protected' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.disabled = s.protected;
    cb.checked = cleanupSelected.has(s.sessionId);
    cb.onchange = () => {
      if (cb.checked) cleanupSelected.add(s.sessionId);
      else cleanupSelected.delete(s.sessionId);
      updateCleanupToolbar();
    };
    const body = document.createElement('div');
    body.className = 'session-row-body';
    const name = document.createElement('div');
    name.className = 'session-row-name';
    name.textContent = s.name || s.snippet || '(sin mensajes)';
    const meta = document.createElement('div');
    meta.className = 'session-row-meta';
    const badge = document.createElement('span');
    badge.className = 'session-badge session-badge-' + s.classification;
    badge.textContent = CLEANUP_CLASS_LABELS[s.classification];
    meta.appendChild(badge);
    if (s.protected) {
      const reasonBadge = document.createElement('span');
      reasonBadge.className = 'session-badge';
      reasonBadge.textContent = CLEANUP_REASON_LABELS[s.protectedReason] || '🔒';
      meta.appendChild(reasonBadge);
    }
    const rest = document.createElement('span');
    rest.textContent = [cleanupFolderName(s.cwd), cleanupFormatMB(s.sizeBytes), (s.lastActivity || '').slice(0, 10)].join(' · ');
    meta.appendChild(rest);
    body.appendChild(name);
    body.appendChild(meta);
    row.appendChild(cb);
    row.appendChild(body);
    box.appendChild(row);
  }
}

function updateCleanupTotals(totalBytes) {
  $('cleanup-total').textContent = `${cleanupSessions.length} sesiones · ${cleanupFormatMB(totalBytes)}`;
}

function updateCleanupToolbar() {
  let toolbar = $('cleanup-toolbar');
  if (!toolbar) {
    toolbar = document.createElement('div');
    toolbar.id = 'cleanup-toolbar';
    toolbar.className = 'cleanup-toolbar';
    toolbar.innerHTML = `
      <span id="cleanup-toolbar-count"></span>
      <button type="button" id="cleanup-toolbar-delete" class="danger">Borrar</button>
    `;
    $('tree-sessions').appendChild(toolbar);
    $('cleanup-toolbar-delete').onclick = openCleanupConfirm;
  }
  const selectedRows = cleanupSessions.filter(s => cleanupSelected.has(s.sessionId));
  const bytes = selectedRows.reduce((sum, s) => sum + s.sizeBytes, 0);
  toolbar.classList.toggle('visible', cleanupSelected.size > 0);
  $('cleanup-toolbar-count').textContent = `${cleanupSelected.size} seleccionadas · ${cleanupFormatMB(bytes)}`;
}

function openCleanupConfirm() {
  const selectedRows = cleanupSessions.filter(s => cleanupSelected.has(s.sessionId));
  const bytes = selectedRows.reduce((sum, s) => sum + s.sizeBytes, 0);
  $('cleanup-confirm-text').textContent =
    `Vas a borrar ${selectedRows.length} sesiones (${cleanupFormatMB(bytes)}) de forma permanente. ¿Confirmás?`;
  $('cleanup-confirm-dialog').showModal();
}

async function runCleanupDelete() {
  const ids = [...cleanupSelected];
  try {
    const resp = await api('/cleanup/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(withAccountBody({ sessionIds: ids })),
    });
    cleanupSelected.clear();
    const freedMB = cleanupFormatMB(resp.freedBytes);
    const skippedMsg = resp.skipped.length ? `, ${resp.skipped.length} salteadas` : '';
    toast(`Borradas ${resp.deleted.length} sesiones · liberaste ${freedMB}${skippedMsg}`, 'info', 5000);
    await loadCleanupSessions();
    updateCleanupToolbar();
  } catch (err) {
    toast('Error borrando sesiones: ' + err.message);
  }
}

$('cleanup-folder-filter').addEventListener('change', () => {
  cleanupFolder = $('cleanup-folder-filter').value;
  renderCleanupList();
});
$('cleanup-size-filter').addEventListener('change', () => {
  cleanupMinSize = Number($('cleanup-size-filter').value);
  renderCleanupList();
});
$('cleanup-date-filter').addEventListener('change', () => {
  cleanupDateFilter = $('cleanup-date-filter').value;
  renderCleanupList();
});
$('cleanup-sort').addEventListener('change', () => {
  cleanupSort = $('cleanup-sort').value;
  renderCleanupList();
});
$('cleanup-select-all-cb').addEventListener('change', (e) => {
  const visible = cleanupFilteredSorted().filter(s => !s.protected);
  if (e.target.checked) visible.forEach(s => cleanupSelected.add(s.sessionId));
  else visible.forEach(s => cleanupSelected.delete(s.sessionId));
  renderCleanupList();
  updateCleanupToolbar();
});
$('cleanup-confirm-cancel').onclick = () => $('cleanup-confirm-dialog').close();
$('cleanup-confirm-form').addEventListener('submit', (e) => {
  e.preventDefault();
  $('cleanup-confirm-dialog').close();
  runCleanupDelete();
});
