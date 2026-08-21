// ── Escáner de documentos (tipo CamScanner) ──
// Extraído de app.js (split por dominio, sesión 2026-08-20) — sin cambios de
// comportamiento, solo de archivo. Script clásico (no ES module), cargado
// después de app.js en index.html: usa $()/prepareForUpload/netFetch/toast/
// api/openLightbox/notebookListLoaded, todos definidos ahí.
//
// Todo el procesamiento (detectar el documento, enderezar la perspectiva,
// limpiar contraste) corre local con OpenCV vía scripts/mejora-imagen/
// mejorar_imagen.py — no pasa por Claude, no gasta tokens. Ver /api/scan en
// server.js.
//
// Documento de varias páginas (2026-08-21): además de guardar/descargar una
// página suelta, se puede ir "agregando" cada escaneo a una cola
// (scanPages) y al final juntarlas en un solo PDF (/api/scan/pdf). Cada
// página en la cola tiene su propio botón de descartar (✕) — es la forma de
// sacar una página puntual que salió mal sin perder las demás ya escaneadas.
let scanBusy = false;
let scanPages = []; // [{ id, detectado, recortada, limpia }]

function renderScanIdle() {
  const el = $('scan-result');
  el.hidden = true;
  el.innerHTML = '';
}

async function processScan(file) {
  if (scanBusy) return;
  scanBusy = true;
  $('scan-start-btn').disabled = true;
  const el = $('scan-result');
  el.hidden = false;
  el.innerHTML = `<div class="scan-loading"><span class="attach-spinner"></span> Procesando…</div>`;
  try {
    const { blob, name } = await prepareForUpload(file, file.name || `foto-${Date.now()}.jpg`);
    const fd = new FormData();
    fd.append('photo', blob, name);
    const res = await netFetch('/api/scan', { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    renderScanResult(await res.json());
  } catch (err) {
    el.hidden = true;
    toast('No se pudo procesar la foto: ' + err.message);
  } finally {
    scanBusy = false;
    $('scan-start-btn').disabled = false;
  }
}

function renderScanResult(data) {
  const el = $('scan-result');
  const variants = [
    { key: 'recortada', label: 'Color (enderezado)', path: data.recortada },
    { key: 'limpia', label: 'Blanco y negro', path: data.limpia },
  ];
  const badge = data.detectado
    ? '<span class="scan-badge scan-badge-ok">✓ documento detectado y enderezado</span>'
    : '<span class="scan-badge">no se detectó el borde del documento — se usó la foto completa</span>';

  el.innerHTML = `
    ${badge}
    <div class="scan-variants">
      ${variants.map(v => `
        <div class="scan-variant">
          <img src="/api/files?path=${encodeURIComponent(v.path)}" alt="${v.label}">
          <div class="scan-variant-label">${v.label}</div>
          <div class="scan-variant-actions">
            <button type="button" class="scan-keep-btn" data-variant="${v.key}">Guardar en Notas</button>
            <a class="scan-dl-btn" href="/api/files?path=${encodeURIComponent(v.path)}" download>Descargar</a>
          </div>
        </div>
      `).join('')}
    </div>
    <div class="scan-variant-actions">
      <button type="button" id="scan-discard-btn" class="scan-discard-btn">🗑 Descartar</button>
      <button type="button" id="scan-add-page-btn" class="scan-add-page-btn">+ Agregar a documento</button>
      <button type="button" id="scan-again-btn" class="scan-again-btn">Escanear otra</button>
    </div>
  `;

  el.querySelectorAll('.scan-variant img').forEach(img => {
    img.onclick = () => openLightbox(img.src, img.src, img.alt);
  });
  el.querySelectorAll('.scan-keep-btn').forEach(btn => {
    btn.onclick = () => keepScan(data.id, btn.dataset.variant, btn);
  });
  $('scan-discard-btn').onclick = () => { renderScanIdle(); $('scan-file-input').value = ''; };
  $('scan-add-page-btn').onclick = () => {
    scanPages.push({ id: data.id, detectado: data.detectado, recortada: data.recortada, limpia: data.limpia });
    renderScanIdle();
    $('scan-file-input').value = '';
    renderScanQueue();
  };
  $('scan-again-btn').onclick = () => { renderScanIdle(); $('scan-file-input').value = ''; };
}

function renderScanQueue() {
  const el = $('scan-queue');
  if (!scanPages.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `
    <div class="scan-queue-title">📄 Documento en progreso — ${scanPages.length} página${scanPages.length === 1 ? '' : 's'}</div>
    <div class="scan-queue-pages">
      ${scanPages.map((p, i) => `
        <div class="scan-queue-page" data-idx="${i}">
          <img src="/api/files?path=${encodeURIComponent(p.recortada)}" alt="Página ${i + 1}">
          <span class="scan-queue-page-num">${i + 1}</span>
          <button type="button" class="scan-queue-discard" title="Descartar esta página" aria-label="Descartar esta página">✕</button>
        </div>
      `).join('')}
    </div>
    <div class="scan-queue-actions">
      <button type="button" id="scan-add-more-btn" class="scan-add-page-btn">+ Escanear otra página</button>
      <button type="button" id="scan-finish-color-btn" class="scan-finish-btn">✅ Terminar (color)</button>
      <button type="button" id="scan-finish-bn-btn" class="scan-finish-btn">✅ Terminar (blanco y negro)</button>
    </div>
  `;
  el.querySelectorAll('.scan-queue-discard').forEach(btn => {
    btn.onclick = () => {
      const idx = Number(btn.closest('.scan-queue-page').dataset.idx);
      scanPages.splice(idx, 1);
      renderScanQueue();
    };
  });
  el.querySelectorAll('.scan-queue-page img').forEach((img, i) => {
    img.onclick = () => openLightbox(img.src, img.src, `Página ${i + 1}`);
  });
  $('scan-add-more-btn').onclick = () => { $('scan-file-input').click(); };
  $('scan-finish-color-btn').onclick = (e) => finishScanDocument('recortada', e.target);
  $('scan-finish-bn-btn').onclick = (e) => finishScanDocument('limpia', e.target);
}

async function finishScanDocument(variant, btn) {
  if (!scanPages.length) return;
  const buttons = document.querySelectorAll('.scan-finish-btn');
  buttons.forEach(b => b.disabled = true);
  const original = btn.textContent;
  btn.textContent = 'Armando PDF…';
  try {
    const pages = scanPages.map(p => ({ id: p.id, variant }));
    const pdf = await api('/scan/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pages }),
    });
    renderScanPdfResult(pdf);
    scanPages = [];
    renderScanQueue();
  } catch (err) {
    toast('No se pudo armar el PDF: ' + err.message);
    buttons.forEach(b => b.disabled = false);
    btn.textContent = original;
  }
}

function renderScanPdfResult(pdf) {
  const el = $('scan-result');
  el.hidden = false;
  el.innerHTML = `
    <div class="scan-variant">
      <div class="scan-variant-label">📄 PDF armado — ${pdf.pageCount} página${pdf.pageCount === 1 ? '' : 's'}</div>
      <div class="scan-variant-actions">
        <button type="button" id="scan-pdf-keep-btn" class="scan-keep-btn">Guardar en Notas</button>
        <a class="scan-dl-btn" href="/api/files?path=${encodeURIComponent(pdf.path)}" download>Descargar</a>
      </div>
    </div>
  `;
  $('scan-pdf-keep-btn').onclick = () => keepScanPdf(pdf.id, $('scan-pdf-keep-btn'));
}

async function keepScanPdf(id, btn) {
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Guardando…';
  try {
    await api(`/scan/pdf/${id}/keep`, { method: 'POST' });
    btn.textContent = '✓ Guardado en Notas';
    notebookListLoaded = false; // fuerza refresco la próxima vez que se entra a Notas
  } catch (err) {
    btn.disabled = false;
    btn.textContent = original;
    toast('No se pudo guardar en Notas: ' + err.message);
  }
}

async function keepScan(id, variant, btn) {
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Guardando…';
  try {
    await api(`/scan/${id}/keep`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variant }),
    });
    btn.textContent = '✓ Guardado en Notas';
    notebookListLoaded = false; // fuerza refresco la próxima vez que se entra a Notas
  } catch (err) {
    btn.disabled = false;
    btn.textContent = original;
    toast('No se pudo guardar en Notas: ' + err.message);
  }
}

$('scan-start-btn').onclick = () => { $('scan-file-input').click(); };
$('scan-file-input').onchange = () => {
  const file = $('scan-file-input').files[0];
  $('scan-file-input').value = '';
  if (file) processScan(file);
};
