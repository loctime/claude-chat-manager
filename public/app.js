let currentConv = null;
let eventSource = null;
let tree = [];

const $ = id => document.getElementById(id);
const messagesEl = $('messages');

async function api(path, opts) {
  const res = await fetch('/api' + path, opts);
  if (!res.ok && res.status !== 202) throw new Error((await res.json()).error || res.statusText);
  return res.json();
}

function badge(status) {
  return status === 'running' ? ' ⚡' : status === 'queued' ? ' ⏳' : '';
}

async function loadTree() {
  tree = await api('/tree');
  const nav = $('tree');
  nav.innerHTML = '';
  for (const proj of tree) {
    const det = document.createElement('details');
    det.className = 'project';
    det.open = true;
    const sum = document.createElement('summary');
    sum.textContent = proj.projectDir.split('/').pop() || proj.projectDir;
    sum.title = proj.projectDir;
    det.appendChild(sum);
    for (const c of proj.conversations) {
      const div = document.createElement('div');
      div.className = 'conv' + (c.convId === currentConv ? ' active' : '');
      div.innerHTML = `<div class="name"></div><div class="sub"></div>`;
      div.querySelector('.name').textContent = c.name + badge(c.status);
      div.querySelector('.sub').textContent = (c.lastActivity || '').slice(0, 16).replace('T', ' ');
      div.onclick = () => selectConv(c.convId, c.name);
      det.appendChild(div);
    }
    nav.appendChild(det);
  }
}

function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function addTool(name, input, output) {
  const det = document.createElement('details');
  det.className = 'tool';
  const summary = typeof input === 'object' && input && input.command ? input.command : JSON.stringify(input || '').slice(0, 80);
  det.innerHTML = '<summary></summary><pre class="in"></pre><pre class="out"></pre>';
  det.querySelector('summary').textContent = `▸ ${name}: ${summary}`;
  det.querySelector('.in').textContent = JSON.stringify(input, null, 2);
  det.querySelector('.out').textContent = output || '';
  messagesEl.appendChild(det);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function loadMessages(convId) {
  messagesEl.innerHTML = '';
  const msgs = await api(`/conversations/${convId}/messages`);
  for (const m of msgs) {
    if (m.role === 'tool') addTool(m.name, m.input, m.output);
    else addMsg(m.role, m.text);
  }
}

function setBusy(busy) {
  $('input').disabled = busy || !currentConv;
  $('send').disabled = busy || !currentConv;
}

function openStream(convId) {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/conversations/${convId}/stream`);
  eventSource.onmessage = e => {
    const payload = JSON.parse(e.data);
    if (payload.kind === 'claude') {
      const ev = payload.event;
      if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
        for (const b of ev.message.content) {
          if (b.type === 'text' && b.text.trim()) addMsg('assistant', b.text);
          else if (b.type === 'tool_use') addTool(b.name, b.input, '');
        }
      }
    } else if (payload.kind === 'status') {
      if (payload.status === 'idle') {
        setBusy(false);
        if (payload.code !== 0 && payload.stderr) addMsg('error', 'Error del proceso claude:\n' + payload.stderr);
        loadMessages(currentConv);
        loadTree();
      } else {
        setBusy(true);
        loadTree();
      }
    }
  };
}

async function selectConv(convId, name) {
  currentConv = convId;
  $('conv-title').textContent = name;
  setBusy(false);
  await loadMessages(convId);
  openStream(convId);
  loadTree();
}

$('composer').onsubmit = async e => {
  e.preventDefault();
  const text = $('input').value.trim();
  if (!text || !currentConv) return;
  addMsg('user', text);
  $('input').value = '';
  setBusy(true);
  try {
    await api(`/conversations/${currentConv}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    addMsg('error', err.message);
    setBusy(false);
  }
};

$('conv-title').ondblclick = () => {
  if (!currentConv) return;
  const el = $('conv-title');
  el.contentEditable = 'true';
  el.focus();
  el.onblur = async () => {
    el.contentEditable = 'false';
    await api(`/conversations/${currentConv}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: el.textContent.trim() }),
    });
    loadTree();
  };
  el.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); el.blur(); } };
};

$('new-conv').onclick = () => {
  const sel = $('project-select');
  sel.innerHTML = '';
  for (const proj of tree) {
    const opt = document.createElement('option');
    opt.value = proj.projectDir;
    opt.textContent = proj.projectDir;
    sel.appendChild(opt);
  }
  $('new-dialog').showModal();
};

$('new-form').onsubmit = async e => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  const projectDir = $('project-custom').value.trim() || $('project-select').value;
  const text = $('first-message').value.trim();
  if (!projectDir || !text) return;
  const { convId } = await api('/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectDir, text }),
  });
  $('new-dialog').close();
  $('first-message').value = '';
  $('project-custom').value = '';
  await selectConv(convId, text.slice(0, 60));
  addMsg('user', text);
  setBusy(true);
};

loadTree();
setInterval(loadTree, 15000);
