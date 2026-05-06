# Anvil seed pack -- instructions

A self-contained, idempotent seed layer that exercises every v3
screen, every API endpoint, every workflow stage, and every
cross-module link in the Anvil platform. Designed to drop into a
staging / local / CI Supabase project on top of the migrations
(001..059) and the existing corpus seed at `supabase/seed.sql`.

## How to apply

The seed pack relies on two guards:

1. The session must declare the environment.

   ```sql
   set app.seed_env = 'staging';   -- or 'local' / 'ci'
   ```

2. The session must run as `service_role` (or the postgres
   superuser). RLS is active on every tenant-scoped table; an
   authenticated session will silently skip the inserts.

Apply files in numeric order. Each file is wrapped in a single
transaction and ends with `commit;`, so a partial failure rolls
back without polluting the schema.

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
  -c "set app.seed_env = 'staging';" \
  -f supabase/seed/100_users_and_tenants.sql \
  -f supabase/seed/200_master_data.sql \
  -f supabase/seed/300_workflow_data.sql \
  -f supabase/seed/400_logs_and_analytics.sql \
  -f supabase/seed/500_erp_mirrors.sql
```

To verify after applying, run `999_verify.sql` -- it asserts row
counts, state coverage, and cross-module link presence.

To roll the seed back, run `900_teardown.sql` (which uses the
`anvil-test-seed-v1` marker to delete precisely without touching
real customer rows from the corpus seed).

## Common conventions across all phase files

| Convention | Detail |
|---|---|
| Idempotency | every `insert` ends in `on conflict ... do nothing`. Re-running any phase is a no-op. Never `do update`. |
| Deterministic UUIDs | `uuid_generate_v5(seed_ns, '<entity>:<key>')` with phase-specific sub-namespaces so cross-phase references work without lookup tables. |
| User UUIDs | per locked decision A: `uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:' || email)`. |
| Seed marker | `{"seed_marker": "anvil-test-seed-v1"}` merged into every jsonb metadata / payload column. Drives the teardown. |
| Time anchor | `seed_now := now()` per file; every `created_at` derived as `seed_now - interval 'N days/hours'`. No literal dates (except `holiday_calendar`). |
| Tenant scope | every tenant-scoped row uses the default tenant `00000000-0000-0000-0000-000000000001`. |
| RLS | files require service_role. Comment at the top of each file restates this. |
| Env guard | first executable statement refuses to run unless `app.seed_env` is set to staging/local/ci. |

## Phase namespaces

Each phase pins a sub-namespace so a future cross-phase reference
stays unambiguous:

| Phase | Sub-namespace UUID |
|---|---|
| 100 | `d7a7e5e4-0001-0001-0001-000000000001` |
| 200 | `d7a7e5e4-0001-0002-0001-000000000001` |
| 300 | `d7a7e5e4-0001-0003-0001-000000000001` |
| 400 | `d7a7e5e4-0001-0004-0001-000000000001` |
| 500 | `d7a7e5e4-0001-0005-0001-000000000001` |

## Locked test credentials (staging / local / CI only)

- **Common password:** `Anvil!Seed#2026` (bcrypt at insert time).
- **Shared TOTP secret (base32):** `JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP`.
  Enroll in Authy / 1Password / Google Authenticator under
  "Anvil Staging". Used by `admin.primary`, `mgr.alpha`,
  `fin.alpha`.

## File-by-file scope and status

### 100_users_and_tenants.sql -- status: **DONE**

Identity layer.

- `auth.users`: 15 fixture users covering every role and status:
  admin (2), sales_engineer (3 incl. pending), sales_manager (2),
  procurement (2), finance (2), operator (1), viewer (1), denied
  (1), deactivated (1).
- `tenant_members` per locked decision A.
- `tenant_settings`, `access_reviews` (one in-progress, one
  complete), `admin_notifications` (one unresolved access_request
  to drive the bell badge plus four resolved bg items).
- `user_security_settings` (TOTP fixture for 3 users), `user_passkeys`
  (1 row for `eng.beta`), `user_security_audit` (30 events).
- `mcp_tokens` (active / revoked / expired), `redaction_rules` (3
  global + 3 tenant), `email_intake_rules` (5).
