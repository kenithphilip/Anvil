# Sales order execution: one record, one stage, one worklist

Design document, 2026-10-16. Docs only. Nothing is built.

- **Base.** `main` at `80cd8151` (2026-10-16). File references are
  `path:line` at that commit. Migration references are `NNN:line`. PR #610
  (open, docs only) adds the Makeflow review to the gap analysis as §3.34.
- **Inputs.** Five code traces: the front of the journey, the back of the
  journey, navigation, work and collaboration, and notifications. A verifier
  re-read each trace and corrected it. Four readings of the gap analysis. The
  prior plans named below. Three design proposals, one per lens: one surface,
  methodology, and agent first. Critics reviewed the first draft, and this
  version fixes what they found.
- **Names used here.**
  - This plan's recommendations are R-U1 to R-U6 (UX), R-F1 to R-F9 (feature
    set) and R-M1 to R-M6 (methodology). Its PRs are C-1 to C-38. Its owner
    decisions are C-D1 to C-D32. OPS-1 to OPS-3 are operations checks. DISC-1
    is a discovery task.
  - A-PRn, A-Dn and audit-Fn come from the SO processing UX audit
    (2026-10-14, `docs/SO_PROCESSING_UX_AUDIT.md`). T-PRn and T-Dn come from `SO_TERMS_AND_HANDOFF_SCOPE.md`.
    WM-n and WM Dn come from `WORK_MANAGEMENT_SCOPE.md`.
  - "PR 16" always means the handoff send (`SO_TERMS_AND_HANDOFF_SCOPE.md` §8
    and §10). The audit uses the same number. "A-PR14" is the audit's internal
    notifications PR. The code comments call it "plan PR 14".
  - Section 6.10 maps every C-PR to the prior plan item it builds.
- **Live database.** Migrations up to 227, plus 248, 250 and 251. Reserved and
  not applied: 228-231, 232-242, 243-247, 249, 252-263, 264 and 265. This plan
  writes one new migration, 266. A number from 267 up is used only if a check
  or a decision in section 8 needs it.
- **House rules used here.** Something built but never wired counts as not
  built. Every PR ships its caller. State is derived from records, never from a
  hand-set field. The server holds the rules, not the screen. Migrations apply
  by hand, so merged is not applied. Roles are named, people are not.

---

## 0. Summary

1. **Diagnosis.** Most parts exist, but nothing carries the order between
   people. An order has no holder, no state after approval in Mode B, and no
   signal to the next person, so every handoff waits for someone to poll one of
   eight lists.
2. **Counts.** One order touches about 20 screens. There are 8 order lists
   with different columns, 4 ways to approve, a workspace with up to 15 tabs,
   and 6 intake surfaces, one of them broken. A sales engineer sees about 49
   nav items. 3 handoffs are silent. 13 links dead-end. 25 of 68 resolution
   options cannot be recorded. No review, approval, return or handoff event
   notifies anyone. Only a failed Mode A ERP push writes an admin bell row.
