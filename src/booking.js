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
const { ticketUrl, tickets, ticketType, buyer, headed } = require('./config');
const { screenshot } = require('./browser');
const log = require('./logger');

const TICKET_TYPE_LABELS = {
  general: /general/i,
  national: /residente|nacional/i,
  student: /estudiante|maestro/i,
  senior: /60|adulto mayor|niñ/i,
};

async function bookSlot({ targetDate, slotTime }) {
  // Headed si dispo (PC local) sinon headless (Railway/conteneur).
  const browser = await chromium.launch({ headless: !headed, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox'] });
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

    // 4. Quantité de billets — bouton "+" Fever = [data-testid="session-selection-increment-button"]
    await page.waitForTimeout(800);
    const plusBtn = page.locator(
      '[data-testid="session-selection-increment-button"]:not([disabled]), button[aria-label*="Más boletos" i]:not([disabled]), button[aria-label*="add" i]:not([disabled])'
    ).first();
    await plusBtn.waitFor({ state: 'visible', timeout: 10000 });

    for (let i = 0; i < tickets; i++) {
      await plusBtn.click();
      await page.waitForTimeout(200);
    }

    // 5. Bouton principal "SUMAR al carrito" / "Continuar" / "Comprar"
    await page.waitForTimeout(800);
    const submitCandidates = [
      page.getByRole('button', { name: /sumar|añadir|a[ñn]adir al carrito|continuar|comprar|siguiente|continue|checkout|pagar/i }),
      page.locator('button.button--primary.button--fill'),
      page.locator('button[type="submit"]'),
      page.locator('button:has-text("SUMAR")'),
      page.locator('button:has-text("Continuar")'),
    ];
    let clicked = false;
    for (const c of submitCandidates) {
      const el = c.first();
      if (await el.count() === 0) continue;
      if (!(await el.isVisible().catch(() => false))) continue;
      const disabled = await el.getAttribute('disabled').catch(() => null);
      if (disabled != null) continue;
      log.info({ strategy: submitCandidates.indexOf(c) }, 'Clic bouton submit');
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await el.click({ force: true });
      clicked = true;
      break;
    }
    if (!clicked) {
      const shot = await screenshot(page, 'no-submit-button');
      throw new Error(`Bouton "SUMAR/Continuar" introuvable. Screenshot: ${shot}`);
    }

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

    const finalUrl = page.url();
    // Sur Railway (headless): on ferme le navigateur, l'utilisateur paiera via le lien.
    // Sur PC local (headed): on laisse ouvert comme avant.
    if (headed) {
      return { ok: true, paymentUrl: finalUrl, screenshot: finalShot, keepAlive: { browser, ctx, page } };
    }
    await browser.close().catch(() => {});
    return { ok: true, paymentUrl: finalUrl, screenshot: finalShot };
  } catch (err) {
    const shot = await screenshot(page, 'booking-error').catch(() => null);
    log.error({ err: err.message, shot }, 'Erreur booking');
    await browser.close().catch(() => {});
    return { ok: false, error: err.message, screenshot: shot };
  }
}

module.exports = { bookSlot };
