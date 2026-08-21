// ── TTS (Web Speech API) ──
// Extraído de app.js (split por dominio, sesión 2026-08-20) — sin cambios de
// comportamiento, solo de archivo. Script clásico (no ES module), cargado
// después de app.js en index.html: usa `settings` (configuración cargada
// desde localStorage, definida en app.js) desde adentro de speak(), pero
// recién cuando de verdad se toca un botón de reproducir — para entonces
// app.js ya terminó de correr y `settings` ya existe, así que el orden de
// archivos no importa acá (solo que este cargue después de app.js).
//
// makeCopyMsgBtn (botón de copiar mensaje) se queda en app.js a propósito:
// vive pegado a este bloque en el archivo viejo pero no es un tema de TTS,
// es una burbuja de mensaje — no lo movemos por moverlo.
let ttsUtterance = null;
function speak(text, btn, kind = 'assistant') {
  if (!('speechSynthesis' in window)) return;
  if (ttsUtterance) {
    speechSynthesis.cancel();
    document.querySelectorAll('.msg-tts.playing').forEach(b => b.classList.remove('playing'));
    if (ttsUtterance._btn === btn) { ttsUtterance = null; return; }
  }
  const u = new SpeechSynthesisUtterance(text);
  const voiceName = kind === 'user' ? settings.voiceUser : settings.voiceAssistant;
  const voice = voiceName ? speechSynthesis.getVoices().find(v => v.name === voiceName) : null;
  if (voice) { u.voice = voice; u.lang = voice.lang; }
  else u.lang = 'es-AR';
  u._btn = btn;
  ttsUtterance = u;
  btn.classList.add('playing');
  u.onend = u.onerror = () => {
    btn.classList.remove('playing');
    if (ttsUtterance === u) ttsUtterance = null;
  };
  speechSynthesis.speak(u);
}

function cleanForTTS(text) {
  // Sacar bloques de código y código inline ANTES de pasar por marked: adentro
  // de un ``` ``` el contenido es código literal (=>, {}, ===, ;), marked no lo
  // toca porque es preformatted, así que si no se saca acá el TTS lo lee tal cual.
  let raw = text
    .replace(/```[a-zA-Z0-9_+-]*\n?[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]+`/g, ' ');

  let plain = raw;
  // Pasar por el mismo parser Markdown que usa el render visual y quedarnos
  // solo con el texto: así el TTS nunca ve *, `, #, [](), etc. y no los lee
  // como si fueran palabras ("asterisco", "numeral", "comillas").
  if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
    const html = DOMPurify.sanitize(marked.parse(raw, { breaks: true, gfm: true }));
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    plain = tpl.content.textContent || '';
  }
  return plain
    .replace(/\[Archivo adjunto:[^\]]+\]/g, '')
    .replace(/`?\/(?:home|tmp|root|var|opt|usr)[^\s`'"]+`?/g, '')
    .replace(/`?[A-Za-z]:\\[^\s`'"]+`?/g, '') // rutas Windows C:\...
    .replace(/`?\\\\[^\s`'"]+`?/g, '') // rutas UNC \\server\share
    .replace(/https?:\/\/\S+/g, '') // URLs pegadas sin formato markdown
    .replace(/["""«»'']/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function makeTtsBtn(text, kind = 'assistant') {
  const clean = cleanForTTS(text);
  const btn = document.createElement('button');
  btn.className = 'msg-tts';
  btn.title = 'Reproducir';
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>';
  if (!clean) btn.style.display = 'none'; // no mostrar si no hay texto para leer
  btn.onclick = () => speak(clean, btn, kind);
  return btn;
}
