// Flujo: mandar un mensaje y ver la respuesta aparecer. El "modelo" que
// responde es fake-claude.js (ver test/e2e/fixtures/) — nunca Anthropic real:
// cero costo, cero red, respuesta siempre igual y determinística.
'use strict';
const { test, expect } = require('@playwright/test');
const { e2eEnv } = require('./helpers/env');

test('mandar un mensaje muestra la respuesta del CLI (fake, sin tocar Anthropic)', async ({ page }) => {
  const { baseURL } = e2eEnv();
  await page.goto(baseURL);

  await page.locator('#tree .conv').first().click();
  await expect(page.locator('#panel-chat')).toHaveClass(/open/);

  const input = page.locator('#input');
  await expect(input).toBeEnabled({ timeout: 10_000 });
  const text = `mensaje de prueba e2e ${Math.random().toString(36).slice(2)}`;
  await input.fill(text);
  await page.locator('#send').click();

  await expect(page.locator('#messages')).toContainText(text, { timeout: 10_000 });
  await expect(page.locator('#messages')).toContainText('[fake-claude] respuesta de prueba', { timeout: 15_000 });
});
