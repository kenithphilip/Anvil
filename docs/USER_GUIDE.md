# User Guide

Two shells ship side-by-side:

- **Legacy** at `/`. The original 8-tab app (Import, Guns, Search, Usage,
  Spare Matrix, Sales Orders, SO History, Settings). Modal-driven.
- **v3** at `/?v3=1`. The new operator console (sidebar + 30 routes,
  Cmd+K palette, role-based access, dark theme by default). The choice
  pins in localStorage as `obara:v3_pinned`. `/?v3=0` flips back.

Both run against the same backend; data flows through the same
`ObaraBackend.*` client either way.

This guide is split:

- **Part 1: v3 console** (below) explains the v3 IA, every nav route,
  role gates, theme + density.
- **Part 2: Legacy reference** (further down) explains each legacy
  modal, kept while the legacy shell ships. Migrates out in a follow-up.

---

# Part 1: v3 console

## Layout

The v3 shell has three regions:

- **Sidebar** (left, 232px or 56px collapsed). 9 nav sections, 30 routes.
  Sections are filtered by your role (Sales Engineer hides admin and
  security; Viewer reads everything but writes nothing).
- **Header** (top, 44px). Brand mark, breadcrumb, Cmd+K search,
  tenant pill, role pill, thread drawer button, notifications bell.
- **Main** (center). The active workspace.
- **Dock** (bottom, 28px). Live status indicators (DB, Tally bridge, FX
  cron, ClamAV).

A floating preference bar (bottom right of dock) holds the theme toggle,
density toggle, and sidebar collapse.

## Default behavior

- Theme defaults to **dark**. Toggle in the floating bar; choice persists
  in localStorage.
- Density defaults to **normal**. Cycle through compact / normal /
  comfortable.
- Role defaults to **Sales Engineer**. Click the role pill to switch
  (dev only; prod reads role from `tenant_members`).

## Cmd+K palette

`Cmd+K` (Mac) or `Ctrl+K` opens the palette. Type 2+ characters to
search live across orders + customers (debounced 180ms). Without a
query, the palette shows:

1. RBAC-filtered jump-to entries for every nav route the role can reach.
2. Quick actions: create SO, create lead, log service visit, send
   missing-doc nudge, open audit log.

Arrow up/down navigates, Enter activates, Esc closes.

## Thread drawer

Click the "Thread" pill in the header to open the right-side drawer. It
shows the timeline for the currently active order (read from
`#/so?id=X` query). Empty state: "Open a Sales Order to see its thread."

## Routes (30)

### Workflows

- **My Day** (`#/home`). Role-aware home. Engineer sees queue, drafts,
  approval count, and ₹ pushed today; Manager sees approval queue, margin
  cockpit, and pipeline; Admin sees system health, tenants, cron, and
  model routing log.
- **Inbox** (`#/intake`). Documents and emails awaiting classification.
  Drag-and-drop POs, OCR confidence per row, click row to open the OCR
  workspace.
- **Sales Orders** (`#/so`). Tabbed list (All, Mine, Intake, Validate,
  Approval, Tally, Shipped, Blocked, Closed). Click "+ New from PO" to go
  to `#/so?new=1` (intake wizard). Click a row to go to `#/so?id=X` (the
  order workspace, 8 tabs: Reconciliation, Margin cockpit, Why, Evidence,
  Approval, Tally, Shipments, Activity).
- **Internal SOs** (`#/internal`). FOC, warranty, trial, expected PO,
  internal transfer.
- **Approvals** (`#/approvals`). Pending decisions with margin breach
  reasons. Approve/reject inline; only managers, finance, and admins.

### Sales

- **Leads** (`#/leads`). Status board (NEW, CONTACTED, QUALIFIED,
  CONVERTED). Inline create form.
- **Opportunities** (`#/opps`). Horizontal kanban across 11 stages with
  weighted-₹ KPIs.
- **Projects** (`#/projects`). Phase tracker (15 phases).
- **Shipments** (`#/shipments`). 7-tab status board with mode, carrier,
  vessel, ports.

### Procurement

- **Source POs** (`#/spo`). Supplier scorecards + 5-status filter.
  Click row to open ack form (price, ETA, qty, notes).
