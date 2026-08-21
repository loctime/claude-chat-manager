// Flujo: buscar un término que solo existe en la conversación de fixture (ver
// SEARCH_TERM en helpers/temp-home.js) y confirmar que el resultado abre esa
// misma conversación. El timeout generoso en el locator del resultado absorbe
// el backfill del índice FTS5, que corre en background al bootear el server.
'use strict';
const { test, expect } = require('@playwright/test');
const { e2eEnv } = require('./helpers/env');

test('el buscador encuentra un término del fixture y abre la conversación', async ({ page }) => {
  const { baseURL, searchTerm } = e2eEnv();
  await page.goto(baseURL);

  await page.locator('#search-btn').click();
  await expect(page.locator('#search-dialog')).toBeVisible();
  await page.locator('#search-input').fill(searchTerm);

  const result = page.locator('.search-result').first();
  await expect(result).toBeVisible({ timeout: 15_000 });
  await result.click();

  await expect(page.locator('#panel-chat')).toHaveClass(/open/);
  await expect(page.locator('#messages')).toContainText(searchTerm);
});
