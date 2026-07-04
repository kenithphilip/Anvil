# v3 Route Contract

The authoritative mapping of every v3 navigation route to the backend table,
API endpoint, and `ObaraBackend.*` client method that drives it. If a column
or field is shown in a v3 screen, it must come from somewhere on this page.

Schema source: 10 SQL migrations in `supabase/migrations/`.
API source: 77 endpoints under `api/`.
Client source: `src/client/obara-client.js`.

## Routes (30) at a glance

| nav_id | screen | backing table(s) | endpoint(s) | client method | gap |
| --- | --- | --- | --- | --- | --- |
| home | HomeEngineer / HomeManager / HomeAdmin | orders, audit_events, fx_rates, eval_runs | `api/orders`, `api/audit`, `api/fx/rates`, `api/eval/dashboard` | orders.list, audit.list, fx.lookup, evalExt.dashboard | none |
| intake | Inbox | documents, ocr_runs, email inbound (rows from `email/inbound`), zip_scans | `api/documents/upload`, `api/documents/ocr`, `api/documents/scan`, `api/email/inbound` | documents.upload/ocr, scan.run, email.inbound | none |
| so | SOList, SOIntake, SOWorkspace | orders, order_documents, order_amendments, validation_findings, source_pos | `api/orders`, `api/orders/[id]`, `api/findings`, `api/tally/push`, `api/tally/amend`, `api/source_pos` | orders.\*, findings.\*, tallyExt.\*, sourcePos.\* | SOWorkspace timeline needs `audit.list?order_id=X` filter, already supported |
| internal | InternalSOs | internal_sales_orders, internal_so_lines | `api/sales/internal_so` | sales.internalSos.\* (verify) | client method needs verification |
| approvals | Approvals | quote_approvals, quote_approval_thresholds, orders | `api/admin/quote_approvals`, `api/orders` (status filter) | admin.quoteApprovals (verify) | endpoint exists, client wrapper may need a thin adapter |
| leads | Leads | leads | `api/sales/leads` | sales.listLeads/createLead/updateLead/deleteLead | none |
| opps | Opportunities | opportunities | `api/sales/opportunities` | sales.listOpportunities/\* | none |
| projects | Projects | projects, project_phase_log, order_schedule_lines | `api/sales/projects`, `api/orders/schedule_lines` | sales.listProjects/\*, scheduleLines.\* | none |
| shipments | Shipments | shipments | `api/sales/shipments` | sales.listShipments/\* | none |
| spo | SourcePOs (list, detail, scorecard) | source_pos, source_po_events, supplier_scorecards | `api/source_pos`, `api/source_pos/[id]`, `api/source_pos/ack`, `api/source_pos/scorecard` | sourcePos.\* | none |
| spares | SparesMatrix, SpareOpportunities, ObsoletePartsScreen | spare_recommendations, obsolete_parts, item_master | `api/spare_matrix/recommend`, `api/spare_matrix/kit`, `api/spare_matrix/opportunities`, `api/spare_matrix/obsolete` | spareMatrix.\* | none |
| svc-visits | ServiceVisits | service_visits, equipment_hierarchy | `api/service/visits` | service.listVisits/\* | none |
| amc | AMCSchedule | amc_schedules | `api/service/amc` | service.amc.\* | none |
| car | CARReports | car_reports, closure_reports | `api/service/car_reports`, `api/service/closure_reports` | service.car/closure | none |
| tally | TallyMasters / TallyPush / TallyReconcile | tally_masters, tally_voucher_records, tally_inventory | `api/tally/masters`, `api/tally/push`, `api/tally/reconcile`, `api/tally/amend`, `api/tally/validate` | tallyExt.\* | none |
| einvoice | EInvoice | einvoices | `api/einvoice` | einvoice.\* | none |
| cost | CostMargin (with simulator) | orders (cost_policy_snapshot column), expense_rate_cards | `api/cost/breakdown`, `api/cost/simulator`, `api/cost/margin_history` | cost.breakdown/simulator/marginHistory | none |
| customers | Customers (list + profile) | customers, customer_locations, customer_format_profiles, customer_format_profile_versions | `api/customers`, `api/customers/profile_versions` | customers.list/upsert, profileVersions.list/rollback | none |
| items | Items + Aliases + Inventory + BOM | item_master, part_aliases, uom_aliases, tally_inventory, bill_of_materials | `api/admin/item_master`, `api/aliases`, `api/admin/inventory`, `api/bom` | admin.items (verify), aliases.\*, admin.inventory (verify), bom.\* | item_master + inventory client wrappers via admin.\*; otherwise direct fetch |
| graph | MasterDataGraph | join across customers, items, orders, source_pos | `api/master_data/graph` | masterData.graph | none |
| forecasts | Forecasts | forecast_snapshots | `api/forecast` | forecast.\* | none |
| evals | EvalSuites | eval_runs, eval_case_results, eval_cases | `api/eval/dashboard`, `api/eval/cases`, `api/eval/run` | evalExt.dashboard/listCases/upsertCase/deleteCase | none |
| studio | ProfileStudio | customer_format_profiles, customer_format_profile_versions | `api/customers/profile_versions` | profileVersions.list/rollback | none |
| anomaly | Findings | validation_findings, audit_events | `api/findings`, `api/anomaly/compute`, `api/audit` | findings.save/resolve, anomaly.compute | none |
| duplicates | Duplicates | orders (payload_hash, doc_fingerprint) | `api/duplicates/search` | duplicates.search | none |
| comms | Communications | communications, audit_events | `api/communications/draft`, `api/communications/send`, `api/communications/missing_doc` | communications.draft/send/missingDoc | comms list endpoint not separate; communications screen uses audit + draft state |
| email | EmailTriage | email_intake_rules + email inbound rows | `api/email/inbound` | email.inbound (verify wrapper) | wrapper exists per client.js |
| security | Security | redaction_rules, injection_test_runs, model_routing_log | `api/security/redact`, `api/security/inject_test`, `api/claude/messages?routing=1` | security.\* | none |
| audit | Audit | audit_events, processing_events | `api/audit`, `api/events` | audit.list/record, events.list/record | none |
| admin | AdminCenter | tenants, tenant_members, holiday_calendar, customer_lead_times, supplier_lead_times, fx_rates, quote_approval_thresholds, lost_reason_taxonomy, expense_rate_cards | `api/admin/members`, `api/admin/holidays`, `api/admin/lead_times`, `api/admin/fx_rates`, `api/admin/quote_approvals`, `api/admin/lost_reasons`, `api/admin/contracts`, `api/admin/customer_locations`, `api/admin/equipment` | admin.\* (10 sub-namespaces) | none |

