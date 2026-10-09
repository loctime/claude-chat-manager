(() => {
  const button = document.getElementById('codex-live-btn');
  const status = document.getElementById('codex-live-status');
  const end = document.getElementById('codex-live-end');
  let active = null;
  const selected = () => typeof currentCodexConv !== 'undefined' && currentCodexConv?.id;
  const label = text => { status.textContent = text; };
  async function readApiResponse(response) {
    if (response.status === 401 || response.status === 403 || (response.redirected && /\/login(?:\.html)?(?:[?#]|$)/.test(response.url))) {
      throw Error('Tu sesión no permite iniciar la voz. Volvé a iniciar sesión en la app.');
    }
    if (response.status === 404) {
      throw Error('La ruta de voz no está disponible. Reiniciá Claude Chat Manager desde otra terminal y recargá esta ventana.');
    }
    if (!(response.headers.get('content-type') || '').includes('application/json')) {
      throw Error('El servidor devolvió una página en lugar de la respuesta de voz. Reiniciá Claude Chat Manager desde otra terminal y recargá esta ventana. Si persiste, revisá el proxy o el inicio de sesión.');
    }
    let result;
    try { result = await response.json(); } catch {
      throw Error('El servidor devolvió una respuesta de voz inválida. Recargá la ventana e intentá de nuevo.');
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error('La respuesta de voz del servidor es inválida.');
    if (!response.ok) throw Error(typeof result.error === 'string' ? result.error : `No se pudo iniciar la voz (${response.status}).`);
    return result;
  }
  async function stop() {
    const s = active;
    active = null;
    if (!s) return;
    clearInterval(s.heartbeat); clearTimeout(s.timeout);
    s.abort.abort();
    s.stream?.getTracks().forEach(t => t.stop());
    s.channel?.close(); s.peer?.close();
    s.audio.pause(); s.audio.srcObject = null;
    end.hidden = true; status.hidden = true;
    button.disabled = false; button.setAttribute('aria-pressed', 'false');
    if (s.id) fetch(`/api/codex-live/conversations/${s.convId}/session/${s.id}`, { method: 'DELETE', keepalive: true }).catch(() => {});
  }
  async function start() {
    if (active) {
      if (active.audio.paused && active.audio.srcObject) {
        try { await active.audio.play(); label('Escuchando'); } catch { toast('El navegador bloqueó el audio'); }
        return;
      }
      return stop();
    }
    const convId = selected();
    if (!convId) return;
    const s = { convId, abort: new AbortController(), audio: new Audio() };
    active = s;
    button.disabled = true; button.setAttribute('aria-pressed', 'true');
    end.hidden = false; status.hidden = false; label('Conectando…');
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw Error('El micrófono requiere HTTPS o localhost');
      const config = await readApiResponse(await fetch('/api/codex-live/status', { signal: s.abort.signal }));
      if (typeof config.configured !== 'boolean') throw Error('El backend de voz no está actualizado. Reiniciá la app desde otra terminal y recargá esta ventana.');
      if (!config.configured) throw Error('Configurá OPENAI_API_KEY en el backend para usar Voz en vivo');
      s.timeout = setTimeout(() => { if (active === s) { stop(); toast('La conexión de voz tardó demasiado'); } }, 40000);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (active !== s) { stream.getTracks().forEach(t => t.stop()); return; }
      s.stream = stream;
      s.peer = new RTCPeerConnection();
      s.peer.ontrack = event => {
        if (active !== s) return;
        s.audio.srcObject = event.streams[0] || new MediaStream([event.track]);
        s.audio.play().catch(() => { label('Tocá Voz en vivo para habilitar el audio'); button.disabled = false; });
      };
      stream.getTracks().forEach(track => s.peer.addTrack(track, stream));
      s.channel = s.peer.createDataChannel('oai-events');
      s.channel.onopen = () => {
        if (active !== s) return;
        clearTimeout(s.timeout); button.disabled = false; label('Escuchando');
      };
      s.channel.onmessage = event => {
        if (active !== s) return;
        let ev; try { ev = JSON.parse(event.data); } catch { return; }
        if (ev.type === 'input_audio_buffer.speech_started') label('Escuchando tu voz');
        if (ev.type === 'input_audio_buffer.speech_stopped') label('Pensando…');
        if (ev.type === 'output_audio_buffer.started') label('Hablando · podés interrumpir');
        if (ev.type === 'output_audio_buffer.stopped' || ev.type === 'output_audio_buffer.cleared') label('Escuchando');
        if (ev.type === 'response.function_call_arguments.done') label('Consultando a Codex…');
        if (ev.type === 'error') { toast(ev.error?.message || 'Error de voz'); stop(); }
      };
      s.channel.onclose = () => { if (active === s) stop(); };
      s.peer.onconnectionstatechange = () => {
        if (active === s && ['failed', 'closed', 'disconnected'].includes(s.peer.connectionState)) stop();
      };
      const offer = await s.peer.createOffer();
      await s.peer.setLocalDescription(offer);
      const response = await fetch(`/api/codex-live/conversations/${convId}/session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp: offer.sdp }), signal: s.abort.signal,
      });
      const result = await readApiResponse(response);
      if (typeof result.id !== 'string' || typeof result.sdp !== 'string') throw Error('El servidor no devolvió una sesión de voz válida.');
      s.id = result.id;
      if (active !== s) { fetch(`/api/codex-live/conversations/${convId}/session/${s.id}`, { method: 'DELETE', keepalive: true }).catch(() => {}); return; }
      await s.peer.setRemoteDescription({ type: 'answer', sdp: result.sdp });
      s.heartbeat = setInterval(async () => {
        try {
          const r = await fetch(`/api/codex-live/conversations/${convId}/session/${s.id}/heartbeat`, { method: 'POST', signal: s.abort.signal });
          if (!r.ok && active === s) { toast('La sesión de voz terminó'); stop(); }
        } catch { if (active === s) stop(); }
      }, 20000);
    } catch (err) {
      if (active === s) { await stop(); if (err.name !== 'AbortError') toast(err.message); }
    }
  }
  button.onclick = start; end.onclick = stop;
  window.CodexLive = { stop };
  // Observe panel changes too: covers mobile navigation and notes/team views.
  function sync() {
    const panel = document.getElementById('panel-chat');
    // El botón "En vivo" del encabezado ya cubre la voz: este del composer queda
    // oculto a propósito (se conserva el código por si se reactiva).
    const SHOW_COMPOSER_BUTTON = false;
    const visible = SHOW_COMPOSER_BUTTON && !!selected() && panel.classList.contains('codex-chat-theme') && panel.classList.contains('open')
      && document.getElementById('notebook-view').hidden && document.getElementById('sala-view').hidden && document.getElementById('equipo-view')?.hidden !== false;
    if (button.hidden !== !visible) button.hidden = !visible;
    if (active && (!visible || active.convId !== selected())) stop();
  }
  new MutationObserver(sync).observe(document.getElementById('panel-chat'), { attributes: true, childList: true, subtree: true, attributeFilter: ['class', 'hidden'] });
  window.addEventListener('pagehide', stop);
  sync();
})();