3. **Collaboration today.** There is no task, comment, mention, watcher or
   order owner. The work layer (migrations 252-263) is designed only. What
   exists is pull-only: the approvals queue, the exceptions list, the register,
   a read-only timeline and tenant-wide nav badges. A phone has no bell at all.
   External task tools were evaluated and dropped (#540). The real incumbent is
   email, WhatsApp, phone calls, Excel and Tally.
4. **The plan.** Three lenses gave 42 proposals. They merge into 21
   recommendations and 38 small PRs. Phase 0 and two parallel tracks are
   committed: Track A (stage and worklist) and Track B (handoff and notices).
   Phases 3 and 4 are provisional, and the shadow-week numbers re-rank them.
   Phase 5 waits for the pilot exit bar. One new migration (266). Three
   reserved numbers are reused (253, 264, 265).
5. **Move 1: put the approval rules on the server (Phase 0).** C-1 makes the
   stale-approval 409 fire for quote-priced orders. C-2 stops the background
   writeback from replacing reviewed lines, and needs C-D1. C-3 makes the
   server refuse a move that an exception blocks. C-3 is preventive: the one
   blocker enforced only in the browser is a critical terms row, and terms
   checking is off for every tenant.
6. **Move 2: run the Mode B lane as a pilot from day one (Phase 0).** A
   readiness card, a pilot nav, a baseline (A-PR1), and half a day of discovery
   with the pilot team: how the clerk works, whether a Tally bridge exists,
   whether the clerk has a seat, and which channel each role answers on. An SO
   PR counts as done only when it is applied, on for the pilot, used by a role,
   and its metric moved.
7. **Move 3: one derived stage and a real end for Mode B (Track A).** A pure
   `order-stage.js` reads records that already exist. "Keyed in ERP" comes from
   the first evidence Anvil gets, in a fixed order: a bridge voucher, the
   clerk's reply, a dropped Tally SO PDF, or a manual exit with a voucher
   number. The three-way check runs by itself. No status value is added.
8. **Move 4: the handoff and per-person notices, in parallel (Track B).** The
   handoff is the audit's top friction (about 6 minutes on every Mode B order)
   and an explicit ask from the first customer. It is sent from the order, on a
   direct rail, and it refuses rather than queue when no mail provider exists.
   A per-user bell (migration 253) reaches every role, on desktop and phone.
9. **Move 5: one worklist per person and one shared list (Track A).** Home,
   and the My Day tab on a phone, become "Waiting on me" and "Waiting on
   others". The Register gets role views. The owner is derived from live data
   until migration 265.
10. **Next 10 working days.** Six decision-free PRs (C-1, C-3, C-4, C-5, C-6,
    C-7), three operations checks, the discovery, and one sitting on C-D1 to
    C-D15 (section 6.1).
11. **What we cut.** WM-5 and most of the work layer leave the sales order
    path. No new status values. No operator actions for the keying step. No
    Slack or Teams to staff. No agent applies anything before the server
    guards, the Controls record and a shadow period.
12. **Decisions.** 32 owner decisions, each with a default, plus three
    operations checks and one discovery task. Only C-D1 to C-D15 are needed in
    the next two weeks.

---

## 1. Why it feels fragmented

### 1.1 The verified journey

One Mode B order, from PO to cash, as the code runs it at `80cd8151`. "Context
switches" counts screens, tabs and tools left and re-entered for that step.

| # | Step | Team | Screen | Actions | Context switches | How the next person learns | Status |
|---|---|---|---|---|---|---|---|
| 1 | PO arrives by upload | Sales engineer | Inbox, then SO intake | About 4: mode, customer, file, continue | 2 | Same person continues | Live |
| 2 | PO arrives by email or WhatsApp | System, then sales engineer | Inbox row, then workspace | About 5: open, run extraction, pick customer by hand | 3 | Inbox list and badge only | Depends on the 5-minute tick, ClamAV and provider secrets; legacy paths create a DRAFT with no customer |
| 3 | PO promoted from Email Triage | Sales engineer | Email Triage | 1 click | 1 | Nothing | Broken: "Promote" makes a blank DRAFT, "Attach" is dropped, both toast success |
| 4 | Extraction | System | Intake banner, workspace strip | 0 | 0 to 1 | Toast, only while the order is open | Live up to 40 pages; the background drain needs the tick |
| 5 | Customer match | Sales engineer | Intake, identity dialog, Customers screen | 0 to 4 | 3 | Nothing needed | Partial: document tiers run in the browser only |
| 6 | Item mapping | Sales engineer | Workspace line grid | About 3 per unmapped line | 2 | Nothing needed | Partial: runs on create and on a customer change only, not on re-extraction or the background writeback |
| 7 | Quote reconcile and anomaly check | System | Strip, banner and card on one screen | 0 | 0 | Rows on the card | Live |
| 8 | Resolve exceptions | Sales engineer | Review and decide, plus up to 5 tabs and Customers | 3 or more per row | 6 | The approver sees rows only if they open the workspace | Partial: the card is read-only |
| 9 | Delivery date and contact | Sales engineer | Header fields tab | About 4 | 2 | Nothing | Partial: the PO date comes mostly from a 5% canary that is off by default |
| 10 | Terms check | Sales engineer, manager | Terms tab | 2 to 3 per flag | 1 | Nothing | Dormant: `terms_check_mode` is off |
| 11 | Send for approval | Sales engineer | Next-step bar or Kanban drag | 1 | 0 | Tenant-wide badge only | Live; the server checks no send blocker |
| 12 | Approve or return | Approver | Queue drawer, header, bar or Kanban (4 paths) | 2 to 3, plus 1 to see exceptions | 2 to 3 | Return: a banner when the engineer reopens. Approve: nobody | Live |
| 13 | Hand off to order processing | Sales engineer to clerk | None: download SO, mail client | About 6, outside Anvil | 3 | An email sent outside Anvil, if sent | Designed only (PR 16) |
| 14 | Key the SO into Tally | Clerk | Tally | Every line, about 5 fields each | 2 | Nothing | Manual by design; no Anvil state |
| 15 | Verify the ERP SO three-way | Clerk or engineer | Find order, open, PO vs ERP tab | About 5 | 4 | Register "ERP SO" column only | Live, but writes no state |
| 16 | Raise the source PO | Procurement | Source POs | About 8 fields; no lines copied | 2 | Nothing | Partial: receiving then fails |
| 17 | Ship, challan, e-way bill | Logistics, stores, finance | Shipments, Invoice vs PO tab, e-Way Bills | 16 fields with 2 UUID pastes; 1 more UUID | 4 | Nothing | Partial |
| 18 | Invoice and collect | Finance | Tally in Mode B; Invoices | About 5 | 2 to 4 | Nothing | Partial: the Mode B invoice lives in Tally |
| 19 | Close the order | Anyone | None | None possible | 0 | Nothing | Missing: the order stays APPROVED |
| 20 | Find what is next, and whose turn | Every role | 8 order lists | 1 click per order | 8 | Nothing | Partial: no list shows next step or owner |

A clean Mode B order needs about 13 context switches from PO to a verified ERP
entry. An order with exceptions needs about 25. The approver hears about the
order out of band. The clerk gets the SO by email from someone's mail client.

### 1.2 The five worst seams

1. **A Mode B order has no state after approval.** `order_status` ends at
   RECONCILED and CANCELLED (`supabase/migrations/001_init.sql:118`). APPROVED
   can move only to EXPORTED_TO_TALLY, FAILED_TALLY_IMPORT, CANCELLED or DRAFT
   (`src/api/orders/[id].js:62`). Mode B takes none of those. The next step is
   a disabled "enter the SO in Tally by hand"
   (`src/api/_lib/order-next-step.js:120`). Attaching the Tally SO writes no
   state (`src/api/orders/attach_sales_order.js:104`). Home counts APPROVED as
   done (`src/v3-app/screens/home.tsx:42`) but keeps the same order in "My
   queue" (`home.tsx:82`). The stepper never completes
   (`src/v3-app/screens/so-workspace.tsx:2714`).
2. **Every handoff is silent.** Send, approve and return write audit rows only
   (`src/api/orders/[id].js:398`, `:418`). The bell holds one tenant-wide row
   (`src/api/_lib/notifications.js:62`). It renders only for admin and operator
   (`src/v3-app/components/Shell.tsx:600`), and only admin can mark it read
   (`src/api/admin/notifications.js:43`). A phone has no bell: the mobile shell
   has four fixed tabs and More (`src/v3-app/components/MobileShell.tsx:12`).
   The code comments defer notices to "plan PR 14" (`so-workspace.tsx:835`,
   `approvals.tsx:329`). That is A-PR14 in the audit numbering, blocked on
   A-D5. WM-7 (migration 253) designs the per-user bell. Neither is built. The
   handoff send does not exist (`src/api/admin/order_handoff_settings.js:18`).
3. **The approval guard has holes.**
   - PATCH stops recomputing the payload hash once an order is quote-derived
     (`src/api/orders/[id].js:276`). The reconcile writes `quote_id` on every
     scanned PO that matches a quote (`src/api/_lib/order-reconcile.js:348`).
     So the stale-approval 409 (#605) never fires for a PO priced from a
     quote. How many pilot POs that covers is not measured.
   - The background writeback replaces lines with no status check and keeps
     the approval (`src/api/cron/extraction_jobs.js:782`, `:796`). Nothing
     blocks send or approve while a job is in flight, so a page-1 preview can
     be approved.
   - The server checks no exception on submit (`[id].js:63`) and only
     `rule_findings` on approve (`[id].js:224`). The `-MOD` finding lives in
     `rule_findings` with `blocks: true` (`order-reconcile.js:302`), so the
     server already refuses it, a Kanban drop included
     (`src/api/_lib/blocking-findings.js:23`). Only its fallback row
     (`order-exceptions.js:709`) is browser-only. The one blocker enforced in
     the browser alone is a critical terms row (`order-exceptions.js:959`).
     Terms checking is off for every tenant (`250_order_terms.sql:203`), so
     that row does not exist today. The Kanban hole opens when terms checking
     is set to on.
4. **Exceptions are listed but cannot be resolved where they are listed.** Each
   row has one link that jumps to another tab
   (`src/v3-app/components/OrderExceptionsCard.tsx:108`). 25 of 68 options have
   no record (`order-exceptions.js:118`). The "update master" fix points to a
   dialog the workspace cannot reach (`order-exceptions.js:148`). The
   approver's drawer shows the customer, reason chips, the submit note and 30
   lines, and no exceptions (`src/v3-app/screens/approvals.tsx:136`).
5. **No order has a holder, and no list is shared.** The orders table has no
   owner, creator or assignee (`001_init.sql:134`). "Mine" means "orders I
   approved" (`src/v3-app/screens/orders.tsx:75`). Home loads 50 orders, shows
   the 8 newest, and calls the newest "oldest" (`home.tsx:64`, `:82`, `:138`).
   The nav badge is tenant-wide, from the newest 200 orders
   (`src/v3-app/lib/telemetry.ts:89`, `:196`). Eight lists carry different
   columns and none shows the next step.

Also verified: 13 dead ends. Examples are the Shipments tab placeholder
(`so-workspace.tsx:3444`), UUID fields on Shipments (`shipments.tsx:622`, `:625`)
and e-Way Bills (`eway-bills.tsx:158`), a Source PO that copies no lines
(`src/api/source_pos/index.js:66`), Pending rows with no link
(`pending-sos.tsx:146`), and "New invoice" that lands on the full list
(`so-workspace.tsx:1314`).

### 1.3 Why the seams exist: how features ship

The seams are not only design. They come from how SO features have shipped. A
PR counts as done when its code merges. The feature then waits on something
that nobody tracks:

- **A flag that defaults to off.** Terms check (`250:203`), handoff (`251:58`),
  operator actions (`150:12`), logistics monitor (`206:93`), dispatch register
  auto-send (`205:12`), the PO-date canary (`218:42`) and the SO agent
  (`210:21`).
- **A send that was never built.** The handoff exists as settings only.
- **An engine with no caller or no clock.** Operator actions, the dispatch
  register and web push. The 5-minute tick is the opposite case: no repo file
  schedules it (`vercel.json:12`), but an external trigger calls it, so every
  tick handler runs today, defects included, and nothing in the repo shows it.
- **A migration that is planned but not written.** 264 and 265 hold the
  decisions table and the order assignment.
- **An open owner decision.** All 13 audit decisions and most terms decisions
  are still open.

Each of these leaves a seam a user falls into. The method fix is R-M5: an SO
PR is done only when its migration is applied, its flag is on for the pilot, a
role used it in production, and its metric moved. R-M6 applies the same rule to
the work layer.

---

## 2. What exists for project management and collaboration on a sales order

Buying or integrating an external task tool was evaluated and dropped
(`PROJECT_MANAGEMENT_SCOPE.md` §0 and §5, #540). None of the five tools
reviewed models a dependency on a lead time, and none attaches work to an
order. The incumbent this plan must beat is what the pilot team uses today:
email, WhatsApp groups, phone calls, Excel trackers and Tally. The traces see
that only from the outside, because every handoff in section 1.1 leaves Anvil.
DISC-1 records it per role.

**The work layer is designed only.** `WORK_MANAGEMENT_SCOPE.md` designs work
items, links, events, watchers, per-user notices and a deal room on migrations
252-263. None of those migrations exists in the repo. No open PR builds them.
Only Wave 0 (WM-1 to WM-4: #579, #590, #581, #588) merged, and it repaired the
opportunity chain without adding any work object.

| Capability | Status | Attaches to order? | Evidence | Limit |
|---|---|---|---|---|
| Tasks or to-dos | Missing | No | `docs/WORK_MANAGEMENT_SCOPE.md:3` | Nearest substitutes are machine goals and the extraction review queue |
| Work layer (items, links, events, watchers, gates) | Designed only | As designed | `WORK_MANAGEMENT_SCOPE.md:1449` | Migrations 252-263 not written; WM-5 waits on WM D1 |
| Owner or assignee on an order | Missing | No | `001_init.sql:134`, `orders.tsx:75` | A return records a role name, not a person (`approvals.tsx:337`) |
| Account owner on the customer | Live | One join away | `227_customer_owner.sql:32`, `src/api/customers/owner.js:19` | No order code reads it |
| Opportunity owner | Live | One join away (`orders.opportunity_id`) | `src/api/sales/opportunities.js:219` | Only `shipment_tracking.js:145` reads it downstream of an order |
| Quote and project owner | Partial | No | `068_quotes_object.sql:73`, `006_corpus_alignment.sql:480` | Creator stamps only; projects have no order FK |
| Notes on an order | Partial | Yes, on status changes | `so-workspace.tsx:1065`, `104_orders_return_for_correction.sql:25` | The submit note is one slot that the next send overwrites |
| Comment log (rep touch) | Partial | No | `src/api/_lib/rep-touch.js:24` | Quotes and opportunities only |
| Mentions and watchers | Missing | No | `WORK_MANAGEMENT_SCOPE.md:187` | Nothing |
| Order timeline | Live, read-only | Yes | `so-workspace.tsx:610`, `ThreadDrawer.tsx:156` | Two timelines; Activity drops the actor; nobody can post |
| Bell (admin notifications) | Partial | Only a failed Mode A ERP push (`erp-runner.js:123`) | `notifications.js:62`, `Shell.tsx:600` | One tenant row; admin and operator only; operator cannot mark read |
| Mobile shell | Live | Through its tabs | `MobileShell.tsx:12`, `:120` | Four fixed tabs plus More; nav visibility can hide a tab but not add one; no bell |
| Nav count badges | Live | Counts only | `telemetry.ts:89`, `:196` | Tenant-wide; newest 200 orders; only while the app is open |
| Web push | Dormant | No | `src/v3-app/lib/push.ts:37` | No subscribe UI, no public-key route, no producer; drain in the tick |
| Direct email to staff | Partial | No | `src/api/_lib/mailer.js:32` | Password reset and welcome only |
| Role-to-address resolver | Built | Not used for orders | `src/api/_lib/internal-recipients.js:127` | Only caller is the handoff settings preview; email only, no phone |
| Queued mail reaper | Dormant | No | `src/api/agents/run.js:276`, `:358` | Hourly tick, tenants with a due goal only; rows with no address fail |
| Copilot "draft and send" | Built, manual | Yes (`order_id`) | `src/api/_lib/erp-chat-tools.js:729`, `src/api/copilot/confirm.js:59` | Delivers only if a mail provider is configured (unverified); needs `approve` (`confirm.js:105`); Teams rows are marked sent with nothing sent |
| Mode B handoff | Partial (settings only) | Columns exist | `251_order_handoff.sql:58`, `order_handoff_settings.js:18` | No send, no status writer; the register shows "not sent" |
| Tally bridge read-back | Dormant without a bridge | No in Mode B; it updates only vouchers Anvil pushed | `src/api/tally/sync.js:188`, `cron/tick.js:109`, `016_tally_v2.sql:163` | Needs a bridge and the tick; stores each voucher's raw payload; no PO reference column |
| Approvals queue (#603) | Live | Yes | `src/api/admin/quote_approvals.js:163` | Tenant-wide, no role filter (`:168`); shows age, never escalates |
| Exceptions list (#600) | Live per order | Yes | `order-exceptions.js:14` | No owner, role or due field; 25 of 68 options not recordable |
| Next-step function (#602) | Partial | Yes | `order-next-step.js:120` | One caller; ends disabled in Mode B; names a role, not a person |
| Home "My queue" | Partial | Yes | `home.tsx:82` | Not per user; capped at 8; keeps approved Mode B orders |
| Order Kanban | Live | Yes | `pipeline-kanban.tsx:61` | Status columns to Push only; operator cannot open it (`rbac.ts:72`) |
| Extraction review claim | Live | Indirect | `src/api/docai/review_queue.js:108` | The only claim flow; a resolve does not close the order's row |
| Operator action checklist | Dormant | Can bind to an order | `150_operator_actions.sql:12`, `src/api/_lib/operator-actions.js:30` | Flag off; no screen calls it |
| Agent goals (16 handlers) | Dormant | Some types | `src/api/agents/_handlers/index.js:45` | Only quote send arms goals automatically (two quote types, `quotes/send.js:60`, `:70`); the rest are armed by hand; hourly tick; escalates to the admin bell |
| Logistics exceptions with SLA and owner | Dormant | `object_type` can be order | `206_logistics_monitor.sql:59`, `:93` | Monitor flag off; nothing writes the owner |
| Delay scan | Partial | Yes | `src/api/delays/scan.js:44` | Computed on page load; writes nothing; alerts nobody |
| Downstream chain on the order | Designed only (WM-10) | FKs exist | `001_init.sql:179`, `[id].js:101` | `include=sourcePos` has no caller; the Shipments tab is a link |
| Internal SO, projects | Partial | No FK | `006_corpus_alignment.sql:340`, `:480` | Joins only through the opportunity |
| Digest email | Designed only | No | `WORK_MANAGEMENT_SCOPE.md:1258` | Needs the work layer |
| WhatsApp, Slack, Teams to staff | Missing | No | `src/api/_lib/comms-send.js:80` | No staff phone number is stored; Teams returns success without sending |
| Turnaround metrics | Live | Aggregate | `src/api/analytics/ops_kpis.js:1` | Created to approved only; no stage after approval |
| SO register (#577) | Live | Yes | `src/api/orders/register.js:15` | A record, not a work list; no "approved, no ERP SO" filter |

---

## 3. Lessons from the gap analysis that change a recommendation

Only lessons that changed a recommendation are listed. "Changes" names the
recommendation in section 5. Section numbers refer to `GAP_ANALYSIS.md` unless
another document is named.

| Lesson | Competitors | Section | Kind | Applies to step | Changes |
|---|---|---|---|---|---|
| Every alert carries the action that resolves it, run in place, including the outbound ask to the customer | Ekho Labs, Comena | §3.26; IMPROVEMENT_PLAN 4.2 | UX | Verification | R-U3 |
| One approval per order, with margin and risk at the decision point | Waybill, Gainfront | §3.28, §3.32 | UX | Approval | R-U4 |
| Land each role on its own queue, and rank exceptions, not orders | Pactle, Comena | §3.5, §3.6 | UX | Every step | R-U1, R-U2 |
| Decide where people are: approvals and handoffs must work on a phone and in the channel the team reads | Makeflow, Korso | §3.34, §3.2 | UX | Approval, handoff | Mobile criteria in C-8, C-14, C-17, C-25; C-D16 |
| Show only server-confirmed status; deep links carry every handoff | (AUDIT_2026_05_07) | Round 2, §B | UX | Every step | R-U6 |
| "Keyed in the ERP" is a verified state, read back three-way with the PO as authority, and every stuck state has a manual exit | Comena, Makeflow | §3.6, §3.34 | Feature | Handoff to ERP | R-F2 |
| Hand work over as an owned task closed by evidence, and tell the next owner | Gainfront, Pactle | §3.32, §2 | Feature | Every handoff | R-F3, R-F5 |
| The SO is the one record every downstream module resolves to | Ekho Labs, Gainfront | §3.26, §3.32 | Feature | Procurement to invoice | R-F7 |
| Derive status from evidence, enforce policy on the server, and ship policy defaults (the buy side already chose 2% price, 0 quantity) | Peer Freight, Naïve, Gainfront | §3.28-3.29, §3.23, §3.32 | Methodology | Every step | R-M1, R-F1, R-M2 |
| Pilot one lane against a written exit bar; "done" means used; shadow before apply; measure time in each state | Makeflow, Ekho Labs | §3.34, §3.26, §10 #5 and #7 | Methodology | Onboarding | R-M4, R-M5 |
| Put the shared deadline on the order, not in a task manager, and plan in journey slices | (gap analysis, IMPROVEMENT_PLAN) | §10 #2; IMPROVEMENT_PLAN §3 | Methodology | Planning | R-M6, section 6 |

---

## 4. The target execution model

An order moves on one spine. Each stage is computed on the server from a record
that already exists, and every screen reads the same answer. Each stage has a
holder role, an exit record and a clock. When the stage changes, the next
holder gets a notice that opens the exact order, tab and exception, on a
desktop or a phone. Each person starts the day from one worklist, and the team
shares one Register. In Mode B the clerk still keys the order into Tally. Anvil
learns that the order was keyed from the first evidence it can get, in a fixed
order, and checks the entry against the PO by itself once it has the Tally SO. A
revised PO amends the order and sends it back through the spine. The agent
reads the same exceptions list and the same stage as people do. It drafts
first, and it applies only what the tenant's Controls record allows, after a
measured shadow period. The pilot lane ends at "Verified in ERP". Later stages
show when their records exist.

```
 Stage            Holder (role)       Exit record (evidence)                        Clock
 ---------------  ------------------  --------------------------------------------  -------
 Received         system              order row; extraction job done                minutes
 Verifying        sales engineer      status PENDING_REVIEW (submit audit row)      target
   (returned)     the submitter       correction_reason set by a return
 In approval      approver_role       approved_at (approve audit row)               target
 Approved   ---+  sales engineer      handoff_status = 'sent'                       target
 Handed off <--+  clerk               first of, in this order:                      target
                                        1 bridge voucher with the buyer's PO no.
                                        2 clerk's reply with the voucher no.
                                        3 Tally SO PDF dropped or attached
                                        4 manual exit: voucher no. and reason
   (C-D11 may put "Handed off" before "Approved". "Keyed" needs both.)
 Keyed in ERP     sales engineer      three-way run on an attached Tally SO         target
   (evidence 1, 2 or 4 shows "Keyed, unverified" until a PDF arrives)
 Verified in ERP  none (pilot done)   three-way clean; tally_status 'reconciled'
 ---------------  later lanes, read-only from records that already join --------
 Sourced          procurement         source_pos.order_id acknowledged
 Dispatched       stores, logistics   dispatch_lines or shipments.order_id
 Invoiced         finance             invoices.order_id or uploaded ERP invoice
 Paid, Closed     finance             payment recorded

 Revision rule (C-D2):
   A revised PO with the same PO number amends the order; it is not a new one.
   Any line change clears the approval ([id].js:245) and the stage returns to
   Verifying. A sent handoff shows "changed since handoff", and re-send is the
   next step. A keyed entry must be verified again against the new lines.
   Until C-32 links a revised PO to its order, the engineer does it by hand.

 Around every stage:
   Agent      reads /api/orders/exceptions and the stage; drafts the handoff,
              customer emails and decisions; shadow, then propose, then apply;
              never keys Tally, never accepts high terms, never sends unasked.
   Notices    stage change -> per-user bell row, desktop and phone;
              direct email for gate requests; a second channel per C-D16.
   Sweep      cron/daily: age in stage against the target -> holder -> manager.
   Worklist   Home and My Day: "Waiting on me", "Waiting on others";
              Register role views.
```

`orders.status` keeps its current meaning: the approval state, plus the Mode A
push states. The stage is a read model. Mode A reads EXPORTED_TO_TALLY as
"Keyed in ERP" and RECONCILED as "Verified in ERP".

---

## 5. Recommendations

Appendix A records which lens proposed each recommendation. Appendix B records
the conflicts between the lenses and how they were resolved. Defaults are
stated once, in section 8, and referenced here by decision number.

### 5.0 Order and confidence

Impact and confidence are judgments, not measurements. The shadow-week numbers
re-rank everything from Phase 3 on.

| ID | Recommendation | Impact | Confidence | Effort | Where |
|---|---|---|---|---|---|
| R-F1 | The server holds the approval rules | High | High | M | Phase 0 |
| R-U6 | Show only what the server confirmed | Medium | High | S | Phase 0 |
| R-M5 | Pilot one lane, readiness card, discovery, definition of done | High | High | S | Phase 0 |
| R-M4 | Measure the fragmentation | Medium | High | M | Phase 0, Phase 4 |
| R-M6 | Attach a thin, order-first slice of the work layer | High | High | S | Plan change |
| R-M1 | One derived stage | High | High | M | Track A |
| R-F2 | "Keyed in ERP" is a verified state | High | High | M | Phase 0, Track A |
| R-U1 | Home and My Day become "my next actions" | High | High | M | Track A |
| R-F4 | An owner and a holder for every order | High | Medium | S, then M | Track A, Phase 5 |
| R-U2 | One Register with role views | Medium | High | M | Track A |
| R-F3 | The handoff, sent from the order | High | Medium | M | Track B |
| R-F5 | Tell the next holder, where they will see it | High | High | M | Track B |
| R-M2 | One Controls record and an autonomy map | High | Medium | M | Phase 3 |
| R-U3 | Resolve exceptions on the card | High | Medium | L | Phase 3 |
| R-U4 | One approval panel | High | Medium | M | Phase 3 |
| R-U5 | Six panels and one timeline | Medium | High | M | Phase 3 |
| R-M3 | A clock on every stage hold | Medium | Medium | M | Phase 4 |
| R-F7 | The order shows its chain | Medium now, high later | High | M | Phase 4 |
| R-F6 | One intake front door | High | Medium | M | Track A (C-16), Phase 4 |
| R-F9 | Float on each SO line | High later | Low | M | Phase 5 |
| R-F8 | Agent drafts back-to-back source POs | Medium | Low | M | Phase 5 |

### 5.1 UX

#### R-U1. Home and My Day become "my next actions", built from every open order

- **Problem.** `nextStep()` has one caller, inside one order
  (`so-workspace.tsx:2071`). `GET /api/orders/exceptions` takes one `?id=`.
  Home "My queue" is the 8 newest of the latest 50 orders, labelled "oldest"
  (`home.tsx:64`, `:82`, `:138`). "Mine" is empty for engineers
  (`orders.tsx:75`). Every role lands on the engineer home (`routes.ts:46`). On
  a phone, the My Day tab is the same home (`MobileShell.tsx:13`).
- **Lesson.** Land each role on its own queue, and rank exceptions, not orders.
- **Proposal.** `GET /api/orders/worklist` runs the stage function (R-M1) and
  an exceptions summary from stored fields for every open order in the tenant.
  Each row carries the stage, next action, holder role, owner (R-F4), blockers
  by role, age in stage, due time (after R-M3) and value in the order's
  currency. Home shows two lanes. "Waiting on me" lists my role's next actions,
  with orders I own first, sorted by value at risk and then age. "Waiting on
  others" names who is next and since when. The My Day tab on a phone shows the
  same two lanes. "Mine", the nav badges and the approvals queue (filtered by
  `approver_role`) read the same endpoint. Every row opens `#/so?id=` on the
  right tab. The clerk's lane exists only if C-D5 gives the clerk a seat. An
  "Agent is handling" lane appears only after the agent pass (C-34).
- **Builds on.** #602, #600, #604, migration 227.
- **Effort.** M. **Impact.** High.
- **Already planned?** WM-6 (after WM-5) and the A-PR13 filters (migration 265,
  A-D1). This interim needs no migration. When 265 lands, the worklist reads
  the explicit assignee.

#### R-U2. One shared order list: the Register with role views

- **Problem.** 8 lists with different columns (Home 5, SO list 7, Register
  11-12, Pending 9, Approvals 9, Tally Push 6, plus Inbox and Kanban). Pending
  rows do not link and hide the status the API returns (`pending-sos.tsx:146`;
  `pending_sales_orders.js:169`). History is reachable only by URL
  (`routes.ts:160`). The Register's Handoff column is a placeholder
  (`order-register.js:184`), and it has no "approved, no ERP SO" filter
  (`register.js:15`). 12 order items sit in 4 nav groups (`nav.ts:14`).
- **Lesson.** Land each role on its own queue.
- **Proposal.** The Register becomes the one order list. It adds stage, next
  action, owner and age from the worklist. Views are defined in code: To
  verify, Awaiting my approval, Returned to me, Approved not handed off, Handed
  off not keyed, Keyed unverified, Late against committed date, Pending by
  customer (grouped, rows link), History. Inbox, the SO list tabs, Pending and
  (in Mode B) Tally Push become links to these views and leave the pilot nav.
  The SOs tab on a phone opens the same Register. The Kanban stays as an
  overview, and its "Flagged" KPI reads the same counts (S9,
  `pipeline-kanban.tsx:235`).
- **Builds on.** #577, #598, the register filters.
- **Effort.** M. **Impact.** Medium.
- **Already planned?** WM-23 saved views (migration 262) and A-PR13. Views in
  code need no migration. Migration 262 is needed later only for user-saved
  views.

#### R-U3. Resolve exceptions on the card that lists them

- **Problem.** Seam 4. Fixing one row takes 3 or more actions over up to 6
  tabs and the Customers screen. Rows have no owner role
  (`order-exceptions.js:14`). Extraction Review's claim and resolve never reach
  the order (`review_queue.js:108`). The quote verdict shows 3 times on one
  screen. "Email customer" is a `mailto:` link (`so-workspace.tsx:2210`).
- **Lesson.** Every alert carries the action that resolves it, including the
  outbound ask. Ship policy defaults.
- **Proposal.** Ship A-PR11 (migration 264) with the C-D17 and C-D18 defaults.
  Each row's options become buttons: accept the PO value, accept the quote
  value, edit in place (rate, quantity, date), confirm, ask the customer
  (C-24), and update the customer (the identity dialog with a suggested match
  and a create option). Each exception type gets an `owner_role` as data:
  customer and master rows go to the masters owner (C-D23); price over
  tolerance and high terms go to sales_manager; a delivery conflict goes to the
  engineer; low extraction confidence goes to operator through the review
  queue; post-approval rows go to the stage holder. Review queue rows join the
  list, so one resolve closes both. The banner and strip copies of the quote
  verdict go. Each decision records `decided_via` (card or tab) for the metric.
- **Builds on.** #600, `communications/draft.js`, the #607 identity dialog.
- **Effort.** L (two PRs). **Impact.** High.
- **Already planned?** A-PR11, pending A-D4 and A-D12. T-PR14 (the amendment
  email) uses the same send.

#### R-U4. One approval panel, used by the queue and the order alike

- **Problem.** 4 approve paths: the workspace header (`so-workspace.tsx:2351`),
  the next-step bar (`:3503`), the queue, and a Kanban drop
  (`pipeline-kanban.tsx:174`). The drawer lacks the exceptions, quote verdict,
  terms flags, blockers and delivery date (`approvals.tsx:40`, `:155`). Margin
  has two sources: the queue uses `_lib/order-margin.js`, and the Margin tab
  reads a snapshot that nothing writes, so it prints 100%
  (`so-workspace.tsx:1697`). Value is the raw total labelled INR
  (`quote_approvals.js:31`). Approvers often decide away from a desk, and
  nothing says the drawer works on a phone.
- **Lesson.** One approval per order, with margin and risk at the decision
  point. Decide where people are.
- **Proposal.** One `ApprovalPanel` component in the queue drawer and the
  workspace. The header approve button goes. A Kanban drop onto Approve opens
  the panel (audit-F2). The panel shows the exceptions with the engineer's
  decisions (and later the agent's, with the policy rule), the quote verdict,
  terms flags, delivery date against the PO date, margin from
  `order-margin.js`, the PO pane, and "changed since you opened". The Margin
  tab switches to the same function. Value shows in the order's currency. The
  panel is usable at 375 px wide in the mobile shell. The approve audit row
  records which shell was used, as one field on a row that already exists, not
  click telemetry. The server rules come from R-F1. A signed one-tap link by
  email waits until C-1 to C-3 ship and the pilot passes.
- **Builds on.** The #603 drawer, #605, #600, #475.
- **Effort.** M. **Impact.** High.
- **Already planned?** A-PR15 (pending A-D3; partly done by #603) and
  audit-F2 (no PR).

#### R-U5. Six panels and one timeline that people can write in

- **Problem.** Up to 15 tabs (`so-workspace.tsx:2129`), 8 header controls and
  an 8-item More menu. Findings show in the Why tab (`:3172`) and on the card.
  The two timelines differ, and the Activity tab drops the actor (`:610`;
  `ThreadDrawer.tsx:156`). Nobody can write a free note on an order
  (`rep-touch.js:24`).
- **Lesson.** Show the whole order on one surface; write the timeline as "what
  changed, who holds it, next step".
- **Proposal.** Six panels: Review and decide (card and PO pane; Why, Evidence
  and Quotes fold in as row detail), Lines and schedule, Header and terms,
  Execution (R-F7), Documents (PO vs ERP, Invoice vs PO, challan), Timeline.
  Pipeline diagnostics and the Margin cockpit move to a More drawer for
  `cost.view` or admin. One timeline merges events, messages and notes, and
  names the actor. "order" joins `TOUCH_OBJECT_TABLES`, so any role with
  `touch.log` can post a note. That is every writer role
  (`communications/log.js:42`, `auth.js:251`); viewer and customer_support
  cannot. `@role` and `@person` resolve through `internal-recipients.js` and
  notify after migration 253. Submit notes, return reasons and decision
  reasons post as thread entries.
- **Builds on.** The #602 layout, `TouchLog.tsx`, ThreadDrawer.
- **Effort.** M. **Impact.** Medium.
- **Already planned?** WM-5 comments and watchers (migration 252, WM D1). This
  is the interim. Watchers are cut (section 7).

#### R-U6. Show only what the server confirmed

- **Problem.** Several steps report success that did not happen, so people
  re-check by hand:
  - Email Triage toasts success and does nothing useful (`email.tsx:128`,
    `:144`).
  - Teams outbound returns success with nothing sent (`comms-send.js:80`), and
    the copilot can reach it (`copilot/confirm.js:52`).
  - WhatsApp with no provider returns `ok: true` (`whatsapp/send.js:121`).
  - Quote email is inserted as queued while the screen says sent
    (`quotes/send.js:455`, `:530`).
  - Logistics and inventory alert emails are queued with no recipient, so the
    reaper would fail them (`logistics/notifications.js:192`,
    `inventory/notifications.js:113`).
  - An operator's mark-read fails and the error is swallowed (`Shell.tsx:135`).
  - The Communications list fetches without auth and with wrong action names,
    so it is always empty (`comms.tsx:84`).
  - The extraction watch says it is waiting for the background worker
    (`BackgroundExtractionWatch.tsx:155`), but not whether the worker has run
    recently. A stale tick writes only a `console.warn`
    (`heartbeat-check.js:97`).
- **Lesson.** Show only server-confirmed status, with a contract test per
  transition.
- **Proposal.** Fix each one. Email Triage leaves the pilot nav until C-32.
  Teams returns `not_configured`. WhatsApp with no provider returns "queued,
  not sent". Quote send goes direct, as invoice send already does
  (`invoices/send.js:196`), and shows the real status. Alert emails get their
  recipients from `resolveInternalRecipients`, so they work once the monitor
  is turned on. The Communications list goes through the API client with
  `comm_draft` and `comm_send`, or hides. The extraction watch adds "the worker
  last ran N minutes ago" from `cron_health`. A stale tick writes a bell row
  and emails admins. Each SO transition gets a contract test that the label
  comes from the server response. `route-deadlinks` and column drift become
  hard CI gates for SO screens.
- **Builds on.** S8 / #566, `cron_health`.
- **Effort.** S. **Impact.** Medium.
- **Already planned?** Partly: the side defects in
  `SO_TERMS_AND_HANDOFF_SCOPE.md` App. A.

### 5.2 Feature set

#### R-F1. The server holds the approval rules

- **Problem.** Seam 3.
- **Lesson.** Enforce policy on the server before the action. An agent calls
  the same API as a person, so the API must hold the rules.
- **Proposal.**
  - (a) Recompute `payload_hash` on every write to the result, line edits or
    customer, including the reconcile and the writeback. Remove the
    quote-derived exemption.
  - (b) The writeback overwrites lines only in DRAFT. In PENDING_REVIEW or
    APPROVED it stores the new lines as a pending replacement, clears the
    approval, returns the order to DRAFT (C-D1), and raises
    `lines_changed_after_review` with `blocks: approval`. It runs
    `mapLinesToItemMaster`. A queued or running job raises
    `extraction_in_flight` with `blocks: send`.
  - (c) PATCH builds the exceptions list on the server for moves to
    PENDING_REVIEW and APPROVED, and refuses with 409
    `ORDER_HAS_BLOCKING_EXCEPTION`. The Kanban, the queue, the workspace and a
    future agent then share one gate.
  - (a) and (b) close live holes. (c) is preventive: it matters once terms
    checking is set to on (C-D22), and it gives the agent the same gate as a
    person. The `-MOD` finding is already refused on the server, and a
    regression test keeps it so.
- **Builds on.** #605, #600, #608, #609.
- **Effort.** M (three S PRs). **Impact.** High.
- **Already planned?** No. The verifiers found these gaps after those PRs
  merged. R-U4, R-F3 and the agent depend on it.

#### R-F2. Close the Mode B loop: "keyed in ERP" is a verified state

- **Problem.** Seam 1.
  - The voucher number is already read from the Tally SO extraction
    (`register.js:158`) but never written to `so_voucher_no`, so the SO PDF
    prints a blank number (`so_pdf.js:109`).
  - Verifying takes find, open, tab and upload, though attach already matches
    by PO number (`attach_sales_order.js:7`). The only mount passes `orderId`
    (`ErpSalesOrderUpload.tsx:43`).
  - The three-way report is read-only (`three_way_report.js:5`), and it
    selects `orders.payment_terms` (`:33`), a column no migration creates.
  - "Mark reconciled" writes `TALLY_RECONCILED`, which is not an enum value, so
    the whole update fails (`tally-reconciler.js:467`).
  - Tally Push offers a push that Mode B refuses (`tally-push.tsx:148`;
    `tally/push.js:88`).
  - Every path to "keyed" today needs someone to print the Tally SO and upload
    it, and nothing checks that this happens.
- **Lesson.** "Keyed in the ERP" is a verified state with a manual exit.
- **Proposal.**
  - **Evidence, in this order.** The first source that arrives records
    `order.erp_keyed` with actor, time and source.
    1. *Bridge.* If DISC-1 finds a Tally bridge, `tally/sync.js` already writes
       every altered voucher to `tally_voucher_state` from the tick
       (`tick.js:109`). C-12 matches an SO voucher whose raw payload carries
       the buyer's PO number. Whether the bridge returns that field is not
       verified.
    2. *Reply.* The handoff's reply-to points at the tenant's Anvil inbound
       address (R-F3). C-33 attaches the clerk's reply to the order and
       proposes the voucher number for one-click confirmation.
    3. *PDF.* A Tally SO PDF dropped on the Register or the clerk's Home (C-13),
       or attached on the order. Only this source also gives lines for the
       three-way check.
    4. *Manual exit.* "Mark keyed in Tally" with a voucher number and a reason
       (C-D4).
  - **On keyed.** Write `so_voucher_no` and `tally_status = 'imported'`.
    Sources 1, 2 and 4 show "Keyed, unverified" until a PDF arrives.
  - **On a Tally SO attach.** Run the three-way report. Each departure from the
    PO becomes an `erp_departure` row for the engineer. A clean result sets
    `tally_status = 'reconciled'` and records `order.erp_verified`.
  - **Status.** `orders.status` stays APPROVED in Mode B (C-D3). `markStatus`
    writes `tally_status`, and sets RECONCILED only from EXPORTED_TO_TALLY
    (Mode A). Tally Push says why it is off in Mode B. Operator actions stay
    off.
  - **Precondition (OPS-3).** If `orders.payment_terms` is missing on the live
    database, every automatic check errors. C-12 then reads the decided term or
    the quote term instead of the column.
- **Builds on.** #576, #502, #503, migrations 005, 016 and 162 (live columns).
- **Effort.** M. **Impact.** High.
- **Already planned?** A-PR17 writes `so_voucher_no` (C-6). The state, the
  evidence order, the automatic check, the drop zone and the manual exit are
  new.

#### R-F3. The handoff, sent from the order on a direct rail

- **Problem.** The handoff exists as settings only
  (`order_handoff_settings.js:18`; `251_order_handoff.sql:58`). Nothing writes
  `handoff_*`. The engineer retypes about 4 fields into a mail client. The
  engineer cannot use `communications/send`, which needs `approve`
  (`send.js:20`). With no provider configured, `sendCommunication` marks the
  row queued (`comms-send.js:196`), and only the hourly reaper drains queued
  rows, for tenants with a due goal (`agents/run.js:358`). The resolver sets
  reply-to to the engineer (`internal-recipients.js:195`), so the clerk's
  reply with the voucher lands in a personal mailbox. The approval stores
  `send_customer_ack`, which nothing reads (`[id].js:237`). This is the
  audit's top-ranked friction: about 6 minutes on every Mode B order.
- **Lesson.** Hand work over as an owned task closed by evidence.
- **Proposal.** Build PR 16 as designed (`SO_TERMS_AND_HANDOFF_SCOPE.md` §8)
  with five changes:
  1. Send synchronously through `sendCommunication` and
     `resolveInternalRecipients`. With no provider, refuse with
     `not_configured` and say so. Never leave a queued row for the reaper. The
     readiness card (C-8) shows the provider before the lane goes live.
  2. Reply-to is the tenant's Anvil inbound address when one is configured,
     with the PO number in the subject. The engineer stays in CC (C-D12).
  3. Write `handoff_status`, `handoff_sent_at`, `handoff_sent_by` and the
     communication id.
  4. The keyed record (R-F2) closes the handoff, not a click. If the order
     changes after the send, show "changed since handoff" and make re-send the
     next step.
  5. The same Messages area later drafts the customer acknowledgement
     (`order_accepted`), which gives `send_customer_ack` its first reader.

  No acknowledgement click in v1. It runs in Track B, so it does not wait for
  the stage work.
- **Builds on.** Migration 251, #580, R-F1 (frozen content).
- **Effort.** M. **Impact.** High.
- **Already planned?** PR 16, pending the decisions gathered in C-D11 and
  C-D12.

#### R-F4. An owner and a holder for every order, now

- **Problem.** Seam 5. A return records a role, not a person
  (`approvals.tsx:337`). The account owner is live with a writer
  (`227_customer_owner.sql:32`; `customers/owner.js:19`), and no order code
  reads it.
- **Lesson.** Land each role on its own queue; every unit of work has an owner.
- **Proposal.** Step 1: `_lib/order-owner.js` derives the owner in the C-D6
  order. The PO uploader comes from `documents.uploaded_by` through
  `order_documents`. The holder is the stage's holder role, and a person where
  one is known, such as the submitter for a returned order. The owner stays for
  the life of the order; the holder changes at each stage. Step 2: migration
  265 adds `orders.owner_user_id`, seeded from step 1, next to the A-PR13
  columns, with claim and reassign.
- **Builds on.** Migrations 204 and 227, `shipment_tracking.js:145`.
- **Effort.** S, then M. **Impact.** High.
- **Already planned?** A-PR13 (migration 265, A-D1).

#### R-F5. Tell the next holder, where they will see it

- **Problem.** Seam 2. `notifyAdmins` reads its roles only to decide whether to
  insert, and the roles never travel with the row (`notifications.js:65`). Its
  header comment still claims one row per recipient (`notifications.js:7`).
  Even a per-user bell reaches only a person who has Anvil open on a desktop:
  the phone has no bell, and web push is dormant (`push.ts:37`). No table
  stores a staff phone number; the resolver reads only user id, role and status
  (`internal-recipients.js:89`). Which channel each pilot role actually reads
  is not known.
- **Lesson.** Tell the next owner, in the place they look.
- **Proposal.** Migration 253 adds `admin_notifications.recipient_user_id`. The
  bell shows for every role, in `Shell` and in `MobileShell`, and the recipient
  can mark read. `notify(users or role)` writes one row per recipient. Events:

  | Event | To | Email too? |
  |---|---|---|
  | Sent for approval | Members of the threshold's `approver_role` (the assigned approver after 265) | Yes |
  | Returned for correction | The submitter (the submit audit actor, else the PO uploader) | Yes |
  | Approved | The owner; in Mode B also the handoff role when the handoff follows approval | No |
  | Handoff sent | The members behind the role tokens | Yes (the handoff itself) |
  | Extraction done or failed | The uploader | No |
  | Keyed in ERP; three-way departure | The owner | No |
  | Stage overdue (R-M3) | The holder, then the manager role | Yes |
  | `@mention` (R-U5) | The person or role | No |

  Every notice opens `#/so?id=&tab=&exception=`. Email goes directly through
  `sendCommunication`. With no provider the send refuses with `not_configured`,
  and the bell row says the email did not go. The code comments that defer to
  "plan PR 14" are updated to name A-PR14 as built. A second channel (C-20)
  follows from DISC-1 and C-D16: web push, or a minimal staff WhatsApp notice.
  Notice-to-action time is measured per channel.
- **Builds on.** `internal-recipients.js`, `communications/send`, the badges.
- **Effort.** M. **Impact.** High.
- **Already planned?** A-PR14 (A-D5) and WM-7 (migration 253). The prior plans
  already say to design them once.

#### R-F6. One intake front door, with one server-side match

- **Problem.** Six intake surfaces. The document tiers (GSTIN, vendor code) run
  only in the intake browser (`so-intake.tsx:421`). A server matcher on the
  sender already exists (`inbound/email/parse.js:47`; `_lib/inbound-chat.js:89`).
  Workspace re-extraction never sets `customer_id` (`so-workspace.tsx:966`).
  Item mapping runs on create (`orders/index.js:155`) and on a customer change
  (`order-identity.js:52`) only, not on re-extraction or the background
  writeback (`extraction_jobs.js:780`). Inbound OCR does not update the order
  (`auto_ocr.js:13`) and needs ClamAV (`persist-attachments.js:131`). Quote
  convert does not open the order (`QuoteDetailDrawer.tsx:413`). Header fields
  such as the delivery contact are retyped (journey step 9). Two progress UIs
  exist (`so-intake.tsx:24` and the workspace watch).
- **Lesson.** One inbound front door, attached to the order and routed to its
  owner; prefill from masters.
- **Proposal.** `_lib/customer-match.js` holds the document tiers and runs
  after the sender tiers. POST `/orders`, the writeback, workspace
  re-extraction and the inbound draft workers all call it. Exact GSTIN and
  vendor-code matches follow C-D27. `mapLinesToItemMaster` runs on every line
  write. Header defaults from the customer master, including the primary
  delivery contact, ship early as C-16 (A-PR20, #238 rebased). Email Triage
  "Promote" goes through `inbound/email/draft_orders`, so the order keeps the
  email and the PO. A revised PO with a known PO number links to its order
  (C-D2). Quote convert opens the new order. One progress UI remains: the
  background watch.
- **Builds on.** #607, #608, `_lib/item-mapper.js`, #578.
- **Effort.** M. **Impact.** High.
- **Already planned?** A-PR18 (A-D6) and A-PR20 (A-D13). OPS: #566 must also
  drain the inbound workers, not only extraction jobs.

#### R-F7. The order shows its whole chain, and downstream records start from it

- **Problem.** The Shipments tab is a link (`so-workspace.tsx:3444`).
  `include=sourcePos` has no caller (`[id].js:101`). A new source PO copies no
  lines, so receiving fails (`source_pos/receive.js:65`). The parent dropdown
  shows 8-character ids (`source-pos.tsx:365`). Shipments and e-way bills take
  pasted UUIDs. Invoices show an 8-character order id (`invoices.tsx:287`).
  Delays rows open the source PO, not the order (`delays.tsx:58`). The FKs
  already exist (`001_init.sql:179`; `shipments.order_id`, `invoices.order_id`,
  `dispatch_lines.order_id`).
- **Lesson.** The SO is the record every downstream module resolves to.
- **Proposal.** An Execution panel replaces the Shipments placeholder. It lists
  source POs (ack, ETA), shipments (stage from `part_tracking.js`), challans,
  and invoices or the uploaded ERP invoice, each linked. "Create from this
  order" starts a source PO with the SO lines grouped by origin (the
  `pending_sales_orders.js:15` classifier), a shipment with the order filled
  in, and an invoice that opens after creation. One `OrderPicker` (PO number
  and customer) replaces every UUID field. Every order-bearing row links to
  `#/so?id=`. Mode B invoices follow C-D25.
- **Builds on.** Live FKs, `part_tracking.js`, DeliveryChallanUpload,
  InvoicePoCheck.
- **Effort.** M (two PRs). **Impact.** Medium for the pilot, high after it.
- **Already planned?** WM-10, narrowed into the order. WM-12 (migration 254) is
  still needed for internal SOs and RFQ award links.

#### R-F8. The agent drafts back-to-back source POs, under a value cap

- **Problem.** The approval stores `create_source_pos`, which nothing reads
  (`[id].js:237`). An RFQ award feeds the quote, not a source PO
  (`supplier_rfq/award.js:45`).
- **Lesson.** The SO is the record every downstream module resolves to.
- **Proposal.** After the pilot, and only if C-D26 says Anvil drafts: at the
  sourcing stage the agent drafts one source PO per supplier and origin group
  for the import lines. It takes supplier and price from the awarded RFQ or the
  last PO for the item, and puts the drafts in the procurement view. A person
  confirms each, up to the Controls value cap.
- **Effort.** M. **Impact.** Medium.
- **Already planned?** Partly, WM-12 (migration 254, WM D5).

#### R-F9. Float on each SO line, and the delay rules fire on it

- **Problem.** Delay rules react after a date passes (`delays/scan.js:22`). The
  PO date comes mostly from the po_extractor v4 canary: 5% of traffic, behind
  `docai_prompt_variants`, which defaults to off and an admin can set through
  the API (`prompt-versions.js:94`; `218_docai_prompt_variants.sql:42`;
  `admin/docai_settings.js:240`). LlamaParse and a description-date fallback
  fill it partly (`order-delivery-date.js:161`). In Mode B the source POs may
  not be in Anvil at all.
- **Lesson.** Put the shared deadline on the order.
- **Proposal.** Compute float at read time: committed date minus expected
  arrival minus transit. Expected arrival is the acknowledged source PO ETA,
  else the supplier's lead-time P50 and P90 (`lead-time.js`). Show the worst
  line on the header and in the worklist. Raise `float_below_zero` and
  `order_by_passed` for procurement. Persist float in migration 259 only when
  WM-18 builds the engine for projects.
- **Effort.** M. **Impact.** High once source POs live in Anvil; low before.
- **Already planned?** WM-18 / PM PR 1 (migration 259), narrowed here.

### 5.3 Methodology

#### R-M1. One order stage, derived from evidence, read by every screen

- **Problem.** Seam 1, and the labels disagree. APPROVED shows as "approval"
  (`helpers.ts:131`). Home "In approval" counts PENDING_REVIEW (`home.tsx:87`).
  The SO list "Approval" tab means APPROVED (`orders.tsx:78`). RECONCILED is
  "shipped" on the list (`helpers.ts:137`) and "Closed" on the Kanban, which
  also holds EXPORTED_TO_TALLY (`pipeline-kanban.tsx:84`). The badge counts
  RECONCILED as active (`telemetry.ts:85`). Value prints in INR from the raw
  total everywhere except the Register (`so-register.tsx:285`).
- **Lesson.** Derive status from evidence, never from a hand-set field.
- **Proposal.** A pure `_lib/order-stage.js` returns `{stage, since,
  evidence_ref, holder_role, next_action}` for any order, using the ladder and
  the revision rule in section 4. The next-step function consumes it, and its
  bar renders at every stage. GET `/api/orders`, `/orders/register`, the
  approvals queue and the exceptions endpoint return it. One `stageLabel()` and
  one `fmtOrderValue()` replace the per-screen maps. The stepper, Home, Kanban
  and badges read the stage. No status value is added. `orders.project_phase`
  and `orders.tally_status` keep their meaning; only `tally_status` is
  written. The 24 h approval expiry goes for Mode B (C-11, C-D8), because an
  expired approval refuses later status moves.
- **Builds on.** #602, #604, migration 251, the `part_tracking.js` precedent.
- **Effort.** M. **Impact.** High.
- **Already planned?** WM-10's chain ladder, moved into one shared helper.
  A-PR19 (the Mode B approval expiry). A-D3 (REJECTED) stays a separate
  decision.

#### R-M2. One Controls record, one autonomy map, one pilot pack

- **Problem.** `terms_check_mode` defaults to off, and only SQL changes it
  (`250_order_terms.sql:203`; `terms/mode.js:34`). `DEFAULT_WORKFLOW_CONFIG` and
  `DEFAULT_AGENT_POLICY` are code, and no tenant setting is read
  (`order-next-step.js:45`). Six SO features default off (section 1.3).
  Nothing states where the agent may act.
- **Lesson.** Enforce policy on the server and ship defaults; onboard with a
  process pack, not a set of flags.
- **Proposal.** Migration 266 adds `tenant_settings.so_controls jsonb`: review
  mode, price and quantity tolerances, the value cap for a second approver, a
  customer allow-list for solo, per-type agent policy (shadow, propose, apply,
  human only), per-agent pause, step targets (R-M3) and the sweep mode.
  `tenant_settings` has many purpose-specific jsonb columns (for example
  `terms_policy` at `250:220` and `nav_disabled` at `151:17`), but no
  general-purpose one, and no key-value settings table exists. So
  `so_controls` needs its own column. `resolveWorkflowConfig` and the
  exceptions builder read it; the code defaults stay as the fallback. Admin >
  Controls shows each value beside its default and edits `terms_check_mode`
  and `docai_prompt_variants` too. Every save is audited.
  `AGENT_READY_SO_FLOW.md` gains the autonomy map below, and
  `DEFAULT_AGENT_POLICY` mirrors it. A "Mode B pilot" pack in
  `install_vertical_pack.js` sets these values and the pilot nav.

  | The agent may do now (read or draft) | Needs a guardrail first | Stays human |
  |---|---|---|
  | Extract, reconcile, run anomaly rules, build the exceptions list and next step, suggest the committed date, map lines on create, draft order emails, read the ERP SO and run the three-way check | Apply a decision (264, R-F1), solo confirm (266, R-F1), send email (narrow right, direct send), apply a customer match (exact GSTIN or vendor code only), write back an extraction (R-F1), draft source POs (cap, known supplier), mark keyed (voucher), chase anyone (clock, owner) | Keying the SO into Tally in Mode B; high or critical terms; price outside tolerance; above the value cap or a new customer; cancel and reject; a new customer, item or supplier master; the first amendment email to a customer; any policy change |

- **Builds on.** `order-next-step.js`, `install_vertical_pack.js`, Admin >
  Navigation, `cron_health`.
- **Effort.** M. **Impact.** High.
- **Already planned?** "Solo review mode and a tenant setting" (pending A-D2
  and A-D4; "needs a migration of 264 or more, none planned") and the terms
  policy editor (planned, no PR). This gives them one record and one screen.

#### R-M3. A clock on every stage hold, dry run first

- **Problem.** No SO step has a target. The queue shows age and "Waiting > 1
  day" but never escalates (`approvals.tsx:379`). The delay scan writes nothing
  (`delays/scan.js:44`). The live logistics table has an owner and an SLA clock
  (`206_logistics_monitor.sql:59`, `:64`), with its flag off and its owner
  never written. Project memory records that switching that monitor on bursts
  about 2,000 mostly wrong critical rows. The repo schedules only cron/daily
  (`vercel.json:12`).
- **Lesson.** Turn on what exists in shadow first, then one kind at a time.
- **Proposal.** Targets live in `so_controls` (C-D24). A sweep on the scheduled
  `cron/daily` writes one fingerprinted `logistics_exceptions` row per overdue
  hold: `rule_kind = 'so_stage_overdue:<stage>'`, `object_type = 'order'`,
  `owner_user_id` = the holder, and `sla_target_at`. At the due time the
  holder gets a notice. One working day later the manager role does. A snooze
  needs a reason and a return date. The first week runs as a dry-run count.
  The logistics monitor flag stays off. Its breach pass (`monitor.js:385`) and
  notification pass (`logistics/notifications.js:95`) select every open row
  with no `rule_kind` filter, and unknown kinds escalate to procurement and
  admin (`logistics/notifications.js:82`). So C-28 makes both passes skip
  `so_stage_overdue:*`, and a test pins it. Otherwise turning the monitor on
  later would stamp and fan out these rows twice. Hour-level clocks wait until
  the tick is proven. Customer and supplier chases move to agent goals only
  after OPS-1 and a purge of stale queued mail.
- **Builds on.** Migration 206, the Delays screen, `cron/daily.js:91`.
- **Effort.** M. **Impact.** Medium.
- **Already planned?** WM-9 (after WM-5) and WM-26 (WM D4). This runs now on a
  live table.

#### R-M4. Measure the fragmentation, and publish it per tenant

- **Problem.** The metric catalog has only `order_approval_time_median`, in
  days, and each approval overwrites `approved_at`. Nothing measures the
  handoff, keying or later stages, or who was right when the clerk's entry
  differs from the PO.
- **Lesson.** Measure time in each state and the touchless rate.
- **Proposal.** Ship A-PR1 as the baseline (C-7), built from audit rows rather
  than the overwritten `approved_at`. Then stamp stage entry and exit from
  append-only `audit_events` and the stage records, and publish weekly per
  tenant: median and P90 per stage, handoff lag, returns and touches per
  order, keyed evidence by source, touchless rate, three-way departures by who
  was right, overdue holds by role, and notice-to-action per channel. Use the
  catalog contract `{value, unit, provenance, as_of}`. These numbers are the
  pilot's exit bar and rank Phases 3 and 4 (section 9). Section 6.5 says which
  baselines are rebuilt from records and which need live stamps.
- **Builds on.** `three-way-adjudicate.js` (#503), `ops_kpis.js`.
- **Effort.** M. **Impact.** Medium.
- **Already planned?** A-PR1 (planned, decision-free except the click metric).

#### R-M5. Pilot one lane, find out how the team works, and redefine "done"

- **Problem.** A sales engineer sees about 49 nav items and an operator about
  23 (`rbac.ts:226`). The lane's features are off by default. The repo does
  not show that an external trigger runs the tick. The Mode B end depends on how the clerk works,
  and nobody has recorded it. Terms shadow, the eval harness, the canary and
  the three-way adjudicator exist, but no rule promotes an agent from them.
- **Lesson.** Pilot one lane against a written exit bar; "done" means used;
  shadow before apply.
- **Proposal.**
  - **Discovery (DISC-1).** Half a day with the pilot team before C-8 and
    C-12. Record the clerk's daily volume and how Tally SOs are printed or
    exported; whether a Tally bridge exists and whether its vouchers carry the
    buyer's order number; whether the clerk has or wants a seat (C-D5); which
    channel each pilot role answers on within an hour (C-D16); and how the team
    coordinates today, the baseline the plan must beat.
  - **Readiness card (C-8).** For the Mode B lane it shows each flag, each
    migration the lane needs, the last run of cron/tick and cron/daily, the
    mail provider from `/api/health`, whether handoff recipients resolve,
    ClamAV, the `orders.payment_terms` check, and use of each step in the last
    7 days. Pilot roles see only the lane's screens through the existing
    per-role nav visibility, on desktop and on the phone tabs.
  - **Shadow week.** Anvil verifies while the clerk keys as usual (section
    6.5). The tenant agrees an exit bar (C-D15) before procurement, dispatch or
    invoicing switch on.
  - **Trust ladder.** After the decisions table and Controls, an Order Entry
    agent pass runs inside the request that already reconciles (the #609
    budget pattern). It writes decisions with `decided_by_kind = 'agent'` in
    shadow. A type moves to propose, then apply, only at the C-D30 threshold.
  - **Definition of done.** An SO PR is done only when its migration is
    applied, its flag is on for the pilot, a role used it in production, and
    its metric moved.
- **Builds on.** Nav visibility, `cron_health`, `/api/health`, terms shadow,
  `three-way-adjudicate.js`, the outcome meter.
- **Effort.** S (card, nav, discovery), L (agent pass). **Impact.** High.
- **Already planned?** The agent runner (planned, no PR; needs A-PR11). The
  card, the discovery and the definition of done are new.

#### R-M6. Attach a thin, order-first slice of the work layer, and cut the rest

- **Problem.** The work layer is 28 PRs on migrations 252-263, gated by WM-5
  and WM D1 (`WORK_MANAGEMENT_SCOPE.md:3`, `:1449`). Meanwhile orders have no
  holder, no notice and no state after approval. The repo already holds
  engines built but never wired (section 1.3).
- **Lesson.** Put the shared deadline on the order, not in a task manager, and
  plan in journey slices.
- **Proposal.** Attach to orders first, in this order: WM-7 notices (253); WM-6
  as the computed worklist; WM-9 as the order stage sweep; WM-10 as the
  Execution panel; WM-18 as SO line float; WM-12 narrowed to internal SO links
  and RFQ award to source PO. Defer WM-5, WM-8 and WM-11 until the pilot shows
  work that fits no stage hold and no exception. When WM-5 is built, an order
  work item points to a stage or an exception and never carries a second
  status. Section 7 lists the cuts.
- **Effort.** S (a plan change). **Impact.** High.
- **Already planned?** Re-sequences WORK_MANAGEMENT_SCOPE Waves 1-5.

---

## 6. Phased PRs in merge order

Each PR is small and ships value alone. Each registers any new endpoint in
`STATIC_ROUTES` (`src/api/router.js`) and ships its caller. "Blocked by" lists
section 8 decisions and operations checks.

**Commitment.** Phase 0, Track A and Track B are committed. Track A and Track B
start together after Phase 0 and run in parallel. Phases 3 and 4 are
provisional: the shadow-week numbers re-rank them (R-M4). Phase 5 waits for the
exit bar (C-D15).

### 6.1 The next 10 working days

| Days | Work | Needs |
|---|---|---|
| 1-2 | OPS-1: which tick handlers run, and is stale queued mail waiting? OPS-3: does `orders.payment_terms` exist on the live database? OPS-2: is ClamAV set? | Database and Vercel access |
| 1-3 | DISC-1 with the pilot team | Half a day of the team's time |
| 1-10 | Review and merge C-1, C-3, C-4, C-5, C-6, C-7 | No decision |
| 3 | One sitting on C-D1 to C-D15, presented as "accept all defaults except ___" | The owner, about an hour |
| 4-10 | C-2 and C-8; then start C-9 (Track A) and C-17 (Track B) | C-D1, C-D5, C-D9; DISC-1 |

### 6.2 Phase 0. Make the server and the screens honest (committed, no migration)

| PR | Title | Rec | Tests | Blocked by |
|---|---|---|---|---|
| C-1 | fix(orders): the approval hash moves on every line write, quote-priced or not | R-F1 | `orders-approval-hash.test.js` (a quote-priced order edited after the approver opened it; approve gets 409 STALE_APPROVAL); `order-reconcile.hash.test.js` | None |
| C-2 | fix(extraction): the background writeback never changes reviewed lines | R-F1 | `extraction-writeback-guard.test.js` (an APPROVED order keeps its lines, the approval is cleared, a row is raised); `order-exceptions.in-flight.test.js` | C-D1 |
| C-3 | fix(orders): the server refuses a move that an exception blocks (preventive) | R-F1 | `orders-blocking-exception.test.js` (a Kanban-shaped PATCH with a critical terms row in `on` mode gets 409); `orders-mod-finding.regression.test.js` (the server-held `-MOD` finding still blocks approve) | None |
| C-4 | fix(tally): "mark reconciled" writes a valid status; Mode B says why push is off | R-F2, R-U6 | `tally-reconciler.markStatus.test.js`; `tally-push.modeB.test.tsx` | None |
| C-5 | fix(ui): show only what the server confirmed, and say when the worker is down | R-U6 | `comms-send.teams.test.js`; `whatsapp-send.no-provider.test.js`; `quotes-send.status.test.js`; `logistics-alert.recipient.test.js`; `heartbeat-check.stale-alert.test.js`; `email-triage.hidden.test.tsx` | None |
| C-6 | fix(orders): the SO PDF prints what the order says; the ERP SO attach writes the voucher (A-PR17) | R-F2 | `attach-sales-order.voucher.test.js`; `so-pdf.terms.test.js` (no literal "30 Days" or "By Road") | None |
| C-7 | feat(metrics): SO cycle and rework baseline (A-PR1) | R-M4 | `metrics-catalog.so-baseline.test.js` (built from audit rows, not `approved_at`) | None (the click metric alone waits on C-D31) |
| C-8 | feat(admin): Mode B lane readiness card and pilot nav preset | R-M5 | `lane-readiness.test.js` (flags, migrations, `cron_health`, mail provider, recipients, ClamAV, `payment_terms`); `nav-visibility.pilot-preset.test.ts`; `mobile-shell.pilot-tabs.test.tsx` (the phone tabs follow the preset) | C-D5, C-D9; DISC-1 |

Six of the eight Phase 0 PRs need no decision. The operations checks (OPS-1 to
OPS-3) and DISC-1 run alongside them and need no PR.

### 6.3 Track A (Phase 1). One stage, one end, one worklist (committed, no migration)

| PR | Title | Rec | Tests | Blocked by |
|---|---|---|---|---|
| C-9 | feat(orders): one derived execution stage (`_lib/order-stage.js`) on every order endpoint | R-M1 | `order-stage.test.js` (each stage from fixtures; Mode A and B; handoff before and after approval; returned; revised after handoff; cancelled; manual exit unverified) | C-D2 |
| C-10 | feat(v3): every screen reads the stage and one money helper | R-M1 | `helpers.stageLabel.test.ts`; `home.modeB-queue.test.tsx` (a verified order leaves the queue); `telemetry.badges.test.ts`; `so-workspace.stepper.test.tsx` | C-9 |
| C-11 | fix(orders): no 24 h approval expiry in Mode B (A-PR19) | R-M1 | `orders-approval-ttl.modeB.test.js` (a line edit still clears the approval) | C-D8 |
| C-12 | feat(orders): "keyed in ERP" is a verified state, with a manual exit | R-F2 | `attach-sales-order.three-way.test.js` (a departure becomes a row; clean sets reconciled); `orders-erp-keyed.test.js` (evidence order; manual exit shows unverified); `three-way-report.payment-terms.test.js`; `rbac.order-erp-keyed.parity.test.js`; `tally-voucher-state.match.test.js` (only if DISC-1 finds a bridge) | C-6, C-9; C-D3, C-D4; OPS-3 |
| C-13 | feat(register): drop Tally SO PDFs without opening the order | R-F2 | `erp-so-drop.match.test.js` (match by PO number; unmatched list); `so-register.drop.test.tsx` | C-12; C-D5 decides whether the clerk's Home gets the zone |
| | **Shadow week (section 6.5)** | R-M5 | | C-12, C-13 live for the pilot |
| C-14 | feat(orders): owner, holder and one worklist on Home and the phone's My Day tab | R-U1, R-F4 | `order-owner.test.js` (precedence); `orders-worklist.test.js` (500 open orders inside the time budget; no LLM or reconcile call); `home.worklist.test.tsx`; `mobile-shell.my-day-worklist.test.tsx`; `quote-approvals.queue-role-filter.test.js` | C-9; C-D5, C-D6, C-D7 |
| C-15 | feat(register): one order list with role views | R-U2 | `orders-register.views.test.js`; `pending-sos.links.test.tsx`; `pipeline-kanban.flagged-kpi.test.tsx` | C-14 |
| C-16 | feat(orders): header defaults from the customer master (A-PR20, #238 rebased) | R-F6 | the #238 tests, rebased; `so-workspace.header-defaults.test.tsx` | C-D14 |

### 6.4 Track B (Phase 2). Push the work to the next holder (committed, migration 253)

| PR | Title | Rec | Tests | Blocked by |
|---|---|---|---|---|
| C-17 | feat(notifications): a notice per person and a bell for every role, on desktop and phone (WM-7, migration 253) | R-F5 | `notifications.recipient.test.js`; `admin-notifications.mark-read.recipient.test.js`; `shell.bell.roles.test.tsx`; `mobile-shell.bell.test.tsx` | None for in-app |
| C-18 | feat(orders): the Mode B handoff, sent from the order (PR 16) | R-F3 | PR 16's own tests, plus `orders-handoff.send-direct.test.js` (never queued; `not_configured` with no provider); `orders-handoff.reply-to.test.js`; `orders-handoff.changed-since.test.js`; `order-register.handoff-column.test.js` | C-1, C-2; C-D11, C-D12; turned on by C-D13 after the shadow week |
| C-19 | feat(orders): tell the next holder on every transition (A-PR14) | R-F5 | `orders-notify.transitions.test.js` (one row per recipient per event); `orders-notify.not-configured.test.js`; `so-workspace.deeplink.test.tsx` (tab and exception params) | C-17; C-D10; merges after the shadow week; keyed notices once C-12 has merged |
| C-20 | feat(notifications): the second channel chosen in discovery | R-F5 | Web push: `push-public-key.route.test.js`, `push-subscribe.ui.test.tsx`, `push-producer.order-events.test.js`. Or staff WhatsApp: `staff-phone.test.js`, `whatsapp-staff-notice.template.test.js` | C-17; C-D16 (WhatsApp also needs migration 267) |

### 6.5 The shadow week

The shadow week runs once C-12 and C-13 are live for the pilot. It ends before
C-14 and C-19 reach the pilot and before C-D13 turns the handoff on. Anvil
verifies while the clerk keys as usual. Track B may merge C-17 and C-18 during
the week: C-17 adds no events by itself, and C-18 stays off until C-D13.

- **Baselines rebuilt from records, with no live stamp:** PO received to
  approved, approval wait and returns per order (audit rows, not
  `approved_at`); time to an ERP SO attach for orders where someone already
  uploaded one (`order_documents` with role `sales_order`).
- **Baselines that need live stamps:** handoff lag (C-18); keying by bridge,
  reply or manual exit (C-12); the three-way verdict at attach (C-12); time in
  each stage after approval. C-27 can replay that last one from audit rows once
  C-12 writes them.

### 6.6 Phase 3. Decide in one place (provisional, migrations 264 and 266)

| PR | Title | Rec | Tests | Blocked by |
|---|---|---|---|---|
| C-21 | feat(admin): one Controls record and screen, and the Mode B pilot pack (migration 266) | R-M2 | `so-controls.resolve.test.js`; `order-next-step.controls.test.js`; `install-vertical-pack.modeB.test.js` | C-D17 |
| C-22 | feat(orders): record exception decisions and act from the card (A-PR11, migration 264) | R-U3 | `order-exception-decisions.test.js` (append-only, carried by fingerprint, `decided_by_kind`); `OrderExceptionsCard.buttons.test.tsx`; `order-exceptions.owner-role.test.js` | C-D17, C-D18, C-D23 |
| C-23 | feat(orders): edit in place, merge the review queue, one quote verdict | R-U3 | `OrderExceptionsCard.inline-edit.test.tsx`; `order-exceptions.review-queue-merge.test.js` | C-22 |
| C-24 | feat(orders): ask the customer from the card (`order.comms_send`) | R-U3, R-F3 | `communications-draft.order.test.js` (no literal `\n`); `rbac.order-comms-send.parity.test.js` | C-D20 |
| C-25 | feat(approvals): one approval panel for the queue and the order (A-PR15) | R-U4 | `ApprovalPanel.test.tsx` (usable at 375 px); `pipeline-kanban.drop-opens-panel.test.tsx`; `margin.single-source.test.js`; `orders-approve.audit-shell.test.js` | C-3; reject waits on C-D19 |
| C-26 | feat(so-workspace): six panels, one timeline, notes and mentions on the order | R-U5 | `rep-touch.order.test.js`; `so-workspace.tabs.test.tsx`; `timeline.merge.test.ts` (actor shown) | Mentions notify after C-17 |

### 6.7 Phase 4. Clock, chain and front door (provisional, no migration)

| PR | Title | Rec | Tests | Blocked by |
|---|---|---|---|---|
| C-27 | feat(metrics): time in each stage, handoff lag, three-way score | R-M4 | `metrics-catalog.stage-times.test.js` | C-9, C-12 |
| C-28 | feat(cron): a daily sweep over stage holds, dry run first | R-M3 | `cron-daily.so-stage-sweep.test.js`; `so-stage-sweep.dry-run.test.js`; `so-stage-sweep.fingerprint.test.js`; `logistics-monitor.skips-so-kinds.test.js` | C-17, C-21; C-D24 |
| C-29 | feat(orders): the Execution panel, the order picker, and links back to the order | R-F7 | `so-workspace.execution-panel.test.tsx`; `OrderPicker.test.tsx`; route-deadlinks as a hard gate | C-D25 |
| C-30 | feat(source-pos): create from the order, with its lines | R-F7 | `source-pos.create-from-order.test.js`; `source-pos.receive.test.js` | C-D26 |
| C-31 | feat(intake): one server-side customer match; item map on every line write | R-F6 | `customer-match.test.js`; `orders-reextract.customer.test.js`; `inbound-draft.customer-match.test.js` | C-D27 |
| C-32 | feat(intake): one front door; revised POs link to their order; one progress UI | R-F6 | `email-triage.promote.test.js`; `intake.revised-po.test.js`; `so-intake.progress.test.tsx`; `quote-convert.opens-order.test.tsx` | C-D2, C-D28; OPS-1, OPS-2 for inbound |
| C-33 | feat(inbound): the clerk's reply attaches to the order and proposes the voucher | R-F2 | `inbound-reply.order-join.test.js`; `inbound-reply.voucher-propose.test.js` | C-18; only if DISC-1 shows email replies and an inbound mailbox exists |

C-33 is needed because inbound mail threads only on the Message-ID chain today,
and the join from a reply back to the sent row is a stated follow-up
(`comms-send.js:213`).

### 6.8 Phase 5. After the pilot exit bar

| PR | Title | Rec | Tests | Migration | Blocked by |
|---|---|---|---|---|---|
| C-34 | feat(agents): Order Entry agent pass, shadow first | R-M5 | `order-entry-agent.shadow.test.js`; `order-entry-agent.policy.test.js` | None beyond 264 | C-21, C-22; C-D15, C-D30 |
| C-35 | feat(orders): submitter, approver and owner columns; claim and reassign (A-PR13) | R-F4 | `orders-assignment.test.js`; `orders-claim-reassign.test.js` | 265 (reserved) | C-D7, C-D32 |
| C-36 | feat(orders): float on each SO line; delay rules fire on float | R-F9 | `order-float.test.js`; `delays-scan.float.test.js` | None (259 later) | C-D22 |
| C-37 | feat(agents): SO chase goals, after the stale-mail purge | R-M3 | `agent-goals.so-chase.test.js` | None | OPS-1 |
| C-38 | feat(agents): drafted source POs under a value cap | R-F8 | `source-po-drafts.agent.test.js` | None | C-D26 |

### 6.9 Migrations

| Number | Status | Content | PR |
|---|---|---|---|
| 253 | Reserved, reused | `admin_notifications.recipient_user_id` (WM-7) | C-17 |
| 264 | Reserved, reused | `order_exception_decisions` (A-PR11), with `decided_by_kind` and `decided_via` | C-22 |
| 265 | Reserved, reused | `orders.submitted_by`, `submitted_at`, `assigned_approver_role`, `assigned_approver_id` (A-PR13) and `orders.owner_user_id` | C-35 |
| 266 | New | `tenant_settings.so_controls jsonb` | C-21 |
| 206 | Live, reused as is | Stage-overdue rows use free-text `rule_kind` | C-28 |
| 267 and up | Only if needed, next free number when written | A staff phone column if C-D16 picks WhatsApp; `orders.payment_terms` only if T-PR3 needs the column after OPS-3; a handoff acknowledgement state if the pilot shows a gap of more than one working day between "sent" and "keyed" | C-20, C-12, later |
| 254, 259, 262 | Reserved, later | Narrowed WM-12; WM-18 for projects; user-saved views | Not in this plan |
| 252, 255-258, 260, 261, 263 | Reserved | Not needed on the SO path | Not in this plan |

### 6.10 Crosswalk to the prior plans

| C-PR | Prior plan item |
|---|---|
| C-1, C-2, C-3 | New: verifier findings after #605, #608 and #609 |
| C-4 | New (the `markStatus` enum defect) |
| C-5 | `SO_TERMS_AND_HANDOFF_SCOPE.md` App. A side defects, plus new false successes |
| C-6 | A-PR17 |
| C-7 | A-PR1 |
| C-8 | New |
| C-9, C-10 | WM-10 chain ladder, moved into a shared helper; S9 in part |
| C-11 | A-PR19 |
| C-12, C-13 | Follows A-PR17; the state, the evidence order and the drop zone are new |
| C-14 | WM-6 and the A-PR13 filters, as an interim |
| C-15 | WM-23 (views in code) and the A-PR13 filters |
| C-16 | A-PR20 (#238) |
| C-17 | WM-7 |
| C-18 | PR 16 |
| C-19 | A-PR14 |
| C-20 | New (web push dormant; staff WhatsApp missing) |
| C-21 | "Solo review mode and a tenant setting"; the terms policy editor |
| C-22, C-23 | A-PR11 |
| C-24 | The T-PR14 send rail |
| C-25 | A-PR15; audit-F2 |
| C-26 | WM-5 notes, as an interim |
| C-27 | A-PR1, extended past approval |
| C-28 | WM-9, narrowed |
| C-29 | WM-10, narrowed |
| C-30 | New; WM-12 in part |
| C-31 | A-PR18, moved to the server |
| C-32 | New |
| C-33 | New |
| C-34 | The agent runner (`AGENT_READY_SO_FLOW.md` §7) |
| C-35 | A-PR13 |
| C-36 | WM-18, narrowed |
| C-37 | New (agent goals) |
| C-38 | WM-12 (RFQ award to source PO) |

---

## 7. What not to build, and what to cut or defer

### 7.1 Do not build

- **A task tool or a generic task list for sales orders.** #540 decided this.
  The stage, the exceptions list and the worklist cover the order.
- **New `order_status` values for stages after approval.** The stage is
  derived. A-D3 (REJECTED) is a terminal decision and stays separate.
- **Operator actions for "keyed in Tally".** One record per fact.
- **A handoff acknowledgement click in v1.** Measure the lag first.
- **Watchers.** The owner, the holder and mentions get notices.
- **Slack or Teams notices to staff.** Teams outbound reports success without
  sending. Staff WhatsApp is not ruled out; C-D16 decides it from evidence.
- **Realtime presence.** #605 and #607 stop damage. Revisit after the pilot.
- **One-tap approval links by email or WhatsApp** until C-1 to C-3 ship and the
  pilot passes.
- **A separate deal room screen.** The Execution panel is the deal room for one
  order.
- **"Mode B+", an agent-drafted Tally voucher import,** until the pilot passes
  its exit bar. Then measure clerk corrections per order before moving a tenant
  toward Mode A.

### 7.2 Cut or defer from existing plans

| Item | Change | Reason |
|---|---|---|
| WM-5 work items (252), WM-8, WM-11 | Defer | Wait for work that fits no stage hold and no exception |
| WM-6 My Work | Replace with the computed worklist (C-14) | Needs no migration |
| WM-9 daily sweep | Narrow to order stage holds on the migration 206 table (C-28) | Needs no work items |
| WM-10 deal room | Narrow to the Execution panel (C-29) | The FKs exist |
| WM-12 chain FKs (254) | Narrow to internal SO links and RFQ award to source PO | The rest already joins |
| WM-18 schedule engine (259) | Narrow to SO line float at read (C-36) | Persist for projects later |
| WM-21, WM-22, WM-24, WM-25 | Cut from the SO path | Templates, configurable workflows (seed in code), custom fields and Gantt add surface, not cohesion |
| WM-23 query language | Cut; keep views in code; 262 only for user-saved views | Views in code cover the pilot |
| WM-13 to WM-16 | Keep for projects only | Not on the SO path |
| Email Triage as an SO entry point | Hide from pilot roles until C-32 | Both actions fail behind success toasts |
| Tally Push in Mode B | Hide with a reason (C-4) | The server refuses it |
| Communications list | Repair or hide (C-5) | Always empty |
| Logistics monitor flag | Keep off | A raw switch-on bursts about 2,000 wrong rows |
| `agents/run` reaper | It runs today inside the tick, for tenants with a due agent goal. Purge stale queued mail now (OPS-1), or leave it out of the #566 allow-list until purged | It would send months of stale quote email |
| #534 inventory planner clock | Not needed for the SO path | Unrelated to the lane |

---

## 8. Owner decisions

Numbered in the order the work needs them. Each has a recommended default.
Inherited decisions keep their old id in brackets. Every default in this plan
is stated here once.

**Batch 1: one sitting in the next 10 working days**

1. **C-D1.** When a background writeback lands on a PENDING_REVIEW order, does
   the order return to DRAFT? Default: yes, with the reason shown. Blocks C-2.
2. **C-D2.** The stage list, the evidence rule for each stage, "done" for Mode
   B, and the revision rule. Default: the ladder in section 4; done means
   "Verified in ERP"; a revised PO with the same PO number amends the order,
   clears the approval and re-verifies the ERP entry. Blocks C-9 and C-32.
3. **C-D3.** In Mode B, does "keyed" change `orders.status`? Default: no.
   Status stays APPROVED; `tally_status` and the stage record it. Blocks C-12.
4. **C-D4.** May someone mark an order keyed without the Tally PDF, and who?
   Default: operator, sales_manager and admin, with a voucher number and a
   reason; the order shows "Keyed, unverified" until a PDF arrives. Blocks
   C-12.
5. **C-D5.** Is the order-processing clerk an Anvil user, or an email address
   only? Default: a user. The clerk, or the clerk's lead, gets one operator
   seat for the Home lane and the drop zone. The handoff email still goes to
   the shared address in C-D12. If the answer is "address only", the clerk lane
   and clerk notices drop out, and keyed evidence comes from a bridge, a reply
   (C-33) or the engineer's upload. Blocks C-8, C-13 and C-14.
6. **C-D6.** Order owner until migration 265. Default: opportunity owner, then
   account owner, then PO uploader, then quote creator. Blocks C-14.
7. **C-D7 (A-D1).** Who approves an order? Default: the threshold's
   `approver_role`, else any sales_manager, never the submitter. The queue
   filters by role. Blocks C-14 and C-35.
8. **C-D8 (A-D11).** Approval expiry in Mode B. Default: no 24 h expiry; a line
   edit still clears the approval. Blocks C-11.
9. **C-D9.** Pilot nav. Default: the sales engineer sees Home, New PO, Orders
   (Register) and Approvals; the clerk (if C-D5 says user) sees Home and
   Orders; admin keeps all. The phone tabs follow the same preset. Blocks C-8.
10. **C-D10 (A-D5 = WM D4).** Notice channels in v1. Default: the bell for
    every event and every role, on desktop and phone; direct email for submit,
    return, handoff and escalation. Blocks C-19.
11. **C-D11 (T-D10 = A-D8).** Handoff before or after approval. Default:
    before, gated by blockers. "Keyed in ERP" needs both. Blocks C-18.
12. **C-D12 (T-D3, T-D4, T-D5, T-D6, T-D7, T-D8 = A-D7).** The PR 16 set.
    Defaults as designed: an undecided critical terms flag blocks the handoff;
    one shared clerk address with the engineer in CC (T-D4 is data); no
    prices, and the SO PDF and the original PO attached; origin precedence as
    designed; ship modes as designed; required-by is the PO date and the
    committed date is prefilled with its source. One change: reply-to is the
    tenant's Anvil inbound address when one exists, else the engineer. Blocks
    C-18.
13. **C-D13.** Turn on `order_handoff_enabled` for the pilot after C-18 and the
    shadow week. Default: yes.
14. **C-D14 (A-D13).** Un-hold #238 (header defaults from the customer
    master)? Default: yes, rebased on the review layout. Blocks C-16.
15. **C-D15.** The pilot exit bar. Default: for 4 consecutive weeks, the median
    from PO received to "Verified in ERP" is at most 1 working day; 95% of
    handed-off orders are keyed within 1 working day; no approved order waits
    more than 2 working days without a holder action; every order's stages are
    evidenced. Blocks Phase 5 and any second lane.

**After discovery**

16. **C-D16.** The second notice channel. Default, from DISC-1: web push if the
    pilot roles keep Anvil open in a phone or desktop browser (no migration;
    needs VAPID keys, a public-key route, a subscribe screen and a producer);
    staff WhatsApp if they answer only on WhatsApp (needs a staff phone number,
    which no table holds, so migration 267, plus one template and a provider).
    Blocks C-20.

**Phase 3**

17. **C-D17 (A-D4).** Who accepts a price deviation, and up to what size?
    Default: the engineer up to ±2% or ₹10,000 per line, and 0 on quantity;
    otherwise sales_manager. The 2% and 0 come from migration 054
    (`054:117`); the ₹10,000 per-line bound comes from `DEFAULT_AGENT_POLICY`
    (`order-exceptions.js:232`). Blocks C-21 and C-22.
18. **C-D18 (A-D12).** Reason chips instead of 10 typed characters. Default:
    chips plus optional text. Blocks C-22 and C-25.
19. **C-D19 (A-D3).** What "reject" means. Default unchanged: a REJECTED
    status with a required reason code. Blocks reject in C-25.
20. **C-D20 (T-D9).** Does Anvil email the customer for an amendment? Default:
    Anvil drafts, the engineer previews and sends. Blocks C-24.
21. **C-D21 (A-D2).** Auto-approve a clean Mode B order below a value? Default:
    off until the exit bar passes.
22. **C-D22 (A-D9, T-D11).** Turn on the v4 PO-date canary and terms shadow
    mode for the pilot, and record provider consent for terms text? Default:
    yes, after a golden-set check and written consent. When terms checking
    goes to on, C-3 becomes load-bearing. Blocks terms rows and C-36.
23. **C-D23.** The masters owner role for customer and master rows. Default:
    sales_manager. Blocks C-22.

**Phase 4**

24. **C-D24.** Step targets and escalation. Default: 1 working day each for In
    approval, Approved to Handed off, Handed off to Keyed, and Keyed to
    Verified; escalate to sales_manager one working day after the target; use
    the current weekend rule until WM-17. Blocks C-28.
25. **C-D25.** In Mode B, do invoices stay in Tally only? Default: yes; the
    Execution panel shows the uploaded ERP invoice and hides "New invoice".
    Blocks C-29.
26. **C-D26.** In Mode B, does Anvil draft source POs or only track them?
    Default: track only in the pilot; the human "create from this order"
    button stays; no agent drafts. Blocks C-30 and C-38.
27. **C-D27 (A-D6).** May exact GSTIN and vendor-code matches bypass the 0.85
    gate? Default: yes; name matches keep the gate. Blocks C-31.
28. **C-D28.** Email Triage: route through the inbound path, or retire it?
    Default: hide it from pilot roles now (C-5); route "Promote" through
    `inbound/email/draft_orders` in C-32. Blocks C-32.

**Work layer and agent**

29. **C-D29 (WM D1, D3, D7, D8, D9).** Default: build thin in Anvil; teams are
    roles; no custom fields; no Gantt in v1; workflows seeded in code; WM-5
    deferred as in section 7.
30. **C-D30.** The trust-ladder threshold. Default: 50 decisions per type at
    98% agreement with people, the PO as authority. Blocks C-34.
31. **C-D31 (A-D10).** Client click telemetry. Default: no; count actions from
    `audit_events`. Blocks only the click metric in C-7.
32. **C-D32 (WM D13).** Who may reassign an order? Default: any writer;
    reassigning someone else's order needs a permission. Blocks C-35.

**Operations and discovery**

- **OPS-1.** The 5-minute tick. `/api/_healthz` reported `tick_stale: false`
  in October 2026, so an external trigger calls it, and on `main` the tick runs
  every handler, `agents/run` included. Confirm with `cron_health` where
  `worker = 'cron/tick'`, and read the stale-worker list in `/api/_healthz`.
  Then count queued communications older than 7 days. If any exist, purge them,
  or merge #566 with an allow-list that leaves `agents/run` out until they are
  purged. Do not merge #566 with its default list: it would stop the inbound
  drains and `tally/sync`. Set `CRON_TICK_HANDLERS` in Vercel first.
- **OPS-2.** Set `CLAMAV_URL`, or inbound auto-OCR never runs. Default: set it.
- **OPS-3.** Check the live database for `orders.payment_terms`.
  `three_way_report.js:33` selects it and no migration creates it. If it is
  absent, C-12 reads the decided term or the quote term instead. Add the
  column only if T-PR3 needs it.
- **DISC-1.** Half a day with the pilot team, as described in R-M5. Output:
  one page filed with the readiness card, with an answer for C-D5 and C-D16.

---

## 9. Metrics to prove fragmentation went down

Baselines come from the traces, from records rebuilt after the fact, or from
the shadow week (section 6.5). Live metrics use sources that already exist where
possible.

| Metric | Source | Baseline | Target |
|---|---|---|---|
| Nav items a pilot sales engineer sees | `rbac.ts:226` filter plus nav visibility | About 49 | About 10 |
| Order lists | Screen count | 8 | 2 (Home worklist, Register) |
| Ways to approve | Screen count | 4 | 1 component |
| Workspace tabs | `so-workspace.tsx:2129` | Up to 15 | 6 |
| Dead ends on the SO path | Route-deadlinks gate | 13 | 0 |
| Silent handoffs | Transitions with no notice | 3 | 0 |
| Resolution options that cannot be recorded | `order-exceptions.js:118` | 25 of 68 | 0 |
| Context switches, clean Mode B order to verified | Trace recount after Phase 3 | About 13 | About 5 |
| Median and P90, PO received to "Verified in ERP" | `orders.created_at` and the `order.erp_verified` audit row | Shadow week | Median at most 1 working day |
| Time in each stage | Stage stamps from `audit_events` (C-27) | Shadow week | Falls each month |
| Handoff lag, sent to keyed | `handoff_sent_at` and `order.erp_keyed` | Not measurable today; the handoff is outside Anvil | 95% within 1 working day |
| Keyed evidence by source | Source field on `order.erp_keyed` | Shadow week | Manual exits fall; each one is later verified |
| Approvals waiting more than 1 day | Existing KPI (`approvals.tsx:379`) | Shadow week | Near 0 |
| Approvals decided on a phone | Shell field on the approve audit row (C-25) | Unknown | Reported weekly; feeds C-D16 and any native-app question |
| Returns per order | `manager_requested_correction` audit rows (C-7) | Rebuilt from audit rows | Falls |
| Approved Mode B orders with no ERP SO after 1 working day | Register view (C-15) | Shadow week | 0 |
| Exceptions closed on the card, not by navigating | `decided_via` (C-22) | 0% | Over 80% |
| Notice to action, by channel | Notice `created_at` to the recipient's next audit row on that order | Not measurable today | Median under 4 working hours |
| Touchless rate | Orders with no open row at submit and no line edit | Shadow week | Rises |
| Three-way departures caught, by who was right | `three-way-adjudicate.js` | Shadow week | Reported weekly |
| Overdue holds by role | Sweep rows (C-28) | Dry-run week | Falls |
| Tick health | `cron_health` and `/api/_healthz` | Tick running (October 2026); stale workers listed | Last run under 10 minutes; no stale SO worker |

---

## 10. Coverage and limits

- **Traces.** Five traces ran: the front of the journey, the back of the
  journey, navigation, work and collaboration, and notifications. A verifier
  re-read each one at `80cd8151`. This plan uses the corrected claims. The
  main corrections: Email Triage is broken as an SO path; a server-side sender
  matcher already exists; the stale-approval 409 fails for quote-priced
  orders; operator actions exist but are dormant; the owner is one join away;
  the tick depends on an external trigger by design, and `/api/_healthz`
  reported `tick_stale: false` in October 2026, so tick handlers run.
- **Gap analysis.** Four readings covered the competitor and plan documents.
  The gap analysis carries a "superseded" banner, and some of its claims are
  stale (EDI exists; `freight_bids` has a consumer; the RFQ matrix handles FX).
  Competitor claims come from documents, not product trials. The Makeflow
  section (§3.34) was added after the base commit and rests on vendor claims
  only.
- **Designers.** All three lenses returned proposals. No agent returned
  nothing.
- **Critics.** Critics reviewed the first draft. This version corrects its
  "plan PR 14" attribution, its `-MOD` claim, its handoff sequencing, its
  mobile gaps, its notice delivery claims, and several counts and pointers.
- **Checked by the editor.**
  - "Plan PR 14" in the code comments is A-PR14. The comments came from #603
    and #604, which use the audit numbering.
  - The `-MOD` finding is held in `rule_findings` with `blocks: true`
    (`order-reconcile.js:302`) and refused on approve
    (`blocking-findings.js:23`).
  - `logistics_exceptions.rule_kind` and `object_type` are free text
    (`206_logistics_monitor.sql:53`, `:56`), so the sweep needs no migration.
    The monitor's notification pass selects every open high-severity row with
    no `rule_kind` filter (`logistics/notifications.js:95`), hence the skip in
    C-28.
  - `tenant_settings` has many purpose-specific jsonb columns but no
    general-purpose one, so `so_controls` needs migration 266.
  - The mobile shell has fixed tabs (`MobileShell.tsx:12`) and no bell. It
    receives the nav already filtered by role and nav visibility
    (`app.tsx:334`, `MobileShell.tsx:120`), so the pilot preset can hide a tab
    but cannot add one. A critic note said the preset could not hide the Inbox
    tab; the code says it can.
  - `sendCommunication` marks a row queued when no provider exists
    (`comms-send.js:196`).
  - `resolveInternalRecipients` sets reply-to to the engineer
    (`internal-recipients.js:195`).
  - `tally/sync.js` needs a `bridge_url` (`sync.js:188`), runs from the tick
    (`tick.js:109`), and stores each voucher's raw payload in
    `tally_voucher_state` (`016_tally_v2.sql:163`). No column holds a PO
    reference.
  - No table stores a staff phone number. The resolver reads only user id, role
    and status from `tenant_members` (`internal-recipients.js:89`).
  - `attach_sales_order` needs only the coarse write permission
    (`attach_sales_order.js:33`), so an operator seat can attach.
- **Not verified.**
  - Which tick handlers succeed. The tick itself runs (OPS-1), but
    `/api/_healthz` listed stale workers.
  - Live `tenant_settings` values. Some flags may already be on.
  - Whether `orders.payment_terms` exists on the live database (OPS-3).
  - Whether a mail provider is configured (check `/api/health`). VAPID is not
    documented anywhere.
  - Whether the pilot tenant has an inbound mailbox.
  - Whether a Tally bridge exists, and whether its vouchers carry the buyer's
    PO number.
  - The share of pilot POs that match a quote, which sets how many orders the
    C-1 hole affects today.
  - Whether a revised PO lands as DUPLICATE in intake today.
  - How fast the worklist runs over a large tenant. C-14 carries a budget test.
  - How the new panels render in the mobile shell. C-25 asserts 375 px.
  - How the pilot's clerk works: volume, export practice, seat, and channel
    (DISC-1).
  - The opportunity owner's coverage on real orders, which decides whether
    C-D6's first source is often empty.
- **Line numbers** are at `80cd8151` and drift as main moves. Re-check each
  `path:line` before a PR edits that file.

---

## Appendix A. Which lens proposed each recommendation

| ID | One surface | Methodology | Agent first |
|---|---|---|---|
| R-U1 | Yes | Yes | Yes |
| R-U2 | Yes | Yes | |
| R-U3 | Yes | Yes | Yes |
| R-U4 | Yes | | Yes |
| R-U5 | Yes | Yes | |
| R-U6 | Yes | Supports | |
| R-F1 | Inside its approval panel | Inside its handoff | Yes |
| R-F2 | Yes | Yes | Yes |
| R-F3 | Yes | Yes | Yes |
| R-F4 | Yes | Yes | Yes |
| R-F5 | Yes | Yes | Yes |
| R-F6 | Yes | | Yes |
| R-F7 | Yes | Yes | Yes |
| R-F8 | | Yes | Yes |
| R-F9 | | Yes | |
| R-M1 | Yes | Yes | Yes |
| R-M2 | Yes | Yes | Yes |
| R-M3 | Yes | Yes | Yes |
| R-M4 | Yes | Yes | Yes |
| R-M5 | Yes | Yes | Yes |
| R-M6 | | Yes | Consistent |

## Appendix B. Conflicts between the lenses, and how they were resolved

| Question | One surface | Methodology | Agent first | Decision | Why |
|---|---|---|---|---|---|
| What records "keyed in Tally"? | An operator action, closed by the PDF | The ERP SO attach; operator actions stay off | An operator action, then status moves | Evidence in a fixed order: bridge voucher, reply, PDF, manual exit. Operator actions stay off. | One record for one fact. The attach already matches by PO number, and an operator seat can already attach. Operator actions need a flag, a new screen and a second store for the same fact. |
| Does "keyed" change `orders.status`? | Owner decision | No | Yes: EXPORTED_TO_TALLY, then RECONCILED | No (C-D3) | The 24 h expiry refuses later moves today. Mode A readers treat EXPORTED_TO_TALLY as "pushed by Anvil". The derived stage gives every screen the end state with no enum change. |
| Does the clerk acknowledge the handoff? | Yes, through the operator action | No; measure first | Not stated | No click in v1. The keyed record closes the handoff. | Add a state only if the pilot shows a gap of more than one working day between "sent" and "keyed". |
| Is the clerk a user or an address? | A user with a worklist | A user with a desk view | A named clerk | Owner decision C-D5; default a user | The handoff design defaults to a shared address. A seat and a shared address can coexist. |
| Where do overdue holds live? | Computed, notices only | Rows on the live migration 206 table | Agent goals | Computed for the worklist, plus one fingerprinted `logistics_exceptions` row per breach | No migration; the Delays screen already lists the rows. Agent goals need the tick. The monitor must skip these kinds. |
| Name and home of the policy | `so_workflow_policy` | Code defaults first | `so_controls` | `tenant_settings.so_controls` (migration 266) | No general-purpose settings column exists. |
| Order owner precedence | Account, uploader, quote creator | Account, opportunity, uploader, quote creator | Account, uploader, quote creator | Opportunity, account, uploader, quote creator (C-D6) | The most specific record wins. `shipment_tracking.js:145` already uses the opportunity owner after the order. |
| Name of the personal list | Worklist | Desk | Inbox | `GET /api/orders/worklist`; Home lanes "Waiting on me" and "Waiting on others" | One endpoint feeds Home, My Day, "Mine", the badges and the Register columns. |
| Kanban | A drop opens the panel | Overview only | Not stated | Overview only; a drop onto Approve opens the approval panel | No path may approve without the decision view. |
| Source POs from the order | Create from the order | Draft at the sourcing stage | Agent drafts under a cap | A human "create from this order" button that copies lines; agent drafts after the pilot (C-D26) | Copying lines fixes receiving today. |
| When the agent acts | Not central | After the lane pilot | Early, inline after reconcile | After R-F1, the decisions table and Controls, in shadow first | The guards the agent needs are broken today. |
| When the handoff ships | With the cockpit | After the stage ladder | With the message drafts | Track B, in parallel with the stage work | It is the top friction and needs only C-1, C-2 and decisions. |
| Which events also send email | Submit, return, handoff | Submit, handoff, escalation | Email now, bell later | Bell for all events; direct email for submit, return, handoff and escalation (C-D10) | Each of these blocks a person until they act. |
