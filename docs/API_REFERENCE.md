# API Reference

Every Vercel serverless route under `api/`. Format:

```
### METHOD /api/path
Permission: read | write | admin | approve
Query/Body: ...
Response: ...
Effects: side effects (DB writes, audit events, external calls)
```

Auth is the same across all endpoints: `Authorization: Bearer <Supabase access
token>` or fall back to the default tenant when `ALLOW_ANONYMOUS_TENANT=true`.

CORS preflight: every endpoint handles `OPTIONS`.

## admin

### GET /api/admin/holidays

Permission: read.
Query: `country` (optional, ISO-2), `from`, `to` (YYYY-MM-DD).
Response: `{ holidays: [{ id, tenant_id, country, date, name, ... }] }`.
Effects: read-only. Includes both tenant rows and global rows (tenant_id null).

### POST /api/admin/holidays

Permission: admin.
Body: `{ country: string (ISO-2), date: YYYY-MM-DD, name?: string }`.
Response: `{ holiday: {...} }`.
Effects: upsert on (tenant_id, country, date). Audit `holiday_upsert`.

### DELETE /api/admin/holidays?id=<uuid>

Permission: admin. Audit `holiday_delete`.

### GET /api/admin/lead_times?type=customer|supplier

Permission: read.
Response: `{ rows: [...], type }`.

### POST /api/admin/lead_times?type=customer|supplier

Permission: admin.
Body: `{ lead_days: 0..365, product_category?, customer_id?, supplier?, country?, notes?, id? }`.
Response: `{ row }`. If `id` is present, updates; else inserts.

### DELETE /api/admin/lead_times?type=...&id=<uuid>

Permission: admin.

### GET /api/admin/members

Permission: read. Response includes joined `auth.users` data.

### POST /api/admin/members

Permission: admin.
Body: `{ email, role: sales_engineer|sales_manager|approver|viewer|admin|operator|finance }`.
Effects: calls `auth.admin.inviteUserByEmail`, upserts `tenant_members`. Audit `member_invite`.

### PATCH /api/admin/members

Permission: admin.
Body: `{ user_id, role }`. Audit `member_role_change`.

### DELETE /api/admin/members?user_id=<uuid>

Permission: admin. Audit `member_revoke`.

### GET /api/admin/inventory?q=&limit=

Permission: read. Lists `tally_inventory` for the tenant.

### POST /api/admin/inventory

Permission: admin.
Body: `{ stock_item_name, available_qty?, reserved_qty?, reorder_level?, uom? }`.
Effects: upsert on (tenant_id, stock_item_name). Audit `inventory_upsert`.

### DELETE /api/admin/inventory?id=<uuid>

Permission: admin.

### GET /api/admin/fx_rates?from=&to=&days=

Permission: read.
Response: `{ rates: [...] }`. Defaults to last 90 days.

### POST /api/admin/fx_rates

Permission: admin.
Body: `{ asOf?, bases?: string[], targets?: string[] }`.
Effects: calls `FX_PROVIDER_URL` for each base/target pair, upserts `fx_rates`.
Audit `fx_manual_refresh`.

### GET /api/admin/contracts

Permission: read.
Query: `customer_id`, `type` (ARC|BLANKET_PO|AMC|ONE_OFF), `status`.
Response: `{ contracts: [{ ..., lines: [...] }] }`.

### POST /api/admin/contracts

Permission: admin.
Body: `{ contract_number, contract_type, customer_id, start_date, end_date?, total_value_inr?, currency?, status?, notes?, parent_quote_id?, lines?: [{part_no, description?, qty_committed?, unit_price?, uom?, notes?}] }`.
Effects: upsert on (tenant_id, contract_number); inserts contract_lines. Audit `contract_upsert`.

### DELETE /api/admin/contracts?id=<uuid>

Permission: admin.

### GET /api/admin/item_master?q=&source_country=&lifecycle=&limit=

Permission: read. Search escapes `%`, `_`, `,`, `(`, `)`, `*` on the `q` filter.

### POST /api/admin/item_master

Permission: admin.
Single body: `{ part_no, description?, drawing_no?, uom?, item_group?, source_country?, source_currency?, purchase_price?, hsn_sac?, sgst_rate?, cgst_rate?, igst_rate?, default_lead_days?, moq?, pack_size?, lifecycle?, is_assembly?, notes? }`.
Bulk body: `{ rows: [...] }`. Returns `{ ok: true, rows: count }`.
Effects: upsert on (tenant_id, part_no). Audit `item_master_upsert` or `item_master_bulk`.

### DELETE /api/admin/item_master?id=<uuid>

Permission: admin.

### GET /api/admin/customer_locations?customer_id=<uuid>

Permission: read.

### POST /api/admin/customer_locations

Permission: admin.
Body: `{ customer_id, location_code, plant_name?, gstin?, state_code?, address_line1?, address_line2?, city?, pincode?, is_default? }`.
If `is_default`, clears other defaults for that customer first.
Effects: upsert on (tenant_id, customer_id, location_code). Audit `customer_location_upsert`.

### DELETE /api/admin/customer_locations?id=<uuid>

Permission: admin.

### GET /api/admin/equipment?customer_id=&gun_no=

Permission: read. Returns `{ equipment: [{ ..., installed_parts: [...] }] }`.

### POST /api/admin/equipment

Permission: admin.
Body: `{ customer_id, customer_location_id?, plant_name?, line_name?, zone_name?, station_name?, robot_make?, robot_no?, gun_no?, gun_type?, qty?, timer_model?, atd_model?, parent_id?, notes?, installed_parts?: [{part_no, description?, installed_qty?, is_critical?, is_emergency_only?, recommended_qty_90d?, recommended_qty_180d?, recommended_qty_365d?, last_replaced_at?, notes?}], id? }`.
If `id`, updates; else inserts. Replaces all installed_parts. Audit `equipment_upsert`.

### DELETE /api/admin/equipment?id=<uuid>

Permission: admin.

### GET /api/admin/lost_reasons

Permission: read. Includes global rows (tenant_id null) plus tenant rows.

### POST /api/admin/lost_reasons

Permission: admin. Body: `{ code, label, category?, active? }`. Audit `lost_reason_upsert`.

### DELETE /api/admin/lost_reasons?id=<uuid>

Permission: admin.

### GET /api/admin/quote_approvals?type=thresholds|approvals

Permission: read. Returns `{ thresholds: [...] }` or `{ approvals: [...] }`.

### POST /api/admin/quote_approvals?type=thresholds

Permission: admin.
Body: `{ approver_role, min_amount_inr?, max_amount_inr?, required_for_modes?: string[], margin_below_pct?, active?, id? }`.

### POST /api/admin/quote_approvals?type=approvals

Permission: write.
Body to create: `{ order_id, approver_role, status?, comments? }`.
Body to decide: `{ id, status: PENDING|APPROVED|REJECTED|SKIPPED, comments? }`. Sets `approver_user` and `decided_at`. Audit `approval_decision`.

### DELETE /api/admin/quote_approvals?type=thresholds&id=<uuid>

Permission: admin.

## copilot (safe actions)

The copilot can take **safe, human-confirmed** actions (PR2). Write-
capable chat/MCP tools never execute on first call: they create a
proposal (preview + single-use `confirm_token`) via `action_proposals`,
and a human confirms to execute.

