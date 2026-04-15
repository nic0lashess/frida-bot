/**
 * Booking : ouvre la billetterie en mode HEADED, sélectionne date + créneau + N billets,
 * remplit les infos acheteur, va jusqu'à la page de paiement, S'ARRÊTE.
 *
 * On laisse la fenêtre Chromium OUVERTE — l'utilisateur clique "payer" lui-même dessus
 * (CB + 3DS). C'est le compromis : pas de bypass captcha, pas de stockage CB, mais flow
 * pré-rempli en 1 clic.
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { ticketUrl, tickets, ticketType, buyer } = require('./config');
const { screenshot } = require('./browser');
const log = require('./logger');

const TICKET_TYPE_LABELS = {
  general: /general/i,
  national: /residente|nacional/i,
  student: /estudiante|maestro/i,
  senior: /60|adulto mayor|niñ/i,
};

async function bookSlot({ targetDate, slotTime }) {
  // Toujours headed pour le booking : on laisse l'utilisateur finir.
  const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({
    locale: 'es-MX',
    timezoneId: 'America/Mexico_City',
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();

  try {
    log.info({ slotTime }, 'Ouverture booking (HEADED)');
    await page.goto(ticketUrl, { waitUntil: 'domcontentloaded' });

    // 1. Cookies
    const accept = page.getByRole('button', { name: /aceptar|accept|got it|de acuerdo/i }).first();
    if (await accept.isVisible().catch(() => false)) await accept.click().catch(() => {});

    // 2. Date — on réutilise pickDate via require dynamique pour éviter la circularité
    const { pickDateOnPage } = require('./_pickDate');
    await pickDateOnPage(page, targetDate);

    // 3. Créneau horaire
    await page.waitForTimeout(800);
    const slotBtn = page.locator(`button:has-text("${slotTime}"), [role="button"]:has-text("${slotTime}")`).first();
    if (!(await slotBtn.isVisible().catch(() => false))) {
      const shot = await screenshot(page, 'slot-not-found');
      throw new Error(`Créneau ${slotTime} introuvable. Screenshot: ${shot}`);
    }
    await slotBtn.click();

    // 4. Quantité de billets — on cherche le bloc du bon type tarifaire et on incrémente
    const typeRegex = TICKET_TYPE_LABELS[ticketType] || /general/i;
    await page.waitForTimeout(800);

    // Stratégie : trouver le label, remonter au conteneur, cliquer le bouton "+"
    const typeLabel = page.getByText(typeRegex).first();
    await typeLabel.waitFor({ timeout: 10000 });
    const container = typeLabel.locator('xpath=ancestor::*[self::div or self::li or self::section][1]');
    const plusBtn = container.locator('button:has-text("+"), button[aria-label*="add" i], button[aria-label*="aumentar" i], button[aria-label*="increase" i]').first();

    for (let i = 0; i < tickets; i++) {
      await plusBtn.click();
      await page.waitForTimeout(150);
    }

    // 5. Bouton "Continuer" / "Comprar"
    const continueBtn = page.getByRole('button', { name: /continuar|comprar|siguiente|continue|checkout|pagar/i }).first();
    await continueBtn.click();

    // 6. Formulaire acheteur (best effort — selon Fever)
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);

    const tryFill = async (label, value) => {
      if (!value) return;
      const candidates = [
        page.getByLabel(label, { exact: false }),
        page.getByPlaceholder(label),
      ];
      for (const c of candidates) {
        const el = c.first();
        if (await el.isVisible().catch(() => false)) { await el.fill(value); return; }
      }
    };
    await tryFill(/nombre|first name/i, buyer.name);
    await tryFill(/apellido|last name/i, buyer.lastName);
    await tryFill(/email|correo/i, buyer.email);
    await tryFill(/teléfono|telefono|phone/i, buyer.phone);

    // 7. STOP. On screenshot et on laisse la fenêtre ouverte pour l'utilisateur.
    const finalShot = await screenshot(page, 'ready-to-pay');
    log.info({ finalShot }, 'Panier prêt — fenêtre laissée OUVERTE pour paiement manuel');

    return {
      ok: true,
      paymentUrl: page.url(),
      screenshot: finalShot,
      // On NE FERME PAS le navigateur — l'utilisateur paye dedans
      keepAlive: { browser, ctx, page },
    };
  } catch (err) {
    const shot = await screenshot(page, 'booking-error').catch(() => null);
    log.error({ err: err.message, shot }, 'Erreur booking');
    await browser.close().catch(() => {});
    return { ok: false, error: err.message, screenshot: shot };
  }
}

module.exports = { bookSlot };
