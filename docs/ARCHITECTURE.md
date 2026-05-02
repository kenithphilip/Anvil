# Architecture

## Overview

Anvil is a thin Vercel + Supabase app. There is no Next.js, no separate frontend
framework, no build pipeline beyond a single-file string composer. The unified
HTML app loads in a browser, calls Vercel serverless functions, and the
functions read and write Supabase Postgres with RLS.

```
                    +----------------------+
   browser ───────► | public/index.html    |
                    | + bridge client      |
                    +----------+-----------+
                               |  fetch(/api/*)
                               v
                    +----------------------+
                    | Vercel functions     |
                    | api/<group>/<route>  |
                    +----------+-----------+
                               |  service-role client
                               v
                    +----------------------+
                    | Supabase Postgres    |
                    | RLS + Auth + Storage |
                    +----------------------+
```

## Data flow: order intake

1. User uploads PO + quote (+ optional price comp) in the SO Agent tab.
2. Bridge client posts files to `/api/documents/upload`, gets signed URLs.
3. Optional: `/api/documents/scan` runs deterministic ZIP guards plus ClamAV
   if `CLAMAV_URL` is configured.
4. Optional: `/api/documents/ocr` runs Mistral OCR and writes evidence rows
   with bboxes.
5. Frontend assembles a Claude prompt and calls `/api/claude/messages`. The
   proxy redacts known PII patterns, applies a system firewall, picks a model
   tier (Haiku for preflight, Sonnet for generation, Opus for reasoning), and
   logs to `model_routing_log`. If the response confidence is below the
   threshold, it auto-falls back to the next tier.
6. Result is persisted via `/api/orders` POST. Approval-bound payload hash is
   computed by `stableStringify(payload)` + SHA-256 and stored on the order.
7. Approval flips status. Tally push at `/api/tally/push` re-checks the
   payload hash, writes a voucher record, posts to the local Tally HTTP
   bridge if `TALLY_BRIDGE_URL` is set.

## Multi-tenant safety

Every table has `tenant_id` as the first non-id column and an RLS policy of:

```sql
create policy <table>_select on <table>
  for select using (tenant_id is null or tenant_id in (select current_tenant_ids()));
create policy <table>_write on <table>
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));
```

`current_tenant_ids()` reads from `tenant_members` keyed by `auth.uid()`.
Service-role queries from the API layer bypass RLS but always include
`.eq("tenant_id", ctx.tenantId)` from `_lib/auth.resolveContext`.

## Order modes (corpus-derived)

The corpus revealed four real sales modes plus an internal-only mode:

- `SPARES`: OIQTLC prefix, INR, road logistics, 30 percent margin.
- `SPARES_ASSEMBLY`: OIQTLC prefix, gun modification spares.
- `PROJECT_FOR`: Free On Rail, INR, freight inclusive.
- `PROJECT_HSS`: OIQTHS prefix, USD with explicit forward FX, CIF Nhava
  Sheva, 10 percent margin.
- `INTERNAL`: FOC supply, warranty replacement, product trial, expected PO,
  internal transfer.

The mode picker lives in the SO Agent intake. It drives quote prefix logic,
source PO numbering (OJ for Japan, OK for Korea, OC for China, OI for India),
and currency.

## Bridge client

`src/client/obara-client.js` is a single global `window.ObaraBackend` namespace.
It is inlined into `public/index.html` at build time and exposes:

- Core: `claudeCall`, `documents`, `orders`, `customers`, `aliases`, `audit`,
  `events`, `findings`, `duplicates`, `anomaly`, `eval`, `email`, `auth`, `ocr`,
  `scan`, `fx`, `delivery`, `inventory`, `masterData`, `bom`, `profileVersions`.
- Tally: `tally.push`, `tally.amend`, `tally.reconcile`, `tally.validate`,
  `tally.listMasters`, `tally.syncMasters`.
- Source POs: `sourcePos.list/get/update/ack/scorecard`.
- Communications: `communications.draft/send/missingDoc`.
- Cost: `cost.breakdown/simulator/marginHistory`.
- Sales: `sales.listLeads/createLead/updateLead/...`, opportunities,
  internal SOs, shipments, projects.
- Service: `service.listVisits/createVisit/...`, CAR reports.
- Admin: `admin.listHolidays/upsertHoliday/...`, lead times, members,
  inventory, FX rates, contracts, item master, customer locations, equipment,
  lost reasons, approval thresholds.

The hybrid storage shim falls back to localStorage when the backend is
unreachable, so the app remains usable offline for read paths.

## Cron

`vercel.json` registers `/api/fx/cron` daily at 04:00 UTC. The handler
iterates all tenants, fetches USD/INR/CNY/JPY/KRW/EUR rates from Frankfurter
for the prior business day, and writes one row per pair per tenant.

## Migrations

`supabase/migrations/` contains six ordered migrations. Each is idempotent
where possible (`create table if not exists`, `drop policy if exists`).
Apply with `supabase db push` or paste into the SQL editor.

| File | Purpose |
| --- | --- |
| 001_init.sql | Tenants, members, customers, profiles, orders, source POs, evidence, validation findings, aliases, masters, vouchers, UOM aliases, audit, processing events |
| 002_eval_and_email.sql | Eval suites, eval runs, eval case results, email inbound |
| 003_studio_ocr_fx_inventory_lead.sql | Studio versions, FX rates, lead times, holiday calendar, tally inventory, BOM, OCR runs, ZIP scans |
| 004_seed_static_data.sql | 2026 holidays for IN/CN/JP/KR/US, default lead times |
| 005_close_remaining_gaps.sql | Tally status, approval expiry, comms, scorecards, amendments, installed base, spare recommendations, model routing log, redaction rules, injection tests, eval cases, backups |
| 006_corpus_alignment.sql | Order modes, customer types, multi-GSTIN locations, item master, contracts, leads, opportunities, internal SOs, equipment hierarchy, shipments, projects, service visits, CAR reports, schedule lines, approval thresholds, lost reasons |
