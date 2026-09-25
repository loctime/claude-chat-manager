// ── Diálogo de Configuración (fuentes, voces, colores, llaves de API y servidor) ──
// Extraído de app.js (split por dominio, sesión 15/09/2026).
// Script clásico (no ES module): comparte el scope global con el resto de los scripts.

function populateFontOptions() {
  const sel = $('cfg-font-family');
  sel.innerHTML = '';
  for (const f of FONT_FAMILY_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = f.value;
    opt.textContent = f.label;
    opt.style.fontFamily = f.stack;
    sel.appendChild(opt);
  }
}
populateFontOptions();

// El <select> de tipografía queda oculto (ver index.html) — un <option> con
// font-family inline no se renderiza en la mayoría de los pickers nativos
// mobile (Android ignora el CSS del option), así que la vista previa real
// vive en este botón + el menú de showFontMenu(), no en el <select> nativo.
// El <select> se sigue usando como fuente de verdad del valor (dispara
// "change" como siempre) para no tocar el resto de applySettings/saveSettings.
function updateFontTrigger() {
  const val = $('cfg-font-family').value;
  const opt = FONT_FAMILY_OPTIONS.find(f => f.value === val) || FONT_FAMILY_OPTIONS[0];
  const btn = $('cfg-font-family-btn');
  btn.textContent = opt.label;
  btn.style.fontFamily = opt.stack;
}

function showFontMenu() {
  document.querySelectorAll('.ctx-menu.font-menu').forEach(m => m.remove());
  const trigger = $('cfg-font-family-btn');
  const current = $('cfg-font-family').value;
  const menu = document.createElement('div');
  menu.className = 'ctx-menu font-menu';
  menu.innerHTML = FONT_FAMILY_OPTIONS.map(f => `
    <button type="button" data-value="${f.value}" class="${f.value === current ? 'active' : ''}" style="font-family:${f.stack.replace(/"/g, '&quot;')}">${f.label}</button>
  `).join('');
  // Colgado del propio <dialog>, no de document.body: un <dialog> abierto
  // con showModal() pinta en el "top layer" del navegador, por encima de
  // TODO el resto del documento sin importar z-index — un menú colgado de
  // document.body quedaría tapado detrás del modal. Adentro del dialog sí
  // se ve, y position:fixed lo saca igual del scroll del body.
  $('settings-dialog').appendChild(menu);
  const rect = trigger.getBoundingClientRect();
  menu.style.width = rect.width + 'px';
  const menuRect = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - menuRect.width - 8)) + 'px';
  menu.style.top = Math.min(rect.bottom + 4, window.innerHeight - menuRect.height - 8) + 'px';

  menu.addEventListener('click', e => {
    e.stopPropagation();
    const btn = e.target.closest('button[data-value]');
    if (!btn) return;
    const sel = $('cfg-font-family');
    sel.value = btn.dataset.value;
    sel.dispatchEvent(new Event('change'));
    updateFontTrigger();
    menu.remove();
  });
  menu.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });

  function dismiss(e) {
    if (menu.contains(e.target)) return;
    menu.remove();
    document.removeEventListener('click', dismiss, true);
    document.removeEventListener('touchstart', dismiss, true);
  }
  // Delay para saltear el click sintético del touchend que abrió el menú.
  setTimeout(() => {
    document.addEventListener('click', dismiss, true);
    document.addEventListener('touchstart', dismiss, true);
  }, 350);
}
$('cfg-font-family-btn').onclick = showFontMenu;

function populateVoices() {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return;
  const sorted = [...voices].sort((a, b) => {
    const aEs = a.lang.startsWith('es') ? 0 : 1;
    const bEs = b.lang.startsWith('es') ? 0 : 1;
    return aEs - bEs || a.name.localeCompare(b.name);
  });
  const sel = $('cfg-voice');
  const current = sel.value;
  sel.innerHTML = '<option value="">Default del sistema</option>';
  for (const v of sorted) {
    const opt = document.createElement('option');
    opt.value = v.name;
    opt.textContent = `${v.name} (${v.lang})`;
    sel.appendChild(opt);
  }
  sel.value = current;
}
if ('speechSynthesis' in window) {
  populateVoices();
  speechSynthesis.onvoiceschanged = populateVoices;
}

