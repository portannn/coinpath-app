/* In-memory stand-in for the Firebase compat SDK, used only to exercise the
   real app.js in a headless browser. Never shipped. */
(function () {
  'use strict';

  const store = {};                 // path -> { id, data }
  const listeners = [];             // { path, kind, cb }
  let uidCounter = 0;

  function nextId() { return 'id' + (++uidCounter) + '_' + Math.floor(Math.random() * 1e6); }

  function notify() {
    listeners.forEach(function (l) {
      try { l.emit(); } catch (e) { console.error('listener error', e); }
    });
  }

  function docsUnder(colPath) {
    return Object.keys(store)
      .filter(function (p) {
        if (p.indexOf(colPath + '/') !== 0) return false;
        const rest = p.slice(colPath.length + 1);
        return rest.indexOf('/') === -1;
      })
      .map(function (p) { return { path: p, id: p.split('/').pop(), data: store[p] }; });
  }

  function makeSnapshotDocs(list) {
    return list.map(function (d) {
      return { id: d.id, data: function () { return JSON.parse(JSON.stringify(d.data)); } };
    });
  }

  function DocRef(path) {
    this.path = path;
    this.id = path.split('/').pop();
  }
  DocRef.prototype.collection = function (name) { return new ColRef(this.path + '/' + name); };
  DocRef.prototype.set = function (data, opts) {
    if (opts && opts.merge && store[this.path]) {
      store[this.path] = Object.assign({}, store[this.path], data);
    } else {
      store[this.path] = JSON.parse(JSON.stringify(data));
    }
    notify();
    return Promise.resolve();
  };
  DocRef.prototype.update = function (data) {
    store[this.path] = Object.assign({}, store[this.path] || {}, data);
    notify();
    return Promise.resolve();
  };
  DocRef.prototype.delete = function () {
    delete store[this.path];
    notify();
    return Promise.resolve();
  };
  DocRef.prototype.onSnapshot = function (cb, errCb) {
    const self = this;
    const l = {
      emit: function () {
        const d = store[self.path];
        cb({
          exists: !!d,
          id: self.id,
          data: function () { return d ? JSON.parse(JSON.stringify(d)) : undefined; },
          metadata: { fromCache: false }
        });
      }
    };
    listeners.push(l);
    setTimeout(l.emit, 0);
    return function () {
      const i = listeners.indexOf(l);
      if (i > -1) listeners.splice(i, 1);
    };
  };

  function ColRef(path, opts) {
    this.path = path;
    this.opts = opts || {};
  }
  ColRef.prototype.doc = function (id) { return new DocRef(this.path + '/' + (id || nextId())); };
  ColRef.prototype.add = function (data) {
    const ref = this.doc(nextId());
    return ref.set(data).then(function () { return ref; });
  };
  ColRef.prototype.orderBy = function (field, dir) {
    return new ColRef(this.path, Object.assign({}, this.opts, { orderBy: field, dir: dir || 'asc' }));
  };
  ColRef.prototype.limit = function (n) {
    return new ColRef(this.path, Object.assign({}, this.opts, { limit: n }));
  };
  ColRef.prototype.onSnapshot = function (cb, errCb) {
    const self = this;
    const l = {
      emit: function () {
        let list = docsUnder(self.path);
        if (self.opts.orderBy) {
          const f = self.opts.orderBy;
          const dir = self.opts.dir === 'desc' ? -1 : 1;
          list.sort(function (a, b) {
            const av = a.data[f], bv = b.data[f];
            if (av === bv) return 0;
            return (av < bv ? -1 : 1) * dir;
          });
        }
        if (self.opts.limit) list = list.slice(0, self.opts.limit);
        cb({ docs: makeSnapshotDocs(list), empty: list.length === 0, metadata: { fromCache: false } });
      }
    };
    listeners.push(l);
    setTimeout(l.emit, 0);
    return function () {
      const i = listeners.indexOf(l);
      if (i > -1) listeners.splice(i, 1);
    };
  };

  function Firestore() {}
  Firestore.prototype.collection = function (name) { return new ColRef(name); };
  Firestore.prototype.enablePersistence = function () { return Promise.resolve(); };
  Firestore.prototype.settings = function () { /* transport settings no-op */ };
  Firestore.prototype.batch = function () {
    const ops = [];
    return {
      set: function (ref, data, opts) { ops.push(function () { return ref.set(data, opts); }); },
      update: function (ref, data) { ops.push(function () { return ref.update(data); }); },
      delete: function (ref) { ops.push(function () { return ref.delete(); }); },
      commit: function () { return Promise.all(ops.map(function (f) { return f(); })); }
    };
  };

  const authState = { user: null, cbs: [] };
  function Auth() {}
  Auth.prototype.onAuthStateChanged = function (cb) {
    authState.cbs.push(cb);
    setTimeout(function () { cb(authState.user); }, 0);
    return function () {};
  };
  Auth.prototype.signInWithEmailAndPassword = function (email) {
    authState.user = { uid: 'testuser', email: email };
    this.currentUser = authState.user;
    authState.cbs.forEach(function (cb) { cb(authState.user); });
    return Promise.resolve({ user: authState.user });
  };
  Auth.prototype.createUserWithEmailAndPassword = Auth.prototype.signInWithEmailAndPassword;
  Auth.prototype.sendPasswordResetEmail = function () { return Promise.resolve(); };
  Auth.prototype.signOut = function () {
    authState.user = null;
    this.currentUser = null;
    authState.cbs.forEach(function (cb) { cb(null); });
    return Promise.resolve();
  };

  const _auth = new Auth();
  const _db = new Firestore();

  window.firebase = {
    apps: [],
    initializeApp: function (cfg) { window.firebase.apps.push({ options: cfg }); return {}; },
    auth: function () { return _auth; },
    firestore: function () { return _db; }
  };

  /* ---------------- seed data ---------------- */
  window.__seed = function (opts) {
    opts = opts || {};
    const uid = 'testuser';
    const base = 'users/' + uid;

    function ym(delta) {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() + delta);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    }
    function dayIn(ymStr, day) { return ymStr + '-' + String(day).padStart(2, '0'); }

    if (opts.empty) {
      authState.user = { uid: uid, email: 'titan@example.com' };
      _auth.currentUser = authState.user;
      return;
    }

    const cats = ['groceries', 'dining', 'transport', 'housing', 'utilities', 'entertain', 'shopping', 'health', 'other'];
    const descs = {
      groceries: ['Supermarket run', 'Fresh market', 'Pasar mingguan'],
      dining: ['Lunch at warung', 'Coffee', 'Dinner out', 'Bakso'],
      transport: ['Gojek ride', 'Petrol', 'Grab to office'],
      housing: ['Rent'],
      utilities: ['Electricity', 'Internet', 'Water'],
      entertain: ['Cinema', 'Spotify'],
      shopping: ['T-shirt', 'Headphones'],
      health: ['Pharmacy', 'Clinic visit'],
      other: ['Gift', 'Misc']
    };

    // deterministic pseudo-random so screenshots are stable
    let seed = 42;
    function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }

    let n = 0;
    for (let mi = -5; mi <= 0; mi++) {
      const M = ym(mi);
      // salary
      store[base + '/transactions/' + nextId()] = {
        date: dayIn(M, 1), type: 'income', categoryId: 'income',
        amount: 9500000, desc: 'Salary', createdAt: Date.now() - n
      };
      // rent (recurring-looking)
      store[base + '/transactions/' + nextId()] = {
        date: dayIn(M, 2), type: 'expense', categoryId: 'housing',
        amount: 3000000, desc: 'Rent', recurringId: 'rent1', createdAt: Date.now() - n
      };
      const count = 16 + Math.floor(rnd() * 8);
      for (let i = 0; i < count; i++) {
        const cat = cats[Math.floor(rnd() * cats.length)];
        if (cat === 'housing') continue;
        const dmax = (mi === 0) ? Math.max(1, new Date().getDate()) : 28;
        const day = 1 + Math.floor(rnd() * dmax);
        const scale = cat === 'utilities' ? 400000 : cat === 'shopping' ? 600000 : 180000;
        const amt = Math.round((30000 + rnd() * scale) / 1000) * 1000;
        const dl = descs[cat];
        store[base + '/transactions/' + nextId()] = {
          date: dayIn(M, day), type: 'expense', categoryId: cat,
          amount: amt, desc: dl[Math.floor(rnd() * dl.length)], createdAt: Date.now() - (n++)
        };
      }
    }

    store[base + '/settings/prefs'] = {
      budgets: {
        groceries: 1500000, dining: 1000000, transport: 600000, housing: 3000000,
        utilities: 700000, entertain: 400000, shopping: 500000, health: 400000,
        education: 300000, savings: 1000000, other: 300000
      },
      categories: null
    };
    delete store[base + '/settings/prefs'].categories;

    store[base + '/goals/g1'] = { name: 'Emergency Fund', target: 15000000, saved: 4200000, targetDate: '2027-06-01' };
    store[base + '/goals/g2'] = { name: 'New Laptop', target: 12000000, saved: 9600000, targetDate: '2026-12-01' };
    store[base + '/goals/g3'] = { name: 'Vacation', target: 8000000, saved: 8000000, targetDate: null };

    store[base + '/recurring/rent1'] = {
      name: 'Rent', amount: 3000000, dayOfMonth: 2, startMonth: ym(-5),
      categoryId: 'housing', type: 'expense', active: true, lastPosted: ym(0)
    };
    store[base + '/recurring/sal1'] = {
      name: 'Salary', amount: 9500000, dayOfMonth: 1, startMonth: ym(-5),
      categoryId: 'income', type: 'income', active: true, lastPosted: ym(0)
    };
    store[base + '/recurring/spot1'] = {
      name: 'Spotify', amount: 54000, dayOfMonth: 15, startMonth: ym(-5),
      categoryId: 'entertain', type: 'expense', active: true, lastPosted: ym(0)
    };

    authState.user = { uid: uid, email: 'titan@example.com' };
    _auth.currentUser = authState.user;
  };
})();
