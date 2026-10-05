// ── Aviso de versión nueva ──
// Consulta /api/version y muestra un aviso flotante cuando el servidor tiene código nuevo
// en disco (o ya se actualizó y esta página quedó vieja). La persona elige: actualizar ya,
// esperar a que termine lo que está haciendo, o forzar. Si fuerza, el server anota qué se
// cortó y acá, al volver, se le pide a cada motor que continúe. Lógica del server en
// src/update.js. Script clásico: comparte el scope global con el resto de los <script>.
(() => {
  const POLL_MS = 60000;
  const WAIT_POLL_MS = 8000;       // mientras espera a que termine el trabajo en curso
  const RESTART_POLL_MS = 1500;
  const RESTART_GIVE_UP_MS = 60000;
  const DISMISS_MS = 30 * 60 * 1000;
  const DISMISS_KEY = 'ccm-update-dismissed';
  const RESUME_TEXT = 'Continuá con lo que estabas haciendo. La app se actualizó y se cortó un momento.';
  const RESUME_URL = {
    claude: id => `/api/conversations/${id}/message`,
    codex: id => `/api/codex/conversations/${id}/message`,
    agy: id => `/api/gemini/conversations/${id}/message`,
  };

  let loadedRunning = null;   // commit del server cuando se cargó esta página
  let last = null;            // última respuesta de /api/version
  let mode = 'idle';          // idle | confirm | waiting | updating
  let pollTimer = null;

  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');
  banner.hidden = true;
  document.body.appendChild(banner);

  function dismissed() { return Date.now() < Number(sessionStorage.getItem(DISMISS_KEY) || 0); }

  function show(text, buttons) {
    banner.replaceChildren();
    const p = document.createElement('div');
    p.className = 'ub-text';
    p.textContent = text;
    banner.appendChild(p);
    if (buttons.length) {
      const row = document.createElement('div');
      row.className = 'ub-actions';
      for (const [label, onClick, primary] of buttons) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        if (primary) b.className = 'primary';
        b.onclick = onClick;
        row.appendChild(b);
      }
      banner.appendChild(row);
    }
    banner.hidden = false;
  }

  function render() {
    if (!last) { banner.hidden = true; return; }
    if (mode === 'updating') return show('Actualizando… un momento.', []);

    // El server ya se actualizó (p. ej. por el reinicio automático) y esta página quedó vieja.
    if (loadedRunning && last.running && last.running !== loadedRunning) {
      return show('La app se actualizó. Recargá para usar la versión nueva.', [['Recargar', () => location.reload(), true]]);
    }
    if (!last.updateAvailable || !last.canUpdate || dismissed()) { banner.hidden = true; return; }

    const busy = last.busy.length > 0;
    if (mode === 'confirm') {
      return show('Se va a cortar lo que está haciendo y después le pido que continúe. ¿Actualizar igual?', [
        ['Sí, actualizar', () => applyUpdate(true), true],
        ['Volver', () => { mode = 'idle'; render(); }],
      ]);
    }
    if (mode === 'waiting') {
      return show('Se actualiza apenas termine de trabajar.', [['Cancelar', () => { mode = 'idle'; schedule(); render(); }]]);
    }
    if (!busy) {
      return show('Hay una versión nueva de la app.', [
        ['Actualizar ahora', () => applyUpdate(false), true],
        ['Más tarde', later],
      ]);
    }
    show('Hay una versión nueva. Ahora está trabajando en algo.', [
      ['Actualizar cuando termine', () => { mode = 'waiting'; schedule(); render(); }, true],
      ['Actualizar igual', () => { mode = 'confirm'; render(); }],
      ['Más tarde', later],
    ]);
  }

  function later() {
    sessionStorage.setItem(DISMISS_KEY, String(Date.now() + DISMISS_MS));
    render();
  }

  async function fetchVersion() {
    try {
      const res = await fetch('/api/version', { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; } // el server puede estar reiniciándose
  }

  async function refresh() {
    const v = await fetchVersion();
    if (!v) return;
    if (loadedRunning === null) loadedRunning = v.running;
    last = v;
    if (mode === 'waiting' && v.busy.length === 0) { applyUpdate(false); return; }
    render();
  }

  function schedule() {
    clearInterval(pollTimer);
    pollTimer = setInterval(refresh, mode === 'waiting' ? WAIT_POLL_MS : POLL_MS);
  }

  async function applyUpdate(force) {
    mode = 'updating';
    render();
    let res;
    try {
      res = await fetch('/api/update-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      });
    } catch {
      mode = 'idle';
      toast('No se pudo actualizar. Probá de nuevo en un momento.', 'error', 6000);
      return render();
    }
    if (res.status === 409) { // empezó a trabajar justo ahora: que la persona decida de nuevo
      mode = 'idle';
      await refresh();
      return;
    }
    if (!res.ok) {
      mode = 'idle';
      toast('No se pudo actualizar.', 'error', 6000);
      return render();
    }
    waitForRestart();
  }

  async function waitForRestart() {
    const t0 = Date.now();
    while (Date.now() - t0 < RESTART_GIVE_UP_MS) {
      await new Promise(r => setTimeout(r, RESTART_POLL_MS));
      const v = await fetchVersion();
      if (v && v.running !== loadedRunning) { location.reload(); return; }
    }
    mode = 'idle';
    toast('No pude confirmar la actualización. Recargá la página.', 'error', 8000);
    render();
  }

  // Tras una actualización forzada, el server dejó anotado qué estaba trabajando (read-once).
  async function resumeAfterUpdate() {
    let items = [];
    try { items = (await (await fetch('/api/update-resume', { cache: 'no-store' })).json()).items || []; } catch { return; }
    if (!items.length) return;
    let ok = 0;
    for (const { engine, id } of items) {
      const url = RESUME_URL[engine] && RESUME_URL[engine](id);
      if (!url) continue;
      try {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: RESUME_TEXT }) });
        if (res.ok) ok++;
      } catch { /* esa conversación no se pudo retomar; las otras siguen */ }
    }
    if (ok) toast(ok === 1 ? 'Se actualizó la app. Retomé lo que estabas haciendo.' : `Se actualizó la app. Retomé ${ok} conversaciones.`, 'info', 8000);
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  schedule();
  refresh();
  setTimeout(resumeAfterUpdate, 1500);
})();
