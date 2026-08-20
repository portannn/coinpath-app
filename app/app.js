/* ==========================================================================
   Coinpath — budget tracker PWA
   Vanilla JS, no build step. Firebase compat SDK for auth + Firestore.
   ========================================================================== */
'use strict';

/* ------------------------------ constants ------------------------------ */

const DEFAULT_CATEGORIES = [
  { id: 'groceries',   name: 'Groceries',      emoji: '🛒' },
  { id: 'dining',      name: 'Food & Dining',  emoji: '🍜' },
  { id: 'transport',   name: 'Transport',      emoji: '🛵' },
  { id: 'housing',     name: 'Housing',        emoji: '🏠' },
  { id: 'utilities',   name: 'Utilities',      emoji: '💡' },
  { id: 'entertain',   name: 'Entertainment',  emoji: '🎬' },
  { id: 'shopping',    name: 'Shopping',       emoji: '🛍️' },
  { id: 'health',      name: 'Health',         emoji: '💊' },
  { id: 'education',   name: 'Education',      emoji: '📚' },
  { id: 'savings',     name: 'Savings',        emoji: '🏦' },
  { id: 'income',      name: 'Income',         emoji: '💰' },
  { id: 'other',       name: 'Other',          emoji: '📦' }
];

const DEFAULT_BUDGETS = {
  groceries: 1500000, dining: 1000000, transport: 600000, housing: 3000000,
  utilities: 700000, entertain: 400000, shopping: 500000, health: 400000,
  education: 300000, savings: 1000000, other: 300000
};

const CFG = window.APP_DEFAULTS || { currency: 'IDR', locale: 'id-ID', currencySymbol: 'Rp' };
const MAX_BACKFILL_MONTHS = 24;

/* ------------------------------- state -------------------------------- */

const state = {
  user: null,
  transactions: [],          // all transactions, newest first
  budgets: { ...DEFAULT_BUDGETS },
  categories: [...DEFAULT_CATEGORIES],
  goals: [],
  recurring: [],
  viewMonth: ymOf(new Date()),   // "YYYY-MM"
  screen: 'home',
  ready: { tx: false, settings: false, goals: false, recurring: false },
  unsubs: [],
  editingTxId: null,
  editingGoalId: null,
  editingRecurId: null,
  draft: { type: 'expense', amount: '', categoryId: null, desc: '', date: null },
  recurDraft: { type: 'expense' },
  deferredInstall: null,
  recurringRunFor: null
};

/* ------------------------------- utils -------------------------------- */

function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

function pad2(n) { return String(n).padStart(2, '0'); }

/** Local-time ISO date (YYYY-MM-DD). Never use toISOString() — it is UTC and
 *  shifts the date for anyone east or west of Greenwich. */
function isoOf(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function todayISO() { return isoOf(new Date()); }
function ymOf(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }
function ymOfISO(iso) { return (iso || '').slice(0, 7); }

function parseYM(ym) {
  const parts = String(ym).split('-');
  return { y: parseInt(parts[0], 10), m: parseInt(parts[1], 10) };
}
function shiftYM(ym, delta) {
  const p = parseYM(ym);
  const d = new Date(p.y, p.m - 1 + delta, 1);
  return ymOf(d);
}
function daysInMonth(ym) {
  const p = parseYM(ym);
  return new Date(p.y, p.m, 0).getDate();
}
function monthLabel(ym, opts) {
  const p = parseYM(ym);
  return new Date(p.y, p.m - 1, 1).toLocaleDateString(undefined, opts || { month: 'long', year: 'numeric' });
}
function shortMonthLabel(ym) {
  const p = parseYM(ym);
  return new Date(p.y, p.m - 1, 1).toLocaleDateString(undefined, { month: 'short' });
}

function fmtMoney(n, opts) {
  const o = opts || {};
  const neg = n < 0;
  const abs = Math.round(Math.abs(n));
  let body;
  try {
    body = abs.toLocaleString(CFG.locale);
  } catch (e) {
    body = abs.toLocaleString();
  }
  const sym = o.noSymbol ? '' : CFG.currencySymbol;
  return (neg ? '-' : '') + sym + body;
}

/** Compact axis/label money, e.g. 1.5jt / 350rb (IDR) or 1.5M / 350K. */
function fmtCompact(n) {
  const abs = Math.abs(n);
  const isIDR = (CFG.currency || '').toUpperCase() === 'IDR';
  const big = isIDR ? 'jt' : 'M';
  const mid = isIDR ? 'rb' : 'K';
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return sign + trimNum(abs / 1e9) + (isIDR ? 'M' : 'B');
  if (abs >= 1e6) return sign + trimNum(abs / 1e6) + big;
  if (abs >= 1e3) return sign + trimNum(abs / 1e3) + mid;
  return sign + String(Math.round(abs));
}
function trimNum(v) {
  const s = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(v % 1 >= 0.05 ? 1 : 0) : v.toFixed(v % 1 >= 0.05 ? 1 : 0);
  return s.replace(/\.0$/, '');
}

function catById(id) {
  for (let i = 0; i < state.categories.length; i++) {
    if (state.categories[i].id === id) return state.categories[i];
  }
  return { id: id || 'other', name: id || 'Other', emoji: '📦' };
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { el.classList.remove('show'); }, 2100);
}

function relDayLabel(iso) {
  const today = todayISO();
  if (iso === today) return 'Today';
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (iso === isoOf(y)) return 'Yesterday';
  const parts = iso.split('-').map(Number);
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/* --------------------------- firebase setup ---------------------------- */

function configLooksUnset(cfg) {
  if (!cfg || typeof cfg !== 'object') return true;
  if (!cfg.apiKey || !cfg.projectId) return true;
  return /PASTE_YOUR/i.test(cfg.apiKey) || /PASTE_YOUR/i.test(cfg.projectId);
}

let auth = null;
let db = null;

function initFirebase() {
  const cfg = window.FIREBASE_CONFIG;
  if (configLooksUnset(cfg)) {
    show('gateSetup');
    return false;
  }
  try {
    if (!firebase.apps.length) firebase.initializeApp(cfg);
  } catch (e) {
    show('gateSetup');
    console.error('Firebase init failed', e);
    return false;
  }
  auth = firebase.auth();
  db = firebase.firestore();

  // Offline cache so the app works with no connection and syncs on reconnect.
  db.enablePersistence({ synchronizeTabs: true }).catch(function (err) {
    console.warn('Offline persistence unavailable:', err && err.code);
  });

  auth.onAuthStateChanged(function (user) {
    if (user) {
      state.user = user;
      $('#acctEmail').textContent = user.email || '—';
      show('app');
      startSync(user.uid);
    } else {
      state.user = null;
      stopSync();
      show('gateAuth');
    }
  });
  return true;
}

function show(which) {
  ['gateSetup', 'gateAuth', 'loadingView', 'app'].forEach(function (id) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', id !== which);
  });
}

/* ------------------------------ auth UI -------------------------------- */

let authMode = 'signin';

function setAuthMode(mode) {
  authMode = mode;
  const isIn = mode === 'signin';
  $('#authTitle').textContent = isIn ? 'Welcome back' : 'Create your account';
  $('#authBlurb').textContent = isIn
    ? 'Sign in to sync your budget across every device.'
    : 'Use the same email and password on every device to see the same budget.';
  $('#authSubmit').textContent = isIn ? 'Sign in' : 'Create account';
  $('#authPassword').setAttribute('autocomplete', isIn ? 'current-password' : 'new-password');
  $('#authForgot').classList.toggle('hidden', !isIn);
  $('#authToggleLine').innerHTML = isIn
    ? 'New here? <button type="button" id="authToggle">Create an account</button>'
    : 'Already have an account? <button type="button" id="authToggle">Sign in</button>';
  $('#authToggle').addEventListener('click', function () {
    setAuthMode(authMode === 'signin' ? 'signup' : 'signin');
  });
  $('#authError').textContent = '';
}

function friendlyAuthError(e) {
  const code = (e && e.code) || '';
  const map = {
    'auth/invalid-email': 'That email address does not look right.',
    'auth/user-not-found': 'No account with that email — try creating one.',
    'auth/wrong-password': 'Wrong password.',
    'auth/invalid-credential': 'Email or password is incorrect.',
    'auth/email-already-in-use': 'That email already has an account — sign in instead.',
    'auth/weak-password': 'Password needs to be at least 6 characters.',
    'auth/network-request-failed': 'No connection. Check your internet and try again.',
    'auth/too-many-requests': 'Too many attempts. Wait a minute and try again.',
    'auth/operation-not-allowed': 'Email/password sign-in is not enabled in your Firebase project yet.',
    'auth/unauthorized-domain': 'This domain (' + location.hostname + ') is not authorised in Firebase. ' +
      'Add it under Authentication → Settings → Authorized domains, then reload.'
  };
  return map[code] || (e && e.message) || 'Something went wrong.';
}

