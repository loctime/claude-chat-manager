const RESPONSE_MODES = {
  directo: 'Modo de respuesta: directo. Da la respuesta, el porqué, y una recomendación si aplica — nada más. No incluyas fragmentos de código, listas de pasos ni explicaciones extensas salvo que el usuario las pida explícitamente en su mensaje. Escribí en frases completas, tono normal — esto no es un modo telegráfico.',
  cavernicola: 'Modo de respuesta: cavernícola. Sé lo más breve posible. Frases cortas o fragmentos, sin cortesías ni relleno. No expliques nada salvo que se pida explícitamente. Si hace falta un comando, ruta o fragmento de código exacto, dejalo intacto y verbatim.',
};

function responseModeInstruction(mode) {
  const key = mode || 'directo';
  return RESPONSE_MODES[key] || null;
}

module.exports = { RESPONSE_MODES, responseModeInstruction };
