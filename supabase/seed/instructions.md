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

### 300_workflow_data.sql -- status: **DONE**

The largest single file. Sales workflow + downstream artefacts.

- `leads` 18 (all 6 `lead_status` values x 3 sources). 3 CONVERTED
  leads back-link to opportunities via `converted_opportunity_id`.
- `opportunities` 22 (all 11 `opportunity_stage` values x 2).
- `projects` 15 (one per `project_phase`). `project_phase_log` 60
  (3 historical + 1 current per project).
- `internal_sales_orders` 30 (all 5 `internal_so_type` x all 6
  statuses) + `internal_so_lines` 60 (2 per ISO).
- `orders` 50 (full 10 `order_status` x 5 `order_mode` grid).
  Anchors a 1-parent + 5-children blanket-release chain on
  MG_MOTOR_INDIA's `OIQTLC-240123` master quote (PO numbers
  `5100002501..5100002506`). 6 of 50 link to the BLANKET_PO
  contract from phase 200; periodic ARC and AMC links across the
  rest.
- Per-order fan-out (only for non-DRAFT): 3 documents per order,
  3 evidence rows, OCR run, ZIP scan, extraction run. BLOCKED
  orders carry 3 unresolved validation_findings + 3 amendments
  spanning detected/approved/rejected statuses. RECONCILED orders
  carry 1 amendment plus 1 order_reconciliation. APPROVED orders
  emit 1 outbound communication. Every order emits 2
  processing_events and 1-2 audit_events tracers.
- `source_pos` 20 (all 10 statuses x 2) + `source_po_events` 80
  (full DRAFT->PENDING->SENT->ACK chain per row).
- `supplier_scorecards` 6 (one per active vendor); `supplier_rfqs`
  5 covering draft/sent/quoting/awarded/closed; `supplier_rfq_lines`
  15 (3 per RFQ); `supplier_rfq_invitations` 15 (3 per RFQ);
  `supplier_quotes` 12 (2 quotes per invitation in non-draft RFQs).
- `shipments` 16 (all 8 status values x 2; cross-links to order +
  source_po + internal_so).
- `quote_approvals` 8 (every status x 2; PENDING rows reference
  PENDING_REVIEW orders).
- `service_visits` 10 (all 5 statuses x 2 visit_types);
  `amc_schedules` 10 (all 5 statuses x 2; 3 SCHEDULED rows link to
  generated `service_visits.id`); `car_reports` 8 (all 4 statuses;
  one carries populated `five_why_analysis`); `closure_reports` 5
  (3 referencing real CARs, 2 standalone).
- `spare_recommendations` 6 across customers; `obsolete_parts` 4
  pointing at the legacy item_master rows from phase 200.
- `einvoices` 5 (every `einvoice_status` x 1; GENERATED rows
  carry IRN + QR + ack_no + ewb_no).
- `invoices` 12 (mix of draft/sent/partial/paid/overdue/void) +
  `invoice_number_sequences` 1 + `payment_records` 6 (1 per paid
  invoice plus 1 razorpay variant).
- `ap_invoices` 6 (2 matched, 2 mismatched, 1 pending, 1 disputed)
  + `ap_invoice_lines` 12 + `ap_goods_receipts` 4.
- `deduction_queue` 3 (open / recovered / written_off).
- `razorpay_payments` 8 (all 5 statuses).
- `esignature_envelopes` 4 (sent/delivered/signed/declined) +
  `esignature_events` 5.
- `portal_tokens` 6 (4 active, 1 revoked, 1 expired) +
  `portal_access_log` 16 + `portal_quote_acceptances` 3 +
  `portal_reorders` 5.

### 400_logs_and_analytics.sql -- status: **DONE**

Append-only logs, analytics rollups, and channel artefacts.

- `audit_events` +201 bulk rows (1 marker + 200 cycled across
  10 action verbs) on top of phase 300's 65 tracers, total >=250.
- `model_routing_log` 121 (1 marker + 120 covering 10 purposes;
  every 5th row exercises a Claude->Mistral fallback path).
- `processing_events` +31 extras (1 marker + 30 system events
  covering classify / route / redact / rlhf / fallback) on top of
  phase 300's 100, total ~131.