function wireAuth() {
  setAuthMode('signin');

  $('#authForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    const email = $('#authEmail').value.trim();
    const pw = $('#authPassword').value;
    const errEl = $('#authError');
    errEl.textContent = '';
    const btn = $('#authSubmit');
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Please wait…';

    const p = authMode === 'signin'
      ? auth.signInWithEmailAndPassword(email, pw)
      : auth.createUserWithEmailAndPassword(email, pw);

    p.catch(function (e) { errEl.textContent = friendlyAuthError(e); })
     .finally(function () { btn.disabled = false; btn.textContent = original; });
  });

  $('#authForgot').addEventListener('click', function () {
    const email = $('#authEmail').value.trim();
    if (!email) { $('#authError').textContent = 'Enter your email above first.'; return; }
    auth.sendPasswordResetEmail(email)
      .then(function () { $('#authError').textContent = ''; toast('Reset link sent to ' + email); })
      .catch(function (e) { $('#authError').textContent = friendlyAuthError(e); });
  });
}

/* ------------------------------ data sync ------------------------------ */

function userRef() { return db.collection('users').doc(state.user.uid); }

function setSync(kind, text) {
  const pill = $('#syncPill');
  pill.className = 'sync-pill' + (kind ? ' ' + kind : '');
  $('#syncText').textContent = text;
}

function stopSync() {
  state.unsubs.forEach(function (u) { try { u(); } catch (e) {} });
  state.unsubs = [];
  state.transactions = [];
  state.goals = [];
  state.recurring = [];
  state.ready = { tx: false, settings: false, goals: false, recurring: false };
  state.recurringRunFor = null;
}

function startSync(uid) {
  stopSync();
  setSync('', 'Syncing…');
  const ref = db.collection('users').doc(uid);

  state.unsubs.push(
    ref.collection('transactions').orderBy('date', 'desc').limit(3000)
      .onSnapshot(function (snap) {
        state.transactions = snap.docs.map(function (d) {
          return Object.assign({ id: d.id }, d.data());
        });
        state.ready.tx = true;
        setSync(snap.metadata.fromCache ? 'offline' : '', snap.metadata.fromCache ? 'Offline' : 'Synced');
        afterData();
      }, function (err) {
        console.error(err);
        setSync('error', 'Sync error');
        toast('Could not load transactions — check your Firestore rules.');
      })
  );

  state.unsubs.push(
    ref.collection('settings').doc('prefs').onSnapshot(function (snap) {
      if (snap.exists) {
        const d = snap.data() || {};
        state.budgets = d.budgets || { ...DEFAULT_BUDGETS };
        state.categories = (d.categories && d.categories.length) ? d.categories : [...DEFAULT_CATEGORIES];
      } else {
        ref.collection('settings').doc('prefs').set({
          budgets: DEFAULT_BUDGETS,
          categories: DEFAULT_CATEGORIES,
          createdAt: Date.now()
        }).catch(function (e) { console.warn(e); });
      }
      state.ready.settings = true;
      afterData();
    }, function (err) { console.error(err); })
  );

  state.unsubs.push(
    ref.collection('goals').onSnapshot(function (snap) {
      state.goals = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      state.ready.goals = true;
      afterData();
    }, function (err) { console.error(err); })
  );

  state.unsubs.push(
    ref.collection('recurring').onSnapshot(function (snap) {
      state.recurring = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      state.ready.recurring = true;
      afterData();
    }, function (err) { console.error(err); })
  );
}

function afterData() {
  if (!state.ready.tx || !state.ready.settings) return;
  if (state.ready.recurring) runRecurring();
  renderAll();
}

/* ------------------- recurring transaction materialiser ----------------- */
/* Deterministic doc IDs plus a lastPosted watermark: safe to run on every
   load, never double-posts, and never resurrects a rule occurrence the user
   deleted by hand. */

function runRecurring() {
  const nowMonth = ymOf(new Date());
  if (state.recurringRunFor === nowMonth + ':' + state.recurring.length) return;
  state.recurringRunFor = nowMonth + ':' + state.recurring.length;

  const today = todayISO();
  const batchOps = [];

  state.recurring.forEach(function (rule) {
    if (rule.active === false) return;
    if (!rule.amount || !rule.startMonth) return;

    let cursor = rule.lastPosted ? shiftYM(rule.lastPosted, 1) : rule.startMonth;
    if (cursor < rule.startMonth) cursor = rule.startMonth;

    // never backfill further than MAX_BACKFILL_MONTHS
    const floor = shiftYM(nowMonth, -MAX_BACKFILL_MONTHS);
    if (cursor < floor) cursor = floor;

    let posted = rule.lastPosted || null;
    let guard = 0;

    while (cursor <= nowMonth && guard < MAX_BACKFILL_MONTHS + 2) {
      guard++;
      const dim = daysInMonth(cursor);
      const day = Math.min(Math.max(parseInt(rule.dayOfMonth, 10) || 1, 1), dim);
      const dateIso = cursor + '-' + pad2(day);

      if (dateIso <= today) {
        batchOps.push({
          id: 'rec_' + rule.id + '_' + cursor,
          data: {
            date: dateIso,
            categoryId: rule.categoryId || 'other',
            type: rule.type || 'expense',
            amount: Number(rule.amount) || 0,
            desc: rule.name || 'Recurring',
            recurringId: rule.id,
            createdAt: Date.now()
          }
        });
        posted = cursor;
      }
      cursor = shiftYM(cursor, 1);
    }

    if (posted && posted !== rule.lastPosted) {
      batchOps.push({ ruleId: rule.id, lastPosted: posted });
    }
  });

  if (!batchOps.length) return;

  const batch = db.batch();
  let count = 0;
  batchOps.forEach(function (op) {
    if (op.ruleId) {
      batch.update(userRef().collection('recurring').doc(op.ruleId), { lastPosted: op.lastPosted });
    } else {
      batch.set(userRef().collection('transactions').doc(op.id), op.data);
      count++;
    }
  });
  batch.commit().then(function () {
    if (count) toast(count + ' recurring ' + (count === 1 ? 'entry' : 'entries') + ' posted');
  }).catch(function (e) { console.warn('recurring post failed', e); });
}

/* ---------------------------- computations ----------------------------- */

function txForMonth(ym) {
  return state.transactions.filter(function (t) { return ymOfISO(t.date) === ym; });
}

function monthTotals(ym) {
  const list = txForMonth(ym);
  let income = 0, expense = 0;
  list.forEach(function (t) {
    const a = Number(t.amount) || 0;
    if (t.type === 'income') income += a; else expense += a;
  });
  return { income: income, expense: expense, net: income - expense, count: list.length };
}

function categoryTotals(ym, maxDay) {
  const map = {};
  txForMonth(ym).forEach(function (t) {
    if (t.type === 'income') return;
    if (maxDay && dayOfISO(t.date) > maxDay) return;
    const k = t.categoryId || 'other';
    map[k] = (map[k] || 0) + (Number(t.amount) || 0);
  });
  return map;
}

function dayOfISO(iso) { return parseInt(String(iso).slice(8, 10), 10) || 0; }

/** Comparing a month in progress against a *complete* previous month makes
 *  spending look like it fell off a cliff. When the viewed month is still
 *  running, cut both months at the same day so the comparison is like-for-like. */
function comparisonCutoff(ym) {
  if (ym !== ymOf(new Date())) return null;      // finished month: compare in full
  return new Date().getDate();
}

function expenseUpTo(ym, maxDay) {
  let sum = 0;
  txForMonth(ym).forEach(function (t) {
    if (t.type === 'income') return;
    if (maxDay && dayOfISO(t.date) > maxDay) return;
    sum += Number(t.amount) || 0;
  });
  return sum;
}

function totalBudget() {
  let sum = 0;
  Object.keys(state.budgets).forEach(function (k) { sum += Number(state.budgets[k]) || 0; });
  return sum;
}

function budgetStatus(spent, limit) {
  if (!limit || limit <= 0) return { key: 'none', pct: 0 };
  const pct = spent / limit;
  if (pct > 1) return { key: 'critical', pct: pct };
  if (pct >= 0.9) return { key: 'serious', pct: pct };
  if (pct >= 0.75) return { key: 'warning', pct: pct };
  return { key: 'good', pct: pct };
}

const STATUS_ICON = {
  good: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>',
  serious: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
  critical: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-5M12 8h.01"/></svg>'
};

/** Month progress 0..1 — how far through the viewed month we are.
 *  Past months = 1, future months = 0. */
