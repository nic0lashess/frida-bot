const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const log = require('./logger');
const { whatsappOwner } = require('./config');

const ownerJid = `${whatsappOwner.replace(/\D/g, '')}@c.us`;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '..', 'data', 'wwebjs-auth') }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
});

let readyResolve;
const readyPromise = new Promise(r => { readyResolve = r; });

client.on('qr', qr => {
  log.info('Scanne ce QR code avec WhatsApp (Réglages > Appareils connectés > Connecter un appareil) :');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  log.info({ owner: ownerJid }, 'WhatsApp connecté');
  readyResolve();
});

client.on('auth_failure', err => log.error({ err }, 'WhatsApp auth_failure'));
client.on('disconnected', reason => log.warn({ reason }, 'WhatsApp disconnected'));

const messageHandlers = [];

client.on('message', async msg => {
  if (msg.from !== ownerJid) return;       // ignore tout sauf toi
  for (const h of messageHandlers) {
    try { await h(msg); } catch (e) { log.error({ err: e }, 'handler error'); }
  }
});

async function send(text) {
  await readyPromise;
  return client.sendMessage(ownerJid, text);
}

async function sendImage(filePath, caption) {
  await readyPromise;
  const { MessageMedia } = require('whatsapp-web.js');
  const media = MessageMedia.fromFilePath(filePath);
  return client.sendMessage(ownerJid, media, { caption });
}

function onMessage(handler) { messageHandlers.push(handler); }

async function start() {
  log.info('Démarrage WhatsApp...');
  await client.initialize();
  await readyPromise;
}

module.exports = { start, send, sendImage, onMessage };
