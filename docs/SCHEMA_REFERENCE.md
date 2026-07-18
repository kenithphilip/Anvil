# Schema Reference

Ten migrations in order. Apply with `supabase db push --include-all`, paste
each file into the Supabase SQL editor, or run via psql with
`for f in supabase/migrations/0*.sql; do psql "$URL" -f "$f"; done`.

| File | Tables added | Enums added |
| --- | --- | --- |
| 001_init.sql | 16 | obara_role, order_status, source_po_status |
| 002_eval_and_email.sql | 3 | none |
| 003_studio_ocr_fx_inventory_lead.sql | 9 | none |
| 004_seed_static_data.sql | 0 | none (seeds 58 holiday rows + 10 lead-time rows) |
| 005_close_remaining_gaps.sql | 11 | none (alters orders, customer_format_profiles, source_pos, uom_aliases) |
| 006_corpus_alignment.sql | 20 | order_mode, customer_type, internal_so_type, contract_type, opportunity_stage, lead_status, project_phase, shipment_mode, item_lifecycle |
| 007_seed_real_corpus_data.sql | 0 (seeds 4 customers + 3 locations + 35 items) | none |
| 008_einvoice_forecast_amc.sql | 3 | einvoice_status |
| 009_corpus_round2_schema.sql | 7 | none (engineering_specs, payment_milestones, expense_rate_cards, inco_terms_taxonomy, blanket_release_drawdown, logistics_ports, logistics_carriers; partial unique indexes on payment_milestones and shipments) |
| 010_seed_corpus_round2_data.sql | 0 (seeds 2 more customers + NRD equipment + MG master + 11 release POs + 6 fingerprints + 1 eng spec + 11 expense rates + 4 approval thresholds + 96 more items) | none |

Total: 72 tables, 13 enums, 177 indexes, RLS on every business table.

All ten migrations are fully idempotent. See
[supabase/README.md](../supabase/README.md) for the apply order and the
patterns used to enforce idempotence.

## Conventions

- Every business table has `tenant_id uuid not null references tenants(id) on delete cascade` as the second column. Exceptions: `tenants` itself, `tenant_members` (composite key includes tenant_id), and a few global-rows tables where `tenant_id` is nullable: `holiday_calendar`, `lost_reason_taxonomy`, `redaction_rules`, `auth_magic_links`.
- Every business table has RLS enabled with two policies:
  - `<table>_select` for SELECT, using `tenant_id is null or tenant_id in (select current_tenant_ids())` (the `is null` clause only on tables with global rows).
  - `<table>_write` for INSERT/UPDATE/DELETE, using and with-check `tenant_id in (select current_tenant_ids())`.
- Service role bypasses RLS but every API call still filters with `.eq("tenant_id", ctx.tenantId)`.
- Status fields use uppercase enum-like values stored as text with CHECK constraints, except in 006 which switched to real Postgres enums for new types.
- Timestamps are `timestamptz`, defaulted to `now()`. Dates are `date` (no time) for business calendar fields.

## Functions and triggers

- `current_tenant_ids() returns setof uuid` (001): reads tenant_members for `auth.uid()`.
- `current_tenant_role(tenant uuid) returns obara_role` (001): role lookup.
- `set_updated_at()` (001): trigger function attached to customers, profiles, orders, source_pos, part_aliases, customer_lead_times, supplier_lead_times, bill_of_materials.
- `snapshot_customer_format_profile()` (003): on insert/update of customer_format_profiles when `is_current` changes to true, writes a row to customer_format_profile_versions.

## Storage buckets

Two private buckets must exist:

- `documents` (default): stores uploaded customer POs, quotes, price comp,
  attachments, golden examples.
- `audit-pack` (default): stores audit pack ZIPs.

Storage policies for `documents`:

```
obara documents read   = SELECT on bucket where authenticated
obara documents write  = INSERT on bucket where authenticated
```

The API uses the service role for storage so RLS bypasses; the policies
exist mostly for direct-from-browser flows.

## Migration 001: init

### tenants
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK | default `uuid_generate_v4()` |
| slug | text | unique |
| display_name | text | |
| settings | jsonb | default `{}` |
| created_at | timestamptz | default `now()` |

