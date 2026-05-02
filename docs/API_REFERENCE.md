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

Permission: approve. Body: `{ orderId, status, tally_voucher_id? }`. Flips order to RECONCILED / EXPORTED_TO_TALLY / FAILED_TALLY_IMPORT.

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
