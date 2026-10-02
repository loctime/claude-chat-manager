const $ = id => document.getElementById(id);

async function login(pin) {
  const r = await fetch('/__auth/slot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'error de login');
}

function renderMessages(messages) {
  const el = $('messages');
  el.innerHTML = '';
  for (const m of messages) {
    if (m.role === 'user' || m.role === 'assistant') {
      const div = document.createElement('div');
      div.className = m.role === 'user' ? 'msg-user' : 'msg-assistant';
      div.textContent = m.text;
      el.appendChild(div);
    } else if (m.role === 'tool') {
      const div = document.createElement('div');
      div.className = 'msg-tool';
      div.textContent = `[usó ${m.name}]`;
      el.appendChild(div);
    }
  }
  el.scrollTop = el.scrollHeight;
}

// Igual que loadMessages() del chat principal (public/app.js, openStream):
// no se intenta reensamblar el texto de la respuesta a mano desde los
// eventos crudos del stream (que tienen una forma distinta para cada motor —
// kind:'claude'/'codex'/'gemini' — ver docs/superpowers/plans/
// 2026-10-02-slots-colaborador.md, Task 5). El stream SSE solo se usa para
// saber cuándo terminó el turno (status idle/running); el contenido real
// siempre se trae con este fetch, misma fuente de verdad que usa el panel
// de admin para una conversación archivada.
async function loadHistory(convId) {
  const r = await fetch(`/api/slot/archived/${convId}`);
  if (!r.ok) return [];
  return r.json();
}

let stream = null;
function openStream(convId) {
  if (stream) stream.close();
  stream = new EventSource('/api/slot/stream');
  stream.onmessage = (ev) => {
    let payload;
    try { payload = JSON.parse(ev.data); } catch { return; }
    if (payload.kind !== 'status') return;
    if (payload.status === 'idle') {
      $('busy-indicator').hidden = true;
      loadHistory(convId).then(renderMessages);
    } else {
      $('busy-indicator').hidden = false;
    }
  };
  stream.onerror = () => {
    // El túnel puede cortar el SSE en turnos largos (mismo comportamiento ya
    // documentado para el chat principal) — EventSource reconecta solo;
    // por las dudas, al reconectar no hace falta hacer nada más acá, el
    // próximo evento 'status' que llegue ya resincroniza todo.
  };
}

function renderArchivedList(ids, activeId) {
  const el = $('archived-list');
  const past = ids.filter((id) => id !== activeId);
  if (past.length === 0) { el.innerHTML = ''; return; }
  el.innerHTML = '<strong>Charlas anteriores (solo lectura):</strong>' +
    past.map((id) => `<a href="#" data-conv="${id}">${id}</a>`).join('');
  el.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      const messages = await loadHistory(a.dataset.conv);
      renderMessages(messages);
    });
  });
}

let currentConvId = null;

async function loadConversation() {
  let r, data;
  try {
    r = await fetch('/api/slot/conversation');
    // Sin cookie valida, el gate redirige a /login.html (HTML, no JSON) — un
    // fetch normal sigue ese redirect solo, asi que r.ok puede ser true con
    // un body que no es JSON. Chequear el content-type en vez de solo r.ok.
    if (!r.ok || !(r.headers.get('content-type') || '').includes('application/json')) return false;
    data = await r.json();
  } catch {
    return false;
  }
  currentConvId = data.activeConversationId;
  if (currentConvId) {
    openStream(currentConvId);
    const messages = await loadHistory(currentConvId);
    renderMessages(messages);
  }
  renderArchivedList(data.archivedConversationIds || [], currentConvId);
  return true;
}

// La cookie de un slot persiste 30 dias (mismo criterio que la de admin) —
// hacer que la persona vuelva a tipear un PIN largo y random cada vez que
// recarga la pagina contradice el motivo por el que se eligio ese formato
// de PIN (hallazgo de la revision final del plan). Si la cookie ya es
// valida, entra directo al chat sin mostrar el formulario.
(async function checkExistingSession() {
  const ok = await loadConversation();
  if (ok) {
    $('login-form').hidden = true;
    $('chat-screen').hidden = false;
  }
})();

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await login($('pin').value);
    $('login-form').hidden = true;
    $('chat-screen').hidden = false;
    await loadConversation();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('text').value.trim();
  if (!text) return;
  $('text').value = '';
  $('busy-indicator').hidden = false;
  const r = await fetch('/api/slot/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    $('busy-indicator').hidden = true;
    alert(data.error || 'no se pudo enviar el mensaje');
    return;
  }
  // Primer mensaje de la conversación: recién ahora existe un convId para
  // abrir el stream (antes de este punto /api/slot/conversation devolvía
  // activeConversationId:null).
  if (data.convId !== currentConvId) {
    currentConvId = data.convId;
    openStream(currentConvId);
  }
  const messages = await loadHistory(currentConvId);
  renderMessages(messages);
});
