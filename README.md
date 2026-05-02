# Anvil

Sales-ops execution system for Obara India: customer PO intake,
quote-and-pricecompo reconciliation, source PO procurement against
Korea/Japan/China/India suppliers, Tally export with idempotency, AMC
service scheduling, GSTN e-Invoice, and a unified single-page browser
app.

Stack: Vercel serverless functions (Node 20), Supabase Postgres with RLS,
single-page HTML app built from a legacy Obara Ops shell plus a React SO
Agent component plus a unified bridge client.

## Documentation

Read in this order:

1. **[docs/SETUP.md](docs/SETUP.md)**: zero-to-deployed walkthrough. Fork
   the repo, set up Supabase, deploy to Vercel, sign in. About 30-45
   minutes the first time.
2. **[docs/ENV_VARS.md](docs/ENV_VARS.md)**: every environment variable,
   what it does, where to set it, how to generate it.
3. **[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)**: external services
   (Anthropic, Mistral, ClamAV, Tally bridge, GSTN, email providers) with
   per-service setup runbooks.
4. **[docs/USER_GUIDE.md](docs/USER_GUIDE.md)**: every modal, every tab,
   every button explained.
5. **[docs/DEPLOY.md](docs/DEPLOY.md)**: deployment lifecycle, migrations,
   rollbacks, multi-tenant onboarding.
6. **[docs/RUNBOOK.md](docs/RUNBOOK.md)**: daily, weekly, monthly ops.
   Incident response. Capacity planning.
7. **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)**: common issues
   and fixes, sorted by likelihood.
8. **[docs/API_REFERENCE.md](docs/API_REFERENCE.md)**: every Vercel
   endpoint with method, body, response, side effects.
9. **[docs/SCHEMA_REFERENCE.md](docs/SCHEMA_REFERENCE.md)**: every table,
   column, enum, RLS policy across the 10 migrations.
10. **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**: high-level system
    design and request flow.
11. **[docs/CORPUS_MAPPING.md](docs/CORPUS_MAPPING.md)**: how the data
    model maps back to the original Obara document corpus.
12. **[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)**: branching, commits,
    code style.
13. **[docs/SECURITY.md](docs/SECURITY.md)**: threat model and incident
    reporting.

## Layout

```
api/                       80 Vercel serverless functions across 31 resource groups
  _lib/                    Shared helpers (auth, cors, audit, supabase, mistral, datemath)
  admin/                   Holidays, lead times, members, FX, inventory, contracts, items, equipment, locations, lost reasons, approvals
  sales/                   Leads, opportunities, internal SOs, projects, shipments
  service/                 Visits, CAR reports, closure reports, AMC + AMC cron
  tally/                   Push, amend, reconcile, masters, validate
  source_pos/              List, get/patch, ack, scorecard
  cost/                    Breakdown, simulator, margin history
  spare_matrix/            Recommend, kit, opportunities, obsolete
  documents/               Upload, OCR, scan, get/delete
  einvoice/                GSTN IRN/QR lifecycle
  forecast/                Pipeline rollup by territory/type/mode
  orders/                  CRUD plus schedule_lines
  ...                      customers, aliases, anomaly, audit, auth, bom, claude, communications, delivery, duplicates, email, eval, events, findings, fx, inventory, master_data, sales_history, security

public/                    Static site root
  index.html               Built unified app (~975KB)
  auth/callback.html       Supabase magic-link landing

src/
  client/obara-client.js   Bridge client used by the unified app
  scripts/build-unified-app.mjs  Composes index.html from legacy + client
  scripts/verify-html.mjs  Parses every script block in the built HTML
  legacy/                  obara-ops-v11.1.html, so-agent-pocv4.jsx (build inputs)

supabase/
  migrations/              10 SQL files (001 init through 010 corpus round-2 seeds)
  seed.sql                 Standalone consolidated 007+010 for SQL editor
  README.md                Migration overview

docs/                      All documentation listed above
.github/workflows/ci.yml   CI: check + build + verify on PRs
```

## Quick start (local)

```sh
nvm use
npm install
cp .env.example .env.local && edit .env.local
npm run check                   # syntax-check every api file + bridge client
npm run build                   # writes public/index.html
npm run verify                  # parses every script block
```

Open `public/index.html` directly, or:

```sh
npx serve public -l 3000
```

For end-to-end with serverless functions running locally:

```sh
npm install -g vercel
vercel dev
```

## Status

- 80 api files, all syntax-clean.
- 10 migrations: 72 tables, 13 enums, 177 indexes, RLS on every business
  table.
- 35-modal unified app built from `src/legacy/` plus `src/client/`.
- 71-item feature audit passes 71 of 71 (50 trust + 12 corpus + 9 closing).
- Two daily crons: FX rates (04:00 UTC) and AMC visit auto-generation
  (05:00 UTC).
- Real customer master seeded for 6 customers: MG Motor (Halol + Haryana
  GSTINs), SRTX, Tata Motors, ABC Motors, JBM Auto Plant 1, Renault Nissan
  India. 131 sample item master rows. MG master quote OIQTLC-240123 with all
  11 release POs (5100002515 to 5100002595). 6 customer-format fingerprints
  including 4 ABC mode variants (SPARES, MODIFICATION, FOR, HSS). 11 expense
  rate cards. 4 approval thresholds. 15 JBM Plant-1 equipment rows + 54
  auto-linked installed parts. SRTX engineering BOM with FANUC motor model.
