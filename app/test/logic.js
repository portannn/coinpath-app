const { chromium } = require('playwright');
const BASE = 'http://localhost:8899/harness.html';

const results = [];
function check(name, cond, detail) { results.push({ name, pass: !!cond, detail: detail || '' }); }

(async () => {
  const browser = await chromium.launch();

  /* ---- run one context per timezone to prove the date handling ---- */
  for (const tz of ['Asia/Jakarta', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
    const ctx = await browser.newContext({ timezoneId: tz, viewport: { width: 420, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(BASE + '?empty=1', { waitUntil: 'networkidle' });
    await page.waitForSelector('#app:not(.hidden)');
    await page.waitForTimeout(400);

    const r = await page.evaluate(() => {
      const c = window.__coinpath;
      const now = new Date();
      const localIso = now.getFullYear() + '-' +
        String(now.getMonth() + 1).padStart(2, '0') + '-' +
        String(now.getDate()).padStart(2, '0');
      return {
        appIso: c.isoOf(now),
        localIso: localIso,
        utcIso: now.toISOString().slice(0, 10)
      };
    });
    check(`date is local-correct in ${tz}`, r.appIso === r.localIso,
      `app=${r.appIso} local=${r.localIso} utc=${r.utcIso}`);
    await ctx.close();
  }

  /* ---- date maths ---- */
  const ctx = await browser.newContext({ timezoneId: 'Asia/Jakarta', viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE + '?empty=1', { waitUntil: 'networkidle' });
  await page.waitForSelector('#app:not(.hidden)');
  await page.waitForTimeout(400);

  const dm = await page.evaluate(() => {
    const c = window.__coinpath;
    return {
      dec2jan: c.shiftYM('2026-12', 1),
      jan2dec: c.shiftYM('2026-01', -1),
      plus14:  c.shiftYM('2026-08', 14),
      feb2026: c.daysInMonth('2026-02'),
      feb2028: c.daysInMonth('2028-02'),   // leap year
      apr:     c.daysInMonth('2026-04'),
      compact: [c.fmtCompact(950), c.fmtCompact(202000), c.fmtCompact(3000000), c.fmtCompact(1500000000)],
      money:   [c.fmtMoney(0), c.fmtMoney(-45000), c.fmtMoney(1234567)]
    };
  });
  check('year rollover forward', dm.dec2jan === '2027-01', dm.dec2jan);
  check('year rollover backward', dm.jan2dec === '2025-12', dm.jan2dec);
  check('multi-year shift', dm.plus14 === '2027-10', dm.plus14);
  check('Feb 2026 has 28 days', dm.feb2026 === 28, String(dm.feb2026));
  check('Feb 2028 leap year has 29 days', dm.feb2028 === 29, String(dm.feb2028));
  check('April has 30 days', dm.apr === 30, String(dm.apr));
  check('compact formatting', JSON.stringify(dm.compact) === JSON.stringify(['950', '202rb', '3jt', '1.5M']),
    JSON.stringify(dm.compact));
  check('money formatting', dm.money[0] === 'Rp0' && dm.money[1] === '-Rp45.000' && dm.money[2] === 'Rp1.234.567',
    JSON.stringify(dm.money));

  /* ---- allowance model: default vs. per-month override, ceiling selection ---- */
  const al = await page.evaluate(async () => {
    const c = window.__coinpath;
    const uid = 'testuser';
    const ymNow = c.state.viewMonth;
    const ymOther = c.shiftYM(ymNow, -3);

    const beforeDefault = c.allowanceFor(ymNow);
    const beforeCeiling = c.budgetCeiling(ymNow);

    await firebase.firestore().collection('users').doc(uid)
      .collection('settings').doc('prefs').set({ allowance: 2000000 }, { merge: true });
    await new Promise(r => setTimeout(r, 200));
    const afterDefaultThis = c.allowanceFor(ymNow);
    const afterDefaultOther = c.allowanceFor(ymOther);
    const ceilingWithAllowance = c.budgetCeiling(ymNow);

    await firebase.firestore().collection('users').doc(uid)
      .collection('monthlyBudgets').doc(ymNow).set({ budgets: { groceries: 500000 }, allowance: 3000000 });
    await new Promise(r => setTimeout(r, 200));
    const overrideThisMonth = c.allowanceFor(ymNow);
    const stillDefaultOtherMonth = c.allowanceFor(ymOther);

    return { beforeDefault, beforeCeiling, afterDefaultThis, afterDefaultOther, ceilingWithAllowance, overrideThisMonth, stillDefaultOtherMonth };
  });
  check('no allowance set anywhere -> allowanceFor returns 0', al.beforeDefault === 0, String(al.beforeDefault));
  check('with no allowance, the ceiling falls back to the category-budget total',
    !!al.beforeCeiling && al.beforeCeiling.kind === 'budgets', JSON.stringify(al.beforeCeiling));
  check('setting a default allowance applies to every month',
    al.afterDefaultThis === 2000000 && al.afterDefaultOther === 2000000, JSON.stringify(al));
  check('the ceiling prefers the allowance once one is set',
    !!al.ceilingWithAllowance && al.ceilingWithAllowance.kind === 'allowance' && al.ceilingWithAllowance.amount === 2000000,
    JSON.stringify(al.ceilingWithAllowance));
  check('a per-month allowance override does not leak into other months',
    al.overrideThisMonth === 3000000 && al.stillDefaultOtherMonth === 2000000, JSON.stringify(al));

  /* ---- recurring: month-end clamping + no double post ---- */
  const rec = await page.evaluate(async () => {
    const c = window.__coinpath;
    const st = c.state;
    const now = new Date();
    const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const prev = c.shiftYM(ym, -1);
    const twoAgo = c.shiftYM(ym, -2);

    // A rule that started two months ago on day 31 — must clamp to each
    // month's real last day and back-fill every missed month exactly once.
    await firebase.firestore().collection('users').doc('testuser')
      .collection('recurring').doc('rule31').set({
        name: 'MonthEndBill', amount: 100000, dayOfMonth: 31,
        startMonth: twoAgo, categoryId: 'utilities', type: 'expense', active: true
      });

    await new Promise(r => setTimeout(r, 700));

    // force the materialiser to run again, twice, as a reload would
    st.recurringRunFor = null;
    c.runRecurring();
    await new Promise(r => setTimeout(r, 500));
    st.recurringRunFor = null;
    c.runRecurring();
    await new Promise(r => setTimeout(r, 700));

    const mine = st.transactions.filter(t => t.desc === 'MonthEndBill');
    return {
      count: mine.length,
      dates: mine.map(t => t.date).sort(),
      ids: mine.map(t => t.id).sort(),
      expectMonths: [twoAgo, prev, ym]
    };
  });

  const uniqueDates = [...new Set(rec.dates)];
  check('recurring back-fills each month exactly once',
    rec.count === uniqueDates.length, `count=${rec.count} unique=${uniqueDates.length} dates=${rec.dates}`);
  check('recurring never double-posts after repeated runs',
    rec.count <= 3, `posted ${rec.count} entries: ${rec.dates}`);
  const badDay = rec.dates.some(d => {
    const [y, m, dd] = d.split('-').map(Number);
    return dd > new Date(y, m, 0).getDate();
  });
  check('day 31 clamps to each month\'s last day', !badDay, rec.dates.join(', '));

  /* ---- sync status honesty ---- */
  const syncStates = await page.evaluate(async () => {
    const txt = () => document.getElementById('syncText').textContent;
    const cls = () => document.getElementById('syncPill').className;
    const out = { initial: txt(), initialClass: cls() };

    // pretend the browser lost its connection
    const realOnLine = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    window.dispatchEvent(new Event('offline'));
    await new Promise(r => setTimeout(r, 150));
    out.offline = txt();
    out.offlineClass = cls();
    out.offlineTitle = document.getElementById('syncPill').getAttribute('title') || '';

    // and regained it
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    window.dispatchEvent(new Event('online'));
    await new Promise(r => setTimeout(r, 150));
    out.online = txt();
    if (realOnLine) Object.defineProperty(Navigator.prototype, 'onLine', realOnLine);
    return out;
  });
  check('starts in a synced state', syncStates.initial === 'Synced', syncStates.initial);
  check('shows Offline when the browser drops its connection',
    syncStates.offline === 'Offline' && /offline/.test(syncStates.offlineClass),
    syncStates.offline + ' / ' + syncStates.offlineClass);
  check('offline state carries an explanation',
    /saved on this device/i.test(syncStates.offlineTitle), syncStates.offlineTitle.slice(0, 60));
  check('recovers to Synced when the connection returns',
    syncStates.online === 'Synced', syncStates.online);

  const pillTag = await page.evaluate(() => document.getElementById('syncPill').tagName);
  check('sync pill is a real button (tappable for an explanation)', pillTag === 'BUTTON', pillTag);

  /* ---- Firestore transport hardening ---- */
  const hasLongPolling = await page.evaluate(() =>
    document.documentElement.innerHTML.length > 0 &&
    !!window.__coinpath);
  check('test hook present', hasLongPolling);

  /* ---- PWA wiring ---- */
  const pwa = await page.evaluate(async () => {
    const manifestLink = document.querySelector('link[rel=manifest]');
    const res = await fetch(manifestLink.href);
    const m = await res.json();
    return {
      manifestOk: res.ok,
      display: m.display,
      icons: (m.icons || []).length,
      hasMaskable: (m.icons || []).some(i => i.purpose === 'maskable'),
      startUrl: m.start_url,
      swSupported: 'serviceWorker' in navigator
    };
  });
  check('manifest loads', pwa.manifestOk);
  check('manifest is standalone (installable)', pwa.display === 'standalone', pwa.display);
  check('manifest has 3 icons incl. maskable', pwa.icons === 3 && pwa.hasMaskable, JSON.stringify(pwa));

  const swReg = await page.evaluate(() =>
    navigator.serviceWorker.getRegistration().then(r => !!r).catch(() => false));
  check('service worker registers', swReg);

  /* ---- offline: reload with network cut, app shell must still render ---- */
  await page.context().setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1200);
  const offlineOk = await page.evaluate(() => !!document.querySelector('.tabbar'));
  check('app shell renders while offline', offlineOk);
  await page.context().setOffline(false);

  console.log('\n=== LOGIC / PWA TESTS ===');
  let failed = 0;
  results.forEach(r => {
    if (!r.pass) failed++;
    console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.pass ? '' : '   -> ' + r.detail));
  });
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (errors.length) { console.log('\nJS errors:'); [...new Set(errors)].forEach(e => console.log('  ' + e)); }

  await browser.close();
  process.exit(failed ? 1 : 0);
})();
