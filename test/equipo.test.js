const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const express = require('express');
const { createEquipoRouter } = require('../src/routes/equipo');
const equipo = require('../src/equipo');

// equipo.js persiste en una ruta fija de ~/.claude — para no pisar datos
// reales durante el test, cada caso usa un STORE_FILE temporario propio
// (mismo patrón que meta.js: todas las funciones del módulo aceptan `file`
// como último parámetro opcional).
function freshStoreFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'equipo-test-'));
  return path.join(dir, 'equipo-rooms.json');
}

// Runner falso: "responde" de forma asíncrona (setImmediate, no síncrona
// como el real, para ejercitar la espera por el evento 'status') y, si se le
// pasa un metaFile, simula lo que hacen los listeners globales reales de
// server.js (runner.on('event', ...) para Claude/Codex): deja
// currentSessionId seteado en el meta file ANTES de emitir 'idle' — el
// orquestador de equipo.js lo relee recién después de ese evento.
function fakeRunner({ metaFile, delayMs = 0 } = {}) {
  const emitter = new EventEmitter();
  emitter.calls = [];
  emitter.send = job => {
    emitter.calls.push(job);
    const schedule = delayMs > 0 ? cb => setTimeout(cb, delayMs) : setImmediate;
    schedule(() => {
      if (metaFile) {
        const data = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        if (data.conversations[job.convId]) {
          data.conversations[job.convId].currentSessionId = 'sess-' + job.convId.slice(0, 8);
          fs.writeFileSync(metaFile, JSON.stringify(data));
        }
      }
      emitter.emit('status', { convId: job.convId, status: 'idle', code: 0 });
    });
  };
  return emitter;
}

// El runner de AgY (Gemini) es distinto en la vida real: el evento 'status'
// final ya trae `.response` con el texto, sin pasar por un scanner — ver
// gemini-runner.js. El doble lo replica así en vez de reusar fakeRunner().
function fakeGeminiRunner(replyText) {
  const emitter = new EventEmitter();
  emitter.calls = [];
  emitter.send = job => {
    emitter.calls.push(job);
    setImmediate(() => emitter.emit('status', { convId: job.convId, status: 'idle', response: replyText }));
  };
  return emitter;
}

function makeApp({ claudeText = 'Respuesta de Claude', codexText = 'Respuesta de Codex', geminiText = 'Respuesta de AgY', claudeDelayMs = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'equipo-test-meta-'));
  const accountMetaFile = path.join(dir, 'claude-meta.json');
  const codexMetaFile = path.join(dir, 'codex-meta.json');
  const geminiMetaFile = path.join(dir, 'gemini-meta.json');
  for (const f of [accountMetaFile, codexMetaFile, geminiMetaFile]) {
    fs.writeFileSync(f, JSON.stringify({ conversations: {}, superseded: [] }));
  }

  const runner = fakeRunner({ metaFile: accountMetaFile, delayMs: claudeDelayMs });
  const codexRunner = fakeRunner({ metaFile: codexMetaFile });
  const geminiRunner = fakeGeminiRunner(geminiText);

  const scanner = {
    findSessionFile: sid => sid,
    getMessagesIncremental: () => [{ role: 'assistant', text: claudeText }],
  };
  const codexScanner = {
    findSessionFile: sid => sid,
    getMessages: () => [{ role: 'assistant', text: codexText }],
  };

  const app = express();
  app.use(express.json());
  app.use('/', createEquipoRouter({
    runner, codexRunner, geminiRunner,
    scanner, codexScanner,
    accountMetaFile: () => accountMetaFile,
    codexMetaFile, geminiMetaFile,
    accountProjectsDir: () => dir,
    accountHomeDir: () => dir,
    getActiveAccount: () => 'fernando',
    getUserName: () => 'Fernando',
  }));
  return { app, runner, codexRunner, geminiRunner };
}

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { server.close(); }
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

