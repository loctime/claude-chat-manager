// Arma el bloque de contexto que se antepone al mensaje del usuario en una
// conversación de Sala — mismo criterio mecánico entre corchetes que ya usa
// el resto del proyecto (pendingRewindNotice/compactedSummary en server.js,
// las etiquetas de "Citar" en app.js): instrucciones/contexto de tono se
// pierden en el system prompt, pero un marcador mecánico tipo "[Fernando
// dijo:]" se respeta. Ver CLAUDE.local.md, "Modos de respuesta".
function buildContextBlock(messages) {
  if (!messages || messages.length === 0) return '';
  return messages
    .map(m => `[${m.author} dijo:]\n${m.text}`)
    .join('\n\n');
}

// Reduce un nombre a solo letras/números en minúscula — así "@ferstark",
// "@FerStark" y "@fer_stark" matchean el mismo appName ("FerStark") sin
// pedirle a nadie que escriba la mención exacto igual a como está
// configurado el nombre de la instancia.
function normalizeMentionName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Saca los tokens "@algo" de un texto — cualquier corrida sin espacios
// después del @, sin el signo de puntuación final si el que escribió
// terminó la frase justo ahí ("@FerStark, revisá esto" no debe capturar
// la coma).
function extractMentions(text) {
  if (!text) return [];
  const matches = text.match(/@(\S+)/g) || [];
  return matches.map(m => m.slice(1).replace(/[.,!?;:)"'’]+$/, ''));
}

// true si `text` menciona a `name` (comparando versiones normalizadas).
function isMentioned(text, name) {
  const target = normalizeMentionName(name);
  if (!target) return false;
  return extractMentions(text).some(m => normalizeMentionName(m) === target);
}

// Marcador mecánico entre corchetes que se antepone al turno disparado por
// una mención — mismo criterio que buildContextBlock/pendingRewindNotice:
// instrucciones de tono se pierden en el system prompt, un marcador
// mecánico concreto se respeta (ver CLAUDE.local.md, "Modos de respuesta").
function mentionNotice(appName) {
  return `[Te mencionaron con @${appName} en este hilo — respondé si corresponde a lo que se está hablando]`;
}

module.exports = { buildContextBlock, normalizeMentionName, extractMentions, isMentioned, mentionNotice };
