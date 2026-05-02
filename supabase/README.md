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

After applying, seed at least one tenant row in `tenants` and one
`tenant_members` row mapping a real `auth.users.id` to that tenant with role
`admin`.
