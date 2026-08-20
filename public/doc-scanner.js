// ── Escáner de documentos (tipo CamScanner) ──
// Extraído de app.js (split por dominio, sesión 2026-08-20) — sin cambios de
// comportamiento, solo de archivo. Script clásico (no ES module), cargado
// después de app.js en index.html: usa $()/prepareForUpload/netFetch/toast/
// api/openLightbox/notebookListLoaded, todos definidos ahí.
//
// Todo el procesamiento (detectar el documento, enderezar la perspectiva,
// limpiar contraste) corre local con OpenCV vía mejora-imagen/mejorar_imagen.py
// — no pasa por Claude, no gasta tokens. Ver /api/scan en server.js.
let scanBusy = false;

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
    <button type="button" id="scan-again-btn" class="scan-again-btn">Escanear otra</button>
  `;

  el.querySelectorAll('.scan-variant img').forEach(img => {
    img.onclick = () => openLightbox(img.src, img.src, img.alt);
  });
  el.querySelectorAll('.scan-keep-btn').forEach(btn => {
    btn.onclick = () => keepScan(data.id, btn.dataset.variant, btn);
  });
  $('scan-again-btn').onclick = () => { renderScanIdle(); $('scan-file-input').value = ''; };
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