Special policy: `tenants_select` allows reading rows where `id in (select current_tenant_ids())`.

### tenant_members
Composite PK `(tenant_id, user_id)`. Role enum `obara_role`.

### customers
Tenant-scoped. Unique on (tenant_id, customer_key). 006 adds `customer_type`, `pan`, `primary_contact_email`, `primary_contact_phone`.

### customer_format_profiles
Stores fingerprint + recipe + learned_rules + golden_examples (added in 005). Unique partial index `customer_format_profiles_current` on (tenant_id, customer_id) where `is_current=true`. 005 adds `force_llm_fallback boolean default false`.

### documents
SHA-256 indexed for dedupe. `metadata jsonb` for arbitrary fields.

### orders
The biggest table. Columns added across migrations:
- 005: `tally_status`, `approval_expires_at`, `approval_actions text[]`.
- 006: `order_mode`, `parent_order_id`, `contract_id`, `lost_reason`, `competitor_name`, `forward_fx_rate`, `forward_contract_ref`, `customer_location_id`, `internal_so_type`, `project_phase`.

Status enum `order_status`: DRAFT, PENDING_REVIEW, APPROVED, BLOCKED, DUPLICATE, REUSED, EXPORTED_TO_TALLY, FAILED_TALLY_IMPORT, RECONCILED, CANCELLED.

Indexes: `orders_tenant_status_idx`, `orders_po_number_idx` (lower(po_number)), `orders_fingerprint_idx`, `orders_customer_idx`, `orders_tally_status_idx` (added 005), `orders_mode_idx` and `orders_parent_idx` (added 006).

### order_documents
Junction `(order_id, document_id) PK`. `role` check: purchase_order | quote | price_composition | attachment | supplier_ack.

### source_pos
Status enum `source_po_status`: DRAFT, PENDING_INTERNAL_APPROVAL, SENT_TO_SUPPLIER, SUPPLIER_ACK, PRICE_CHANGED, ETA_CONFIRMED, DELAYED, RECEIVED, CLOSED, CANCELLED.

005 adds: `ack_received_at`, `ack_payload jsonb`, `price_variance_pct`, `eta_variance_days`.

### source_po_events
Status transition log. `from_status, to_status, detail, actor`.

### evidence
Field-level provenance. Has `bbox jsonb`, `page_number`, `snippet`, `confidence`, `extraction_method`. Indexed by (order_id, field_path).

### validation_findings
Rule findings per order. `rule_id`, `code`, `severity`, `owner`, `blocks bool`, `line_index`, `detail`, `suggested_fix`, `resolved`.

### part_aliases
Unique on (tenant_id, customer_id, customer_part_no). Status: active | pending | deprecated.

### tally_masters, tally_voucher_records, uom_aliases
Tally integration tables. `tally_voucher_records` has unique idempotency on (tenant_id, voucher_no, payload_hash). 005 adds `integer_only`, `min_order_qty`, `pack_size`, `rounding_rule` to uom_aliases.

### audit_events, processing_events, extraction_cache
Append-only logs and a content-addressed cache for extraction reuse.

## Migration 002: eval and email

- `eval_runs`: per suite run summary (passed, failed, total_score).
- `eval_case_results`: per case results, FK to eval_runs.
- `email_intake_rules`: optional rules to classify inbound subjects.
- View `eval_accuracy_by_suite`: rollup view.

## Migration 003: studio, ocr, fx, inventory, lead times

- `customer_format_profile_versions`: history rows. Trigger `trg_snapshot_customer_format_profile` on customer_format_profiles fires after insert/update and copies the row.
- `fx_rates`: unique (tenant_id, from_ccy, to_ccy, as_of). Indexed for lookup desc.
- `customer_lead_times`, `supplier_lead_times`: per-customer / per-country lead day overrides.
- `holiday_calendar`: tenant-nullable for global rows. Unique nulls not distinct (tenant_id, country, date).
- `tally_inventory`: unique (tenant_id, stock_item_name).
- `bill_of_materials`: unique (tenant_id, parent_part_no, child_part_no).
- `ocr_runs`: per-document OCR job tracker.
- `zip_scans`: persisted scan results from `/api/documents/scan`.
- `auth_magic_links`: audit-only log of magic-link issuance.

