# Anvil

Sales-ops execution system for Obara India: customer PO intake, quote-and-pricecompo
reconciliation, source PO procurement against Korea/Japan/China/India suppliers,
Tally export with idempotency, and a service module for visits, CAR reports, and
spare-matrix intelligence.

Stack: Vercel serverless functions (Node 20), Supabase Postgres with RLS, single-page
browser app built from the legacy Obara Ops HTML and the SO Agent React component
plus a unified bridge client.

## Layout

```
api/                       Vercel serverless functions, auto-routed by path
  _lib/                    Shared helpers (auth, cors, audit, supabase, mistral, datemath)
  admin/                   Holidays, lead times, members, FX, inventory, contracts, items, equipment
  sales/                   Leads, opportunities, internal SOs, projects, shipments
  service/                 Visits, CAR reports
  tally/                   Push, amend, reconcile, masters, validate
  source_pos/              List, get/patch, ack, scorecard
  cost/                    Breakdown, simulator, margin history
  spare_matrix/            Recommend, kit, opportunities, obsolete
  documents/               Upload, OCR, scan
  ...                      orders, customers, aliases, fx, delivery, master_data, eval, etc.

public/                    Static site root
  index.html               Built unified app
  auth/callback.html       Supabase magic-link landing

src/
  client/obara-client.js   Bridge client used by the unified app at runtime
  scripts/build-unified-app.mjs  Composes index.html from legacy + client
  legacy/                  Source inputs the build script reads (kept versioned)

supabase/
  migrations/              006 SQL migrations, applied in order

docs/                      Architecture, deploy, development, corpus mapping
.github/workflows/         CI: syntax check, build, plain-script verify
```

## Local dev

```sh
nvm use
npm install
cp .env.example .env.local && edit .env.local
npm run build
npm run check
```

`npm run build` writes `public/index.html`. Open it directly or serve `public/`
with any static server.

## Deploy

See [docs/DEPLOY.md](docs/DEPLOY.md). Short version:

1. Apply Supabase migrations in `supabase/migrations/` in order.
2. Configure env vars in Vercel from `.env.example`.
3. `vercel --prod` or push to `main` if Vercel is wired to the repo.

## Status

62-item feature audit passes (50 trust/execution items + 12 corpus-derived items
mapped from real Obara documents). All 74 api files compile clean. Build produces
a 934KB unified HTML.
