# Static demo build

A free, backend-less build of Kumbara for public sharing: fake data, fully clickable, no server.

## Build

```bash
cd app
VITE_DEMO=1 VITE_API_URL= npm run build   # -> dist/
```

`VITE_DEMO=1` is the only switch. It swaps the 14 Electric collections for in-memory ones seeded from
`src/lib/demo/demo-data.ts`, and routes the API helpers to `src/lib/demo/demo-api.ts` (baked budget,
no-op writes, an interactive inbox-triage shim). Without the flag the build is the normal app and all demo
code is tree-shaken out.

Preview locally with no backend running:

```bash
npx vite preview --port 4173     # open http://127.0.0.1:4173
```

## Deploy (all free)

`dist/` is plain static files. `public/_redirects` (`/* /index.html 200`) gives SPA-route fallback on
Cloudflare Pages and Netlify.

- **Cloudflare Pages** (recommended — free, private-repo OK, serves at root):
  ```bash
  npx wrangler pages deploy dist --project-name kumbara-demo   # one-time: wrangler login
  ```
- **Netlify**: `npx netlify deploy --prod --dir dist`
- **GitHub Pages** (needs Pro for a private repo, serves under `/<repo>/`):
  ```bash
  VITE_BASE=/<repo>/ VITE_DEMO=1 VITE_API_URL= npm run build
  ```
  then publish `dist/` and add a `404.html` copy of `index.html` for deep-link fallback.

## What works vs. what's faked

- **Real (client-side):** browsing transactions, accounts, investments, subscriptions, merchants; all
  filters, sheets, drawers, the month stepper; inbox triage (one-tap category chips resolve a cohort;
  Transfer/Refund confirm resolves the pair); the Budget → Paychecks drawer (a seeded income source with
  401k/medical/HSA deductions — add/edit/delete rules); adding a synthetic leg to a transaction group —
  edits persist in-session and reset on reload.
- **Baked:** the Budget page + Insights charts (`src/lib/demo/budget-fixture.ts`) — a hardcoded summary,
  so the numbers don't react to edits. `grossIncome` equals net (no generated paycheck deduction legs).
- **No-op / empty:** sync, subscription detection, paycheck generation, push. `paycheck_period` and
  `synthetic_leg` seed empty, so there is no pre-seeded diverged-paycheck inbox anomaly.

Regenerating the flag: everything lives under `src/lib/demo/`. To change the fake dataset edit
`demo-data.ts`; to change the budget numbers edit `budget-fixture.ts`.
