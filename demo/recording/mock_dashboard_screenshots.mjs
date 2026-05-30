// Mock-packages into every dashboard column and screenshot each column.
// Run: node demo/recording/mock_dashboard_screenshots.mjs

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const DASHBOARD = 'http://localhost:3000/#dashboard';
const OUT_DIR = join(import.meta.dirname, 'frames');
mkdirSync(OUT_DIR, { recursive: true });

// Column colour palette (border-top) + left-border for inner cards
const COLORS = {
  'No Decision':       { top: '#546E7A', left: '#546E7A' },
  'Queued':            { top: '#1565C0', left: '#1565C0' },
  'Running':           { top: '#6A1B9A', left: '#6A1B9A' },
  'Needs Escalation':  { top: '#E65100', left: '#E65100' },
  'Quarantined':       { top: '#F57F17', left: '#F57F17' },
  'Blocked':           { top: '#C62828', left: '#C62828' },
  'Allowed':           { top: '#2E7D32', left: '#2E7D32' },
  'Promotion Pending': { top: '#546E7A', left: '#546E7A' },
  'Promoted':          { top: '#546E7A', left: '#2E7D32' },
  'Failed':            { top: '#C62828', left: '#C62828' },
  'Superseded':        { top: '#546E7A', left: '#546E7A' },
};

const MOCK_PACKAGES = [
  { name: '📥 express@4.21.0', time: '3h', desc: 'express@4.21.0 is the core HTTP framework for Node.js with mi' },
  { name: '📥 debug@4.3.7', time: '2h', desc: 'debug@4.3.7 is a tiny JavaScript debugging utility modelled af' },
  { name: '📥 axios@1.7.9', time: '5h', desc: 'axios@1.7.9 is a promise-based HTTP client for the browser and ' },
  { name: '📥 lodash@4.17.21', time: '1h', desc: 'lodash@4.17.21 is a modern JavaScript utility library deliveri' },
  { name: '📥 chalk@5.3.0', time: '30m', desc: 'chalk@5.3.0 is a popular terminal string styling library with ' },
  { name: '📥 uuid@10.0.0', time: '6h', desc: 'uuid@10.0.0 generates RFC9562 UUIDs with zero external depende' },
  { name: '📥 semver@7.6.3', time: '8h', desc: 'semver@7.6.3 is the canonical semantic versioning parser used ' },
  { name: '📥 commander@12.1.0', time: '4h', desc: 'commander@12.1.0 is a complete solution for writing node.js co' },
  { name: '📥 minimist@1.2.8', time: '2h', desc: 'minimist@1.2.8 is a minimal argument parser with a long standi' },
  { name: '📥 event-stream@4.0.1', time: '1d', desc: 'event-stream@4.0.1 is a toolkit for creating and working with ' },
  { name: '📥 colors@1.4.0', time: '12h', desc: 'colors@1.4.0 adds colour and style to your Node.js console out' },
  { name: '📥 moment@2.30.1', time: '2d', desc: 'moment@2.30.1 is a legacy date manipulation library still wide' },
];

/** Build a package-card div */
function cardHTML(pkg, leftColor) {
  return `<div style="cursor:pointer;margin-top:0.5rem;padding:0.5rem;background:#fff;border-radius:4px;font-size:0.85rem;border-left:3px solid ${leftColor};box-shadow:0 1px 3px rgba(0,0,0,0.1);">\
<div style="font-weight:600;font-size:0.8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${pkg.name}</div>\
<div style="display:flex;gap:0.3rem;margin-top:0.2rem;"><span style="font-size:0.75rem;color:#666;">${pkg.time}</span></div>\
<div style="font-size:0.75rem;color:#555;margin-top:0.2rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${pkg.desc}</div>\
</div>`;
}