Write tools (in `_lib/erp-chat-tools.js`): `create_lead` (scope
`write.leads`) and `draft_and_send_comms` (scope `write.comms`). Each
returns `{ proposed: true, preview, confirm_token, expires_at }` and
performs no business write. Internal chat may propose under `read`; MCP
tokens must hold the matching `write.*` scope (default-deny - new tokens
are issued read-only unless write scopes are explicitly requested).

### POST /api/copilot/confirm

Permission: approve. Body `{ confirm_token, cancel? }`. Atomically
consumes the proposal (must match tenant + the proposing user, be
unexpired and unconsumed), then executes the bound action and audits it.
Returns `{ ok, action, result }`. Rejects replays (`409
ALREADY_CONSUMED`), expired (`410 EXPIRED`), wrong user (`403
WRONG_USER`), wrong tenant / unknown (`404 NOT_FOUND`). `cancel: true`
discards a pending proposal.

### GET /api/copilot/proposals

Permission: read. Lists the tenant's pending (proposed, unexpired)
proposals with preview + confirm_token for a Confirm/Cancel UI.

## bom (BOM ingestion)

Generalized BOM ingestion (Phase 1). See `docs/BOM_INGESTION_DESIGN.md`.
The legacy flat `/api/bom` (parent/child edge upsert) is unchanged; these
are additive.

### POST /api/bom/import

Permission: write. Body: `{ asset: { asset_code, name?, asset_type?,
customer_id?, source_format?, revision?, drawing_no?, source_country?,
metadata? }, lines: [{ part_no, part_name?, supplier_part_no?,
supplier_id?, material?, size?, qty?, uom?, level?, seq_no?, side?,
std_category?, is_spare?, remarks?, raw? }], project_id?, file_name? }`.
Rows are parsed + column-mapped client-side. Effects: upserts `bom_assets`
(by `tenant_id, asset_code, revision`) tracking uploader; replaces
`bom_lines`; creates `item_master` rows for every part (fills gaps, never
clobbers operator-set fields); derives `bill_of_materials` edges from the
level hierarchy (replaces this asset's root edges, upserts sub-edges
additively); optional project link; writes a `bom_import_events` row;
audits `bom_import`. Returns `{ ok, asset_id, lines, derived: {
items_upserted, edges_upserted }, diff: { added, removed, changed,
unchanged } }`.

### GET /api/bom/assets[?id=<uuid>][&q=<term>]

Permission: read. Without `id`: list assets (optional `q` filter on
asset_code/name). With `id`: `{ asset, lines (seq order), projects
(project + customer where-used), history (recent bom_import_events) }`.

### POST | DELETE /api/bom/asset_projects

Permission: write. POST `{ asset_id, project_id, qty?, notes? }` links an
asset to a project; DELETE `?asset_id=&project_id=` unlinks. Audited.

### GET | PUT | DELETE /api/bom/source_formats

Tenant-configurable BOM source-format registry (Phase 2). GET (read)
returns the effective formats (built-in obara india/korea/china/japan +
generic_flat, merged with tenant rows; tenant wins by key). PUT/POST
(admin) upserts a tenant format `{ key, label?, source_country?,
column_map?, detect?, quirks?, enabled? }`. DELETE (admin) `?key=` removes
a tenant format (reverts to the built-in if the key shadowed one).

### POST /api/bom/parse

