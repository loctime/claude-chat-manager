// ── Búsqueda global ──
// Extraído de app.js (split por dominio, sesión 2026-08-20) — sin cambios de
// comportamiento, solo de archivo. Script clásico (no ES module), cargado
// después de app.js en index.html: usa $()/selectConv/openNotebook/toast/api/
// withAccount/activePane/currentNotebook/currentConv/messagesEl/goToPane/
// selectCodexShared/selectGemini, todos definidos ahí.

let searchDebounce = null;
let searchLastQuery = '';
let searchResults = [];
let currentSearchKind = 'all';

// El servidor delimita el término encontrado con estos caracteres de control.
// Las marcas las pone el índice (FTS5), que es el único que sabe qué matcheó
// de verdad: buscando "facil" el snippet trae "fácil", y "deplo" trae "deploy".
const HL_START = '\u0001';
const HL_END = '\u0002';

// Fallback para cuando el snippet viene sin marcas (buscador degradado, sin
// índice): resaltar buscando la query cruda, como se hacía antes.
function highlightByQuery(snippet, query) {
  const q = query.trim();
  const frag = document.createDocumentFragment();
  const idx = q ? snippet.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (idx < 0) { frag.appendChild(document.createTextNode(snippet)); return frag; }
  const hit = document.createElement('mark');
  hit.textContent = snippet.slice(idx, idx + q.length);
  frag.appendChild(document.createTextNode(snippet.slice(0, idx)));
  frag.appendChild(hit);
  frag.appendChild(document.createTextNode(snippet.slice(idx + q.length)));
  return frag;
}

function highlightSnippet(snippet, query) {
  if (!snippet.includes(HL_START)) return highlightByQuery(snippet, query);
  const frag = document.createDocumentFragment();
  for (const part of snippet.split(HL_START)) {
    const end = part.indexOf(HL_END);
    // El primer tramo es el texto anterior a la primera marca: no lleva cierre.
    if (end < 0) { frag.appendChild(document.createTextNode(part)); continue; }
    const hit = document.createElement('mark');
    hit.textContent = part.slice(0, end);
    frag.appendChild(hit);
    frag.appendChild(document.createTextNode(part.slice(end + 1)));
  }
  return frag;
}

function formatSearchDate(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return '';
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, '0');
  const mins = String(d.getMinutes()).padStart(2, '0');
  return `${day}/${month}/${year} ${hours}:${mins}`;
}

function setSearchKind(kind) {
  currentSearchKind = kind || 'all';
  document.querySelectorAll('.search-pill').forEach(btn => {
    btn.classList.toggle('active', (btn.dataset.kind || 'all') === currentSearchKind);
  });
  const toolsLabel = $('search-tools-label');
  if (toolsLabel) toolsLabel.hidden = (currentSearchKind === 'note');
  const input = $('search-input');
  if (input) {
    input.placeholder = currentSearchKind === 'note'
      ? 'Buscar en todas las notas…'
      : 'Buscar en conversaciones y notas… (Ctrl+K)';
  }
  if (input && input.value.trim()) {
    runSearch(input.value);
  }
}

async function runSearch(q) {
  const box = $('search-results');
  if (!q.trim()) { box.innerHTML = ''; searchResults = []; return; }
  box.innerHTML = '<div class="search-loading">Buscando…</div>';
  try {
    const kind = currentSearchKind || 'all';
    const tools = $('search-tools') && $('search-tools').checked ? '1' : '0';
    const sort = ($('search-sort') && $('search-sort').value) || 'recent';
    const { results } = await api(withAccount(
      `/search?limit=50&kind=${kind}&tools=${tools}&sort=${sort}&q=` + encodeURIComponent(q)));
    searchResults = results || [];
    searchLastQuery = q;
    box.innerHTML = '';
    if (searchResults.length === 0) {
      box.innerHTML = '<div class="search-empty">Sin resultados</div>';
      return;
    }
    for (let i = 0; i < searchResults.length; i++) {
      const r = searchResults[i];
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'search-result';
      row.dataset.idx = String(i);

      const name = document.createElement('div');
      name.className = 'search-name';

      const badge = document.createElement('span');
      badge.className = `search-badge search-badge-${r.kind || 'chat'}`;
      if (r.kind === 'codex') badge.textContent = 'Codex';
      else if (r.kind === 'gemini') badge.textContent = 'AgY';
      else if (r.kind === 'note') badge.textContent = 'Nota';
      else badge.textContent = 'Claude';
      name.appendChild(badge);

      if (r.project) {
        const proj = document.createElement('span');
        proj.className = 'conv-project-tag';
        proj.textContent = r.project;
        name.appendChild(proj);
      }

      const title = document.createElement('span');
      title.className = 'search-name-text';
      title.textContent = r.displayName || r.name || '(sin título)';
      name.appendChild(title);

      const snip = document.createElement('div');
      snip.className = 'search-snippet';
      snip.appendChild(highlightSnippet(r.snippet || '', q));

      const meta = document.createElement('div');
      meta.className = 'search-meta';
      const fecha = formatSearchDate(r.ts || r.lastActivity);
      const metaParts = [];
      if (r.kind === 'note') {
        if (fecha) metaParts.push(fecha);
      } else {
        if (r.role) metaParts.push(r.role);
        if (r.cwd) metaParts.push(r.cwd.split(/[\\/]/).pop());
        if (fecha) metaParts.push(fecha);
      }
      meta.textContent = metaParts.filter(Boolean).join(' · ');

      row.appendChild(name);
      row.appendChild(snip);
      row.appendChild(meta);
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
  if (r.kind === 'note') {
    if (typeof goToPane === 'function') await goToPane(3);
    return openNoteResult(r);
  }
  if (r.kind === 'codex') {
    if (typeof goToPane === 'function') await goToPane(2);
    if (typeof selectCodexShared === 'function') {
      await selectCodexShared(r.convId, r.displayName || r.name, r.cwd, r.project);
    }
  } else if (r.kind === 'gemini') {
    if (typeof goToPane === 'function') await goToPane(6);
    if (typeof selectGemini === 'function') {
      await selectGemini(r.convId, r.displayName || r.name, r.cwd, r.project);
    }
  } else {
    // chat (Claude)
    if (typeof goToPane === 'function') await goToPane(0);
    if (typeof selectConv === 'function') {
      await selectConv(r.convId, r.displayName || r.name, r.model, r.lastModel, r.cwd);
    }
  }
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

// Abre la libreta del resultado y resalta la nota encontrada. Las notas se
// renderizan en orden cronológico, que es el mismo orden del archivo del que
// salió matchIndex.
async function openNoteResult(r) {
  await openNotebook(r.notebookId, r.name);
  requestAnimationFrame(() => {
    const target = $('notes-messages').querySelectorAll('.note-bubble')[r.matchIndex];
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('search-hit');
    setTimeout(() => target.classList.remove('search-hit'), 2000);
  });
}

function openSearchDialog() {
  const dlg = $('search-dialog');
  const input = $('search-input');
  input.value = '';
  const isNotes = (activePane === 3 || currentNotebook);
  setSearchKind(isNotes ? 'note' : 'all');
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

// Cambiar el filtro o sort re-consulta con lo que ya está tipeado, sin esperar otra tecla.
if ($('search-tools')) {
  $('search-tools').addEventListener('change', () => runSearch($('search-input').value));
}
if ($('search-sort')) {
  $('search-sort').addEventListener('change', () => runSearch($('search-input').value));
}

document.querySelectorAll('.search-pill').forEach(btn => {
  btn.onclick = () => {
    setSearchKind(btn.dataset.kind || 'all');
  };
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