test('equipo.js: store puro — crear sala, mensajes, fase', () => {
  const file = freshStoreFile();
  const room = equipo.createRoom('Documento Maximia', file);
  assert.equal(room.phase, 'rules');
  equipo.appendMessage(room.id, { from: 'Fernando', kind: 'human', text: 'hola equipo' }, file);
  equipo.setPhase(room.id, 'open', file);
  equipo.setAgentConv(room.id, 'claude', 'conv-1', file);
  const fresh = equipo.getRoom(room.id, file);
  assert.equal(fresh.phase, 'open');
  assert.equal(fresh.claudeConvId, 'conv-1');
  assert.equal(fresh.messages.length, 1);
  assert.equal(equipo.listRooms(file).length, 1);
});

test('equipo.js: buildContextBlock marca persona/agente entre corchetes', () => {
  const block = equipo.buildContextBlock([
    { from: 'Fernando', kind: 'human', text: 'hagamos esto' },
    { from: 'Claude', kind: 'agent', text: 'dale' },
  ]);
  assert.match(block, /\[Fernando \(persona\) dijo:\]/);
  assert.match(block, /\[Claude \(agente de IA\) dijo:\]/);
});

test('primer mensaje de una sala nueva: responde SOLO Claude y pasa a fase open', async () => {
  const { app, runner, codexRunner, geminiRunner } = makeApp();
  await withServer(app, async base => {
    const created = await (await fetch(`${base}/rooms`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Doc Maximia' }),
    })).json();
    assert.equal(created.phase, 'rules');

    const post = await fetch(`${base}/rooms/${created.id}/message`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'tenemos que armar el informe mensual' }),
    });
    assert.equal(post.status, 202);

    // esperar a que termine la ronda en background
    await wait(100);

    assert.equal(runner.calls.length, 1, 'Claude respondió una vez');
    assert.equal(codexRunner.calls.length, 0, 'Codex todavía no participa en la fase rules');
    assert.equal(geminiRunner.calls.length, 0, 'AgY todavía no participa en la fase rules');

    const { messages, phase, busy } = await (await fetch(`${base}/rooms/${created.id}/messages`)).json();
    assert.equal(phase, 'open');
    assert.equal(busy, false);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].kind, 'human');
    assert.equal(messages[1].from, 'Claude');
    assert.equal(messages[1].text, 'Respuesta de Claude');
  });
});

test('segundo mensaje (fase open): responden Claude, Codex y AgY en cadena', async () => {
  const { app, runner, codexRunner, geminiRunner } = makeApp();
  await withServer(app, async base => {
    const created = await (await fetch(`${base}/rooms`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Doc Maximia' }),
    })).json();

    await fetch(`${base}/rooms/${created.id}/message`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'primer mensaje' }),
    });
    await wait(100);

    const post2 = await fetch(`${base}/rooms/${created.id}/message`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'ya está bien, ¿qué opinan?' }),
    });
    assert.equal(post2.status, 202);
    await wait(150);

    assert.equal(runner.calls.length, 2, 'Claude ya había hablado una vez en rules + una vez acá');
    assert.equal(codexRunner.calls.length, 1);
    assert.equal(geminiRunner.calls.length, 1);

    const { messages } = await (await fetch(`${base}/rooms/${created.id}/messages`)).json();
    // human(rules) + Claude(rules) + human(open) + Claude + Codex + AgY
    assert.equal(messages.length, 6);
    assert.deepEqual(messages.slice(-3).map(m => m.from), ['Claude', 'Codex', 'AgY']);

    // Codex vio en su prompt lo que Claude acababa de responder en esta ronda
    const codexPrompt = codexRunner.calls[0].text;
    assert.match(codexPrompt, /Respuesta de Claude/);
  });
});

test('no deja mandar un mensaje nuevo mientras el equipo está respondiendo (409)', async () => {
  // claudeDelayMs alto a propósito: deja una ventana real para que el
  // segundo POST llegue mientras la ronda sigue en curso (en vez de una
  // carrera contra un setImmediate, que puede resolver antes de que el
  // segundo fetch salga).
  const { app } = makeApp({ claudeDelayMs: 150 });
  await withServer(app, async base => {
    const created = await (await fetch(`${base}/rooms`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Sala' }),
    })).json();

    const first = await fetch(`${base}/rooms/${created.id}/message`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hola' }),
    });
    assert.equal(first.status, 202);

    const second = await fetch(`${base}/rooms/${created.id}/message`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'otra cosa ya' }),
    });
    assert.equal(second.status, 409);
    await wait(200);
  });
});