## Migration 004: seeds

- 75+ rows in `holiday_calendar` for IN/CN/JP/KR/US 2026 (tenant_id null = global).
- 5 rows in `supplier_lead_times` for the default tenant: IN 7 days, CN 21, JP 21, KR 14, US 30.

## Migration 005: close remaining gaps

Adds 11 tables and 4 column groups across orders/profiles/source_pos/uom_aliases.

### communications
Per-order email thread. `direction in (inbound, outbound)`, `status in (draft, sent, failed, replied, archived)`, `template_code`, `attachments jsonb`.

### supplier_scorecards
Unique (tenant_id, supplier). Tracks `on_time_pct`, `price_accuracy_pct`, `response_time_hours`, `total_acks`, `variance_count`.

### order_amendments
`amendment_type in (qty, price, date, line_added, line_removed, mixed)`. Status: detected | approved | rejected | applied.

### spare_recommendations
Unique (tenant_id, part_no, customer_id). `criticality_score`, `recommended_qty`, `reason jsonb`.

### obsolete_parts
Tracks parts not seen in N months.

### model_routing_log
Per Claude call: primary_model, primary_status, primary_confidence, fallback_model, fallback_reason, fallback_status, total_input_tokens, total_output_tokens, total_latency_ms.

### redaction_rules
Pattern + replacement. `tenant_id` nullable (global). 008 widens write policy to allow admins to manage global rules.

### injection_test_runs
Catalogue + pass/fail summary plus per-case detail.

### eval_cases
The catalogue of golden test cases. Unique on (tenant_id, suite, case_id).

### backups
Storage path + size + taker.

## Migration 006: corpus alignment

The biggest schema migration. 9 new enums, 20 new tables, plus FK columns added to `orders` and `customers`.

### Enums
- `order_mode`: SPARES, SPARES_ASSEMBLY, PROJECT_FOR, PROJECT_HSS, INTERNAL.
- `customer_type`: AUTO_OEM, TIER_ONE, LINE_BUILDER, OTHER.
- `internal_so_type`: FOC_SUPPLY, WARRANTY_REPLACEMENT, PRODUCT_TRIAL, EXPECTED_PO, INTERNAL_TRANSFER.
- `contract_type`: ARC, BLANKET_PO, AMC, ONE_OFF.
- `opportunity_stage`: 11 values from QUALIFICATION through CLOSE_WON, CLOSE_LOST, REGRETTED.
- `lead_status`: NEW, CONTACTED, QUALIFIED, CONVERTED, REJECTED, REGRETTED.
- `project_phase`: 15 values from INITIAL_INFO through CLOSED.
- `shipment_mode`: SEA, AIR, ROAD, COURIER.
- `item_lifecycle`: ACTIVE, OBSOLETE, DISCONTINUED, NEW, TRIAL.

### customer_locations
Unique (tenant_id, customer_id, location_code). Holds GSTIN per plant.

### item_master
Canonical part data. Unique on (tenant_id, part_no). Indexes on lower(part_no), drawing_no, item_group + sub_group.

### contracts, contract_lines
ARC/Blanket/AMC headers and lines. `contract_number` unique per tenant.

### leads, opportunities
Pre-sale CRM. `leads.converted_opportunity_id` FK to opportunities (added after opportunities is created).

### internal_sales_orders, internal_so_lines
Five `iso_type` flavours including INTERNAL_TRANSFER.

### equipment_hierarchy, equipment_installed_parts
Plant -> Line -> Zone -> Station -> Robot -> Gun. Self-FK on `parent_id`.

### shipments
Cross-references orders, source_pos, internal_sales_orders. Carries vessel, ports, dates, POD flag, ASN.

### projects, project_phase_log
14-phase project lifecycle from corpus tracker. Each phase advance opens a new log row and closes the previous.

### service_visits, car_reports, closure_reports
Service module. CAR has `five_why_analysis jsonb`. Closure can be linked to a CAR.

### order_schedule_lines
For PO footnotes that say "as per schedule lines, sent separately".

