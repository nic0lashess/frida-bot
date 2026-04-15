const cron = require('node-cron');
const log = require('./logger');
const { checkCron, targetDate, tickets } = require('./config');
const wa = require('./messenger');
const { checkAvailability } = require('./monitor');
const { handleSlotsFound, handleUserMessage, tickPaymentTimeout } = require('./conversation');

async function runCheck() {
  log.info('--- Tick monitor ---');
  try {
    const r = await checkAvailability();
    if (r.error) { log.warn({ err: r.error }, 'check error'); return; }
    if (r.slots.length === 0) { log.info('Aucun créneau usable'); return; }
    await handleSlotsFound(r.slots);
  } catch (e) {
    log.error({ err: e.message }, 'runCheck failure');
  }
}

async function main() {
  log.info({ targetDate, tickets, checkCron }, 'frida-bot démarrage');

  await wa.start();
  wa.onMessage(handleUserMessage);

  await wa.send(
    `🤖 Frida-bot en ligne.\n` +
    `Cible: ${tickets} places le ${targetDate}.\n` +
    `Polling: ${checkCron}.\n` +
    `Tape /check pour forcer un check.`
  );

  // Premier check immédiat
  runCheck();

  // Cron récurrent
  cron.schedule(checkCron, runCheck);

  // Watchdog timeout paiement (toutes les minutes)
  setInterval(tickPaymentTimeout, 60_000);

  log.info('Bot prêt.');
}

main().catch(e => {
  log.fatal({ err: e }, 'Crash fatal');
  process.exit(1);
});