- Master data tied to identity: `holiday_calendar` (DE additions for
  Globex), `fx_rates` (USD/EUR/JPY/KRW <-> INR for 8 days),
  `customer_lead_times` (per corpus customer), `supplier_lead_times`
  (extension to the 5 from migration 004), `lost_reason_taxonomy`
  (12 global rows), `inco_terms_taxonomy` (12 codes), `logistics_ports`
  (12), `logistics_carriers` (8), `auth_magic_links` (8 rows
  covering sent/failed/verified), `password_reset_attempts`,
  `mfa_attempts`, `magic_link_attempts`.

Schema repair: adds `operator` to `obara_role` enum
(`alter type ... add value if not exists`). The matrix and
`docs/RBAC.md` claim migration 010 added it but no migration
ever did, and `auth.js` already references `operator` in
`WRITER_ROLES`/`VIEWER_ROLES`.

### 200_master_data.sql -- status: **DONE**

Reference data the rest of the seed pivots around.

- 4 fictional customers: Anvil Test Industries (TIER_ONE / MH),
  Globex GmbH (LINE_BUILDER / DE / EUR), Acme Robotics (OTHER /
  US / USD), Nippon Kogyo (TIER_ONE / JP / Unicode).
- `customer_locations` for each of the 4.
- `customer_format_profiles` v1 -> v2 sequence on ATI to exercise
  the `snapshot_customer_format_profile` trigger (auto-fills
  `customer_format_profile_versions`).
- `item_master` extension: 17 rows (3 OBSOLETE, 3 DISCONTINUED,
  4 NEW, 3 TRIAL, 4 ACTIVE for BOM parent + sub-assemblies).
- `part_aliases`: 8 rows covering active / pending / deprecated.
- `uom_aliases`: 12 rows covering all `rounding_rule` values plus
  `integer_only` / `min_order_qty` / `pack_size` variants.
- `bill_of_materials`: a 3-level BOM (1 parent -> 4 sub-assemblies
  -> 12 components). The `X2C-BASE-ASSY` parent.
- `tally_inventory` (15), `catalog_synonyms` (11), `catalog_alternatives`
  (10 covering all 4 relations), `private_label_items` (5),
  `vendors` (8 incl. one inactive).
- `equipment_hierarchy`: full Plant -> Line -> Zone -> Station ->
  Robot -> Gun chain for MG Halol and JBM Plant 1 (12 nodes).
- `equipment_installed_parts` (32), `installed_base` (10).
- `contracts`: 16 rows covering every `contract_type` x every
  `status` (4 x 4). `contract_lines` (3 per contract = 48).
- `payment_milestones` (7), `blanket_release_drawdown` (12 = 3 per
  BLANKET_PO contract x 4), `engineering_specs` (4).

### 300_workflow_data.sql -- status: **TODO**

The largest single file. Sales workflow + downstream artefacts.

Planned tables and floor counts:

- `leads` (18; all 6 `lead_status` values), `opportunities`
  (22; all 11 `opportunity_stage` values), `projects` (15; one per
  `project_phase`), `project_phase_log` (3-5 rows per project),
  `internal_sales_orders` (covering all 5 `internal_so_type` and
  all 6 statuses) + `internal_so_lines`.
- `orders` (50 rows covering every `order_status` x `order_mode`
  combination, parent/child blanket-release chain anchored on the
  MG `OIQTLC-240123` master quote, BLOCKED orders with >=3
  unresolved findings, RECONCILED ones with reconciliation rows,
  customer-format-profile-driven `format_change_summary`).
- Per-order fan-out: `order_documents`, `evidence` (>=3 fields per
  non-DRAFT), `validation_findings` (mix resolved/unresolved),
  `order_amendments` (3 different statuses for one order),
  `order_reconciliations` (RECONCILED order has one),
  `order_schedule_lines` (>=3 for `mode_hint='blanket'`),
  `communications` (>=1 thread per APPROVED), `documents`,
  `ocr_runs`, `zip_scans`, `extraction_*`, `processing_events`
  (1-3 per workflow row), `audit_events` (1-4 per workflow row).
