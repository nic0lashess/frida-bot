const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { headed } = require('./config');

async function newContext() {
  const browser = await chromium.launch({
    headless: !headed,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext({
    locale: 'es-MX',
    timezoneId: 'America/Mexico_City',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });
  return { browser, ctx };
}

async function screenshot(page, name) {
  const dir = path.join(__dirname, '..', 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}-${Date.now()}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

module.exports = { newContext, screenshot };
