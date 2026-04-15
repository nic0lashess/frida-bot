const log = require('./logger');
const state = require('./state');
const wa = require('./messenger');
const { bookSlot } = require('./booking');
const { targetDate, tickets, slotProposalTimeoutMin, paymentLinkTimeoutMin, checkCron } = require('./config');

let activeBrowser = null;

function cronToHuman(expr) {
  const m = expr.match(/^\*\/(\d+) \* \* \* \*$/);
  if (m) return `toutes les ${m[1]} min`;
  if (expr === '* * * * *') return 'chaque minute';
  return expr;
}

function fmtDate(iso) {
  const [y, m, d] = iso.split('-');
  const months = ['janv.','févr.','mars','avril','mai','juin','juil.','août','sept.','oct.','nov.','déc.'];
  return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1]} ${y}`;
}

function slotIndicator(s) {
  if (s.available != null) {
    if (s.available >= tickets) return '🟢';
    return '🟡';
  }
  if (s.lowAvailability) return '🟡';
  return '🟢';
}

function slotLabel(s) {
  if (s.available != null) return `${s.available} places`;
  if (s.lowAvailability) return 'peu de places';
  return 'dispo';
}

function fmtSlotsRich(slots) {
  if (!slots.length) return '<i>Aucun créneau trouvé.</i>';
  return slots.map(s => `${slotIndicator(s)} <b>${s.time}</b> — ${slotLabel(s)}`).join('\n');
}

function slotButtons(slots) {
  const usable = slots.filter(s => s.available == null || s.available >= tickets);
  const rows = [];
  for (let i = 0; i < usable.length; i += 2) {
    rows.push(usable.slice(i, i + 2).map(s => ({
      text: `🎟 ${s.time}`,
      callback_data: `book:${s.time}`,
    })));
  }
  rows.push([
    { text: '🔄 Re-vérifier', callback_data: 'check' },
    { text: '❌ Annuler', callback_data: 'cancel' },
  ]);
  return rows;
}

function mainMenuButtons() {
  return [
    [{ text: '🔍 Vérifier maintenant', callback_data: 'check' }],
    [{ text: '📊 Statut', callback_data: 'status' }, { text: '🔄 Reset', callback_data: 'cancel' }],
  ];
}

async function sendGreeting() {
  const text =
    `<b>🎨 Frida-bot activé</b>\n\n` +
    `Je surveille pour toi la billetterie Casa Azul.\n\n` +
    `📅 Date visée : <b>${fmtDate(targetDate)}</b>\n` +
    `🎟 Places : <b>${tickets}</b>\n` +
    `⏱ Vérification auto : <b>${cronToHuman(checkCron)}</b>\n\n` +
    `Je t'envoie un message dès qu'un créneau apparaît.\n` +
    `Tu peux aussi forcer une vérification quand tu veux.`;
  await wa.send(text, { buttons: mainMenuButtons() });
}

function newSlots(current, lastSeen) {
  const lastTimes = new Set((lastSeen || []).map(s => s.time));
  return current.filter(s => !lastTimes.has(s.time));
}

async function sendAvailabilityReport(result, { force = false } = {}) {
  if (result.error) {
    await wa.send(`❌ <b>Erreur</b> lors de la vérif :\n<code>${result.error}</code>`, { buttons: mainMenuButtons() });
    return;
  }
  const all = result.all || result.slots || [];
  if (!all.length) {
    await wa.send(
      `🔴 <b>Aucun créneau dispo</b> pour le ${fmtDate(targetDate)}.\n\n` +
      `Je continue à surveiller.`,
      { buttons: mainMenuButtons() }
    );
    return;
  }

  const usable = all.filter(s => s.available == null || s.available >= tickets);
  const text =
    `<b>🎨 Casa Azul — ${fmtDate(targetDate)}</b>\n` +
    `<i>${usable.length} créneau(x) OK pour ${tickets} places / ${all.length} au total</i>\n\n` +
    fmtSlotsRich(all) + '\n\n' +
    (usable.length
      ? `👇 Choisis un horaire pour réserver :`
      : `Aucun créneau avec assez de places. Je continue à surveiller.`);

  await wa.send(text, { buttons: slotButtons(all) });

  if (usable.length) {
    const s = state.load();
    s.conversation = 'SLOTS_PROPOSED';
    s.proposedSlots = usable;
    s.proposedAt = new Date().toISOString();
    s.lastSeenSlots = all;
    state.save(s);
  }
}

async function handleSlotsFound(slots) {
  const s = state.load();

  if (s.conversation === 'BOOKING' || s.conversation === 'PAYMENT_LINK_SENT') {
    s.lastSeenSlots = slots;
    state.save(s);
    return;
  }

  if (s.conversation === 'SLOTS_PROPOSED' && s.proposedAt) {
    const ageMin = (Date.now() - new Date(s.proposedAt).getTime()) / 60000;
    if (ageMin > slotProposalTimeoutMin) {
      log.info('Proposition expirée, retour IDLE');
      state.reset();
    }
  }

  const fresh = state.load();
  const candidates = fresh.conversation === 'SLOTS_PROPOSED'
    ? newSlots(slots, fresh.proposedSlots)
    : newSlots(slots, fresh.lastSeenSlots);

  if (candidates.length === 0) {
    fresh.lastSeenSlots = slots;
    state.save(fresh);
    return;
  }

  log.info({ count: candidates.length }, 'Notification créneaux');
  await sendAvailabilityReport({ all: slots });
}

async function startBooking(slotTime) {
  const s = state.load();
  const slot = (s.proposedSlots || []).find(x => x.time === slotTime)
    || { time: slotTime, available: null };
  s.conversation = 'BOOKING';
  s.selectedSlot = slot;
  state.save(s);

  await wa.send(`⏳ Préparation du panier pour <b>${slot.time}</b>...`);
  const result = await bookSlot({ targetDate, slotTime: slot.time });
  if (!result.ok) {
    await wa.send(`❌ Booking échoué :\n<code>${result.error}</code>`, { buttons: mainMenuButtons() });
    if (result.screenshot) await wa.sendImage(result.screenshot, 'Dernière vue avant erreur');
    state.reset();
    return;
  }
  if (result.keepAlive && result.keepAlive.browser) {
    activeBrowser = result.keepAlive.browser;
  }
  const s2 = state.load();
  s2.conversation = 'PAYMENT_LINK_SENT';
  s2.paymentUrl = result.paymentUrl;
  s2.paymentSentAt = new Date().toISOString();
  state.save(s2);

  const caption =
    `✅ <b>Panier prêt</b>\n` +
    `${tickets} places — ${fmtDate(targetDate)} ${slot.time}\n\n` +
    `👉 <a href="${result.paymentUrl}">Ouvrir le paiement</a>\n\n` +
    `Tape ce lien ou clique le bouton, entre ta CB et valide le 3DS.\n` +
    `Réponds <b>/done</b> une fois payé, ou <b>/cancel</b> pour annuler.`;

  const buttons = [
    [{ text: '💳 Payer maintenant', url: result.paymentUrl }],
    [{ text: '✅ J\'ai payé', callback_data: 'done' }, { text: '❌ Annuler', callback_data: 'cancel' }],
  ];

  if (result.screenshot) {
    await wa.sendImage(result.screenshot, caption, { buttons });
  } else {
    await wa.send(caption, { buttons });
  }
}

async function handleUserMessage(msg) {
  const raw = (msg.body || '').trim();
  const text = raw.toLowerCase();
  const s = state.load();

  // Callback buttons : "book:10:00", "check", "cancel", "status", "done"
  if (msg._isCallback) {
    if (raw.startsWith('book:')) {
      const time = raw.slice(5);
      await startBooking(time);
      return;
    }
    if (raw === 'check') { await forceCheck(); return; }
    if (raw === 'cancel') { await resetAll(); return; }
    if (raw === 'status') { await sendStatus(); return; }
    if (raw === 'done') { await markPaid(); return; }
  }

  // Commandes textuelles
  if (text === '/start' || text === 'start') { await sendGreeting(); await forceCheck(); return; }
  if (text === '/help' || text === 'help') { await sendHelp(); return; }
  if (text === '/status') { await sendStatus(); return; }
  if (text === '/check') { await forceCheck(); return; }
  if (text === '/reset' || text === '/cancel') { await resetAll(); return; }
  if (text === '/done' || text === 'done' || text === 'payé') { await markPaid(); return; }

  // Réponses numériques en SLOTS_PROPOSED
  if (s.conversation === 'SLOTS_PROPOSED') {
    if (/^(non|no|annuler)/.test(text)) { await resetAll(); return; }
    const num = parseInt(text, 10);
    if (Number.isInteger(num) && num >= 1 && num <= (s.proposedSlots || []).length) {
      const slot = s.proposedSlots[num - 1];
      await startBooking(slot.time);
      return;
    }
  }

  await sendHelp();
}

async function forceCheck() {
  await wa.send('🔍 Je vérifie la dispo...');
  const { checkAvailability } = require('./monitor');
  const r = await checkAvailability();
  await sendAvailabilityReport(r, { force: true });
}

async function sendStatus() {
  const s = state.load();
  const stateHuman = {
    IDLE: 'En veille, je surveille.',
    SLOTS_PROPOSED: 'Créneaux en attente de ton choix.',
    BOOKING: 'Panier en cours de préparation...',
    PAYMENT_LINK_SENT: 'Paiement en attente.',
  }[s.conversation] || s.conversation;

  await wa.send(
    `<b>📊 Statut</b>\n\n` +
    `État : ${stateHuman}\n` +
    `Date cible : ${fmtDate(targetDate)}\n` +
    `Places : ${tickets}\n` +
    `Vérif auto : ${cronToHuman(checkCron)}`,
    { buttons: mainMenuButtons() }
  );
}

async function resetAll() {
  state.reset();
  if (activeBrowser) { try { await activeBrowser.close(); } catch {} activeBrowser = null; }
  await wa.send('🔄 Remis à zéro. Je surveille toujours.', { buttons: mainMenuButtons() });
}

async function markPaid() {
  if (activeBrowser) { try { await activeBrowser.close(); } catch {} activeBrowser = null; }
  state.reset();
  await wa.send('🎉 Super, profite de Casa Azul !');
}

async function sendHelp() {
  await wa.send(
    `<b>Commandes</b>\n\n` +
    `🔍 /check — vérifier la dispo\n` +
    `📊 /status — état actuel\n` +
    `🔄 /reset — annuler tout\n` +
    `✅ /done — marquer comme payé\n\n` +
    `Ou utilise les boutons ci-dessous.`,
    { buttons: mainMenuButtons() }
  );
}

function tickPaymentTimeout() {
  const s = state.load();
  if (s.conversation !== 'PAYMENT_LINK_SENT' || !s.paymentSentAt) return;
  const ageMin = (Date.now() - new Date(s.paymentSentAt).getTime()) / 60000;
  if (ageMin > paymentLinkTimeoutMin) {
    log.warn('Paiement expiré, reset');
    if (activeBrowser) { try { activeBrowser.close(); } catch {} activeBrowser = null; }
    state.reset();
    wa.send('⏰ Délai de paiement dépassé, panier fermé.').catch(() => {});
  }
}

module.exports = { handleSlotsFound, handleUserMessage, tickPaymentTimeout, sendGreeting, forceCheck };
