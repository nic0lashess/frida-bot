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
  // Attente agressive du calendrier avec plusieurs signaux possibles
  const waitPromises = [
    page.waitForSelector('text=/ABR\\s*\\d{4}|MAY\\s*\\d{4}|ENE\\s*\\d{4}/i', { timeout: 25000 }).catch(() => null),
    page.waitForSelector('text=/selecciona tipo de boleto/i', { timeout: 25000 }).catch(() => null),
  ];
  await Promise.race(waitPromises);
  await page.waitForTimeout(2000); // laisse le widget finir son rendu

  diag.url = page.url();
  diag.title = await page.title().catch(() => '');

  // Chercher aussi dans les iframes
  const frames = page.frames();
  diag.frameCount = frames.length;
  diag.frameUrls = frames.map(f => f.url()).slice(0, 5);

  // Fonction pour scanner un contexte (page ou frame)
  async function scan(ctx) {
    return ctx.evaluate((yearStr) => {
      const out = [];
      const all = document.querySelectorAll('*');
      const seen = new Set();
      for (const el of all) {
        if (el.children.length > 0) continue;
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
  }

  let detected = await scan(page).catch(() => []);
  // Si rien trouvé en main frame, scanner chaque iframe
  if (detected.length === 0) {
    for (const f of frames) {
      if (f === page.mainFrame()) continue;
      const found = await scan(f).catch(() => []);
      if (found.length > 0) {
        detected = found;
        diag.foundInFrame = f.url();
        break;
      }
    }
  }
  diag.tabTexts = detected;

  const monthTabRegex = new RegExp(`${target.monthShort}\\s*${target.year}`, 'i');
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

  // 2. Cliquer le jour dans la grille ngb-datepicker
  // Format cellule : <div role="gridcell" class="ngb-dp-day" aria-label="5-5-2026"><span>5</span></div>
  const ariaLabel = `${target.day}-${target.month}-${target.year}`;
  const cell = page.locator(`[role="gridcell"][aria-label="${ariaLabel}"]`).first();

  // Attendre que la cellule soit dans le DOM après changement de mois
  try {
    await cell.waitFor({ state: 'attached', timeout: 8000 });
  } catch {
    diag.cellMissing = true;
    log.warn({ ariaLabel }, 'Cellule ngb-dp-day absente du DOM après clic mois');
    return false;
  }

  const cls = (await cell.getAttribute('class').catch(() => '')) || '';
  const ariaDisabled = await cell.getAttribute('aria-disabled').catch(() => null);
  diag.cellClass = cls;
  diag.cellAriaDisabled = ariaDisabled;

  if (cls.includes('disabled') || ariaDisabled === 'true') {
    log.warn({ ariaLabel, cls }, 'Jour cible désactivé (complet ou fermé)');
    diag.cellDisabled = true;
    return false;
  }

  await cell.scrollIntoViewIfNeeded().catch(() => {});
  await cell.click({ force: true });
  await page.waitForTimeout(600);
  diag.dayClicked = true;
  log.info({ ariaLabel }, 'Clic jour cible réussi');
  return true;
}

async function readSlots(page) {
  await page.waitForFunction(() => {
    return /\d{1,2}:\d{2}/.test(document.body.innerText);
  }, { timeout: 15000 }).catch(() => {});

  // Créneaux Fever : <div role="option" data-testid="level-item" class="level-item level-item--time [level-item--disabled]" aria-label="11:00">
  const slots = await page.evaluate(() => {
    const out = [];
    const els = Array.from(document.querySelectorAll('[data-testid="level-item"], [role="option"]'));
    const seen = new Set();
    for (const el of els) {
      const ariaLabel = el.getAttribute('aria-label') || '';
      const innerTxt = (el.innerText || '').trim();
      const m = (ariaLabel.match(/^(\d{1,2}:\d{2})/) || innerTxt.match(/(\d{1,2}:\d{2})/));
      if (!m) continue;
      const time = m[1];
      if (seen.has(time)) continue;

      const cls = el.getAttribute('class') || '';
      const disabled = cls.includes('disabled') ||
        el.hasAttribute('disabled') ||
        el.getAttribute('aria-disabled') === 'true' ||
        /sold ?out|agotado|no disponible/i.test(innerTxt);
      if (disabled) continue;

      const lowAvail = cls.includes('low') || /baja disponibilidad|low availability/i.test(innerTxt);
      const numMatch = innerTxt.match(/(\d+)\s*(plazas|tickets|disponibles|left|restantes)/i);
      const available = numMatch ? parseInt(numMatch[1], 10) : (lowAvail ? 3 : null);

      seen.add(time);
      out.push({ time, available, lowAvailability: lowAvail, raw: innerTxt.slice(0, 80) });
    }
    return out.sort((a, b) => a.time.localeCompare(b.time));
  });

  return slots;
}

// Pré-scan rapide : pour un ensemble de dates, retourne lesquelles ont au moins un créneau dispo
async function scanAvailability(dates) {
  const { browser, ctx } = await newContext();
  const page = await ctx.newPage();
  const result = {};
  try {
    await page.goto(ticketUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const accept = page.getByRole('button', { name: /aceptar|accept|got it|de acuerdo/i }).first();
    if (await accept.isVisible().catch(() => false)) await accept.click().catch(() => {});
    await page.waitForTimeout(1500);

    for (const iso of dates) {
      const target = parseTargetDate(iso);
      try {
        const ok = await pickDate(page, target, {});
        if (!ok) { result[iso] = { available: false, reason: 'date désactivée' }; continue; }
        const slots = await readSlots(page);
        const usable = slots.filter(s => s.available == null || s.available >= 1);
        result[iso] = { available: usable.length > 0, count: usable.length, firstTime: usable[0]?.time };
      } catch (e) {
        result[iso] = { available: false, reason: e.message.slice(0, 60) };
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return result;
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

module.exports = { checkAvailability, scanAvailability };

if (require.main === module) {
  checkAvailability().then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  });
}
