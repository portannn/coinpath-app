const { chromium } = require('playwright');
const path = require('path');

const OUT = path.join(__dirname, 'shots');
const BASE = 'http://localhost:8899/harness.html';

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const ctx = await browser.newContext({
    viewport: { width: 420, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: process.env.SCHEME === 'light' ? 'light' : 'dark'
  });
  const page = await ctx.newPage();

  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  const suffix = process.env.SCHEME === 'light' ? '-light' : '';

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#app:not(.hidden)', { timeout: 10000 });
  await page.waitForTimeout(900);

  async function shot(name, full) {
    await page.screenshot({ path: path.join(OUT, name + suffix + '.png'), fullPage: !!full });
  }

  // 1. Home
  await shot('01-home', true);

  // 2. Budgets
  await page.click('.tabbar button[data-screen="budgets"]');
  await page.waitForTimeout(400);
  await shot('02-budgets', true);

  // 3. Trends
  await page.click('.tabbar button[data-screen="trends"]');
  await page.waitForTimeout(500);
  await shot('03-trends', true);

  // 4. Add sheet
  await page.click('.tabbar button[data-screen="home"]');
  await page.waitForTimeout(200);
  await page.click('#fabAdd');
  await page.waitForTimeout(450);
  // tap a few numpad keys + a category to show a filled state
  await page.click('#numpad button[data-key="4"]');
  await page.click('#numpad button[data-key="5"]');
  await page.click('#numpad button[data-key="000"]');
  await page.click('#txCategoryChips button[data-cat="dining"]');
  await page.waitForTimeout(300);
  await shot('04-add');

  // 5. History
  await page.keyboard.press('Escape');
  await page.waitForTimeout(350);
  await page.click('[data-goto="history"]');
  await page.waitForTimeout(400);
  await shot('05-history', true);

  // 6. More
  await page.click('.tabbar button[data-screen="more"]');
  await page.waitForTimeout(300);
  await shot('06-more', true);

  // 7. Recurring sheet
  await page.click('#openRecurring');
  await page.waitForTimeout(450);
  await shot('07-recurring');

  // 8. Empty state
  await page.keyboard.press('Escape');
  await page.goto(BASE + '?empty=1', { waitUntil: 'networkidle' });
  await page.waitForSelector('#app:not(.hidden)', { timeout: 10000 });
  await page.waitForTimeout(700);
  await shot('08-empty', true);

  // sanity assertions on the seeded view
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#app:not(.hidden)');
  await page.waitForTimeout(900);
  const facts = await page.evaluate(() => ({
    hero: document.querySelector('#heroValue').textContent,
    heroLabel: document.querySelector('#heroLabel').textContent,
    expense: document.querySelector('#tileExpense').textContent,
    income: document.querySelector('#tileIncome').textContent,
    net: document.querySelector('#tileNet').textContent,
    pace: document.querySelector('#tilePace').textContent,
    alerts: document.querySelectorAll('#alertsList .alert').length,
    recent: document.querySelectorAll('#recentList .tx').length,
    budgetRows: document.querySelectorAll('#budgetList .budget-row').length,
    goals: document.querySelectorAll('#goalsList .goal').length,
    trendBars: document.querySelectorAll('#trendChart rect[fill^="var"]').length,
    catBars: document.querySelectorAll('#catChart rect[fill^="var"]').length,
    insights: document.querySelectorAll('#insightsList .alert').length,
    monthLabel: document.querySelector('#monthLabel').textContent
  }));

  console.log(JSON.stringify(facts, null, 2));
  if (errors.length) {
    console.log('\n--- JS ERRORS ---');
    errors.forEach(e => console.log(e));
  } else {
    console.log('\nNo JS errors.');
  }

  await browser.close();
})();
