# Project management in Anvil: the schedule runs through lead times, not tasks

Scoping note, 2026-09-21. Requested after reviewing an open-source task-manager
comparison (Super Productivity, Vikunja, Taskwarrior, Planify, Nextcloud Tasks)
for what could be integrated. Nothing built.

---

## 0. The short answer, and a redirect

**Do not integrate a task manager.** The comparison is a useful negative result:
by its own admission all five tools lack **Gantt, critical-path analysis,
estimates-versus-actuals, and team assignment** (only Vikunja has the last).
They are personal and small-team to-do lists. Bolting one on would add a second
place to type things and would not touch the problem described:

> the planning stage kills time — design, specification confirmation, price
> negotiation, signoff — because not all components in a project share a lead
> time, and long-lead items need preordering.

That is not a task-tracking problem. It is a **scheduling** problem, and the
binding constraint is stated in the sentence itself: *the long-lead item must be
ordered before the design that specifies it is signed off.* A to-do list cannot
tell you that. It can only record that someone said it.

**What Anvil can do that none of those tools can:** it holds the BOM, the
supplier lead times, the working-day calendar, the quote, the PO and the
procurement rail. So it can compute, per component, the **last date an order can
be placed and still hit the customer's date** — and then show which approval is
standing in front of that date. The management object is not a task. It is a
deadline that the data already implies and nobody currently sees.

**And Anvil is much closer to this than it looks.** See §2: the schema for
phases, expected milestone dates, budgeted man-days, actual phase durations and
a responsible owner already exists and has existed for a long time. Almost
nothing reads it.

---

## 1. What the five tools actually offer

| tool | model | licence | why it does not fit |
|---|---|---|---|
| Super Productivity | projects, nested subtasks, per-task time tracking | MIT | local-first single user; explicitly weakest at team use |
| Vikunja | projects, subtasks, Kanban, assignees, **dependencies** | AGPL-3.0 | closest fit, and still no lead-time or critical-path notion; AGPL is a licensing decision in itself |
| Taskwarrior | CLI tasks with dependencies | MIT | terminal only; no calendar, no Gantt |
| Planify | GTK desktop, subtasks, Kanban | GPL-3.0 | Linux desktop app; not multi-team |
| Nextcloud Tasks | CalDAV tasks | AGPL-3.0 | needs a whole Nextcloud; CalDAV has no dependency model |

Two things worth taking as **patterns**, not as integrations:

- **Vikunja's dependency + assignee model** is the right minimum shape for a
  task: predecessor, owner, due date. Copy the shape; do not run the server.
- **Super Productivity's time tracking** is the discipline that makes
  actual-versus-expected possible at all. Anvil's equivalent is cheaper: phase
  timestamps, not a stopwatch.

One thing to reject: **Kanban as the primary view.** A board sorts by status. The
question here is "what is late, and what will make us late", which sorts by
date and by dependency. A board hides exactly the item that has slack but a
twelve-week lead.

---

## 2. What Anvil already has — verified, and more than expected

All of the following exists in the schema today.

**`projects` (migration 006)** already carries the entire *baseline*:

| column | PMP name |
|---|---|
| `current_phase` (`project_phase` enum, 15 values) | WBS level 1 / stage gate |
| `expected_po_release_date`, `expected_design_final_date`, `expected_ready_date`, `expected_shipping_etd`, `expected_delivery_date`, `expected_sop_date` | schedule baseline milestones |
| `budgeted_design_mandays`, `budgeted_install_mandays`, `budgeted_travel_mandays` | effort baseline (planned value) |
| `total_value_inr`, `budgeted_warranty_pct` | cost baseline |
| `status` (ACTIVE / ON_HOLD / COMPLETED / CANCELLED) | project state |

**The `project_phase` enum is not generic** — it is this business, in order:
`INITIAL_INFO → STRATEGY → PROMOTIONAL → RFQ_PREP → BUDGETARY_QUOTATION →
PRICE_NEGOTIATION → LB_FINALIZATION → KICKOFF → DESIGN → APPROVAL_PROCESSING →
MANUFACTURING → SHIPPING → INSTALLATION_COMMISSIONING → PAYMENT_FOLLOWUP →
CLOSED`. The three phases named as the time sink — design, price negotiation,
signoff — are `DESIGN`, `PRICE_NEGOTIATION` and `APPROVAL_PROCESSING`. The model
already knows the shape of the problem.

