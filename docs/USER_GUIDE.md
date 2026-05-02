# User Guide

A modal-by-modal walkthrough of every UI surface. Open the command palette
with `Cmd/Ctrl+K` to reach any of these.

## Sign in

Open **Connect Backend** from the palette. Three tabs:

- **Backend URL**: paste your Supabase URL (or the Vercel deploy URL if
  routing through Vercel). For first-time use, leave the token empty and
  the app falls back to `DEFAULT_TENANT_ID`.
- **Magic Link**: paste your email, click **Send link**. Click the link in
  your inbox; the callback page (`/auth/callback.html`) stores the access
  token in localStorage. Refresh the main app.
- **Dev Token**: paste a Supabase access token directly. For headless test
  rigs.

After sign-in the header shows your email and role (`admin`,
`sales_manager`, etc.). Sign out clears the session.

## SO Agent (order intake)

Tabs: Process, Overview, Sales Order, History, Customers.

### Process tab

1. Drag-drop the customer PO into the PO uploader. Optionally drop a
   matching quote and price-composition file.
2. Pick the **Order Mode**: SPARES, SPARES_ASSEMBLY, PROJECT_FOR,
   PROJECT_HSS, INTERNAL. This drives quote prefix (OIQTLC vs OIQTHS),
   margin defaults, and currency expectations.
3. Fill the **Source Override Note** if you need to force a particular
   source country for a part.
4. The system runs a preflight (Haiku tier) and shows the detected
   customer profile, format-status, and any cached fingerprint match.
5. If the format is `known` and `extractor_ready`, the **Run dry run**
   button uses the local extraction template (no Claude call).
6. Otherwise, **Generate SO** runs the full Sonnet generation.

If a customer profile has `force_llm_fallback` set in the Studio, the
template path is bypassed.

### Overview tab

The order overview shows every panel that can fire on an order:

- **Margin Cockpit**: SO totals vs price comp, margin %, FX impact card,
  margin-history comparison if `cost.marginHistory` has data.
- **Playbook Hints Panel**: customer-specific hints from the profile.
- **Alias Suggestion Panel**: appears when the SO has line items that
  match known customer-part aliases.
- **Why Panel**: explains decisions (mode picker, profile reuse, currency
  handling).
- **Reconciliation Grid**: PO vs Quote vs Price-comp side-by-side. Each
  line has buttons: **Use quote price**, **Use PO price**, **Create
  alias**, **Escalate**.
- **Amendment Diff Panel**: appears after **Detect amendment** is clicked.
- **Anomaly Badges, Issues Panel**: rule findings.
- **Approval Status Banner**: shows whether the approval is still valid.
  Edits to `result` or line items invalidate it.
- **Evidence Coverage**: count of fields with bbox/snippet evidence.
  Click **View evidence** to open the bbox viewer.

Buttons row at the bottom:

- **Communication timeline**, **Export audit pack**, **My queue**,
  **Run server OCR + bboxes**, **Master data graph**, **Detect amendment**,
  **Push to Tally** (only when status=APPROVED).

### Sales Order tab

The actual SO line items table with inline edit. Each line shows:

- Source classification pill (origin: ok / PO-only / unknown).
- HSN, custPartNo, UOM, qty, rate, GST split, total.
- Inline `SoHistoryHint` (last sold price for this customer/part).
- `InventoryStatusPill` (in-stock / partial / source-PO-needed / below-reorder).
- `LostMarginWarning` if quoted under last-known price.
- `RepeatOrderSuggestion` if customer reorders this part regularly.
- **Edit** button opens the `LineItemEditor` modal.

### History tab

All orders this user can see. Filter by status, PO number, customer.
Bulk-select to compare or export.

### Customers tab

Per-customer profile cards. Each shows fingerprint state, learned rules,
last format change. Click **Open Studio** for the deep editor.

## Admin Center

Open from the palette: **Admin Center**. 13 tabs:

1. **Holidays**: add/delete per country and date. The default tenant
   inherits 75+ global rows seeded by 004.
2. **Customer lead times**: per-customer day overrides; falls back to
   defaults from 004 if not set.
3. **Supplier lead times**: per-country (and optional supplier) overrides.
4. **BOM**: parent/child part relationships with qty + UOM.
5. **Inventory**: real-time tally_inventory rows. Edit available, reserved,
   reorder level, UOM.
