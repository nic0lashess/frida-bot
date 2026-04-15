/**
 * Monitor : ouvre la billetterie, sélectionne la date cible, retourne la liste des créneaux dispo.
 *
 * Stratégie de sélecteurs : on privilégie role + accessible name + texte (robuste face aux
 * changements de classes CSS). Le calendrier Fever utilise généralement aria-label sur les
 * boutons de date au format "ej. lunes 4 de mayo de 2026" ou similaire.
 */
const { newContext, screenshot } = require('./browser');
const { ticketUrl, targetDate, tickets } = require('./config');
const log = require('./logger');

const MONTHS_ES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

function parseTargetDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return { year: y, month: m, day: d, monthName: MONTHS_ES[m - 1] };
}

async function pickDate(page, target) {
  // Attendre le calendrier
  await page.waitForSelector('[role="grid"], [class*="calendar" i], [class*="datepicker" i]', { timeout: 15000 });

  // Le calendrier ngb-datepicker utilise aria-label="D-M-YYYY" (ex: "4-5-2026").
  const exactLabel = `${target.day}-${target.month}-${target.year}`;
  const enabledSelector = `[aria-label="${exactLabel}"]:not(.disabled):not([aria-disabled="true"])`;
  const anySelector = `[aria-label="${exactLabel}"]`;

  async function findNextBtn() {
    const candidates = [
      'button.ngb-dp-arrow-btn:not([disabled]):nth-of-type(2)',
      'button.ngb-dp-arrow-btn:not([disabled]):last-of-type',
      '[aria-label*="Next" i]:not([disabled])',
      '[aria-label*="siguiente" i]:not([disabled])',
      '[aria-label*="suivant" i]:not([disabled])',
      '.ngb-dp-arrow.right button',
      'button:has(.ngb-dp-navigation-chevron):nth-of-type(2)',
    ];
    for (const sel of candidates) {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) return loc;
    }
    return null;
  }

  for (let i = 0; i < 24; i++) {
    const cell = page.locator(anySelector).first();
    if (await cell.count() > 0) {
      const disabled = await cell.getAttribute('aria-disabled').catch(() => null);
      const cls = (await cell.getAttribute('class').catch(() => '')) || '';
      if (disabled !== 'true' && !cls.includes('disabled')) {
        await cell.scrollIntoViewIfNeeded().catch(() => {});
        await cell.click();
        return true;
      }
      log.warn({ exactLabel, disabled, cls }, 'Date présente mais désactivée, tentative nav mois suivant');
    }
    const next = await findNextBtn();
    if (!next) {
      log.warn({ i }, 'Bouton "mois suivant" introuvable');
      break;
    }
    await next.click();
    await page.waitForTimeout(500);
  }
  return false;
}

async function readSlots(page) {
  // Attente que les créneaux apparaissent. On cherche des éléments contenant un horaire HH:MM.
  await page.waitForFunction(() => {
    return /\d{1,2}:\d{2}/.test(document.body.innerText);
  }, { timeout: 15000 }).catch(() => {});

  // Récupère tous les boutons/éléments cliquables qui ressemblent à un créneau horaire.
  const slots = await page.evaluate(() => {
    const out = [];
    const els = Array.from(document.querySelectorAll('button, [role="button"], li, div'));
    const seen = new Set();
    for (const el of els) {
      const t = (el.innerText || '').trim();
      const m = t.match(/^(\d{1,2}:\d{2})/);
      if (!m) continue;
      const time = m[1];
      if (seen.has(time)) continue;

      const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' ||
        /sold ?out|agotado|no disponible/i.test(t);
      if (disabled) continue;

      // Détection "Baja disponibilidad" — on extrait si possible un nombre.
      const lowAvail = /baja disponibilidad|low availability/i.test(t);
      const numMatch = t.match(/(\d+)\s*(plazas|tickets|disponibles|left|restantes)/i);
      const available = numMatch ? parseInt(numMatch[1], 10) : (lowAvail ? 3 : null);

      seen.add(time);
      out.push({ time, available, lowAvailability: lowAvail, raw: t.slice(0, 80) });
    }
    return out.sort((a, b) => a.time.localeCompare(b.time));
  });

  return slots;
}

async function checkAvailability(dateOverride) {
  const target = parseTargetDate(dateOverride || targetDate);
  const { browser, ctx } = await newContext();
  const page = await ctx.newPage();
  try {
    log.info({ url: ticketUrl }, 'Ouverture billetterie');
    await page.goto(ticketUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Cookies / popup (best effort)
    for (const txt of [/aceptar|accept|got it|de acuerdo/i]) {
      const btn = page.getByRole('button', { name: txt }).first();
      if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {});
    }

    const ok = await pickDate(page, target);
    if (!ok) {
      const shot = await screenshot(page, 'pickdate-failed');
      log.warn({ shot }, 'Impossible de cliquer la date cible');
      return { error: 'date_not_found', screenshot: shot, slots: [] };
    }

    const slots = await readSlots(page);
    const usable = slots.filter(s => s.available === null || s.available >= tickets);
    log.info({ total: slots.length, usable: usable.length }, 'Créneaux récupérés');
    return { slots: usable, all: slots };
  } catch (err) {
    const shot = await screenshot(page, 'monitor-error').catch(() => null);
    log.error({ err: err.message, shot }, 'Erreur monitor');
    return { error: err.message, screenshot: shot, slots: [] };
  } finally {
    await browser.close();
  }
}

module.exports = { checkAvailability };

if (require.main === module) {
  checkAvailability().then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  });
}
