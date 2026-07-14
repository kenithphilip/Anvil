# Logistics Operations — architecture map & extension design

**Status:** P0 + P1 shipped. P2–P5 designed, not built.
**Owner:** Joel. **Primary rule:** extend the existing platform; do not rebuild. Every phase is additive-only (new tables + `add column if not exists`) and preserves existing APIs, workflows, permissions, and UI patterns.

The manufacturer is an OEM-serving industrial supplier, **not** a logistics company. The goal is operational excellence: no shipment misses a committed date, lead times are watched, bottlenecks are detected automatically, and stakeholders get actionable alerts *before* a delay — with minimal manual follow-up.

---

## 1. Headline finding

Anvil is **not missing logistics primitives — it is missing the connective tissue.** There is a real shipment record, a real freight-bidding chain, a genuinely sophisticated inventory-planning engine, three separate "action" substrates, a cron multiplexer, and a notification fan-out. But they are **loosely-coupled islands**, most monitoring is **inbound-biased** (supplier→us, not us→customer), and the three things this brief centers on — a **configuration-driven rule engine**, a **stateful SLA/escalation model**, and **auto-created tasks** — **do not exist as generic machinery.** This is an *extension-and-wiring* effort, not a rebuild.

---

## 2. The substrate every logistics handler must reuse

| Concern | Reuse | Invariant |
|---|---|---|
| Auth / tenant | `_lib/auth.js` `resolveContext(req)` → `{user, tenantId, role}`; `requirePermission(ctx, read\|write\|approve\|admin)` | Use `ctx.user.id` (**not** `ctx.userId` — 29 live sites store null by copying that bug). RLS is a fail-closed backstop only; isolation depends on every query doing `.eq("tenant_id", ctx.tenantId)`. |
| Audit | `recordAudit(ctx, {action, objectType, objectId, before, after})` → `audit_events` (append-only); `recordEvent` → `processing_events` (per-order timeline, `case_id = order_id`) | Free with the call; a failed audit soft-lands in `audit_failures`. |
| Scheduling | `_lib/cron-mux.js` `runCronGroup` + `recordCronHeartbeat` + `cron_health`; register a job in `src/api/cron/tick.js` (5-min) or `daily.js` | ⚠️ `vercel.json` registers **only** `/api/cron/daily`. Every 5-min monitor rides an **external cron-job.org** trigger — a new monitor silently never runs unless registered there too. |
| Alerts | `_lib/notifications.js` `notifyAdmins` (in-app bell); `communications` outbox (email/WhatsApp/Slack, drained by the `agents/run.js` reaper); `_lib/inventory/notifications.js` `dispatchNotifications` (bell+email+voice with per-severity gating) | The escalation path is the weak link — see §5 P1. |
| Config-driven rules (the only existing example) | `_lib/approval-evaluator.js` loads `quote_approval_thresholds` admin rows → `matchesThreshold` → acts idempotently | This is the reference pattern for the P1 rule engine. |
| UI | `Card / KPI / KPIRow / Banner / Btn / Chip / WSTitle / Icon`, `useFetch`, `tbl` tables, the cockpit pattern in `src/v3-app/screens/sales-ops.tsx`; bridge through `src/client/anvil-client.js` | A "Logistics cockpit" is a copy of the sales-ops cockpit. |

---

## 3. What already exists — the four islands