## Confirmed gaps (all surfaceable)

The following have a backing table and an API endpoint but no thin
`ObaraBackend.*` client wrapper today. We add wrappers in Phase 1 alongside
the v3 shell so every screen has a one-liner to call:

1. `ObaraBackend.admin.items` (currently inline `fetch('/api/admin/item_master')`).
2. `ObaraBackend.admin.inventory` (currently inline).
3. `ObaraBackend.admin.contracts` (already used directly via fetch in
   spare-matrix code).
4. `ObaraBackend.admin.equipment` (used by NRD importer).
5. `ObaraBackend.sales.internalSos` (CRUD wrappers for internal SOs).
6. `ObaraBackend.admin.quoteApprovals` (Approvals screen needs list / decide /
   delegate methods).
7. `ObaraBackend.admin.lostReasons` (Opportunities lost-reason picker).

Adding these is a 30-line change in `obara-client.js`.

## Confirmed: zero schema gaps

Every column referenced by every v3 screen exists in the migration set.
Spot-checks done:

- HomeEngineer queue table: orders.po_number, orders.customer_id, orders.status, orders.created_at — all present in 001 + 006.
- SOWorkspace reconciliation grid: order_documents (linked to documents),
  validation_findings.field_name + severity + suggested_fix, item_master
  alias resolution via part_aliases + uom_aliases — all present.
- Margin cockpit: cost_breakdown computed from orders.cost_policy_snapshot
  jsonb plus expense_rate_cards. Present.
- Why panel: model_routing_log (005) plus orders.api_usage jsonb. Present.
- Source PO scorecard: supplier_scorecards aggregated per source_pos.country.
  Present.
- TallyPush queue: tally_voucher_records.status + orders.payload_hash. Present.
- EInvoice queue: einvoices.status enum (DRAFT / PENDING_GSTN / GENERATED /
  CANCELLED / REJECTED) + irn + qr columns. Present.
- ProfileStudio diff: customer_format_profile_versions.fingerprint vs current
  customer_format_profiles.fingerprint. Present.

## Notes

- All RLS policies confirmed tenant-scoped via macros in 001 / 003 / 005 /
  006 / 008 / 009.
- Every endpoint uses `serviceClient()` from `_lib/supabase.js`, so writes
  bypass user-token RLS but still scope by tenant via explicit `tenant_id`
  filter (verified in code).
- Every endpoint emits an `audit_events` row through `_lib/audit.js`, so
  any v3 surface that displays an audit list will pick up the new actions
  automatically.