- **Spares Matrix** (`#/spares`). 4-tab (Recommend, Kit, Opportunities,
  Obsolete) per customer.

### Service

- **Service Visits** (`#/svc-visits`). Scheduled, In progress, Completed.
- **AMC Schedule** (`#/amc`). Active contracts and visits-due-30d.
- **CAR Reports** (`#/car`). Concern Analysis Reports with closure
  reports linked.

### Finance

- **Tally Sync** (`#/tally`). Default view: TallyPush queue. Sub-routes:
  `#/tally?sub=masters` (Tally master sync, 5-tab), `#/tally?sub=reconcile`
  (reconcile push to received voucher).
  - **Reconcile sub-route** has two surfaces:
    - **Drift findings** (Phase F.6). Clicking **Run drift check**
      walks recently pushed vouchers, compares each against the
      Tally-side mirror, and lists `total_mismatch` /
      `line_count_mismatch` / `voucher_cancelled_in_tally` /
      `voucher_altered_in_tally` / `missing_in_tally` /
      `gstin_mismatch` rows with severity chips and a per-row
      **Resolve** button that marks the finding cleared.
    - **Recent reconciliation runs**. Last 20 runs (cron + manual)
      with vouchers considered, drifted, auto-fixes applied, and
      run status. The cron runs every 30 min after `tally/sync`
      mirrors state, so a clean tenant should see steadily
      growing run counts and zero open findings.
  - **SO Workspace -> Tally tab**. Per-order drift surface: shows
    voucher number + `last_drift_at` timestamp, a "Reconcile now"
    button that runs `mode='drift_check'` scoped to the single
    order, and the open findings table with resolve actions.
- **e-Invoice** (`#/einvoice`). 4-tab GSTN queue (Pending, Generated,
  Cancelled, Rejected). 24h cancel countdown on Generated rows.
- **Cost & Margin** (`#/cost`). 3-tab: cost breakdown, simulator,
  margin history per customer.

### Data

- **Customers** (`#/customers`). Master with live search.
- **Item Master** (`#/items`). 4-tab (Items, Aliases, Inventory, BOM).
- **Master Data Graph** (`#/graph`). Connection stats. Full graph view
  is a follow-up.
- **Forecasts** (`#/forecasts`). 3 groupings (territory, customer type,
  order mode).

### Quality

- **Eval Suites** (`#/evals`). Pass rate, recent runs, field heatmap.
- **Profile Studio** (`#/studio`). Customer format profile history with
  rollback.
- **Anomaly** (`#/anomaly`). Validation findings, severity-coloured.
- **Duplicates** (`#/duplicates`). Candidate pairs from `payload_hash`
  and `doc_fingerprint` similarity.

### Comms & Security

- **Communications** (`#/comms`). Template-driven outbound.
- **Email Triage** (`#/email`). Two-pane: inbound list + detail with
  promote, attach, missing-doc actions.
- **Security** (`#/security`). Admin-only. Redaction rules, injection
  test history, model routing log.

### Admin

- **Audit** (`#/audit`). Full audit-event browser with filter bar plus
  CSV/JSON export.
- **Admin Center** (`#/admin`). Admin-only. 7-tab: Members, Settings,
  Holidays, Lead times, FX rates, Approval thresholds, Diagnostics.

## Roles + access

See [docs/RBAC.md](RBAC.md). Quick mental model:

- **Sales Engineer**: intake to draft to validate. Cannot approve.
- **Sales Manager**: approves up to delegate cap. Sees team queues.
- **Procurement**: source POs, items, supplier scorecards.
- **Finance**: Tally, e-invoice, cost. Approves above-cap orders.
- **Admin**: full tenant access including security and members.
- **Operator**: internal SOs and service flows.
- **Viewer**: read-only across the tenant.

The sidebar hides routes the role cannot read. Buttons disable when the
role cannot perform the action (e.g. "Push to Tally" greys for engineers).

---

# Part 2: Legacy reference

A modal-by-modal walkthrough of the legacy UI surface (kept while both
shells ship). Open the command palette with `Cmd/Ctrl+K` to reach any of
these.

## Sign up and sign in (v3 app)

The v3 app shows a Landing page when you visit while signed-out.
You'll see marketing copy on the left and a sign-in / sign-up
card on the right. The card has three tabs:

### Sign up (new user)

Fill in your full name, work email, password (10 chars minimum),
and the role you're requesting (sales engineer, sales manager,
procurement, finance, viewer). Add a short note if you want the
admin reviewing your request to know why you need access (for
example: "new hire on the inside-sales team, manager: Priya").

When you submit:

- The very first user on a fresh tenant is auto-approved as admin
  and signed in immediately.
- Everyone else lands in pending state. The page replaces the
  form with a "Pending admin approval" panel. Close the tab; an
  admin will review your request, possibly adjust the role you
  requested, and approve or deny it. You'll get an email when
  the decision is made (or you can just try signing in again
  later).

You **cannot** sign in until the admin approves you. Trying earlier
will surface a "your account is pending admin approval" message.

### Sign in (existing user)

Type your email and password and click **Sign in**.

If your account has two-factor authentication enabled, the form
switches to a 6-digit-code input after the password is accepted.
Open Authy / Google Authenticator / 1Password and type the
current code. Codes refresh every 30 seconds; the server accepts
the current and adjacent steps.

If the admin denied your access request, you'll see the reason
they wrote (if any) instead of a generic error.

### Sign in with passkey

Click **Sign in with passkey** instead of typing a password.
Your browser prompts for TouchID / FaceID / Windows Hello / a
hardware security key. If the passkey is registered to your
account, you're signed in immediately (no password, no TOTP).

Passkeys work only on the same origin where they were
registered: a passkey created at `app.example.com` won't work at
`staging.example.com`.

### Magic link

Pick the **Magic link** tab, type your email, click **Send
magic link**. The email contains a one-time URL that signs you
in for 24 hours.

### Forgot password

Click **Forgot password?** under the sign-in form. Type your
email; we'll send you a single-use reset link that expires in
one hour. Open the email, click the link, set a new password
(10 chars minimum), confirm it. After saving, sign in with the
new password.

The link is single-use: clicking it once and starting the form
makes a second click invalid. If the link expired, request
another from the sign-in page.

We rate-limit reset requests to 5 per email per hour. If you've
hit the limit you'll still get a generic "if an account exists,
an email has been sent" response, but no email actually goes
out. Wait an hour or contact your admin.

### Set up two-factor authentication (recommended)

Once signed in, open **Admin Center → Security**. Click **Set up
two-factor**. A modal shows a QR code; scan it with your
authenticator app, then type the 6-digit code it generates.
Click **Verify and enable**. From the next sign-in onward you'll
need both your password and the current code.

To disable, go back to the same panel and type the current code
in **Disable two-factor**. We require the current code so a
stolen session can't disable MFA without your authenticator.

### Register a passkey

In **Admin Center → Security → Passkeys**, type a label (e.g.
"MacBook Pro"), click **Register passkey**. Your browser will
prompt for biometrics or a hardware key. Once registered, the
passkey shows up in the list with a last-used age. You can
register multiple passkeys (one per device); remove any
individual passkey from the same panel.

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
    Gun -> Installed parts. NRD-style importer is in its own modal.
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

### Admin -> DocAI cost panel (usage-trend chart)

Lives on the Admin screen alongside the cost-guard recommendations.
Three blocks:

- **Usage trend**. Inline SVG stacked-area chart of per-day per-adapter
  call volume (or cost when toggled), spanning the configured window
  (default 7 days, configurable up to 90). The dashed rust line shows
  any per-adapter daily cap. CSV download exports the same dense
  matrix the chart renders.
- **Burn + forecast**. Per-adapter `today_calls / window-median` ratio
  flags > 2x as a warning chip. The forecast column projects
  `hours_to_cap` from the morning's burn rate and badges adapters
  that will hit their cap before midnight UTC.
- **Anomalies**. Days where calls hit `>= 2x` median **and** `>= 5`
  calls. The 5-call floor suppresses noise on low-volume tenants so
  the panel doesn't cry wolf during PoC weeks.

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

## Inventory Planning

`#/inventory-planning` is the procurement workbench. KPI row +
multi-tab body covering Positions / Plans / Reorder / Allocations /
Suppliers / Calibration / Forecast history.

- **Staleness banner**. When the most recent positions snapshot is
  older than 60 minutes, a warn banner appears above the KPIs with
  the age and a refresh nudge.