Permission: read. Body `{ rows: <2D array>, file_name?, source_format? }`.
Runs the detect + column-map + normalize engine over a client-parsed
sheet using the tenant's effective format registry; returns `{
source_format, header_index, columns, asset: { asset_code, name,
source_country, customer_hint, metadata }, lines: [...] }` ready to feed
`/api/bom/import`. Non-mutating. `source_format` forces a specific
profile instead of auto-detecting.

## sales

### GET /api/sales/leads?status=&account_id=

Permission: read.

### POST /api/sales/leads

Permission: write.
Body: `{ company_name (req), category?, lead_source?, reliability_score?, account_id?, contact_name?, contact_email?, contact_phone?, designation?, product_interest?, lead_type?, customer_segment?, region?, budget_estimate?, timeline?, decision_maker?, notes? }`.
Audit `lead_create`.

### PATCH /api/sales/leads

Permission: write. Body: `{ id, ...allowed }`.
With `convert_to_opportunity: true` plus `account_id`, `company_name`, `opportunity_name?`: creates an opportunity, sets `status=CONVERTED`, links via `converted_opportunity_id`.

### DELETE /api/sales/leads?id=<uuid>

Permission: admin.

### GET /api/sales/opportunities?stage=&customer_id=&close_from=&close_to=

Permission: read.

### POST /api/sales/opportunities

Permission: write.
Body: `{ opportunity_name, customer_id, customer_location_id?, stage?, order_mode?, amount_inr?, amount_currency?, amount_native?, fx_rate_used?, close_date?, probability?, product_summary?, related_lead_id? }`. Audit `opp_create`.

### PATCH /api/sales/opportunities

Permission: write. Audit `opp_stage_change` if stage changed; else `opp_update`.

### DELETE /api/sales/opportunities?id=<uuid>

Permission: admin.

### GET /api/sales/internal_so?type=&status=

Permission: read. Returns `{ internalSos: [{ ..., lines: [...] }] }`.

### POST /api/sales/internal_so

Permission: write.
Body: `{ iso_type: FOC_SUPPLY|WARRANTY_REPLACEMENT|PRODUCT_TRIAL|EXPECTED_PO|INTERNAL_TRANSFER, iso_number, purpose?, requested_person?, requested_date?, customer_id?, ..., lines?: [...] }`.
Audit `iso_create`.

### PATCH /api/sales/internal_so

Permission: write. Setting status=APPROVED stamps `approved_by` and `approved_at`. Audit `iso_update`.

### DELETE /api/sales/internal_so?id=<uuid>

Permission: admin.

### GET /api/sales/projects?phase=&customer_id=

Permission: read. Returns `{ projects: [{ ..., phase_log: [...] }] }`.

### POST /api/sales/projects

Permission: write. Body includes `project_code`, `project_name`, `current_phase?`, expected dates, mandays. Upsert on (tenant_id, project_code). Inserts phase_log entry. Audit `project_create`.

### PATCH /api/sales/projects

Permission: write. Phase change closes the previous phase row (sets `completed_at`) and opens a new one. Audit `project_update`.

### DELETE /api/sales/projects?id=<uuid>

Permission: admin.

### GET /api/sales/shipments?order_id=&status=

Permission: read.

### POST /api/sales/shipments

Permission: write.
Body: `{ order_id?, source_po_id?, internal_so_id?, shipment_number?, mode (SEA|AIR|ROAD|COURIER)?, carrier?, vessel_or_flight?, shipper_invoice_no?, ready_date?, port_of_loading?, port_of_discharge?, vessel_sailing_date?, port_arrival_date?, warehouse_receipt_date?, customer_delivery_date?, pod_received?, pod_document_id?, status?, remarks? }`.
Audit `shipment_create`. Records process event `shipment_created` if `order_id` is set.

### PATCH /api/sales/shipments

Permission: write. Audit `shipment_update`. Records `shipment_delivered` or `pod_received` events on status flips.

### DELETE /api/sales/shipments?id=<uuid>

Permission: admin.

## service

### GET /api/service/visits

Permission: read. Filters: `customer_id`, `status`.

### POST /api/service/visits

Permission: write. Audit `visit_create`.

### PATCH /api/service/visits

Permission: write. Set `checkin: true` to stamp `check_in_at` and flip status; `checkout: true` to stamp `check_out_at`.

### GET /api/service/car_reports

Permission: read.

### POST /api/service/car_reports

Permission: write.
Body: `{ customer_id?, original_po_no?, original_so_no?, part_no?, qty_rejected?, root_cause?, five_why_analysis?, temporary_countermeasure?, permanent_countermeasure?, analysis_date?, status? }`.
Audit `car_create`.

### PATCH /api/service/car_reports

Permission: write. Audit `car_update`.

### GET /api/service/closure_reports

Permission: read.

### POST /api/service/closure_reports

Permission: write.
Body: `{ car_report_id?, customer_id?, issue_date?, equipment_part_no?, investigation?, root_cause?, temporary_countermeasure?, permanent_countermeasure?, signed_off? }`.
If `signed_off=true`, sets `closed_at` and updates the linked CAR to `CLOSED`. Audit `closure_create`.

### PATCH /api/service/closure_reports

Permission: write. Audit `closure_update`.

### GET /api/service/amc

Permission: read. Filters: `contract_id`, `customer_id`, `status`, `from`, `to`.

### POST /api/service/amc

Permission: write.
Bulk seed body: `{ bulk_seed: { contract_id, frequency: MONTHLY|QUARTERLY|BIANNUAL|ANNUAL, start_date, count?, visit_label? } }`.
Single body: `{ contract_id, customer_id, scheduled_date, visit_type?, visit_label?, duration_days?, remarks?, customer_location_id? }`.
Audit `amc_create` or `amc_bulk_seed`.

### PATCH /api/service/amc

Permission: write. With `generate_visit: true`, creates a `service_visits` row and flips status to `VISIT_CREATED`. Audit `amc_update`.

### DELETE /api/service/amc?id=<uuid>

Permission: admin.

### GET /api/service/amc_cron

Permission: optional bearer (`CRON_SECRET`).
Effects: scans every tenant for `SCHEDULED` AMC rows due within 7 days; creates service_visits and flips AMC rows to `VISIT_CREATED`. Audit `amc_visit_auto_created` per tenant.

## tally

### GET /api/tally/masters?type=

Permission: read.

### POST /api/tally/masters

Permission: write. Body: `{ master_type, records: [{name, payload?}], replace? }`. Audit `tally_masters_sync`.

### POST /api/tally/validate

Permission: write. Validates a payload against masters and uom_aliases.

### POST /api/tally/push

Permission: approve.
Body: `{ orderId, payloadHash, salesOrder, voucherNo? }`.
Side effects: posts to `TALLY_BRIDGE_URL` if set; upserts `tally_voucher_records` keyed on (tenant_id, voucher_no, payload_hash); flips the order's `tally_status` and `status`. Audit `tally_push`. Records process event `tally_exported` or `tally_failed`.

### POST /api/tally/reconcile

Two modes selected via `body.mode`:

- `mode: "mark"` (default when `orderId + status` are present, kept for back-compat). Permission: approve. Body: `{ orderId, status, tally_voucher_id? }`. Flips order to RECONCILED / EXPORTED_TO_TALLY / FAILED_TALLY_IMPORT.
- `mode: "drift_check"` (Phase F.6). Permission: write. Body: `{ scope?, scopeValue?, autoFix?, trigger? }`. `scope` is one of `all` | `tenant_recent` (default) | `order`. Walks pushed `tally_voucher_records` for the scope, compares each against `tally_voucher_state`, persists per-voucher findings (`total_mismatch`, `line_count_mismatch`, `voucher_cancelled_in_tally`, `voucher_altered_in_tally`, `missing_in_tally`, `gstin_mismatch`, etc.), optionally auto-fixes (`cancelled` -> `order_failed`, `missing` -> `re_pushed`), and updates `last_reconciled_at` / `last_drift_at` / `drift_summary` rollups. Audit `tally_drift_detected` / `tally_recon_run`. Records process event `tally_drift_detected` / `tally_recon_run`. Returns `{ run_id, status, vouchers_considered, vouchers_drifted, findings_persisted, auto_fixes_applied, findings }`.

### GET /api/tally/reconcile

Permission: read. Read modes:

- `?run_id=<uuid>` -> `{ run, findings }`.
- `?order_id=<uuid>` -> `{ voucher_record, findings }` (latest findings for the order, plus rollup state on `tally_voucher_records`).
- `?scope=runs&limit=N` -> `{ runs }` (recent reconciliation runs, default 50).
- `?scope=findings&limit=N` -> `{ findings }` (open / unresolved findings).
- (no query) -> `{ latest_run }`.

### PATCH /api/tally/reconcile?finding_id=<uuid>

Permission: approve. Marks a finding resolved (`resolved_at`, `resolved_by`). Audit `tally_drift_resolved`.

### POST /api/tally/amend

Permission: write. Body: `{ parentOrderId, revisedSalesOrder }`. Diffs against the original SO via `lineKey`, classifies amendment type (qty/price/date/line_added/line_removed/mixed), persists `order_amendments`, returns Tally amendment XML with `ACTION="Alter"`.

## source_pos

### GET /api/source_pos?status=&order_id=&limit=

Permission: read. `status` may be comma-separated.

### GET /api/source_pos/[id]

Permission: read. Returns `{ sourcePo, events }`.

### PATCH /api/source_pos/[id]

Permission: write. Body: `{ status?, acknowledged_price?, acknowledged_eta?, payload?, ack_payload?, reason? }`. Audit `source_po_update`. Records process event when status changes.

### POST /api/source_pos/ack

Permission: write.
Body: `{ sourcePoId, ack: { confirmedPrice?, confirmedEta?, supplierRef?, raw? } }`.
Effects: computes `priceVariancePct` and `etaVarianceDays`. Updates source PO status (PRICE_CHANGED if >1%, DELAYED if eta off >7d, else SUPPLIER_ACK). Updates `supplier_scorecards` running averages.

### GET /api/source_pos/scorecard?supplier=&country=

Permission: read.

## cost

### GET /api/cost/breakdown?customer_id=&since=

Permission: read. Computes USD spend, success counts, fields extracted, by-month and by-customer rollups.

### POST /api/cost/simulator

Permission: read.
Body: `{ tokenEstimate: { totalInput, call2Output }, customerId?, usdToInr? }`.
Returns scenarios: full_sonnet, haiku_pf_sonnet_gen, template_dry_run, cached_duplicate, opus_complex.

### GET /api/cost/margin_history?customer_id=

Permission: read. Returns median/low/high margin pct from past orders' price comp blocks.

## spare_matrix

### POST /api/spare_matrix/recommend

Permission: write. Body: `{ customer_id?, top_n? }`. Computes criticality_score = usageScore (40) + bomScore (20) + recencyScore (20) + leadScore (20). Upserts `spare_recommendations`.

### POST /api/spare_matrix/kit

Permission: read. Body: `{ customer_id, gun_models?: [{model, qty}], target_months? }`. Returns kit list.

### GET /api/spare_matrix/opportunities?customer_id=

Permission: read. Parts not yet purchased by the customer ranked by criticality.

### GET /api/spare_matrix/obsolete?months=

Permission: read. Default 18 months. Parts with no SO line in the window.

## documents

### POST /api/documents/upload

Permission: write.
Body: `{ filename, mime_type?, size_bytes?, sha256?, classification?, metadata? }`.
Returns `{ documentId, uploadUrl, token, path }`. Caller PUTs the file to `uploadUrl`.

### GET /api/documents/[id]

Permission: read. Returns the document row plus a 10-minute signed `downloadUrl`.

### DELETE /api/documents/[id]

Permission: admin. Removes both the storage object and the DB row.

### POST /api/documents/scan

Permission: write.
Body: `{ documentId, maxFileBytes?, maxFileCount?, allowedExtensions? }`.
Effects: deterministic guards (size/count/nesting/exec/macro/zip-bomb) plus optional ClamAV via `CLAMAV_URL`. Persists `zip_scans`. Audit `document_scan`.

### POST /api/documents/ocr

Permission: write.
Body: `{ documentId, orderId? }`.
Effects: requires `MISTRAL_API_KEY`. Runs Mistral OCR, persists `evidence` rows with bbox coords and `ocr_runs`. Audit `ocr_run`. Records process event `ocr_completed`.

## orders

### GET /api/orders?status=&po=&customer=&limit=

Permission: read.

### POST /api/orders

Permission: write.
Body: full order shape including corpus columns (`order_mode`, `parent_order_id`, `contract_id`, `customer_location_id`, `forward_fx_rate`, `forward_contract_ref`, `internal_so_type`, `project_phase`, `lost_reason`, `competitor_name`).
Audit `create_order`. Records process event `order_created`.

### GET /api/orders/[id]

Permission: read. Returns `{ order, findings, evidence, sourcePos }`.

### PATCH /api/orders/[id]

Permission: write or approve.
Body: any subset of approval inputs plus the corpus columns.
Status transition to APPROVED requires `body.approval` with `payloadHash`. Sets `approval_expires_at` (default 24h, override via `approval.ttlHours`) and `approval_actions` allowlist. Editing `result` or `line_edits` invalidates approval. Audit `approve_order` or `update_order`.

### DELETE /api/orders/[id]

Permission: admin.

### GET /api/orders/schedule_lines?order_id=

Permission: read.

### POST /api/orders/schedule_lines

Permission: write. Bulk via `{ order_id, rows: [{line_index?, part_no?, scheduled_qty, scheduled_date, delivery_location?, remark?, source_document_id?}] }` or single row. Audit `schedule_lines_insert`.

### DELETE /api/orders/schedule_lines?id=<uuid> or ?order_id=<uuid>

Permission: admin. With `order_id`, clears all lines for the order.

## customers

### GET /api/customers

Permission: read. Returns `{ customers, profiles: { customer_id: profile } }`.

### POST /api/customers

Permission: write. Body includes `customer_key`, optional profile. Profile upsert creates a new version row in `customer_format_profiles` with `version` incremented. Audit `upsert_customer_profile`.

### GET /api/customers/profile_versions?customerId=

Permission: read.

### POST /api/customers/profile_versions

Permission: approve. Body `{ profileVersionId }`. Promotes a prior version to current. Audit `profile_rollback`.

## aliases

### GET /api/aliases?customer_id=&customer_part_no=

Permission: read.

### POST /api/aliases

Permission: write. Upsert on (tenant_id, customer_id, customer_part_no). Audit `upsert_alias`.

### DELETE /api/aliases?id=<uuid>

Permission: write.

## anomaly

### POST /api/anomaly/compute

Permission: read. Body `{ customerId, candidate: { grandTotal?, lineItems: [...] } }`. Returns `{ flags, sample }` of robust z-score outliers.

## audit

### GET /api/audit?action=&object_id=&object_type=&limit=

Permission: read.

### POST /api/audit

Permission: write. Free-form record.

## auth

### POST /api/auth/magic_link

No auth required. Body `{ email, redirectTo? }`. Issues Supabase OTP. Logs to `auth_magic_links`.

### POST /api/auth/verify

No auth required. Body `{ access_token }`. Returns `{ user, memberships: [{ tenant_id, role, tenants }] }`.

## bom

### GET /api/bom?parent=&child=

Permission: read.

### POST /api/bom

Permission: write. Single row or `{ rows: [...] }`. Upsert on (tenant_id, parent_part_no, child_part_no).

### DELETE /api/bom?id=<uuid>

Permission: write.

## claude

### GET /api/claude/messages?routing=1&limit=

Permission: read. Returns `{ log: [...] }` from `model_routing_log`.

### POST /api/claude/messages

Permission: write.
Body: `{ messages, system?, purpose?, tier?, model?, max_tokens?, cache_ttl?, minConfidence?, allowFallback?, bypassFirewall?, confidenceHint?, orderId? }`.
Effects: applies redaction patterns + tenant rules, applies prompt firewall to `system`, picks model by tier, calls Anthropic, derives confidence (parses `<confidence>X</confidence>` from output, falls back on `body.confidenceHint` or `stop_reason`), retries with stronger tier if below `minConfidence`. Logs to `model_routing_log`. Audit `anthropic_call`.

## communications

### POST /api/communications/draft

Permission: write. Body `{ orderId?, sourcePoId?, templateCode, variables? }`. Substitutes `{{var}}` placeholders. Inserts to `communications` with status='draft'.

### POST /api/communications/send

Permission: approve. Body `{ id }`. POSTs to `COMMS_PROVIDER_URL` if set. Updates row to `sent` with `sent_at`.

### POST /api/communications/missing_doc

Permission: write. Body `{ orderId }`. Detects missing roles via `order_documents`; drafts `missing_quote`, `missing_price_comp`, `missing_po` as appropriate. Returns `{ missing, drafts, errors }`.

## delivery

### POST /api/delivery/promise

Permission: read. Body `{ customerId?, sourcePos: [{country, supplier?, productCategory?, baseDate?}], requestedDate?, internalLeadDays? }`. Returns predicted ship date, gap days, risk class (green/amber/red), per-source breakdown.

## duplicates

### POST /api/duplicates/search

Permission: read. Body candidate. Returns `{ matches: [...] }` of similar prior orders ranked by score (PO number, customer, total, fingerprint, line overlap).

## einvoice

### GET /api/einvoice?status=&order_id=&customer_id=

Permission: read. Response includes `gstn_configured: boolean`.

### POST /api/einvoice

Permission: write. Body `{ order_id, invoice_number, invoice_date, shipment_id?, seller_gstin?, currency? }`. Composes the GSTN payload from order data; stores DRAFT row.

### PATCH /api/einvoice

Permission: write.
Action `send_to_gstn`: only DRAFT can be sent. If `GSTN_API_URL` unset, parks at `PENDING_GSTN`. If set, calls GSTN, stores IRN/QR/EWB on success, REJECTED with response on failure.
Action `cancel`: only GENERATED can be cancelled, only within 24 hours of `ack_date`. Body must include `cancel_reason` and `cancel_remarks`.
Plain field edit: only DRAFT, allowed fields are `invoice_date`, `seller_gstin`, `shipment_id`, `currency`, `payload`.

### DELETE /api/einvoice?id=<uuid>

Permission: admin. Refuses to delete GENERATED.

## email

### POST /api/email/inbound

No auth (token-gated via `?token=` or `x-obara-inbound-token` header).
Refuses all calls when `EMAIL_INBOUND_TOKEN` is unset.
Tenant comes from `x-obara-tenant` header or falls back to `DEFAULT_TENANT_ID`. Body fields are mapped from common provider shapes (SendGrid, Mailgun, Postmark). Persists attachments to `documents` storage, classifies subject + attachment role, bundles into a recent DRAFT order if the thread matches.

## eval

### GET /api/eval/cases?suite=

Permission: read.

### POST /api/eval/cases

Permission: write. Body `{ suite, case_id, description?, expected, enabled? }`.

### DELETE /api/eval/cases?id=<uuid>

Permission: write.

### POST /api/eval/run

Permission: write. Body `{ suite, cases: [{id, expected, actual}] }`. Validates that every case has both `expected` and `actual` (returns 400 if every case is malformed). Inserts `eval_runs` and `eval_case_results`.

### GET /api/eval/dashboard?suite=

Permission: read. Returns runs (last 50), suiteSummary, fieldStats, trend.

## events

### GET /api/events?case_id=

Permission: read.

### POST /api/events

Permission: write. Records a process event.

## findings

### POST /api/findings

Permission: write. Body `{ order_id, findings: [...] }`.

### PATCH /api/findings

Permission: write. Body `{ id, resolved }`.

## forecast

### GET /api/forecast?dimension=&fresh=

Permission: read. Dimension is one of `overall`, `territory`, `customer_type`, `order_mode`. `fresh=1` forces real-time aggregation; default reads from `forecast_snapshots`.

### POST /api/forecast

Permission: admin. Recomputes all four dimensions and upserts `forecast_snapshots` for today.

## fx

### GET /api/fx/rates?from=&to=&as_of=

Permission: read. Returns the most recent rate at or before `as_of`.

### POST /api/fx/rates

Permission: write. Body `{ from?, to_list?, as_of? }`. Calls `FX_PROVIDER_URL`.

### GET /api/fx/cron

Optional bearer `CRON_SECRET`. Iterates every tenant; refreshes for each. Audit per tenant.

## inventory

### POST /api/inventory/sync

Permission: write. Body `{ records: [{stockItemName, available_qty?, reserved_qty?, reorder_level?, uom?}], replace? }`.

### POST /api/inventory/availability

Permission: read. Body `{ lineItems: [{partNo, qty}] }`. ATP = available - reserved - openSoReserved + inboundFromSourcePos.

### GET /api/inventory/forecast_runs

Permission: read. Two modes:

- `?limit=N` (default 50, max 200) -> `{ runs: [{ id, started_at, finished_at, status, items_count, models_evaluated, wape_summary, notes }] }`. Ordered by `started_at desc`.
- `?id=<uuid>` -> `{ run, forecasts_sample }`. The sample is the first 50 rows of `demand_forecasts` linked by `forecast_run_id` (best-effort; legacy schemas without the column return an empty array).

## opportunities

### GET /api/opportunities/line_items?opportunity_id=<uuid>

Permission: read. Returns `{ line_items }` ordered by `line_index`. Drives the inventory-planning pipeline-demand calculation.

### POST /api/opportunities/line_items

Permission: write. Body `{ opportunity_id, product_family, qty, line_index?, product_category?, part_no?, description?, uom?, expected_unit_price?, expected_currency?, expected_close_date?, win_probability_pct? }`. Validates `qty > 0` and `win_probability_pct` in `0..100`. Auto-assigns `line_index = max + 1` when omitted. Audit `opportunity_line_item_created`.

### PATCH /api/opportunities/line_items?id=<uuid>

Permission: write. Whitelisted fields only: `product_family, product_category, part_no, description, qty, uom, expected_unit_price, expected_currency, expected_close_date, win_probability_pct`. Audit `opportunity_line_item_updated`.

### DELETE /api/opportunities/line_items?id=<uuid>

Permission: write. Audit `opportunity_line_item_deleted`.

## master_data

### GET /api/master_data/graph?customerId=&partNo=&depth=

Permission: read. Returns `{ nodes, edges, summary, depth }`. Edges are deduped by (source -> target :: kind) key.

## sales_history

### GET /api/sales_history/price_band?customer_id=&part_no=

Permission: read. Returns last/median/min/max rates plus full history for the customer-part pair.

## security

### GET /api/security/redact

Permission: read.

### POST /api/security/redact

Permission: admin. Body `{ field_path, pattern, replacement?, enabled?, notes? }`.

### DELETE /api/security/redact?id=<uuid>

Permission: admin.

### POST /api/security/inject_test

Permission: admin. Body `{ catalogue?, cases?, model? }`. Runs adversarial prompts through the firewall, records pass/fail per case to `injection_test_runs`.

## Permission ladder

`requirePermission(ctx, level)` enforces:

- `read`: any role
- `write`: `sales_engineer` and above
- `approve`: `sales_manager`, `approver`, `admin`
- `admin`: `admin` only

The role comes from `tenant_members.role` for the authenticated user, or
`viewer` if `ALLOW_ANONYMOUS_TENANT=true` and no Authorization header.

## auth (security flows)

The Phase 5 security work added several new endpoints under
`/api/auth/`. They follow the same JSON-over-HTTPS shape as the
older auth surface.

### POST /api/auth/signup

Body: `{ email, password, display_name, requested_role?, notes? }`.

`requested_role` ∈ `viewer | sales_engineer | sales_manager |
procurement | finance`. The admin can override on approve.

Two response shapes:

- **First user on a fresh tenant** (status 200): auto-approved as
  admin, returns
  `{ status: "approved", user, session: { access_token, refresh_token, expires_at } }`.
- **Subsequent signups** (status 202): returns
  `{ status: "pending", message, user, requested_role }` with no
  session. Sign-in is blocked until an admin approves.

Failure modes:
- 400 invalid email / weak password / unrecognised role.
- 409 email already exists.
- 403 `SIGNUP_ALLOWED=false`.

Side effects: writes one `admin_notifications` row of kind
`access_request` per approved admin on the target tenant.

### POST /api/auth/password_login

Body: `{ email, password, totp_code? }`.

Three response shapes:

- **Success**: status 200, `{ user, session: { access_token, ... } }`.
- **MFA required**: status 200, `{ mfa_required: true, email }` with
  no session. Resubmit with `totp_code`.
- **Not approved**: status 403, `{ error: { code: "MEMBERSHIP_PENDING" |
  "MEMBERSHIP_DENIED" | "MEMBERSHIP_DEACTIVATED", message, status } }`.
- **Wrong TOTP**: status 401, `{ error: { code: "INVALID_TOTP" } }`.

Audits to `user_security_audit`: `password_login_ok`,
`password_login_fail`, `mfa_challenge_ok`, `mfa_challenge_fail`.

### POST /api/auth/request_reset

Body: `{ email, redirect_to? }`.

Always returns 200. Generates a single-use Supabase recovery link,
emails it via SendGrid (when configured), audits the request.
Per-email rate limit defaults to 5 per hour (`RESET_RATE_LIMIT`).

In dev, when SendGrid is not configured, the response also
includes `dev_action_link` so you can open it manually.

### POST /api/auth/complete_reset

Body: `{ access_token, new_password }`.

`access_token` is the recovery token from the reset URL fragment.
Updates the password via the Supabase admin API, signs out the
recovery session, drops the rate-limit row.

Failure modes:
- 400 weak password.
- 401 `INVALID_TOKEN` (link expired or malformed).
- 500 upstream Supabase update failed.

### POST /api/auth/mfa

Body: `{ action: "enroll" | "verify" | "unenroll", code? }`.

- `enroll`: returns `{ secret, otpauth_uri, expires_at }`. The
  pending secret expires in 10 minutes.
- `verify`: requires a 6-digit `code` matching the pending secret;
  promotes it to active and flips `totp_enrolled` + `require_mfa`.
- `unenroll`: requires a 6-digit `code` matching the active secret;
  clears the secret. Refusing here would let a stolen session
  disable MFA.

Authenticated. Audits `mfa_enrolled`, `mfa_unenrolled`,
`mfa_challenge_fail`.

### GET /api/auth/mfa

Returns `{ totp_enrolled, passkey_enrolled, require_mfa,
last_security_change_at }`.

### POST /api/auth/passkey/register/begin

Body: `{ label? }`. Authenticated.

Returns `{ options, pending_id }`. `options` is a
`PublicKeyCredentialCreationOptions` for `navigator.credentials.create`.

### POST /api/auth/passkey/register/finish

Body: `{ pending_id, response }`. Authenticated.

`response` is the `AuthenticatorAttestationResponse` from the
browser. Verifies attestation, persists the credential, mirrors
`passkey_enrolled` onto `user_security_settings`.

### POST /api/auth/passkey/auth/begin

Body: `{ email }`. **Anonymous**.

Returns `{ options, challenge_id }`. Always returns a challenge
even when the email is unknown to prevent account enumeration.

### POST /api/auth/passkey/auth/finish

Body: `{ email, challenge_id, response }`. **Anonymous**.

Verifies the assertion, bumps the credential counter, runs the
membership-status approval gate, mints a session by generating +
verifying a Supabase magic-link token via the service role.

Returns `{ user, session }` on success.

### GET /api/auth/passkey/list

Returns `{ passkeys: [...] }` for the calling user.

### DELETE /api/auth/passkey/list?id=<uuid>

Removes one passkey. Refreshes `passkey_enrolled` mirror.

## admin/access_requests

### GET /api/admin/access_requests?status=pending|approved|denied|deactivated

Returns `{ requests: [...], counts: { pending, approved, denied,
deactivated } }`. `requests` is the joined view from
`tenant_members_enriched`: each row carries `user_id`, `status`,
`role`, `requested_role`, `request_email`, `request_display_name`,
`request_notes`, `requested_at`, `approved_at/by`, `denied_at/by`,
`denied_reason`, `user_email`, `last_sign_in_at`, `meta_name`.

Admin only.

### POST /api/admin/access_requests

Body: `{ user_id, action: "approve" | "deny" | "modify", role?,
display_name?, email?, reason? }`.

- `approve`: sets `status='approved'`, role from body (defaults to
  `requested_role`), records `approved_by` and `approved_at`,
  resolves the matching `admin_notifications` row.
- `deny`: sets `status='denied'`, records `denied_reason`.
- `modify`: updates editable fields without changing the status;
  display_name and email also propagate to the Supabase auth user.

Admin only.

## admin/notifications

### GET /api/admin/notifications

Returns `{ notifications: [...], unread_count }`. Filters to
`resolved=false` rows on the calling tenant. `unread_count` is
per-user (excludes rows where the caller is in `read_by`).

### POST /api/admin/notifications

Body: `{ id?, action: "mark_read" | "mark_all_read" | "resolve",
note? }`.

Admin only.

## sourcing/network (Phase 5.6)

### GET /api/sourcing/network/listings

Returns `{ listings: [...] }` for the calling tenant.
`?include_inactive=1` to show deactivated rows.

### POST /api/sourcing/network/listings

Body: `{ sku, description?, uom?, available_qty?, lead_time_days?,
currency?, transfer_unit_price?, notes?, active? }`. Upsert by
`(tenant_id, sku)`.

### DELETE /api/sourcing/network/listings?id=<uuid>

Hard delete.

### GET /api/sourcing/network/search?sku=<sku>&qty=<n>&order_id=<uuid>

Returns matched peer listings, anonymised via per-asker hash.
Caller's tenant must have `network_share=true`.

### POST /api/sourcing/network/handoff

Body: `{ query_id, listing_id }`. Drafts a communication to the
listing tenant's `network_contact_email`, marks the query
resolved.

## plm (Phase 5.5)

### POST /api/plm/connect

Body: `{ system: "windchill" | "arena", base_url, display_name?,
username?, password?, api_key? }`.

Validates credentials by calling the system's metadata or `/me`
endpoint. Returns `{ system_id, probed, probe_error }`.

### GET /api/plm/sync

Returns `{ systems, sync_state }` for the calling tenant.

### POST /api/plm/sync

Body: `{ system_id }` for a manual one-off, or no body when called
with `Authorization: Bearer $CRON_SECRET` for the cron mux. Pulls
BOMs and changes.

### GET /api/plm/health

Returns `{ systems, sync_state }` for status panels.

## sage_x3 (Phase 5.4a)

Five endpoints mirroring the existing ERP shape: `connect`,
`sync`, `push`, `retry`, `health`. See the SX.e / Prophet 21
endpoints for the canonical contract; `sage_x3` follows the same
shape with `tenant_settings.sagex3_*` config columns.

## inbound/chat (Phase 5.2)

### GET /api/inbound/chat/configure

Returns `{ configs: [...] }` of channels for the calling tenant.

### POST /api/inbound/chat/configure

Body: `{ channel: "whatsapp" | "slack" | "teams" | "wechat",
display_name?, creds }`. `creds` is a channel-specific bag,
encrypted at rest.

### DELETE /api/inbound/chat/configure?channel=<channel>

Soft-deactivate.

### POST /api/inbound/whatsapp/webhook

Twilio webhook. Verifies `X-Twilio-Signature` against the stored
auth token; rejects mismatches with 403.

### POST /api/inbound/slack/webhook

Slack Events API. Echoes `url_verification` challenges; verifies
`X-Slack-Signature` (v0 scheme, 5-minute replay window).

### POST /api/inbound/teams/webhook

Microsoft Bot Framework activity. Verifies a shared
`X-Anvil-Teams-Secret` header.

## voice (Phase 5.1)

### GET /api/voice/configure

Returns `{ configs: [...] }`.

### POST /api/voice/configure

Body: `{ provider: "vapi" | "retell", display_name?, phone_number,
assistant_id?, api_key, webhook_secret?, voice_persona?,
system_prompt?, handoff_phone_number? }`. Encrypts API key at rest.

### DELETE /api/voice/configure?id=<uuid>

Soft-deactivate.

### POST /api/voice/webhook?provider=vapi|retell

Provider lifecycle webhook. Verifies signature, persists
`voice_calls` rows, enqueues `voice_call_actions` for the agent
runner.

### POST /api/voice/handoff

Body: `{ call_id, to_number? }`. Transfers an in-progress call to
the configured handoff number; marks status=`escalated`.


## Phase 5.4b ERP endpoints

Eight new ERP connectors share the canonical 7-endpoint shape
(connect, sync, push, retry, health, diagnostics, field_map). They
all behave identically at the API level — the ERP-specific
differences (auth, base URL, field maps) are configured per-tenant
via the connect call. (Sage X3, shipped in Phase 5.4a, exposes the
same `diagnostics` + `field_map` pair under `/api/sage_x3/*`.)

For each ERP `<prefix>` in `{ifs, oracle_fusion, ramco, jde, plex,
jobboss, oracle_ebs, proalpha}`:

### `POST /api/<prefix>/connect` — admin

Stores credentials on `tenant_settings` (encrypted via
`ANVIL_SECRETS_KEY` when configured) and runs a probe call to
validate them. Per-ERP request bodies:

- **ifs**: `{ base_url, token_url, client_id, client_secret,
  scope?, company?, projection? }`
- **oracle_fusion**: `{ base_url, token_url, client_id,
  client_secret, scope?, api_version?, business_unit? }`
- **ramco**: `{ base_url, token_url, client_id, client_secret,
  scope?, org_unit?, company? }`
- **jde**: `{ base_url, environment, role, username, password,
  device? }`
- **plex**: `{ base_url, customer_id, api_key, pcn? }`
- **jobboss**: `{ base_url, token, company? }`
- **oracle_ebs**: `{ base_url, username, password,
  responsibility?, org_id? }`
- **proalpha**: `{ base_url, username, password, company? }`

Response: `{ ok, probe_status, probe_error, storage_mode }`.

### `POST /api/<prefix>/sync` — admin or cron

Pulls customers / items / sales_orders into the local mirror
tables `<prefix>_{customers, items, sales_orders}`. Body:

- `entity?` — restrict to one entity (`customer | item |
  sales_order | sales_order_status`).
- `entities?` — array form of `entity`.
- `full?: boolean` — bypass the high-water cursor for a full pull.

Cron-only when called with `Authorization: Bearer $CRON_SECRET`;
fans out to every tenant whose `<prefix>_base_url` is set.

### `POST /api/<prefix>/push` — approve

Body: `{ orderId, dry_run? }`. Translates the Anvil order to the
ERP's sales-order shape and POSTs it. Recoverable failures (5xx /
408 / 429 / network) land in `<prefix>_retry_queue`; permanent
failures (4xx) return 502 immediately.

### `POST /api/<prefix>/retry` — admin or cron

Drains `<prefix>_retry_queue` with exponential backoff
(1m / 5m / 15m / 60m / 4h / 12h). Body: `{ id?, limit? }`. Cron-only
when called with `Authorization: Bearer $CRON_SECRET`.

### `GET /api/<prefix>/health` — read

Returns `{ configured, probe_ok, probe_error, base_url,
connected_at, sync_state[], retry_pending }` for the calling tenant.

### `GET /api/<prefix>/diagnostics` — read (`?drift=1` requires admin)

Probes the live ERP read surfaces (per-connector entities) and
reports connectivity + config completeness. Returns
`{ configured, base_url, probes: [{ entity, ok, status, latency_ms,
rows_returned, error }], summary: { all_ok, total, failed }, ran_at }`,
or `{ configured: false, probes: [], notes }` when the connector is
not configured. Read-only; performs no writes.

With `?drift=1` (permission `admin`) the response also carries a
`drift` block diffing `tenant_settings.<prefix>_field_map` against the
live sales-order schema: `{ available, entity, live_field_count,
findings: [{ finding_kind: "mapped_field_absent", severity, field,
expected: { target }, actual: { present } }] }`. Connectors with no
readable sales-order schema (jde, oracle_ebs) return
`drift.available: false`. Backed by `_lib/connector-drift.js`.

### `GET | PUT /api/<prefix>/field_map` — read (GET) / admin (PUT)

GET returns the tenant's current override:
`{ field_map: { <anvilField>: <erpField> } }` (empty object when
unset). PUT validates and persists the map on
`tenant_settings.<prefix>_field_map` (jsonb) and writes an audit row;
body `{ field_map: {...} }`, max 50 string→string entries. Returns
`{ ok: true, field_map }`. Backed by the shared
`_lib/connector-fieldmap.js` helper.

## ERP credential storage

Encrypted at rest in `tenant_settings` via AES-256-GCM
(`_lib/secrets.js`). Per-ERP column families:

- IFS: `ifs_base_url, ifs_token_url, ifs_scope, ifs_company,
  ifs_projection, ifs_client_id, ifs_client_id_enc,
  ifs_client_secret_enc, ifs_creds_iv, ifs_field_map,
  ifs_connected_at`.
- Oracle Fusion: `oracle_fusion_*` mirroring the IFS shape with
  `api_version` and `business_unit` extras.
- Ramco: `ramco_*` with `org_unit` + `company`.
- JDE: `jde_*` carrying `environment`, `role`, `device` plus the
  Basic-auth username/password as encrypted bytea.
- Plex: `plex_base_url, plex_customer_id, plex_pcn,
  plex_api_key_enc, plex_creds_iv`.
- JobBoss: `jobboss_base_url, jobboss_company,
  jobboss_token_enc, jobboss_creds_iv` plus the SFTP-fallback
  fields `jobboss_sftp_*`.
- Oracle EBS: `oracle_ebs_*` with `responsibility` + `org_id`.
- proALPHA: `proalpha_*` with `company`.

The matching mirror tables are
`<prefix>_{customers, items, sales_orders, sync_state, sync_runs,
retry_queue}` with RLS scoping by `tenant_id`. See migrations
044 → 051 for the per-ERP DDL.

## Phase 5 endpoints (operational hardening)

Audit Phase 5. New surfaces around cron health, prompt-injection
testing, inbound email classification, and anomaly explainability.

### `GET /api/health` — read

Returns the cron heartbeat snapshot. `{ workers: [{ worker,
last_run_at, last_status, last_duration_ms, consecutive_failures,
metadata, stale }] }`. A worker is `stale` when its
`last_run_at` is older than the worker's expected cadence + a
buffer. Used by uptime monitors to alarm on a halted cron.

### `POST /api/security/inject_test` — admin

Audit P5.2. Replaces the in-memory shadow firewall with a real
HTTP call to `/api/claude/messages` so every published catalogue
entry runs through the live Persona-style guard. Body:
`{ subset?: ["override", "exfil", ...], limit? }`. Returns
`{ summary, findings[] }` with each finding's `firewall_decision`,
`bypassed`, and `tools_used` flags. Bypass attempts are logged
to `model_routing_log.firewall_bypassed = true` so the post-hoc
tail catches anything that slips past the live guard.

### Inbound email classifier (Phase 5.3)

Embedded in `/api/inbound/email/parse`: every received row is
classified through Haiku on every parse pass. Schema columns
`classified_intent`, `classification_confidence`,
`classification_model`, `classified_at` populate. Intents:
`rfq | purchase_order | po_revision | quote_accept |
payment_acknowledge | delivery_query | complaint |
support_question | out_of_office | marketing | phishing | other`.
Confidence threshold for actionable routing is 0.55; below that
the parse falls back to the regex `looksLikeRfq()` heuristic.
Phishing / marketing / out_of_office route to `archived` so the
operator's queue stays clean.

### `GET /api/anomaly/explain?finding_id=<uuid>` — read

Audit P5.4. Haiku-tier on-demand explainer for a single finding.
Returns `{ explanation, recommendation }`. Cached on the
finding row (`finding_id` -> Haiku response) for 24h so a
second click is free.

## Phase 6 endpoints (quotes + LLM dunning + reply intake)

### `GET|POST|PATCH|DELETE /api/quotes`

First-class quote object. Lifecycle:
`DRAFT -> PENDING_INTERNAL_APPROVAL -> SENT -> ACCEPTED |
DECLINED | EXPIRED | CONVERTED -> CANCELLED`.

- `GET ?id=<uuid>` returns one quote; without `id` lists.
- `POST` creates a draft (`{ customer_id, line_items, currency,
  validity_days, ... }`).
- `PATCH ?id=<uuid>` edits fields (`{ line_items, ... }`),
  enforces transitions on `{ status }`, or `{ action: "revise" }`
  produces a new version row.
- `DELETE ?id=<uuid>` soft-cancels (status -> CANCELLED).

### `POST /api/quotes/send`

Body `{ id, to?, subject?, body?, share_link? }`. Renders the
quote PDF, issues a portal token (scope `["quotes",
"accept_quote"]`), drafts a `communications` row, and flips the
quote to `SENT`.

### `POST /api/quotes/convert`

Body `{ id }`. ACCEPTED quote -> DRAFT order in one click.
Idempotent: returns the existing order row when the quote
already has one.

### `POST /api/quotes/expire` (cron-only)

Daily sweep that flips lapsed `SENT` quotes whose
`expires_at < now()` to `EXPIRED`. Wired into `/api/cron/daily`.

### `POST /api/portal/accept_quote`

Customer-facing portal endpoint. Body
`{ token, quote_id?, order_id? }`. Accepts the quote without
needing an authenticated session; the portal token's scope
gates which quote is accessible.

### `POST /api/agents/handle_replies` (cron-only)

Audit P6.8. Drains `inbound_emails` rows with
`classified_intent = payment_acknowledge` and pauses the
matching `ar_collect` agent goal for 14 days. Wired into
`/api/cron/tick`.

## Phase 7 endpoints (AI scoring + state machines + commercial docs)

### `GET|POST /api/sales/score_lead`

Audit P7.1. `?id=<uuid>` runs the Haiku lead scorer for one
lead; without id, `POST` drains every lead lacking
`ai_score`. Returns `{ score, band: hot|warm|cool, reasoning,
positive_signals, negative_signals }` and persists to
`leads.ai_score*` columns.

### `GET|POST /api/sales/predict_opportunity`

Audit P7.2. `?id=<uuid>` runs Haiku close-probability for one
opportunity; pulls the customer's historical win-rate as a
feature. Persists to `opportunities.ai_probability*`.

### `GET|POST /api/customers/health_score`

Audit P7.3. `?id=<uuid>` for a single tenant-customer; `POST`
without id drains 50 rows per pass with a 7-day cooldown.
Returns `{ score, band: green|yellow|red, reasoning,
positive_signals, negative_signals }` and persists to
`customers.ai_health_*`.

### `GET|POST|PATCH|DELETE /api/credit_notes`

Audit P7.5. Lifecycle:
`DRAFT -> ISSUED -> ACKNOWLEDGED -> CANCELLED`. Auto-numbering
`CN-YYYYMM-####` for credits, `DN-YYYYMM-####` for debits.
Reasons: `price_correction | short_shipment | tax_correction |
goods_returned | discount_applied | rebate | other`.

### `GET|POST|PATCH|DELETE /api/billing/recurring`

Audit P7.6. CRUD for recurring invoice schedules. Cadence:
`MONTHLY | QUARTERLY | BIANNUAL | ANNUAL`. Body fields:
`cadence, amount, currency, customer_id, contract_id?,
start_date, end_date?, max_invoices?`. PATCH supports
`status: PAUSED|ACTIVE|CANCELLED`.

### `POST /api/billing/recurring_cron` (cron-only)

Drains `recurring_invoice_schedules` where
`status = ACTIVE AND next_invoice_date <= today`. For each row,
allocates an invoice number via `next_invoice_number`, builds an
`invoices` row, advances `next_invoice_date` by cadence,
auto-cancels on `max_invoices` or `end_date`. Wired into
`/api/cron/daily`.

### `GET|POST|PATCH|DELETE /api/eway_bills`

Audit P7.7. NIC e-Way bill lifecycle:
`DRAFT -> PENDING_NIC -> GENERATED -> CANCELLED|EXPIRED` with
`REJECTED` reachable from `PENDING_NIC`. PATCH actions:
`send_to_nic | mark_generated_manually | update_vehicle |
extend_validity | cancel | revert_to_draft`. Validity defaults
to 1 day per 200 km per NIC's regular-vehicle rule. Outbound
NIC call gated by `EWB_API_URL` so the module is usable
pre-go-live for payload composition.

### `POST /api/eway_bills/expire` (cron-only)

Daily sweeper flipping lapsed GENERATED rows to EXPIRED so
internal queries on `status = GENERATED` stay honest.

## Phase 8 endpoints (PAY_LINK + canonicaliser + agents + catalog embeddings)

### Auto-substitution of `[PAY_LINK]` (P8.1)

Embedded in `/api/agents/run`. Every dunning email queues with a
fresh per-invoice portal token (scope `["invoices", "pay"]`,
30-day TTL). The substitution falls back to a "reply for a
link" hint when `PORTAL_BASE_URL` isn't configured.

### Canonicaliser wiring (P8.2)

All 17 ERP `sync.js` files now call `canonicaliseCustomer` after
their staging-table upsert: `netsuite, sap, d365, acumatica,
p21, eclipse, sxe, sage_x3, ifs, oracle_fusion, ramco, jde,
plex, jobboss, oracle_ebs, proalpha, tally`. The helper
deduplicates by `external_ref->>{vendor}_id` first, then GSTIN,
then canonical name. Multi-ERP tenants no longer accumulate one
row per vendor for the same physical customer.

### Agent goal types (P8.3)

Nine new entries in `agents/_handlers/index.js`:
`supplier_ack_followup, delivery_eta_check,
service_visit_schedule, amc_renewal_chase,
credit_review_request, onboarding_followup,
price_increase_announcement, replenishment_suggestion,
obsolete_product_warning`. Each accepts the same
`{ goal, ctx }` contract and returns
`{ thought, action, action_payload }`.

### `GET|POST /api/catalog/embed` (P8.4)

Voyage AI catalog indexer.

- `GET` returns `{ pending_count, batch_size,
  max_batches_per_run }` for the calling tenant.
- `POST` (admin) drains `embedding is null` rows in 64-row
  batches up to 16 batches per call (~1024 items per run).
- Cron-callable with `Authorization: Bearer $CRON_SECRET` to
  fan out across tenants. Wired into `/api/cron/daily`.

### Hybrid catalog search (P8.4)

`/api/catalog/search` now accepts
`?mode=auto|hybrid|lexical|semantic`. `auto` resolves to
`hybrid` when `VOYAGE_API_KEY` is configured. Hybrid runs
lexical (ILIKE + synonyms) + semantic (cosine-distance against
the HNSW index) in parallel and merges, with semantic hits
boosted by 0.05 so a strong semantic match outranks a substring
near-match. `semantic_available` flag on the response lets the
UI surface a "semantic ON" chip.