- `mcp_call_log` 21 (1 marker + 20 across all 6 read scopes; every
  6th row is `denied`, every 7th is `error`).
- `eval_cases` 20 (3 suites x ~7 cases each); `eval_runs` 5;
  `eval_case_results` 100 (full 5x20 grid).
- `agent_goals` 8 (all 5 statuses + all 3 goal_types);
  `agent_steps` 76 (4 to 12 per goal); `agent_eval_runs` 5.
- `deploys` 8 (5 preview, 3 production); `backups` 6 (3 succeeded,
  1 failed, 2 in_progress, encoded in `notes` since the schema
  has no status column); `audit_export_runs` 4;
  `injection_test_runs` 3.
- Forecast + analytics: `forecast_snapshots` 120 (4 months x 2
  dimensions x 15 segments); `analytics_customer_monthly` 24
  (12 months x 2 customers); `analytics_winloss_daily` 30;
  `rlhf_feedback` 25; `rlhf_reward_daily` 30.
- Channel: `push_subscriptions` 4 (web + fcm + inactive);
  `push_notifications` 8 (queued/sent/failed/expired x 2);
  `inbound_email_threads` 40; `inbound_emails` 150 (3-5 per
  thread; all 6 status values; 4 thread states);
  `inbound_chat_configs` 2 (Slack + Teams); `inbound_messages`
  24 (4 channels: WhatsApp/Slack/Teams/WeChat); `voice_configs`
  1; `voice_calls` 5 (4 statuses); `voice_call_actions` 3.
- Network + outbound: `network_listings` 30 (3 sources);
  `network_sourcing_queries` 4; `prospecting_campaigns` 3;
  `prospecting_targets` 30 (all 7 statuses);
  `prospecting_suppressions` 8 (mix tenant + global).
- EDI: `edi_partners` 4 (X12 + EDIFACT); `edi_envelopes` 12
  (all 6 message types and 6 statuses).
- PLM: `plm_systems` 2 (Windchill + Arena); `plm_boms` 5;
  `plm_changes` 8; `plm_sync_state` 4 (all 3 statuses).
- `vertical_pack_installs` 3 (welding-equipment, automotive-tier1,
  auto-OEM).
- `erp_chat_sessions` 4 + `erp_chat_messages` 54 (9, 12, 15, 18
  messages per session, all 3 roles: user/assistant/tool).
- `print_jobs` 8 (all 5 statuses + all 3 trigger types).

Re-run safety: `audit_events`, `model_routing_log`,
`processing_events`, and `mcp_call_log` use sentinel marker rows
to short-circuit the bulk loops, so re-applying phase 400 is a
no-op.

### 500_erp_mirrors.sql -- status: **DONE**

Three deep ERP seeds plus a templated PL/pgSQL helper for the
other 14 connectors.

**Deep seeds (per locked decision B):**

- **NetSuite (014, 015):** sync_state 6 (one per entity:
  customer/item/inventory/sales_order/invoice/ar_aging),
  sync_runs 5 (covers all 4 statuses + 1 historical), retry_queue
  4, open_orders 6, vendors 6 (mirroring real suppliers),
  purchase_orders 8, locations 4 (3 active + 1 inactive),
  currencies 4 (INR/USD/EUR/JPY), inventory_balances 12 (4 items
  x 3 locations).
- **SAP (017):** sync_state 5, sync_runs 5, retry_queue 4,
  business_partners 6, materials 8 (mirroring item_master),
  plants 3 (IN-Halol/IN-Pune/DE-Hamburg), currencies 4,
  sales_orders 6, purchase_orders 5, inventory_balances 12.
- **Tally v2 (016):** companies 1 (default), voucher_records 6
  (every voucher status), payment_receipts 4, retry_queue 4,
  sync_runs 5, voucher_state 4 (imported / edited / cancelled).