function monthProgress(ym) {
  const now = new Date();
  const cur = ymOf(now);
  if (ym < cur) return 1;
  if (ym > cur) return 0;
  return now.getDate() / daysInMonth(ym);
}

function buildAlerts(ym) {
  const alerts = [];
  const cats = categoryTotals(ym);
  const progress = monthProgress(ym);
  const isCurrent = ym === ymOf(new Date());

  // 1. over / near budget, worst first
  const rows = [];
  Object.keys(state.budgets).forEach(function (id) {
    const limit = Number(state.budgets[id]) || 0;
    if (limit <= 0) return;
    const spent = cats[id] || 0;
    const st = budgetStatus(spent, limit);
    if (st.key === 'critical' || st.key === 'serious' || st.key === 'warning') {
      rows.push({ id: id, spent: spent, limit: limit, st: st });
    }
  });
  rows.sort(function (a, b) { return b.st.pct - a.st.pct; });
  rows.slice(0, 3).forEach(function (r) {
    const c = catById(r.id);
    if (r.st.key === 'critical') {
      alerts.push({
        kind: 'critical',
        html: '<strong>' + escapeHtml(c.name) + '</strong> is over budget by ' +
              fmtMoney(r.spent - r.limit) + '.'
      });
    } else {
      alerts.push({
        kind: r.st.key === 'serious' ? 'warning' : 'warning',
        html: '<strong>' + escapeHtml(c.name) + '</strong> is at ' + Math.round(r.st.pct * 100) +
              '% of its limit — ' + fmtMoney(r.limit - r.spent) + ' left.'
      });
    }
  });

  // 2. pace projection for the current month
  const tot = monthTotals(ym);
  const budget = totalBudget();
  if (isCurrent && progress > 0.15 && budget > 0 && tot.expense > 0) {
    const projected = tot.expense / progress;
    if (projected > budget * 1.05) {
      alerts.push({
        kind: 'warning',
        html: 'At this pace you will spend about <strong>' + fmtMoney(projected) +
              '</strong> this month — ' + fmtMoney(projected - budget) + ' over your total budget.'
      });
    } else if (projected < budget * 0.85) {
      alerts.push({
        kind: 'good',
        html: 'On pace to finish around <strong>' + fmtMoney(projected) + '</strong> — comfortably under budget.'
      });
    }
  }

  // 3. month-over-month movement on the biggest category
  const prev = categoryTotals(shiftYM(ym, -1));
  let biggest = null;
  Object.keys(cats).forEach(function (id) {
    if (!biggest || cats[id] > cats[biggest]) biggest = id;
  });
  if (biggest && prev[biggest] > 0 && progress >= 0.95) {
    const change = (cats[biggest] - prev[biggest]) / prev[biggest];
    if (Math.abs(change) >= 0.2) {
      alerts.push({
        kind: change > 0 ? 'warning' : 'good',
        html: '<strong>' + escapeHtml(catById(biggest).name) + '</strong> is ' +
              Math.abs(Math.round(change * 100)) + '% ' + (change > 0 ? 'higher' : 'lower') +
              ' than last month.'
      });
    }
  }

  // 4. savings rate
  if (tot.income > 0 && progress >= 0.95) {
    const rate = tot.net / tot.income;
    if (rate >= 0.2) {
      alerts.push({ kind: 'good', html: 'You saved <strong>' + Math.round(rate * 100) + '%</strong> of your income this month.' });
    } else if (rate < 0) {
      alerts.push({ kind: 'critical', html: 'You spent <strong>' + fmtMoney(-tot.net) + '</strong> more than you earned this month.' });
    }
  }

  if (!alerts.length) {
    alerts.push({
      kind: 'good',
      html: tot.count ? 'Nothing needs your attention — every category is within its limit.'
                      : 'No transactions yet this month. Tap + to add your first one.'
    });
  }
  return alerts;
}

function buildInsights(ym) {
  const out = [];
  const cutoff = comparisonCutoff(ym);
  const prevYM = shiftYM(ym, -1);
  const cats = categoryTotals(ym);
  const prevCats = categoryTotals(prevYM, cutoff);
  const tot = monthTotals(ym);
  // like-for-like totals when the viewed month is still running
  const thisExpenseCmp = expenseUpTo(ym, cutoff);
  const prevExpenseCmp = expenseUpTo(prevYM, cutoff);
  const sameSpan = cutoff
    ? ' at this point in ' + monthLabel(prevYM, { month: 'long' })
    : ' versus ' + monthLabel(prevYM, { month: 'long' });

  const ranked = Object.keys(cats).map(function (id) { return { id: id, v: cats[id] }; })
    .sort(function (a, b) { return b.v - a.v; });

  if (!ranked.length) {
    return [{ kind: 'info', html: 'Add a few transactions and insights will show up here.' }];
  }

  const top = ranked[0];
  const share = tot.expense > 0 ? top.v / tot.expense : 0;
  out.push({
    kind: 'info',
    html: '<strong>' + escapeHtml(catById(top.id).name) + '</strong> is your biggest category at ' +
          fmtMoney(top.v) + ' — ' + Math.round(share * 100) + '% of everything you spent.'
  });

  if (prevExpenseCmp > 0) {
    const d = (thisExpenseCmp - prevExpenseCmp) / prevExpenseCmp;
    out.push({
      kind: d > 0.05 ? 'warning' : (d < -0.05 ? 'good' : 'info'),
      html: 'Spending is <strong>' + (d >= 0 ? 'up ' : 'down ') + Math.abs(Math.round(d * 100)) +
            '%</strong> compared with' + sameSpan + '.'
    });
  }

  // biggest mover
  let mover = null;
  Object.keys(cats).forEach(function (id) {
    const before = prevCats[id] || 0;
    if (before < 100000) return;                 // ignore noise on tiny bases
    const delta = cats[id] - before;
    if (!mover || Math.abs(delta) > Math.abs(mover.delta)) {
      mover = { id: id, delta: delta, before: before };
    }
  });
  if (mover && Math.abs(mover.delta) / mover.before >= 0.15) {
    out.push({
      kind: mover.delta > 0 ? 'warning' : 'good',
      html: '<strong>' + escapeHtml(catById(mover.id).name) + '</strong> moved the most: ' +
            (mover.delta > 0 ? '+' : '−') + fmtMoney(Math.abs(mover.delta)) +
            ' compared with' + sameSpan + '.'
    });
  }

  // most frequent
  const freq = {};
  txForMonth(ym).forEach(function (t) {
    if (t.type === 'income') return;
    freq[t.categoryId] = (freq[t.categoryId] || 0) + 1;
  });
  let often = null;
  Object.keys(freq).forEach(function (id) { if (!often || freq[id] > freq[often]) often = id; });
  if (often && freq[often] >= 3) {
    const avg = cats[often] / freq[often];
    out.push({
      kind: 'info',
      html: 'You logged <strong>' + escapeHtml(catById(often).name) + '</strong> ' + freq[often] +
            ' times, averaging ' + fmtMoney(avg) + ' each.'
    });
  }

  if (tot.income > 0) {
    out.push({
      kind: tot.net >= 0 ? 'good' : 'critical',
      html: 'Savings rate this month: <strong>' + Math.round((tot.net / tot.income) * 100) + '%</strong>.'
    });
  }

  return out;
}

/* ------------------------------ rendering ------------------------------ */

function renderAll() {
  $('#monthLabel').textContent = monthLabel(state.viewMonth, { month: 'short', year: 'numeric' });
  renderHome();
  renderBudgets();
  renderGoals();
  renderTrends();
  renderHistory();
  $('#recurringCount').textContent = state.recurring.length;
  $('#categoryCount').textContent = state.categories.length;
}

