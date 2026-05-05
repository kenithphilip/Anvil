# Anvil

Multi-tenant industrial sales-ops platform: customer PO intake,
quote-and-pricecompo reconciliation, source PO procurement against
Korea / Japan / China / India suppliers, ERP export with idempotency
(NetSuite, SAP, Dynamics 365, Acumatica, Prophet 21, Eclipse,
Infor SX.e, Tally, Sage X3), AMC service scheduling, GSTN e-Invoice,
multi-channel intake (email + WhatsApp + Slack + Teams + voice via
Vapi/Retell), PLM mirror (PTC Windchill, Arena), in-network
back-to-back sourcing, and a Vite + React + TypeScript browser app.

Stack: Vercel serverless functions (Node 20), Supabase Postgres
with RLS + Auth, Vite + React + TypeScript v3 app at
`src/v3-app/`, design-system primitives shared across 46 screens.

## Sign-in surface (Phase 5)

- Approval-gated signup. New users land in `tenant_members.status='pending'`
  and an admin reviews the request from the in-portal Access Requests tab
  before sign-in is unlocked. The first user on a fresh tenant is auto-
  promoted to admin so the loop can ever start.
- Four sign-in paths converging on the same approval gate:
  password (with optional TOTP MFA), magic link, passkey (WebAuthn,
  TouchID / FaceID / Windows Hello / hardware keys), password reset
  via single-use rate-limited recovery link emailed by SendGrid.
- Self-hosted RFC 6238 TOTP, no third-party MFA provider.
- Passkeys via `@simplewebauthn/server@^11`, lazy-imported on the
  client.
- Per-event security audit log at `user_security_audit`.

See `docs/SECURITY.md` for the full picture.

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
14. **[docs/V3_ROUTE_CONTRACT.md](docs/V3_ROUTE_CONTRACT.md)**: v3 nav id
    to backing table + endpoint + client method, with confirmed gaps.
15. **[docs/RBAC.md](docs/RBAC.md)**: 7 roles, 30 routes, action-level
    matrix, server + client enforcement.
16. **[docs/V3_WIRING_PATTERN.md](docs/V3_WIRING_PATTERN.md)**: how to
    convert a static design-system screen into a wired screen.
17. **[docs/V3_VERIFICATION.md](docs/V3_VERIFICATION.md)**: Phase 5
    smoke + WCAG + spill checklist.
18. **[docs/ROADMAP.md](docs/ROADMAP.md)**: living list of what is next
    (mobile shell, i18n, real-time, push notifications).

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
  index.html               Built legacy app (~979KB)
  v3.html                  Built v3 operator console (~777KB)
  auth/callback.html       Supabase magic-link landing

src/
  client/obara-client.js   Bridge client used by both shells
  scripts/build-unified-app.mjs  Composes index.html from legacy + client
  scripts/build-v3.mjs     Composes v3.html from src/v3/* + client
  scripts/verify-html.mjs  Parses every script block in the built HTMLs
  legacy/                  obara-ops-v11.1.html, so-agent-pocv4.jsx (legacy build inputs)
  v3/                      v3 design system + 35 wired screens
    styles.css             tokens (light + dark, IBM Plex)
    primitives.jsx         Btn, Chip, Card, KPI, etc. (47 icons)
    shell.jsx              Shell + CmdK + ThreadDrawer
    rbac.js                client-side gating (7 roles, 30 routes)
    preferences.js         theme + density + rail (persisted)
    app.jsx                router with hash-based deep-linking
    screens/               14 static design templates
    screens-wired/         35 wired screens (live ObaraBackend data)
    index.html.tpl         build template

supabase/
  migrations/              10 SQL files (001 init through 010 corpus round-2 seeds)
  seed.sql                 Standalone consolidated 007+010 for SQL editor
  README.md                Migration overview

docs/                      All documentation listed above
.github/workflows/ci.yml   CI: check + build + verify on PRs
```

## One-click deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fkenithphilip%2FAnvil&env=SUPABASE_URL,SUPABASE_ANON_KEY,SUPABASE_SERVICE_ROLE_KEY,ANTHROPIC_API_KEY,MAGIC_LINK_REDIRECT_URL,DEFAULT_TENANT_ID,ALLOW_ANONYMOUS_TENANT,ALLOWED_ORIGINS&envDescription=Anvil+needs+Supabase+%2B+Anthropic+credentials.+See+the+linked+docs+for+each+variable.&envLink=https%3A%2F%2Fgithub.com%2Fkenithphilip%2FAnvil%2Fblob%2Fmain%2Fdocs%2FENV_VARS.md&project-name=anvil&repository-name=anvil)

The button lands you on Vercel's import page with the required env vars
pre-filled. After deploy:

1. Run `supabase/setup.sh` against your Supabase project (see
   [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md)).
2. Add `https://YOUR-DEPLOY.vercel.app/auth/callback.html` to your
   Supabase Auth redirect allowlist.
3. Sign in via magic link. Add yourself to `tenant_members` with role
   admin (one SQL statement).

Optional integrations (Mistral OCR, ClamAV, Tally bridge, GSTN e-Invoice,
inbound email, comms provider) are documented in
[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md). Add their env vars to your
Vercel project later. The app degrades gracefully without them.

## Quick start (local)

```sh
nvm use
npm install
cp .env.example .env.local && edit .env.local
npm run check                   # syntax-check every api file + bridge client
npm run build                   # writes public/index.html and public/v3.html
npm run verify                  # parses every script block + runs v3 contract test
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
- Two shells: legacy 35-modal app from `src/legacy/`, and v3 operator
  console (30 routes, RBAC-gated, dark by default, Cmd+K palette,
  thread drawer) from `src/v3/` reached via `/?v3=1`. v3 has 35 wired
  screens fetching live data via `ObaraBackend.*`. Both run against the
  same backend.
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
