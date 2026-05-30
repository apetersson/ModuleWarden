// Headed playwright script that drives the browser through the storyboard.
// Run AFTER ffmpeg+Terminal are already in place. Times are aligned to
// the cumulative seconds in STORYBOARD.md, with t=0 = script start.

import { chromium } from 'playwright';

const ADMIN_TOKEN = process.env.MW_ADMIN_TOKEN || 'mw-admin-token-change-me';
const DASHBOARD = 'http://localhost:3000/#dashboard';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function login(page) {
  await page.goto(DASHBOARD);
  const tokenBox = page.getByPlaceholder(/Bearer token/i);
  await tokenBox.fill(ADMIN_TOKEN);
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForLoadState('networkidle').catch(() => {});
}

async function triggerAudit(page, pkg) {
  const nameBox = page.getByPlaceholder(/package name/i);
  await nameBox.fill(pkg);
  await page.getByRole('button', { name: /Audit/ }).click();
  await sleep(800);
}

async function main() {
  const browser = await chromium.launch({
    headless: false,
    args: ['--window-position=960,0', '--window-size=960,1080'],
  });
  const ctx = await browser.newContext({ viewport: { width: 960, height: 1040 } });
  const page = await ctx.newPage();

  // t=0..14: terminal does its thing. We just sit on the dashboard.
  await login(page);
  await sleep(14000);

  // t=14..18: pan
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await sleep(4000);

  // t=18..32: trigger 3 audits
  for (const pkg of ['tiny', 'delay', 'nanoid']) {
    await triggerAudit(page, pkg);
    await sleep(4000);
  }

  // t=32..44: scroll to progress bar
  await page.evaluate(() => {
    const h = [...document.querySelectorAll('h3')]
      .find(e => /Current Package Review Progress/i.test(e.textContent || ''));
    h?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  await sleep(12000);

  // t=44..52: click Quarantined column
  await page.getByText('Quarantined', { exact: false }).first().click().catch(() => {});
  await sleep(8000);

  // t=52..62: click dotenv detail
  await page.getByText(/dotenv@17\.4\.2/).first().click().catch(() => {});
  await sleep(10000);

  // t=62..72: Prompts tab
  await page.getByRole('button', { name: 'Prompts' }).click();
  await sleep(2000);
  // Try to expand first pack
  const firstExpand = page.locator('button:has-text("Expand"), [role="button"]:has-text("Show")').first();
  await firstExpand.click().catch(() => {});
  await sleep(8000);

  // t=72..90: terminal does install + final hold. We hold.
  await sleep(18000);

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