function readComputedColor(varName) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  // <input type="color"> exige formato #rrggbb
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  if (/^#[0-9a-f]{3}$/i.test(v)) return '#' + v.slice(1).split('').map(c => c + c).join('');
  return '#000000';
}

// Puntito + nombre del header de Configuración, coloreado en vivo con lo
// que se está eligiendo/escribiendo — el guardado real de Nombre/Color de
// identidad es server-side (ver los .onchange de abajo) y pide reiniciar el
// server para verse de verdad en el ícono/tema, así que esto es solo una
// vista previa a ojo mientras se elige, no reemplaza esa aplicación real.
function updateNamePreview() {
  const name = $('cfg-app-name').value.trim() || APP_NAME;
  const color = $('cfg-app-color').value || APP_COLOR;
  $('cfg-name-preview-dot').style.background = color;
  $('cfg-name-preview-text').textContent = name;
}

function openSettings() {
  $('cfg-app-name').value = APP_NAME;
  $('cfg-user-name').value = USER_NAME;
  $('cfg-app-color').value = APP_COLOR;
  updateNamePreview();
  $('cfg-show-tools').checked = settings.showTools;
  $('cfg-show-archived-pane').checked = settings.showArchivedPane;
  $('cfg-show-codex-pane').checked = settings.showCodexPane;
  $('cfg-show-agy-pane').checked = settings.showAgYPane;
  $('cfg-show-notes-pane').checked = settings.showNotesPane;
  $('cfg-show-task-pane').checked = settings.showTaskPane;
  $('cfg-show-sala-pane').checked = settings.showSalaPane;
  $('cfg-voice').value = settings.voice;
  $('cfg-color-accent').value = settings.colorAccent || readComputedColor('--accent');
  $('cfg-color-codex').value = settings.colorCodex || readComputedColor('--codex-accent');
  $('cfg-color-antigravity').value = settings.colorAntigravity || readComputedColor('--antigravity-accent');
  $('cfg-color-me').value = settings.colorMe || readComputedColor('--bubble-me');
  $('cfg-color-ai').value = settings.colorAi || readComputedColor('--bubble-ai');
  $('cfg-font-family').value = settings.fontFamily;
  updateFontTrigger();
  $('cfg-font-size').value = settings.fontSize;
  // La key en sí nunca vuelve del server (solo el booleano groqApiKeySet) —
  // el campo arranca siempre vacío para no exponerla ni pisarla por
  // accidente, y updateGroqKeyStatus() avisa si ya hay una guardada.
  $('cfg-groq-key').value = '';
  updateGroqKeyStatus();
  $('cfg-sala-url').value = SALA_URL;
  $('cfg-sala-token').value = '';
  updateSalaTokenStatus();
  loadVoiceSettings();
  $('settings-dialog').showModal();
}

// Panel "Voces" — reemplaza los accesos directos sueltos del escritorio
// ("Voz Claude/Codex/AgY"). No cachea nada localmente a propósito: se puede
// haber tocado un icono viejo o el panel desde otro dispositivo, así que se
// lee fresco cada vez que se abre Configuración.
// Nombre lindo para cada voz de edge-tts — el select del server solo manda
// el id crudo (`options`, mismo whitelist que valida el PATCH).
const VOICE_NAME_LABELS = {
  'es-AR-ElenaNeural': 'Elena (Argentina)', 'es-AR-TomasNeural': 'Tomás (Argentina)',
  'es-UY-ValentinaNeural': 'Valentina (Uruguay)', 'es-UY-MateoNeural': 'Mateo (Uruguay)',
  'es-MX-DaliaNeural': 'Dalia (México)', 'es-MX-JorgeNeural': 'Jorge (México)',
  'es-ES-ElviraNeural': 'Elvira (España)', 'es-ES-AlvaroNeural': 'Álvaro (España)', 'es-ES-XimenaNeural': 'Ximena (España)',
  'es-CO-SalomeNeural': 'Salomé (Colombia)', 'es-CO-GonzaloNeural': 'Gonzalo (Colombia)',
  'es-CL-CatalinaNeural': 'Catalina (Chile)', 'es-CL-LorenzoNeural': 'Lorenzo (Chile)',
  'es-PY-TaniaNeural': 'Tania (Paraguay)', 'es-PY-MarioNeural': 'Mario (Paraguay)',
  'es-VE-PaolaNeural': 'Paola (Venezuela)', 'es-VE-SebastianNeural': 'Sebastián (Venezuela)',
  'es-PE-CamilaNeural': 'Camila (Perú)', 'es-PE-AlexNeural': 'Alex (Perú)',
  'es-US-PalomaNeural': 'Paloma (EE.UU.)', 'es-US-AlonsoNeural': 'Alonso (EE.UU.)',
};

