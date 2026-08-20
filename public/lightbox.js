// ── Lightbox (visor de imágenes a pantalla completa) ──
// Extraído de app.js (split por dominio, sesión 2026-08-20) — sin cambios de
// comportamiento, solo de archivo. Script clásico (no ES module), cargado
// después de app.js en index.html.
//
// Se expone como window.openLightbox (no una función lexical más) porque el
// resto del renderizado de archivos/adjuntos — que SÍ llama a esto — se queda
// en app.js por ahora (es parte del dominio grande de mensajes, para otra
// vuelta) y así queda accesible sin depender del orden relativo entre ambos.
(function initLightbox() {
  const lb = document.createElement('div');
  lb.id = 'lightbox';
  lb.innerHTML = `
    <div id="lightbox-backdrop"></div>
    <div id="lightbox-inner">
      <button id="lightbox-close" aria-label="Cerrar">✕</button>
      <img id="lightbox-img" alt="">
      <a id="lightbox-dl" download>⬇ Descargar</a>
    </div>
  `;
  document.body.appendChild(lb);

  function closeLightbox() { lb.classList.remove('open'); }
  lb.querySelector('#lightbox-backdrop').onclick = closeLightbox;
  lb.querySelector('#lightbox-close').onclick = closeLightbox;
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });

  window.openLightbox = function(src, downloadHref, filename) {
    const img = lb.querySelector('#lightbox-img');
    const dl = lb.querySelector('#lightbox-dl');
    img.src = src;
    dl.href = downloadHref;
    dl.download = filename || 'imagen';
    lb.classList.add('open');
  };
})();
