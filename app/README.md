# Coinpath — a real budget app

An installable app for tracking spending, staying under budget, and reaching savings goals. Works on your phone, tablet, and computer, with everything synced through your own private Firebase project.

It is a **PWA** (Progressive Web App): it installs to your home screen with its own icon, opens fullscreen with no browser bar, and keeps working when you have no signal — anything you enter offline syncs as soon as you're back online.

---

## What's in the box

| Screen | What it does |
|---|---|
| **Home** | How much you have left to spend, spending pace, and warnings before you blow a budget |
| **Budgets** | A monthly limit per category with colour-coded progress, plus your savings goals |
| **Trends** | Six-month spending chart, a ranked breakdown of where the money went, and written insights |
| **History** | Every transaction, searchable and filterable, grouped by day |
| **More** | Recurring transactions, custom categories, CSV import/export, account |

Other things it does:

- **Two-tap expense entry** — big numpad with a `000` key for rupiah, category chips, done.
- **Recurring transactions** — rent, salary, subscriptions post themselves each month. Back-fills months you missed, clamps "day 31" to short months, and never double-posts.
- **Budget alerts** — flags categories over or near their limit and projects where you'll land at your current pace.
- **Insights** — like-for-like month comparisons (a half-finished month is compared against the same half of last month, not the whole thing).
- **Light and dark themes**, following your system setting or forced with the toggle in the top bar.
- **CSV export and import** so your data is never trapped.

---

## How the pieces fit

Two services, doing different jobs:

- **Vercel** hosts the files — it's what gives you the URL you open.
- **Firebase** is the backend — it stores your transactions and handles your login. There is no Firebase *hosting* here; you only use its database and sign-in.

You need both. Both are free at this scale.

---

## Setup — about 10 minutes, once

### 1. Create a Firebase project

1. Go to **console.firebase.google.com** and sign in with any Google account.
2. **Add project** → name it (e.g. `coinpath`) → you can skip Google Analytics.

### 2. Register a web app

1. On the project home page, click the **`</>`** (Web) icon.
2. Nickname it, click **Register app**.
3. Firebase shows a `firebaseConfig` object. Keep this tab open.

### 3. Turn on Email/Password sign-in

**Build → Authentication → Get started → Sign-in method → Email/Password → Enable.**

### 4. Create the database and lock it down

1. **Build → Firestore Database → Create database.** Pick a region near you (`asia-southeast2` is Jakarta), start in **production mode**.
2. Open the **Rules** tab, replace everything with the contents of `firestore.rules` from this folder, and click **Publish**.

That rule is what makes your data private: only your signed-in account can read or write your own records.

### 5. Paste your keys

Open **`firebase-config.js`** and replace the placeholders with the values from step 2. That is the only file you need to edit.

```js
window.FIREBASE_CONFIG = {
  apiKey: "AIza…",
  authDomain: "coinpath-1234.firebaseapp.com",
  projectId: "coinpath-1234",
  storageBucket: "coinpath-1234.firebasestorage.app",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
};
```

These values are **not secrets** — they identify your project the way a URL does. Your data is protected by the rules in step 4 and your password, not by hiding them.

### 6. Deploy to Vercel

The app needs HTTPS to install as an app, which Vercel gives you automatically. `vercel.json` and `.vercelignore` are already set up — no build step, no framework, nothing to configure.

Pick either route.

**Option A — CLI (fastest):**

```bash
npm install -g vercel     # once
cd path/to/app            # this folder
vercel                    # preview deploy; answer the prompts
vercel --prod             # publish
```

At the prompts: link to your account, **Set up and deploy**, create a new project, accept the default project name, and when it asks about build settings say **no** to overriding them — this is a plain static site.

**Option B — GitHub (auto-deploys on every push):**

1. Push this folder to a GitHub repo.
2. At **vercel.com/new**, import that repo.
3. Framework Preset: **Other**. Leave Build Command and Output Directory empty.
4. **Deploy**.

Either way you end up with a URL like `https://coinpath.vercel.app`.

### 7. Authorise your Vercel domain in Firebase

**Don't skip this — sign-in will fail without it.** Firebase only accepts logins from domains you've approved.