async function main() {
  const browser = await chromium.launch({
    headless: false,
    args: ['--start-maximized'],
  });
  const ctx = await browser.newContext({ viewport: null }); // full screen
  const page = await ctx.newPage();

  await page.goto(DASHBOARD, { waitUntil: 'networkidle' });

  // Login
  const tokenBox = page.getByPlaceholder(/Bearer/i);
  if (await tokenBox.count() > 0) {
    await tokenBox.fill('mw-admin-token-change-me');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForTimeout(2000);
  }
  await page.waitForTimeout(3000);

  // Inject mock cards into empty / sparse columns
  await page.evaluate(({ MOCK_PACKAGES, COLORS, cardHTMLFn }) => {
    // Reconstruct the cardHTML function (can't pass functions to evaluate)
    const mkCard = (pkg, leftColor) =>
      `<div style="cursor:pointer;margin-top:0.5rem;padding:0.5rem;background:#fff;border-radius:4px;font-size:0.85rem;border-left:3px solid ${leftColor};box-shadow:0 1px 3px rgba(0,0,0,0.1);">\
<div style="font-weight:600;font-size:0.8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${pkg.name}</div>\
<div style="display:flex;gap:0.3rem;margin-top:0.2rem;"><span style="font-size:0.75rem;color:#666;">${pkg.time}</span></div>\
<div style="font-size:0.75rem;color:#555;margin-top:0.2rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${pkg.desc}</div>\
</div>`;

    // Select all column divs
    const columns = document.querySelectorAll('div[style*="min-width: 180px"][style*="border-radius: 8px"]');
    let pkgIdx = 0;

    for (const col of columns) {
      const headerSpan = col.querySelector('span[style*="font-weight: 600"]');
      if (!headerSpan) continue;
      const colName = headerSpan.textContent.trim();

      const colorInfo = COLORS[colName];
      if (!colorInfo) continue;

      // Find the badge that shows the count
      const badge = col.querySelector('span[style*="border-radius: 12px"]');
      const existingCards = col.querySelectorAll('div[style*="border-left: 3px solid"]').length;

      // Add cards for columns that have < 3 cards
      const toAdd = Math.max(0, 3 - existingCards);
      const pkgs = [];
      for (let i = 0; i < toAdd; i++) {
        pkgs.push(MOCK_PACKAGES[(pkgIdx + i) % MOCK_PACKAGES.length]);
      }
      pkgIdx += toAdd;

      const newCardsHTML = pkgs.map(p => mkCard(p, colorInfo.left)).join('');

      // Inject after the last child (or after the header)
      if (newCardsHTML) {
        col.insertAdjacentHTML('beforeend', newCardsHTML);
      }

      // Update badge count
      if (badge) {
        const newCount = existingCards + toAdd;
        badge.textContent = newCount;
      }
    }
  }, { MOCK_PACKAGES, COLORS });

  await page.waitForTimeout(1000);

  // ---- Screenshot 1: Full dashboard ----
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT_DIR, 'dashboard-all-columns.png'), fullPage: true });
  console.log('saved: dashboard-all-columns.png');

  // ---- Screenshot 2: Individual columns ----
  // Scroll to the columns row
  const columns = [
    'No Decision', 'Queued', 'Running', 'Needs Escalation', 'Quarantined',
    'Blocked', 'Allowed', 'Promotion Pending', 'Promoted', 'Failed', 'Superseded',
  ];

  for (const colName of columns) {
    // Find and scroll the column into view
    await page.evaluate((name) => {
      const spans = [...document.querySelectorAll('span[style*="font-weight: 600"]')];
      const el = spans.find(s => s.textContent.trim() === name);
      if (el) el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
    }, colName);
    await page.waitForTimeout(300);

    // Take full-page screenshot (shows the column in context)
    const safeName = colName.toLowerCase().replace(/ /g, '-');
    await page.screenshot({
      path: join(OUT_DIR, `col-${safeName}.png`),
      fullPage: true,
    });
    console.log(`saved: col-${safeName}.png`);
  }

  // Take one more close-up of the columns row area
  await page.evaluate(() => {
    const colsRow = document.querySelector('div[style*="overflow-x: auto"]');
    if (colsRow) colsRow.scrollIntoView({ behavior: 'instant', block: 'start' });
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT_DIR, 'columns-row.png'), fullPage: false });
  console.log('saved: columns-row.png');

  await page.waitForTimeout(2000);
  await browser.close();
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
