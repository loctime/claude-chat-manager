const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const meta = require('../meta');
const equipo = require('../equipo');

// ── Equipo (vos + Claude + Codex + AgY, todos en esta PC) ──
// A diferencia de Sala (sala.js — necesita el VPS porque coordina con la PC
// de otra persona), acá los tres agentes corren local, así que no hace falta
// red: cada uno tiene su propia conversación "de verdad" (oculta, no aparece
// en Chats/Codex/AgY) en el meta file nativo de su propio runner, y la
// orquestación vive acá. Reusar el meta file nativo de cada agente (en vez de
// uno aparte) es a propósito: los listeners globales de server.js que ya
// capturan sessionId (Claude/Codex) y el texto de respuesta (AgY) siguen
// funcionando solos, sin tocar ese código.
//
// Tres modos, siempre con el humano en el medio:
//  1. Charla (room.phase 'rules' → 'open'): el primer mensaje lo responde solo
//     Claude (plantea reglas y pregunta si están bien); desde el siguiente
//     responden los tres en cadena. Solo discusión: no se modifica nada.
//  2. Plan (POST /rooms/:id/plan): Claude arma un plan con tareas por agente.
//     room.plan.status 'proposed'. Espera la aprobación del humano.
//  3. Ejecución (POST /rooms/:id/execute, el botón de aprobar): en orden fijo
//     Claude → Codex → AgY, de a uno, dentro de un git worktree propio de la
//     sala (rama equipo/...). Nadie hace merge: lo decide el humano al final.
// Los roles y el orden los pone el código en el prompt de cada turno
// (equipo.roleBlock), no los dice un agente en la charla.
const EXEC_ORDER = ['claude', 'codex', 'gemini'];
const SHORT_NAME = { claude: 'Claude', codex: 'Codex', gemini: 'AgY' };

function slugify(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'sala';
}

