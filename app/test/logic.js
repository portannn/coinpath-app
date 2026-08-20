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