6. **FX rates**: list last 90 days. **Refresh now** triggers a manual
   pull from `FX_PROVIDER_URL` for any historical date.
7. **Members and roles**: invite by email (sends Supabase magic link),
   change role inline, revoke access.
8. **Customer locations**: multi-GSTIN per customer. Real example: MG
   Motor Halol (24...) plus Haryana (06...).
9. **Item master**: 35 columns from the corpus template. CSV bulk import
   available in tab #12.
10. **Contracts (ARC/Blanket/AMC)**: contract headers with line items.
    AMC contracts feed into the AMC Schedule modal.
11. **Equipment hierarchy**: Plant -> Line -> Zone -> Station -> Robot ->
    Gun -> Installed parts. JBM-style importer is in its own modal.
12. **Quote approvals**: threshold rules (role + amount range + mode +
    margin floor) plus pending approval queue. Approve/Reject inline.
13. **CSV import**: pasteable templates for Item Master, BOM, lead times,
    holidays. Click **Insert template** to see the column order.

## Sales Pipeline

Three tabs:

- **Leads**: pre-account inquiries. Convert to opportunity carries the
  account_id and company_name through.
- **Opportunities**: 11-stage pipeline. Stage `CLOSE_LOST` reveals a
  **Loss reason** button that prompts for a code from the taxonomy.
- **Lost reasons**: taxonomy CRUD; tenants can add their own codes on top
  of the 9 seeded global codes.

## Internal Sales Orders

Five tabs, one per type. Each has:

- Auto-numbered ISO number (`FOC-2026-0001`, etc.) prefilled to avoid
  duplicates.
- Type-specific fields: warranty reference (`WARRANTY_REPLACEMENT`),
  expected PO ref (`EXPECTED_PO`), from/to store (`INTERNAL_TRANSFER`).

## Project Tracker

14-phase lifecycle from the corpus tracker. Phase advances log to
`project_phase_log` automatically. Field columns include budgeted
mandays (design, install, travel) and expected key dates (PO release,
design final, ready, shipping ETD, delivery, SOP).

## Shipments and POD

Status flow: PLANNED -> READY -> IN_TRANSIT -> AT_PORT -> CLEARED ->
DELIVERED -> POD_RECEIVED. Each row carries mode, vessel/flight, shipper
invoice, port arrival date, warehouse receipt date. Setting status to
`POD_RECEIVED` flips `pod_received` to true and records a process event.

## Service

Three tabs:

- **Visits**: plan a visit, **Check in** (stamps timestamp), **Check out**.
  Captures observation, possible cause, action taken, follow-up.
- **CAR reports**: Concern Analysis Reports linked to original PO/SO and
  rejected qty. 5-why analysis supported via JSON.
- **Closure reports**: signed-off resolution of a CAR. Marking
  **sign off** flips the linked CAR to `CLOSED`.

## Source PO Procurement

Tabs: Open, Awaiting ack, Live, Scorecards.

- **Awaiting ack** rows have **Record ack** which prompts for confirmed
  price + ETA + qty + notes. Backend computes price variance and ETA
  delta and updates the row's status (PRICE_CHANGED / DELAYED /
  SUPPLIER_ACK).
- **Scorecards** show on-time pct, price-accuracy pct, total POs per
  supplier.

## Spare Matrix Intelligence

Four tabs:

- **Recommend**: pick a customer, click **Regenerate** to recompute
  criticality_score = usage(40) + bom(20) + recency(20) + lead(20).
  Persists to `spare_recommendations`.
- **Kit**: customer + months input; returns target qty per part.
- **Opportunities**: parts the customer has not yet purchased ranked by
  criticality.
- **Obsolete**: parts not in any SO for N months (default 18).

## Eval Dashboard

Four tabs:

- **Summary**: pass rate, last-30-runs sparkline per suite.
- **Field heatmap**: top 20 fields by failure rate.
- **Latest runs**: last 50 runs with id, suite, started_at, status,
  duration.
- **Cases editor**: add/delete cases. **Run** button per case prompts
  for actual JSON and scores against expected via `eval.run`.

## Email Triage

