const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { createGeminiRouter } = require('../src/routes/gemini');

test('gemini /tree maneja projectFilter sin ReferenceError y con case-insensitive', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-test-tree-'));
  const tmpMeta = path.join(tmpDir, 'gemini-meta.json');
  fs.writeFileSync(tmpMeta, JSON.stringify({
    conversations: {
      'c1': {
        currentSessionId: 's1',
        name: 'Charla 1',
        project: 'controldoc-holding',
        messages: [{ role: 'user', text: 'hola' }],
        lastActivity: '2026-09-16T20:00:00Z',
      },
      'c2': {
        currentSessionId: 's2',
        name: 'Charla 2',
        project: 'otro-proyecto',
        messages: [{ role: 'user', text: 'chau' }],
        lastActivity: '2026-09-16T20:01:00Z',
      },
    },
    superseded: [],
  }));

  const app = express();
  app.use('/', createGeminiRouter({
    geminiRunner: { isBusy: () => false, getActiveSessionIds: () => [] },
    geminiSseClients: new Map(),
    geminiMetaFile: tmpMeta,
    geminiTurnStartedAt: new Map(),
    inferRepoFromMessage: async () => null,
    inferRepoFromMessages: async () => null,
    registerProject: () => {},
    getHiddenProjectNames: () => new Set(),
  }));

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  try {
    // 1. Filtrar con casing idéntico
    const res1 = await fetch(`http://127.0.0.1:${port}/tree?project=controldoc-holding`);
    assert.equal(res1.status, 200);
    const body1 = await res1.json();
    assert.equal(body1.conversations.length, 1);
    assert.equal(body1.conversations[0].convId, 'c1');

    // 2. Filtrar con diferente casing (ControlDoc-Holding)
    const res2 = await fetch(`http://127.0.0.1:${port}/tree?project=ControlDoc-Holding`);
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.conversations.length, 1);
    assert.equal(body2.conversations[0].convId, 'c1');

    // 3. Filtrar __none__ (solo charlas sin proyecto asignado)
    const res3 = await fetch(`http://127.0.0.1:${port}/tree?project=__none__`);
    assert.equal(res3.status, 200);
    const body3 = await res3.json();
    assert.ok(body3.conversations.every(c => !c.project));
    assert.equal(body3.conversations.some(c => c.convId === 'c1'), false);
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('gemini /tree recupera el proyecto si el título contiene el prefijo de anuncio', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-test-recov-'));
  const tmpMeta = path.join(tmpDir, 'gemini-meta.json');
  fs.writeFileSync(tmpMeta, JSON.stringify({
    conversations: {
      'c-announced': {
        currentSessionId: 's-ann',
        name: '[Estamos trabajando en el proyecto "controldoc-holding", carpeta: C:/proyectos/controldoc]',
        messages: [{ role: 'user', text: 'vamos a trabajar en la nomina' }],
        lastActivity: '2026-09-16T20:00:00Z',
      },
    },
    superseded: [],
  }));

  const registeredProjects = [];
  const app = express();
  app.use('/', createGeminiRouter({
    geminiRunner: { isBusy: () => false, getActiveSessionIds: () => [] },
    geminiSseClients: new Map(),
    geminiMetaFile: tmpMeta,
    geminiTurnStartedAt: new Map(),
    inferRepoFromMessage: async () => null,
    inferRepoFromMessages: async () => null,
    registerProject: (p) => registeredProjects.push(p),
    getHiddenProjectNames: () => new Set(),
  }));

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/tree?project=controldoc-holding`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.conversations.length, 1);
    assert.equal(body.conversations[0].project, 'controldoc-holding');
    assert.equal(body.conversations[0].name, 'vamos a trabajar en la nomina');
    assert.ok(registeredProjects.includes('controldoc-holding'));
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('agyContextWindowFor devuelve el limite segun el modelo', () => {
  const { agyContextWindowFor } = require('../src/routes/gemini');
  assert.equal(agyContextWindowFor('gemini-3.8-flash-high'), 1_000_000);
  assert.equal(agyContextWindowFor('gemini-3.1-pro-high'), 2_000_000);
  assert.equal(agyContextWindowFor('claude-sonnet-4-6'), 1_000_000);
  assert.equal(agyContextWindowFor('claude-3-5-sonnet'), 200_000);
  assert.equal(agyContextWindowFor('gpt-oss-120b-medium'), 128_000);
  assert.equal(agyContextWindowFor(null), 1_000_000);
});

test('gemini /tree y /conversations/:id/usage informan porcentaje y tokens de contexto', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-test-ctx-'));
  const tmpMeta = path.join(tmpDir, 'gemini-meta.json');
  fs.writeFileSync(tmpMeta, JSON.stringify({
    conversations: {
      'c-with-usage': {
        currentSessionId: 's-usage',
        name: 'Charla con uso',
        model: 'gemini-3.8-flash-high',
        contextTokens: 250000,
        lastUsage: { input_tokens: 250000, output_tokens: 1200, total_tokens: 251200 },
        messages: [{ role: 'user', text: 'hola' }],
        lastActivity: '2026-09-16T20:00:00Z',
      },
      'c-without-usage': {
        currentSessionId: null,
        name: 'Charla sin uso',
        model: 'gemini-3.8-flash-high',
        messages: [{ role: 'user', text: 'x'.repeat(400) }],
        lastActivity: '2026-09-16T20:01:00Z',
      },
    },
    superseded: [],
  }));

  const app = express();
  app.use('/', createGeminiRouter({
    geminiRunner: { isBusy: () => false, getActiveSessionIds: () => [] },
    geminiSseClients: new Map(),
    geminiMetaFile: tmpMeta,
    geminiTurnStartedAt: new Map(),
    inferRepoFromMessage: async () => null,
    inferRepoFromMessages: async () => null,
    registerProject: () => {},
    getHiddenProjectNames: () => new Set(),
  }));

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  try {
    // 1. GET /tree expone contextTokens, contextWindow y contextPct
    const treeRes = await fetch(`http://127.0.0.1:${port}/tree`);
    assert.equal(treeRes.status, 200);
    const treeBody = await treeRes.json();
    const convWithUsage = treeBody.conversations.find(c => c.convId === 'c-with-usage');
    assert.ok(convWithUsage);
    assert.equal(convWithUsage.contextTokens, 250000);
    assert.equal(convWithUsage.contextWindow, 1_000_000);
    assert.equal(convWithUsage.contextPct, 0.25);

    const convWithoutUsage = treeBody.conversations.find(c => c.convId === 'c-without-usage');
    assert.ok(convWithoutUsage);
    assert.equal(convWithoutUsage.contextWindow, 1_000_000);
    assert.ok(convWithoutUsage.contextTokens > 0);
    assert.ok(convWithoutUsage.contextPct > 0);

    // 2. GET /conversations/:id/usage devuelve el detalle completo
    const usageRes = await fetch(`http://127.0.0.1:${port}/conversations/c-with-usage/usage`);
    assert.equal(usageRes.status, 200);
    const usageBody = await usageRes.json();
    assert.equal(usageBody.model, 'gemini-3.8-flash-high');
    assert.equal(usageBody.contextTokens, 250000);
    assert.equal(usageBody.contextWindow, 1_000_000);
    assert.equal(usageBody.contextPct, 0.25);
    assert.equal(usageBody.input_tokens, 250000);
    assert.equal(usageBody.output_tokens, 1200);

    // 3. GET /conversations/:id/usage con id inexistente da 404
    const notFoundRes = await fetch(`http://127.0.0.1:${port}/conversations/c-inexistente/usage`);
    assert.equal(notFoundRes.status, 404);
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('contextTokens descarta valores corruptos superiores a la ventana y topa contextPct a 1.0', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-test-context-'));
  const tmpMeta = path.join(tmpDir, 'gemini-meta.json');
  fs.writeFileSync(tmpMeta, JSON.stringify({
    conversations: {
      'c-corrupt': {
        currentSessionId: null,
        name: 'Charla con tokens acumulados excesivos',
        model: 'gemini-3.8-flash-high',
        contextTokens: 54192944,
        lastUsage: { input_tokens: 4986064, output_tokens: 269101, cache_read_tokens: 49206880, total_tokens: 5255165 },
        messages: [{ role: 'user', text: 'hola mundo' }],
        lastActivity: '2026-09-16T20:00:00Z',
      },
    },
    superseded: [],
  }));

  const app = express();
  app.use('/', createGeminiRouter({
    geminiRunner: { isBusy: () => false, getActiveSessionIds: () => [] },
    geminiSseClients: new Map(),
    geminiMetaFile: tmpMeta,
    geminiTurnStartedAt: new Map(),
    inferRepoFromMessage: async () => null,
    inferRepoFromMessages: async () => null,
    registerProject: () => {},
    getHiddenProjectNames: () => new Set(),
  }));

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const treeRes = await fetch(`http://127.0.0.1:${port}/tree`);
    assert.equal(treeRes.status, 200);
    const treeBody = await treeRes.json();
    const convCorrupt = treeBody.conversations.find(c => c.convId === 'c-corrupt');
    assert.ok(convCorrupt);
    // Ya no debe valer 54M; se recalcula con messages
    assert.ok(convCorrupt.contextTokens < 1_000_000);
    assert.ok(convCorrupt.contextPct <= 1.0);
    assert.ok(convCorrupt.contextPct > 0);

    const usageRes = await fetch(`http://127.0.0.1:${port}/conversations/c-corrupt/usage`);
    assert.equal(usageRes.status, 200);
    const usageBody = await usageRes.json();
    assert.ok(usageBody.contextTokens < 1_000_000);
    assert.ok(usageBody.contextPct <= 1.0);
    // Pero preserva los datos de consumo de ese turno
    assert.equal(usageBody.cache_read_tokens, 49206880);
    assert.equal(usageBody.total_tokens, 5255165);

    // Archivo en disco actualizado sin el valor corrupto
    const metaOnDisk = JSON.parse(fs.readFileSync(tmpMeta, 'utf8'));
    assert.equal(metaOnDisk.conversations['c-corrupt'].contextTokens, convCorrupt.contextTokens);
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


