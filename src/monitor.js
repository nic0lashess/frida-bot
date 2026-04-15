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
const MONTHS_ES_SHORT = ['ENE','FEB','MAR','ABR','MAY','JUN','JUL','AGO','SEP','OCT','NOV','DIC'];

function parseTargetDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return { year: y, month: m, day: d, monthName: MONTHS_ES[m - 1], monthShort: MONTHS_ES_SHORT[m - 1] };
}

async function pickDate(page, target, diag = {}) {
  await page.waitForSelector('text=/selecciona tipo de boleto|select/i', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(800);

  const monthTabRegex = new RegExp(`${target.monthShort}\\s*${target.year}`, 'i');

  // Diagnostic : scanner TOUS les éléments (pas juste les buttons) contenant "2026"
  const detected = await page.evaluate((yearStr) => {
    const out = [];
    const all = document.querySelectorAll('*');
    const seen = new Set();
    for (const el of all) {
      if (el.children.length > 0) continue; // feuilles uniquement
      const t = (el.innerText || el.textContent || '').trim();
      if (!t || !t.includes(yearStr) || t.length > 40) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      out.push({
        text: t,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || null,
        cls: (el.getAttribute('class') || '').slice(0, 60),
      });
    }
    return out;
  }, String(target.year));
  diag.tabTexts = detected;
  log.info({ detected }, 'Éléments avec année détectés');

  // Multi-stratégie de clic sur l'onglet mois
  const tryClicks = [
    () => page.getByRole('button', { name: monthTabRegex }).first(),
    () => page.getByRole('tab', { name: monthTabRegex }).first(),
    () => page.locator(`button:has-text("${target.monthShort}")`).first(),
    () => page.locator(`[role="button"]:has-text("${target.monthShort}")`).first(),
    () => page.locator(`*:has-text("${target.monthShort} ${target.year}")`).last(),
    // XPath fallback : n'importe quel élément contenant le texte exact
    () => page.locator(`xpath=//*[normalize-space(text())="${target.monthShort} ${target.year}"]`).first(),
  ];

  let clicked = false;
  for (const getLoc of tryClicks) {
    try {
      const loc = getLoc();
      if (await loc.count() === 0) continue;
      if (!(await loc.isVisible().catch(() => false))) continue;
      await loc.click({ force: true, timeout: 3000 });
      clicked = true;
      log.info('Onglet mois cliqué via stratégie', { idx: tryClicks.indexOf(getLoc) });
      break;
    } catch {}
  }
  diag.monthClicked = clicked;

  if (!clicked) {
    log.warn({ monthShort: target.monthShort, detected }, 'Onglet mois : aucune stratégie n\'a marché');
    return false;
  }
  await page.waitForTimeout(1200);

  // 2. Cliquer le jour dans la grille. Les cellules sont des éléments avec juste le numéro.
  // Stratégies multiples pour trouver le bon "5" sans matcher "15", "25"...
  const dayStr = String(target.day);
  const dayCandidates = [
    // Cellule dédiée (bouton/div) avec exactement le texte du jour
    page.locator(`button:has-text("${dayStr}"):not(:has-text("${dayStr}0")):not(:has-text("${dayStr}1")):not(:has-text("${dayStr}2")):not(:has-text("${dayStr}3")):not(:has-text("${dayStr}4")):not(:has-text("${dayStr}5")):not(:has-text("${dayStr}6")):not(:has-text("${dayStr}7")):not(:has-text("${dayStr}8")):not(:has-text("${dayStr}9"))`),
    page.getByRole('button', { name: new RegExp(`^\\s*${dayStr}\\s*$`) }),
    page.getByRole('gridcell', { name: new RegExp(`^\\s*${dayStr}\\s*$`) }),
    // Fallback: locator par texte exact
    page.locator(`[role="button"]:text-is("${dayStr}")`),
  ];

  for (const c of dayCandidates) {
    const el = c.first();
    const count = await el.count().catch(() => 0);
    if (count === 0) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    // Vérifier que le jour n'est pas désactivé
    const disabled = await el.getAttribute('disabled').catch(() => null);
    const ariaDisabled = await el.getAttribute('aria-disabled').catch(() => null);
    if (disabled != null || ariaDisabled === 'true') {
      log.warn({ dayStr }, 'Jour présent mais désactivé');
      continue;
    }
    log.info({ dayStr }, 'Clic jour cible');
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click();
    await page.waitForTimeout(500);
    return true;
  }

  log.warn({ dayStr }, 'Aucune cellule jour cliquable trouvée');
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

    // Screenshot de l'état initial avant navigation
    const initialShot = await screenshot(page, 'calendar-initial').catch(() => null);
    log.info({ initialShot }, 'État initial du calendrier');

    const diag = {};
    const ok = await pickDate(page, target, diag);
    if (!ok) {
      const shot = await screenshot(page, 'pickdate-failed');
      log.warn({ shot, diag }, 'Impossible de cliquer la date cible');
      return {
        error: `date_not_found (${target.monthName} ${target.day})`,
        screenshot: shot,
        initialScreenshot: initialShot,
        diag,
        slots: [],
      };
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
