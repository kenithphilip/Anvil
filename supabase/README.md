# Supabase

10 migrations + a consolidated standalone seed file. Every file is fully
idempotent, so re-running any of them on an already-applied project is a
no-op. Verified by running each migration three times in a row against a
fresh Postgres 16 database with zero errors and no row-count drift.

## Apply order

Run files **in numeric order**. Migration N depends on schema from N-1.

### Option A: Supabase CLI (recommended for fresh projects)

```sh
# From repository root, with the Supabase project linked:
supabase db push --include-all
```

The CLI applies every file in `supabase/migrations/` in order.

### Option B: Supabase SQL Editor (paste-and-run)

1. Open `https://supabase.com/dashboard/project/<id>/sql`.
2. For each `supabase/migrations/00*.sql` file in numeric order, click
   **New query**, paste the entire file contents, and click **Run**.
3. After 010 finishes, paste `supabase/seed.sql` into a new query (it
   re-runs 007 + 010 inline) and run it. The bottom `select` prints a
   one-row-per-relation count summary so you can confirm what landed.

> **Important.** The SQL Editor is per-query, not transactional across
> queries. If a file fails partway, fix the cause and re-run the same file.
> The migrations are idempotent: re-running picks up where it left off.

### Option C: psql (CI / scripted)

```sh
for f in supabase/migrations/0*.sql; do
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$f" || exit 1
done
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/seed.sql
```

## Files

| File | What it adds |
| --- | --- |
| 001_init.sql | Tenants, members, customers, profiles, documents, orders, source POs, evidence, validation, aliases, masters, vouchers, audit, processing events, extraction cache, RLS macros, `set_updated_at` trigger function |
| 002_eval_and_email.sql | Eval suites, runs, case results, email intake rules |
| 003_studio_ocr_fx_inventory_lead.sql | Studio profile versions, FX rates, customer/supplier lead times, holiday calendar, tally inventory, BOM, OCR runs, ZIP scans, magic-link audit |
| 004_seed_static_data.sql | 2026 holidays for IN/CN/JP/KR/US, default lead-time rows |
| 005_close_remaining_gaps.sql | Tally status, approval expiry, communications, scorecards, amendments, installed base, spare recommendations, model routing log, redaction rules, injection tests, eval cases, backups |
| 006_corpus_alignment.sql | Order modes (SPARES, SPARES_ASSEMBLY, PROJECT_FOR, PROJECT_HSS, INTERNAL), customer locations (multi-GSTIN), item master, contracts (ARC/Blanket/AMC), leads, opportunities, internal SOs, equipment hierarchy, shipments, projects, service visits, CAR reports, schedule lines, approval thresholds, lost-reason taxonomy |
| 007_seed_real_corpus_data.sql | Round 1 corpus seeds: MG Motor + Halol/Haryana locations, SRTX, Tata Motors Pune, ABC Motors, 35 item-master rows |
| 008_einvoice_forecast_amc.sql | GSTN e-Invoice rows, forecast snapshots, AMC schedule + cron support, redaction-rules write-policy fix |
| 009_corpus_round2_schema.sql | Round 2 schema: engineering specs (SRTX EG SHEET style), payment milestones (multi-tranche, partial unique on contract+sequence and order+sequence), expense rate cards, incoterms taxonomy, blanket release drawdown ledger, logistics ports + carriers, partial unique index on shipments (tenant_id, shipment_number), item_master technical_specs/critical/stock, customer_locations tax_treatment, RLS for all of the above. Seeds global incoterms + ports + carriers. |
| 010_seed_corpus_round2_data.sql | Round 2 corpus seeds: JBM Plant 1 customer + 15 equipment rows + 50 items + auto-linked installed parts, RNAIPL customer, MG master quote + 11 release POs (5100002515 to 5100002595) + 50/50 payment milestones, ABC FOR/HSS payment milestone templates, 6 customer-format fingerprints (MG, SRTX, ABC x4 mode variants), SRTX engineering BOM payload, 11 expense rate cards, 4 approval thresholds (Sales Manager / Finance / Director / margin gate), 25 MG sample items + 11 HSN-expansion items, 3 real shipments with HX vessels |

## Standalone seed file

`supabase/seed.sql` is the inlined concatenation of 007 + 010. Use it when
the SQL Editor is your only access path and you want a single paste to land
all corpus seeds. Run it **after** migrations 001 - 010 have already been
applied (it does not redefine schema, just inserts data). Re-running is a
no-op and prints a row-count summary at the end.

## After-apply checklist

1. Confirm a default tenant exists in `tenants`. Migration 001 seeds one
   with id `00000000-0000-0000-0000-000000000001`.
2. Add at least one row to `tenant_members` mapping a real
   `auth.users.id` to that tenant with role `admin`. Without this, the user
   token client gets back zero rows on every RLS-scoped read.
3. Confirm Storage has the bucket the upload endpoints expect (default
   `obara-documents`). Create it under **Storage** in the dashboard if
   missing. The migrations don't seed buckets because Supabase manages them.
4. Run `supabase/seed.sql` if you want the corpus customers, items, and MG
   release POs visible immediately for QA. Skip this on a tenant with real
   customer data already present.

## Idempotence guarantees

The migrations are robust against the common Postgres re-apply traps:

- Every `create type ... as enum` is wrapped in `do $$ begin if not exists
  ... end $$;`.
- Every `alter table ... add constraint` is wrapped the same way against
  `pg_constraint`.
- Every `add column` uses `if not exists`.
- Every `create table` uses `if not exists`.
- Every `create index` uses `if not exists`.
- Every `insert ... values` either uses `on conflict (...) do nothing` with
  a real unique constraint as target, or wraps the row in
  `where not exists (select 1 ...)`.
- RLS macros only loop over tables that have a `tenant_id` column.

If you hit a non-idempotent error after a fresh pull, please file an issue
with the file name and the exact error.