**Templated minimum** for D365, Acumatica, P21, Eclipse, SX.e,
Sage X3, IFS, Oracle Fusion, Ramco, JDE, Plex, JobBoss, Oracle
EBS, proALPHA. The `_seed_erp_templated(prefix)` helper handles
each connector: 1 sync_state row, 5 sync_runs (every status + 1
historical), 4 retry_queue (pending/succeeded/gave_up + 1
retry-heavy), 3 customers, 3 items (the helper auto-detects the
items table variant: `_items` / `_stock_items` /
`_released_products` / `_products`), 3 sales_orders, plus 3
purchase_orders + 3 inventory_balances + 3
branches/warehouses/plants/locations rows where the connector
exposes those mirror tables. Helper is dropped after `commit;`.

`status='processing'` rows are intentionally not seeded (added
by migration 059 alongside the `claimed_at` / `claimed_by`
columns; only meaningful when a real worker has claimed the row).

Razorpay (020) was seeded in phase 300 (8 razorpay_payments
covering all 5 statuses); phase 500 leaves it alone.

### 900_teardown.sql -- status: **DONE**

Two safety guards before any DELETE runs:
1. `app.seed_env` must be `staging` / `local` / `ci`.
2. Production hostname guard: refuses if `cluster_name` or
   `application_name` contains `production` or `prod-`.

Reverse-FK-order delete: 500 -> 400 -> 300 -> 200 -> 100. Selection
strategy per table:
- jsonb seed_marker on `raw` / `payload` / `metadata` columns
  where the seed embedded one.
- deterministic UUID formula via `uuid_generate_v5(seed_ns,
  '<entity>:<key>')` for tables without a marker column (sync_state
  rows, NetSuite open_orders, etc.).
- field-value matches for log-shaped tables (`audit_events.detail
  like 'phase400:%'`, `processing_events.case_id like 'case:%'`,
  `model_routing_log.purpose = 'phase400_marker'`,
  `mcp_call_log.tool = 'phase400_marker'`).

Corpus seed (`supabase/seed.sql`) is preserved: its rows do not
carry our `seed_marker` and its UUIDs are not derived from our
namespace, so no WHERE clause here can match them.

Idempotent: every delete returns 0 rows on the second run.

`obara_role.operator` enum value (added by phase 100) is not
removed: dropping enum values requires a full type rebuild and
risks breaking unrelated code.

### 999_verify.sql -- status: **DONE**

Read-only. Six sections:
1. **Row-count summary** across every public-schema table.
2. **State coverage**, two parts:
   a. **Enum coverage:** auto-discovers every column in the public
      schema with one of the 14 known enum types, then asserts
      `count(*) >= 1` for each enum value.
   b. **Text-checked status coverage:** explicit (table, column,
      expected_value) tuples for every text-checked status /
      direction / type column (~120 rows).
3. **Cross-module link audit:** 20 named checks asserting each
   CROSS-MODULE LINK REQUIREMENT row count is `>= floor`.
4. **RBAC fixture audit:** 1 user per role (7) and per status (4).
5. **UI smoke probes:** 110+ named probes mirroring what each v3
   screen's API endpoint runs.
6. **Single-line summary:** sentinel re-check; emits `verify: PASS`
   or `verify: FAIL (N below floor)` so output is greppable.

### 600_storage_uploads.sql -- status: **OUT OF SCOPE**

Per prompt section E, this file is emitted only when
`SEED_INCLUDE_STORAGE=true`. That env var was not in scope; the
seed pack ships without it. The `documents` rows seeded by
phase 300 carry deterministic `path` strings only (option E.1);
byte uploads remain a separate, out-of-band concern handled by
the `documents.upload` API path. If real PDFs are ever needed
for storage-bucket smoke tests, follow-up work would either:

- Hand-author 5 minimal valid PDFs into `tests/fixtures/` and
  emit a 600 file that uses `pg_largeobject` or a documented
  `supabase storage` upload sequence, or
- Skip storage seeding entirely and rely on the API path for
  test-time uploads.

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
   `alter type ... add value if not exists`, run OUTSIDE the explicit
   transaction wrapper (Postgres rejects use of a newly-added enum
   value in the same transaction that adds it).
2. The migrations claim 058 makes `audit_events` append-only, but
   the migration only drops the UPDATE/DELETE policies; service-role
   inserts of historical rows continue to work, so phase 400 does not
   need to disable a trigger.
