// ── Agenda: semáforo de tareas recurrentes mensuales (07/09/2026) ──
// Extraído de app.js (split por dominio, sesión 15/09/2026).
// Script clásico (no ES module): comparte el scope global con el resto de los scripts.

let agendaListLoaded = false;
let agendaTasks = [];

// Catálogo fijo del lado del servidor (agenda.js). Acá solo se pinta y se
// disparan las acciones. La única tarea con automatización real hoy es
// Estadístico Contratista (pedirle la nómina a Macarena por Outlook clásico
// vía COM — nunca se manda sola, siempre se abre en Outlook para que
// Fernando revise y apriete Enviar él mismo).
const AGENDA_COLOR_LABEL = { verde: 'Hecho', amarillo: 'Pendiente', naranja: 'Por vencer', rojo: 'Vencida', esperando: 'Esperando' };

async function loadAgendaList() {
  const { tasks } = await api('/agenda');
  agendaTasks = tasks;
  renderAgendaList();
  updateAgendaBadge(tasks);
}

// Badge en la pestaña "Agenda" (visible sin entrar a la sección) — cuenta
// vencidas (🔴) + por vencer (🟠), así avisa ANTES de que se pase la fecha,
// no solo cuando ya es tarde. Rojo si hay al menos una vencida, naranja si
// solo hay "por vencer". Se llama al abrir la Agenda y también solo
// (startup + cada 10 min) para que se vea aunque estés en Chats.
function updateAgendaBadge(tasks) {
  const rojas = tasks.filter(t => t.color === 'rojo').length;
  const naranjas = tasks.filter(t => t.color === 'naranja').length;
  const total = rojas + naranjas;
  const badge = $('agenda-badge');
  if (total > 0) {
    badge.textContent = String(total);
    badge.classList.toggle('tab-badge-naranja', rojas === 0);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

async function refreshAgendaBadge() {
  try {
    const { tasks } = await api('/agenda');
    agendaTasks = tasks;
    updateAgendaBadge(tasks);
  } catch { /* noop: no es crítico, se reintenta solo en el próximo tick */ }
}

// ── "🎓 Aprender rutina nueva" — enseñar una tarea recurrente por CHAT ──
// Fernando pidió esto en vez del formulario de 3 campos que había antes
// (07/09/2026): "tengo que tener el chat así podemos ver, pasar link, y si
// está todo bien o no" — enseñar una rutina real necesita ida y vuelta
// (pegar links, capturas, aclarar pasos), no un formulario. Así que este
// botón abre una conversación real nueva (mismo mecanismo que "+ Nueva
// conversación") con un mensaje inicial que le explica a esa sesión cómo
// registrar la tarea en el catálogo una vez que quede clara.
const AGENDA_LEARN_PROMPT = `Te quiero enseñar una rutina nueva para la pestaña Agenda de FerStark (semáforo de tareas recurrentes mensuales).

Preguntame lo que haga falta — puedo pegarte links, capturas, explicarte los pasos. Cuando ya tengas claro de qué se trata (nombre, si tiene un día fijo del mes o no, y qué grupo la agrupa), agregala vos mismo al catálogo: es el módulo \`src/agenda.js\` dentro de \`/mnt/c/Users/Fernando/Desktop/claude/claude-chat-manager/\`, tiene una función \`addCustomTask({title, group, day, kind, insumoNota})\` — la podés invocar con \`node -e\` desde esa carpeta. Confirmame cuando quedó guardada (no hace falta reiniciar FerStark para que aparezca, ese catálogo se lee de un JSON en vivo).

Empecemos: contame qué rutina es.`;

// Abre una conversación real nueva (mismo mecanismo que "+ Nueva
// conversación") y le manda un primer mensaje ya armado — reusado tanto por
// "Aprender rutina nueva" como por "▶️ Hacer ahora" en cada tarjeta con
// autoPrompt (ver agenda.js). Devuelve el convId por si hace falta encadenar algo.
async function agendaSpawnConversation(promptText, project) {
  const { convId, projectDir } = await api('/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withAccountBody({ project })),
  });
  await selectConv(convId, 'Nueva conversación', undefined, null, projectDir);
  await performSend(convId, promptText, []);
  return convId;
}

async function agendaLearnNewRoutine() {
  const btn = $('agenda-learn-btn');
  btn.disabled = true;
  try {
    await agendaSpawnConversation(AGENDA_LEARN_PROMPT, 'Agenda');
  } catch (err) {
    toast('No se pudo abrir el chat: ' + err.message);
  } finally {
    btn.disabled = false;
  }
}

// Dispara el trabajo real de una tarea del catálogo (hoy: las 2 facturas).
// El prompt ya trae adentro la instrucción de marcarse "hecho" sola al
// terminar (ver MARK_DONE_CMD en agenda.js) — este botón solo abre el chat.
// Si la tarea tiene checklist con estado por ítem, no repetir lo que ya está
// hecho — armar un prompt que abra la conversación pidiendo SOLO lo que sigue
// gris, y le suma la guía completa del autoPrompt como referencia de cómo
// hacer cada cosa (accesos, formato, dónde subir). Pedido de Fernando
// 09/09/2026: "si aprieto en ferzep solo me va a pedir el recibo de sueldo o
// me va a empezar la rutina de cero" — antes empezaba siempre de cero.
function agendaBuildRunPrompt(task) {
  if (!Array.isArray(task.checklistState) || !task.checklistState.length) {
    return task.autoPrompt; // sin checklist por ítem, comportamiento de siempre
  }
  const withIndex = task.checklistState.map((item, i) => ({ ...item, i }));
  const pending = withIndex.filter(i => !i.done);
  if (pending.length === 0) return null; // ya está todo hecho, no hay nada que pedir
  const done = withIndex.filter(i => i.done);
  const markItemCmd = i =>
    `cd /mnt/c/Users/Fernando/Desktop/claude/claude-chat-manager && node -e "require('./src/agenda').markItem('${task.id}', ${i}, true)"`;
  let prompt = '';
  if (done.length) {
    prompt += `De "${task.title}" esto ya está hecho este mes, NO lo vuelvas a hacer ni lo reproceses:\n`;
    prompt += done.map(i => `- ${i.text}${i.doneAt ? ` (${agendaFormatDoneDate(i.doneAt)})` : ''}`).join('\n');
    prompt += '\n\n';
  }
  prompt += `Falta SOLO esto:\n${pending.map(i => `- ${i.text}`).join('\n')}\n\n`;
  prompt += `Guía completa de la tarea (accesos, formato, dónde subir cada cosa — usala como referencia, pero hacé nada más que lo que falta arriba):\n\n${task.autoPrompt}\n\n`;
  prompt += `IMPORTANTE — marcado: ignorá el comando de "marcá la tarea como hecha" que pueda aparecer en la guía de arriba (es para cuando se arranca de cero y tildaría de vuelta lo que ya estaba hecho, pisando esas fechas). En cambio, a medida que termines cada ítem de la lista de arriba, corré el comando de ESE ítem puntual:\n`;
  prompt += pending.map(i => `- ${i.text} →\n  ${markItemCmd(i.i)}`).join('\n');
  return prompt;
}

async function agendaRunTask(id) {
  const task = agendaTasks.find(t => t.id === id);
  if (!task || !task.autoPrompt) return toast('Esta tarea no tiene automatización todavía');
  const prompt = agendaBuildRunPrompt(task);
  if (prompt === null) return toast('Ya está todo hecho este mes ✅');
  try {
    await agendaSpawnConversation(prompt, task.group);
  } catch (err) {
    toast('No se pudo abrir el chat: ' + err.message);
  }
}

async function agendaDeleteLearnedTask(id) {
  if (!confirm('¿Borrar esta rutina aprendida?')) return;
  try {
    await api(`/agenda/tasks/${id}`, { method: 'DELETE' });
    await loadAgendaList();
  } catch (err) { toast('No se pudo borrar: ' + err.message); }
}

function agendaCardActions(task) {
  if (task.id === 'estadistico_contratista') {
    return `
      <div class="agenda-actions">
        <button type="button" onclick="agendaPrepareMacarena()">✉️ Pedir nómina</button>
        <button type="button" onclick="agendaCheckMacarena()">🔄 ¿Contestó?</button>
      </div>
      <div class="agenda-draft" id="agenda-macarena-draft" hidden></div>
    `;
  }
  const label = task.state === 'hecho' ? '↩️ Desmarcar' : '✅ Marcar hecho';
  // "Marcar hecho" queda siempre como fallback manual (por si lo resolviste
  // por otro lado), pero si la tarea tiene autoPrompt sumamos el botón real
  // que abre un chat y hace el trabajo — mismo mecanismo que "Aprender
  // rutina nueva" (spawnear una conversación real con un prompt armado).
  const runBtn = task.autoPrompt ? `<button type="button" class="primary" onclick="agendaRunTask('${task.id}')">▶️ Hacer ahora</button>` : '';
  return `<div class="agenda-actions">${runBtn}<button type="button" onclick="agendaToggleDone('${task.id}', ${task.state !== 'hecho'})">${label}</button></div>`;
}

function renderAgendaList() {
  const wrap = $('agenda-list');
  wrap.innerHTML = '';
  if (agendaTasks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'notes-empty';
    empty.textContent = 'Sin tareas cargadas.';
    wrap.appendChild(empty);
    return;
  }
  let lastGroup = null;
  for (const task of agendaTasks) {
    if (task.group !== lastGroup) {
      const h = document.createElement('div');
      h.className = 'agenda-group-title';
      h.textContent = task.group;
      wrap.appendChild(h);
      lastGroup = task.group;
    }
    const card = document.createElement('div');
    card.className = 'agenda-card';
    card.id = `agenda-card-${task.id}`;
    const dayMeta = task.day != null ? `Día ${task.day}` : (task.insumoNota || '');
    card.innerHTML = `
      <div class="agenda-card-top">
        <span class="agenda-dot ${task.color}" title="${AGENDA_COLOR_LABEL[task.color] || ''}"></span>
        <span class="agenda-title"></span>
        ${task.learned ? `<button type="button" class="agenda-delete-btn" title="Borrar rutina aprendida" onclick="agendaDeleteLearnedTask('${task.id}')">🗑️</button>` : ''}
      </div>
      <div class="agenda-meta"></div>
      ${Array.isArray(task.checklist) && task.checklist.length ? '<ul class="agenda-checklist"></ul>' : ''}
      ${agendaCardActions(task)}
    `;
    card.querySelector('.agenda-title').textContent = task.title;
    card.querySelector('.agenda-meta').textContent = dayMeta;
    // Checklist visible en la tarjeta (pedido de Fernando 08/09/2026: "esto
    // tiene que ser una guía"). Desde 09/09/2026 cada ítem tiene su propio
    // estado: dot verde + fecha cuando está hecho, gris cuando falta — clic
    // en el dot lo tilda/destilda sin tener que abrir la tarea entera. Ya sé
    // lo que hicimos (queda cargado desde acá o desde markDone en bloque),
    // así que solo hace falta preguntarle a Fernando por lo que sigue gris.
    // textContent por ítem, no innerHTML, para no depender de escapear bien
    // texto con tildes/símbolos.
    const ul = card.querySelector('.agenda-checklist');
    if (ul && Array.isArray(task.checklistState)) {
      task.checklistState.forEach((item, i) => {
        const li = document.createElement('li');
        li.className = 'agenda-checklist-item';
        const dot = document.createElement('span');
        dot.className = `agenda-checklist-dot ${item.done ? 'verde' : 'gris'}`;
        dot.title = item.done ? 'Hecho — clic para destildar' : 'Pendiente — clic para marcar hecho';
        dot.onclick = () => agendaToggleItemDone(task.id, i, !item.done);
        const label = document.createElement('span');
        label.textContent = item.done && item.doneAt
          ? `${item.text} — ${agendaFormatDoneDate(item.doneAt)}`
          : item.text;
        li.appendChild(dot);
        li.appendChild(label);
        ul.appendChild(li);
      });
    } else if (ul) {
      for (const item of task.checklist) {
        const li = document.createElement('li');
        li.textContent = item;
        ul.appendChild(li);
      }
    }
    wrap.appendChild(card);
  }
}

async function agendaToggleDone(id, done) {
  try {
    await api(`/agenda/${id}/done`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done }) });
    await loadAgendaList();
  } catch (err) { toast('No se pudo actualizar: ' + err.message); }
}