In the Firebase console: **Authentication → Settings → Authorized domains → Add domain**, and add your Vercel hostname without the `https://`:

```
coinpath.vercel.app
```

If you later add a custom domain, add that too. (`localhost` is already on the list, which is why local testing works.)

The symptom when this is missed is a sign-in error mentioning `auth/unauthorized-domain`.

### 8. Install it on your devices

Open your URL, then **Sign up** once with an email and password. On every other device, open the same URL and **Sign in** with those same credentials.

To install it as an app:

- **Android / Chrome** — tap the ⋮ menu → *Install app* (or *Add to Home screen*).
- **iPhone / Safari** — tap the Share button → *Add to Home Screen*. (iOS only allows this from Safari.)
- **Desktop Chrome / Edge** — click the install icon in the address bar.

It then behaves like any other app: own icon, own window, no browser chrome.

---

## Updating the app later

**Before deploying any change to `app.js`, `styles.css`, or `index.html`, bump `CACHE_VERSION` in `sw.js`** (e.g. `coinpath-v1` → `coinpath-v2`). Installed copies cache the old files otherwise and you'll wonder why nothing changed.

Then:

```bash
vercel --prod
```

…or just `git push`, if you set it up through GitHub.

Changing the Firestore rules is separate — edit them in the Firebase console's **Rules** tab and hit Publish. Vercel doesn't touch them.

---

## Using it

**Adding a transaction** — tap the blue **+**. Type the amount on the numpad (`000` adds three zeros), tap a category, tap Add. Note and date are optional; the date defaults to today.

**Editing or deleting** — tap any transaction row.

**Budget limits** — Budgets tab → *Edit*. Blank or `0` means "no limit". Bars go green → amber → orange → red as you approach and pass a limit.

**Recurring** — More → *Recurring transactions* → *Add*. Set the amount, the day of the month, and which month it starts. It posts automatically from then on. Deleting a rule stops future posts but keeps the entries it already made.

**Months** — the arrows in the top bar move between months. Every screen follows the selected month.

**Backups** — More → *Export all transactions (CSV)*. The import expects a `Date,Type,Category,Description,Amount` header with dates as `YYYY-MM-DD`.

---

## Cost and privacy

Firebase's free **Spark** plan covers this comfortably — its free tier is 50,000 document reads and 20,000 writes per day, and a personal budget app uses a tiny fraction of that. No credit card required.

Your transactions live in **your** Firebase project, under your Google account. They do not pass through anyone else's servers.

---

## Files

| File | Purpose |
|---|---|
| `index.html` | App shell and markup |
| `app.js` | All application logic |
| `styles.css` | Styling and the light/dark theme |
| `firebase-config.js` | **The file you edit** — your project keys |
| `sw.js` | Service worker: offline support |
| `manifest.json` | Makes the app installable |
| `firestore.rules` | Database security rules — paste into the Firebase console |
| `vercel.json` | Hosting config: caching headers so updates actually ship |
| `.vercelignore` | Keeps dev files out of the deploy |
| `icons/` | App icons |
| `test/`, `harness.html`, `make_icons.py` | Development only — safe to delete; already excluded from deploys |

---

## If something goes wrong

**Sign-in fails with `auth/unauthorized-domain`** — step 7. Add your `.vercel.app` hostname to Firebase → Authentication → Settings → Authorized domains.

**Stuck on the setup screen** — `firebase-config.js` still has placeholder values, or the file failed to load. Check the browser console.

**"Email/password sign-in is not enabled"** — step 3 was skipped.

**Transactions won't load, or "Missing or insufficient permissions"** — the Firestore rules from step 4 weren't published.

**Deployed but the page is blank or 404s** — Vercel probably guessed a framework. In the project's Settings → General, set Framework Preset to **Other** and clear the Build Command and Output Directory, then redeploy.

**You deployed a change but the app looks the same** — you didn't bump `CACHE_VERSION` in `sw.js`. Bump it and redeploy; or, to verify immediately, open the site in a private window.

**Changes on one device don't show on another** — make sure both are signed in with the same email. The dot in the top bar shows *Synced* or *Offline*.

**The install option doesn't appear** — the app must be served over HTTPS (not opened as a local file), and on iPhone it must be Safari.
