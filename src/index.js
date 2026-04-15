const cron = require('node-cron');
const log = require('./logger');
const { checkCron, targetDate, tickets } = require('./config');
const wa = require('./messenger');
const { handleUserMessage, tickPaymentTimeout, sendGreeting } = require('./conversation');

async function main() {
  log.info({ targetDate, tickets, checkCron }, 'frida-bot démarrage');

  await wa.start();
  wa.onMessage(handleUserMessage);

  await sendGreeting();

  // Cron optionnel : uniquement si CHECK_CRON est défini et non "off"
  if (checkCron && checkCron !== 'off' && cron.validate(checkCron)) {
    log.info({ checkCron }, 'Cron auto-check activé');
    cron.schedule(checkCron, async () => {
      log.info('--- Tick cron ---');
      // Auto-check désactivé par défaut — uniquement notifs passives
    });
  } else {
    log.info('Aucun cron auto (mode à la demande uniquement)');
  }

  setInterval(tickPaymentTimeout, 60_000);

  log.info('Bot prêt.');
}

main().catch(e => {
  log.fatal({ err: e }, 'Crash fatal');
  process.exit(1);
});
