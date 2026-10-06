const express = require('express');
const crypto = require('crypto');
const meta = require('../meta');
const equipo = require('../equipo');

// ── Equipo FerStark (Fernando + Claude + Codex + AgY, todos en esta PC) ──
// A diferencia de Sala (sala.js — necesita el VPS porque coordina con la PC
// de Diego), acá los tres agentes corren local, así que no hace falta red:
// cada uno tiene su propia conversación "de verdad" (oculta, no aparece en
// Chats/Codex/AgY) en el meta file nativo de su propio runner, y la
// orquestación vive acá. Reusar el meta file nativo de cada agente (en vez
// de uno aparte) es a propósito: los listeners globales de server.js que ya
// capturan sessionId (Claude/Codex) y el texto de respuesta (AgY) siguen
// funcionando solos, sin tocar ese código — ver runner.on('event'/'status')
// en server.js para Claude/Codex, y geminiRunner.on('status') para AgY.
//
// Dinámica pedida por Fernando (02-04/10/2026, charla en el chat de Claude):
// el primer mensaje de una sala nueva lo responde SOLO Claude, planteando
// las reglas/restricciones que ya sabe que aplican y preguntándole a
// Fernando si están bien (room.phase 'rules'). Desde el mensaje siguiente en
// esa misma sala, responden los tres en cadena — Claude, después Codex,
// después AgY, cada uno viendo lo que dijo el anterior — sin que haga falta
// arrobar a nadie (room.phase 'open'). Para otro tema, Fernando abre otra
// sala y vuelve a arrancar en 'rules'.
function createEquipoRouter({
  runner, codexRunner, geminiRunner,
  scanner, codexScanner,
  accountMetaFile, codexMetaFile, geminiMetaFile,
  accountProjectsDir, accountHomeDir,
  getActiveAccount,
  getUserName,
}) {
  const router = express.Router();
  // Guarda de concurrencia en memoria (no en disco): evita que dos POST
  // simultáneos a la misma sala arranquen dos rondas en paralelo. Se resetea
  // solo con un reinicio del server — una ronda a medio terminar en ese
  // momento ya se cortó con el proceso de todos modos.
  const busyRooms = new Set();

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

  function ensureAgentConv(room, agentKey) {
    const field = `${agentKey}ConvId`;
    if (room[field]) return room[field];
    const convId = crypto.randomUUID();
    const acc = getActiveAccount();
    const cwd = accountHomeDir(acc);
    if (agentKey === 'claude') {
      const data = meta.load(accountMetaFile(acc));
      data.conversations[convId] = { currentSessionId: null, projectDir: cwd, hidden: true, project: 'Equipo FerStark' };
      meta.save(data, accountMetaFile(acc));
    } else if (agentKey === 'codex') {
      const data = meta.load(codexMetaFile);
      data.conversations[convId] = { currentSessionId: null, projectDir: cwd, hidden: true, project: 'Equipo FerStark' };
      meta.save(data, codexMetaFile);
    } else if (agentKey === 'gemini') {
      const data = meta.load(geminiMetaFile);
      data.conversations[convId] = { currentSessionId: null, projectDir: cwd, model: 'gemini-3.8-flash-high', messages: [], lastActivity: null, hidden: true, project: 'Equipo FerStark' };
      meta.save(data, geminiMetaFile);
    }
    equipo.setAgentConv(room.id, agentKey, convId);
    return convId;
  }

  async function runClaudeTurn(convId, text) {
    const acc = getActiveAccount();
    const metaFile = accountMetaFile(acc);
    const before = meta.load(metaFile).conversations[convId];
    const idle = waitForIdle(runner, convId);
    runner.send({ convId, sessionId: before?.currentSessionId || null, cwd: accountHomeDir(acc), text, account: acc });
    const status = await idle;
    if (status.cancelled || status.code !== 0) return `(no pude responder: ${status.stderr || 'turno cancelado'})`;
    const after = meta.load(metaFile).conversations[convId];
    if (!after?.currentSessionId) return '(sin respuesta)';
    const file = scanner.findSessionFile(after.currentSessionId, accountProjectsDir(acc));
    const msgs = file ? scanner.getMessagesIncremental(file).filter(m => m.role === 'assistant') : [];
    return msgs[msgs.length - 1]?.text || '(sin respuesta)';
  }

  async function runCodexTurn(convId, text) {
    const acc = getActiveAccount();
    const before = meta.load(codexMetaFile).conversations[convId];
    const idle = waitForIdle(codexRunner, convId);
    codexRunner.send({ convId, sessionId: before?.currentSessionId || null, cwd: accountHomeDir(acc), text });
    const status = await idle;
    if (status.cancelled || status.code !== 0) return `(no pude responder: ${status.stderr || 'turno cancelado'})`;
    const after = meta.load(codexMetaFile).conversations[convId];
    if (!after?.currentSessionId) return '(sin respuesta)';
    const file = codexScanner.findSessionFile(after.currentSessionId);
    const msgs = file ? codexScanner.getMessages(file).filter(m => m.role === 'assistant') : [];
    return msgs[msgs.length - 1]?.text || '(sin respuesta)';
  }

  async function runGeminiTurn(convId, text) {
    const acc = getActiveAccount();
    const before = meta.load(geminiMetaFile).conversations[convId];
    const idle = waitForIdle(geminiRunner, convId);
    geminiRunner.send({ convId, sessionId: before?.currentSessionId || null, cwd: accountHomeDir(acc), text, model: before?.model || 'gemini-3.8-flash-high' });
    const status = await idle;
    if (status.cancelled || status.incomplete) return `(no pude responder: ${status.stderr || 'turno cancelado'})`;
    return status.response || '(sin respuesta)';
  }

  function rulesPrompt(contextBlock, humanText) {
    const ctx = contextBlock ? `${contextBlock}\n\n` : '';
    return `[MODO EQUIPO FERSTARK — primera vuelta de este tema]\nEstás en "Equipo FerStark", la sala de trabajo local entre Fernando, vos (Claude), Codex y AgY (Gemini) — los tres corren en esta misma PC, mismo filesystem, sin necesidad de coordinar nada por red. Fernando acaba de plantear un tema nuevo acá. Tu rol en esta primera vuelta: poné las reglas y restricciones que ya sabés que aplican (por tu conocimiento de Fernando, sus proyectos, templates que no se pueden modificar, formatos exigidos, etc.) y preguntale explícitamente si están bien. Todavía NO le pidas nada a Codex ni a AgY — eso arranca recién cuando Fernando conteste.\n\n${ctx}Mensaje de Fernando:\n${humanText}`;
  }

  function openPrompt(agentLabel, otherAgents, contextBlock, humanText) {
    const ctx = contextBlock ? `${contextBlock}\n\n` : '';
    return `[EQUIPO FERSTARK — charla libre]\nSeguís en la sala de trabajo local con Fernando y ${otherAgents} — los tres en esta misma PC. Las reglas de este tema ya quedaron definidas más arriba. Fernando mandó un mensaje nuevo (o siguen discutiendo el mismo tema) — das tu aporte/opinión como ${agentLabel}, charla normal de equipo: de acuerdo, en desacuerdo, o algo que se les esté pasando por alto. No hace falta que te arroben para participar.\n\n${ctx}Mensaje de Fernando:\n${humanText}`;
  }

  async function runEquipoRound(room, humanText) {
    busyRooms.add(room.id);
    equipo.setBusy(room.id, true);
    try {
      if (room.phase === 'rules') {
        const convId = ensureAgentConv(room, 'claude');
        const reply = await runClaudeTurn(convId, rulesPrompt('', humanText));
        equipo.appendMessage(room.id, { from: 'Claude', kind: 'agent', text: reply });
        equipo.setPhase(room.id, 'open');
        return;
      }

      // Fase abierta: Claude → Codex → AgY en cadena, cada uno viendo lo que
      // dijeron los anteriores en ESTA ronda (más el historial completo de
      // la sala, por buildContextBlock).
      const history = equipo.getRoom(room.id).messages;
      const ctx = equipo.buildContextBlock(history);

      const claudeConvId = ensureAgentConv(room, 'claude');
      const claudeReply = await runClaudeTurn(claudeConvId, openPrompt('Claude', 'Codex y AgY (Gemini)', ctx, humanText));
      equipo.appendMessage(room.id, { from: 'Claude', kind: 'agent', text: claudeReply });

      const ctx2 = equipo.buildContextBlock(equipo.getRoom(room.id).messages);
      const codexConvId = ensureAgentConv(room, 'codex');
      const codexReply = await runCodexTurn(codexConvId, openPrompt('Codex', 'Claude y AgY (Gemini)', ctx2, humanText));
      equipo.appendMessage(room.id, { from: 'Codex', kind: 'agent', text: codexReply });

      const ctx3 = equipo.buildContextBlock(equipo.getRoom(room.id).messages);
      const geminiConvId = ensureAgentConv(room, 'gemini');
      const geminiReply = await runGeminiTurn(geminiConvId, openPrompt('AgY (Gemini)', 'Claude y Codex', ctx3, humanText));
      equipo.appendMessage(room.id, { from: 'AgY', kind: 'agent', text: geminiReply });
    } catch (err) {
      equipo.appendMessage(room.id, { from: 'sistema', kind: 'system', text: `Error en la ronda: ${err.message}` });
    } finally {
      busyRooms.delete(room.id);
      equipo.setBusy(room.id, false);
    }
  }

  router.get('/rooms', (req, res) => {
    const rooms = equipo.listRooms().map(r => ({
      id: r.id, name: r.name, phase: r.phase, lastActivity: r.lastActivity, busy: busyRooms.has(r.id),
    }));
    res.json({ rooms });
  });

  router.post('/rooms', (req, res) => {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'nombre vacío' });
    const room = equipo.createRoom(name);
    res.status(201).json({ id: room.id, name: room.name, phase: room.phase, lastActivity: room.lastActivity });
  });

  router.get('/rooms/:id/messages', (req, res) => {
    const room = equipo.getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'sala no encontrada' });
    res.json({ messages: room.messages, phase: room.phase, busy: busyRooms.has(room.id) });
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
    runEquipoRound(room, text).catch(err => {
      equipo.appendMessage(room.id, { from: 'sistema', kind: 'system', text: `Error: ${err.message}` });
      busyRooms.delete(room.id);
      equipo.setBusy(room.id, false);
    });
  });

  return router;
}

module.exports = { createEquipoRouter };
