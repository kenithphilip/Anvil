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

## Approval-gated membership (Phase 5)

`tenant_members` carries a `status` column (added in migration 042)
that gates every authenticated request:

```
pending      ─┐
denied       ─┼── resolveContext throws 403 with code=MEMBERSHIP_<X>
deactivated  ─┘
approved     ─── resolveContext returns the user's role for the tenant
```

Sign-up creates a row with `status='pending'` (the first user on a
fresh tenant is auto-promoted to admin + approved so the
approval loop can ever start). The frontend's auth gate refuses
to mount the Shell until `isSessionValid()` AND the resolved
context returns 200; pending users land on the Landing page's
"Pending admin approval" panel instead.

Admins approve / deny / modify requests at **Admin Center →
Access requests**; the action propagates to the matching
`admin_notifications` row and `auth.users.user_metadata` (name,
email).

```
                 sign-up
                    │
                    ▼
         tenant_members row (status='pending')
                    │
                    ├──► admin_notifications fan-out
                    │       │
                    │       ▼
                    │   bell badge + Access Requests tab
                    │       │
                    │       ▼ admin clicks Approve
                    │
                    ▼
         status='approved' ──► next sign-in mints session
```

## Authentication surface (Phase 5)

Four sign-in paths converge on the same approval gate:

```
       password + TOTP        magic link        passkey
            │                     │                │
            ▼                     ▼                ▼
       /api/auth/password_login   verify           auth/finish
            │                     │                │
            └──────────► resolveContext approval gate ◄────────────┐
                                  │                                │
                                  ▼                                │
                             session cookie                        │
                                                                   │
       password reset (request_reset → email → complete_reset) ────┘
       (no session minted; user signs in again afterwards)
```

TOTP secrets, ERP credentials, voice / chat / PLM credentials live
under AES-256-GCM via `_lib/secrets.js` when `ANVIL_SECRETS_KEY` is
set; passkey public keys are not secret and are stored in plain
columns. Every security event lands in `user_security_audit`.

For deeper coverage see `docs/SECURITY.md`.

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

## DocAI extraction pipeline (L0 to L7)

The unified extraction pipeline (migrations 088-094, code in
`src/api/_lib/docai/`) replaces the legacy "send-the-file-to-Claude
and-hope" path. Every consumer (SO intake, inbound auto_ocr cron,
source PO ack, invoice match, e-Way bill) calls the shared
`runExtractionPipeline()` helper, which orchestrates this ladder:

```
Upload bytes
    |
    v
[L0 file gate]                            (existing: ClamAV scan, ZIP guard, mime detect)
    |
    v
[L1 deterministic text]                   text_layer.js + extraction_text_layer cache
    |  has_text or mixed -> hints.bodyText  (Phase A)
    |  image_only or extract_failed -> fall to L2
    v
[L2 OCR-augmented text]                   ocr_layer.js + extraction_ocr_layer cache
    |  ok / partial -> hints.bodyText      (Phase B; Mistral OCR)
    v
[L3 customer template]                    templates.js + customer_format_templates
    |  hits >= 1 -> fills hints.knownFields (Phase D; auto-built after 3+ ok runs)
    v
[L4 LLM dispatch]                         index.js dispatcher + adapters
    |  serial first-wins, OR vote=true -> all-in-parallel
    |  cost guard blocks paid adapters over their daily cap (Phase Cost-Opt)
    |  deterministic model selector picks Haiku/Sonnet/Flash/Pro per call
    v                                     (Phase Cost-Opt; model_selector.js)
[E customer field overrides]              overrides.js + customer_field_overrides
    |  applies before validators           (Phase E; promotes from corrections)
    v
[L5 validators]                           validators.js
    |  GSTIN, currency, state code, HSN/SAC, line math
    |  errors downgrade confidence to <0.7 (Phase A)
    v
[L6 cross-adapter voter]                  voter.js
    |  only when 2+ adapters ran           (Phase C)
    |  emits per-field provenance + per-line provenance
    v
[L7 operator review banner]               so-workspace.tsx Pipeline Diagnostics
    |  shows status_reason, validator issues, layer flags,
    |  voter provenance, selected model + selection reason
```

The dispatcher's default order is cost-optimised:

```
gemini -> docling -> marker -> unstructured -> azure_di -> reducto -> claude
```

Tenants override via `tenant_settings.docai_provider_order`.

Every run persists the full signal set on `extraction_runs`:
`status_reason`, `validator_issues`, `validator_summary`,
`text_layer_used`, `ocr_layer_used`, `template_used`,
`overrides_applied`, `field_provenance`, `voter_lines`, `voter_used`,
`extraction_kind`, `selected_model`, `model_selection_reason`. The
pipeline's full state for one order is exposed via
`/api/orders/<id>/pipeline-state` for the workspace's Pipeline
Diagnostics tab.

Cost telemetry: every successful adapter call increments
`docai_daily_usage(tenant_id, usage_date, adapter)`. Tenants set
hard daily caps via `tenant_settings.docai_daily_limits`. The
admin "DocAI cost" tab (`/admin#docai_cost`) aggregates today's
usage + 7-day trend + recommended actions; under the hood it reads
`/api/docai/cost_status`.

For the full plan see `docs/EXTRACTION_PIPELINE_PLAN.md`. For
zero-budget deployment see `docs/COST_OPTIMIZED_DEPLOYMENT.md`.