function renderHome() {
  const ym = state.viewMonth;
  const tot = monthTotals(ym);
  const budget = totalBudget();
  const progress = monthProgress(ym);

  // hero: left to spend against total budget (or net if no budget set)
  if (budget > 0) {
    const left = budget - tot.expense;
    $('#heroLabel').textContent = 'Left to spend';
    $('#heroValue').textContent = fmtMoney(left);
    $('#heroValue').style.color = left < 0 ? 'var(--critical)' : '';
    const pct = Math.max(0, Math.min(1, tot.expense / budget));
    const st = budgetStatus(tot.expense, budget);
    const bar = $('#heroBar');
    bar.style.width = (pct * 100) + '%';
    bar.className = 'bar-fill ' + (st.key === 'none' ? '' : st.key);
    $('#heroSpentLabel').textContent = fmtMoney(tot.expense) + ' spent';
    $('#heroBudgetLabel').textContent = 'of ' + fmtMoney(budget);

    const daysLeft = Math.max(0, daysInMonth(ym) - Math.round(progress * daysInMonth(ym)));
    if (ym === ymOf(new Date()) && daysLeft > 0 && left > 0) {
      $('#heroSub').innerHTML = '<span class="pos">' + fmtMoney(left / daysLeft) + '/day</span> for the ' +
        daysLeft + ' days left';
    } else if (left < 0) {
      $('#heroSub').innerHTML = '<span class="neg">Over budget</span> by ' + fmtMoney(-left);
    } else {
      $('#heroSub').textContent = monthLabel(ym);
    }
  } else {
    $('#heroLabel').textContent = 'Net this month';
    $('#heroValue').textContent = fmtMoney(tot.net);
    $('#heroValue').style.color = tot.net < 0 ? 'var(--critical)' : '';
    $('#heroBar').style.width = '0%';
    $('#heroSpentLabel').textContent = 'No budgets set';
    $('#heroBudgetLabel').textContent = '';
    $('#heroSub').textContent = 'Set limits on the Budgets tab';
  }

  $('#tileExpense').textContent = fmtMoney(tot.expense);
  $('#tileExpenseSub').textContent = tot.count + (tot.count === 1 ? ' transaction' : ' transactions');
  $('#tileIncome').textContent = fmtMoney(tot.income);
  $('#tileIncomeSub').textContent = monthLabel(ym, { month: 'long' });
  $('#tileNet').textContent = fmtMoney(tot.net);
  $('#tileNet').style.color = tot.net < 0 ? 'var(--critical)' : 'var(--success-text)';
  $('#tileNetSub').textContent = tot.income > 0
    ? Math.round((tot.net / tot.income) * 100) + '% of income'
    : '—';

  const daysElapsed = Math.max(1, Math.round(progress * daysInMonth(ym)));
  $('#tilePace').textContent = fmtMoney(tot.expense / daysElapsed);
  $('#tilePaceSub').textContent = 'per day so far';

  // alerts
  const alerts = buildAlerts(ym);
  $('#alertsList').innerHTML = alerts.map(function (a) {
    return '<div class="alert ' + a.kind + '"><span class="a-icon">' + (STATUS_ICON[a.kind] || STATUS_ICON.info) +
           '</span><div class="a-body">' + a.html + '</div></div>';
  }).join('');

  // recent
  const recent = txForMonth(ym).slice(0, 6);
  $('#recentList').innerHTML = recent.length
    ? recent.map(txRowHtml).join('')
    : '<div class="empty"><span class="e-emoji">🧾</span>Nothing logged for ' + escapeHtml(monthLabel(ym, { month: 'long' })) + ' yet.<br>Tap the + button to add something.</div>';
}

function txRowHtml(t) {
  const c = catById(t.categoryId);
  const isIncome = t.type === 'income';
  const title = t.desc && t.desc.trim() ? t.desc : c.name;
  return '<button class="tx" data-tx="' + escapeHtml(t.id) + '">' +
    '<span class="tx-ico">' + escapeHtml(c.emoji || '📦') + '</span>' +
    '<span class="tx-mid">' +
      '<span class="tx-title">' + escapeHtml(title) + '</span>' +
      '<span class="tx-meta">' + escapeHtml(c.name) + ' · ' + escapeHtml(relDayLabel(t.date)) +
        (t.recurringId ? ' · <span class="tx-recur">auto</span>' : '') +
      '</span>' +
    '</span>' +
    '<span class="tx-amt' + (isIncome ? ' income' : '') + '">' +
      (isIncome ? '+' : '−') + fmtMoney(Number(t.amount) || 0) +
    '</span>' +
  '</button>';
}

function renderBudgets() {
  const ym = state.viewMonth;
  const cats = categoryTotals(ym);
  const ids = state.categories
    .filter(function (c) { return c.id !== 'income'; })
    .map(function (c) { return c.id; });

  const rows = ids.map(function (id) {
    const limit = Number(state.budgets[id]) || 0;
    const spent = cats[id] || 0;
    return { id: id, limit: limit, spent: spent, st: budgetStatus(spent, limit) };
  }).filter(function (r) { return r.limit > 0 || r.spent > 0; })
    .sort(function (a, b) {
      if (b.st.pct !== a.st.pct) return b.st.pct - a.st.pct;
      return b.spent - a.spent;
    });

  if (!rows.length) {
    $('#budgetList').innerHTML = '<div class="empty"><span class="e-emoji">🎯</span>No limits set yet.<br>Tap Edit to add a monthly cap per category.</div>';
    return;
  }

  const labels = { good: 'On track', warning: 'Watch', serious: 'Close', critical: 'Over', none: 'No limit' };

  $('#budgetList').innerHTML = rows.map(function (r) {
    const c = catById(r.id);
    const pctW = r.limit > 0 ? Math.min(1, r.st.pct) * 100 : 0;
    const chip = r.st.key === 'none'
      ? ''
      : '<span class="status-chip ' + r.st.key + '">' + STATUS_ICON[r.st.key] + labels[r.st.key] + '</span>';
    return '<div class="budget-row">' +
      '<div class="b-top">' +
        '<span class="b-name"><span class="cat-emoji">' + escapeHtml(c.emoji) + '</span>' +
          '<span class="n-text">' + escapeHtml(c.name) + '</span></span>' +
        '<span class="b-amt">' + fmtMoney(r.spent) + (r.limit > 0 ? ' / ' + fmtMoney(r.limit) : '') + '</span>' +
      '</div>' +
      '<div class="bar-track"><div class="bar-fill ' + (r.st.key === 'none' ? '' : r.st.key) + '" style="width:' + pctW + '%"></div></div>' +
      '<div class="b-foot">' +
        '<span class="f-left">' + chip +
          '<span>' + (r.limit > 0 ? Math.round(r.st.pct * 100) + '% used' : 'No limit set') + '</span></span>' +
        '<span>' + (r.limit > 0 ? (r.limit - r.spent >= 0 ? fmtMoney(r.limit - r.spent) + ' left' : fmtMoney(r.spent - r.limit) + ' over') : '') + '</span>' +
      '</div>' +
    '</div>';
  }).join('');

  // status chip icons need sizing
  $$('#budgetList .status-chip svg').forEach(function (s) {
    s.setAttribute('width', '11'); s.setAttribute('height', '11');
  });
}

function renderGoals() {
  if (!state.goals.length) {
    $('#goalsList').innerHTML = '<div class="empty"><span class="e-emoji">🏝️</span>No savings goals yet.<br>Tap Add goal to create one.</div>';
    return;
  }
  const sorted = state.goals.slice().sort(function (a, b) {
    return (b.saved / b.target) - (a.saved / a.target);
  });
  $('#goalsList').innerHTML = sorted.map(function (g) {
    const target = Number(g.target) || 0;
    const saved = Number(g.saved) || 0;
    const pct = target > 0 ? Math.min(1, saved / target) : 0;
    const done = target > 0 && saved >= target;
    let foot = '';
    if (done) {
      foot = '<span class="status-chip good">' + STATUS_ICON.good + 'Reached</span>';
    } else if (g.targetDate) {
      const months = monthsUntil(g.targetDate);
      foot = months > 0
        ? '<span>' + fmtMoney((target - saved) / months) + '/mo to hit ' + escapeHtml(fmtGoalDate(g.targetDate)) + '</span>'
        : '<span>Target date passed</span>';
    } else {
      foot = '<span>' + fmtMoney(target - saved) + ' to go</span>';
    }
    return '<div class="goal" data-goal="' + escapeHtml(g.id) + '">' +
      '<div class="g-top"><span class="g-name">' + escapeHtml(g.name || 'Goal') + '</span>' +
      '<span class="g-amt">' + fmtMoney(saved) + ' / ' + fmtMoney(target) + '</span></div>' +
      '<div class="bar-track"><div class="bar-fill' + (done ? ' good' : '') + '" style="width:' + (pct * 100) + '%"></div></div>' +
      '<div class="g-foot">' + foot + '<span>' + Math.round(pct * 100) + '%</span></div>' +
    '</div>';
  }).join('');
  $$('#goalsList .status-chip svg').forEach(function (s) {
    s.setAttribute('width', '11'); s.setAttribute('height', '11');
  });
}

