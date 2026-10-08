// ── Guía interactiva "Muéstrame" ──
// Recorrido paso a paso sobre la app real: resalta el botón a tocar, espera a
// que la persona lo toque (o lo hace por ella con "Hacelo por mí") y avanza.
// Usa una conversación de práctica real (compactar necesita mensajes reales),
// por eso avisa antes que gasta un poquito de cupo.
// Script clásico: comparte scope global con app.js ($, currentConv, busy, etc.).

const TOUR_PRACTICE_NAME = 'Práctica de la guía';
const TOUR_PRACTICE_MSG = 'Esto es solo una prueba de la app, no hagas nada en la computadora. Contestame con una sola frase corta: ¿qué es compactar una conversación?';

let _tour = null;

const tourSleep = ms => new Promise(r => setTimeout(r, ms));
const tourIsMobile = () => window.innerWidth < 768;

// Espera a que cond() sea truthy (o devuelva 'back'/'cancel'); null si vence el tiempo.
async function tourWaitFor(cond, timeoutMs = 600000) {
  const t0 = Date.now();
  while (_tour && !_tour.cancelled) {
    let r;
    try { r = cond(); } catch { r = false; }
    if (r) return r;
    if (Date.now() - t0 > timeoutMs) return null;
    await tourSleep(200);
  }
  return 'cancel';
}

function tourConvRow(convId) {
  return [...document.querySelectorAll('#tree .conv')].find(el => el._conv && el._conv.convId === convId) || null;
}

function tourBuildLayer() {
  const layer = document.createElement('div');
  layer.id = 'tour-layer';
  layer.innerHTML = `
    <div class="tour-dim" hidden></div>
    <div class="tour-ring" hidden></div>
    <div class="tour-card" role="dialog" aria-live="polite">
      <div class="tour-card-title"></div>
      <div class="tour-card-text"></div>
      <div class="tour-card-wait" hidden><span class="tour-spinner"></span><span class="tour-wait-label"></span></div>
      <div class="tour-card-actions"></div>
      <button type="button" class="tour-exit" aria-label="Salir de la guía" title="Salir de la guía">✕</button>
    </div>`;
  document.body.appendChild(layer);
  layer.querySelector('.tour-exit').onclick = () => tourStop(true);
  return layer;
}

function tourPositionLoop() {
  const t = _tour;
  if (!t || t.cancelled) return;
  const ring = t.layer.querySelector('.tour-ring');
  const card = t.layer.querySelector('.tour-card');
  const dim = t.layer.querySelector('.tour-dim');
  const el = t.findTarget ? t.findTarget() : null;
  const vw = window.innerWidth, vh = window.innerHeight;
  const cw = card.offsetWidth, ch = card.offsetHeight;
  if (el && el.getBoundingClientRect) {
    const r = el.getBoundingClientRect();
    const visible = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh;
    if (visible) {
      const pad = 5;
      ring.hidden = false;
      dim.hidden = true;
      ring.style.left = (r.left - pad) + 'px';
      ring.style.top = (r.top - pad) + 'px';
      ring.style.width = (r.width + pad * 2) + 'px';
      ring.style.height = (r.height + pad * 2) + 'px';
      const below = r.bottom + 14 + ch <= vh - 8;
      let top = below ? r.bottom + 14 : r.top - 14 - ch;
      top = Math.max(8, Math.min(top, vh - ch - 8));
      let left = r.left + r.width / 2 - cw / 2;
      left = Math.max(8, Math.min(left, vw - cw - 8));
      card.style.left = left + 'px';
      card.style.top = top + 'px';
      return;
    }
  }
  // Sin objetivo visible: tarjeta centrada con fondo atenuado.
  ring.hidden = true;
  dim.hidden = false;
  card.style.left = Math.max(8, (vw - cw) / 2) + 'px';
  card.style.top = Math.max(8, (vh - ch) / 2) + 'px';
}

