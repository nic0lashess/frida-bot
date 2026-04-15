const log = require('./logger');
const state = require('./state');
const purchases = require('./purchases');
const wa = require('./messenger');
const { bookSlot } = require('./booking');
const { targetDate, tickets, slotProposalTimeoutMin, paymentLinkTimeoutMin } = require('./config');

let activeBrowser = null;

const QUICK_DATES = ['2026-05-05', '2026-05-06', '2026-05-07', '2026-05-08'];

function fmtDate(iso) {
  const [y, m, d] = iso.split('-');
  const months = ['janv.','févr.','mars','avril','mai','juin','juil.','août','sept.','oct.','nov.','déc.'];
  return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1]} ${y}`;
}

function shortDate(iso) {
  const [, m, d] = iso.split('-');
  return `${parseInt(d, 10)}/${parseInt(m, 10)}`;
}

function slotIndicator(s) {
  if (s.available != null) return s.available >= tickets ? '🟢' : '🟡';
  return s.lowAvailability ? '🟡' : '🟢';
}

function dateRow() {
  return QUICK_DATES.map(d => ({ text: shortDate(d), callback_data: `pickdate:${d}` }));
}

function mainMenu() {
  return [
    dateRow(),
    [{ text: '📊 Mon stock', callback_data: 'stock' }, { text: '❓ Aide', callback_data: 'help' }],
  ];
}

function renderStock() {
  const list = purchases.load();
  if (!list.length) return '<i>Aucune place réservée pour l\'instant.</i>';
  return list.map(p => {
    const icon = p.status === 'paid' ? '🟩' : p.status === 'pending' ? '🟦' : '⬜';
    return `${icon} <b>${fmtDate(p.date)}</b> à ${p.time}  <i>(${p.status})</i>`;
  }).join('\n');
}

async function sendGreeting() {
  const text =
    `<b>🎨 Bot Frida Kahlo</b>\n\n` +
    `<b>Tes places réservées :</b>\n` +
    renderStock() + `\n\n` +
    `<b>Acheter une nouvelle place ?</b>\n` +
    `Choisis une date ci-dessous.`;
  await wa.send(text, { buttons: mainMenu() });
}

async function showSlotsForDate(date) {
  await wa.send(`🔍 Je regarde les créneaux pour le <b>${fmtDate(date)}</b>...`);
  try {
    const { checkAvailability } = require('./monitor');
    const r = await Promise.race([
      checkAvailability(date),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 90s')), 90_000)),
    ]);
    if (r.error) {
      await wa.send(`❌ Erreur : <code>${r.error}</code>`, { buttons: mainMenu() });
      return;
    }
    const all = r.all || r.slots || [];
    if (!all.length) {
      await wa.send(
        `🔴 Aucun créneau dispo le <b>${fmtDate(date)}</b>.`,
        { buttons: mainMenu() }
      );
      return;
    }
    const usable = all.filter(s => s.available == null || s.available >= tickets);

    const text =
      `<b>Créneaux — ${fmtDate(date)}</b>\n\n` +
      all.map(s => `${slotIndicator(s)} <b>${s.time}</b>`).join('\n') +
      `\n\n👇 Choisis un horaire :`;

    const rows = [];
    for (let i = 0; i < usable.length; i += 3) {
      rows.push(usable.slice(i, i + 3).map(s => ({
        text: `🕒 ${s.time}`,
        callback_data: `picktime:${date}:${s.time}`,
      })));
    }
    rows.push([{ text: '⬅️ Retour', callback_data: 'home' }]);

    await wa.send(text, { buttons: rows });
  } catch (e) {
    log.error({ err: e.message }, 'showSlotsForDate crash');
    await wa.send(`❌ Le check a planté :\n<code>${e.message}</code>`, { buttons: mainMenu() });
  }
}

async function askConfirm(date, time) {
  const text =
    `<b>Confirmer la réservation ?</b>\n\n` +
    `📅 ${fmtDate(date)}\n` +
    `🕒 ${time}\n` +
    `🎟 1 place`;
  const buttons = [
    [
      { text: '✅ Oui, acheter', callback_data: `confirm:${date}:${time}` },
      { text: '❌ Non',         callback_data: 'home' },
    ],
  ];
  await wa.send(text, { buttons });
}

async function startBooking(date, time) {
  await wa.send(`⏳ Ouverture du panier pour le <b>${fmtDate(date)}</b> à <b>${time}</b>...`);
  try {
    const result = await bookSlot({ targetDate: date, slotTime: time });
    if (!result.ok) {
      await wa.send(`❌ Réservation échouée :\n<code>${result.error}</code>`, { buttons: mainMenu() });
      if (result.screenshot) await wa.sendImage(result.screenshot, 'Dernière vue');
      return;
    }
    if (result.keepAlive && result.keepAlive.browser) activeBrowser = result.keepAlive.browser;

    purchases.add({
      id: `${date}-${time}-${Date.now()}`,
      date, time,
      status: 'pending',
      paymentUrl: result.paymentUrl,
    });

    const s = state.load();
    s.conversation = 'PAYMENT_LINK_SENT';
    s.paymentUrl = result.paymentUrl;
    s.paymentSentAt = new Date().toISOString();
    state.save(s);

    const caption =
      `✅ <b>Panier prêt</b>\n` +
      `1 place — ${fmtDate(date)} à ${time}\n\n` +
      `👉 <a href="${result.paymentUrl}">Ouvrir le paiement</a>\n\n` +
      `Entre ta CB et valide le 3DS, puis tape <b>/done</b>.`;
    const buttons = [
      [{ text: '💳 Payer maintenant', url: result.paymentUrl }],
      [{ text: '✅ J\'ai payé', callback_data: 'done' }, { text: '🏠 Retour', callback_data: 'home' }],
    ];
    if (result.screenshot) await wa.sendImage(result.screenshot, caption, { buttons });
    else await wa.send(caption, { buttons });
  } catch (e) {
    log.error({ err: e.message }, 'booking crash');
    await wa.send(`❌ Crash : <code>${e.message}</code>`, { buttons: mainMenu() });
  }
}

async function markPaid() {
  const list = purchases.load();
  const pending = list.find(p => p.status === 'pending');
  if (pending) {
    pending.status = 'paid';
    pending.paidAt = new Date().toISOString();
    purchases.save(list);
  }
  if (activeBrowser) { try { await activeBrowser.close(); } catch {} activeBrowser = null; }
  state.reset();
  await wa.send('🎉 Place confirmée ! Ajoutée à ton stock.', { buttons: mainMenu() });
}

async function resetAll() {
  if (activeBrowser) { try { await activeBrowser.close(); } catch {} activeBrowser = null; }
  state.reset();
  await wa.send('🔄 Remis à zéro.', { buttons: mainMenu() });
}

async function sendHelp() {
  await wa.send(
    `<b>Comment ça marche</b>\n\n` +
    `1️⃣ Choisis une date (boutons en bas)\n` +
    `2️⃣ Choisis un créneau horaire\n` +
    `3️⃣ Confirme → je prépare le panier\n` +
    `4️⃣ Tu paies via le lien → tape /done\n\n` +
    `Commandes : /start /stock /reset /done`,
    { buttons: mainMenu() }
  );
}

async function handleUserMessage(msg) {
  const raw = (msg.body || '').trim();
  const text = raw.toLowerCase();

  if (msg._isCallback) {
    if (raw.startsWith('pickdate:')) { await showSlotsForDate(raw.slice(9)); return; }
    if (raw.startsWith('picktime:')) {
      const segs = raw.slice(9).split(':');
      await askConfirm(segs[0], segs.slice(1).join(':'));
      return;
    }
    if (raw.startsWith('confirm:')) {
      const segs = raw.slice(8).split(':');
      await startBooking(segs[0], segs.slice(1).join(':'));
      return;
    }
    if (raw === 'home') { await sendGreeting(); return; }
    if (raw === 'stock') {
      await wa.send(`<b>📊 Ton stock</b>\n\n${renderStock()}`, { buttons: mainMenu() });
      return;
    }
    if (raw === 'help') { await sendHelp(); return; }
    if (raw === 'done') { await markPaid(); return; }
  }

  if (text === '/start' || text === 'start') { await sendGreeting(); return; }
  if (text === '/help' || text === 'help') { await sendHelp(); return; }
  if (text === '/stock') {
    await wa.send(`<b>📊 Ton stock</b>\n\n${renderStock()}`, { buttons: mainMenu() });
    return;
  }
  if (text === '/reset' || text === '/cancel') { await resetAll(); return; }
  if (text === '/done' || text === 'done' || text === 'payé') { await markPaid(); return; }

  await sendGreeting();
}

async function handleSlotsFound() { /* plus de notifs auto: tout est à la demande */ }

function tickPaymentTimeout() {
  const s = state.load();
  if (s.conversation !== 'PAYMENT_LINK_SENT' || !s.paymentSentAt) return;
  const ageMin = (Date.now() - new Date(s.paymentSentAt).getTime()) / 60000;
  if (ageMin > paymentLinkTimeoutMin) {
    log.warn('Paiement expiré, reset');
    if (activeBrowser) { try { activeBrowser.close(); } catch {} activeBrowser = null; }
    state.reset();
    wa.send('⏰ Délai de paiement dépassé.').catch(() => {});
  }
}

module.exports = { handleUserMessage, handleSlotsFound, tickPaymentTimeout, sendGreeting, forceCheck: () => sendGreeting() };