### quote_approval_thresholds, quote_approvals
Threshold table maps role + amount range + mode to required approvers. Approvals table tracks per-order decisions.

### lost_reason_taxonomy
Tenant-nullable for global codes. Seed adds 9 default codes (PRICE_HIGH, LEAD_TIME, COMPETITOR_RELATIONSHIP, SCOPE_MISMATCH, QUALITY_CONCERN, BUDGET_CUT, NO_RESPONSE, TECHNICAL_GAP, PAYMENT_TERMS).

## Migration 007: real corpus seed

Idempotent (`on conflict do nothing`). All inserts under tenant `00000000-0000-0000-0000-000000000001`.

- Tenant row insert (in case migration was run before any other tenant seed).
- 4 customers: Vega Motor India Pvt. Ltd. (AUTO_OEM, GSTIN 24AAKCX0002A1Z5, PAN AAKCM8110E), WGX (TIER_ONE), Comet Motors PV Pune (AUTO_OEM), ABC Motors (AUTO_OEM, sample customer from corpus).
- 3 customer locations: MG HALOL (default, Gujarat), MG HARYANA, Tata PUNE.
- 35 item_master rows with HSN codes, source country, currency, GST rates extracted from the corpus.

## Migration 008: e-Invoice, forecast, AMC

### Enums
- `einvoice_status`: DRAFT, PENDING_GSTN, GENERATED, CANCELLED, REJECTED.

### einvoices
One row per IRN attempt. Holds `irn`, `ack_no`, `ack_date`, `qr_code_b64`, `signed_invoice_b64`, `ewb_no`, `ewb_valid_upto`, plus full `payload jsonb` (the request sent to GSTN) and `response jsonb` (the raw response).

Indexes: status, order, irn (global), customer.

### forecast_snapshots
Daily rollup. Unique (tenant_id, as_of, segment_dimension, segment_value). Index on (tenant_id, segment_dimension, as_of).

### amc_schedules
FK to contracts and customers. `visit_type in (PREVENTIVE, EMERGENCY, TRAINING, AUDIT)`. Status: SCHEDULED -> VISIT_CREATED -> COMPLETED. The cron at `/api/service/amc_cron` flips SCHEDULED rows due in the next 7 days to VISIT_CREATED and creates a `service_visits` row.

### Additional indexes
- `contracts_customer_status_idx (tenant_id, customer_id, status)`
- `contracts_type_idx (tenant_id, contract_type, status)`
- `shipments_source_po_idx (tenant_id, source_po_id)`
- `order_schedule_part_idx (tenant_id, part_no)`
- `einvoices_customer_idx (tenant_id, customer_id)`

### Policy fix
`redaction_rules_write` is widened so admins can manage global rules where `tenant_id is null`.

## Migration 095: Tally voucher reconciliation (Phase F.6)

Closes the Tally bridge loop. Today's `/api/tally/reconcile` is a
manual status flip; this migration adds the structures the
reconciler engine compares pushed payloads against
`tally_voucher_state` and persists findings.

### tally_reconciliation_runs
One row per reconciliation tick (cron) or operator click. Tracks
trigger (`cron|manual|workspace|retry`), scope (`all|order|tenant_recent|order_id`), counts of vouchers considered / drifted / clean, findings persisted, auto-fixes applied, and run status (`running|ok|partial_failure|failed`).

Indexes:
- `(tenant_id, started_at desc)` — history list.
- `(tenant_id, status, vouchers_drifted desc) where vouchers_drifted > 0` — partial index for "runs with drift".

### tally_reconciliation_findings
One row per drifted field on a single voucher. `finding_kind` is
constrained to: `voucher_cancelled_in_tally`, `voucher_altered_in_tally`, `total_mismatch`, `line_count_mismatch`, `voucher_no_mismatch`, `gstin_mismatch`, `party_mismatch`, `missing_in_tally`, `missing_locally`, `date_mismatch`. `severity` is `info|warn|error|critical`. `expected`/`actual` jsonb hold the diff; `diff_pct` carries the percent for `total_mismatch`. `auto_fix_applied` records the remediation taken (`re_pushed`, `amended`, `order_failed`, `none`). `resolved_at`/`resolved_by` track operator acks.