function monthsUntil(iso) {
  const parts = String(iso).split('-').map(Number);
  const target = new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1);
  const now = new Date();
  return Math.max(0, Math.round((target - now) / (1000 * 60 * 60 * 24 * 30.44)));
}
function fmtGoalDate(iso) {
  const parts = String(iso).split('-').map(Number);
  return new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1)
    .toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function renderHistory() {
  const q = ($('#histSearch').value || '').toLowerCase().trim();
  const fcat = $('#histCat').value;
  const ftype = $('#histType').value;

  // populate the category filter once per render (cheap, keeps it in sync)
  const sel = $('#histCat');
  const current = sel.value;
  sel.innerHTML = '<option value="">All categories</option>' + state.categories.map(function (c) {
    return '<option value="' + escapeHtml(c.id) + '">' + escapeHtml(c.emoji + ' ' + c.name) + '</option>';
  }).join('');
  sel.value = current;

  const list = state.transactions.filter(function (t) {
    if (fcat && t.categoryId !== fcat) return false;
    if (ftype && t.type !== ftype) return false;
    if (q) {
      const hay = ((t.desc || '') + ' ' + catById(t.categoryId).name).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  }).slice(0, 300);

  if (!list.length) {
    $('#historyList').innerHTML = '<div class="empty"><span class="e-emoji">🔍</span>Nothing matches those filters.</div>';
    return;
  }

  // group by day
  let html = '';
  let lastDay = null;
  list.forEach(function (t) {
    if (t.date !== lastDay) {
      lastDay = t.date;
      const dayTotal = list.filter(function (x) { return x.date === t.date && x.type !== 'income'; })
        .reduce(function (s, x) { return s + (Number(x.amount) || 0); }, 0);
      html += '<div class="tx-day-label">' + escapeHtml(relDayLabel(t.date)) +
              (dayTotal > 0 ? ' · <span class="day-sum">' + fmtMoney(dayTotal) + '</span>' : '') + '</div>';
    }
    html += txRowHtml(t);
  });
  $('#historyList').innerHTML = html;
}

/* ------------------------------- charts -------------------------------- */
/* Two forms, both magnitude jobs:
   - trend: grouped bars, 2 series (expense / income) -> legend + table view
   - category: ranked horizontal bars, ONE series -> single hue, no legend
     (colour never encodes rank)                                            */

function renderTrends() {
  renderTrendChart();
  renderCategoryChart();
  const ins = buildInsights(state.viewMonth);
  $('#insightsList').innerHTML = ins.map(function (a) {
    return '<div class="alert ' + a.kind + '"><span class="a-icon">' + (STATUS_ICON[a.kind] || STATUS_ICON.info) +
           '</span><div class="a-body">' + a.html + '</div></div>';
  }).join('');
}

function lastMonths(ym, n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(shiftYM(ym, -i));
  return out;
}

function niceCeil(v) {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag;
}

function renderTrendChart() {
  const months = lastMonths(state.viewMonth, 6);
  const data = months.map(function (m) {
    const t = monthTotals(m);
    return { ym: m, expense: t.expense, income: t.income };
  });

  const W = 340, H = 170;
  const padL = 40, padR = 8, padT = 12, padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const maxV = Math.max(1, Math.max.apply(null, data.map(function (d) { return Math.max(d.expense, d.income); })));
  const top = niceCeil(maxV);

  const groupW = plotW / months.length;
  const gap = 2;                        // 2px surface gap between adjacent bars
  const barW = Math.max(6, (groupW - 14 - gap) / 2);

  const y = function (v) { return padT + plotH - (v / top) * plotH; };

  let svg = '';

  // gridlines + y labels (recessive)
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = (top / ticks) * i;
    const yy = y(v);
    svg += '<line class="grid-line" x1="' + padL + '" y1="' + yy + '" x2="' + (W - padR) + '" y2="' + yy + '"/>';
    svg += '<text class="axis-label" x="' + (padL - 6) + '" y="' + (yy + 3) + '" text-anchor="end">' +
           escapeHtml(v === 0 ? '0' : fmtCompact(v)) + '</text>';
  }

  // bars
  data.forEach(function (d, i) {
    const gx = padL + i * groupW + 7;
    const eH = Math.max(d.expense > 0 ? 2 : 0, plotH - (y(d.expense) - padT));
    const iH = Math.max(d.income > 0 ? 2 : 0, plotH - (y(d.income) - padT));

    if (eH > 0) {
      svg += '<rect class="hit" data-i="' + i + '" x="' + gx + '" y="' + (padT + plotH - eH) + '" width="' + barW +
             '" height="' + eH + '" rx="4" fill="var(--series-1)"/>';
    }
    if (iH > 0) {
      svg += '<rect class="hit" data-i="' + i + '" x="' + (gx + barW + gap) + '" y="' + (padT + plotH - iH) + '" width="' + barW +
             '" height="' + iH + '" rx="4" fill="var(--series-2)"/>';
    }
    // x label
    svg += '<text class="axis-label" x="' + (gx + barW + gap / 2) + '" y="' + (H - padB + 15) +
           '" text-anchor="middle">' + escapeHtml(shortMonthLabel(d.ym)) + '</text>';

    // invisible full-height hit area for hover
    svg += '<rect class="hit-zone" data-i="' + i + '" x="' + (padL + i * groupW) + '" y="' + padT +
           '" width="' + groupW + '" height="' + plotH + '" fill="transparent" style="cursor:pointer"/>';
  });

  // baseline
  svg += '<line class="base-line" x1="' + padL + '" y1="' + (padT + plotH) + '" x2="' + (W - padR) + '" y2="' + (padT + plotH) + '"/>';

  const el = $('#trendChart');
  el.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  el.innerHTML = svg;

  $('#trendLegend').innerHTML =
    '<span class="legend-item"><span class="dot expense"></span>Spent</span>' +
    '<span class="legend-item"><span class="dot income"></span>Income</span>';

  // hover tooltip
  const tip = $('#trendTip');
  const wrap = $('#trendChartWrap');
  $$('.hit-zone', el).forEach(function (zone) {
    function showTip(ev) {
      const i = parseInt(zone.getAttribute('data-i'), 10);
      const d = data[i];
      tip.innerHTML = '<div class="tip-title">' + escapeHtml(monthLabel(d.ym, { month: 'long', year: 'numeric' })) + '</div>' +
        '<div class="tip-row"><span class="dot expense"></span>Spent ' + fmtMoney(d.expense) + '</div>' +
        '<div class="tip-row"><span class="dot income"></span>Income ' + fmtMoney(d.income) + '</div>';
      const rect = wrap.getBoundingClientRect();
      const pt = ev.touches ? ev.touches[0] : ev;
      tip.style.left = (pt.clientX - rect.left) + 'px';
      tip.style.top = (pt.clientY - rect.top) + 'px';
      tip.classList.add('show');
    }
    zone.addEventListener('mouseenter', showTip);
    zone.addEventListener('mousemove', showTip);
    zone.addEventListener('touchstart', showTip, { passive: true });
    zone.addEventListener('mouseleave', function () { tip.classList.remove('show'); });
    zone.addEventListener('touchend', function () { setTimeout(function () { tip.classList.remove('show'); }, 1400); });
  });

  // table view
  $('#trendTable').innerHTML = '<table class="data-table"><thead><tr><th>Month</th>' +
    '<th class="num">Spent</th><th class="num">Income</th><th class="num">Net</th></tr></thead><tbody>' +
    data.map(function (d) {
      return '<tr><td>' + escapeHtml(monthLabel(d.ym, { month: 'short', year: 'numeric' })) + '</td>' +
        '<td class="num">' + fmtMoney(d.expense) + '</td>' +
        '<td class="num">' + fmtMoney(d.income) + '</td>' +
        '<td class="num">' + fmtMoney(d.income - d.expense) + '</td></tr>';
    }).join('') + '</tbody></table>';
}