async function loadVoiceSettings() {
  let data;
  try { data = await api('/voice-settings'); }
  catch (err) { toast('No se pudo leer el estado de las voces: ' + err.message); return; }
  for (const row of document.querySelectorAll('.voice-row')) {
    const info = data.voices[row.dataset.voice];
    if (!info) continue;
    const select = row.querySelector('.voice-select');
    if (!select.options.length) {
      for (const id of data.options) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = VOICE_NAME_LABELS[id] || id;
        select.appendChild(opt);
      }
    }
    select.value = info.name;
    row.querySelector('.voice-on-toggle').checked = info.on;
    row.querySelector('.voice-volume').value = info.volume;
    row.querySelector('.voice-volume-pct').textContent = info.volume + '%';
    row.classList.toggle('voice-off', !info.on);
  }
}

async function patchVoiceSetting(voice, patch) {
  try {
    await api(`/voice-settings/${voice}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  } catch (err) {
    toast('No se pudo guardar: ' + err.message);
  }
}

for (const row of document.querySelectorAll('.voice-row')) {
  const voice = row.dataset.voice;
  const toggle = row.querySelector('.voice-on-toggle');
  const slider = row.querySelector('.voice-volume');
  const pct = row.querySelector('.voice-volume-pct');
  const select = row.querySelector('.voice-select');
  toggle.addEventListener('change', () => {
    row.classList.toggle('voice-off', !toggle.checked);
    patchVoiceSetting(voice, { on: toggle.checked });
  });
  // 'input' solo actualiza el número mientras arrastrás (feedback instantáneo);
  // el PATCH real va en 'change' (soltar el slider), no en cada tick del drag.
  slider.addEventListener('input', () => { pct.textContent = slider.value + '%'; });
  slider.addEventListener('change', () => { patchVoiceSetting(voice, { volume: Number(slider.value) }); });
  select.addEventListener('change', () => { patchVoiceSetting(voice, { name: select.value }); });
}

// Placeholder + badge "✓ Configurada" junto al label — dos señales para lo
// mismo porque el placeholder solo (gris, desaparece al enfocar el campo)
// no alcanzaba para que se notara a simple vista si ya había una key.
function updateGroqKeyStatus() {
  $('cfg-groq-key').placeholder = GROQ_KEY_SET ? '•••••••• (guardada)' : 'gsk_...';
  $('cfg-groq-key-status').hidden = !GROQ_KEY_SET;
}

function updateSalaTokenStatus() {
  $('cfg-sala-token').placeholder = SALA_TOKEN_SET ? '•••••••• (guardado)' : '•••';
  $('cfg-sala-token-status').hidden = !SALA_TOKEN_SET;
}

$('settings-btn').onclick = openSettings;
$('cfg-app-name').addEventListener('input', updateNamePreview);
$('cfg-app-color').addEventListener('input', updateNamePreview);
// Cerrar tocando afuera (el backdrop): un click que cae en el propio
// <dialog> (no en un descendiente) solo puede venir del backdrop, porque
// #settings-form ocupa 100% de la caja del dialog — no queda "aire" propio
// del dialog para clickear. En mobile el dialog es pantalla completa (no
// hay backdrop visible), así que ahí este listener simplemente nunca dispara.
$('settings-dialog').addEventListener('click', e => {
  if (e.target === e.currentTarget) $('settings-dialog').close();
});

// Nombre: no es localStorage como el resto de esta pantalla — vive en el
// server (~/.ccm-config.json), así que el título/manifest de la PWA sale
// igual para cualquier dispositivo que entre a esta misma instancia. Guarda
// al perder foco (blur/Enter), mismo patrón que el rename de conversación.
$('cfg-app-name').onchange = async e => {
  const name = e.target.value.trim();
  try {
    const { appName } = await api('/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appName: name }),
    });
    APP_NAME = appName;
    e.target.value = appName;
    updateGlobalBusyIndicator();
    toast('Nombre guardado — recargá para verlo en el título de la pestaña y reinstalá la PWA para el ícono/nombre de app instalada', 'info', 5000);
  } catch (err) {
    toast('No se pudo guardar el nombre: ' + err.message);
  }
};

// Tu nombre: mismo patrón que cfg-app-name (server-side, guarda al perder
// foco). Se usa como etiqueta de tus mensajes en "Copiar conversación".
$('cfg-user-name').onchange = async e => {
  const name = e.target.value.trim();
  try {
    const { userName } = await api('/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: name }),
    });
    USER_NAME = userName;
    e.target.value = userName;
    toast('Nombre guardado', 'info', 2000);
  } catch (err) {
    toast('No se pudo guardar tu nombre: ' + err.message);
  }
};

// API key de Groq (respuestas sugeridas): mismo patrón server-side que los
// dos de arriba. Vacío = apaga la feature (config.js borra el campo). No
// hace falta reiniciar el server — se lee del archivo en cada request.
$('cfg-groq-key').onchange = async e => {
  const key = e.target.value.trim();
  try {
    const { groqApiKeySet } = await api('/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groqApiKey: key }),
    });
    GROQ_KEY_SET = !!groqApiKeySet;
    e.target.value = '';
    updateGroqKeyStatus();
    toast(GROQ_KEY_SET ? 'Key guardada' : 'Key borrada — respuestas sugeridas apagadas', 'info', 2500);
  } catch (err) {
    toast('No se pudo guardar la key de Groq: ' + err.message);
  }
};

// Sala compartida: URL + token, mismo patrón server-side que appName/groqApiKey.
$('cfg-sala-url').onchange = async e => {
  const url = e.target.value.trim();
  try {
    const { salaUrl } = await api('/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ salaUrl: url }),
    });
    SALA_URL = salaUrl || '';
    e.target.value = SALA_URL;
    toast('URL de la sala guardada', 'info', 2000);
  } catch (err) {
    toast('No se pudo guardar la URL de la sala: ' + err.message);
  }
};

$('cfg-sala-token').onchange = async e => {
  const token = e.target.value.trim();
  try {
    const { salaTokenSet } = await api('/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ salaToken: token }),
    });
    SALA_TOKEN_SET = !!salaTokenSet;
    e.target.value = '';
    updateSalaTokenStatus();
    toast(SALA_TOKEN_SET ? 'Token guardado' : 'Token borrado — la Sala queda sin configurar', 'info', 2500);
  } catch (err) {
    toast('No se pudo guardar el token de la sala: ' + err.message);
  }
};

// Color de identidad: mismo patrón server-side que el nombre de arriba (no
// localStorage, vive en ~/.ccm-config.json) — a diferencia del "Acento" de
// más abajo, que es un ajuste personal por dispositivo. Este además
// regenera los íconos de la PWA en el server (ver /api/config en server.js).
$('cfg-app-color').onchange = async e => {
  const color = e.target.value;
  try {
    const { appColor, iconOk } = await api('/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appColor: color }),
    });
    APP_COLOR = appColor;
    e.target.value = appColor;
    if (iconOk) {
      toast('Color guardado — recargá para verlo en la interfaz y reinstalá la PWA para el ícono', 'info', 5000);
    } else {
      // ImageMagick no encontrado en el PATH de esta cuenta de Windows (u
      // otro fallo al regenerar el PNG) — el color de la interfaz sí quedó
      // guardado, pero el ícono de la PWA se va a seguir viendo con el
      // verde default hasta que se resuelva del lado del server.
      toast('Color guardado, pero no se pudo generar el ícono nuevo (¿ImageMagick instalado en esta cuenta?) — la interfaz sí cambia', 'error', 8000);
    }
  } catch (err) {
    toast('No se pudo guardar el color: ' + err.message);
  }
};

$('cfg-show-tools').onchange = e => {
  settings.showTools = e.target.checked;
  applySettings(); saveSettings();
};
const PANE_TOGGLE_SETTINGS = {
  'cfg-show-archived-pane': 'showArchivedPane',
  'cfg-show-codex-pane': 'showCodexPane',
  'cfg-show-agy-pane': 'showAgYPane',
  'cfg-show-notes-pane': 'showNotesPane',
  'cfg-show-task-pane': 'showTaskPane',
  'cfg-show-sala-pane': 'showSalaPane',
};
for (const [inputId, setting] of Object.entries(PANE_TOGGLE_SETTINGS)) {
  $(inputId).onchange = e => {
    settings[setting] = e.target.checked;
    applySettings(); saveSettings();
  };
}
// Una sola voz para mensajes propios y del agente. Elegirla reproduce sola
// una muestra corta (previewVoice, tts.js) — no hace falta un botón aparte.
$('cfg-voice').onchange = e => {
  settings.voice = e.target.value; saveSettings();
  previewVoice(e.target);
};
$('cfg-color-accent').oninput = e => { settings.colorAccent = e.target.value; applySettings(); saveSettings(); };
$('cfg-color-codex').oninput = e => { settings.colorCodex = e.target.value; applySettings(); saveSettings(); };
$('cfg-color-antigravity').oninput = e => { settings.colorAntigravity = e.target.value; applySettings(); saveSettings(); };
$('cfg-color-me').oninput = e => { settings.colorMe = e.target.value; applySettings(); saveSettings(); };
$('cfg-color-ai').oninput = e => { settings.colorAi = e.target.value; applySettings(); saveSettings(); };
$('cfg-font-family').onchange = e => { settings.fontFamily = e.target.value; applySettings(); saveSettings(); };
$('cfg-font-size').onchange = e => { settings.fontSize = e.target.value; applySettings(); saveSettings(); };

// Reinicio del server (toma código nuevo tras un git pull) — ver /api/restart
// en server.js. netFetch/api normal no sirve acá: el server responde igual,
// pero se muere unos milisegundos después de mandar la respuesta, así que la
// conexión puede leerse como error de red aunque el restart haya salido bien
// — por eso el catch de abajo no muestra error, solo el then es best-effort.
$('cfg-restart-btn').onclick = async () => {
  if (!confirm('Reiniciar el server?\n\nHace git pull y reinicia con el código nuevo. Si el pull no se puede (cambios sin commitear o falla), reinicia igual con el código actual y te deja una conversación nueva contándote qué pasó. Se corta la conexión unos segundos y después hay que recargar la página a mano.')) return;
  toast('Reiniciando server…', 'info', 6000);
  try {
    await fetch('/api/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  } catch {
    // Esperado: el server puede cerrar la conexión antes de que el fetch
    // termine de leer la respuesta. No es un error real, ver comentario arriba.
  }
};

// Apagado remoto de la PC — ver /api/shutdown-pc en server.js. Doble
// confirmación (confirm() acá + el /t 20 del lado del server) porque no hay
// vuelta atrás fácil una vez que Windows empieza a cerrar sesión.
$('cfg-shutdown-btn').onclick = async () => {
  if (!confirm('Apagar la PC?\n\nEsto corta esta conversación y todo lo que esté abierto en esa máquina. Hay ~20s de margen antes de que se apague de verdad.')) return;
  toast('Apagando la PC en 20s…', 'info', 6000);
  try {
    const r = await fetch('/api/shutdown-pc', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const data = await r.json();
    if (!r.ok) toast(data.error || 'no se pudo apagar', 'error', 5000);
  } catch {
    // Igual que /api/restart: el server puede cortar la conexión antes de
    // que el fetch termine de leer, no es necesariamente un error real.
  }
};

$('cfg-reset').onclick = () => {
  // Confirm agregado al pasar el botón a ícono (perdió el texto "Restaurar"
  // que antes avisaba qué hacía) — pierde voz, colores, tipografía, todo.
  if (!confirm('Restaurar la configuración a los valores por defecto?\n\nSe pierden la voz, los colores, la tipografía y el tamaño de letra elegidos.')) return;
  Object.assign(settings, DEFAULT_SETTINGS);
  applySettings(); saveSettings();
  openSettings();
  toast('Configuración restaurada', 'info', 2000);
};
