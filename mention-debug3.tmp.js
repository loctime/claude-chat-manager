const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:3777/login.html');
  const pinInput = await page.$('input');
  if (pinInput) { await pinInput.fill('diego'); await page.keyboard.press('Enter'); }
  await page.waitForTimeout(1000);
  await page.goto('http://127.0.0.1:3777');
  await page.waitForSelector('#pane-tabs');
  await page.waitForTimeout(2500);
  await page.click('.pane-tab[data-pane="5"]');
  await page.waitForResponse(r => r.url().includes('/api/sala/rooms') && r.request().method() === 'GET').catch(() => {});
  await page.waitForTimeout(500);
  await page.click('#room-list .conv:has-text("General")');
  await page.waitForSelector('#sala-view:not([hidden])');
  await page.waitForTimeout(1500); // dejar que loadRoomMessages() real termine

  const before = await page.evaluate(() => ({
    roomMessagesLen: roomMessages.length,
    sample: roomMessages.slice(0, 3),
    USER_NAME, APP_NAME,
    candidates: salaMentionCandidates(),
  }));
  console.log('estado antes de tipear:', JSON.stringify(before, null, 2));

  await page.click('#sala-input');
  await page.keyboard.type('@');
  await page.waitForTimeout(300);
  const menuVisible = await page.$eval('#sala-mention-menu', el => !el.hidden);
  const state = await page.evaluate(() => salaMention);
  console.log('menú visible:', menuVisible, 'salaMention:', JSON.stringify(state));

  await browser.close();
})();