Indexes:
- `(tenant_id, created_at desc)` — main feed.
- `(tenant_id, order_id, created_at desc) where order_id is not null` — SO workspace drill-in.
- `(tenant_id, finding_kind, severity, created_at desc) where resolved_at is null` — open-findings queue.

### tally_voucher_records (additive columns)
- `last_reconciled_at timestamptz` — most recent run that touched the voucher.
- `last_drift_at timestamptz` — most recent finding (NULL when always clean).
- `drift_summary jsonb default '{}'` — rollup `{ kind: count }` of unresolved findings, e.g. `{"total_mismatch": 1, "voucher_altered_in_tally": 1}`. Empty when clean.
- Partial index `tally_voucher_records_drift_idx (tenant_id, last_drift_at desc) where last_drift_at is not null` for the "vouchers with active drift" query.

### tenant_settings (additive columns)
- `tally_recon_total_tolerance_pct numeric(5,2) default 0.50` — percent diff between expected and Tally total under which the reconciler treats as "no drift". Covers rounding noise.
- `tally_recon_auto_fix_enabled boolean default false` — opt-in flag. When TRUE the reconciler runs the auto-remediation paths (re-push for missing vouchers; flip the order to FAILED_TALLY_IMPORT for cancelled-in-Tally findings).

All new tables RLS-scoped on `tenant_id` against the JWT claim.

## Migration 146: ERP export ledger (PR3)

Idempotency guard for ERP sales-order exports. The HTTP push handlers
(SAP, NetSuite, D365, Acumatica, P21, Eclipse, SX.e, Sage X3, IFS,
Oracle Fusion, Ramco, JDE, Plex, JobBoss, Oracle EBS, proALPHA)
previously sent no idempotency key and did not check whether an order
was already exported, so a double-click or two overlapping pushes
created duplicate sales orders in the live ERP. This generalises the
Tally pattern to every HTTP connector. Tally keeps its own ledger
(`tally_voucher_records`) and is not duplicated here.

### erp_export_ledger
One success row per `(tenant_id, order_id, connector, payload_hash)`,
enforced by a unique constraint. Columns: `connector` (the
`external_systems` key, e.g. `sap`, `oracle_ebs`, `sage_x3`),
`payload_hash` (the approval-bound hash the export was built from),
`external_id` (the ERP-side sales order id), `status` (`success`),
`last_pushed_at`, `created_at`. Before the outbound call a handler
calls `checkExportIdempotency`: an exact match short-circuits to a
no-op returning the prior `external_id`; a different hash is blocked
(`PAYLOAD_HASH_CHANGED`) unless the caller passes `reexport:true`. On
success the handler calls `recordExport` to upsert the row.

Index: `(tenant_id, order_id, connector)` for the prior-export lookup.
RLS-scoped on `tenant_id` with the standard select/write policies.

## Migration 147: BOM ingestion (Phase 1)

Generalized, industry-neutral BOM ingestion. See
`docs/BOM_INGESTION_DESIGN.md`. Strictly additive: `bill_of_materials`,
`item_master`, and `/api/bom` are unchanged; the import endpoint derives
edges + catalog rows from these new tables.

### bom_assets
The finished product / equipment / assembly whose parts list was
imported (neutral generalization of a per-asset BOM header). Key columns:
`asset_code`, `name`, `asset_type` (free label), `customer_id`,
`source_format`, `revision` (default `''`; `unique(tenant_id, asset_code,
revision)`), `drawing_no`, `source_country`, `metadata` jsonb. Provenance:
`uploaded_by`, `last_uploaded_by`, `last_imported_at`. Governance (future
approver workflow; v1 only sets `imported`): `approval_status`
(`imported|pending_approval|approved|rejected`), `approved_by`,
`approved_at`.

### bom_lines
The as-imported parts list for an asset (source of truth for its
structure). Columns: `asset_id`, `seq_no` (source order;
`unique(tenant_id, asset_id, seq_no)`), `level` (assembly depth, null =
flat), `parent_line_id` (nullable; reserved), `part_no`, `part_name`,
`supplier_part_no` (external/source code), `supplier_id`, `material`,
`size`, `qty` numeric(18,6), `uom`, `side`, `std_category`, `is_spare`,
`remarks`, `raw` jsonb.