function renderCategoryChart() {
  const cats = categoryTotals(state.viewMonth);
  let rows = Object.keys(cats).map(function (id) { return { id: id, v: cats[id] }; })
    .filter(function (r) { return r.v > 0; })
    .sort(function (a, b) { return b.v - a.v; });

  const el = $('#catChart');
  if (!rows.length) {
    el.setAttribute('viewBox', '0 0 340 60');
    el.innerHTML = '<text class="axis-label" x="170" y="34" text-anchor="middle">No spending recorded this month</text>';
    $('#catTable').innerHTML = '';
    return;
  }

  // Long tails fold into one rolled-up row rather than growing the chart.
  // Named "+N more" so it never reads as the user's own "Other" category.
  if (rows.length > 8) {
    const tail = rows.slice(7);
    const rest = tail.reduce(function (s, r) { return s + r.v; }, 0);
    rows = rows.slice(0, 7).concat([{ id: '__rollup', v: rest, label: '+' + tail.length + ' more', emoji: '⋯' }]);
  }

  const W = 340;
  const rowH = 30;
  const padL = 104, padR = 54, padT = 6;
  const H = padT + rows.length * rowH + 6;
  const plotW = W - padL - padR;
  const max = rows[0].v;

  let svg = '';
  rows.forEach(function (r, i) {
    const yTop = padT + i * rowH;
    const barH = 15;
    const w = Math.max(2, (r.v / max) * plotW);
    const c = r.id === '__rollup' ? { emoji: r.emoji, name: r.label } : catById(r.id);
    const name = c.name.length > 13 ? c.name.slice(0, 12) + '…' : c.name;

    svg += '<text class="axis-label" x="' + (padL - 8) + '" y="' + (yTop + barH / 2 + 4) +
           '" text-anchor="end" style="font-size:11px;fill:var(--text-secondary)">' +
           escapeHtml(c.emoji + ' ' + name) + '</text>';
    svg += '<rect class="hit-zone" data-i="' + i + '" x="' + padL + '" y="' + yTop + '" width="' + plotW +
           '" height="' + barH + '" fill="transparent" style="cursor:pointer"/>';
    svg += '<rect x="' + padL + '" y="' + yTop + '" width="' + w + '" height="' + barH +
           '" rx="4" fill="var(--series-1)" pointer-events="none"/>';
    svg += '<text class="value-label" x="' + (padL + w + 7) + '" y="' + (yTop + barH / 2 + 4) +
           '" pointer-events="none">' + escapeHtml(fmtCompact(r.v)) + '</text>';
  });
  svg += '<line class="base-line" x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' + (padT + rows.length * rowH - rowH + 15) + '"/>';

  el.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  el.innerHTML = svg;

  const total = rows.reduce(function (s, r) { return s + r.v; }, 0);
  const tip = $('#catTip');
  const wrap = $('#catChartWrap');
  $$('.hit-zone', el).forEach(function (zone) {
    function showTip(ev) {
      const i = parseInt(zone.getAttribute('data-i'), 10);
      const r = rows[i];
      const c = r.id === '__rollup' ? { name: r.label } : catById(r.id);
      tip.innerHTML = '<div class="tip-title">' + escapeHtml(c.name) + '</div>' +
        '<div class="tip-row">' + fmtMoney(r.v) + ' · ' + Math.round((r.v / total) * 100) + '% of spending</div>';
      const rect = wrap.getBoundingClientRect();
      const pt = ev.touches ? ev.touches[0] : ev;
      tip.style.left = (pt.clientX - rect.left) + 'px';
      tip.style.top = (pt.clientY - rect.top) + 'px';
      tip.classList.add('show');
    }
    zone.addEventListener('mouseenter', showTip);
    zone.addEventListener('mousemove', showTip);
    zone.addEventListener('touchstart', showTip, { passive: true });
    zone.addEventListener('mouseleave', function () { tip.classList.remove('show'); });
    zone.addEventListener('touchend', function () { setTimeout(function () { tip.classList.remove('show'); }, 1400); });
  });

  $('#catTable').innerHTML = '<table class="data-table"><thead><tr><th>Category</th>' +
    '<th class="num">Spent</th><th class="num">Share</th></tr></thead><tbody>' +
    rows.map(function (r) {
      const c = r.id === '__rollup' ? { name: r.label } : catById(r.id);
      return '<tr><td>' + escapeHtml(c.name) + '</td><td class="num">' + fmtMoney(r.v) +
        '</td><td class="num">' + Math.round((r.v / total) * 100) + '%</td></tr>';
    }).join('') + '</tbody></table>';
}

/* ------------------------------- sheets -------------------------------- */

function openSheet(id) {
  $('#sheetBackdrop').classList.add('open');
  document.getElementById(id).classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeSheets() {
  $('#sheetBackdrop').classList.remove('open');
  $$('.sheet').forEach(function (s) { s.classList.remove('open'); });
  document.body.style.overflow = '';
}

/* ---- transaction sheet ---- */

function openTxSheet(txId) {
  state.editingTxId = txId || null;
  const existing = txId ? state.transactions.find(function (t) { return t.id === txId; }) : null;

  if (existing) {
    state.draft = {
      type: existing.type || 'expense',
      amount: String(Math.round(Number(existing.amount) || 0)),
      categoryId: existing.categoryId || null,
      desc: existing.desc || '',
      date: existing.date || todayISO()
    };
    $('#txSheetTitle').textContent = 'Edit transaction';
    $('#txDelete').classList.remove('hidden');
    $('#txHeadSpacer').classList.add('hidden');
  } else {
    state.draft = { type: 'expense', amount: '', categoryId: null, desc: '', date: todayISO() };
    $('#txSheetTitle').textContent = 'New expense';
    $('#txDelete').classList.add('hidden');
    $('#txHeadSpacer').classList.remove('hidden');
  }

  syncTxSheet();
  openSheet('txSheet');
}

function syncTxSheet() {
  const d = state.draft;

  $$('#txTypeSeg button').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-type') === d.type);
  });
  if (!state.editingTxId) {
    $('#txSheetTitle').textContent = d.type === 'income' ? 'New income' : 'New expense';
  }

  const disp = $('#amountDisplay');
  $('#amountText').textContent = d.amount ? Number(d.amount).toLocaleString(CFG.locale) : '0';
  disp.classList.toggle('empty-amt', !d.amount);

  const pool = state.categories.filter(function (c) {
    return d.type === 'income' ? true : c.id !== 'income';
  });
  $('#txCategoryChips').innerHTML = pool.map(function (c) {
    return '<button class="chip' + (c.id === d.categoryId ? ' active' : '') + '" data-cat="' + escapeHtml(c.id) + '">' +
      '<span>' + escapeHtml(c.emoji) + '</span>' + escapeHtml(c.name) + '</button>';
  }).join('');

  $('#txDesc').value = d.desc || '';
  $('#txDate').value = d.date || todayISO();

  const valid = Number(d.amount) > 0 && !!d.categoryId;
  $('#txSave').disabled = !valid;
  $('#txSave').textContent = state.editingTxId ? 'Save changes' : 'Add ' + (d.type === 'income' ? 'income' : 'expense');
}

function saveTx() {
  const d = state.draft;
  const amount = Number(d.amount) || 0;
  if (amount <= 0 || !d.categoryId) return;

  const payload = {
    date: d.date || todayISO(),
    categoryId: d.categoryId,
    type: d.type,
    amount: amount,
    desc: (d.desc || '').trim(),
    updatedAt: Date.now()
  };

  const col = userRef().collection('transactions');
  const op = state.editingTxId
    ? col.doc(state.editingTxId).set(payload, { merge: true })
    : col.add(Object.assign({ createdAt: Date.now() }, payload));

  // Firestore's offline cache resolves the write locally first, so the UI is
  // instant; the promise settles when the server confirms.
  op.catch(function (e) { console.error(e); toast('Could not save — try again.'); });

  toast(state.editingTxId ? 'Updated' : 'Added ' + fmtMoney(amount));
  closeSheets();
  state.editingTxId = null;
}

function deleteTx() {
  if (!state.editingTxId) return;
  const id = state.editingTxId;
  userRef().collection('transactions').doc(id).delete()
    .catch(function (e) { console.error(e); toast('Could not delete.'); });
  toast('Deleted');
  closeSheets();
  state.editingTxId = null;
}

/* ---- budget sheet ---- */

function openBudgetSheet() {
  const pool = state.categories.filter(function (c) { return c.id !== 'income'; });
  $('#budgetInputs').innerHTML = pool.map(function (c) {
    const v = Number(state.budgets[c.id]) || 0;
    return '<div class="field">' +
      '<label for="bud_' + escapeHtml(c.id) + '">' + escapeHtml(c.emoji + ' ' + c.name) + '</label>' +
      '<input type="number" inputmode="numeric" id="bud_' + escapeHtml(c.id) + '" data-cat="' + escapeHtml(c.id) +
      '" value="' + (v || '') + '" placeholder="0">' +
    '</div>';
  }).join('');
  openSheet('budgetSheet');
}

function saveBudgets() {
  const next = {};
  $$('#budgetInputs input').forEach(function (inp) {
    const v = Number(inp.value) || 0;
    if (v > 0) next[inp.getAttribute('data-cat')] = v;
  });
  state.budgets = next;
  userRef().collection('settings').doc('prefs').set({ budgets: next }, { merge: true })
    .catch(function (e) { console.error(e); toast('Could not save limits.'); });
  toast('Limits saved');
  closeSheets();
  renderAll();
}

/* ---- goal sheet ---- */

function openGoalSheet(goalId) {
  state.editingGoalId = goalId || null;
  const g = goalId ? state.goals.find(function (x) { return x.id === goalId; }) : null;
  $('#goalSheetTitle').textContent = g ? 'Edit goal' : 'New goal';
  $('#goalName').value = g ? (g.name || '') : '';
  $('#goalTarget').value = g ? (g.target || '') : '';
  $('#goalSaved').value = g ? (g.saved || 0) : '';
  $('#goalDate').value = g ? (g.targetDate || '') : '';
  $('#goalDelete').classList.toggle('hidden', !g);
  openSheet('goalSheet');
}

