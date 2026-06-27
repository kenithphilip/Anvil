# Project Management module — Design (PARKED, design-only)

Status: **Parked design.** No code. Studies OpenProject as a reference and
proposes an Anvil-native task/PM module with per-function SLA KPIs. Build after
the core sales chain + the SLA engine (issue #184) land.

## 1. What OpenProject is (and the verdict on forking)

- **Stack:** Ruby on Rails backend + Angular SPA frontend + PostgreSQL. A
  monolith (self-hosted or cloud), typically run via Docker/packaged installs.
- **License:** **GPLv3** for the Community Edition; several modules are
  Enterprise (commercial add-on).
- **API:** REST **HAL+JSON** ("HATEOAS") at `/api/v3` (+ OpenAPI spec, SCIM,
  BCF for BIM).
- **Core model — "Work Packages":** a single typed work item (task, bug,
  milestone, feature, …) carrying status, priority, assignee, parent/child
  hierarchy, relations (blocks / precedes / relates), custom fields, watchers,
  and an activity journal. On top of that: workflows (status transitions per
  type × role), **Queries** (saved filters/views), Boards (kanban/agile),
  Gantt timelines, Backlogs (Scrum), time & cost tracking, wiki, meetings,
  notifications, roles/permissions.

**Verdict: do NOT fork or embed OpenProject.** Two hard blockers:
1. **Stack mismatch** — a Rails+Angular monolith can't live inside Anvil's
   Node-serverless + Supabase + React app; it would be a second app to run,
   auth, and host.
2. **GPLv3 copyleft** — linking/!copying its code into Anvil (a proprietary,
   multi-tenant SaaS) would impose GPL obligations on the combined work. Its
   *concepts and data model are ideas* (not copyrightable) and safe to learn
   from; its *code* is not safe to copy.

**Two viable paths:**
- **A. Build native (RECOMMENDED).** Reimplement the *relevant* work-package
  concepts in Anvil's stack, fused with assets Anvil already has. Best
  integration, no GPL exposure, multi-tenant RLS by default.
- **B. Integrate the running app over its HAL API** (separate self-hosted
  service, sync work items via `/api/v3`). Only worth it if Anvil later needs
  OpenProject's *heavy* PM suite (Gantt, time/cost, BIM). Adds an app to
  operate + two-way sync complexity; still avoid copying code. Not recommended
  for the stated need.

## 2. What to borrow (concepts, not code)

- The **single typed "work item"** abstraction (one table, many types) instead
  of a separate table per task kind.
- **Status workflow** per type (open → in_progress → waiting → done …) with
  allowed transitions (Anvil already does this for orders/quotes).
- **Hierarchy + relations** (parent/child, blocks/precedes/relates).
- **Queries** = saved, shareable filtered views ("My open RFQ tasks due this
  week").
- **Watchers + activity journal** for collaboration + audit.
- **Polymorphic link to a source object** (a work item *about* an order /
  quote / RFQ / gun).

## 3. Anvil-native design

The stated need is narrower than full PM: **(a) every user tracks their
pending tasks, and (b) leadership monitors SLA response times per function**
(SO processing, RFQ response, design-approval iterations for guns built
against POs/Quotes). That is a *task model + the SLA engine*, not Gantt/Scrum.

### Reuse map (Anvil already has most of the plumbing)
| Need | Reuse |
|---|---|
| SLA timers, breach nudges, escalation | `agent_goals` + the parked **SLA engine** (`docs/SLA_AND_SUPPORT_ROADMAP.md`, issue #184) |
| Cycle-time / stage history | `processing_events`, `opportunity_stage_events`, `analytics_funnel_daily` |
| Breach detection pattern | `delays/scan` |
| Business-hours targets | admin `holidays` |
| Activity timeline | `audit_events` |
| Projects container | `projects` table + screen |
| Guns / designs | `bom_assets` |
| Auto-create tasks from events (zero data entry) | the `quotes/send.js` lifecycle-hook precedent + the zero-data-entry roadmap |
| Permissions | RBAC matrix |

### Data model (new)
- **`work_items`** — the work-package analog:
  `id, tenant_id, type, title, description, status, priority, assignee_id,
  project_id, parent_id, subject_type, subject_id (order|quote|supplier_rfq|
  bom_asset|customer), context_type/context_id (the PO or Quote a design is
  against), due_at, started_at, completed_at, sla_policy_key, sla_due_at,
  sla_breached, iteration int (design rounds), created_by, timestamps`. RLS by
  tenant.
- **`work_item_relations`** — `(work_item_id, related_id, kind)`.
- **`work_item_events`** — comments + status changes (or lean on `audit_events`
  + a small comments table).
- **Types (extensible):** `task`, `so_processing`, `rfq_response`,
  `design_review`, `approval`, `followup`.
- SLA fields are populated by the **SLA engine** (policies + clocks), so PM and
  the SLA module share one timer mechanism.

### The three KPI flows mapped
1. **Processing sales orders** — on SO intake, auto-create a `so_processing`
   work item (assignee = ops) with SLA start = PO received, stop = SO confirmed.
   KPI: time-to-confirm, attainment %, breaches.
2. **Responding to RFQs** — customer RFQ (inbound) → `rfq_response` (start =
   RFQ classified, stop = quote sent); vendor RFQ (`supplier_rfqs`) → response
   tracking (start = RFQ sent, stop = vendor quote captured). KPI: first-
   response time, win-back rate.
3. **Design approval iterations for guns** — `design_review` work item, subject
   = `bom_asset` (gun), context = the PO or Quote it's built against; each
   rejection bumps `iteration` + reopens, approval completes. KPI: **avg
   iterations to approval**, approval-cycle time, designs stuck > N rounds,
   SLA on each review round.

### UI surfaces
- **My Tasks / "My Day"** — per-user list of open work items assigned to (or
  watched by) me, sorted by SLA due, breach-flagged. Directly answers "track
  pending tasks." (Extends the existing My Day.)
- **Board** — kanban by status, filterable by type/project/assignee
  (OpenProject "board" analog).
- **KPI dashboard** — SLA attainment + cycle time per function (SO / RFQ /
  design), breach trends; feeds the Sales-Ops cockpit.
- **Saved queries** — "my overdue RFQ tasks", "designs > 2 iterations".

### API
`/api/work_items` (list with filters = the "query" idea; create), 
`/api/work_items/[id]` (get/patch/transition), relations + events endpoints.
Mirror Anvil's existing RBAC + audit + RLS conventions.

## 4. Phased plan (each = shippable PR + migration + gates)
- **P0 (dependency):** the SLA engine (issue #184) — PM SLAs ride its clocks.
- **P1:** `work_items` core (table + CRUD/list API + "My Tasks" view) +
  auto-create from SO intake and RFQ events. Delivers pending-task tracking.
- **P2:** `design_review` type + iteration tracking for guns vs PO/Quote
  (subject = bom_asset, context = order/quote) + the design KPI.
- **P3:** board view + relations/hierarchy + saved queries.
- **P4:** KPI dashboard (per-function SLA attainment + cycle time) into the
  Sales-Ops cockpit.

## 5. Recommendation
Build native (Path A). The need is a task model + SLA KPIs, both of which fit
Anvil's stack and reuse machinery that already exists (or is already designed
in the SLA roadmap). Reserve OpenProject-as-a-service (Path B, API-only, never
a code fork) for a future need for its heavy PM suite. Sequence it **after**
the SLA engine, since the KPIs depend on it.

Related: [[backlog-parked-prs]], `docs/SLA_AND_SUPPORT_ROADMAP.md` (issue #184),
`docs/ZERO_DATA_ENTRY_AUDIT.md` (auto-create tasks from events),
the Sales-Ops cockpit (KPI home).