- `source_pos` (22; all 10 `source_po_status`) + `source_po_events`
  (full DRAFT->PENDING->SENT->ACK chain per row), `supplier_scorecards`
  (one per supplier, 6 suppliers), `supplier_rfqs` (5; mix of
  statuses) + `supplier_rfq_lines` + `supplier_rfq_invitations`
  + `supplier_quotes`.
- `shipments` (18; all 8 status values, every `shipment_mode`,
  one row per (order_id, source_po_id, internal_so_id) combo).
- `quote_approvals` (every status x 2; PENDING references orders
  in `PENDING_REVIEW`).
- `service_visits` (12; all 5 statuses x 2 visit_types),
  `amc_schedules` (10; all 5 statuses + all 4 visit_types),
  `car_reports` (8; all 4 statuses, one with `five_why_analysis`),
  `closure_reports` (5; linked to >=2 CARs).
- `spare_recommendations`, `obsolete_parts`.
- `einvoices` (every `einvoice_status` x 1).
- `invoices` (12; mix of paid / partial / overdue / voided),
  `invoice_number_sequences`, `payment_records`, `ap_invoices` +
  `ap_invoice_lines` + `ap_goods_receipts` (6 invoices, 3-way
  match scenarios: 2 matched, 1 qty mismatch, 1 price mismatch),
  `deduction_queue` (3: open / resolved / written-off),
  `razorpay_payments`.
- `esignature_envelopes` + `_events` (sent / viewed / signed /
  declined), `portal_tokens` + `portal_access_log` +
  `portal_quote_acceptances` + `portal_reorders`.

### 400_logs_and_analytics.sql -- status: **TODO**

Append-only logs, analytics rollups, and channel artefacts.

Planned tables and floor counts:

- `audit_events` bulk fill to **>=250 rows** total (combined with
  per-workflow events emitted in 300).
- `processing_events` (100), `model_routing_log` (120; every Claude
  call has a primary/fallback path; mix of fallback-fired and
  primary-only).
- `eval_cases` (20 across 3 suites: extraction / validation /
  classification), `eval_runs` (5) + `eval_case_results` (full
  5x20 grid).
- `agent_goals` (8; mix of active / paused / completed),
  `agent_steps` (4-12 per goal), `agent_eval_runs` (5).
- `deploys` (8; mix of preview / production envs and git shas),
  `backups` (6; 3 succeeded / 1 failed / 2 in_progress),
  `audit_export_runs` (4), `injection_test_runs` (3).
- Security audit extensions: more `user_security_audit` rows on
  top of phase 100, `password_reset_attempts` extra rows,
  `auth_magic_links` extra rows, `mcp_call_log` (20).
- Forecast + analytics: `forecast_snapshots` (120; 4 months x 2
  dimensions x ~15 segments), `analytics_customer_monthly` (24),
  `analytics_winloss_daily` (30), `rlhf_feedback` (25),
  `rlhf_reward_daily` (30).
- Channel and integration: `push_subscriptions` + `push_notifications`
  (4 / 8), `inbound_emails` + `inbound_email_threads` +
  `inbound_messages` (40 threads / 150 messages), `inbound_chat_configs`
  (2: Slack + Teams), `voice_calls` + `voice_call_actions` (5 /
  3 with extracted actions), `voice_configs` (1).
- Outbound + integrations: `network_listings` + `network_sourcing_queries`,
  `prospecting_campaigns` + `_targets` + `_suppressions`,
  `edi_partners` + `edi_envelopes`, `plm_systems` + `plm_boms` +
  `plm_changes` + `plm_sync_state`, `vertical_pack_installs` (3),
  `erp_chat_sessions` + `erp_chat_messages`, `print_jobs`.

### 500_erp_mirrors.sql -- status: **TODO**

Three deep ERP seeds plus a templated function for the other 14
connectors.

- **Deep:** NetSuite (014, 015), SAP (017), Tally v2 (016) per
  locked decision B. Each gets `sync_state`, 5 `sync_runs` covering
  every status, 4 `retry_queue` rows, and the per-connector entity
  mirrors mirroring the seeded `customers` / `item_master`.
