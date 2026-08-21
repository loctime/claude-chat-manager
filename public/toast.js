// ── Toast ──
// Extraído de app.js (split por dominio, sesión 2026-08-20) — sin cambios de
// comportamiento, solo de archivo. Script clásico (no ES module): sigue
// compartiendo el mismo scope global que el resto de los <script> del index,
// cargado después de app.js en index.html.
// ttl = 0 → toast persistente, no se autodescarta (usalo para operaciones
// largas como compactar: mostrás "en curso…" y vos mismo lo cerrás cuando
// llega el resultado). Devuelve { remove } para eso.
function toast(msg, kind = 'error', ttl = 4000, action = null) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  const text = document.createElement('span');
  text.textContent = msg;
  t.appendChild(text);

  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    t.style.opacity = '0';
    t.style.transition = 'opacity .2s';
    setTimeout(() => t.remove(), 220);
  };

  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.type = 'button';
    btn.textContent = action.label;
    btn.onclick = () => { remove(); action.onClick(); };
    t.appendChild(btn);
  }

  container.appendChild(t);
  if (ttl > 0) setTimeout(remove, ttl);
  return { remove };
}
