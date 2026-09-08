// Cliente HTTP del servicio "sala-jarvis" (ver sala-jarvis/README.md y
// docs/superpowers/specs/2026-09-07-sala-compartida-design.md). Mismo
// patrón que src/groq-suggest.js: fetchImpl inyectable (default global
// fetch) para que los tests no pegan red real. A diferencia de
// groq-suggest.js (que traga errores porque es cosmético), acá un fallo se
// propaga siempre — publicar/leer la sala es la funcionalidad, no un extra.
async function request(url, { method = 'GET', token, body, fetchImpl = fetch } = {}) {
  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}` },
  };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetchImpl(url, opts);
  if (!res.ok) {
    let message = `sala-jarvis respondió ${res.status}`;
    try {
      const data = await res.json();
      if (data && data.error) message = data.error;
    } catch { /* body no era JSON, se queda con el mensaje genérico */ }
    throw new Error(message);
  }
  return res.json();
}

async function listRooms({ baseUrl, token, fetchImpl }) {
  const data = await request(`${baseUrl}/rooms`, { token, fetchImpl });
  return data.rooms;
}

async function createRoom({ baseUrl, token, name, fetchImpl }) {
  return request(`${baseUrl}/rooms`, { method: 'POST', token, body: { name }, fetchImpl });
}

async function fetchMessages({ baseUrl, token, roomId, since, fetchImpl }) {
  return request(`${baseUrl}/rooms/${roomId}/messages?since=${since}`, { token, fetchImpl });
}

async function postMessage({ baseUrl, token, roomId, text, fetchImpl }) {
  return request(`${baseUrl}/rooms/${roomId}/messages`, { method: 'POST', token, body: { text }, fetchImpl });
}

module.exports = { listRooms, createRoom, fetchMessages, postMessage };
