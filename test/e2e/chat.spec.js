// Flujo: abrir una conversación desde la lista y volver con el botón atrás,
// en viewport mobile (ver playwright.config.js) — mismo layout que usa Diego
// desde el celu. No dispara ningún mensaje, no toca fake-claude.js.
'use strict';
const { test, expect } = require('@playwright/test');
const { e2eEnv } = require('./helpers/env');

test('abrir una conversación de la lista y volver con el botón atrás', async ({ page }) => {
  const { baseURL } = e2eEnv();
  await page.goto(baseURL);

  const row = page.locator('#tree .conv').first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();

  await expect(page.locator('#panel-chat')).toHaveClass(/open/);
  await expect(page.locator('#messages')).toContainText('término de prueba de este fixture');

  await page.locator('#back-btn').click();
  await expect(page.locator('#panel-chat')).not.toHaveClass(/open/);
});
