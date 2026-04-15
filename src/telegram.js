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

  bot.on('callback_query', async q => {
    if (String(q.message.chat.id) !== String(telegramChatId)) return;
    await bot.answerCallbackQuery(q.id).catch(() => {});
    const adapted = { body: q.data || '', from: String(q.message.chat.id), _source: 'telegram', _isCallback: true };
    for (const h of messageHandlers) {
      try { await h(adapted); } catch (e) { log.error({ err: e }, 'telegram callback error'); }
    }
  });

  bot.on('polling_error', err => log.error({ err: err.message }, 'Telegram polling_error'));

  log.info({ chatId: telegramChatId }, 'Telegram connecté');
}

async function send(text, options = {}) {
  if (!bot) return;
  const tgOpts = { parse_mode: 'HTML' };
  if (options.buttons) {
    tgOpts.reply_markup = { inline_keyboard: options.buttons };
  }
  return bot.sendMessage(telegramChatId, text, tgOpts);
}

async function sendImage(filePath, caption, options = {}) {
  if (!bot) return;
  const tgOpts = { caption, parse_mode: 'HTML' };
  if (options.buttons) {
    tgOpts.reply_markup = { inline_keyboard: options.buttons };
  }
  return bot.sendPhoto(telegramChatId, filePath, tgOpts);
}

function onMessage(handler) { messageHandlers.push(handler); }

module.exports = { start, send, sendImage, onMessage };
