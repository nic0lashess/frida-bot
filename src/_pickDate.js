// Helper partagé monitor/booking pour cliquer une date dans le calendrier Fever.
const MONTHS_ES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

async function pickDateOnPage(page, isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const monthName = MONTHS_ES[m - 1];

  await page.waitForSelector('[role="grid"], [class*="calendar" i], [class*="datepicker" i]', { timeout: 15000 });

  for (let i = 0; i < 24; i++) {
    const monthVisible = await page.getByText(new RegExp(monthName, 'i')).first().isVisible().catch(() => false);
    if (monthVisible) break;
    const next = page.getByRole('button', { name: /next|siguiente|mes siguiente|>/i }).first();
    if (!(await next.isVisible().catch(() => false))) break;
    await next.click();
    await page.waitForTimeout(300);
  }

  const dayStr = String(d);
  const candidates = [
    page.getByRole('button', { name: new RegExp(`\\b${dayStr}\\b.*${monthName}`, 'i') }),
    page.getByRole('gridcell', { name: new RegExp(`\\b${dayStr}\\b`, 'i') }),
    page.locator(`[aria-label*="${dayStr} de ${monthName}" i]`),
    page.locator(`button:has-text("${dayStr}"):not([disabled])`),
  ];
  for (const c of candidates) {
    const el = c.first();
    if (await el.isVisible().catch(() => false)) { await el.click(); return true; }
  }
  return false;
}

module.exports = { pickDateOnPage };
