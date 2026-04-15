// Helper partagé monitor/booking pour cliquer une date dans le calendrier Fever.
const MONTHS_ES_SHORT = ['ENE','FEB','MAR','ABR','MAY','JUN','JUL','AGO','SEP','OCT','NOV','DIC'];

async function pickDateOnPage(page, isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const monthShort = MONTHS_ES_SHORT[m - 1];

  // Attendre le calendrier Fever (chips + ngb-datepicker)
  await page.waitForSelector('text=/ABR\\s*\\d{4}|MAY\\s*\\d{4}|ENE\\s*\\d{4}/i', { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // 1. Cliquer le chip du mois cible (ex: "may 2026")
  const monthRegex = new RegExp(`${monthShort}\\s*${y}`, 'i');
  const monthChip = page.getByRole('button', { name: monthRegex })
    .or(page.getByRole('tab', { name: monthRegex }))
    .or(page.locator(`.list-chip__item:has-text("${monthShort}")`))
    .or(page.locator(`xpath=//*[contains(translate(text(), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), "${monthShort} ${y}")]`))
    .first();
  if (await monthChip.count() > 0 && await monthChip.isVisible().catch(() => false)) {
    await monthChip.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1200);
  }

  // 2. Cliquer la cellule jour via aria-label="D-M-YYYY"
  const ariaLabel = `${d}-${m}-${y}`;
  const cell = page.locator(`[role="gridcell"][aria-label="${ariaLabel}"]`).first();
  try {
    await cell.waitFor({ state: 'attached', timeout: 8000 });
  } catch {
    return false;
  }
  const cls = (await cell.getAttribute('class').catch(() => '')) || '';
  const ariaDisabled = await cell.getAttribute('aria-disabled').catch(() => null);
  if (cls.includes('disabled') || ariaDisabled === 'true') return false;

  await cell.scrollIntoViewIfNeeded().catch(() => {});
  await cell.click({ force: true });
  await page.waitForTimeout(600);
  return true;
}

module.exports = { pickDateOnPage };
