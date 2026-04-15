const wa = require('./whatsapp');
const tg = require('./telegram');
const { telegramToken, whatsappEnabled } = require('./config');

const transports = [];
if (whatsappEnabled) transports.push(wa);
if (telegramToken) transports.push(tg);

async function start() {
  for (const t of transports) {
    try { await t.start(); }
    catch (e) { require('./logger').error({ err: e.message, transport: t }, 'transport start failed'); }
  }
}

async function send(text, options) {
  await Promise.allSettled(transports.map(t => t.send(text, options)));
}

async function sendImage(filePath, caption, options) {
  await Promise.allSettled(transports.map(t => t.sendImage(filePath, caption, options)));
}

function onMessage(handler) {
  for (const t of transports) t.onMessage(handler);
}

module.exports = { start, send, sendImage, onMessage };
