const TelegramBot = require('node-telegram-bot-api');
const log = require('./logger');
const { telegramToken, telegramChatId } = require('./config');

let bot = null;
const messageHandlers = [];

async function start() {
  if (!telegramToken || !telegramChatId) {
    log.warn('Telegram non configuré (TELEGRAM_TOKEN/TELEGRAM_CHAT_ID manquants), transport désactivé');
    return;
  }
  log.info('Démarrage Telegram...');
  bot = new TelegramBot(telegramToken, { polling: true });

  bot.on('message', async msg => {
    if (String(msg.chat.id) !== String(telegramChatId)) return;
    const adapted = { body: msg.text || '', from: String(msg.chat.id), _source: 'telegram' };
    for (const h of messageHandlers) {
      try { await h(adapted); } catch (e) { log.error({ err: e }, 'telegram handler error'); }
    }
  });

  bot.on('polling_error', err => log.error({ err: err.message }, 'Telegram polling_error'));

  log.info({ chatId: telegramChatId }, 'Telegram connecté');
}

async function send(text) {
  if (!bot) return;
  return bot.sendMessage(telegramChatId, text);
}

async function sendImage(filePath, caption) {
  if (!bot) return;
  return bot.sendPhoto(telegramChatId, filePath, { caption });
}

function onMessage(handler) { messageHandlers.push(handler); }

module.exports = { start, send, sendImage, onMessage };