- **Positions** lists `inventory_positions` with available, reserved,
  on-order, ATP, days-of-cover.
- **Plans / Reorder** drive `inventory_reorder_plans`. The **Replan
  now** button opens a confirmation modal that previews
  `items_at_risk`, `exceptions`, and `WAPE` from the latest forecast
  run before triggering the replan.
- **Allocations** -> see `#/inventory-allocations`. The **New
  allocation** button (header) opens a modal to create a reservation
  with part, qty, required-by date, optional project / order /
  opportunity link.
- **Suppliers** -> see `#/inventory-suppliers`. The **New supplier**
  button opens a modal for code / name / country / currency /
  lead-time / contact email upsert.
- **Calibration** tab shows the win-probability calibration table
  (stage-by-stage probability vs realised win rate) sourced from
  `/api/inventory/calibration`.
- **Forecast history** tab lists `forecast_runs` with start / finish /
  status / items-count / models-evaluated / WAPE summary / notes.
  Sourced from `GET /api/inventory/forecast_runs`.

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

## NRD Spare Matrix Importer

Pick a customer, upload an XLSX with the NRD-style structure (Line, Zone,
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

## Lead scoring (Phase 7.1)

Open `Sales -> Leads`. Every row carries a chip in the new
**Score** column:

- `hot 80` (green): the AI scorer rates the lead 75 or higher.
  Recent activity, clear budget, fast reply cadence.
- `warm 50` (amber): one or two warning signals (slow response,
  vague requirements). Worth a follow-up.
- `cool 20` (info): low-confidence lead. Park or re-qualify.
- `score?` (faded): the lead was created before the scorer ran
  or hasn't been re-scored in 7+ days.

Click a row to open the detail card. The header has a
**Score lead / Re-score** button that calls
`/api/sales/score_lead` for that one row and updates the chip
inline.

The **Sort by score** toggle in the title bar pulls the highest
score to the top with unsourced leads at the bottom.

## Opportunity probability (Phase 7.2)

Open `Sales -> Opportunities`. Each kanban card shows an extra
chip after the stage chip:

- `p82` (green): AI close-probability is 70% or higher.
- `p55` (amber): mid-funnel signal.
- `p25` (info): low likelihood of close.
- `p?` (faded): not predicted yet.

Click a card to open the detail. The header has
**Predict probability / Re-predict** which calls
`/api/sales/predict_opportunity`.

The **Sort by probability** toggle re-sorts each kanban column
desc by AI probability so the most-likely-to-close opps float
to the top of every stage.

## Customer health (Phase 7.3)

Open `Master -> Customers`. The new **Health** column shows
each customer's latest band:

- `green 84`: paying on time, recent activity, no anomalies.
- `yellow 56`: one or two warning signals (slow pay, AR aging,
  declining order volume).
- `red 30`: multiple warnings (missed payments, abandoned
  orders, dormant 90+ days).
- `health?`: not scored yet, or the cron hasn't run.

Hovering shows the AI's reasoning summary. Click a row to open
the detail card and use **Score health** in the header to
re-run for that single customer.

## Customer duplicate review (Phase 9.5)

Open `#/customer-duplicates` (or the Quality nav once it's
linked). The screen shows groups of probable-duplicate
customer rows surfaced by three signals:

- **GSTIN match** (green): two rows share the same registered
  GST identifier. High-confidence duplicate.
- **Name match** (amber): canonical-name match (case-
  insensitive, alpha-num only, common suffixes stripped).
- **Vendor-prefix mismatch** (info): customer keys like
  `ns:1234` vs `sap_id:5678` with the same legal name.

For each group:

1. Pick a row with the **Primary** radio (defaults to the
   row with the longest customer_name).
2. Tick **Merge?** for each duplicate to fold into the
   primary.
3. Click **Merge N into primary**. Confirm the destructive
   action.

Every row pointing at the duplicates (orders, invoices,
contacts, communications, audit events) repoints to the
primary; the duplicate rows are deleted. Cannot be undone.

## Anomaly explainer (Phase 5.4)

Open `Quality -> Findings`. Each row in the open / resolved /
suppressed tabs has an **explain** button. Click it to call
`/api/anomaly/explain?finding_id=<id>` and surface the Haiku
explanation inline below the row:

- **Why**: one-sentence English explanation of why the rule
  fired given this row's evidence.
- **Suggested action**: the recommended operator response.

Click **hide** to collapse. The explanation is cached for 24
hours; a re-click surfaces the cached response without paying
the model cost.

## Credit + debit notes (Phase 7.5)

Open `#/credit-notes`. Lifecycle:
`DRAFT -> ISSUED -> ACKNOWLEDGED` with `CANCELLED` reachable
from any non-terminal state.

To draft a new note, click **New credit/debit note**:

1. Pick **kind** (credit or debit) and **reason**.
2. Link to a source `invoice_id` OR `einvoice_id`.
3. Add line items as JSON. The note's totals compute on save.
4. Click **Create draft**.

Per-row buttons: **Issue** (DRAFT -> ISSUED), **Mark ack**
(ISSUED -> ACKNOWLEDGED), **Cancel** (any -> CANCELLED).

Note numbers auto-allocate: `CN-YYYYMM-####` for credits,
`DN-YYYYMM-####` for debits, scoped per tenant.

## Recurring invoices (Phase 7.6)

Open `#/recurring-invoices`. Schedule a recurring billing
cadence per contract:

1. Click **New schedule**.
2. Pick the customer, optional contract, and cadence
   (`MONTHLY | QUARTERLY | BIANNUAL | ANNUAL`).
3. Set the start date and (optionally) end date and max-
   invoices cap.
4. Click **Create schedule**.

The daily cron at `/api/cron/daily` materialises one
`invoices` row per cycle, advances `next_invoice_date` by the
cadence, and auto-cancels on `end_date` / `max_invoices`. The
**Last error** column surfaces stuck rows so an operator can
intervene.

Per-row controls: **Pause / Resume / Cancel**.

## e-Way bills (Phase 7.7)

Open `#/eway-bills`. NIC-issued transport authorisation
lifecycle:
`DRAFT -> PENDING_NIC -> GENERATED -> CANCELLED|EXPIRED` with
`REJECTED` reachable from PENDING_NIC.

To compose a new EWB:

1. Click **New e-way bill**.
2. Link to a source `invoice_id` OR `einvoice_id`.
3. Fill the doc / vehicle / transporter / value sections.
4. Click **Create draft**.

To send to NIC, click **Send to NIC** on a DRAFT row. When
`EWB_API_URL` is unset, the row stays at `PENDING_NIC` and an
operator can mark generated manually with the IRN once the
GSTN portal flow is complete.

Per-row controls: **Vehicle** (update vehicle on a GENERATED
row), **Cancel** (within 24h of generation, requires reason
code 1-4), **Hide / Explain** (on findings).

## Catalog semantic search (Phase 8.4)

The catalog search box (used in BOM import, intake, and the
SO workspace) now accepts free-text queries and returns
semantic + lexical hits side by side. A query like
`"4-pole motor 1.5 kW IE3"` matches a part whose description
is `"Three-phase induction motor 1.5 kW, IE3 efficiency,
4-pole"` even though no individual word overlaps.

Each result row shows a **match** label:

- `direct`: substring match on `part_no` or `description`.
- `synonym`: matched a registered alias / synonym.
- `semantic`: cosine-distance match against the embedding
  index. Only available when `VOYAGE_API_KEY` is configured.

When `VOYAGE_API_KEY` isn't set the semantic path falls back
silently to lexical, so the search box always works.

To populate embeddings for a tenant on first use, run
`POST /api/catalog/embed` (admin) or wait for the daily cron;
the indexer drains rows with `embedding IS NULL` in 64-row
batches up to 16 batches per run.

## PAY_LINK substitution in dunning (Phase 8.1)

Every dunning email queued by `agents/ar_collect` now
substitutes the `[PAY_LINK]` placeholder with a real per-
invoice portal URL. The dunning agent issues a fresh portal
token (scope `["invoices", "pay"]`, 30-day TTL) on each tier
escalation; the customer can pay through `/portal/<token>`
straight from the reminder.

When `PORTAL_BASE_URL` is unset the substitution drops a
"reply to this email and we will send one" fallback so the
customer never sees a literal `[PAY_LINK]` token.
