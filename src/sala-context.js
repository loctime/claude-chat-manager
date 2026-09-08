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

module.exports = { buildContextBlock };