// Worktree aislado para la ejecución. Sale de HEAD del repo del proyecto: lo
// que esté sin commitear ahí no entra (el prompt lo avisa).
function defaultCreateWorktree({ projectDir, roomId, name }) {
  execFileSync('git', ['-C', projectDir, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
  const id8 = roomId.slice(0, 8);
  const branch = `equipo/${slugify(name)}-${id8}`;
  const dir = path.join(os.homedir(), '.ccm-equipo-worktrees', `${path.basename(projectDir)}-${id8}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  execFileSync('git', ['-C', projectDir, 'worktree', 'add', '-b', branch, dir], { stdio: 'ignore' });
  return { path: dir, branch };
}

function createEquipoRouter({
  runner, codexRunner, geminiRunner,
  scanner, codexScanner,
  accountMetaFile, codexMetaFile, geminiMetaFile,
  accountProjectsDir, accountHomeDir,
  getActiveAccount,
  getUserName,
  createWorktree = defaultCreateWorktree,
}) {
  const router = express.Router();
  // Guarda de concurrencia en memoria (no en disco): evita que dos POST
  // simultáneos a la misma sala arranquen dos rondas en paralelo. Se resetea
  // solo con un reinicio del server — una ronda a medio terminar en ese
  // momento ya se cortó con el proceso de todos modos.
  const busyRooms = new Set();
  // Salas a las que les tocaron la cruz: la ronda en curso corta en el
  // próximo punto de control en vez de seguir con el agente que sigue.
  const cancelledRooms = new Set();

  function waitForIdle(emitter, convId) {
    return new Promise(resolve => {
      const handler = status => {
        if (status.convId !== convId || status.status !== 'idle') return;
        emitter.removeListener('status', handler);
        resolve(status);
      };
      emitter.on('status', handler);
    });
  }

  // Carpeta donde corren los agentes en la charla: el proyecto de la sala (así
  // leen su CLAUDE.local.md) o, sin proyecto, el home. Tiene que ser siempre
  // la misma para una conversación: --resume solo encuentra la sesión si el
  // cwd es el mismo con el que se creó (ver CLAUDE.local.md, 27/07/2026). Por
  // eso la ejecución, que corre en el worktree, usa conversaciones aparte.
  function roomCwd(room) {
    return room.projectDir || accountHomeDir(getActiveAccount());
  }

  function ensureAgentConv(room, agentKey, { exec = false, cwd } = {}) {
    const field = `${agentKey}${exec ? 'Exec' : ''}ConvId`;
    if (room[field]) return room[field];
    const convId = crypto.randomUUID();
    const acc = getActiveAccount();
    const dir = cwd || roomCwd(room);
    if (agentKey === 'claude') {
      const data = meta.load(accountMetaFile(acc));
      data.conversations[convId] = { currentSessionId: null, projectDir: dir, hidden: true, project: 'Equipo' };
      meta.save(data, accountMetaFile(acc));
    } else if (agentKey === 'codex') {
      const data = meta.load(codexMetaFile);
      data.conversations[convId] = { currentSessionId: null, projectDir: dir, hidden: true, project: 'Equipo' };
      meta.save(data, codexMetaFile);
    } else if (agentKey === 'gemini') {
      const data = meta.load(geminiMetaFile);
      data.conversations[convId] = { currentSessionId: null, projectDir: dir, model: 'gemini-3.8-flash-high', messages: [], lastActivity: null, hidden: true, project: 'Equipo' };
      meta.save(data, geminiMetaFile);
    }
    equipo.patchRoom(room.id, { [field]: convId });
    room[field] = convId;
    return convId;
  }

  async function runClaudeTurn(convId, text, cwd) {
    const acc = getActiveAccount();
    const metaFile = accountMetaFile(acc);
    const before = meta.load(metaFile).conversations[convId];
    const idle = waitForIdle(runner, convId);
    runner.send({ convId, sessionId: before?.currentSessionId || null, cwd, text, account: acc });
    const status = await idle;
    if (status.cancelled || status.code !== 0) return `(no pude responder: ${status.stderr || 'turno cancelado'})`;
    const after = meta.load(metaFile).conversations[convId];
    if (!after?.currentSessionId) return '(sin respuesta)';
    const file = scanner.findSessionFile(after.currentSessionId, accountProjectsDir(acc));
    const msgs = file ? scanner.getMessagesIncremental(file).filter(m => m.role === 'assistant') : [];
    return msgs[msgs.length - 1]?.text || '(sin respuesta)';
  }

  async function runCodexTurn(convId, text, cwd) {
    const before = meta.load(codexMetaFile).conversations[convId];
    const idle = waitForIdle(codexRunner, convId);
    codexRunner.send({ convId, sessionId: before?.currentSessionId || null, cwd, text });
    const status = await idle;
    if (status.cancelled || status.code !== 0) return `(no pude responder: ${status.stderr || 'turno cancelado'})`;
    const after = meta.load(codexMetaFile).conversations[convId];
    if (!after?.currentSessionId) return '(sin respuesta)';
    const file = codexScanner.findSessionFile(after.currentSessionId);
    const msgs = file ? codexScanner.getMessages(file).filter(m => m.role === 'assistant') : [];
    return msgs[msgs.length - 1]?.text || '(sin respuesta)';
  }

  async function runGeminiTurn(convId, text, cwd) {
    const before = meta.load(geminiMetaFile).conversations[convId];
    const idle = waitForIdle(geminiRunner, convId);
    geminiRunner.send({ convId, sessionId: before?.currentSessionId || null, cwd, text, model: before?.model || 'gemini-3.8-flash-high' });
    const status = await idle;
    if (status.cancelled || status.incomplete) return `(no pude responder: ${status.stderr || 'turno cancelado'})`;
    return status.response || '(sin respuesta)';
  }

  const TURN = { claude: runClaudeTurn, codex: runCodexTurn, gemini: runGeminiTurn };

  function rulesPrompt(contextBlock, humanText) {
    const user = getUserName();
    const ctx = contextBlock ? `${contextBlock}\n\n` : '';
    return `[MODO EQUIPO — primera vuelta de este tema]\n${equipo.roleBlock('claude')}\nEstás en la sala "Equipo", la sala de trabajo local entre ${user}, vos (Claude), Codex y AgY (Gemini) — los tres corren en esta misma PC, mismo filesystem, sin necesidad de coordinar nada por red. La persona que escribe se llama ${user} (no es ninguna otra persona) y acaba de plantear un tema nuevo acá. Tu rol en esta primera vuelta: poné las reglas y restricciones que ya sabés que aplican (por tu conocimiento de ${user}, sus proyectos, templates que no se pueden modificar, formatos exigidos, etc.) y preguntale explícitamente si están bien. Todavía NO le pidas nada a Codex ni a AgY — eso arranca recién cuando ${user} conteste. Por ahora es solo discusión: podés leer archivos, pero no modifiques nada.\n\n${ctx}Mensaje de ${user}:\n${humanText}`;
  }

  function openPrompt(agentKey, contextBlock, humanText) {
    const user = getUserName();
    const label = equipo.ROLES[agentKey].label;
    const others = EXEC_ORDER.filter(k => k !== agentKey).map(k => equipo.ROLES[k].label).join(' y ');
    const ctx = contextBlock ? `${contextBlock}\n\n` : '';
    return `[EQUIPO — charla libre]\n${equipo.roleBlock(agentKey)}\nSeguís en la sala de trabajo local con ${user} (la persona que escribe; no es ninguna otra) y ${others} — los tres en esta misma PC. Las reglas de este tema ya quedaron definidas más arriba. ${user} mandó un mensaje nuevo (o siguen discutiendo el mismo tema) — das tu aporte/opinión como ${label} desde tu rol: de acuerdo, en desacuerdo, o algo que se les esté pasando por alto. Es solo discusión: podés leer archivos para opinar con datos, pero NO modifiques nada hasta que ${user} apruebe un plan. No hace falta que te arroben para participar.\n\n${ctx}Mensaje de ${user}:\n${humanText}`;
  }

  function planPrompt(contextBlock) {
    const user = getUserName();
    return `[EQUIPO — ARMAR EL PLAN]\n${equipo.roleBlock('claude')}\nCon todo lo discutido, armá el plan de ejecución para que ${user} lo apruebe. Formato: tres secciones, "## Claude — ...", "## Codex — ..." y "## AgY — ...", en ese orden (es el orden real de trabajo: cada uno parte de lo que dejó el anterior). Cada sección con tareas concretas y verificables, ajustadas al rol de cada uno. Aclarale a ${user} qué se va a tocar y qué no. Terminá preguntando si lo aprueba. NO ejecutes nada ni modifiques archivos: esto es solo el plan.\n\n${contextBlock}`;
  }

  function execPrompt(agentKey, planText, contextBlock, worktree) {
    const user = getUserName();
    return `[EQUIPO — EJECUCIÓN DEL PLAN APROBADO]\n${equipo.roleBlock(agentKey)}\n${user} aprobó el plan. Ahora te toca a vos, solo tu parte. Trabajás en un git worktree aislado: carpeta ${worktree.path}, rama ${worktree.branch} (sale del último commit del proyecto: lo que ${user} tenga sin commitear en el repo original no está acá, y node_modules tampoco). Reglas: trabajá SOLO ahí; NO toques el repo original, NO hagas merge ni push; commiteá tu trabajo en esta rama con mensajes claros; no repitas lo que ya hizo otro agente. Cuando termines, cerrá con un resumen corto: archivos tocados, qué hiciste, qué queda para el siguiente, y las líneas "FUERA DE ROL:" si corresponde.\n\nPLAN APROBADO:\n${planText}\n\n${contextBlock}`;
  }

  // Corre fn() marcando la sala ocupada y cerrando bien aunque falle o se cancele.
  async function withBusy(room, fn) {
    busyRooms.add(room.id);
    cancelledRooms.delete(room.id);
    equipo.setBusy(room.id, true);
    try {
      await fn();
    } catch (err) {
      equipo.appendMessage(room.id, { from: 'sistema', kind: 'system', text: `Error en la ronda: ${err.message}` });
    } finally {
      if (cancelledRooms.delete(room.id)) {
        equipo.appendMessage(room.id, { from: 'sistema', kind: 'system', text: 'Ronda cancelada.' });
      }
      busyRooms.delete(room.id);
      equipo.setBusy(room.id, false);
    }
  }

  async function runEquipoRound(room, humanText) {
    await withBusy(room, async () => {
      const cwd = roomCwd(room);
      if (room.phase === 'rules') {
        const convId = ensureAgentConv(room, 'claude');
        const reply = await runClaudeTurn(convId, rulesPrompt('', humanText), cwd);
        if (cancelledRooms.has(room.id)) return;
        equipo.appendMessage(room.id, { from: 'Claude', kind: 'agent', text: reply });
        equipo.setPhase(room.id, 'open');
        return;
      }

      // Fase abierta: Claude → Codex → AgY en cadena, cada uno viendo lo que
      // dijeron los anteriores en ESTA ronda (más el historial completo de
      // la sala, por buildContextBlock).
      for (const key of EXEC_ORDER) {
        const ctx = equipo.buildContextBlock(equipo.getRoom(room.id).messages);
        const convId = ensureAgentConv(room, key);
        const reply = await TURN[key](convId, openPrompt(key, ctx, humanText), cwd);
        if (cancelledRooms.has(room.id)) return;
        equipo.appendMessage(room.id, { from: SHORT_NAME[key], kind: 'agent', text: reply });
      }
    });
  }

  async function runPlanRound(room) {
    await withBusy(room, async () => {
      const ctx = equipo.buildContextBlock(equipo.getRoom(room.id).messages);
      const convId = ensureAgentConv(room, 'claude');
      const reply = await runClaudeTurn(convId, planPrompt(ctx), roomCwd(room));
      if (cancelledRooms.has(room.id)) return;
      equipo.appendMessage(room.id, { from: 'Claude', kind: 'agent', text: reply });
      equipo.patchRoom(room.id, { plan: { text: reply, status: 'proposed' } });
    });
  }

  async function runExecRound(room) {
    await withBusy(room, async () => {
      const { worktree, plan } = equipo.getRoom(room.id);
      for (const key of EXEC_ORDER) {
        const fresh = equipo.getRoom(room.id);
        const ctx = equipo.buildContextBlock(fresh.messages);
        const convId = ensureAgentConv(fresh, key, { exec: true, cwd: worktree.path });
        const reply = await TURN[key](convId, execPrompt(key, plan.text, ctx, worktree), worktree.path);
        if (cancelledRooms.has(room.id)) {
          // Se puede volver a aprobar: el worktree y lo ya commiteado quedan.
          equipo.patchRoom(room.id, { plan: { text: plan.text, status: 'proposed' } });
          return;
        }
        equipo.appendMessage(room.id, { from: SHORT_NAME[key], kind: 'agent', text: reply });
      }
      equipo.patchRoom(room.id, { plan: { text: plan.text, status: 'done' } });
      equipo.appendMessage(room.id, {
        from: 'sistema', kind: 'system',
        text: `Ejecución terminada. Nadie hizo merge: el trabajo está en la rama ${worktree.branch} (carpeta ${worktree.path}). Revisá el diff y, si te cierra, mergealo con: git -C "${room.projectDir}" merge ${worktree.branch}`,
      });
    });
  }

  router.get('/rooms', (req, res) => {
    const rooms = equipo.listRooms().map(r => ({
      id: r.id, name: r.name, phase: r.phase, lastActivity: r.lastActivity, busy: busyRooms.has(r.id), projectDir: r.projectDir || null,
    }));
    res.json({ rooms });
  });

  router.post('/rooms', (req, res) => {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'nombre vacío' });
    const projectDir = (req.body.projectDir || '').trim();
    if (projectDir) {
      let ok = false;
      try { ok = fs.statSync(projectDir).isDirectory(); } catch {}
      if (!ok) return res.status(400).json({ error: 'la carpeta del proyecto no existe' });
    }
    const room = equipo.createRoom(name, undefined, { projectDir: projectDir || undefined });
    res.status(201).json({ id: room.id, name: room.name, phase: room.phase, lastActivity: room.lastActivity, projectDir: room.projectDir || null });
  });

  router.get('/rooms/:id/messages', (req, res) => {
    const room = equipo.getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'sala no encontrada' });
    res.json({
      messages: room.messages, phase: room.phase, busy: busyRooms.has(room.id),
      projectDir: room.projectDir || null, plan: room.plan || null, worktree: room.worktree || null,
    });
  });

  router.post('/rooms/:id/message', (req, res) => {
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'mensaje vacío' });
    const room = equipo.getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'sala no encontrada' });
    if (busyRooms.has(room.id)) return res.status(409).json({ error: 'el equipo ya está respondiendo' });

    equipo.appendMessage(room.id, { from: getUserName(), kind: 'human', text });
    res.status(202).json({ queued: true });

    // La ronda corre en segundo plano — ya respondimos 202, el cliente se
    // entera de las respuestas nuevas por polling (GET .../messages), mismo
    // criterio que Sala.
    runEquipoRound(room, text);
  });

  // Pide el plan: Claude lo arma con todo lo discutido. No ejecuta nada.
  router.post('/rooms/:id/plan', (req, res) => {
    const room = equipo.getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'sala no encontrada' });
    if (busyRooms.has(room.id)) return res.status(409).json({ error: 'el equipo ya está respondiendo' });
    if (room.phase !== 'open') return res.status(409).json({ error: 'primero hay que discutir el tema (mandá un mensaje y contestá las reglas)' });
    if (room.plan?.status === 'running') return res.status(409).json({ error: 'hay una ejecución en curso' });
    equipo.appendMessage(room.id, { from: getUserName(), kind: 'human', text: '📋 Armen el plan con lo que discutimos.' });
    res.status(202).json({ queued: true });
    runPlanRound(room);
  });

  // El botón de aprobar: crea el worktree (una vez por sala) y ejecuta en orden.
  router.post('/rooms/:id/execute', (req, res) => {
    const room = equipo.getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'sala no encontrada' });
    if (busyRooms.has(room.id)) return res.status(409).json({ error: 'el equipo ya está respondiendo' });
    if (room.plan?.status !== 'proposed') return res.status(409).json({ error: 'no hay un plan pendiente de aprobar' });
    if (!room.projectDir) return res.status(400).json({ error: 'la sala no tiene carpeta de proyecto: sin ella no hay dónde ejecutar' });

    let worktree = room.worktree;
    if (!worktree) {
      try { worktree = createWorktree({ projectDir: room.projectDir, roomId: room.id, name: room.name }); }
      catch (err) { return res.status(500).json({ error: `no se pudo crear el worktree (¿la carpeta es un repo git?): ${err.message}` }); }
    }
    equipo.patchRoom(room.id, { worktree, plan: { text: room.plan.text, status: 'running' } });
    equipo.appendMessage(room.id, { from: getUserName(), kind: 'human', text: `✅ Plan aprobado. Ejecuten en orden (Claude → Codex → AgY) en la rama ${worktree.branch}.` });
    res.status(202).json({ queued: true, worktree });
    runExecRound(room);
  });

  // La cruz: corta el turno del agente que esté hablando y descarta el resto
  // de la ronda. cancel() devuelve false si ese agente no está corriendo, así
  // que se puede llamar a todos sin mirar cuál es.
  router.delete('/rooms/:id/message', (req, res) => {
    const room = equipo.getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'sala no encontrada' });
    if (!busyRooms.has(room.id)) return res.json({ cancelled: false });
    cancelledRooms.add(room.id);
    for (const id of [room.claudeConvId, room.claudeExecConvId]) if (id) runner.cancel(id);
    for (const id of [room.codexConvId, room.codexExecConvId]) if (id) codexRunner.cancel(id);
    for (const id of [room.geminiConvId, room.geminiExecConvId]) if (id) geminiRunner.cancel(id);
    res.json({ cancelled: true });
  });

  return router;
}

module.exports = { createEquipoRouter };
