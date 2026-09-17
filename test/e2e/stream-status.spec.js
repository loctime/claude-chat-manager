// Una conexión SSE nueva debe recibir también `idle`. Es la recuperación de
// un cliente móvil que perdió el broadcast final mientras estaba en background.
'use strict';
const { test, expect } = require('@playwright/test');
const http = require('node:http');
const { e2eEnv } = require('./helpers/env');

test('el stream de una conversación libre entrega un snapshot idle al conectar', async ({ page }) => {
  const { baseURL } = e2eEnv();
  await page.goto(baseURL);
  const treeResponse = await page.request.get(baseURL + '/api/tree');
  const { tree } = await treeResponse.json();
  const convId = tree[0].conversations[0].convId;

  const eventText = await new Promise((resolve, reject) => {
    const request = http.get(`${baseURL}/api/conversations/${convId}/stream`, response => {
      let received = '';
      response.on('data', chunk => {
        received += chunk.toString();
        if (!received.includes('"kind":"status"')) return;
        response.destroy();
        resolve(received);
      });
    });
    request.once('error', reject);
  });

  expect(eventText).toContain('"kind":"status"');
  expect(eventText).toContain('"status":"idle"');
});