function tourStop(userExit) {
  const t = _tour;
  if (!t) return;
  t.cancelled = true;
  clearInterval(t.posTimer);
  window.removeEventListener('resize', t.onResize);
  if (t.origFetch) window.fetch = t.origFetch;
  t.layer.remove();
  _tour = null;
  if (userExit && t.practiceId) {
    toast('La conversación de práctica quedó en tu lista; podés archivarla cuando quieras.', 'info', 5000);
  }
}

// Muestra una tarjeta y devuelve una promesa que resuelve cuando termina el paso.
// opts: title, text, target (fn → elemento), buttons [{label, value, primary}],
//       wait (fn → truthy/'back' cuando la persona hizo la acción), waitLabel,
//       auto (fn: lo que hace "Hacelo por mí"), timeoutMs
async function tourStep(opts) {
  const t = _tour;
  if (!t || t.cancelled) return 'cancel';
  const card = t.layer.querySelector('.tour-card');
  card.querySelector('.tour-card-title').textContent = opts.title || '';
  card.querySelector('.tour-card-text').innerHTML = opts.text || '';
  const waitBox = card.querySelector('.tour-card-wait');
  waitBox.hidden = !opts.waitLabel;
  card.querySelector('.tour-wait-label').textContent = opts.waitLabel || '';
  const actions = card.querySelector('.tour-card-actions');
  actions.innerHTML = '';
  t.findTarget = opts.target || null;

  const result = new Promise(resolve => {
    const buttons = [...(opts.buttons || [])];
    if (opts.auto) buttons.push({ label: 'Hacelo por mí', value: '__auto__', secondary: true });
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = b.label;
      btn.className = 'tour-btn' + (b.primary ? ' primary' : '') + (b.secondary ? ' secondary' : '');
      btn.onclick = () => {
        if (b.value === '__auto__') { try { opts.auto(); } catch (e) { toast('No se pudo: ' + e.message); } return; }
        resolve(b.value);
      };
      actions.appendChild(btn);
    }
    if (opts.wait) {
      tourWaitFor(opts.wait, opts.timeoutMs).then(r => resolve(r === null ? 'timeout' : r));
    }
  });
  tourPositionLoop();
  const out = await result;
  return _tour && !_tour.cancelled ? out : 'cancel';
}