Two-pane: list of DRAFT inbound orders on the left, detail on the right.
Detail row buttons: **Promote to order**, **Request missing doc**. The
missing-doc action drafts emails for missing PO / quote / price comp;
review and **Send** or **Discard**.

## Security Center

Three tabs:

- **Redaction rules**: regex patterns + replacements. Tenant or global
  (admin can edit globals).
- **Injection tests**: **Run all** runs the catalogue of adversarial
  prompts through Claude with the firewall and reports pass/fail per
  case.
- **Routing log**: last 100 rows from `model_routing_log`.

## Cost Analytics Deep

Three tabs:

- **Breakdown**: by-month bar chart (inline SVG), by-customer table,
  cost-per-success and cost-per-field KPIs.
- **Simulator**: pick a scenario (full_sonnet, haiku_pf_sonnet_gen,
  template_dry_run, cached_duplicate, opus_complex) and project savings.
- **Margin history**: per-customer median / low / high margin pct.

## Profile Studio

Open from the palette or from a customer profile card. Four feature
sections:

- **Drift visualization**: side-by-side diff of the current fingerprint
  vs the prior version.
- **Compare new PO to last format**: file picker uploads + OCRs a fresh
  PO and reports overlap percent against the current/prior fingerprints.
- **Force Claude fallback**: toggle that bypasses the template extractor
  for this customer.
- **Run template dry run**: runs the latest golden example through the
  template extractor and shows pass/fail per field.

The **Save as new version** button creates a new
`customer_format_profile_versions` row via the trigger in 003.

## Master Data Graph

Two views:

- **Table view**: hierarchical drilldown of customers -> orders -> source
  POs -> parts -> aliases.
- **Graph view**: Cytoscape force-directed graph with layout selector
  (cose, cose-bilkent, breadthfirst, concentric, grid, circle, dagre,
  klay). Extensions are lazy-loaded on first selection.

## e-Invoice

Compose a draft from an APPROVED order: invoice number, date, seller
GSTIN. **Send to GSTN** flips to PENDING_GSTN; if `GSTN_API_URL` is set,
the call goes out and the row flips to GENERATED with IRN/QR/EWB. **Cancel**
is allowed for 24 hours after `ack_date` per GSTN policy.

## Forecasting

Pick a dimension (overall, customer_type, territory, order_mode) and
toggle **Real-time** to skip the cached snapshot. Buckets show open
count, weighted amount (probability-adjusted), next 30/90 days, and
won/lost counts. **Persist nightly snapshot** writes the rollup to
`forecast_snapshots`.

## AMC Schedule

Bulk-seed a contract: pick AMC contract, frequency
(monthly/quarterly/biannual/annual), start date, count of visits. Each
row in the table has **Generate visit** which creates a `service_visits`
row when invoked. The cron at `/api/service/amc_cron` does this
automatically every day for SCHEDULED rows due in the next 7 days.

## Schedule Lines

Order delivery schedules attached to a customer PO. Paste TSV: `part_no
\t qty \t date \t location \t remark` per row. Each row goes into
`order_schedule_lines`.

## JBM Spare Matrix Importer

Pick a customer, upload an XLSX with the JBM-style structure (Line, Zone,
Station, Robot, Gun, Timer, ATD plus 150+ part columns). Each row
becomes one `equipment_hierarchy` node and the part columns explode into
`equipment_installed_parts` rows.

## Audit Pack export

Bundles the order JSON, audit events, process events, raw documents (PDF,
xlsx attachments), plus a `manifest.json` with SHA-256 of every file.
Export as ZIP or as printable PDF (uses `window.print()` via a hidden
iframe).

## Keyboard shortcuts

- `Cmd/Ctrl+K`: command palette
- `/`: focus search/filter in the current view
- `?`: shortcut list
- `Esc`: close modal or palette

## Integration Report

From the palette: **Show Integration Report**. Lists every wiring check
and reports `ok` or `err`. Use after a deploy to confirm everything is
connected. Errors point to a specific feature (e.g.,
"e-Invoice modal" -> the backend route or modal is missing).

## My Queue

Filter orders to those waiting on the current user's role: sales engineer
sees `BLOCKED` orders, sales manager sees `PENDING_REVIEW`, etc. Clicking
through opens the order overview directly.
