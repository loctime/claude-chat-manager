// Respuestas sugeridas por IA debajo del último mensaje de Claude — ver
// docs/superpowers/... (brainstorming en el chat, sin spec escrito por
// tratarse de una tarea bounded). Le pega a Groq (gratis, rápido) con el
// texto completo del último mensaje y le pide que decida SOLA si hay algo
// para confirmar/responder; si no hay nada, devuelve un array vacío y no
// se muestra ningún botón. Nunca rompe el chat: cualquier error (sin key,
// sin red, JSON roto, timeout) cae a [] en silencio — es una mejora
// cosmética, no una funcionalidad crítica.
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const DEFAULT_TIMEOUT_MS = 3000;
const MAX_SUGGESTIONS = 3;
const MAX_INPUT_CHARS = 4000; // el último mensaje puede ser largo; no hace falta mandarlo entero

const SYSTEM_PROMPT = `Vas a leer el último mensaje de un asistente de IA (Claude) dirigido a un usuario humano, dentro de un chat informal.
Tu tarea: si el mensaje termina pidiendo una confirmación, una decisión, o una respuesta del usuario (con o sin signo de pregunta), sugerí hasta 3 respuestas cortas, naturales e informales que el usuario podría tocar para responder con un solo toque, en el mismo idioma del mensaje.
Si el mensaje es solo informativo y no espera ninguna respuesta puntual, devolvé una lista vacía.
Respondé ÚNICAMENTE con JSON válido de la forma {"suggestions": ["...", "...", "..."]}, sin texto adicional.`;

async function getReplySuggestions(text, opts = {}) {
  const apiKey = opts.apiKey;
  if (!apiKey || !text || !text.trim()) return [];

  const fetchImpl = opts.fetchImpl || fetch;
  const model = opts.model || DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text.slice(0, MAX_INPUT_CHARS) },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.4,
        max_tokens: 200,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : null;
    if (!content) return [];
    const parsed = JSON.parse(content);
    const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
    return suggestions
      .filter(s => typeof s === 'string' && s.trim())
      .map(s => s.trim())
      .slice(0, MAX_SUGGESTIONS);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { getReplySuggestions, GROQ_URL, DEFAULT_MODEL };
