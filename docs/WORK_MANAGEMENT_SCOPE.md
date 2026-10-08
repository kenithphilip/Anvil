# Work management in Anvil: one thin layer from opportunity to cash

Design document, 2026-10-08. Docs only. Nothing is built.

- **Base.** `origin/main` at `05ba982d`. The audit behind section 2 was read at
  `c54d3e63`. Its key claims were re-verified on `05ba982d`. File references
  are `path:line`. Migration references are `NNN:line`.
- **Related.** `PROJECT_MANAGEMENT_SCOPE.md` (#540),
  `ACCOUNTS_ASSETS_PORTAL_SCOPE.md` (#547), `PRODUCT_CATALOG_SCOPE.md` §9b
  (#542), `SLA_AND_SUPPORT_ROADMAP.md`, `LOGISTICS_OPS_DESIGN.md`,
  `TALLY_INTEGRATION_SCOPE.md`.
- **House rules used here.** Something built but never wired counts as not
  built. Every PR ships its caller. Prefill instead of blank entry. Refuse
  rather than guess. Migrations apply by hand, so merged is not applied.

---

## 0. Summary

1. The owner wants one work layer for opportunities, projects and tasks. It
   must carry a deal from opportunity to invoice and show owners,
   dependencies, blockers and deadlines across sales, design, procurement,
   finance, logistics and service.
2. Anvil already holds most of the facts: opportunities, quotes, orders,
   source POs, shipments, invoices, lead times, holidays and ETA history. It
   has no human task, no dependency, no per-user inbox, and four breaks in the
   opportunity-to-order chain.
3. The design adds one generic `work_items` table with a polymorphic subject
   and ancestry columns, a links table, and an append-only events table. The
   pipeline, the order lifecycle and the project ladder become views over the
   same items.
4. Most items are created and closed by events that Anvil already emits. A
   person types only what Anvil cannot know.
5. The owner's kickoff workbook is replaced by a project record that links to
   the opportunity, the customer master, the item master and the installed
   base. Scope is rows, not columns. Sourcing comes from a versioned rule
   table, not formulas.
6. Five authorisations that commit money before a customer PO become **gates**.
   Each gate records its basis (PO, LOI or risk waiver), the exposure amount,
   the fee terms, the approver (never the requester), the evidence and the
   audit. Whether a gate blocks the action is an owner decision.
7. Dates come from a **schedule engine**. Route templates hold stage durations
   as distributions learned from actuals. Calendars and sailings are data. The
   engine plans forward from the PO and backward from the customer's date,
   shows P50 and P90, float and the critical path, and plans to an assumed PO
   date when the PO is missing. It never shows `#VALUE!`.
8. 28 PRs in six waves. Wave 0 (PRs 1 to 4) fixes the chain and is worth doing
   even if the owner rejects the rest. Migrations 252 to 263.
9. Fifteen owner decisions. The first eight are the ones the owner named.

---

## 1. Goal, scope and non-goals

### 1.1 The goal

One interface inside Anvil where a B2B manufacturer or an enterprise customer
team can see, for any deal:

- what has to happen next, who owns it, and by when;
- what blocks it, and who holds the blocker;
- which money is at risk before the customer's PO arrives;
- whether the customer's date will be met, and by how much (float).

The chain it covers is: opportunity, quote, customer PO, sales order, internal
SO and procurement, shipment, invoice. The teams are sales, design,
procurement, finance, logistics and service.

### 1.2 The shape of the answer

Build a **thin layer**. Three rules define "thin":

1. **Every item is anchored to an Anvil object.** An item has a subject (a
   quote, an order, a source PO, a project) and ancestry (account,
   opportunity, project, order). There is no free-floating to-do list.
2. **Events create and close most items.** "Chase the supplier
   acknowledgement" is created when the source PO is sent and closed when the
   ack is recorded. If no event can close an item, it is not auto-created.
3. **Dates are computed where Anvil can compute them.** A person types a date
   only when it is a commitment or a fact that Anvil cannot see. Every
   computed date states its basis.

### 1.3 In scope

| Area | In this design |
|---|---|
| Work items | Typed items, links, events, watchers, workflows, templates, automation rules, saved views, query language |
| Project kickoff | Project record, account roles, project types, scope lines, configuration specs, sourcing rules |
| Gates | Five money-at-risk gates with basis, exposure, segregation of duties, evidence and audit |
| Schedule | Route templates, learned durations, calendars, sailings, forward and backward passes, P50 and P90, float, critical path, re-planning |
| Collaboration | Role queues, watchers, mentions, per-user notifications, a daily digest, a daily sweep, a deal room |
| Chain repair | The four breaks and the screen bugs the audit found |

### 1.4 Non-goals

- **Not a Jira clone.** No sprints, story points, velocity, epics as planning
  units, releases, time tracking, resource levelling or plugin marketplace.
- **Not a CRM beside Anvil.** No second account, contact or opportunity
  record. The opportunity header item points at the `opportunities` row and
  copies none of its facts.
- **No integration with an external task tool.** `PROJECT_MANAGEMENT_SCOPE.md`
  §0 and `ACCOUNTS_ASSETS_PORTAL_SCOPE.md` §2.1 already decided this.
- **No timesheets.** Phase and stage timestamps are the actuals (#540 §5).
- **Not board-first.** The default view is a list sorted by due date and float
  (#540 §1). A board exists as one layout of a saved view.
- **Not CAD, PDM or MES.** Anvil does not run the design work or the shop
  floor. It records gates, dates, evidence and the hand-offs between teams.
- **No customer-facing view.** The portal keeps showing only a date a person
  committed to (#547 D10). Planned and assumed dates stay internal.

### 1.5 What changes from the project-management scope (#540)

`PROJECT_MANAGEMENT_SCOPE.md` (2026-09-21) said: do not integrate a task
manager; the problem is scheduling through lead times; build a backward pass
first; add a minimal `project_tasks` table; no Gantt first; no generic
work-management platform. The owner's new goal asks for more. This table says
what survives and what changes.

| #540 said | This design | Why |
|---|---|---|
| "A generic work-management platform" is a thing not to build (§5) | Builds a work layer, but anchored and event-driven, with bounded configuration | The owner now asks for one layer across teams. #540's warning survives as the guard rails in section 13 |
| PR 3: `project_tasks`, project only | `work_items` with a polymorphic subject | Most spares deals never have a project. Cross-team work runs through quotes, orders, RFQs and source POs |
| PR 1: backward pass, read-only, no new tables | Kept as the first output of the schedule engine (WM-18) | Same bet. Now per route, with calendars and sailings |
| PR 2: variance from `projects.expected_*` and the phase log | Folded into learning from actuals (WM-19) | Variance and learning read the same actuals |
| PR 5: price the order-at-risk decision | Becomes the gates with exposure (section 6) | The kickoff workbook shows this decision is taken up to five times per project, on checkboxes |
| PR 6: learned phase durations, P50 and P80, with a floor | P50 and P90 for every route stage and design phase, with a sample floor | Same rule: refuse below the floor and label priors as priors |
| No Gantt first | Kept. List first. A read-only timeline after the engine (D8) | A Gantt renders the answer. It is not the answer |
| Kanban is not the primary view | Kept | A board sorts by status. The question is "what will make us late" |
| "Every column that is not specific to lead-time-driven delivery makes this Jira with fewer features" (§5) | Typed core columns. JSONB custom fields only if D7 allows them, with a per-tenant schema and a promotion rule | The owner asked for custom fields. The guards stop them from holding facts Anvil already has |
| Open question 2: where the customer's required date lives | `orders.committed_delivery_date` for an order. A new `projects.customer_required_date` with its source for a project | The backward pass needs one answer per subject |
| Open question 3: per-part lead time | Owner decision D12. Default: infer from source PO ack versus receipt | Unchanged recommendation |
| Open question 5: LD clauses | Still open. Gates record cancellation and manufacturing fee terms, not LD | The kickoff names fees, not LD |

An earlier internal review (not in the repo) said "project management: defer,
or buy a tool". The owner's goal replaces "defer". "Buy" stays open as D1.

---

## 2. What exists today

This section summarises a read-only audit of opportunity, project and task
management made on 2026-10-08 (not committed as a file). Line numbers were
re-checked on `05ba982d` where cited.

### 2.1 Verdict

| Domain | Status | Why |
|---|---|---|
| Opportunity management | Partial | Tables, API, stage history, AI scoring, quote-revision log, pipeline report, touch log and account owner exist. No screen can move a stage or link a quote, and the screen reads fields the API does not return |
| Project management | Built, not wired, so Missing | `projects` has a 15-phase ladder, six milestone dates and man-day budgets (`006:480-505`). Nothing reads them. No phase can advance from the screen. No owner, no link to an order |
| Task management | Missing | No human task object anywhere. The nearest things are machine goals, a follow-up date nothing reads, approval rows that do not gate the order, and an unrouted checklist table |

### 2.2 The chain and where it breaks

| # | Link | How it is stored | Status |
|---|---|---|---|
| 1 | Lead to opportunity | `leads.converted_opportunity_id` (`006:285`) | Partial. A lead made on the screen can never convert: convert needs `account_id`, the screen never sends it on create, and PATCH cannot set it (`sales/leads.js:33-79`) |
| 2 | Opportunity stage moves | `opportunities.stage`, `opportunity_stage_events` (`140:24-40`) | **Break.** No screen moves a stage. `owner_id` is not in the PATCH allowlist (`sales/opportunities.js:113`) |
| 3 | Opportunity to Anvil quote | `quotes.opportunity_id` (`068:48`) | **Break.** No UI writes it (`NewQuoteModal.tsx:104-114`; `spare_matrix/to_quote.js:147` writes null) |
| 3b | Opportunity to uploaded quote | `opportunity_quotes` (`203`) | Built. A separate object from `quotes` |
| 4 | Quote approval | `PENDING_INTERNAL_APPROVAL` and the margin floor (`quotes/index.js:370-385`) | Partial. No approver, no queue entry |
| 5 | Quote follow-up | `agent_goals` armed at send (`quotes/send.js:47-91`) | Partial. The runner is in the unscheduled tick |
| 6 | Quote or PO to sales order | `orders.quote_id` | Partial. Orders have no owner |
| 7 | Sales order back to opportunity | `orders.opportunity_id` (`204`) | **Break.** Only the one-time 204 backfill wrote it. No handler writes it now (verified by grep) |
| 8 | Order approval | `orders.approval` and payload hash (`orders/[id].js:193`); `quote_approvals` | Partial. Two gates that do not talk |
| 9 | Order to project | none | **Break.** No foreign key |
| 10 | Order to internal SO | text only (`006:353-354`) | **Break.** No foreign key. The list screen is always empty (`internal-sos.tsx:56` reads a key that `internal_so.js:34` does not send) |
| 11 | Order to supplier RFQ | `supplier_rfqs.source_order_id` | Built |
| 12 | RFQ award to source PO | none (`supplier_rfq/award.js:45` sets `awarded` only) | **Break.** Award creates nothing |
| 13 | Order to source PO | `source_pos.order_id` | Partial. The ack form always returns 400 (`source-pos.tsx:211` against `source_pos/ack.js:23-26`) |
| 14 | Source PO to shipment | `shipments.source_po_id` (`006:442-470`); ETA log (`212`) | Built |
| 15 | Order to invoice | `invoices.order_id`, `due_date` | Built |

Owners exist on the opportunity (not editable), the account (#551), the agent
goal and the service visit. A blocker exists only on the order
(`ORDER_HAS_UNRESOLVED_BLOCKER`, `orders/[id].js:193`). No link carries an owner
from one stage to the next.

### 2.3 Cross-cutting capabilities

| Capability | Status | Evidence |
|---|---|---|
| Dependencies | Missing | No dependency column or table in any migration |
| Blockers | Partial | Orders only (`rule_findings`, `blocker_summary`) |
| Deadlines | Partial | Dates on almost every object. Clocks only in `delays/scan.js` (on demand) and `logistics_exceptions.sla_target_at` (monitor off by default) |
| Owners and teams | Partial | Teams are roles. Roles are `sales_engineer`, `sales_manager`, `procurement`, `finance`, `admin`, `operator`, `viewer`, `design_engineer`, `design_manager`, `customer_support` (`rbac.ts:27`). No logistics or service role |
| Comments, mentions, watchers | Missing | No table. The touch log covers quotes and opportunities only |
| Activity history | Partial | `audit_events` and `processing_events` on every object. A merged timeline exists for orders only (`ThreadDrawer.tsx`) |
| Notifications | Partial | The bell is one tenant-wide row (`_lib/notifications.js:62-69`). It renders for admin and operator only (`Shell.tsx:600`). Mark-read requires admin (`admin/notifications.js:43`) |
| Reminders | Not running | Agent goals run in the 5-minute tick (`cron/tick.js:198-200`). Vercel schedules only `/api/cron/daily` (`vercel.json`). Open PR #566 gives the tick a scheduler behind an allow-list that defaults to extraction jobs only |
| Calendar | Partial | `holiday_calendar` (`003:97-104`) and `_lib/datemath.js` exist. No timeline or calendar screen |

### 2.4 Reusable primitives

| Primitive | Where | What this design takes from it |
|---|---|---|
| `audit_events` | `001:323-339`; `_lib/audit.js` | Who changed what. Merged into the deal room feed |
| `processing_events` | `001:343-353` | An event source for automation, and feed rows |
| `communications` with `object_type`/`object_id` | `005`, `189` | Touch log and mail per object. Follow-up dates seed items |
| `opportunity_stage_events` | `140:24-40` | Stage dwell time and gate cycle time |
| `project_phase_log` | `006:510-520` | Phase actuals for learning |
| `shipment_eta_observations` | `212` | Promise history and slip distributions |
| `shipments` ladder dates | `006:453-459` | Actual ready, sailing, arrival, receipt and delivery dates |
| `supplier_lead_times`, `customer_lead_times` | `003:70-94` | Priors for stage durations |
| `holiday_calendar`, `_lib/datemath.js` | `003:97`; `datemath.js:42-63` | Business-day arithmetic with per-country holidays |
| `quote_approvals` and the evaluator | `006:622-632`; `_lib/approval-evaluator.js` | Each pending row becomes an approval item |
| `operator_actions` | `150` | Pattern for ordered steps with evidence |
| `logistics_exceptions` | `206:50-70` | Pattern: fingerprint dedup, SLA target, breach time. Same idea as `source_key` |
| `resolveAssignee`, `userDisplayNames` | `_lib/assignee.js:15,38` | Member check and names for every assignee field |
| `SERVER_ACTIONS` | `_lib/auth.js:213` | The server-side gate for fine-grained actions |
| `item_field_definitions` | `105:380-405` | Precedent for a per-tenant field schema |
| `bom_asset_projects` | `147:74-82` | Project to design BOM, with quantity |
| `equipment_hierarchy`, `equipment_installed_parts` | `006:390-429` | The canonical installed base (`INSTALLED_BASE_CANONICAL.md`) |
| `_lib/mailer.js` `sendEmail` | `mailer.js:130` | Sends directly, so a digest does not need the tick-only reaper |

### 2.5 Corrections and additions from the re-verification

1. **An order-less source PO is already possible.** The audit cites
   `source_pos.order_id not null` (`001:179`). Migration 087 dropped that
   constraint for stocking POs (`087:34-45`), and the plan-release path creates
   one (`inventory/plans.js:28-35`). The manual create path still requires an
   order (`source_pos/index.js:45-48`). So pre-ordering for a project needs a
   `project_id` on the PO and a create path. It does not need a schema
   relaxation.
2. **The work week is hard-coded.** `datemath.isWeekend` treats Saturday and
   Sunday as the weekend for every country (`datemath.js:37-40`). A country
   with another work week cannot be modelled. The kickoff workbook itself uses
   a Sunday-only weekend for one leg.
3. **No segregation of duties exists anywhere.** A search of `src/api` for
   self-approval, maker-checker and segregation finds nothing.
4. **No exposure field exists.** No column holds a cancellation fee, a
   manufacturing fee, an LD clause or an LOI. The `documents` table can hold an
   LOI file, but nothing types it.
5. **Customer type is one value.** `customers.customer_type` is an enum with
   `AUTO_OEM`, `TIER_ONE`, `LINE_BUILDER`, `OTHER` (`006:28-35`, `006:111-112`).
   The customer's country is `customers.country` (`096`).
6. **`projects` already carries most kickoff header fields:**
   `customer_location_id`, `end_user` (free text), `customer_segment`,
   `related_opportunity_id`, `shipping_mode`, six `expected_*` dates and
   man-day budgets (`006:480-505`).
7. **`orders.po_date` exists** (`001:140`). It is the actual PO date for the
   schedule.
8. **`item_master` has `source_country` and `default_lead_days`**
   (`006:178,188`). They are per item, with no effective date and no rule.
9. **Three urgent bugs are being fixed separately now,** in open PRs. The
   Kanban "Closed" column cancels an order (`pipeline-kanban.tsx:52`; #567,
   which also sends the payload hash on Approve). The supplier ack from the
   screen always returns 400 (#571). The projects POST upserts on
   `project_code` and overwrites another project (`sales/projects.js:92`;
   #573). This design does not include them in its PRs.

---

## 3. The kickoff template, and why it does not scale

The owner shared the team's current "project kickoff and design internal work
order" workbook. It was read with formulas and with computed values. This
section describes its **structure only**. It names no customer, plant, person,
part or project.

### 3.1 What the template is

One sheet. One project per file. Seven blocks, top to bottom:

1. **Header.** A project code, a purpose (one of seven project types), the
   requester and the request date.
2. **Parties.** The customer who issues the PO, the principal customer whose
   plant gets the equipment, the project name, two "type of customer"
   checkboxes, the integrator or line builder, the customer's country, the
   salesperson, the region (plant city) and the sales manager.
3. **A notes block.** A large merged area for free-text notes. In the example,
   the real scope lives here.
4. **Authorisations.** A caution note about fees, four "document purpose"
   checkboxes, a "special schedule" checkbox, and a "no manufacturing without
   PO" label.
5. **Timeline.** Expected PO or LOI date, a design-approval completion target,
   the manufacturing source country, the shipping mode, and computed dates:
   earliest manufacturing start, ready, packing complete, departure, arrival
   and material dispatch. A second row of manual "custom dates" for the
   special schedule.
6. **Scope.** Sixteen product-family columns. Under each: a quantity for new
   equipment, a quantity for modification of existing equipment, a part
   number, and a source-origin code.
7. **Configuration and sign-off.** Three configuration specs (sensor polarity,
   pneumatic vendor, water-circuit valve state), then "prepared by", "approved
   by" and "authorised signatory".

### 3.2 Findings and the principle behind each fix

| # | Finding | What the sheet does | Effect | Principle | Fixed in |
|---|---|---|---|---|---|
| F1 | The project code is not an identity | Two-digit year, plus the first four letters of the region, plus a typed serial | Two projects in one region and year collide unless someone tracks the serial by hand. Choosing the "other region" option puts the first letters of that option's label into the code. The code links to no opportunity and no customer | Identity is a system key. A display code is generated from a per-tenant sequence and never reused. Links are foreign keys | §5.2, WM-13 |
| F2 | Product families are hard-coded columns | Sixteen fixed family columns, one part-number cell each, new and modification quantities as two fixed rows | A seventeenth family needs a new template version. A family with two parts cannot be recorded. The part-number label is merged over the first four family columns, so four families have no part-number cell at all | Scope is rows, not columns. Any number of lines per family | §5.5, WM-13 |
| F3 | Sourcing origin is a formula | "If the new quantity is filled, then a fixed origin code" per column. Some columns also have a one-value dropdown | The rule cannot change without a new template. The formula reads only the new-quantity row, so a modification-only line gets no origin. In the example the origin was typed over the formula | Sourcing is a versioned rule table. Each line records the rule version it used | §5.7, WM-14 |
| F4 | One origin and one mode schedule the whole project | The timeline reads one source country and one shipping mode | The scope row allows a different origin per family, but the dates assume one. A mixed-origin project is planned as if all of it came from one place | Plan per route (origin and mode). The project date is the latest route | §7, WM-18 |
| F5 | Lead times are constants | One origin adds 98 days, two origins add 42 days, local adds 28 days, all as calendar days. Packing, departure, arrival and dispatch add fixed offsets. Departure snaps to a fixed weekday per origin | Three calendars mix in one chain: calendar days, Monday-to-Friday workdays, and a Sunday-only weekend. No holiday list is passed to the workday functions. There is no P50 or P90, no actual, and no learning | Durations are data. They are distributions learned from actuals. Calendars and sailings are data | §7.2 to §7.4, WM-17 to WM-19 |
| F6 | The example is broken | With the expected PO date blank, the "earliest manufacturing start" cell returns the text "no manufacturing without PO". Every later date adds days to that text | Every computed date shows `#VALUE!`. The plan cannot be computed before the PO, which is exactly when the team needs it | Plan to an assumed date and show the assumption. Never put text in a date | §7.7, WM-18 |
| F7 | There is no customer date | No cell holds the date the customer needs the equipment | There is nothing to compare the plan with. No float, no "are we late", no backward pass | Every plan is measured against a commitment. Float is the primary number | §7.6, WM-18 |
| F8 | Money is authorised by checkbox | Four purpose checkboxes and one special-schedule checkbox. The caution note says design and manufacturing fees apply without a customer PO | The checkboxes record no approver, no time, no amount and no fee terms. Anyone can untick one. "Prepared by", "approved by" and "authorised signatory" are blank in the example | A money decision is a gate with a basis, an exposure, an approver who is not the requester, evidence and an audit record | §6, WM-15 |
| F9 | Parties are free text | Customer, principal customer and integrator are typed names. In the example all three are the same typed name. "OEM" and "Tier 1" are two independent checkboxes. The customer's country is typed per project | Typos split one customer into many. Both checkboxes can be ticked, or neither. Nothing reaches the customer master | Parties are links to the customer master, each with a role. Customer type and country live on the customer | §5.3, WM-13 |
| F10 | People are typed names | Requester, salesperson and sales manager are text | No one can be notified, assigned or audited | People are users. Approval is by role | §8, WM-5 |
| F11 | The real scope is a note | The modification scope (which subassemblies change on an existing machine) is prose in the notes block. The existing machine is a part number in a cell | Nothing can plan, cost or check that scope. The existing machine links to nothing | Scope is structured lines. Existing equipment links to an installed asset | §5.5, WM-13 |
| F12 | Configuration is three dropdowns | Three spec rows apply to one product family, but each is one merged value for the whole sheet | A second family with its own spec cannot be recorded. No unit, no comparison | Configuration specs are rated attributes on the scope line (#542) | §5.6, WM-13 |
| F13 | Validation is brittle | Three validations compare to `TODAY()`. A chain of "fill the cell above first" rules fires only on edit. One defined name is `#REF!`. A scratch area holds stray debug cells | On any later day, the record fails its own rules if someone edits or audits it. A paste bypasses the chain. Blank required cells pass | Validation runs on the server, against the record's own dates, at every save and every transition | §4.6, WM-5 |
| F14 | Completeness is text | Three cells build messages like "part number not provided at submission" | A missing input is a sentence, not a blocker with an owner | A missing input is a blocked status with a reason and an owner | §4.3 |
| F15 | Only the template has a version | The footer carries a template version. A project's copy has no history. The custom dates overwrite the plan. "Sales manager only" is a label | No one can tell what changed, when, or why. Anyone can type custom dates | Every change is an event. An override needs a reason and an approver role | §4.5, §7.9 |
| F16 | "No manufacturing without PO" is a label | A text note, and the text returned by the start-date cell | Nothing stops manufacturing. Nothing records that it started without a PO | A gate with a mode: advisory or enforced (D2) | §6.6, WM-16 |
| F17 | Countries have three vocabularies | Source country uses title-case names. Customer country uses upper-case names. The scope row uses origin codes | Comparisons and reports need translation. A typo breaks a formula silently | One reference list. Codes, not labels | §5.7 |

### 3.3 Corrections to the critique that came with the request

- **Sixteen family columns, not seventeen.** The scope header has sixteen
  family columns plus one label column.
- **The origin formula is worse than described.** It tests only the
  new-quantity row. A modification-only line gets no origin unless someone
  types over the formula, which the example does.
- **The part-number row is narrower than it looks.** Its label is merged over
  the first four family columns.
- **The schedule ignores the per-family origins.** It reads one project-level
  source country and one shipping mode.
- **There is no customer date at all,** so float cannot be computed even when
  every input is filled.
- **The five checkboxes are form controls linked to cells.** Their captions
  live in the drawing layer, not in cells. Unticking one leaves no trace.

---

## 4. The work model

### 4.1 Item types

| Type | What it is | Where its facts live |
|---|---|---|
| `opportunity` | The header of a deal | The `opportunities` row. The item is a pointer and copies nothing |
| `project` | The header of an engineering and delivery effort | The `projects` row. The item is a pointer |
| `task` | A piece of human work with an owner and a due date | The item |
| `gate` | A decision that commits money or a date before the customer has | The item, plus `work_gate_decisions` (§6) |
| `issue` | A problem someone raised. It can block other items | The item |

`category` sub-types a task or an issue from the template: `follow_up`,
`check`, `approval`, `design_review`, `procurement`, `logistics`, `finance`,
`service`. Categories are tenant data, not code.

**Header items are pointers.** An `opportunity` or `project` item exists so
that links, watchers, comments and views have one shape. Its title, status,
owner and dates are read from the domain row through a view
(`work_item_rows`). Its own columns for those facts stay null. Editing a header
item calls the domain API (`sales/opportunities.js`, `sales/projects.js`) with
its existing guards. This is the rule that keeps the layer from becoming a CRM
beside Anvil.

Orders are not header items. An order already has a workspace. Items about an
order carry `order_id` in their ancestry, and the deal room groups them.

### 4.2 `work_items`

Shapes, not final SQL. Every table has `tenant_id`, RLS on, and is written by
the API through the service role with an explicit tenant filter.

```
work_items
  id uuid, tenant_id
  item_key text                    -- display key, e.g. 'WK-1042', from work_counters
  type text check in ('opportunity','project','task','gate','issue')
  category text                    -- tenant data, see 4.1
  title text, detail text          -- null for header items

  -- what the item is about (polymorphic, validated in code)
  subject_type text not null       -- opportunity | quote | opportunity_quote | order
                                   -- | project | project_scope_line | internal_so
                                   -- | supplier_rfq | source_po | shipment | invoice
                                   -- | customer | equipment | document | support_case (D6)
  subject_id uuid not null

  -- ancestry, stamped by one resolver (_lib/work-chain.js)
  account_id, opportunity_id, project_id, order_id  uuid null
  parent_id uuid null references work_items  -- the tree; see 4.4

  -- state (null on header items: their state is the domain row's stage or phase)
  status text                      -- a status key from the tenant workflow
  status_category text check in ('todo','in_progress','blocked','done','cancelled')
  blocked_reason text              -- required when status_category = 'blocked'
  blocked_since timestamptz
  resolution text                  -- e.g. 'approved','rejected','duplicate','wont_do'

  -- ownership
  assignee_user_id uuid null       -- a person
  assignee_role text null          -- or a role (team) queue

  -- time
  start_at timestamptz null        -- planned start, for the timeline
  due_at timestamptz null
  due_source text check in ('manual','sla','schedule','customer_commit','follow_up','gate')
  due_basis jsonb                  -- {run_id, p50, p90, assumption} when due_source = 'schedule'
  priority smallint default 3      -- 1 urgent .. 4 low

  -- provenance
  source text check in ('manual','event','template','automation','sweep','agent')
  source_key text                  -- idempotency key for auto-created items
  template_key text, template_version int, template_step_key text
  custom jsonb default '{}'        -- only if D7 allows custom fields

  created_by, created_at, updated_at, completed_by, completed_at
  version int default 1            -- optimistic concurrency

  unique (tenant_id, item_key)
  unique (tenant_id, source_key) where source_key is not null
                                 and status_category not in ('done','cancelled')
  unique (tenant_id, subject_type, subject_id) where type in ('opportunity','project')
  check (type in ('opportunity','project')
         or (title is not null and status is not null and status_category is not null))
  check (status_category is distinct from 'blocked' or blocked_reason is not null)
```

Indexes: `(tenant_id, assignee_user_id, status_category, due_at)`,
`(tenant_id, assignee_role, status_category) where assignee_user_id is null`,
and one each on `opportunity_id`, `project_id`, `order_id` and
`(subject_type, subject_id)`. A GIN index on `custom` only if D7 allows it.

`work_counters (tenant_id, counter_key, next_value)` issues item keys and
project codes with `update ... returning`. No serial is ever typed.

### 4.3 Rules that matter more than the columns

1. **A dependency on another team's object is an item.** "Supplier ack for
   source PO 123" is an item for procurement. The ack event closes it. So
   every dependency is item to item, and the links table keeps one shape.
2. **Auto-created items are idempotent.** The same event fired twice makes one
   item, through `source_key`. This is the `logistics_exceptions` fingerprint
   pattern.
3. **Every auto item has an auto-close.** If no event can close it, it is not
   auto-created. The logistics monitor's first run produced about 2,000
   critical rows that nothing could resolve. That must not repeat.
4. **One resolver writes ancestry.** `_lib/work-chain.js` walks from the
   subject to the quote, opportunity, order, project and account. The link
   writers in WM-3 and WM-12 call it again when a link changes.
5. **Status is a discriminator.** No missing-column fallback (Postgres 42703)
   may write a default status, type or category. Migration 219 taught this.
6. **Blocked has two meanings, and both show.** `blocked` status means a
   person says it is blocked, with a reason (for example "waiting for the
   customer's spec"). "Waiting" is derived: an open item that blocks this one.
   The screen shows both.
7. **A missing input is a blocked item, not a sentence.** Where the workbook
   printed "part number not provided", Anvil opens a `check` item, assigned to
   the line's owner, closed when the field is filled.

### 4.4 `work_item_links`

```
work_item_links
  tenant_id, from_item_id, to_item_id
  link_type text check in ('blocks','relates','duplicates')
  lag_days int default 0           -- 'blocks' only: finish-to-start lag, in business days
  created_by, created_at
  primary key (from_item_id, to_item_id, link_type)
  check (from_item_id <> to_item_id)
```

- **`blocks`.** A blocks B: B cannot move to `done` while A is open. Adding a
  `blocks` edge that closes a cycle is refused in code. The timeline draws
  these edges.
- **`relates`.** No semantics. Stored once, shown on both sides.
- **`duplicates`.** A duplicates B: A closes with resolution `duplicate`, and
  its watchers move to B.
- **Parent and child.** The API offers them as a link type for uniformity. They
  are stored as `work_items.parent_id`, because an item has at most one parent
  and a column enforces that. Typical tree: opportunity, then project, then
  gates and tasks.

### 4.5 `work_item_events` and watchers

```
work_item_events                  -- append-only: the thread and the history
  id bigserial, tenant_id, item_id
  kind text check in ('comment','comment_redacted','mention','field_change',
                      'status_change','assign','link_add','link_remove',
                      'watch','unwatch','gate_request','gate_decision',
                      'schedule_change','auto')
  actor_user_id uuid null          -- null for a rule; detail names the rule
  body text                        -- comment text
  mentions uuid[]
  field text, old_value jsonb, new_value jsonb
  detail jsonb                     -- rule key, run id, reason
  created_at

work_item_watchers
  tenant_id, item_id, user_id, reason ('creator','assignee','mention','owner','manual')
  primary key (item_id, user_id)
```

- Every change to a typed column writes one `field_change` event with the old
  and new value. This answers "what changed, when and why" (finding F15).
- Comments are never edited in place. A redaction hides the body, keeps the
  row, and records who redacted it. This handles a comment that contains
  something it should not.
- Watchers are state, so they are a table. Watch and unwatch are also events.
- The deal room feed merges these events with `audit_events`,
  `processing_events` and `communications`.

### 4.6 Workflows

```
work_workflows
  tenant_id, item_type, category null, version, active
  statuses jsonb      -- [{key, label, category}]  category from the fixed five
  transitions jsonb   -- [{from, to, roles[], requires[], on_enter[]}]
  created_by, created_at
```

- **Per type, per tenant, versioned.** A seeded default exists for `task`,
  `issue` and `gate`. A tenant can publish a new version. An item keeps its
  status key. The editor refuses to remove a status that open items use unless
  the tenant maps it to a kept status.
- **RBAC on transitions.** Each transition lists the roles that may take it.
  The server checks `ctx.role` against the list (admin always passes the role
  check, but never the segregation-of-duties check in §6.4). The client hides
  transitions the user cannot take, as `rbac.ts` `canDo` does today.
- **`requires`** names server-side checks, for example `blocked_reason`,
  `all_children_done`, `no_open_blockers`, `gate_decided`,
  `custom_field:<key>`. They run at every transition (finding F13).
- **`on_enter`** names automation actions, for example "notify watchers".
- **Header types use their domain ladder.** The `opportunity` workflow is the
  11-value `opportunity_stage` enum with its existing guard
  (`sales/opportunities.js:32-49`). The `project` workflow is the 15-value
  `project_phase` enum with its guard (`sales/projects.js:20-37`). A tenant
  can relabel stages and attach stage checks to them. It cannot add enum values
  in v1, because funnel, forecast and win/loss read them.

Default `gate` workflow: `draft` (todo), `requested` (in progress),
`approved` (done), `rejected` (done), `withdrawn` (cancelled), `expired`
(blocked, reason "waiver expired and no PO"), `superseded` (done, the PO
arrived and replaced a waiver).

### 4.7 Templates per project type

```
work_templates
  tenant_id, template_key, version, name, active
  applies_to jsonb    -- {project_type_keys[], order_modes[], opportunity: true}
  steps jsonb         -- [{step_key, type, category, title, assignee_role,
                      --   due_rule: {anchor, offset_bd} | {schedule_stage},
                      --   depends_on: [step_key], gate_key, required}]
```

- Instantiating a template creates its items once. Each `source_key` is
  `tpl:<template_key>:<version>:<anchor_id>:<step_key>`, so a second click
  adds nothing.
- `due_rule.anchor` is an event date (`project.created`,
  `gate:manufacturing_release.approved`, `opportunity.close_date`) or a
  schedule stage (`schedule:<line>:ready_p50`). Offsets are business days in
  the assignee's calendar.
- A running project keeps the template version it started with. "Add the
  steps the new version has" is an explicit action that shows a diff.
- Seeded templates: one per project type for equipment projects (design,
  approval, release, procurement, logistics, installation), and one for spares
  deals with no gates. Section 6.1 lists the default stage checks.

### 4.8 Automation rules

```
work_automation_rules
  tenant_id, rule_key, enabled, version
  trigger text        -- an event type from a code registry, e.g. 'quote.sent',
                      -- 'order.approved', 'source_po.sent', 'shipment.eta_changed',
                      -- 'opportunity.stage_changed', 'gate.approved', 'schedule.float_negative'
  condition jsonb     -- the same AST as the query language, over the event payload
  actions jsonb       -- [{create_item: {template_step}}, {close_item: {source_key}},
                      --  {transition: {to}}, {assign: {...}}, {notify: {...}}]
  created_by, created_at
```

- **Inline, not on a timer.** Handlers call `emitWorkEvent(ctx, type,
  payload)` after they commit. Matching rules run in the same request. This
  avoids the unscheduled tick (§2.3).
- **The trigger registry is code.** A tenant can only react to events Anvil
  emits. This keeps rules testable and keeps the layer thin.
- **Every `create_item` rule must name its closing trigger.** The rule editor
  refuses a rule without one (§4.3 rule 3).
- **Off by default.** `tenant_settings.work_items_auto_enabled` defaults to
  false. Before a tenant turns it on, a dry run reports how many items the
  rules would open today.

### 4.9 Views, the query language, and layouts

```
work_views
  tenant_id, view_id, owner_user_id null (null = shared), name
  query text, query_ast jsonb, query_version int
  layout text check in ('list','board','timeline','calendar')
  columns jsonb, group_by text, sort jsonb, shared_with_roles text[]
```

**The query language** is small, typed and compiled to parameterised SQL over
a whitelist of fields. It never accepts raw SQL. The tenant filter and the
caller's read rights are always added by the server.

```
query   := expr [ ORDER BY field [ASC|DESC] {, field [ASC|DESC]} ]
expr    := term { (AND | OR) term }
term    := [NOT] ( '(' expr ')' | clause )
clause  := field op value
         | field [NOT] IN '(' value {, value} ')'
         | field IS [NOT] EMPTY
op      := = | != | > | >= | < | <= | ~        (~ is "text contains")
value   := 'string' | number | date | function
function:= me() | myRoles() | today([+-]Nd) | startOfWeek() | endOfWeek()
field   := type | category | status | statusCategory | assignee | role | priority
         | due | start | created | updated | account | opportunity | project
         | order | subject | gate | exposure | float | blocked | waiting
         | watcher | text | custom.<key>
```

Examples:

| Need | Query |
|---|---|
| My work | `assignee = me() AND statusCategory NOT IN (done, cancelled) ORDER BY due` |
| My team's unassigned queue | `role IN myRoles() AND assignee IS EMPTY AND statusCategory = todo` |
| Gates waiting for me, largest first | `type = gate AND status = requested AND role IN myRoles() ORDER BY exposure DESC` |
| Late or at risk | `due < today() OR float < 0` |
| What blocks a project | `project = PRJ-2026-0042 AND (blocked = true OR waiting = true)` |

The filter bar builds the same text, so most users never type it. Automation
conditions use the same AST, so one parser serves both. A parse error returns
its position.

**Layouts.**

- **List** is the default. It sorts by due date, then float.
- **Board** groups by workflow status, with optional swim lanes by assignee or
  account. It is a layout, never the home screen.
- **Timeline** draws bars from start to due (or P50 to P90 for scheduled
  items) and arrows for `blocks` links. It highlights the critical path from
  the schedule engine. In v1 it is read-only. Moving a bar would set a manual
  due date with a reason. See D8.
- **Calendar** shows due dates by day. It is cheap once the list exists.

### 4.10 Custom fields: typed core plus a JSONB schema

**Typed core columns** hold everything the system reasons about: type,
status, assignee, due, priority, ancestry, gate basis, exposure. Queries,
indexes, workflows and the schedule depend on them.

**Custom fields** (only if D7 allows them in v1):

```
work_field_definitions
  tenant_id, field_key, label, data_type check in
    ('text','number','money','date','boolean','enum','user','unit_value')
  applies_to_types text[], options jsonb, unit text
  required_on_status text[]       -- workflow statuses that require it
  searchable boolean, active boolean, version
```

- Values live in `work_items.custom` as JSONB. The API validates every write
  against the definition. A wrong type is a 400, not a silent drop.
- **Never EAV-only.** An entity-attribute-value table (like
  `item_field_values`, `105:410-420`) turns every list into a pivot, loses
  types, and hides drift. This design takes the definitions half of that
  precedent and keeps values on the row.
- **No shadow facts.** The editor refuses a custom key that matches a core
  column or an Anvil fact, for example a "customer" text field.
- **Promotion rule.** When a custom field becomes a hot filter or feeds a
  rule, a migration promotes it to a typed column.

### 4.11 Why not reuse what exists

| Candidate | Why it is not the task table | What this design does with it |
|---|---|---|
| `agent_goals` (`011`) | A machine loop. `goal_type` is a CHECK list where each value has a handler (`011:31`). The status set is `active, paused, completed, cancelled, failed` (`011:46-48`): no `blocked`, no human `done`. The runner picks `status = 'active'` rows by `next_run_at` (`011:81-82`), so a human task there is either run by a handler or needs a no-op one. The runner lives in the tick (`cron/tick.js:198-200`), which Vercel does not schedule | Keep it for automation. On escalation, a goal creates an owned work item instead of only a tenant-wide bell row (`agents/run.js:102-129`) |
| `processing_events` (`001:343-353`) | An append-only machine log keyed by a text `case_id`, with no status, owner or due date. It is history, not state. Mixing human comments into machine telemetry would also mix personal data into a table with a different purpose | Read it as an event source and as feed rows. Keep writing it |
| `operator_actions` (`150`) | The closest shape (polymorphic subject, ordered steps, evidence). But its lifecycle is "proposed to reconciled" for governed entry into systems with no API. No assignee and no due date. Flag off, no route, no screen | A work item can point at one as its subject |
| `logistics_exceptions`, `inventory_exceptions` | Detector outputs for one domain each | Keep them. A later rule mirrors an exception that needs a human owner into an item |
| `quote_approvals` | Approval rows for one object type, which do not gate the order | Each pending row becomes an approval item for its `approver_role` |
| `project_tasks` (#540 PR 3, never built) | Same columns, project only | Generalised into `work_items` |

### 4.12 RBAC

- **One new MATRIX row, `work`.** Read for every internal role, including
  `viewer` and `customer_support`. Write for the writer roles. The deal room
  needs a row every team can read. Today the MATRIX hides opportunities from
  procurement and operator (`rbac.ts:43`) while the API serves them, so the
  deal room must not depend on the `opps` row.
- **Server actions.** `work.assign_others` (reassign someone else's item) and
  `work.configure` (workflows, templates, rules, fields: admin). Gate approval
  is checked against the gate definition's approver roles, on the server.
- **Visibility is a filter, not a wall,** as #547 D3 recommends. Every internal
  role can read every item in its tenant. "Mine" and "my team" are default
  filters.
- **Cost stays gated.** Exposure amounts and any cost in the deal room are
  filtered by the existing `cost.view` action (`_lib/auth.js:213-249`).
- **Polymorphic ids need a tenant check.** The service role bypasses RLS. Every
  write checks that the subject belongs to the caller's tenant, the way
  `communications/log.js` checks its target.

---

## 5. The project kickoff, redesigned

### 5.1 The flow

The kickoff is not a form typed from blank. It starts from the opportunity and
prefills from what Anvil already holds (the reduce-clicks rule).

1. On an opportunity, "Start project" opens the kickoff. It links
   `projects.related_opportunity_id` at create (today it is omitted,
   `projects.tsx:108-114`).
2. **Parties** prefill from the opportunity's customer and its location.
3. **Project type** is picked from the tenant's list. The type picks the
   template and the gates.
4. **Scope lines** prefill from `opportunity_line_items` and the linked quote
   lines. For a modification type, the "existing equipment" picker searches
   the installed base for that customer.
5. **Configuration specs** prefill from the RFQ extraction when one exists
   (#542 rule 2). Otherwise the engineer fills them on the line.
6. **Sourcing** resolves per line from the rule table, with the rule version
   shown.
7. **Schedule** runs immediately. If there is no PO, it plans to an assumed PO
   date and says so.
8. **Gates** are created from the type's gate definitions. Requesting the
   first gate notifies the approver role.

### 5.2 The project record

`projects` stays. Migrations 254 and 255 add:

| Column | Purpose |
|---|---|
| `project_type_key` | Links to `project_types` |
| `owner_user_id` | The project owner (from migration 254, WM-12) |
| `requested_by`, `requested_at` | The requester, as a user, server-set |
| `customer_required_date` | The date the customer needs it |
| `customer_required_source` | `po`, `loi`, `customer_schedule`, `verbal`, `assumed` |
| `assumed_po_date`, `assumed_po_source` | The planning assumption when no PO exists (§7.7) |
| `legacy_code` | The old typed code, kept for search |

- **The project code is generated** from `work_counters` in a per-tenant
  format (default `PRJ-<year>-<sequence>`, D14). It is never typed and never
  reused. The upsert bug (`sales/projects.js:92`) is fixed separately (§2.5).
- **`end_user` (free text) is replaced** by a party row (§5.3). The column is
  kept for old rows and no longer written.
- **The six `expected_*` dates stay** as the baseline. The schedule engine
  writes the first baseline when the project is created. After that, the
  baseline changes only through a recorded re-baseline.

### 5.3 Account roles

```
project_parties
  tenant_id, project_id, role check in ('buyer','end_customer','integrator','consultant','other')
  customer_id uuid not null references customers
  customer_location_id uuid null references customer_locations   -- the plant
  contact_id uuid null
  unique (project_id, role, customer_id)
```

- **Buyer** issues the PO. **End customer** owns the plant where the equipment
  runs. **Integrator** builds the line. One customer can hold several roles,
  which replaces typing the same name three times.
- **Customer type and country live on the customer.** `customers.customer_type`
  and `customers.country` already exist. The two independent "OEM" and "Tier
  1" checkboxes disappear. Whether this deal is direct or through an
  integrator follows from which party is the buyer.
- **Region is the plant.** It is `customer_locations` (city, state) of the end
  customer. Reports derive region from it.
- A party that is not yet in the customer master is created through the
  existing customer create path, with its duplicate check
  (`126_customer_master_golden_record.sql`). It is never a free-text field.

### 5.4 Project types

```
project_types
  tenant_id, type_key, label, active, sort
  default_template_key, gate_keys text[]
  requires_existing_equipment boolean    -- true for modification types
```

Seeded with the seven purposes the workbook uses, in generic form: a new
plant; a new model on a new line; a new model on an existing line; a volume
expansion; a minor facelift; a major facelift; and a modification of existing
equipment. A tenant edits the list as data. No code change adds a type.

### 5.5 Scope lines

```
project_scope_lines
  tenant_id, project_id, line_no, parent_line_id null
  product_family_id uuid null      -- product_families (#495 shape)
  item_id uuid null                -- item_master, when the part is known
  part_no text null                -- the join key every stage uses (#495 §3)
  bom_asset_id uuid null           -- the design BOM, when one exists (147)
  change_kind text check in ('new','modification','replacement','spare')
  qty numeric
  existing_equipment_id uuid null  -- equipment_hierarchy, the installed asset
  subassembly_ref text null        -- for a modification child line: the BOM node changed
  origin_country text, origin_source text      -- §5.7
  shipment_mode shipment_mode, mode_source text
  required_date date null          -- per line, when it differs from the project
  owner_user_id uuid null
  check (change_kind <> 'modification' or existing_equipment_id is not null)
```

- **Any number of lines per family.** A family with two parts has two lines.
  A new family is a new row in `product_families`, not a new template.
- **New versus modification is a column,** not two fixed rows.
- **A modification links to the installed asset.** The parent line names the
  existing machine (`existing_equipment_id`). Child lines name each
  subassembly that changes. This is the scope the workbook kept in its notes
  block.
- **Which registry?** `equipment_hierarchy` is the canonical installed base
  (`INSTALLED_BASE_CANONICAL.md`). #547 D5 makes the shared spare matrix the
  customer-facing view and leaves the two unlinked for now. This design links
  to `equipment_hierarchy`. If a tenant's machines live only in the spare
  matrix, the picker also searches matrix rows and creates the
  `equipment_hierarchy` row on first use. That depends on #547 D5's "link
  first" path and is noted as a risk.
- **`product_families`.** If #495 has not shipped it, migration 255 creates it
  with the exact shape `PRODUCT_CATALOG_SCOPE.md` §3 specifies, so #495 reuses
  it.

### 5.6 Configuration specs as rated attributes

```
project_line_requirements
  tenant_id, scope_line_id, attribute_key
  comparison text check in ('at_least','at_most','range','exact','enum_subset')
  required_number numeric, required_min numeric, required_max numeric
  required_text text, unit text
  source text check in ('customer_spec','rfq_extract','engineer')
  evidence_document_id uuid null
```

- This is the requirement side of #542 §9b. The comparison semantic is the
  column that matters: without it, a selector cannot tell which direction is
  better.
- The workbook's three configuration specs are `exact` or `enum_subset`
  requirements on the line of the family they apply to. A second family can
  carry its own.
- When #542's `product_attributes` exists, `attribute_key` gets a foreign key
  to it, and the ranked selector can check each line against variant ratings.
  Until then, the key is validated against a per-family list held as data.

### 5.7 Sourcing by a versioned rule table

```
sourcing_rules
  tenant_id, rule_set_version int, priority int
  -- match (null means any)
  product_family_id, item_category, change_kind, project_type_key,
  end_customer_country, end_customer_id
  -- result
  origin_country text, supplier_id uuid null, default_mode shipment_mode
  effective_from date, effective_to date null
  note text, created_by, created_at
```

- **Resolution order per line:** an override with a reason, then the highest
  priority matching rule in the active version, then
  `item_master.source_country` when the item is known, then **unresolved**.
- **Unresolved is refused, not guessed.** The line shows "origin unknown" and
  the schedule marks it `route_unknown`. This is #540's `lead_unknown` rule.
- **Rules are never edited in place.** A change publishes a new
  `rule_set_version`. Each line stores `origin_source =
  'rule:<id>@v<version>'`. "Re-resolve with the current rules" is an explicit
  action that shows the differences before saving.
- **One country vocabulary.** Origins are ISO country codes. The display label
  comes from one reference list (finding F17). The existing `O-XXX` style
  codes in `item_master.source_country` map once, through a lookup.

---

## 6. Stage gates with money at risk

### 6.1 Stage checks and gates are different things

**Stage checks** are light. They are tasks with `category = 'check'` attached
to an opportunity stage or an order status. They carry no money. The default
template creates them from events and closes them from events. A stage can
advance with open checks if the user gives a reason (the margin-floor override
pattern). The audit's checklist is the default:

| Stage entered | Check | Role | Opened by | Closed by |
|---|---|---|---|---|
| QUALIFICATION | Name the owner; set close date and order mode | sales_manager, owner | fields empty | fields set |
| NEEDS_ANALYSIS | Enter requirement lines; book the next follow-up | owner | no lines; no follow-up | first line saved; touch logged |
| RFQ | Confirm the customer spec; design review for assembly and project modes | owner, design_engineer | stage entered | one click each |
| INTERNAL_PROPOSAL | Supplier price for lines with no cost | procurement | quote lines without cost | RFQ awarded or composition synced |
| PROPOSAL_PRICE_QUOTE | Approve and send the quote | sales_manager | quote to internal approval | quote sent |
| NEGOTIATION_REVIEW | Chase the customer's answer | owner | sent plus N business days | touch logged, or quote accepted or declined |
| CLOSE_WON | Link the customer PO; credit check | operator, finance | stage entered with no order | order linked; finance marks done |
| CLOSE_LOST | Record the lost reason | owner | stage entered | `lost_reason` set |
| Order PENDING_REVIEW | Resolve blocking findings; approval by role | finding owner, approver role | `rule_findings`; `quote_approvals` row | finding resolved; row decided |
| Order APPROVED | Commit a delivery date; push to Tally | sales_engineer, finance | date empty; status approved | date set; exported |
| Procurement | Raise each source PO by its order-by date; supplier ack | procurement | approved order with unstocked lines; PO sent | PO created; ack recorded |
| Logistics | Book the shipment; deliver with POD | operator | delay rules 6 to 8 | shipment created; POD received |
| Finance | Raise the invoice; collect | finance | despatch recorded; due date | invoice created; paid |

**Gates** are heavy. They commit money or a date before the customer has. They
carry a basis, an exposure, an approver who is not the requester, evidence and
an audit record.

### 6.2 The five gates

Seeded for equipment project types. Spares deals have none. Each is tenant
data (`work_gate_definitions`) and can be renamed or extended.

| Gate | What it releases | Money at risk without a PO | What Anvil can guard | Typical preconditions | Approver role |
|---|---|---|---|---|---|
| G1 Design kickoff | Local design work starts | Design man-days | Creating the design tasks from the template | Scope lines present; parties linked; a customer date or an assumed one | sales_manager |
| G2 Design PO to the source country | A design order to the source-country supplier | The supplier's design fee and its cancellation fee | Creating a design source PO for the project | G1 approved; origin resolved for every line; design PO value | sales_manager, finance |
| G3 Manufacturing release | Manufacturing starts | The manufacturing fee | Creating manufacturing source POs or internal work for project lines | Customer design approval recorded with evidence; G2 approved where it applies | sales_manager, finance |
| G4 Pre-ordering standard items | Long-lead standard items are ordered ahead | The value of non-returnable stock | Creating project source PO lines for standard items before the PO; approving an EXPECTED_PO internal SO | The item list with quantity, value and returnability | procurement, finance |
| G5 Special schedule | A schedule faster than the computed P50 | Expedite cost and the risk of a missed promise | Schedule overrides that pull a date earlier than P50 (§7.9) | The override dates, the reason, the float impact | sales_manager |

**Basis.** Each gate passes on one basis:

- **PO.** A customer PO is linked to the project (an order with
  `orders.po_date`).
- **LOI.** A letter of intent is attached as a document, with its date and
  scope.
- **Risk waiver.** No PO or LOI. The approver accepts a stated exposure with
  stated fee terms, for a limited time.

### 6.3 What each decision records

```
work_gate_definitions
  tenant_id, gate_key, version, label, description, sequence, active
  applies_to_project_types text[]
  mode text check in ('advisory','enforced')            -- D2
  requester_roles text[], approver_roles text[]
  approvals_required int default 1                      -- 2 = a second signatory
  allow_self_approval boolean default false             -- D10
  preconditions jsonb          -- [{check, params}], evaluated on the server
  exposure_required boolean, evidence_kinds text[]
  guards text[]                -- action keys refused when enforced and not approved
  waiver_valid_days int        -- e.g. 30

work_gate_decisions             -- append-only
  id, tenant_id, item_id, gate_key, gate_version
  decision text check in ('requested','approved','rejected','withdrawn',
                          'expired','superseded','revoked')
  basis text check in ('po','loi','risk_waiver')
  requested_by, requested_at, decided_by, decided_at
  exposure_amount numeric, exposure_currency text
  exposure_breakdown jsonb      -- {design_mandays, supplier_fees, committed_po_value, stock_value}
  fee_terms jsonb               -- {cancellation_pct, cancellation_amount, notice_days, manufacturing_fee}
  customer_order_id uuid null, loi_document_id uuid null
  evidence_document_ids uuid[]
  waiver_expires_at timestamptz null
  precondition_snapshot jsonb   -- each precondition and its state at decision time
  sod_waived boolean default false
  comment text
```

- **A gate item has a full history.** Request, decision, expiry and
  supersession are rows, never overwrites. Each also writes a
  `gate_decision` event and an `audit_events` row.
- **The precondition snapshot** shows exactly what the approver saw. A later
  change to the project does not rewrite it.
- **Reversal is a new row.** `revoked` records who withdrew an approval and
  why.

### 6.4 Segregation of duties

- **The approver is never the requester.** The server refuses
  `decided_by = requested_by` in every mode, advisory or enforced. An admin
  holds every role for the role check, but this check applies to the person,
  so an admin cannot approve their own request.
- **The approver must hold an approver role** listed on the definition. The
  check is on the server.
- **Two signatures when the tenant wants them.** With `approvals_required =
  2`, the gate passes only after two approvals by two different people,
  neither of them the requester. This replaces the workbook's "authorised
  signatory" line.
- **Small tenants.** A tenant with one person who can approve cannot meet this
  rule. D10 decides whether such a tenant may switch on self-approval. If it
  does, each such decision records `sod_waived = true` and shows a badge.

### 6.5 Exposure and waivers

- **Exposure is prefilled, then confirmed.** The prefill adds committed
  source PO value for the project with no customer PO, budgeted design
  man-days times a tenant rate, and stock value for G4. The approver confirms
  or edits it. The edit is recorded. D11 decides what counts.
- **Money at risk is a number on the project.** The project header shows the
  sum of exposure on approved waivers that have not been superseded by a PO.
  A tenant report lists every project with exposure and no PO, oldest first.
- **Waivers expire.** At `waiver_expires_at`, the daily sweep moves the gate to
  `expired` (blocked, reason "waiver expired and no PO"). It notifies the
  approver and the project owner. Renewal is a new request.
- **The PO supersedes the waiver.** When a customer PO links to the project,
  each approved waiver gate gets a `superseded` row with basis `po`. Exposure
  without a PO drops to zero for those gates.

### 6.6 Advisory or enforced

- **A gate can only guard an action that happens in Anvil.** Anvil cannot stop
  a designer opening a CAD file. It can refuse to create a source PO.
- **Advisory.** The guarded action proceeds. Anvil records
  `proceeded_without_gate` on the project and opens an item for the gate's
  approver role.
- **Enforced.** The server refuses the guarded action with a 409 that names the
  gate, until the gate is approved on some basis.
- **Recommended default (D2).** The record, the basis and segregation of
  duties are always enforced. Blocking is advisory for four weeks, with a
  "would have blocked" report. After that, G3 and G4 become enforced, because
  they create supplier commitments inside Anvil. G1, G2 and G5 stay advisory
  unless the owner says otherwise.

---

## 7. A data-driven schedule engine

### 7.1 Inputs

| Input | Source |
|---|---|
| Scope lines with origin and mode | `project_scope_lines` (§5.5, §5.7) |
| Route template per origin and mode | `schedule_routes`, `schedule_route_stages` |
| Stage durations | Learned estimates, else tenant priors (§7.4) |
| Calendars | `work_calendars` (work week) and `holiday_calendar` (holidays) per country |
| Sailings | `sailing_schedules` per lane, when loaded |
| Anchors | PO date (`orders.po_date`, else assumed), customer design approval (task actual, else planned), gate approvals |
| Commitment | `orders.committed_delivery_date`, else `projects.customer_required_date` |
| Actuals so far | `shipments` ladder dates, source PO ack ETA, `shipment_eta_observations`, `project_phase_log`, task completions |

### 7.2 Route templates

```
schedule_routes
  tenant_id, route_key, version, origin_country, mode shipment_mode,
  destination_country, active, effective_from

schedule_route_stages
  route_id, seq, stage_key, calendar_country, unit check in ('business','calendar')
  prior_p50_days numeric, prior_p90_days numeric
  snap_rule jsonb null           -- e.g. {sailing_lane: 'X-Y'} or {weekday: 'SAT', label: 'weekly sailing'}
  actual_source text             -- which actual column measures this stage
```

Stages are only as fine as the actuals that measure them. Today Anvil records
ready, sailing, port arrival, warehouse receipt and customer delivery
(`006:453-459`). So the default stages are:

| Stage | Starts at | Ends at | Measured by |
|---|---|---|---|
| `design` | G1 approved | customer design approval | design task completion; `project_phase_log` DESIGN |
| `customer_approval` | design submitted | approval recorded | approval task completion |
| `manufacture` | later of PO (or approved waiver) and design approval, plus one business day | ready | source PO sent to `shipments.ready_date` |
| `ready_to_depart` | ready | departure | `ready_date` to `vessel_sailing_date` (packing folds in here) |
| `transit` | departure | port arrival | `vessel_sailing_date` to `port_arrival_date` |
| `clear_and_inland` | port arrival | warehouse receipt | `port_arrival_date` to `warehouse_receipt_date` |
| `deliver` | warehouse receipt | at customer site | to `customer_delivery_date` |

The workbook's separate packing step has no actual in Anvil, so it folds into
`ready_to_depart`. A local route has no `transit` stage at sea. It has a road
stage measured by despatch to delivery.

### 7.3 Calendars and sailings as data

```
work_calendars
  tenant_id null (null = shared default), country, weekend_mask char(7),  -- Mon..Sun, '1' = off
  effective_from date

sailing_schedules
  tenant_id, lane_key, carrier, vessel_voyage,
  cargo_cutoff_at timestamptz, etd date, eta date,
  source text check in ('manual','import','api'), valid_until date
```

- `datemath.addBusinessDays` gains a weekend-mask argument. Today the weekend
  is fixed to Saturday and Sunday (`datemath.js:37-40`). Holidays keep coming
  from `holiday_calendar`.
- **Each stage uses the calendar of where it happens.** Manufacturing uses the
  origin's calendar. Clearance uses the destination's calendar.
- **Departure snaps to a real sailing** when `sailing_schedules` has one for
  the lane: the first sailing whose cut-off is after ready plus handling.
  Without sailings, a lane's `snap_rule` names a weekday and the screen labels
  it "weekly sailing rule, not a schedule".
- A missing calendar for a country is shown, not hidden: "no holidays loaded
  for this country".

### 7.4 Durations learned from actuals

- **Per stage key and route,** the engine keeps an empirical distribution from
  actuals in a rolling window (default 24 months):
  `stage_duration_estimates (tenant, route_key, stage_key, segment, n, p10,
  p50, p90, fitted_at, window)`. `segment` can be a supplier or a product
  family when there is enough data.
- **Sources.** Manufacture from source PO sent to ready (and ack ETA against
  receipt, #540 Q3). Transit and clearance from the `shipments` ladder. Slip
  from `shipment_eta_observations` (`212`). Design and customer approval from
  task completions and `project_phase_log`.
- **A sample floor.** Below N observations (default 8) the stage uses the
  tenant prior and the screen says "prior, not learned (n = 3)". This follows
  `three-way-summary.js` refusing below `MIN_DECIDABLE_FOR_CONFIDENCE`.
- **Overrides are not actuals.** A special-schedule date never feeds learning.
- **Refit weekly** in the daily cron, on one weekday.

### 7.5 Forward and backward

- **Forward from the PO.** Start at the PO date (actual or assumed) and the
  design approval date (actual or planned). Add stage durations in each
  stage's calendar. Result: P50 and P90 ready, departure, arrival and
  at-site dates per line.
- **Backward from the customer's date.** Start at the commitment. Subtract
  stage durations. Result per line: the latest manufacturing release, the
  latest design approval and the latest PO date that still meet the date at
  P50 and at P90. These are the "last responsible moment" dates of #540 §3.
- **Order-by items.** Backward dates become items with `due_source =
  'schedule'`: "release manufacturing for line 3 by 14 Nov (P90)". Their
  `source_key` is `sched:<project>:<line>:<stage>`. A re-plan moves their due
  date and logs a `schedule_change` event.

### 7.6 P50 and P90, float, and the critical path

- **Totals are sampled, not added.** The P90 of a sum is not the sum of the
  P90s. Adding P90s overstates the tail. The engine draws stage durations from
  each distribution (default 1,000 samples, fixed seed from the inputs, so a
  run is reproducible) and takes quantiles of the totals. Before learning
  exists, it fits a log-normal through each prior P50 and P90 and labels the
  result as a prior.
- **The project date is the latest line.** In each sample, the project's
  at-site date is the maximum over its lines. P50 and P90 are taken from that.
- **Float** = commitment minus forecast, in business days, at P50 and at P90.
  Negative float means late. Float is the primary number on every project,
  order and deal room. It is also the number the logistics track named as the
  next primitive: delay rules can open items only when float is below a
  threshold, instead of on every slip (`eta-history.js:14-15,159`).
- **Critical path.** The line, and the stages and blocking items on it, that
  set the P50 date. Sampling also gives a **criticality index** per line: the
  share of samples in which that line was the latest. A line that is latest
  in 40% of samples is shown even if it is not on the P50 path.
- **No commitment, no float.** If neither date exists, float shows "no
  customer date". It never shows zero.

### 7.7 A missing PO date

- The engine never stops for a missing PO. It plans to `assumed_po_date`.
  Default: the opportunity's `close_date`. Else, the approval date of a
  waiver gate. Else, today plus a tenant default.
- **Every date that depends on the assumption carries a marker.** The screen
  says "Assumed PO on 2 Nov (opportunity close date)". Changing the assumption
  is an event.
- **The backward pass answers the sales question directly:** "the PO must be
  in by 23 Nov for P90 delivery on the committed date" (the example in §7.10).
- When the PO links, the actual replaces the assumption and the engine
  re-plans. The difference between the assumed and the actual PO date is
  recorded. Over time this measures how far close dates slip.
- An assumed date never reaches the customer portal (#547 D10).

### 7.8 Re-planning when actuals arrive

```
schedule_runs
  id, tenant_id, subject_type ('project'|'order'), subject_id
  basis jsonb               -- anchors, assumptions, route and rule versions
  inputs_hash text, seed bigint, computed_at, trigger text
  result jsonb              -- per line and stage: dates (p50, p90), actual flags
  p50_at_site date, p90_at_site date, float_p50_bd int, float_p90_bd int
  critical_line_id uuid
```

- **Triggers.** PO linked; gate approved or expired; customer design approval
  recorded; source PO sent or acknowledged; shipment date set; ETA
  observation written; a sourcing re-resolve; a calendar or route version
  change. Each runs the engine inline for that subject. It is cheap.
- **The daily sweep** re-runs every open subject whose `inputs_hash` changed,
  as a backstop.
- **Completed stages use actuals.** The engine plans only what remains.
- **History is kept.** Each run is a row. The screen can say "plan 4 moved
  at-site by 9 days because the supplier acknowledgement slipped".

### 7.9 Special schedules

```
schedule_overrides
  tenant_id, subject_type, subject_id, scope_line_id null, stage_key
  override_date date, reason text, gate_item_id uuid   -- the approved G5 gate
  created_by, created_at, superseded_at null
```

- An override replaces a computed stage date. It needs a reason and an
  approved G5 gate when it pulls a date earlier than P50.
- The screen shows the override and the computed P50 and P90 side by side, so
  everyone sees how aggressive the promise is.
- Overrides never feed learning (§7.4).

### 7.10 What the schedule screen shows

Illustrative output for a two-line project before the PO arrives. Weeks are
counted from the assumed PO date. The customer's committed date is W+20. The
numbers are invented, but they are consistent with each other.

| Line | Route | Basis | Ready P50 / P90 | At site P50 / P90 | Float P50 / P90 | Critical |
|---|---|---|---|---|---|---|
| 1. New unit, family A | Origin X, sea | assumed PO; planned design approval 16 Nov | W+9 / W+12 | W+15 / W+19 | +25 / +5 bd | 97% |
| 2. Modify existing machine, two subassemblies | Local, road | assumed PO | W+5 / W+7 | W+6 / W+8 | +70 / +60 bd | 3% |
| **Project** | | **Assumed PO 2 Nov (opportunity close date)** | | **W+15 / W+19** | **+25 / +5 bd** | |

Below it, the backward pass: "For P90 delivery on the committed date,
manufacturing on line 1 must start by 24 Nov. So the PO (or an approved G3
waiver) and the customer's design approval must both be in by 23 Nov. Design
approval is planned for 16 Nov, so it is the binding date, with 5 business
days to spare."

---

## 8. Cross-functional collaboration

### 8.1 Teams and roles

- **A team is a role in v1** (D3). `assignee_role` routes an item to a role
  queue. Anyone in that role can take it. This reuses RBAC as it is.
- **Logistics and service.** Today those people sit in `operator` and
  `procurement`. D3 asks whether to add `logistics` and `service` roles. Adding
  a role is one MATRIX column, one `SERVER_ACTIONS` review and one parity
  test.
- **The alternative** is a `work_teams` table (key, name, members, lead) used
  only for routing, never for permissions.

### 8.2 Assignment defaults

- **Default assignee** follows #547 D4: the opportunity owner, else the
  account owner, else the creator. A role queue is used when the template
  step names a role.
- **Who may assign whom** (D13): any writer may assign to anyone in the tenant.
  Reassigning someone else's item needs `work.assign_others`, default
  `sales_manager`, `design_manager` and `admin`.
- Every assignee goes through `resolveAssignee` (`_lib/assignee.js:15`), so an
  unapproved member cannot be assigned.

### 8.3 Watchers and mentions

- The creator, the assignee and anyone mentioned become watchers. On header
  items, the opportunity owner and the account owner also watch.
- `@person` in a comment writes a `mention` event, adds a watcher and sends a
  notice. `@role` is not supported in v1, because it would notify a whole team
  for one comment. Assigning to the role queue does that job.

### 8.4 A notification per user

- Migration 253 adds `admin_notifications.recipient_user_id`. Null keeps
  today's tenant-wide behaviour. A non-null row is a personal notice.
- The bell renders for every role, not only admin and operator
  (`Shell.tsx:600`).
- The recipient can mark their own notice read. Today mark-read requires admin
  (`admin/notifications.js:43`), so an operator's click fails silently.
- **Notice kinds:** assigned to me; mentioned; a gate waits for my role; my
  item is overdue; something I watch changed status; a waiver I approved
  expires in three days; float went negative on my project.
- `user_notification_prefs (tenant_id, user_id, kind, channel)` holds per-kind
  choices (D4).

### 8.5 The email digest

- One email per user per working day, from the daily cron (02:30 UTC). It
  lists: overdue items, items due today, items I block, gates waiting for my
  role, mentions, and projects I own with negative float.
- It calls `_lib/mailer.js` `sendEmail` directly. It does not queue through
  `communications`, because the queued-mail reaper runs only in the tick
  (`agents/run.js:276-364`).
- Opt-out per user. No digest when the list is empty.

### 8.6 The sweep on the daily cron

`/api/cron/daily` is the only runner Vercel schedules (`vercel.json`). The
sweep runs there, per tenant:

1. Mark items overdue and due soon. Raise priority on overdue gates.
2. Expire waivers (§6.5).
3. Re-plan subjects whose inputs changed (§7.8).
4. Open float items: "project X is now late at P50".
5. Refit duration estimates, one weekday per week (§7.4).
6. Send digests (§8.5).

The 5-minute tick is gated. Open PR #566 schedules it behind an allow-list
that defaults to extraction jobs only. This design does not depend on the tick.
Real-time behaviour comes from creating and closing items inline in the
handlers.

### 8.7 The deal room

One screen per opportunity (or per order when there is no opportunity):

- **Header.** Account, parties, owner, value, stage, committed date, P50 and
  P90 at site, float, and money at risk without a PO.
- **The ladder.** Opportunity, quotes (both `quotes` and `opportunity_quotes`,
  labelled as different objects), customer PO, sales order, internal SOs,
  supplier RFQs, source POs, shipments, invoices and payment. Each rung shows
  its linked objects with owner, date and status.
- **Gates** with basis, exposure, approver and expiry.
- **Open items by team,** blocked and waiting first.
- **The schedule** for the subject, with the critical path.
- **One activity feed** merged from `audit_events`, `processing_events`,
  `communications` and `work_item_events`. This generalises `ThreadDrawer.tsx`.
- Every internal role can open it through the `work` MATRIX row. Cost fields
  need `cost.view`.

---

## 9. Field-by-field mapping

Each field of the kickoff template, by block, and where it lives in Anvil.

| Block | Template field | New home | Kind |
|---|---|---|---|
| Header | Project code (year, region letters, typed serial) | `projects.project_code`, generated from `work_counters`; the old code in `projects.legacy_code` | generated |
| Header | Purpose (seven project types) | `projects.project_type_key` to `project_types` | link |
| Header | Requested person | `projects.requested_by` (user) | link |
| Header | Requested date | `projects.requested_at` (server time) | system |
| Parties | Customer who issues the PO | `project_parties` role `buyer` to `customers` | link |
| Parties | Principal customer whose plant gets the equipment | `project_parties` role `end_customer` to `customers` and `customer_locations` | link |
| Parties | Project name | `projects.project_name` | typed |
| Parties | Type of customer: two checkboxes | `customers.customer_type` of each party | link |
| Parties | Integrator or line builder | `project_parties` role `integrator` | link |
| Parties | Customer's country, and "other country" | `customers.country` | link |
| Parties | Salesperson | `opportunities.owner_id`; `projects.owner_user_id` | user |
| Parties | Region, and "other region" | the end customer's `customer_locations` row (city, state) | link |
| Parties | Sales manager | approver role on gates; the deciding user in `work_gate_decisions.decided_by` | role |
| Notes | Free-text notes and the real scope | `project_scope_lines` for scope; comments on the project header item for context | structured |
| Authorisations | Caution note about fees | `work_gate_definitions.description`; fee terms on each decision | data |
| Authorisations | Purpose checkbox 1: kickoff and local design | Gate G1 item and its decisions | gate |
| Authorisations | Purpose checkbox 2: design PO to the source country | Gate G2 | gate |
| Authorisations | Purpose checkbox 3: manufacturing release | Gate G3 | gate |
| Authorisations | Purpose checkbox 4: pre-ordering standard items | Gate G4 | gate |
| Authorisations | "No manufacturing without PO" label | G3 preconditions and mode (D2) | gate |
| Timeline | Special schedule checkbox | Gate G5; `schedule_overrides` | gate |
| Timeline | Expected PO or LOI date | `opportunities.close_date`, then `projects.assumed_po_date` with source; the actual is `orders.po_date` | assumption / fact |
| Timeline | Earliest manufacturing start | `manufacture` stage start in the schedule run | computed |
| Timeline | Manufacturing source country | `project_scope_lines.origin_country` per line, from `sourcing_rules` | rule |
| Timeline | Shipping mode | `project_scope_lines.shipment_mode` per line, from the rule's default | rule |
| Timeline | Design-approval completion target | A customer-approval task with a planned date; baseline `projects.expected_design_final_date` | task / baseline |
| Timeline | Ready date | `manufacture` end, P50 and P90; baseline `expected_ready_date`; actual `shipments.ready_date` | computed |
| Timeline | Packing complete | Folded into `ready_to_depart` (no actual exists) | computed |
| Timeline | Departure (vessel or flight) | `ready_to_depart` end, snapped to a sailing; baseline `expected_shipping_etd`; actual `vessel_sailing_date` | computed |
| Timeline | Arrival (vessel or flight) | `transit` end; actual `port_arrival_date`; promise history `shipment_eta_observations` | computed |
| Timeline | Material dispatch | `clear_and_inland` end; actual `warehouse_receipt_date` | computed |
| Timeline | Custom dates row | `schedule_overrides` with reason and G5 | override |
| Scope | Sixteen family columns | `project_scope_lines.product_family_id`, one row per line | rows |
| Scope | Quantity, new | `change_kind = 'new'`, `qty` | rows |
| Scope | Quantity, modification of existing | `change_kind = 'modification'`, `qty`, `existing_equipment_id` | rows |
| Scope | Part number per family | `item_id` and `part_no`, any number per family | link |
| Scope | Source-origin code per family | `origin_country` and `origin_source` (rule and version) | rule |
| Configuration | Three spec rows | `project_line_requirements` on the line of that family | attributes |
| Configuration | "Part number not provided" messages | `check` items, assigned and auto-closed | items |
| Sign-off | Prepared by | `work_gate_decisions.requested_by` | user |
| Sign-off | Approved by | `work_gate_decisions.decided_by` | user |
| Sign-off | Authorised signatory | `approvals_required = 2` on the gate definition: a second, different approver | role |
| Footer | Template version | `work_templates.version` and `work_gate_definitions.version`; the instance history is `work_item_events` and `schedule_runs` | system |
| Hidden | Country lookup and the broken defined name | Dropped; one reference list of countries | removed |

---

## 10. Phased PRs, in merge order

Each PR is small, ships its caller, and has tests. "DF" means decision-free.
Sizes are S (under a day), M (one to three days), L (more).

The three urgent bugs in §2.5 item 9 are being fixed separately now. WM-4 does
not include them.

### Wave 0: repair the chain (no migration)

| PR | Title | What | Caller | Mig | Size | Decision |
|---|---|---|---|---|---|---|
| WM-1 | The opportunities screen reads what the API returns | Field drift (`title`, `customer_name`, `value`, `owner`, `expected_close_date`), probability shown ×100, real stage KPIs; fix the tests that lock the drift in. Same as #547 PR 6 | `opps.tsx` | none | S | DF |
| WM-2 | Move, assign and lose an opportunity | Stage control with the 409 shown; `owner_id` in the PATCH allowlist through `resolveAssignee`; lost-reason picker. Same as #547 PR 7 | opportunity drawer | none | M | DF with #547 D2 default |
| WM-3 | Close the chain links | Opportunity picker in `NewQuoteModal` and "New quote" in the drawer (#547 PR 8). Write `orders.opportunity_id` in `quotes/convert.js`, `orders/reconcile_quotes.js` and `orders/attach_quote.js`. Offer CLOSE_WON when a PO links | quote modal, SO workspace | none | M | DF for the writes; D15 for the stage offer |
| WM-4 | Chain bug batch | Leads POST and PATCH fields and `account_id`; projects field drift, phase advance control, `related_opportunity_id` on create; internal SO list key (#547 PR 24's screen fix); My Day list key (`home.tsx:34`); orders in statuses that match no Kanban column (after the separate Kanban fix lands) | five screens | none | M | DF |

WM-1 to WM-4 are worth doing even if the owner rejects everything after them.

### Wave 1: the work layer

| PR | Title | What | Caller | Mig | Size | Decision |
|---|---|---|---|---|---|---|
| WM-5 | Work items core | Migration 252. `_lib/work-items.js` (ensure, transition, assign, close), `_lib/work-chain.js`, `/api/work_items` with comments and watchers. Seeded default workflows in code. MATRIX row `work`, server action `work.assign_others`. A Work tab on the opportunity drawer, the SO workspace and the project screen | three screens | 252 | L | D1 |
| WM-6 | My Work on Home | Mine, my role's queue, overdue, blocked, approvals for my role, follow-ups due. Replaces the always-empty queue | `home.tsx` | none | M | DF |
| WM-7 | A notification per user | Migration 253. `recipient_user_id`; bell for every role; recipient mark-read; notices for assign, mention and gate request | `Shell.tsx` bell | 253 | M | DF (in-app only) |
| WM-8 | Items from existing events | `emitWorkEvent` in the handlers: quote approval request, `quote_approvals` rows, touch-log follow-up, agent escalation (an owned item, not only the bell), RFQ due date, source PO sent. Behind `work_items_auto_enabled` with a dry-run count | the handlers | none | M | DF |
| WM-9 | The daily sweep | Overdue and due-soon, quote expiring in N days, delivery at risk (delay rules 7 and 8) | `cron/daily.js` | none | S | DF |
| WM-10 | Deal room, read-only | `/api/deals/room` resolves the chain and merges the feed; the screen of §8.7 without gates and schedule | new route, links from opportunity and SO workspace | none | M | DF |
| WM-11 | Dependencies and blockers | Link add and remove, cycle refusal, the "what blocks this" panel, waiting versus blocked | Work tab, deal room | none (in 252) | M | DF |

### Wave 2: projects and gates

| PR | Title | What | Caller | Mig | Size | Decision |
|---|---|---|---|---|---|---|
| WM-12 | Chain foreign keys | Migration 254: `orders.project_id`, `internal_sales_orders.order_id` and `project_id`, `projects.owner_user_id`, `source_pos.supplier_rfq_id` and `project_id`. RFQ award offers "create source PO" | projects, internal SOs, RFQ award | 254 | M | D5 |
| WM-13 | The kickoff record | Migration 255: `project_types`, `project_parties`, `product_families` (if absent), `project_scope_lines`, `project_line_requirements`, new `projects` columns. The kickoff flow of §5.1, prefilled from the opportunity; the installed-asset picker | "Start project" on the opportunity; project screen | 255 | L | D14 (code format); #547 D5 for the asset registry |
| WM-14 | Sourcing rules | Migration 256. Versioned rules, the resolver, origin and rule version on each line, override with reason, "re-resolve" with a diff, one country list | kickoff scope lines; admin rules editor | 256 | M | DF |
| WM-15 | Gates, advisory | Migration 257: definitions and decisions. Five seeded gates. Request, approve and reject with basis, exposure prefill, fee terms, evidence and segregation of duties. Waiver expiry in the sweep. Money at risk on the project header | project screen, deal room, My Work | 257 | L | D10, D11 (defaults usable) |
| WM-16 | Gate enforcement | The guarded actions refuse with a 409 when a gate is enforced and not approved: project source PO create, EXPECTED_PO internal SO approve. The "would have blocked" report. (The G5 guard on schedule overrides ships with the overrides in WM-18.) | `source_pos/index.js`, `sales/internal_so.js` | none | M | D2 |

### Wave 3: the schedule engine

| PR | Title | What | Caller | Mig | Size | Decision |
|---|---|---|---|---|---|---|
| WM-17 | Calendars and sailings | Migration 258. `work_calendars` with weekend masks; `datemath` takes a mask; `sailing_schedules` with a CSV import; admin screens | admin holidays tab; lead-time screens | 258 | M | DF |
| WM-18 | Schedule engine v1 | Migration 259: routes, stages, estimates, runs, overrides. Deterministic P50 from priors; forward and backward; assumed PO date with markers; float; critical line; order-by items; overrides with reason and the G5 check. This is #540 PR 1 | project schedule tab; deal room | 259 | L | DF |
| WM-19 | Learning from actuals | Fit stage estimates from shipments, source PO ack and receipt, ETA observations and phase actuals; sample floor; sampled P50 and P90; criticality index; weekly refit. This absorbs #540 PRs 2 and 6 | schedule tab ("learned, n = 14") | none | L | D12 |
| WM-20 | Re-plan on actuals | Inline triggers of §7.8; the sweep backstop; float items; delay rules gated by float | handlers; `cron/daily.js` | none | M | DF |

### Wave 4: configuration and views

| PR | Title | What | Caller | Mig | Size | Decision |
|---|---|---|---|---|---|---|
| WM-21 | Templates and automation rules | Migration 260. Seed the stage checks of §6.1 and the project templates; instantiate idempotently; rule editor with the closing-trigger check; dry-run count | admin; project kickoff | 260 | L | DF |
| WM-22 | Configurable workflows | Migration 261. Tenant versions of the task, issue and gate workflows; transition roles and `requires` checks; the status-mapping guard | admin; Work tab transitions | 261 | M | D9 |
| WM-23 | Saved views and the query language | Migration 262. Parser, compiler and whitelist; filter bar that writes the query; list, board and calendar layouts; shared views by role | a Work screen in the nav | 262 | L | DF |
| WM-24 | Custom fields | Migration 263. Definitions, JSONB validation, required-on-status, the promotion rule | Work tab; admin | 263 | M | D7 |
| WM-25 | Timeline | Read-only timeline from items and schedule runs, with `blocks` arrows and the critical path | Work screen layout; project schedule tab | none | M | D8 |

### Wave 5: channels and reports

| PR | Title | What | Caller | Mig | Size | Decision |
|---|---|---|---|---|---|---|
| WM-26 | Email digest and preferences | Daily digest through `sendEmail`; per-kind channel preferences (table in 253) | `cron/daily.js`; profile screen | none | M | D4 |
| WM-27 | Reports | Gate cycle time; money at risk without a PO; overdue by role; P50 hit rate per route stage; assumed versus actual PO date | Sales Ops cockpit | none | M | DF |
| WM-28 | Support cases on work items | A case is a subject; its actions are items; its thread is `work_item_events` | support screens | changes 243 to 247 | M | D6 |

**Dependencies.** WM-5 before everything in waves 1 to 5. WM-13 before WM-14,
WM-15 and WM-18. WM-15 before WM-16 and WM-18. WM-17 before WM-18. WM-18
before WM-19 and WM-20. WM-23 before WM-25. WM-7 before WM-26. Migrations
228 to 251 are applied, or skipped on purpose, before 252.

---

## 11. Migration numbers

The registry, as it stands:

| Range | Owner |
|---|---|
| 228 to 231 | Accounts, assets and portal (#547) |
| 232 to 242 | Tally integration (`TALLY_INTEGRATION_SCOPE.md`) |
| 243 to 247 | Support plan |
| 248 | Gemini fallback model (#562, on main) |
| 249 | Security views |
| 250 to 251 | SO terms and hand-off design (another document) |
| **252 to 263** | **This design** |

| Number | Content | PR |
|---|---|---|
| 252 | `work_items`, `work_item_links`, `work_item_events`, `work_item_watchers`, `work_counters`; `tenant_settings.work_items_auto_enabled` default false | WM-5 |
| 253 | `admin_notifications.recipient_user_id`; `user_notification_prefs` | WM-7 |
| 254 | `orders.project_id`, `internal_sales_orders.order_id`, `internal_sales_orders.project_id`, `projects.owner_user_id`, `source_pos.supplier_rfq_id`, `source_pos.project_id` | WM-12 |
| 255 | `project_types`, `project_parties`, `product_families` (if absent), `project_scope_lines`, `project_line_requirements`; new `projects` columns | WM-13 |
| 256 | `sourcing_rules` | WM-14 |
| 257 | `work_gate_definitions`, `work_gate_decisions` | WM-15 |
| 258 | `work_calendars`, `sailing_schedules` | WM-17 |
| 259 | `schedule_routes`, `schedule_route_stages`, `stage_duration_estimates`, `schedule_runs`, `schedule_overrides` | WM-18 |
| 260 | `work_templates`, `work_automation_rules` | WM-21 |
| 261 | `work_workflows` | WM-22 |
| 262 | `work_views` | WM-23 |
| 263 | `work_field_definitions` | WM-24 |

- **The next free number after this design is 264.**
- All migrations are additive and idempotent: `create table if not exists`,
  `add column if not exists`, constraints inside a `pg_constraint` check, and
  `to_regclass` guards on tables whose apply state is unknown.
- **No enum value is added.** Statuses and categories are text with checks or
  tenant data.
- **They apply by hand.** A merged 252 is not an applied 252. The live
  database was last recorded at 227. Migration 248 is on main, and its apply
  state is not confirmed here. Migrations 228 to 251 must land, or be skipped
  on purpose, before 252 is applied.

---

## 12. Owner decisions

The first eight are the ones the owner named. Each has a recommended default.
The PRs are written against the defaults.

| # | Question | Recommended default | Alternative | Gates |
|---|---|---|---|---|
| D1 | Build or buy? | **Build the thin layer in Anvil.** Items are created and closed by Anvil events and anchored to Anvil objects. A separate tool is a second place to type. #540 §0 and #547 §2.1 already rejected integration | Buy (Jira, Zoho Projects, Asana) only for internal work that has no deal, with no sync. A real integration needs a two-way sync per object type, plus per-seat cost | WM-5 and later |
| D2 | Are gates advisory or enforced? | **The record, the basis and segregation of duties are always enforced.** Blocking is advisory for four weeks with a "would have blocked" report. Then G3 and G4 are enforced. G1, G2 and G5 stay advisory | All advisory. Or all enforced from day one | WM-16 |
| D3 | Teams and roles | **Roles are teams.** Add `logistics` and `service` roles if those people exist today | A `work_teams` table for routing only | WM-5, WM-8 |
| D4 | Notification channels | **In-app bell per user for every role, plus a daily email digest.** Immediate email only for a gate request to its approvers | WhatsApp (exists), push (tick-only today), an email per event | WM-7, WM-26 |
| D5 | Project-to-order cardinality | **One project, many orders.** `orders.project_id`. An order has at most one project. PROJECT_* orders show a warning when they have none | A link table, if one customer PO can cover several projects | WM-12 |
| D6 | Do support cases reuse work items? | **Yes.** A case is a subject. Its actions are items. `work_item_events` replaces `support_case_events`. The support plan's 243 to 247 change shape | Separate tables as the support plan has them | WM-28; the support plan |
| D7 | Custom fields in v1? | **No.** Typed columns only until a tenant names three fields it cannot work without. Then WM-24 | In v1, with the same guards | WM-24 |
| D8 | Timeline and Gantt in v1? | **A list with dates, float and the critical path first. A read-only timeline after the engine (WM-25). No drag-to-reschedule** | A Gantt in v1, with editing | WM-25 |
| D9 | Configurable workflows in v1? | **Seeded defaults in code first.** The tenant editor is WM-22 | Editor in WM-5 | WM-22 |
| D10 | Self-approval in a tenant with one approver | **Refused.** A tenant setting may allow it. Each such decision records `sod_waived` and shows a badge | Always allowed for tiny tenants | WM-15 |
| D11 | What counts as exposure? | **Committed source PO value without a customer PO, plus budgeted design man-days times a tenant rate, plus non-returnable stock for G4.** The approver confirms or edits | The approver types a figure with no prefill | WM-15 |
| D12 | Per-part lead time source | **Infer from source PO acknowledgement against receipt** (#540 Q3) | An `item_master` lead-days column kept by hand | WM-19 |
| D13 | Who may assign work to whom? | **Any writer assigns to anyone. Reassigning someone else's item needs `work.assign_others`** (managers and admin) | Managers only | WM-5 |
| D14 | Project code format | **`PRJ-<year>-<sequence>`, generated per tenant.** Old codes kept in `legacy_code` | A tenant-defined pattern | WM-13 |
| D15 | Does a linked customer PO mark the opportunity CLOSE_WON? | **Propose it, one click.** The stage guard still applies | Automatic on link | WM-3 |

Two decisions from #547 also bear on this design: D2 (what a "manager" is)
for WM-2, and D5 (which installed-base registry) for the asset picker in WM-13.

---

## 13. Risks, and what must not be claimed

### 13.1 Risks

1. **Platform creep.** #540 §5 warns this becomes "Jira with fewer features".
   Guard: every PR names the Anvil event that creates or closes its items;
   configuration is admin-only; the trigger registry is code; no sprints,
   points or timesheets.
2. **Auto-item noise.** The logistics monitor's first run opened about 2,000
   critical rows. Guard: auto-creation is off by default, a dry run reports the
   count first, and every auto item has an auto-close.
3. **Built but not wired.** This repo's habit. Every PR above names its caller.
   A table does not merge without its screen.
4. **Field drift.** Five screens in the chain read fields their API does not
   send, and tests lock some of it in. Verify both sides of every screen.
5. **The tick is not scheduled.** Agent goals, push and the queued-mail reaper
   do not run. #566 would schedule the tick with a narrow allow-list. This
   design avoids the tick: items are created inline and swept daily.
6. **Two approval gates.** Work items make `quote_approvals` visible. They do
   not make the order approve check them. That stays the open question of
   `APPROVAL_DEVIATION_SCOPE.md`.
7. **Two quote objects.** `quotes` and `opportunity_quotes` do not join. The
   deal room shows both and labels them.
8. **Polymorphic ids.** The service role bypasses RLS. Every write checks that
   the subject belongs to the tenant.
9. **Header items drifting from their rows.** Guard: header items copy nothing.
   Facts are read through the view.
10. **Small samples.** A learned P90 from five shipments is noise. Guard: the
    sample floor, and the "prior, not learned" label.
11. **The assumption read as a promise.** Guard: the marker on every assumed
    date, and no assumed date in the portal.
12. **Gates that cannot enforce.** A gate guards only actions inside Anvil.
    Design work in a CAD tool is not stopped. Guard: say so on the gate screen.
13. **Configurable workflows that strand items.** Guard: the editor refuses to
    drop a status in use without a mapping.
14. **Custom fields as a dumping ground.** Guard: no shadow facts, and the
    promotion rule.
15. **The installed base has two registries.** The asset picker depends on
    #547 D5. If the tenant's machines live only in the spare matrix, linking
    adds rows to `equipment_hierarchy` on first use.
16. **Manual migrations.** The live database lags the repo. Each PR's runbook
    checks its prerequisite columns before it ships.

### 13.2 What must not be claimed

- **Not "a Jira replacement" or "a full project-management suite."** No
  sprints, time tracking, resource levelling or portfolio planning.
- **Not "gates prevent unauthorised spend."** They record every decision. They
  block only actions inside Anvil, and only when enforced.
- **No "P90 delivery dates" until a route stage has enough samples.** Before
  that, they are prior estimates and are labelled so.
- **No "critical path" for design work** until design durations are learned or
  entered.
- **No "holiday-aware" for a country** whose calendar is not loaded.
- **No "vessel schedules"** unless sailing data is loaded for the lane.
  Otherwise it is a weekday rule, and it is labelled so.
- **No "learns from your history" before there is history.** Say how many
  observations a figure rests on.
- **No "real-time notifications."** Items are created inline. Sweeps and
  digests are daily. Push needs the tick.
- **No "audit-grade approval trail" for ISO or SOX** until the compliance
  backlog says so. It is a complete internal record, which is a different
  claim.
- **No customer-visible planned date.** Only a date a person committed to
  reaches the portal.