function saveGoal() {
  const name = $('#goalName').value.trim();
  const target = Number($('#goalTarget').value) || 0;
  const saved = Number($('#goalSaved').value) || 0;
  const targetDate = $('#goalDate').value || null;
  if (!name || target <= 0) { toast('Add a name and a target amount.'); return; }

  const payload = { name: name, target: target, saved: saved, targetDate: targetDate };
  const col = userRef().collection('goals');
  const op = state.editingGoalId ? col.doc(state.editingGoalId).set(payload, { merge: true }) : col.add(payload);
  op.catch(function (e) { console.error(e); toast('Could not save goal.'); });

  toast('Goal saved');
  closeSheets();
  state.editingGoalId = null;
}

function deleteGoal() {
  if (!state.editingGoalId) return;
  userRef().collection('goals').doc(state.editingGoalId).delete()
    .catch(function (e) { console.error(e); });
  toast('Goal deleted');
  closeSheets();
  state.editingGoalId = null;
}

/* ---- recurring sheets ---- */

function openRecurringSheet() {
  renderRecurringList();
  openSheet('recurringSheet');
}

function renderRecurringList() {
  if (!state.recurring.length) {
    $('#recurringList').innerHTML = '<div class="empty"><span class="e-emoji">🔁</span>No recurring entries yet.<br>Add rent, salary or a subscription.</div>';
    return;
  }
  $('#recurringList').innerHTML = state.recurring.slice().sort(function (a, b) {
    return (a.dayOfMonth || 1) - (b.dayOfMonth || 1);
  }).map(function (r) {
    const c = catById(r.categoryId);
    const isIncome = r.type === 'income';
    return '<button class="tx" data-recur="' + escapeHtml(r.id) + '">' +
      '<span class="tx-ico">' + escapeHtml(c.emoji) + '</span>' +
      '<span class="tx-mid">' +
        '<span class="tx-title">' + escapeHtml(r.name || c.name) + '</span>' +
        '<span class="tx-meta">Day ' + escapeHtml(String(r.dayOfMonth || 1)) + ' each month · ' + escapeHtml(c.name) + '</span>' +
      '</span>' +
      '<span class="tx-amt' + (isIncome ? ' income' : '') + '">' + (isIncome ? '+' : '−') + fmtMoney(Number(r.amount) || 0) + '</span>' +
    '</button>';
  }).join('');
}

function openRecurEdit(id) {
  state.editingRecurId = id || null;
  const r = id ? state.recurring.find(function (x) { return x.id === id; }) : null;
  state.recurDraft = { type: r ? (r.type || 'expense') : 'expense' };

  $('#recurEditTitle').textContent = r ? 'Edit recurring' : 'New recurring';
  $('#recurName').value = r ? (r.name || '') : '';
  $('#recurAmount').value = r ? (r.amount || '') : '';
  $('#recurDay').value = r ? (r.dayOfMonth || 1) : 1;
  $('#recurStart').value = r ? (r.startMonth || ymOf(new Date())) : ymOf(new Date());
  $('#recurEditDelete').classList.toggle('hidden', !r);

  $('#recurCategory').innerHTML = state.categories.map(function (c) {
    return '<option value="' + escapeHtml(c.id) + '">' + escapeHtml(c.emoji + ' ' + c.name) + '</option>';
  }).join('');
  $('#recurCategory').value = r ? (r.categoryId || 'other') : 'other';

  syncRecurSeg();
  openSheet('recurEditSheet');
}

function syncRecurSeg() {
  $$('#recurTypeSeg button').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-type') === state.recurDraft.type);
  });
}

function saveRecur() {
  const name = $('#recurName').value.trim();
  const amount = Number($('#recurAmount').value) || 0;
  const day = Math.min(31, Math.max(1, parseInt($('#recurDay').value, 10) || 1));
  const startMonth = $('#recurStart').value || ymOf(new Date());
  const categoryId = $('#recurCategory').value;

  if (!name || amount <= 0) { toast('Add a name and an amount.'); return; }

  const payload = {
    name: name, amount: amount, dayOfMonth: day, startMonth: startMonth,
    categoryId: categoryId, type: state.recurDraft.type, active: true
  };

  const col = userRef().collection('recurring');
  if (state.editingRecurId) {
    col.doc(state.editingRecurId).set(payload, { merge: true })
      .catch(function (e) { console.error(e); toast('Could not save.'); });
  } else {
    col.add(payload).catch(function (e) { console.error(e); toast('Could not save.'); });
  }

  state.recurringRunFor = null;    // let the materialiser re-evaluate
  toast('Recurring saved');
  closeSheets();
  state.editingRecurId = null;
  setTimeout(function () { openRecurringSheet(); }, 240);
}

function deleteRecur() {
  if (!state.editingRecurId) return;
  userRef().collection('recurring').doc(state.editingRecurId).delete()
    .catch(function (e) { console.error(e); });
  toast('Recurring rule deleted (past entries kept)');
  closeSheets();
  state.editingRecurId = null;
}

/* ---- categories sheet ---- */

function openCategorySheet() {
  renderCategoryList();
  openSheet('categorySheet');
}

function renderCategoryList() {
  $('#categoryList').innerHTML = state.categories.map(function (c) {
    const used = state.transactions.some(function (t) { return t.categoryId === c.id; });
    return '<div class="row-btn" style="cursor:default">' +
      '<span style="font-size:1.2rem">' + escapeHtml(c.emoji) + '</span>' +
      '<span class="r-label">' + escapeHtml(c.name) + '</span>' +
      (used ? '<span class="r-value">in use</span>' :
        '<button class="link-btn btn-danger" data-delcat="' + escapeHtml(c.id) + '">Remove</button>') +
    '</div>';
  }).join('');
}

function saveCategories() {
  return userRef().collection('settings').doc('prefs')
    .set({ categories: state.categories }, { merge: true })
    .catch(function (e) { console.error(e); toast('Could not save categories.'); });
}

/* ------------------------------ CSV I/O -------------------------------- */

function exportCsv() {
  const rows = [['Date', 'Type', 'Category', 'Description', 'Amount']];
  state.transactions.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; })
    .forEach(function (t) {
      rows.push([t.date, t.type, catById(t.categoryId).name, t.desc || '', Math.round(Number(t.amount) || 0)]);
    });
  const csv = rows.map(function (r) {
    return r.map(function (cell) {
      const s = String(cell == null ? '' : cell);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',');
  }).join('\n');

  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'coinpath-' + todayISO() + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  toast('Exported ' + (rows.length - 1) + ' transactions');
}

function parseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQ = false; }
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function importCsv(file) {
  const reader = new FileReader();
  reader.onload = function () {
    const text = String(reader.result || '').replace(/^﻿/, '');
    const lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (lines.length < 2) { toast('That file has no rows.'); return; }

    const header = parseCsvLine(lines[0]).map(function (h) { return h.trim().toLowerCase(); });
    const idx = {
      date: header.indexOf('date'),
      type: header.indexOf('type'),
      category: header.indexOf('category'),
      desc: header.indexOf('description'),
      amount: header.indexOf('amount')
    };
    if (idx.date === -1 || idx.amount === -1) {
      toast('CSV needs at least Date and Amount columns.');
      return;
    }

    const nameToId = {};
    state.categories.forEach(function (c) { nameToId[c.name.toLowerCase()] = c.id; });

    const batch = db.batch();
    let n = 0;
    for (let i = 1; i < lines.length && n < 450; i++) {
      const cells = parseCsvLine(lines[i]);
      const date = (cells[idx.date] || '').trim();
      const amount = Number(String(cells[idx.amount] || '').replace(/[^\d.-]/g, ''));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !amount) continue;

      const catName = idx.category > -1 ? (cells[idx.category] || '').trim().toLowerCase() : '';
      const typeRaw = idx.type > -1 ? (cells[idx.type] || '').trim().toLowerCase() : 'expense';

      batch.set(userRef().collection('transactions').doc(), {
        date: date,
        type: typeRaw.indexOf('income') > -1 ? 'income' : 'expense',
        categoryId: nameToId[catName] || 'other',
        desc: idx.desc > -1 ? (cells[idx.desc] || '').trim() : '',
        amount: Math.abs(amount),
        createdAt: Date.now()
      });
      n++;
    }
    if (!n) { toast('No valid rows found (dates must be YYYY-MM-DD).'); return; }
    batch.commit()
      .then(function () { toast('Imported ' + n + ' transactions'); })
      .catch(function (e) { console.error(e); toast('Import failed.'); });
  };
  reader.readAsText(file);
}