### bom_asset_projects
M:N link of an asset to `projects` (`primary key (tenant_id, asset_id,
project_id)`), with `qty`, `notes`, `created_by`. Customer flows from the
project or `bom_assets.customer_id`.

### bom_import_events
One row per upload / re-import: `asset_id`, `uploaded_by`,
`source_format`, `file_name`, `line_count`, `diff` jsonb (added/removed/
changed/unchanged counts). Provenance + basis for the future approver
workflow.

All four tables are RLS-scoped on `tenant_id` with the standard
select/write policies.

## Migration 148: BOM source-format registry (Phase 2)

### bom_source_formats
Tenant-configurable BOM source formats. Built-in profiles (obara india/
korea/china/japan + generic_flat) ship in code (`_lib/bom-format.js`);
this table holds tenant-authored formats and overrides of a built-in
(same `key` wins, merged at read time). Columns: `key`
(`unique(tenant_id, key)`), `label`, `source_country`, `column_map` jsonb
(`{ canonicalField: [header aliases] }`), `detect` jsonb (`headers_all`,
`any_label`, `script`, `filename`, `priority`), `quirks` jsonb
(`parts_code_to`, `level_from_col`, `level_from_dotted`, `lr_yes_no`,
`remarks_append`, `meta_labels`), `enabled`, `created_by`. RLS-scoped on
`tenant_id`. Lets any industry add a BOM layout as data, no code change.

## Migration 149: copilot action proposals (PR2)

### action_proposals
The confirm-token store for copilot safe actions. A write-capable copilot
tool creates a row here (preview + single-use `confirm_token`, short TTL,
bound to tenant + proposer) instead of acting; the action runs only when
a human confirms via `POST /api/copilot/confirm`. Columns: `created_by`,
`action`, `args` jsonb, `preview` jsonb, `payload_hash`, `confirm_token`
(unique), `status` (`proposed|consumed|cancelled|expired`), `expires_at`,
`consumed_at`, `result` jsonb. Consume is an atomic claim (single-use:
proposed -> consumed in one update), so a replay or concurrent confirm
cannot execute twice. RLS-scoped on `tenant_id`.

## Migration 150: operator actions (PR4)

Governed bridge for API-less workflow steps. See
`docs/OPERATOR_ACTIONS_DESIGN.md`. Flag-gated by
`tenant_settings.operator_actions_enabled` (added here, default false).

### operator_actions
A typed, ordered checklist for an off-system step (thick client / VDI /
console), optionally bound to an Anvil object (`object_type`/`object_id`).
`status` walks `proposed -> in_progress -> evidence_captured ->
reconciled` (+ `abandoned`). `reconcile_contract` jsonb declares the
governed write-back (`note` or guarded order `status`); `reconcile_result`
captures the outcome. Provenance: `created_by`/`started_by`/
`reconciled_by`. `driver` is `human` (a future computer-use driver sets
`cua` behind the same contract).

### operator_action_steps
One instruction per row (`seq`, `unique (tenant_id, operator_action_id,
seq)`), `status` (`pending|done|skipped`), notes, `done_by`/`done_at`.

### operator_action_evidence
Captured artifacts linked to the action / a step, pointing at `documents`
for the bytes (`document_id`) plus optional `ocr_text` (from
`documents/ocr`); `kind` (`screenshot|export|diff|note`), `captured_by`.

All RLS-scoped on `tenant_id` with the standard policies.

## Verifying after applying

In the SQL editor:

```sql
-- table count (should be 62 incl auth + storage which we don't touch)
select count(*) from information_schema.tables where table_schema='public';

-- enum count (should be at least 13)
select count(*) from pg_type where typtype='e';

-- RLS coverage
select c.relname, c.relrowsecurity
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind='r' and c.relname not in ('schema_migrations')
order by c.relname;
-- every row should have relrowsecurity=true
```

If any business table has `relrowsecurity=false`, re-run the migration that
created it; the RLS dynamic-policy block at the bottom of every migration
should cover everything.
