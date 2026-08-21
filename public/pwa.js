// ── PWA: service worker + install prompt + forzar actualización ──
// Extraído de app.js (split por dominio, sesión 2026-08-20) — sin cambios de
// comportamiento, solo de archivo. Script clásico (no ES module), cargado
// después de app.js en index.html: usa $() (definido ahí) y corre su lógica
// de instalación apenas carga, por eso necesita ese orden.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

(function initPWA() {
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  if (isStandalone) return;

  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

  window.addEventListener('appinstalled', () => {
    $('install-bar').hidden = true;
    $('ios-tip').hidden = true;
  });

  if (isIOS) {
    $('ios-tip').hidden = false;
    $('ios-tip-close').onclick = () => { $('ios-tip').hidden = true; };
    return;
  }

  // Android/Chrome: mostrar el botón solo cuando el browser esté listo
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    $('install-bar').hidden = false;
  });

  $('install-btn').onclick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    $('install-bar').hidden = true;
  };
  $('install-dismiss').onclick = () => { $('install-bar').hidden = true; };
})();

// ── Forzar actualización del service worker ──
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.ready.then(reg => {
    reg.update(); // fuerza chequeo de nueva versión en cada carga
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      window.location.reload(); // nuevo SW activado → recarga automática
    });
  });
}