### A. Shipment & freight (inbound-biased)
- **`shipments`** (mig 006), CRUD via `src/api/sales/shipments.js` ↔ `screens/shipments.tsx`. One flat row per journey: `mode` (SEA/AIR/ROAD/COURIER — **no RAIL**), `carrier` (free text), `port_of_loading/discharge`, `ready_date`, `vessel_sailing_date`, `port_arrival_date`, `warehouse_receipt_date`, `customer_delivery_date`, `pod_received`, `asn_sent_at`, and an 8-state status (PLANNED→…→POD_RECEIVED/EXCEPTION). Serves inbound **and** outbound (FKs `order_id`, `source_po_id`, `internal_so_id`). **No transition guard, no event log** (unlike `source_pos`).
- **Freight bidding** (mig 145): `freight_consolidations` aggregates `procurement_plans` by origin lane + arrival week into an LCL/FCL container-fill estimate (pure engine `_lib/freight-consolidation.js`); `freight_bids` captures carrier quotes with an award flow. Real and wired to `logistics.tsx` — but **inbound-only**, and the award **never creates a `shipments` row** (consolidation status `shipped` is never set).
- **`freight_rates`** (mig 106): per-tenant air/ocean/road/courier rate cards; consumed only client-side in `pricing.ts`.
- **Reference masters** `logistics_ports`, `logistics_carriers`, `inco_terms_taxonomy` (mig 009) and `incoterms_v2` (mig 106) exist; ports/carriers/inco_terms_taxonomy are **design-only, unreferenced**. `orders.incoterm_code` uses `incoterms_v2`.
- **`eway_bills`** (mig 074): India GST e-Way bill (Road/Rail/Air/Ship), FK `shipment_id`. Real persistence; NIC call gated on env. The sole domestic-dispatch document.

### B. Inbound procurement / receiving (open loop)
- **`source_pos`** (mig 001) supplier-PO lifecycle is fully built: draft→sent→ack→ETA_CONFIRMED/DELAYED→RECEIVED/CLOSED, DocAI ack extraction, `source_po_events` audit, supplier scorecards. Columns include `acknowledged_eta` (date), `acknowledged_price`, `ack_received_at`, `eta_variance_days`, `primary_contact_email`, `total_landed_inr`.
- **Open receipt loop:** `source_po_lines.received_qty` is only ever **initialized to 0** (`inventory/plans.js`) and read in the AP 3-way match; **no handler ever posts a receipt.** `ap_goods_receipts` (mig 054, the only "GRN" table) has **zero** application insert path (seed-only).
- **"Customs"** exists only as a **landed-cost pricing line** in `pricing.ts` — no bill-of-entry, no clearance workflow, no duty reconciliation.
- No warehouse inwarding / put-away, no inbound supplier ASN, no over/short/damage receiving.

### C. Inventory planning engine — the crown jewel to build on
`_lib/inventory/*` + `inventory_positions / inventory_exceptions / inventory_allocations / procurement_plans` (mig 085). Forecast-driven safety-stock/ROP with real statistics (inverse-normal z, compound lead-time-demand, gamma quantile, EOQ, optional conformal intervals), three crons, and — critically — an **idempotent, fingerprint-deduped exception detector with a per-tenant bell+email+voice fan-out** (`exceptions-detector.js` + `_lib/inventory/notifications.js`). This is *the* template for any logistics monitor. Its one logistics-relevant rule, *below safety stock*, is genuinely implemented. Gaps: no bin/location, no blocked/QC-hold status, no stock-movement ledger, no work-order link. Gated off by default (`tenant_settings.inventory_planning_enabled`).

### D. The "action" substrates (three, none generic)
- **`agent_goals` / `agent_steps`** (mig 011): polymorphic autonomous follow-ups with `due_at`, `next_run_at`, an hourly cron runner, and a handler registry (`src/api/agents/_handlers/index.js`). Closest thing to task+SLA+owner. `owner_user_id` is an *escalation* target, not a work assignee.
- **`operator_actions`** (mig 150): governed checklist+evidence+reconcile state machine (`_lib/operator-actions.js`). Flag-gated off, **never auto-created, no UI**. `object_type/object_id` is polymorphic; `action_type` is free text; a `driver` seam ('human' now, 'cua' later).
- **`delays/scan.js`**: a real stateless SLA rule detector (5 rule families) — was **unrouted** until P0.

---

## 4. Gap matrix — requested scope vs reality

🟢 present · 🟡 partial · 🔴 absent