3. Migration `021_push_notifications.sql` tried to declare
   `unique (..., coalesce(endpoint, device_token))` inside CREATE
   TABLE. Postgres rejects function expressions in inline UNIQUE
   constraints; the migration was repaired to use a separate
   `CREATE UNIQUE INDEX` statement. This migration had never
   successfully applied to a fresh Postgres before this seed effort.

## Smoke-test fixes captured during the May 2026 dry run

Running the pack against a fresh Supabase project surfaced the
following real bugs. Each is fixed in the file referenced; the seed
ran clean end-to-end after the patches and `999_verify.sql` returned
**375 of 375** checks green.

| # | File | Bug | Fix |
|---|---|---|---|
| 1 | `migrations/021` | `unique (col, coalesce(...))` rejected inline | Moved to `CREATE UNIQUE INDEX` |
| 2 | phase 100 | PL/pgSQL `user_id` shadowed `tenant_members.user_id` in `ON CONFLICT` | Renamed to `v_user_id` |
| 3 | phase 100 | `alter type ... add value` inside explicit txn | Moved before `begin;` |
| 4 | phases 100/200/300/400/900 | Wrong corpus customer keys (`JBM_AUTO`, `RENAULT_NISSAN`) | Renamed to `JBM_AUTO_PLANT_1`, `RNAIPL` |
| 5 | phase 200 | `payment_milestones` ON CONFLICT missed partial-index predicate | Added `where contract_id is not null` |
| 6 | phase 300 | `order_schedule_lines` referenced `doc_po` for DRAFT orders that never inserted one | Set `source_document_id = null` for DRAFT |
| 7 | phase 300 | `source_pos.order_id` looked up orders by `source_po_status` instead of `order_status` | Added separate `ord_statuses` array |
| 8 | phase 300 | `shipments.order_id` looked up orders by `shipment_mode` instead of `order_mode` | Added separate `ord_modes` array |
| 9 | phase 300 | `esignature_events` insert missed `on conflict (id) do nothing` | Added |
| 10 | phase 400 | PL/pgSQL `suite` shadowed `eval_cases.suite` / `eval_runs.suite` | Renamed to `v_suite` |
| 11 | phase 400 | PL/pgSQL `case_id` shadowed `eval_cases.case_id` | Renamed to `v_case_id` |
| 12 | phase 400 | `rlhf_feedback` requires NOT NULL `rating smallint` | Added column to INSERT |
| 13 | phase 400 | `inbound_messages.status` allows `intake-extracted`/`resolved`, not `parsed`/`duplicate` | Updated cycle |
| 14 | phase 400 | `network_listings unique (tenant_id, sku)` violated by 30-row reuse of 5 SKUs | Suffixed sku with iteration index |
| 15 | phase 400 | `prospecting_campaigns` cycle hit only 2 distinct statuses out of 4 | Bumped loop to 4 with one campaign per status |
| 16 | phase 500 | PL/pgSQL `company_id` shadowed `tally_*.company_id` | Renamed to `v_company_id` |
| 17 | phase 500 | Templated `_sync_state` insert used `error` column; newer connectors use `last_error` | Dropped the column from the insert |
| 18 | phase 999 | `check` (reserved word) used as column alias | Renamed to `check_name` |
| 19 | phase 999 | Bulk regex on `count(*) ... from <table>` collapsed `from <table>` to `fromtable` | Restored space |

The pattern that produced #2, #10, #11, #16: PL/pgSQL variables
that share a name with a target table column become ambiguous in
`ON CONFLICT (...)` and `INSERT (..., col, ...) ... values (...,
col_var, ...)` contexts. **Convention going forward**: prefix
PL/pgSQL locals with `v_` to make column-vs-variable disambiguation
syntactic.

The pattern that produced #7 and #8: enum domains that share a
status name (e.g. shipment_mode and order_mode are different
enums) but get confused at the call site. **Convention going
forward**: when constructing keys that span two enum domains,
declare a separate array variable per domain rather than reusing
a single `statuses` / `modes` name.

The round-trip test (teardown -> re-seed -> verify) was also
exercised against the live Supabase project; teardown removes
every seed row without touching the corpus + migrations, and the
re-seed restores all 375 verify checks to green.

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
