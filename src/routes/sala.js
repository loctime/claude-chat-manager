const express = require('express');
const crypto = require('crypto');
const meta = require('../meta');
const salaClient = require('../sala-client');
const { buildContextBlock, isMentioned } = require('../sala-context');

// ── Sala compartida (Jarvis ↔ FerStark) ──
// Cada "sala" es una conversación de Claude local normal (mismo runner,
// mismo --resume) — lo único distinto es que antes de cada turno se le
// antepone lo que se dijo en la sala compartida desde la última vez que
// esta instancia miró, y al terminar se publica la respuesta de vuelta.
// Ver docs/superpowers/specs/2026-09-07-sala-compartida-design.md.
function createSalaRouter({
  runner,
  salaMetaFile,
  getSalaUrl,
  getSalaToken,
  getUserName,
  getAppName,
  getActiveAccount,
  accountHomeDir,
}) {
  const router = express.Router();

  // Une el convId local (una sesión de Claude de ESTA instancia) con el
  // roomId remoto (la sala en el VPS, compartida). 1 sala ↔ 1 conv local por
  // instancia — se crea la primera vez que se manda un mensaje a esa sala.
  function resolveOrCreateSalaConv(roomId) {
    const data = meta.load(salaMetaFile);
    let convId = Object.keys(data.conversations).find(id => data.conversations[id].roomId === roomId);
    if (!convId) {
      convId = crypto.randomUUID();
      data.conversations[convId] = { roomId, contextCursor: 0, createdAt: new Date().toISOString() };
      meta.save(data, salaMetaFile);
    }
    return { convId, conv: data.conversations[convId] };
  }

  router.get('/rooms', async (req, res) => {
    const salaUrl = getSalaUrl(), salaToken = getSalaToken();
    if (!salaUrl || !salaToken) return res.status(400).json({ error: 'sala no configurada — completá la URL y el token en Configuración' });
    try {
      const rooms = await salaClient.listRooms({ baseUrl: salaUrl, token: salaToken });
      const data = meta.load(salaMetaFile);
      const withConv = rooms.map(r => {
        const convId = Object.keys(data.conversations).find(id => data.conversations[id].roomId === r.id) || null;
        // busy = esta instancia (la de acá, no la del otro lado) está generando
        // un turno para esa sala ahora mismo — mismo criterio que el ping-dot
        // de Chats/Codex (runner.isBusy), no hay forma de saber si el OTRO
        // agente está procesando, eso vive en su propia PC.
        // unread = dos causas, no una sola (ver charla 15/09/2026, "revisar si
        // la pestaña brilla tanto para el agente como para el usuario"):
        //   1. un turno de ESTA instancia terminó en esta sala mientras nadie
        //      la miraba (runner.on('status', ...), mismo criterio que Chats/
        //      Codex) — data.conversations[convId].unread.
        //   2. hay actividad en la sala (r.lastActivity, de sala-jarvis) más
        //      nueva que la última vez que ESTE humano la vio (lastSeenAt) —
        //      cubre el caso que (1) no ve: Fernando/FerStark escriben algo
        //      que no menciona a esta instancia, así que acá nunca corre un
        //      turno y el flag de (1) nunca se toca. lastSeenAt se actualiza al
        //      abrir la sala (PATCH .../rooms/:id) y al mandar vos un mensaje
        //      (POST .../rooms/:id/message) — no al recibir uno ajeno.
        const conv = convId ? data.conversations[convId] : null;
        const hasNewActivity = conv && r.lastActivity ? r.lastActivity > (conv.lastSeenAt || 0) : false;
        return {
          ...r, convId,
          busy: convId ? runner.isBusy(convId) : false,
          hidden: conv ? !!conv.hidden : false,
          unread: conv ? (!!conv.unread || hasNewActivity) : false,
        };
      });
      // "Ocultar" (menú contextual, ver PATCH .../rooms/:id abajo) es una
      // preferencia LOCAL de esta instancia — vive en SALA_META_FILE, no en la
      // sala compartida del VPS — así que ocultar acá no le saca la sala a
      // Fernando/FerStark del lado de él. Mismo patrón que notes.listNotebooks().
      res.json({ rooms: withConv.filter(r => !r.hidden) });
    } catch (err) {
      res.status(502).json({ error: 'no se pudo contactar la sala: ' + err.message });
    }
  });

  // Ocultar/mostrar una sala, y/o marcarla leída — preferencias locales (ver
  // comentario en GET /api/sala/rooms de arriba). resolveOrCreateSalaConv
  // garantiza que exista la entrada aunque esta instancia nunca haya hablado
  // ahí todavía (el auto-descubrimiento del poller de menciones normalmente ya
  // la creó, esto es solo una red de seguridad).
  router.patch('/rooms/:id', (req, res) => {
    const { convId } = resolveOrCreateSalaConv(req.params.id);
    const data = meta.load(salaMetaFile);
    if ('hidden' in req.body) data.conversations[convId].hidden = !!req.body.hidden;
    if ('unread' in req.body) {
      data.conversations[convId].unread = !!req.body.unread;
      // Marcarla leída (unread:false, lo que manda openRoom() al abrir la
      // sala) es también el momento de decir "ya vi todo lo que había hasta
      // ahora" — avanza lastSeenAt para el cálculo de unread por actividad
      // nueva (ver GET /api/sala/rooms). Un unread:true explícito no debería
      // tocar lastSeenAt (no se usa desde el cliente hoy, pero sería raro que
      // "marcar no leída" además dijera "y la vi ahora").
      if (!req.body.unread) data.conversations[convId].lastSeenAt = Date.now();
    }
    meta.save(data, salaMetaFile);
    res.json({ ok: true });
  });

  // Nombres de instancia configurados (Jarvis/FerStark) — lo usa el
  // autocompletar de @menciones del cliente, sin depender del historial de
  // ninguna sala puntual (ver sala-jarvis/src/server.js GET /identities).
  router.get('/identities', async (req, res) => {
    const salaUrl = getSalaUrl(), salaToken = getSalaToken();
    if (!salaUrl || !salaToken) return res.status(400).json({ error: 'sala no configurada — completá la URL y el token en Configuración' });
    try {
      const identities = await salaClient.listIdentities({ baseUrl: salaUrl, token: salaToken });
      res.json({ identities });
    } catch (err) {
      res.status(502).json({ error: 'no se pudo contactar la sala: ' + err.message });
    }
  });

  router.post('/rooms', async (req, res) => {
    const salaUrl = getSalaUrl(), salaToken = getSalaToken();
    if (!salaUrl || !salaToken) return res.status(400).json({ error: 'sala no configurada — completá la URL y el token en Configuración' });
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'nombre vacío' });
    try {
      const room = await salaClient.createRoom({ baseUrl: salaUrl, token: salaToken, name });
      res.status(201).json(room);
    } catch (err) {
      res.status(502).json({ error: 'no se pudo crear la sala: ' + err.message });
    }
  });

  router.get('/rooms/:id/messages', async (req, res) => {
    const salaUrl = getSalaUrl(), salaToken = getSalaToken();
    if (!salaUrl || !salaToken) return res.status(400).json({ error: 'sala no configurada — completá la URL y el token en Configuración' });
    try {
      // Para MOSTRARLE la sala al humano siempre se trae desde el principio
      // (since=0) — es una lectura completa para renderizar, independiente
      // del contextCursor que trackea qué ya se le dio de comer a Claude.
      const { messages } = await salaClient.fetchMessages({ baseUrl: salaUrl, token: salaToken, roomId: req.params.id, since: 0 });
      // Mismo campo busy que GET /api/sala/rooms (ver ahí el comentario) —
      // acá también, sin efecto secundario para eso: solo lectura de lo que ya
      // exista en SALA_META_FILE, no crea la conv si todavía no existe.
      const data = meta.load(salaMetaFile);
      const convId = Object.keys(data.conversations).find(id => data.conversations[id].roomId === req.params.id) || null;
      // convId también viaja acá (no solo en GET /api/sala/rooms) — el cliente
      // lo necesita para poder abrir /api/conversations/:id/stream y mostrar
      // las tarjetas de herramienta (Read/Bash/Edit) en vivo mientras esta
      // instancia arma la respuesta; null si esta sala todavía no tiene ningún
      // turno local (recién se crea al primer mensaje/mención).
      //
      // Este SÍ tiene un efecto secundario: el único caller real de este
      // endpoint es la sala que está ABIERTA en pantalla (loadRoomMessages, al
      // abrir y en cada poll de 5s mientras siga abierta — ver pollSalaPane en
      // app.js) — nunca se llama "de pasada" para una sala que no se está
      // mirando. Por eso cada lectura acá cuenta como "el humano vio todo esto
      // ahora": sin avanzar lastSeenAt, quedarte mirando una sala mientras el
      // otro lado escribe prendería la pestaña Sala igual, aunque el mensaje
      // nuevo ya te esté apareciendo en pantalla (ver el cálculo de unread por
      // actividad en GET /api/sala/rooms).
      if (convId) {
        data.conversations[convId].lastSeenAt = Date.now();
        meta.save(data, salaMetaFile);
      }
      res.json({ messages, busy: convId ? runner.isBusy(convId) : false, convId });
    } catch (err) {
      res.status(502).json({ error: 'no se pudo leer la sala: ' + err.message });
    }
  });

  router.post('/rooms/:id/message', async (req, res) => {
    const salaUrl = getSalaUrl(), salaToken = getSalaToken();
    if (!salaUrl || !salaToken) return res.status(400).json({ error: 'sala no configurada — completá la URL y el token en Configuración' });
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'mensaje vacío' });
    const roomId = req.params.id;
    const { convId, conv } = resolveOrCreateSalaConv(roomId);
    if (runner.isBusy(convId)) return res.status(409).json({ error: 'esa sala ya está procesando un mensaje' });

    try {
      // 1. Traer lo nuevo que se dijeron los demás desde la última vez.
      const { messages: newFromOthers, nextCursor } = await salaClient.fetchMessages({
        baseUrl: salaUrl, token: salaToken, roomId, since: conv.contextCursor,
      });
      // 2. Publicar YA el mensaje del humano en la sala, para que el otro lado
      //    lo vea aunque esta instancia tarde en responder.
      const { total: totalAfterOwn } = await salaClient.postMessage({
        baseUrl: salaUrl, token: salaToken, roomId, text: `${getUserName()}: ${text}`, kind: 'human',
      });
      // 3. El cursor avanza más allá de lo leído en (1) Y de lo que uno mismo
      //    acaba de publicar en (2) — nada de eso hay que re-inyectárselo a
      //    Claude la próxima vez, ya está en su sesión local vía --resume.
      //    De paso, lastSeenAt también avanza a ahora: acabás de leer (1) y
      //    escribir (2), así que no hay nada "sin leer" para vos en este
      //    instante — sin esto, mandar un mensaje prendería tu propia pestaña
      //    Sala un segundo después (ver el cálculo de unread en GET .../rooms).
      const data = meta.load(salaMetaFile);
      data.conversations[convId].contextCursor = Math.max(nextCursor, totalAfterOwn);
      data.conversations[convId].lastSeenAt = Date.now();
      meta.save(data, salaMetaFile);

      // La sala es libre por default (charla 15/09/2026: "los agentes solo
      // responden cuando los llamamos") — un mensaje NO dispara un turno acá
      // salvo que mencione explícitamente al propio agente (@Jarvis/@FerStark,
      // según la instancia). El texto ya quedó publicado (arriba) para que
      // cualquiera lo lea; si menciona al OTRO agente, es su poller de
      // menciones el que lo levanta (no se toca acá). Antes el default era el
      // opuesto (respondía salvo que mencionaras a alguien más) — invertido a
      // propósito.
      if (!isMentioned(text, getAppName())) {
        return res.status(202).json({ queued: false, addressed: false });
      }

      const contextBlock = buildContextBlock(newFromOthers);
      const outgoing = contextBlock
        ? `${contextBlock}\n\n[Mensaje actual de ${getUserName()}]\n${text}`
        : text;

      const activeAcc = typeof getActiveAccount === 'function' ? getActiveAccount() : undefined;
      const cwd = typeof accountHomeDir === 'function' ? accountHomeDir(activeAcc) : undefined;
      runner.send({ convId, sessionId: conv.currentSessionId, cwd, text: outgoing, account: activeAcc, isSala: true, appName: getAppName() });
      res.status(202).json({ queued: true });
    } catch (err) {
      res.status(502).json({ error: 'no se pudo publicar en la sala: ' + err.message });
    }
  });

  return router;
}

module.exports = { createSalaRouter };