| Capability | Status | Reality |
|---|---|---|
| Inventory below safety stock | 🟢 | inventory exceptions-detector |
| Freight consolidation / LCL-FCL bidding | 🟢 | mig 145, inbound-only |
| Supplier-dispatch / ack-overdue detection | 🟢 (post-P0) | `delays/scan` now routed |
| Multi-leg supplier→customer shipment | 🔴 | one flat `shipments` row; no leg/segment entity |
| Transport modes incl. **Rail** | 🟡 | SEA/AIR/ROAD/COURIER only; vocab clashes (SEA vs ocean); Rail only on e-way bills |
| **Committed delivery date + customer OTD** | 🔴 | no order-level promised date; every "OTD" in code = on-time-*payment* |
| Material received-not-inwarded / GRN | 🔴 | open receipt loop (§3B) |
| Customs / bill-of-entry / clearance | 🔴 | only a landed-cost pricing line |
| QC pending / overdue / prioritized inspection | 🔴 | no inspection/NCR/hold tables (only post-shipment CAR reports) |
| Configuration-driven rule engine | 🔴 | rules/thresholds hardcoded in JS; only `quote_approval_thresholds` is configurable |
| Auto-created tasks (inward/QC/release/book/dispatch/docs) | 🔴 | no task-template engine; only quote-send auto-arms an agent goal |
| Assignment / ownership / round-robin | 🔴 | role-based only; no `assigned_to` |
| Stateful SLA (first-response/breach/resolution) | 🔴 | no sla_target/first_response/breach columns anywhere |
| Escalation hierarchy + delivery to a human | 🟡 | `escalate` writes a `processing_events` row only; never emails/bells the owner |
| Dispatch-overdue / delivery-at-risk monitor | 🟡 (post-P0) | `delays/scan` inbound families live; `delivery_eta_check` fixed but not yet armed; no outbound customer-delivery SLA |
| Production / work-order / packing | 🔴 | "MANUFACTURING" is a project-phase label; "traveler" is a PDF |
| Warehouse / bin / lot / batch / serial | 🔴 | positions key on (part, source); daily snapshots, no movement ledger |
| Reverse logistics / RMA · demurrage · cargo insurance · CHA/forwarder master | 🔴 | none modeled |

### Corrections to the initial audit (verified against code)
- `source_pos.acknowledged_eta` **does exist** (`001_init.sql:190`, `date`). The `delays/scan` query is valid — routing it was safe.
- The supplier contact column is **`primary_contact_email`** (mig 006), and the promised date is **`acknowledged_eta`**. `promised_date` / `supplier_contact_email` were never defined — that is why `delivery_eta_check` always no-op'd.
- `source_po_status` has **no `FULFILLED`**; terminals are `RECEIVED / CLOSED / CANCELLED`.

---

## 5. Phased roadmap (backward-compatible)

Each phase is independently shippable and additive-only. P0 is done; the rest are designed and await go-ahead per phase.