**`project_phase_log`** already carries the *actual*: `phase`, `started_at`,
`completed_at`, `responsible_user`, `progress_pct`, `remarks`. One row per phase
per project, with an owner and a real duration.

**So baseline and actual both exist, and schedule variance is computable today
from data already stored.** What is missing is that **nothing computes it**:
`sales/projects.js` is CRUD. It writes `expected_design_final_date` and
`budgeted_design_mandays` and no code anywhere reads either for analysis. This is
the fifth instance in one session of the repository's recurring habit — build the
machinery, never wire it.

**The scheduling primitives also exist:**

- `_lib/datemath.js` — `addBusinessDays(start, days, country, holidaySet)`,
  `buildHolidaySet`, `isWeekend`, `earliestEta`. Working-day arithmetic with
  per-country holidays is the genuinely fiddly part of backward scheduling and it
  is already written and in use.
- `_lib/spare-minmax.js` — parses free-text lead times (`"11-12 weeks"`,
  `"6 wk"`, `"30 days"`, `"2 months"`) with a documented `DEFAULT_LEAD_DAYS = 56`
  fallback and long-lead multipliers.
- `supplier_lead_times.lead_days` per (supplier, country, product_category);
  `item_master.network_min_lead_days` (migration 037).
- `bill_of_materials` for the component tree; `inventory/net-req.js`,
  `positions.js`, `eoq.js`, `allocations.js` for a real net-requirement loop.
- `order_schedule_lines` for the customer's dated delivery schedule.

**What genuinely does not exist:**

1. **No task.** `project_phase_log` is phase-grain. There is no object with
   (owner, due date, predecessor, status), and no `(owner + due_date + status)`
   primitive anywhere to borrow — `action_proposals`, `operator_actions`,
   `inventory_exceptions` and `logistics_exceptions` are all domain-specific.
2. **No dependency** of any kind, between phases or tasks.
3. **No per-part lead time.** Lead time is per supplier/country/category or free
   text. A BOM component cannot answer "how long do you take" without a join and
   a guess.
4. **No backward pass.** Nothing works back from a required date to an order-by
   date.
5. **No variance reporting.** No SV, no SPI, no phase-duration history.

---

## 3. The reframe, with the PMP hat on

Classic sequencing says: baseline the scope, then procure. In this business that
is a losing move — if design signoff is three weeks out and the gun body has a
twelve-week lead, waiting for the baseline has already cost the delivery date.
The correct PMP frame is **rolling-wave planning with progressive elaboration**,
and the operational question it produces is the **last responsible moment** for
each component.

For every component on a project:

```
order_by = required_date − lead_days − inbound_transit − inspection_buffer
           (all in BUSINESS days, per supplier country)
slack    = order_by − today
```

`datemath.addBusinessDays` already does that arithmetic. Then:

- **`slack < 0`** — already late. This is the number nobody has today.
- **`slack` lands before the phase that specifies the part completes** — the
  item must be ordered **at risk**, or the project slips. This is the real
  finding, and it is a *decision*, not an alert.
- The **critical path** is the ordered list of components whose `order_by` is
  earliest relative to the approvals in front of them. It is *computed*, not
  drawn.

**The differentiated feature is pricing the "order at risk" decision.** When a
long-lead item must be ordered before its design is frozen, someone chooses
between two costs, usually on instinct:

| choice | exposure | Anvil holds |
|---|---|---|
| order at risk now | scrap / rework if the design changes | component cost, MOQ, the revision history that says how often this part changes |
| wait for signoff | late delivery, liquidated damages, expedite freight | the customer's required date, the LD clause, awarded freight rates |

Anvil has most of both sides already. Surfacing them together turns a gut call
into a documented one — and because `project_phase_log` records who owned the
phase and when it actually finished, the same data says how often signoff
historically slips, which is the honest input to the risk side.

**The compounding asset is learned phase durations.** Once
`project_phase_log.started_at/completed_at` has a few dozen projects in it, the
*expected* dates on the next project stop being typed in and start being
estimated from this tenant's own history — "your DESIGN phase takes 24 business
days at P50 and 41 at P80, and you have budgeted 15." That is the same trick
Anvil already uses for extraction (golden set → learned prompts) and lead times,
pointed at the schedule. It is also, in PMP terms, the only lessons-learned
process that actually runs, because it needs no one to write a retrospective.

