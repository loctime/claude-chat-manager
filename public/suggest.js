// ── Respuestas sugeridas por IA (Groq) ──
// Extraído de app.js (split por dominio, sesión 15/09/2026) — sin cambios de
// comportamiento, solo de archivo. Script clásico (no ES module): sigue
// compartiendo el mismo scope global que el resto de los <script> del index,
// cargado después de app.js en index.html.
// Se dispara solo para el ÚLTIMO mensaje de la conversación, cuando es de
// Claude/Codex/Antigravity y el turno no sigue en curso. El server decide si
// corresponde sugerir algo — puede devolver [] (mensaje informativo, nada que
// confirmar) y ahí no se pinta nada. Sin GROQ_KEY_SET ni siquiera pega al server.
const suggestionCache = new Map(); // key -> string[] — vive mientras dure la pestaña, no se persiste

async function maybeShowReplySuggestions(convId, div, text, uuid, paneType = 'claude') {
  if (!GROQ_KEY_SET || !text || !text.trim()) return;
  const key = uuid ? `${convId}:${uuid}` : `${convId}:${text.trim().slice(0, 150)}`;
  let suggestions = suggestionCache.get(key);
  if (suggestions === undefined) {
    try {
      const r = await api('/suggest-replies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      suggestions = r.suggestions || [];
    } catch {
      suggestions = []; // nunca rompe el chat por esto
    }
    suggestionCache.set(key, suggestions);
  }
  // Puede haber pasado tiempo real esperando a Groq: si te fuiste de la
  // conversación, o ese mensaje ya no es el último (llegó una respuesta
  // nueva, por ejemplo el disparo automático de un mensaje en cola),
  // no pintamos botones desactualizados.
  const isCurrent = (paneType === 'gemini' && currentGeminiConv?.id === convId) ||
                    (paneType === 'codex' && currentCodexConv?.id === convId) ||
                    (paneType === 'claude' && currentConv === convId);
  if (!isCurrent || div !== messagesEl.lastElementChild || !suggestions.length) return;
  renderReplySuggestions(div, suggestions);
}

function renderReplySuggestions(div, suggestions) {
  const existing = div.querySelector('.reply-suggestions');
  if (existing) existing.remove();
  const bar = document.createElement('div');
  bar.className = 'reply-suggestions';
  suggestions.forEach(text => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'reply-suggestion';
    btn.textContent = text;
    btn.addEventListener('click', () => sendSuggestedReply(text, bar));
    bar.appendChild(btn);
  });
  div.appendChild(bar);
  if (stickToBottom) scrollToBottom();
}

// Un toque = mandado directo (no rellena el composer) — respeta el flujo de
// cada pestaña (Antigravity, Codex o Claude) y cola si hay turno en curso.
async function sendSuggestedReply(text, bar) {
  bar.remove();
  if (currentGeminiConv) {
    if (geminiMainBusy) return;
    $('input').value = text;
    $('composer').requestSubmit();
    return;
  }
  if (currentCodexConv) {
    if (codexMainBusy) return;
    $('input').value = text;
    $('composer').requestSubmit();
    return;
  }
  if (!currentConv) return;
  const convId = currentConv;
  if (busy) {
    queueMessage(convId, text, []);
    renderQueuedBar();
    updateComposerLock();
    return;
  }
  await performSend(convId, text, []);
}