### P0 · Revive + fix the monitoring rail — **SHIPPED**
- Registered `/delays/scan` in `router.js` (the 5-rule detector was dead; `delays.tsx` 404'd).
- Fixed `agents/_handlers/delivery_eta_check.js` to read the columns that exist (`acknowledged_eta`, `primary_contact_email`) and the real terminal statuses (`RECEIVED/CLOSED/CANCELLED`). No migration.
- **Not yet armed:** nothing creates a `delivery_eta_check` goal. Arming (e.g. on `source_pos` SUPPLIER_ACK) is P1/P2.
- *Affected:* router, one agent handler, its test. *DB:* none. *Gates:* typecheck, cold-import, dead-handler 0, write-path 0, 34 tests.

### P1 · Logistics Monitor + SLA/escalation spine (the keystone) — **SHIPPED**
The generic machinery every later alert rides on. Migration **162**.
- **DB:** `logistics_monitor_rules` (tenant config: rule_kind, threshold_days, sla_hours, severity, escalate_roles, active) + `logistics_exceptions` (detector output with the SLA clock folded on: sla_target_at / first_response_at / breached_at / resolved_at + status lifecycle + fingerprint dedup) + `tenant_settings.logistics_monitor_enabled` (OFF by default). Both RLS'd.
- **API/libs:** `_lib/logistics/monitor.js` reuses the tested `delays/scan.js` rules with the tenant's configured SLAs, persists idempotent fingerprint-deduped exceptions, opens SLA clocks, ages severity up past 2× SLA, and `markBreaches`. `_lib/logistics/notifications.js` fans high-severity + breached rows to bell + email via the existing rails, recipients from `escalate_roles`. `GET/POST /admin/logistics_monitor_rules`, `GET/PATCH /logistics/exceptions`, `GET /cron/logistics-monitor-tick` (registered in `cron/tick.js` ALWAYS + needs the external cron-job.org entry). Defaults in `DEFAULT_MONITOR_RULES` so an un-configured tenant still works.
- **Escalation:** `agents/run.js` `escalate` now writes the `processing_events` row **and** calls `notifyAdmins(escalate_roles)` — agent escalations reach a human.
- **UI:** admin **Logistics monitor** editor (enable flag + per-kind rule rows) + a **Monitored exceptions** panel on the Delays screen (SLA/breach chips + ack/resolve).
- **Deferred kinds** (schema-ready): `grn_overdue` → P2, `dispatch_overdue`/`delivery_at_risk` → P3, `qc_overdue`/`customs_delay` → P5.

### P2 · GRN-first (close the inbound receipt loop)
Highest downstream unblock in one build.
- **API:** `POST /source_pos/:id/receive` writes `received_qty`/`received_at` per line + populates `ap_goods_receipts`; flips header status to RECEIVED via the existing guard + `source_po_events`.
- **Unblocks:** OTD, material-not-inwarded detection, the AP 3-way match, in-transit→on-hand decrement.
- **DB:** none required (columns exist); optional `grn` view. **Reuse:** DocAI ack pipeline for a delivery-note/BOE PDF.

### P3 · Outbound delivery commitment + customer OTD
The "no shipment misses committed delivery dates" headline.
- **DB:** order-level `committed_date`/`promised_date` (or `order_commitments`); a fulfillment link on `order_schedule_lines` (status + `dispatched_shipment_id`).
- **API/Workflow:** persist `delivery/promise` output; reconcile schedule lines ↔ `shipments`; an outbound "customer-delivery-at-risk" scan (new `delays/scan` rule family); fix the `shipments.tsx` field drift so actual/committed dates can be captured; an OTD cockpit card.

### P4 · Shipment legs + carrier master + ETA-vs-actual
- **DB:** child `shipment_legs` (copy the `source_po_events` append-only pattern) with per-leg carrier/mode/ETA/actual; add `tracking_no`/`bill_of_lading`/`awb`/`container_no`; add RAIL to the mode enum + normalize vocab.
- **API/Workflow:** wire the dormant `logistics_carriers`/`logistics_ports`/incoterm masters as FKs/pickers; ETA-vs-actual variance + a shipment transition guard.

### P5 · QC / inspection module
- Greenfield under `/qc/*`, boilerplate from `service/car_reports.js`. Gated at goods-receipt by `item_master.inspection_required` (mig 107). Inspection status/due/SLA, defect/NCR, QC-hold/disposition; criticality-driven prioritization (breakdown/downtime/critical-spare/VIP/urgent) feeds the P1 task queue.

---

## 6. Module invariants (for every PR here)
1. **Extend, never duplicate** — a new logistics monitor is a detector on the inventory-exceptions rail, not a new engine.
2. `ctx.user.id`, never `ctx.userId`. Always `.eq("tenant_id", ctx.tenantId)` (RLS is decorative for user JWTs).
3. New tables: RLS enable + tenant policy. Write routes: `resolveContext` + `requirePermission` + `recordAudit`.
4. New cron: register in `cron/tick.js`/`daily.js` **and** the external scheduler, with `recordCronHeartbeat`.
5. Migrations are additive + idempotent, numbered `NNN_*.sql`, and applied **manually** (merged ≠ applied).
6. Reuse the design-system primitives + the sales-ops cockpit pattern; no CDN scripts (CSP `script-src 'self'`).