- **Templated:** one PL/pgSQL function called once per connector
  for D365, Acumatica, P21, Eclipse, SX.e, Sage X3, IFS, Oracle
  Fusion, Ramco, JDE, Plex, JobBoss, Oracle EBS, proALPHA. Per
  connector: 1 `sync_state`, 5 `sync_runs`, 4 `retry_queue`, 3
  rows in each applicable entity-mirror table (customers / items /
  sales_orders / purchase_orders / inventory_balances).
- Razorpay (020): 8 `razorpay_payments` covering created /
  authorized / captured / refunded / failed.

### 900_teardown.sql -- status: **TODO**

Reverses every seed in reverse FK order, gated on:
- the `app.seed_env` env guard;
- a hostname check that rejects `*.production.*` patterns;
- the `seed_marker = 'anvil-test-seed-v1'` jsonb marker;
- deterministic seed-namespace UUIDs.

Order: 500 -> 400 -> 300 -> 200 -> 100 (reverse of apply order).
For tables without a jsonb marker column, the script deletes by
formula: `id in (select uuid_generate_v5(seed_ns, '<entity>:<key>') ...)`.

### 999_verify.sql -- status: **TODO**

Read-only verification queries:
1. Row-count summary across all 259 tables.
2. State-coverage check: one row per enum value, one per status,
   asserting `count(*) >= 1`.
3. Cross-module-link audit: one query per "CROSS-MODULE LINK
   REQUIREMENTS" item from the prompt.
4. RBAC fixture audit: 1 user per role, 1 user per status.
5. "What would break the UI": SELECT statements that mirror what
   each v3 screen's API endpoint runs, asserting non-zero results.

### 600_storage_uploads.sql -- status: **OPTIONAL, deferred**

Only emitted if `SEED_INCLUDE_STORAGE=true`. Either uses
`pg_largeobject` or instructs the operator to manually upload
5 sample PDFs from `tests/fixtures/`. Not required for v1 scope.

## Open scoping notes (decisions already locked but worth flagging)

- **Auth users:** option (1) from prompt section A. We insert
  directly into `auth.users` via service-role with bcrypt-hashed
  passwords. Self-contained; bypasses Supabase signup flow.
- **ERP connector depth:** option (B.1) -- 3 deep + 14 templated.
- **Volume targets:** matrix floors with the explicit overrides in
  prompt section C (orders 50, audit_events 250, model_routing_log
  120, inbound_emails/messages 40/150, forecast_snapshots 120,
  processing_events 100, eval_case_results filling 5x20).
- **Timestamps:** option (D.1) -- relative to `now()` per file.
- **Storage objects:** option (E.1) -- documents.path strings only.
  No bytes uploaded.
- **Real names vs faker:** option (F.1) -- corpus customers carry
  ~70% of every workflow table. The 4 fictional customers carry
  the EU/US/JP/Unicode/multi-currency edges.
- **Out of scope modules:** none. All 18 modules from matrix
  section 2a plus all 17 ERP connectors get seeded.

## Known gaps the seed pack repairs

1. `obara_role` enum is missing `operator`. Phase 100 adds it via
   `alter type ... add value if not exists`.
2. The migrations claim 058 makes `audit_events` append-only, but
   the migration only drops the UPDATE/DELETE policies; service-
   role inserts of historical rows continue to work, so phase 400
   does not need to disable a trigger.

## What to read before extending the seed

| Path | Why |
|---|---|
| `supabase/migrations/*.sql` (all 59) | Source of truth for every column, enum, FK, check constraint. |
| `supabase/seed.sql` | Existing corpus seed. Do not duplicate. |
| `docs/SCHEMA_REFERENCE.md` | Per-table notes, RLS pattern, trigger behavior. |
| `docs/V3_ROUTE_CONTRACT.md` | Every v3 screen -> backing tables -> API endpoint. |
| `docs/RBAC.md` | Role x route x permission matrix. |
| The Phase 1 discovery: `anvil_seed_coverage_matrix.md` | Per-module row counts and state-coverage requirements. Authoritative for **what** to seed. |
| The Phase 1 prompt: `anvil_seed_generation_prompt.md` | Authoritative for **how** to seed (idempotency, UUIDs, env guard, etc.). |

If anything in this document conflicts with the migrations, the
**migrations win**.