async function runCompactTour() {
  if (_tour) tourStop(false);
  const dlg = $('help-dialog');
  if (dlg && dlg.open) dlg.close();

  const t = _tour = { cancelled: false, layer: tourBuildLayer(), findTarget: null, practiceId: null };
  t.onResize = () => tourPositionLoop();
  window.addEventListener('resize', t.onResize);
  t.posTimer = setInterval(tourPositionLoop, 250);
  // Para saber si de verdad se disparó la compactación (el menú puede cerrarse sin compactar).
  t.compactStarted = false;
  t.origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/\/conversations\/[^/]+\/compact/.test(url) && init && init.method === 'POST') t.compactStarted = true;
    } catch { /* ignorar */ }
    return t.origFetch.apply(this, arguments);
  };

  try {
    if (activePane !== 0) await goToPane(0);

    // 0 — intro
    let r = await tourStep({
      title: '🗜️ Compactar, paso a paso',
      text: 'Vamos a practicar con una <strong>conversación de prueba</strong>: la creamos, charlamos un momento y la compactamos.<br><br>Usa un poquito de tu cupo (un mensaje corto). Vos tocás los botones que te marque; si te trabás, tocá <em>Hacelo por mí</em>.',
      buttons: [{ label: 'Empezar', value: 'go', primary: true }, { label: 'Cancelar', value: 'cancel' }],
    });
    if (r !== 'go') return tourStop(false);

    // 1 — crear conversación nueva
    const startConv = currentConv;
    r = await tourStep({
      title: 'Paso 1 · Conversación nueva',
      text: 'Tocá este botón para crear una conversación nueva.',
      target: () => $('new-conv'),
      auto: () => $('new-conv').click(),
      wait: () => currentConv && currentConv !== startConv,
    });
    if (r === 'cancel') return;
    const convId = currentConv;
    t.practiceId = convId;
    api(`/conversations/${convId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(withAccountBody({ name: TOUR_PRACTICE_NAME })),
    }).then(() => { if (typeof invalidateUnifiedTreeCache === 'function') invalidateUnifiedTreeCache(); refreshVisibleTrees(); }).catch(() => {});

    // 2 — mandar un mensaje
    await tourSleep(400);
    const input = $('input');
    input.value = TOUR_PRACTICE_MSG;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    let sent = false;
    const onSubmit = () => { sent = true; };
    $('composer').addEventListener('submit', onSubmit, true);
    r = await tourStep({
      title: 'Paso 2 · Un mensaje',
      text: 'Una conversación vacía no se puede compactar: primero hace falta charlar. Ya te dejé un mensaje corto escrito — tocá <strong>Enviar</strong>.',
      target: () => $('send'),
      auto: () => $('composer').requestSubmit(),
      wait: () => sent,
    });
    $('composer').removeEventListener('submit', onSubmit, true);
    if (r === 'cancel') return;

    // 3 — esperar respuesta
    await tourSleep(800);
    r = await tourStep({
      title: 'Esperamos la respuesta',
      text: 'Claude está contestando…',
      target: () => $('messages'),
      waitLabel: 'Esperando la respuesta',
      wait: () => !busy,
      timeoutMs: 180000,
    });
    if (r === 'cancel') return;
    if (r === 'timeout') {
      toast('La respuesta tardó demasiado. Probá de nuevo más tarde.', 'info', 5000);
      return tourStop(false);
    }

    // 4 — el porcentaje de contexto
    await tourSleep(600);
    if (!$('cost-badge').hidden) {
      r = await tourStep({
        title: 'Paso 3 · El contexto',
        text: 'Este número es <strong>cuánto contexto se usó</strong> en esta conversación. Con pocos mensajes casi no se mueve; en una charla larga sube, y ahí conviene compactar.',
        target: () => $('cost-badge'),
        buttons: [{ label: 'Siguiente', value: 'next', primary: true }],
      });
      if (r === 'cancel') return;
    }

    // 5 — en celular, volver a la lista (el menú de compactar sale de la lista)
    if (tourIsMobile() && $('panel-chat').classList.contains('open')) {
      r = await tourStep({
        title: 'Volvemos a la lista',
        text: 'El menú de compactar se abre desde la lista de conversaciones. Tocá la flecha para volver.',
        target: () => $('back-btn'),
        auto: () => $('back-btn').click(),
        wait: () => !$('panel-chat').classList.contains('open'),
      });
      if (r === 'cancel') return;
    }

    // 6 + 7 — abrir el menú y tocar Compactar (si cierran el menú sin compactar, se repite)
    for (;;) {
      const row = () => tourConvRow(convId);
      r = await tourStep({
        title: 'Paso 4 · Abrí el menú',
        text: tourIsMobile()
          ? '<strong>Mantené apretada</strong> la conversación de práctica hasta que aparezca el menú.'
          : '<strong>Click derecho</strong> sobre la conversación de práctica para abrir el menú.',
        target: row,
        auto: () => { const el = row(); if (!el) throw new Error('no encuentro la conversación en la lista'); const b = el.getBoundingClientRect(); showConvMenu(b.left + 40, b.top + b.height / 2, el._conv); },
        wait: () => document.querySelector('.ctx-menu'),
      });
      if (r === 'cancel') return;

      const menuBtn = () => document.querySelector('.ctx-menu [data-action="compact"]');
      r = await tourStep({
        title: 'Paso 5 · Compactar',
        text: 'Presioná acá para <strong>compactar</strong>. La app te va a pedir confirmación: aceptala.',
        target: menuBtn,
        // Tocar la tarjeta de la guía cuenta como "click afuera" y cierra el menú: si pasó, se reabre.
        auto: () => {
          if (!menuBtn()) {
            const el = row(); if (!el) throw new Error('no encuentro la conversación en la lista');
            const b = el.getBoundingClientRect(); showConvMenu(b.left + 40, b.top + b.height / 2, el._conv);
          }
          menuBtn().click();
        },
        wait: () => t.compactStarted || (!document.querySelector('.ctx-menu') && 'back'),
      });
      if (r === 'cancel') return;
      if (r === 'back') {
        // Cerraron el menú o rechazaron el confirm: se vuelve a mostrar el paso anterior.
        if (t.compactStarted) break;
        continue;
      }
      break;
    }

    // 8 — esperar la compactación
    r = await tourStep({
      title: 'Esperamos la compactación',
      text: 'Claude está resumiendo toda la conversación. En charlas largas puede tardar un buen rato; acá es rápido.',
      target: () => tourConvRow(convId),
      waitLabel: 'Compactando…',
      wait: () => document.querySelector('#messages .compact-divider'),
      timeoutMs: 240000,
    });
    if (r === 'cancel') return;
    if (r === 'timeout') {
      toast('La compactación tardó demasiado o falló. Revisá la conversación de práctica.', 'info', 6000);
      return tourStop(false);
    }

    // 9 — mostrar el resultado (en celular hay que abrir la conversación)
    if (tourIsMobile() && !$('panel-chat').classList.contains('open')) {
      r = await tourStep({
        title: '¡Listo!',
        text: 'Terminó. Tocá la conversación para ver cómo quedó.',
        target: () => tourConvRow(convId),
        auto: () => { const el = tourConvRow(convId); if (el) el.click(); },
        wait: () => $('panel-chat').classList.contains('open'),
      });
      if (r === 'cancel') return;
      await tourSleep(500);
    }
    const divider = () => [...document.querySelectorAll('#messages .compact-divider')].pop();
    const d = divider();
    if (d) d.scrollIntoView({ block: 'center' });
    r = await tourStep({
      title: '✅ Compactada',
      text: 'Esta línea marca el momento: la conversación quedó <strong>limpia y con un resumen de todo lo que hicimos antes</strong>. Los números muestran cuánto contexto se liberó.',
      target: divider,
      buttons: [{ label: 'Siguiente', value: 'next', primary: true }],
    });
    if (r === 'cancel') return;

    // 10 — datos de interés
    r = await tourStep({
      title: '💡 Datos de interés',
      text: '<ul><li><strong>Cada compactación pierde detalles</strong> (palabras exactas, código largo que ya se leyó). Lo importante queda.</li><li><strong>No es recomendable compactar más de 2 veces la misma conversación</strong>: el resumen de un resumen se va degradando. Si ya compactaste dos veces, abrí una conversación nueva y pasale lo esencial en un mensaje.</li><li>Si cambiás de tema, no compactes: abrí una conversación nueva.</li></ul>',
      buttons: [
        { label: 'Archivar la práctica', value: 'archive', primary: true },
        { label: 'Dejarla', value: 'keep' },
      ],
    });
    if (r === 'cancel') return;
    if (r === 'archive') {
      try {
        await api(`/conversations/${convId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(withAccountBody({ archived: true })),
        });
        if (typeof invalidateUnifiedTreeCache === 'function') invalidateUnifiedTreeCache();
        refreshVisibleTrees();
        toast('Conversación de práctica archivada', 'info', 3000);
      } catch (err) { toast('No se pudo archivar: ' + err.message); }
    }
    t.practiceId = null;
    tourStop(false);
  } catch (err) {
    toast('La guía se interrumpió: ' + err.message);
    tourStop(false);
  }
}

const TOURS = { compact: runCompactTour };
function startTour(name) { const fn = TOURS[name]; if (fn) fn(); }
