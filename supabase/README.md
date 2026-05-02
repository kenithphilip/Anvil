# Supabase

Apply migrations in order. The files are idempotent so re-running them is safe.

```sh
# With Supabase CLI:
supabase db push --include-all

# Or paste each file into the SQL editor under
# https://supabase.com/dashboard/project/<id>/sql
```

| File | What it adds |
| --- | --- |
| 001_init.sql | Tenants, members, customers, profiles, orders, source POs, evidence, validation, aliases, masters, vouchers, audit |
| 002_eval_and_email.sql | Eval suites, runs, case results, email inbound table |
| 003_studio_ocr_fx_inventory_lead.sql | Studio versions, FX rates, lead times, holiday calendar, tally inventory, BOM, OCR runs, ZIP scans |
| 004_seed_static_data.sql | 2026 holidays for IN/CN/JP/KR/US, default lead-time rows |
| 005_close_remaining_gaps.sql | Tally status, approval expiry, communications, scorecards, amendments, installed base, spare recommendations, model routing log, redaction rules, injection tests, eval cases, backups |
| 006_corpus_alignment.sql | Order modes (4 corpus modes + INTERNAL), customer locations (multi-GSTIN), item master, contracts (ARC/Blanket/AMC), leads, opportunities, internal SOs, equipment hierarchy, shipments, projects, service visits, CAR reports, schedule lines, approval thresholds, lost-reason taxonomy |
| 007_seed_real_corpus_data.sql | Round 1 corpus seeds: MG Motor + Halol/Haryana locations, SRTX, Tata Motors Pune, ABC Motors, 35 item-master rows |
| 008_einvoice_forecast_amc.sql | GSTN e-Invoice rows, forecast snapshots, AMC schedule + cron support |
| 009_corpus_round2_schema.sql | Round 2 schema: engineering specs (SRTX EG SHEET style), payment milestones (multi-tranche), expense rate cards, incoterms taxonomy, blanket release drawdown ledger, logistics ports + carriers, item_master technical_specs/critical/stock, customer_locations tax_treatment, RLS for all of the above. Seeds global incoterms + ports + carriers. |
| 010_seed_corpus_round2_data.sql | Round 2 corpus seeds: JBM Plant 1 customer + 15 equipment rows + 50 items + auto-linked installed parts, RNAIPL customer, MG master quote + 11 release POs (5100002515 - 5100002595) + 50/50 payment milestones, ABC FOR/HSS payment milestone templates, 6 customer-format fingerprints (MG, SRTX, ABC x4 mode variants), SRTX engineering BOM payload, 11 expense rate cards, 4 approval thresholds (Sales Manager / Finance / Director / margin gate), 25 MG sample items + 11 HSN-expansion items, 3 real shipments with HX vessels |

After applying, seed at least one tenant row in `tenants` and one
`tenant_members` row mapping a real `auth.users.id` to that tenant with role
`admin`.

## Standalone seed file

`supabase/seed.sql` consolidates 007 + 010 into a single file you can paste
directly into the Supabase SQL Editor. Run it after migrations 001-009 are
applied. It is idempotent: re-running on an already-seeded project is a
no-op. After it runs it prints a one-row-per-relation count summary so you
can confirm what landed.