---

## 4. What to build, in dependency order

**PR 1 — the backward pass, read-only, no new tables.** Compute `order_by` and
`slack` per BOM component for a project from the existing BOM, lead-time and
calendar data, and show the ordered list. No task model, no writes. Highest value
per line of code in this whole document: it makes the invisible deadline visible
using only data already stored, and it is falsifiable against a project the team
already knows the answer for. **Must refuse rather than guess** — a component
with no resolvable lead time reports `lead_unknown`, not 56 days, following the
house convention (`comparability()` in sales-order-match.js, `dispatchLookup` in
invoice-reconcile.js). A default dressed as an estimate is how a schedule tool
loses trust in week one.

**PR 2 — variance on what is already recorded.** Expected versus actual per
phase from `projects.expected_*` against `project_phase_log`, with schedule
variance and SPI per phase and per project. Still no new tables. This is pure
wiring of data that has been accumulating and is read by nothing.

**PR 3 — the task and the blocker.** One new table, deliberately minimal and
shaped like Vikunja's: `project_tasks` (project_id, phase, title, owner,
due_date, status, predecessor_task_id, blocked_reason, completed_at). Two rules
that matter more than the columns:
- a task may be **derived** from a computed `order_by` date, so the schedule
  generates its own critical tasks rather than waiting to be told;
- **blocked** is a first-class status with an owner and a date, because the
  described problem is blockers held by other teams (design waiting on customer
  spec confirmation, SCM waiting on design).

**PR 4 — the cross-team view.** One screen per project showing the phase ladder,
the component order-by list, and open blockers by owner. Design, sales, SCM and
logistics see the same object; each sees its own overdue items. Reuse the
existing role model (`RBAC`, nav visibility) rather than inventing project
permissions.

**PR 5 — price the at-risk decision.** For each component that must be ordered
before its specifying phase completes, show both exposures side by side. Needs
the LD clause captured, which it is not today — flag as a prerequisite.

**PR 6 — learned phase durations.** Fit P50/P80 per phase from
`project_phase_log` history and offer them as the default `expected_*` on a new
project, labelled as an estimate from N prior projects. Requires PR 2 and enough
history to be honest about; **do not ship it with five projects in the table** —
say how many it is based on, and refuse below a floor, the way
`three-way-summary.js` refuses below `MIN_DECIDABLE_FOR_CONFIDENCE`.

---

## 5. What not to build

- **A Gantt chart, at least not first.** It is what gets asked for and it is a
  rendering of the answer, not the answer. PR 1's ordered list with slack is more
  useful on a phone and far cheaper. Revisit after PR 3.
- **Timesheets.** Full earned-value needs actual man-days, and asking four teams
  to log hours is a behaviour change that will fail quietly and poison the data.
  Phase timestamps are already captured as a by-product of working. Use those.
- **A generic work-management platform.** Every column that is not specific to
  lead-time-driven delivery makes this Jira with fewer features.
- **Integrating any of the five tools.** None models a dependency on a lead time,
  which is the only dependency that matters here.

---

## 6. Open questions

1. **Who owns a phase transition today?** `project_phase_log.responsible_user`
   exists; is it populated, or is the phase moved by whoever happens to open the
   screen? PR 2's variance numbers are only as good as the phase timestamps, and
   a phase closed retroactively in a batch is worse than no data.
2. **Is the customer's required date reliable, and where does it live?**
   `projects.expected_delivery_date` or `order_schedule_lines`? The whole backward
   pass hangs off it, and if it is aspirational rather than contractual the slack
   numbers are fiction.
3. **Per-part lead time: captured or inferred?** A supplier-and-category lead time
   is too coarse for a twelve-week casting beside a two-week fastener from the
   same vendor. Options are an `item_master.lead_days` column populated from
   quotes and acknowledgements, or inferring it from `source_pos`
   acknowledged-ETA versus actual receipt. The second is better data and needs no
   data entry — which also makes it the slower one to become useful.
4. **How often does a design change after an at-risk order?** This sets whether
   PR 5 is a real decision aid or theatre. The BOM revision history may already
   answer it.
5. **Do LD clauses exist in a field anywhere?** Needed for PR 5's cost side.
   Suspected to live only in contract PDFs.
