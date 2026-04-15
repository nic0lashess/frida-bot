/**
 * State machine de la conversation WhatsApp.
 *
 *   IDLE
 *     ↓ (monitor trouve des créneaux)
 *   SLOTS_PROPOSED  ── timeout 10 min ──┐
 *     ↓ (user répond "1", "2"...)        │
 *   BOOKING                              │
 *     ↓ (panier prêt)                    │
 *   PAYMENT_LINK_SENT ── timeout 15 min ─┘
 *     ↓
 *   IDLE
 */
const log = require('./logger');
const state = require('./state');
const wa = require('./messenger');
const { bookSlot } = require('./booking');
const { targetDate, tickets, slotProposalTimeoutMin, paymentLinkTimeoutMin } = require('./config');

let activeBrowser = null; // référence à la fenêtre Chromium ouverte (booking)

function fmtSlots(slots) {
  return slots.map((s, i) => {
    const avail = s.available != null ? `${s.available} places` : (s.lowAvailability ? 'baja dispo' : 'dispo');
    return `  ${i + 1}. ${s.time}  (${avail})`;
  }).join('\n');
}

function newSlots(current, lastSeen) {
  const lastTimes = new Set(lastSeen.map(s => s.time));
  return current.filter(s => !lastTimes.has(s.time));
}

async function handleSlotsFound(slots) {
  const s = state.load();

  // Si on est en plein booking ou attente paiement, ne rien faire
  if (s.conversation === 'BOOKING' || s.conversation === 'PAYMENT_LINK_SENT') {
    s.lastSeenSlots = slots;
    state.save(s);
    return;
  }

  // Vérifier expiration de SLOTS_PROPOSED
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

  // Notifier
  const msg =
    `🎨 Casa Azul — ${targetDate}\n` +
    `Créneaux dispo pour ${tickets} places :\n\n` +
    fmtSlots(candidates) + `\n\n` +
    `Réponds avec le numéro pour réserver, ou "non".`;

  log.info({ count: candidates.length }, 'Notification créneaux');
  await wa.send(msg);

  fresh.conversation = 'SLOTS_PROPOSED';
  fresh.proposedSlots = candidates;
  fresh.proposedAt = new Date().toISOString();
  fresh.lastSeenSlots = slots;
  state.save(fresh);
}

async function handleUserMessage(msg) {
  const text = (msg.body || '').trim().toLowerCase();
  const s = state.load();

  // Commandes globales
  if (text === '/status') {
    await wa.send(`État: ${s.conversation}\nDate: ${targetDate}\nPlaces: ${tickets}`);
    return;
  }
  if (text === '/check') {
    await wa.send('🔍 Check forcé en cours...');
    const { checkAvailability } = require('./monitor');
    const r = await checkAvailability();
    if (r.error) { await wa.send(`❌ Erreur: ${r.error}`); return; }
    if (r.slots.length === 0) { await wa.send('Aucun créneau dispo.'); return; }
    await handleSlotsFound(r.slots);
    return;
  }
  if (text === '/reset' || text === '/cancel') {
    state.reset();
    if (activeBrowser) { try { await activeBrowser.close(); } catch {} activeBrowser = null; }
    await wa.send('🔄 Reset.');
    return;
  }

  // Réponses contextuelles
  if (s.conversation === 'SLOTS_PROPOSED') {
    if (/^(non|no|annuler|cancel)/.test(text)) {
      state.reset();
      await wa.send('OK, annulé.');
      return;
    }
    const num = parseInt(text, 10);
    if (Number.isInteger(num) && num >= 1 && num <= s.proposedSlots.length) {
      const slot = s.proposedSlots[num - 1];
      s.conversation = 'BOOKING';
      s.selectedSlot = slot;
      state.save(s);
      await wa.send(`⏳ Ouverture du panier pour ${slot.time}...`);
      const result = await bookSlot({ targetDate, slotTime: slot.time });
      if (!result.ok) {
        await wa.send(`❌ Booking échoué: ${result.error}`);
        if (result.screenshot) await wa.sendImage(result.screenshot, 'Dernière vue');
        state.reset();
        return;
      }
      activeBrowser = result.keepAlive.browser;
      const s2 = state.load();
      s2.conversation = 'PAYMENT_LINK_SENT';
      s2.paymentUrl = result.paymentUrl;
      s2.paymentSentAt = new Date().toISOString();
      state.save(s2);
      await wa.sendImage(result.screenshot,
        `✅ Panier prêt — ${tickets} places, ${targetDate} ${slot.time}\n\n` +
        `⚠️ La fenêtre Chromium est OUVERTE sur ton PC. Va dessus, vérifie le panier, ` +
        `tape ta CB et valide le 3DS sur ton tel.\n\n` +
        `URL: ${result.paymentUrl}\n\n` +
        `Tape /done quand c'est payé, ou /cancel pour fermer.`);
      return;
    }
    await wa.send(`Réponds avec un numéro entre 1 et ${s.proposedSlots.length}, ou "non".`);
    return;
  }

  if (s.conversation === 'PAYMENT_LINK_SENT') {
    if (/^(\/done|done|payé|ok)/.test(text)) {
      if (activeBrowser) { try { await activeBrowser.close(); } catch {} activeBrowser = null; }
      state.reset();
      await wa.send('🎉 Super, profite de Casa Azul !');
      return;
    }
  }

  // Default
  await wa.send(
    'Commandes:\n' +
    '  /check  — forcer un check de dispo\n' +
    '  /status — état actuel\n' +
    '  /reset  — annuler tout\n' +
    '  /done   — marquer comme payé'
  );
}

// Cleanup paiement expiré
function tickPaymentTimeout() {
  const s = state.load();
  if (s.conversation !== 'PAYMENT_LINK_SENT' || !s.paymentSentAt) return;
  const ageMin = (Date.now() - new Date(s.paymentSentAt).getTime()) / 60000;
  if (ageMin > paymentLinkTimeoutMin) {
    log.warn('Paiement expiré, reset');
    if (activeBrowser) { try { activeBrowser.close(); } catch {} activeBrowser = null; }
    state.reset();
    wa.send('⏰ Délai de paiement dépassé, fenêtre fermée.').catch(() => {});
  }
}

module.exports = { handleSlotsFound, handleUserMessage, tickPaymentTimeout };