// Tilde/destilde de un ítem puntual del checklist (ver agenda.markItem en el
// server). Si con esto quedan todos los ítems hechos, la tarjeta pasa a
// verde sola — no hace falta tocar el botón "Marcar hecho" aparte.
async function agendaToggleItemDone(id, index, done) {
  try {
    await api(`/agenda/${id}/items/${index}/done`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done }) });
    await loadAgendaList();
  } catch (err) { toast('No se pudo actualizar el ítem: ' + err.message); }
}

function agendaFormatDoneDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
}

// Pide el texto propuesto al server (busca el hilo de Maca por Outlook COM)
// y lo muestra en un textarea editable — todavía no toca Outlook.
async function agendaPrepareMacarena() {
  const box = $('agenda-macarena-draft');
  box.hidden = false;
  box.innerHTML = '<div class="agenda-meta">Buscando el hilo en Outlook…</div>';
  try {
    const data = await api('/agenda/macarena/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    box.innerHTML = `
      ${data.warning ? `<div class="agenda-warning">${data.warning}</div>` : `<div class="agenda-meta">Responde a: "${data.subject}"</div>`}
      <textarea id="agenda-macarena-text">${data.proposedText}</textarea>
      <div class="agenda-actions">
        <button type="button" class="primary" onclick="agendaSendMacarena('${data.entryId || ''}')" ${data.entryId ? '' : 'disabled'}>📤 Abrir en Outlook</button>
        <button type="button" onclick="$('agenda-macarena-draft').hidden = true">Cancelar</button>
      </div>
    `;
  } catch (err) {
    box.innerHTML = `<div class="agenda-warning">No se pudo conectar con Outlook: ${err.message}. ¿Está Outlook clásico abierto?</div>`;
  }
}

// Recién acá se abre Outlook — con el texto que el usuario ya revisó/editó
// en el textarea. Outlook se queda con la ventana de respuesta abierta sin
// enviar; el envío lo hace Fernando a mano.
async function agendaSendMacarena(entryId) {
  const text = $('agenda-macarena-text').value.trim();
  if (!text) return toast('El texto está vacío');
  try {
    await api('/agenda/macarena/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entryId, text }) });
    toast('Abrí Outlook y revisá antes de mandar');
    $('agenda-macarena-draft').hidden = true;
    await loadAgendaList();
  } catch (err) { toast('No se pudo abrir Outlook: ' + err.message); }
}

async function agendaCheckMacarena() {
  try {
    const data = await api('/agenda/macarena/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    toast(data.replied ? '¡Maca contestó! Revisá el mail.' : 'Todavía no contestó.');
    await loadAgendaList();
  } catch (err) { toast('No se pudo chequear: ' + err.message); }
}

refreshAgendaBadge();
setInterval(refreshAgendaBadge, 10 * 60 * 1000);