/* ----------------------------- navigation ------------------------------ */

function goScreen(name) {
  state.screen = name;
  $$('.screen').forEach(function (s) {
    s.classList.toggle('active', s.id === 'screen-' + name);
  });
  $$('.tabbar button[data-screen]').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-screen') === name);
  });
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

/* -------------------------------- theme -------------------------------- */

function applyTheme(mode) {
  if (mode === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
  try { localStorage.setItem('coinpath-theme', mode); } catch (e) {}
}
function currentTheme() {
  try { return localStorage.getItem('coinpath-theme') || 'system'; } catch (e) { return 'system'; }
}

/* ------------------------------- events -------------------------------- */

function wireApp() {
  // month navigation
  $('#prevMonth').addEventListener('click', function () {
    state.viewMonth = shiftYM(state.viewMonth, -1);
    renderAll();
  });
  $('#nextMonth').addEventListener('click', function () {
    state.viewMonth = shiftYM(state.viewMonth, 1);
    renderAll();
  });

  // tabs
  $$('.tabbar button[data-screen]').forEach(function (b) {
    b.addEventListener('click', function () { goScreen(b.getAttribute('data-screen')); });
  });
  $('#fabAdd').addEventListener('click', function () { openTxSheet(null); });
  document.addEventListener('click', function (ev) {
    const goto = ev.target.closest && ev.target.closest('[data-goto]');
    if (goto) goScreen(goto.getAttribute('data-goto'));
  });

  // theme cycle: system -> light -> dark
  $('#themeBtn').addEventListener('click', function () {
    const order = ['system', 'light', 'dark'];
    const next = order[(order.indexOf(currentTheme()) + 1) % order.length];
    applyTheme(next);
    toast('Theme: ' + next);
  });

  // sheets: backdrop + cancel buttons
  $('#sheetBackdrop').addEventListener('click', closeSheets);
  $$('[data-close-sheet]').forEach(function (b) {
    b.addEventListener('click', closeSheets);
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') closeSheets();
  });

  /* --- transaction sheet --- */
  $('#txCancel').addEventListener('click', closeSheets);
  $('#txSave').addEventListener('click', saveTx);
  $('#txDelete').addEventListener('click', function () {
    if (confirm('Delete this transaction?')) deleteTx();
  });

  $('#txTypeSeg').addEventListener('click', function (ev) {
    const b = ev.target.closest('button[data-type]');
    if (!b) return;
    state.draft.type = b.getAttribute('data-type');
    if (state.draft.type === 'income' && !state.draft.categoryId) state.draft.categoryId = 'income';
    syncTxSheet();
  });

  $('#txCategoryChips').addEventListener('click', function (ev) {
    const b = ev.target.closest('button[data-cat]');
    if (!b) return;
    state.draft.categoryId = b.getAttribute('data-cat');
    syncTxSheet();
  });

  $('#numpad').addEventListener('click', function (ev) {
    const b = ev.target.closest('button[data-key]');
    if (!b) return;
    const k = b.getAttribute('data-key');
    let a = state.draft.amount || '';
    if (k === 'del') a = a.slice(0, -1);
    else if (k === '000') { if (a && a !== '0') a += '000'; }
    else { if (a === '0') a = ''; a += k; }
    if (a.length > 12) a = a.slice(0, 12);
    state.draft.amount = a.replace(/^0+(?=\d)/, '');
    syncTxSheet();
  });

  $('#txDesc').addEventListener('input', function () { state.draft.desc = this.value; });
  $('#txDate').addEventListener('change', function () { state.draft.date = this.value; });

  // tapping a transaction row anywhere opens it for editing
  document.addEventListener('click', function (ev) {
    const row = ev.target.closest && ev.target.closest('[data-tx]');
    if (row) { openTxSheet(row.getAttribute('data-tx')); return; }
    const goal = ev.target.closest && ev.target.closest('[data-goal]');
    if (goal) { openGoalSheet(goal.getAttribute('data-goal')); return; }
    const rec = ev.target.closest && ev.target.closest('[data-recur]');
    if (rec) { openRecurEdit(rec.getAttribute('data-recur')); return; }
    const delcat = ev.target.closest && ev.target.closest('[data-delcat]');
    if (delcat) {
      const id = delcat.getAttribute('data-delcat');
      state.categories = state.categories.filter(function (c) { return c.id !== id; });
      saveCategories().then(renderCategoryList);
      return;
    }
  });

  /* --- budgets --- */
  $('#editBudgetsBtn').addEventListener('click', openBudgetSheet);
  $('#budgetSave').addEventListener('click', saveBudgets);

  /* --- goals --- */
  $('#addGoalBtn').addEventListener('click', function () { openGoalSheet(null); });
  $('#goalSave').addEventListener('click', saveGoal);
  $('#goalDelete').addEventListener('click', function () {
    if (confirm('Delete this goal?')) deleteGoal();
  });

  /* --- recurring --- */
  $('#openRecurring').addEventListener('click', openRecurringSheet);
  $('#recurringAdd').addEventListener('click', function () { openRecurEdit(null); });
  $('#recurEditSave').addEventListener('click', saveRecur);
  $('#recurEditDelete').addEventListener('click', function () {
    if (confirm('Delete this recurring rule? Entries it already posted stay put.')) deleteRecur();
  });
  $('#recurTypeSeg').addEventListener('click', function (ev) {
    const b = ev.target.closest('button[data-type]');
    if (!b) return;
    state.recurDraft.type = b.getAttribute('data-type');
    syncRecurSeg();
  });

  /* --- categories --- */
  $('#openCategories').addEventListener('click', openCategorySheet);
  $('#addCatBtn').addEventListener('click', function () {
    const name = $('#newCatName').value.trim();
    const emoji = $('#newCatEmoji').value.trim() || '📦';
    if (!name) { toast('Give the category a name.'); return; }
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || ('cat' + Date.now());
    if (state.categories.some(function (c) { return c.id === id; })) { toast('That category already exists.'); return; }
    state.categories = state.categories.concat([{ id: id, name: name, emoji: emoji }]);
    saveCategories().then(function () {
      $('#newCatName').value = '';
      $('#newCatEmoji').value = '';
      renderCategoryList();
      toast('Category added');
    });
  });

  /* --- history filters --- */
  ['#histSearch', '#histCat', '#histType'].forEach(function (sel) {
    $(sel).addEventListener('input', renderHistory);
    $(sel).addEventListener('change', renderHistory);
  });

  /* --- data --- */
  $('#exportCsv').addEventListener('click', exportCsv);
  $('#importCsvBtn').addEventListener('click', function () { $('#importCsvInput').click(); });
  $('#importCsvInput').addEventListener('change', function () {
    if (this.files && this.files[0]) importCsv(this.files[0]);
    this.value = '';
  });

  /* --- table toggles --- */
  $$('[data-table]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const t = document.getElementById(btn.getAttribute('data-table'));
      const nowHidden = t.classList.toggle('hidden');
      btn.textContent = nowHidden ? 'Show as table' : 'Hide table';
    });
  });

  /* --- account --- */
  $('#signOutBtn').addEventListener('click', function () {
    if (confirm('Sign out of Coinpath?')) { stopSync(); auth.signOut(); }
  });

  /* --- install prompt --- */
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    state.deferredInstall = e;
    $('#installBtn').style.display = '';
  });
  $('#installBtn').addEventListener('click', function () {
    if (!state.deferredInstall) return;
    state.deferredInstall.prompt();
    state.deferredInstall.userChoice.finally(function () {
      state.deferredInstall = null;
      $('#installBtn').style.display = 'none';
    });
  });

  /* --- connectivity --- */
  window.addEventListener('online', function () { setSync('', 'Synced'); });
  window.addEventListener('offline', function () { setSync('offline', 'Offline'); });

  // deep link ?screen=add from the manifest shortcut
  const params = new URLSearchParams(location.search);
  if (params.get('screen') === 'add') {
    setTimeout(function () { if (state.user) openTxSheet(null); }, 700);
  }
}

/* -------------------------------- boot --------------------------------- */

function boot() {
  applyTheme(currentTheme());
  wireAuth();
  wireApp();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(function (e) {
      console.warn('SW registration failed', e);
    });
  }

  initFirebase();
}

/* Test hook — only attached when a harness sets window.__COINPATH_TEST__
   before this script loads. Never active in the shipped app. */
if (window.__COINPATH_TEST__) {
  window.__coinpath = {
    state: state,
    runRecurring: runRecurring,
    isoOf: isoOf,
    shiftYM: shiftYM,
    daysInMonth: daysInMonth,
    fmtCompact: fmtCompact,
    fmtMoney: fmtMoney
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
