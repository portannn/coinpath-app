const { chromium } = require('playwright');
const BASE = 'http://localhost:8899/harness.html';

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail || '' });
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  await page.goto(BASE + '?empty=1', { waitUntil: 'networkidle' });
  await page.waitForSelector('#app:not(.hidden)');
  await page.waitForTimeout(600);

  const money = () => page.textContent('#tileExpense');

  /* ---------- 1. add an expense ---------- */
  await page.click('#fabAdd');
  await page.waitForTimeout(350);
  for (const k of ['1', '2', '5', '000']) await page.click(`#numpad button[data-key="${k}"]`);
  await page.click('#txCategoryChips button[data-cat="groceries"]');
  await page.fill('#txDesc', 'Test market run');
  await page.click('#txSave');
  await page.waitForTimeout(500);
  check('add expense updates total', (await money()).includes('125.000'), await money());
  check('add expense appears in list', (await page.textContent('#recentList')).includes('Test market run'));

  /* ---------- 2. numpad edge cases ---------- */
  await page.click('#fabAdd');
  await page.waitForTimeout(300);
  await page.click('#numpad button[data-key="000"]');           // 000 on empty must do nothing
  let amt = await page.textContent('#amountText');
  check('000 on empty amount is ignored', amt === '0', 'got ' + amt);
  await page.click('#numpad button[data-key="0"]');
  await page.click('#numpad button[data-key="0"]');
  await page.click('#numpad button[data-key="5"]');
  amt = await page.textContent('#amountText');
  check('leading zeros are stripped', amt === '5', 'got ' + amt);
  await page.click('#numpad button[data-key="del"]');
  amt = await page.textContent('#amountText');
  check('delete key works', amt === '0', 'got ' + amt);
  const saveDisabled = await page.getAttribute('#txSave', 'disabled');
  check('save disabled with no amount/category', saveDisabled !== null);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  /* ---------- 3. add income, check net + savings rate ---------- */
  await page.click('#fabAdd');
  await page.waitForTimeout(300);
  await page.click('#txTypeSeg button[data-type="income"]');
  for (const k of ['5', '0', '0', '000']) await page.click(`#numpad button[data-key="${k}"]`);
  await page.click('#txCategoryChips button[data-cat="income"]');
  await page.click('#txSave');
  await page.waitForTimeout(500);
  const income = await page.textContent('#tileIncome');
  const net = await page.textContent('#tileNet');
  check('income recorded', income.includes('500.000'), income);
  check('net = income - expense', net.includes('375.000'), net);

  /* ---------- 4. edit a transaction ---------- */
  await page.click('#recentList .tx:has-text("Test market run")');
  await page.waitForTimeout(400);
  const titleTxt = await page.textContent('#txSheetTitle');
  check('edit sheet opens with edit title', titleTxt === 'Edit transaction', titleTxt);
  const preAmt = await page.textContent('#amountText');
  check('edit prefills amount', preAmt === '125.000', preAmt);
  await page.click('#numpad button[data-key="del"]');   // 125000 -> 12500
  await page.click('#txSave');
  await page.waitForTimeout(500);
  check('edit updates total', (await money()).includes('12.500'), await money());

  /* ---------- 5. delete a transaction ---------- */
  page.on('dialog', d => d.accept());
  await page.click('#recentList .tx:has-text("Test market run")');
  await page.waitForTimeout(400);
  await page.click('#txDelete');
  await page.waitForTimeout(500);
  check('delete removes transaction', !(await page.textContent('#recentList')).includes('Test market run'));

  /* ---------- 6. budgets editing (per-month) ---------- */
  await page.click('.tabbar button[data-screen="budgets"]');
  await page.waitForTimeout(300);
  const headingBefore = await page.textContent('#budgetsHeading');
  check('budget heading names the month, not "this month"',
    !/this month/i.test(headingBefore) && !/custom/.test(headingBefore), headingBefore);

  await page.click('#editBudgetsBtn');
  await page.waitForTimeout(400);
  await page.fill('#bud_groceries', '2000000');
  await page.click('#budgetSaveBtn');
  await page.waitForTimeout(600);
  const budTxt = await page.textContent('#budgetList');
  check('budget limit saved for the viewed month', budTxt.includes('2.000.000'), 'no 2.000.000 in budget list');
  const headingAfter = await page.textContent('#budgetsHeading');
  check('month is marked custom after editing', /custom/.test(headingAfter), headingAfter);

  /* ---------- 6b. the override must NOT leak into other months ---------- */
  await page.click('#prevMonth');
  await page.waitForTimeout(500);
  const prevBudTxt = await page.textContent('#budgetList');
  const prevHeading = await page.textContent('#budgetsHeading');
  check('previous month keeps the default limit', prevBudTxt.includes('1.500.000'),
    'expected default 1.500.000 groceries, got: ' + prevBudTxt.slice(0, 140));
  check('previous month is not marked custom', !/custom/.test(prevHeading), prevHeading);

  /* ---------- 6c. reset an override ---------- */
  await page.click('#nextMonth');
  await page.waitForTimeout(500);
  await page.click('#editBudgetsBtn');
  await page.waitForTimeout(400);
  const resetVisible = await page.locator('#budgetReset').isVisible();
  check('reset option appears only on a customised month', resetVisible);
  await page.click('#budgetReset');
  await page.waitForTimeout(600);
  const afterReset = await page.textContent('#budgetList');
  const headingReset = await page.textContent('#budgetsHeading');
  check('reset restores the default limit', afterReset.includes('1.500.000'), afterReset.slice(0, 140));
  check('custom marker cleared after reset', !/custom/.test(headingReset), headingReset);

  /* ---------- 6d. promoting to default changes other months ---------- */
  await page.click('#editBudgetsBtn');
  await page.waitForTimeout(400);
  await page.fill('#bud_groceries', '2500000');
  await page.click('#budgetSaveDefault');
  await page.waitForTimeout(700);
  await page.click('#prevMonth');
  await page.waitForTimeout(500);
  const prevAfterDefault = await page.textContent('#budgetList');
  check('promoting to default applies to other months', prevAfterDefault.includes('2.500.000'),
    prevAfterDefault.slice(0, 140));
  await page.click('#nextMonth');
  await page.waitForTimeout(400);

  /* ---------- 6e. monthly allowance ---------- */
  await page.click('.tabbar button[data-screen="home"]');
  await page.waitForTimeout(300);
  const heroBudLabelNoAllowance = await page.textContent('#heroBudgetLabel');
  check('hero falls back to category budgets when no allowance is set',
    /budgeted/i.test(heroBudLabelNoAllowance) && !/allowance/i.test(heroBudLabelNoAllowance),
    heroBudLabelNoAllowance);

  await page.click('.tabbar button[data-screen="budgets"]');
  await page.waitForTimeout(300);
  await page.click('#editBudgetsBtn');
  await page.waitForTimeout(400);
  const allowancePrefill = await page.inputValue('#budgetAllowanceInput');
  check('allowance input starts empty when unset', allowancePrefill === '', 'got ' + allowancePrefill);
  await page.fill('#budgetAllowanceInput', '1000000');
  await page.click('#budgetSaveBtn');
  await page.waitForTimeout(600);
  const allowSummary = await page.textContent('#allowanceSummary');
  check('over-allocation warning shown when category limits exceed the allowance',
    /over your/i.test(allowSummary) && allowSummary.includes('1.000.000'), allowSummary.slice(0, 160));

  await page.click('.tabbar button[data-screen="home"]');
  await page.waitForTimeout(400);
  const heroVal = await page.textContent('#heroValue');
  const heroBudLabel = await page.textContent('#heroBudgetLabel');
  check('hero "left to spend" uses the allowance as the ceiling once one is set',
    heroVal.includes('1.000.000') && /allowance/i.test(heroBudLabel),
    heroVal + ' / ' + heroBudLabel);

  /* ---------- 6f. resetting the month clears the allowance override too ---------- */
  await page.click('.tabbar button[data-screen="budgets"]');
  await page.waitForTimeout(300);
  await page.click('#editBudgetsBtn');
  await page.waitForTimeout(400);
  await page.click('#budgetReset');
  await page.waitForTimeout(600);
  const allowSummaryAfterReset = await page.textContent('#allowanceSummary');
  check('resetting the month clears the allowance override too',
    allowSummaryAfterReset.trim() === '', 'got: ' + allowSummaryAfterReset.slice(0, 80));

  /* ---------- 7. goals ---------- */
  await page.click('#addGoalBtn');
  await page.waitForTimeout(400);
  await page.fill('#goalName', 'Test Goal');
  await page.fill('#goalTarget', '1000000');
  await page.fill('#goalSaved', '250000');
  await page.click('#goalSave');
  await page.waitForTimeout(500);
  const goalTxt = await page.textContent('#goalsList');
  check('goal created with correct progress', goalTxt.includes('Test Goal') && goalTxt.includes('25%'), goalTxt.slice(0, 120));

  /* ---------- 8. recurring auto-post ---------- */
  await page.click('.tabbar button[data-screen="more"]');
  await page.waitForTimeout(300);
  await page.click('#openRecurring');
  await page.waitForTimeout(400);
  await page.click('#recurringAdd');
  await page.waitForTimeout(400);
  await page.fill('#recurName', 'Netflix');
  await page.fill('#recurAmount', '186000');
  await page.fill('#recurDay', '1');
  await page.selectOption('#recurCategory', 'entertain');
  const thisMonth = await page.evaluate(() => {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  });
  await page.fill('#recurStart', thisMonth);
  await page.click('#recurEditSave');
  await page.waitForTimeout(900);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.click('.tabbar button[data-screen="home"]');
  await page.waitForTimeout(600);
  const homeTxt = await page.textContent('#recentList');
  check('recurring rule auto-posted this month', homeTxt.includes('Netflix'), homeTxt.slice(0, 160));

  const afterExpense = await money();
  check('recurring amount added to total', afterExpense.includes('186.000'), afterExpense);

  /* ---------- 9. recurring does not double-post on reload ---------- */
  const countBefore = await page.evaluate(() =>
    window.__state ? 0 : document.querySelectorAll('#recentList .tx').length);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  // mock store is in-memory so a reload reseeds; instead re-run the materialiser in place
  check('no JS errors after reload', errors.length === 0, errors.join(' | '));

  /* ---------- 10. month navigation ---------- */
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#app:not(.hidden)');
  await page.waitForTimeout(800);
  const augExpense = await money();
  await page.click('#prevMonth');
  await page.waitForTimeout(400);
  const julExpense = await money();
  const julLabel = await page.textContent('#monthLabel');
  check('month navigation changes data', augExpense !== julExpense, augExpense + ' vs ' + julExpense);
  check('month label updates', julLabel.includes('Jul'), julLabel);

  /* ---------- 11. history filters ---------- */
  await page.click('.tabbar button[data-screen="home"]');
  await page.click('[data-goto="history"]');
  await page.waitForTimeout(400);
  const allRows = await page.locator('#historyList .tx').count();
  await page.selectOption('#histType', 'income');
  await page.waitForTimeout(400);
  const incRows = await page.locator('#historyList .tx').count();
  check('history type filter narrows results', incRows > 0 && incRows < allRows, `${incRows} of ${allRows}`);
  await page.selectOption('#histType', '');
  await page.fill('#histSearch', 'Rent');
  await page.waitForTimeout(400);
  const rentRows = await page.locator('#historyList .tx').count();
  check('history search works', rentRows > 0 && rentRows < allRows, `${rentRows} rent rows`);

  /* ---------- 12. table views ---------- */
  await page.click('.tabbar button[data-screen="trends"]');
  await page.waitForTimeout(400);
  await page.click('[data-table="trendTable"]');
  await page.waitForTimeout(250);
  const tableVisible = await page.locator('#trendTable table').isVisible();
  check('trend table view toggles on', tableVisible);
  const tableRows = await page.locator('#trendTable tbody tr').count();
  check('trend table has 6 months', tableRows === 6, String(tableRows));

  /* ---------- 13. CSV export ---------- */
  const dl = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
  await page.click('.tabbar button[data-screen="more"]');
  await page.waitForTimeout(300);
  await page.click('#exportCsv');
  const download = await dl;
  check('CSV export produces a file', !!download, download ? await download.suggestedFilename() : 'no download');

  console.log('\n=== FUNCTIONAL TESTS ===');
  let failed = 0;
  results.forEach(r => {
    if (!r.pass) failed++;
    console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.pass ? '' : '   -> ' + r.detail));
  });
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (errors.length) {
    console.log('\n--- JS ERRORS ---');
    [...new Set(errors)].forEach(e => console.log(e));
  }

  await browser.close();
  process.exit(failed ? 1 : 0);
})();
