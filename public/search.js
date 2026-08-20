// ── Búsqueda global ──
// Extraído de app.js (split por dominio, sesión 2026-08-20) — sin cambios de
// comportamiento, solo de archivo. Script clásico (no ES module), cargado
// después de app.js en index.html: usa $()/selectConv/openNotebook/toast/api/
// withAccount/activePane/currentNotebook/currentConv/messagesEl, todos
// definidos ahí.
//
// El atajo de teclado Tab (saltar entre las 2 conversaciones de arriba) se
// queda en app.js a propósito: vivía pegado a este bloque en el archivo viejo
// pero no tiene nada que ver con buscar, solo cayó ahí por casualidad.
let searchDebounce = null;
let searchLastQuery = '';
let searchResults = [];

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

// Dónde busca: parado en la pestaña Notas (o con una libreta abierta) busca
// notas; en cualquier otro lado, chats.
function searchScope() {
  return (activePane === 2 || currentNotebook) ? 'note' : 'chat';
}

async function runSearch(q) {
  const box = $('search-results');
  if (!q.trim()) { box.innerHTML = ''; searchResults = []; return; }
  box.innerHTML = '<div class="search-loading">Buscando…</div>';
  try {
    const kind = searchScope();
    const tools = $('search-tools').checked ? '1' : '0';
    const { results } = await api(withAccount(
      `/search?limit=50&kind=${kind}&tools=${tools}&q=` + encodeURIComponent(q)));
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
      // Una nota no tiene cwd ni rol que valga la pena mostrar: alcanza libreta + fecha.
      const fecha = (r.lastActivity || '').slice(0, 16).replace('T', ' ');
      meta.textContent = r.kind === 'note'
        ? ['nota', fecha].filter(Boolean).join(' · ')
        : [r.role, (r.cwd || '').split(/[\\/]/).pop(), fecha].filter(Boolean).join(' · ');
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
  if (r.kind === 'note') return openNoteResult(r);
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
  const enNotas = searchScope() === 'note';
  input.value = '';
  input.placeholder = enNotas ? 'Buscar en todas las notas…' : 'Buscar en todas las conversaciones… (Ctrl+K)';
  // El filtro de herramientas solo aplica a chats; en notas no hay nada que filtrar.
  $('search-tools-label').hidden = enNotas;
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
// Cambiar el filtro re-consulta con lo que ya está tipeado, sin esperar otra tecla.
$('search-tools').addEventListener('change', () => runSearch($('search-input').value));
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
