# Sales order agent infrastructure: audit

Audit document, 2026-10-28. Docs only. Nothing is changed.

- **Base.** `origin/main` at `931eb143`. Every `path:line` is at that commit.
  Paths without a prefix are under `src/api/`. `NNN:line` is a file in
  `supabase/migrations/`. Open work is named by PR number.
- **Plan.** `docs/SO_AGENT_INFRA_AUDIT_PLAN.md` (#643). This document is the
  audit that the plan describes. It uses the plan's ids: M-1 to M-49, Q1 to
  Q18, H-1 to H-15, D-1 to D-7, O-1 to O-6, AD-1 to AD-8.
- **Evidence.** One card per mechanism, the per-layer matrices and the full
  defect tables are in `docs/SO_AGENT_INFRA_AUDIT_CARDS.md`. Defect ids keep
  their layer prefix (L1-D01, L2-D1, L3-D1, L4-D1, L-1, T-1) so that each one
  traces to its card.
- **New ids here.** N-1 to N-35 are mechanisms that the plan did not list. X-1
  to X-24 are conflicts. P-1 to P-9 are the shared primitives of the target
  model. U-1 to U-30 are the proposed PRs. OD-1 to OD-12 are the decisions
  handed back to the owner.
- **Decisions taken before the audit.** The owner asked to resume the pending
  work after the plan. The audit used the default of each decision AD-1 to
  AD-8: `main` is the baseline with the open PRs as an overlay, code only plus
  the owner's queries later, the SO path plus every shared mechanism, a
  comparison of both target shapes, and one docs-only PR.
- **Labels.** *Verified*: read in code. *Inferred*: follows from verified
  facts, and the steps are in the card. *Not confirmed*: neither. Wired is not
  live.
- **Live state.** No production data was read. Every "live" answer waits for
  the owner's queries in Appendix A. The audit says "live: no" only where code
  alone proves that a path cannot run.
- **House rules.** Built but never wired counts as not built. The server holds
  the rules. Merged is not applied. Roles are named, people are not. No
  customer, person or part names. The next free migration number is 271.

---

## 0. Summary

1. **The owner is right.** SO agent work runs on 84 mechanisms: the 49 that the
   plan listed and 35 more that the audit found (section 2.2). They share
   almost nothing. On `main` there are 6 trust models, 11 queue shapes, 2
   staleness maps, 8 recipient resolvers, 1 send core beside 6 separate send
   rails, 8 paths that create an order, 2 dedup rules for one bell table and 5
   ways to record an actor. The open PRs raise the resolvers to 13 and the bell
   dedup rules to 4.
2. **The clock is not in the repo.** Nothing in the repo calls
   `/api/cron/tick` (`vercel.json:12-17`; no workflow; no `pg_cron`). The repo
   says that an outside cron-job.org job runs it (`docs/CRONS.md:8-14`;
   `066:3-6`), and only the owner's query A1 can confirm that. If no such job
   is live, the goal runner, the mail reaper, all inbound intake drains, all
   17 ERP retry queues and web push have never run. A worker that never ran
   has no `cron_health` row, and both health probes read a missing row as
   healthy (`_lib/heartbeat-check.js:63-88`). The daily rows fall to a
   10-minute default bound, so `/api/_healthz` answers 503 for all but about
   10 minutes a day even with no tick, and all day with a live tick (H-3).
3. **No shared gate for order writes.** Only the PATCH in `orders/[id].js`
   applies the transition table (`:67`) and the role gate
   (`_lib/order-write-gate.js:57`). Sixteen other mechanisms write an
   order around it: push, retry, the reconciler, operator actions,
   the extraction writeback, POST, the intake drains and more (X-11). POST
   accepts a client status and approval (`orders/index.js:35`, `:58-59`;
   fixed in #631). The PATCH itself lets a person set `EXPORTED_TO_TALLY` by
   hand with no voucher (`orders/[id].js:70`).
4. **Tenant isolation.** The audit found 16 cross-tenant findings (T-1 to
   T-16). Nine manual endpoints reuse the all-tenant cron body. PR #644 fixes
   two of them (T-1, T-2). The worst open one: any approver of any tenant can
   classify every tenant's inbound mail with the LLM and read their ids
   (`inbound/email/parse.js:148`, T-3). Any approver can add drift billing
   meter rows to every add-on tenant (`cron/tally-reconcile.js:90`, T-5).
5. **One Tally voucher can be posted twice.** Four live paths do it (X-12),
   because the XML uses `ACTION="Create"` and the retry drain replays with no
   check and no claim. The reconciler reads three columns that
   `tally_voucher_state` does not have (`_lib/tally-reconciler.js:325-329`;
   `016:163-176`), so it flags every exported voucher as missing. **#632 must
   not merge before U-3.** With #632, every recent exported voucher is pushed
   again once, for each tenant with the drift add-on and auto-fix on (auto-fix
   defaults to off, `095:137`), and on any manual drift check with
   `autoFix: true`.
6. **Nobody is told.** Five of six SO events reach no person by bell or email
   (section 4.3). A Tally push that gives up writes only status columns. Of the
   16 other ERP connectors, 14 ring the bell: NetSuite does not, and the
   Acumatica queue never drains. Intake actors write
   `processing_events` that no screen reads.
7. **Dead parts.** The Acumatica retry queue never drains (L1-D04). Portal
   reorder always fails (L3-D21). Email PO documents never link to their order
   (L3-D7). Attachment persistence and auto OCR starve after 80 and 20 rows
   (L1-D02, L1-D03). Inventory voice alerts never dial (L4-D6). The catalog
   embed cron never runs (L1-D10). Three goal types read a column that does
   not exist (L2-D11). The drift report never queues (L4-D21). The signed
   audit export fails (L-6).
8. **Target model (section 5).** Consolidate in place onto 9 shared primitives,
   each grown from a part that already works: a scheduler registry, a queue
   contract, an order write gate, an action gate with one autonomy map, an
   intake front door, a notice helper with one staff resolver, a send rail, a
   work record and an event log. No new status values. No new orchestrator.
9. **Migration path (section 6).** 30 small PRs. Ten safety PRs come first and
   need no decision (U-1 to U-10). Then the primitives, behavior first,
   behind today's results (U-11 to U-19). Then each mechanism moves onto them
   (U-20 to U-28). Retirements come last (U-29, U-30).
10. **Decisions (section 7).** 12 decisions, each with a default. Two are
    urgent: hold #632 until U-3 (OD-4), and fix the shape of `work_items`
    before #637 merges (OD-3).
11. **Defects (section 8).** 153 raw findings (152 from the layers, 1 from
    the verifier), 122 after merging duplicates: 24 high, 52 medium, 46 low.
    Five highs are already fixed in open PRs (#619, #622, #631, #644).

---

## 1. Method as run

- Five read-only layer auditors ran in parallel, one per layer (L1 to L5), as
  plan section 6.5 says. Each filled the Q1 to Q18 card for its mechanisms,
  answered the layer questions, read the open PRs that touch its rows and
  listed defects. They made about 800 tool calls in total. No auditor wrote to
  the repo or a database.
- The lead re-read every high claim in code before it entered this document.
  Three agent claims were wrong and are corrected here: only `orders/[id].js`
  imports the order write gate (the plan named four files); the Tally and
  NetSuite retry queues do not use `_lib/erp-runner.js`; and the voice drain is
  at `voice/process_actions.js:150`, not `:152`.
- A verifier re-read every high defect, every conflict and every signal
  verdict against the code. Section 9 lists what it changed.
- Deviation from the plan: the plan expected about 10 new mechanisms in open
  PRs. The audit also found 35 on `main` that the plan did not list. They are
  in section 2.2, with a verdict each.
- What the method cannot see: production data, provider settings outside the
  database, and the behavior of screens on a phone. Section 10 lists the
  limits.

---

## 2. O-1. Inventory

### 2.1 The planned mechanisms

Status codes are the plan's: *wired*, *wired, not scheduled* (a tick-only
handler; see H-1), *routable*, *flag off*. "Live" is *NC* (not confirmed, with
the owner query in Appendix A that settles it) or *no* (code proves it cannot
run). The verdict is the target model's action for the mechanism (section 5).

| ID | Mechanism | Status on main | Live | Verdict | Plans and PRs |
|---|---|---|---|---|---|
| M-1 | Vercel cron | wired | NC (A1) | keep | none |
| M-2 | Tick multiplexer | wired, no trigger in repo | NC (A1) | adapt onto P-1 | #566 |
| M-3 | Daily multiplexer | wired | NC (A1) | merge into P-1 | #534, #623, #640, #642 |
| M-4 | Fan-out runtime | wired | as M-2, M-3 | keep, fix | #566 (statusCode) |
| M-5 | Heartbeats | wired | NC (A1) | keep, one writer | none |
| M-6 | Staleness checks | wired; sweep only logs | NC (A1) | merge into one map (P-1) | #623 |
| M-7 | Routable-only crons (4, plus N-1) | routable | NC (A1) | register or retire each | #534 |
| M-8 | drainQueue | wired, not scheduled | NC (A1, A2) | adapt onto P-2 | none |
| M-9 | erp-runner retry and sync (15 ERPs) | wired, not scheduled | NC (A2k) | base of P-2 | none |
| M-10 | Tally and NetSuite retry copies | wired, not scheduled | NC (A2k) | merge into P-2 | #631 |
| M-11 | Extraction jobs and run reaper | jobs not scheduled; reaper daily | NC (A2a) | adapt onto P-2 | #566, #625 |
| M-12 | Goal runner | wired, not scheduled | NC (A2l, A6) | adapt onto P-2, P-4, P-6 | #566 |
| M-13 | Goal types and arming | wired | NC (A2l) | adapt (one arming helper) | #623 |
| M-14 | Reply handler | wired, not scheduled | NC (A2e) | merge into M-12 or the EA rules | #644 |
| M-15 | erp_chat loop and tool registry | wired | NC | keep | none |
| M-16 | Propose and confirm | wired | NC (A2m) | keep, grow into P-4 | #623 |
| M-17 | Ask Anvil personas | flag off | NC (A4); no app writer of the flag | keep | none |
| M-18 | MCP server | wired | NC (A6) | keep | none |
| M-19 | Operator actions | flag off | NC (A4); no app writer of the flag, no screen | keep; status write via P-3 | none |
| M-20 | Voice intake and outbound | webhook wired; drain not scheduled | NC (A2g, A2h) | adapt onto P-5 | #644 |
| M-21 | Chat intake | webhooks wired; drain not scheduled | NC (A2f) | merge into P-5 | none |
| M-22 | Legacy WhatsApp intake | wired (global token) | NC (env) | retire | none |
| M-23 | Prospecting dispatch | wired, not scheduled | NC (A1) | keep, add a claim | none |
| M-24 | Dispatch register auto-send | flag off | NC (A4); no app writer of the flag | keep, move onto P-4 | none |
| M-25 | Inbound email webhook | wired | NC (A2b) | keep as the P-5 email adapter | #635, #636 beside it |
| M-26 | Inbound email classifier | wired, not scheduled | NC (A2b) | adapt onto P-2 | none |
| M-27 | Attachment persistence | wired, not scheduled; starves | NC (A2c, A2d) | adapt onto P-2 | none |
| M-28 | Draft orders from email | wired, not scheduled | NC (A2b, A7c) | merge into P-5 | none |
| M-29 | Legacy inbound email | wired (global token) | NC (env) | retire | none |
| M-30 | Auto OCR | wired, not scheduled; starves | NC (A2o) | adapt, then merge into P-5 | none |
| M-31 | Extraction review queue | wired | NC (A3f) | merge into P-8 | none |
| M-32 | Other order creators | wired; portal reorder always fails | NC; reorder no | merge into P-5 | #631 |
| M-33 | Order transitions and approval | wired | NC (A6) | core of P-3 | #622, #626, #627, #631 |
| M-34 | Exceptions, findings, next step | wired (derived) | NC (A3d) | keep the builder; enforce in P-3 | #622, #625 |
| M-35 | Tally push and enqueue | wired | NC (A2k) | adapt onto P-3 | #632 |
| M-36 | Tally sync, retry, reconciler, meter | wired, not scheduled; reconciler re-push dead | NC (A7a) | retry onto P-2; reconciler fixed, onto P-3 | #631, #632 |
| M-37 | Mode B and handoff settings | wired; no send on main | NC (A4) | keep; read in P-3 | #626, #628, #630 |
| M-38 | Bell | wired | NC (A3a) | adapt onto P-6 | #624 |
| M-39 | Web push | wired, not scheduled | no (nobody can subscribe) | retire now | none |
| M-40 | Communications record | wired | NC (A2i) | keep; fix "draft" and "queued" | #623 |
| M-41 | Send rails | wired | NC (A2i) | merge into P-7 | #623, #630 |
| M-42 | Queued mail reaper | wired, not scheduled | NC (A2i) | adapt onto P-2, out of the goal runner | #623 |
| M-43 | Recipient resolvers | wired | NC | merge into P-6 | #623, #624, #630 |
| M-44 | Logistics exceptions | flag off | NC (A3b, A4) | adapt (notices via P-6) | #623 |
| M-45 | Inventory exceptions | routable; voice branch dead | NC (A3c) | adapt (fingerprint, P-6) | #623 |
| M-46 | Pull lists | wired | NC (A3) | keep; read the stage; owner via P-8 | #626, #629 |
| M-47 | Audit log | wired; drives billing and a metric | NC (A6) | base of P-9 | none |
| M-48 | Processing events | wired; display only | NC (A6) | becomes a view of P-9, later | none |
| M-49 | Per-mechanism logs | wired | NC (A1, A6) | keep; add the actor kind | none |

### 2.2 Mechanisms the plan did not list

| ID | Layer | Mechanism | Entry | Status and note | Verdict |
|---|---|---|---|---|---|
| N-1 | L1 | Customer health score batch | `router.js:1003`; `customers/health_score.js:224-228` | Routable only. LLM per customer. Its header claims a daily caller that does not exist. Its manual POST scores every tenant's customers (T-16) | register or retire; scope the POST |
| N-2 | L1 | Manual drain routes | e.g. `inbound/email/parse.js:146-148`, `tally/retry.js:162-169` | A second trigger for every drain. Nine reuse the all-tenant cron body (T-1 to T-8, T-16) | adapt onto P-2 (tenant required) |
| N-3 | L1 | Reap on read | `orders/pipeline_state.js:90` | A second trigger for the run reaper, tenant scoped | keep |
| N-4 | L2 | kb/ask tool loop | `kb/ask.js:34-110` | A second LLM loop over the full registry, write tools included | keep, share the persona filter |
| N-5 | L2 | Dunning drafter | `_lib/dunning-drafter.js:115` | LLM email inside a goal; cost not on `agent_steps` | keep |
| N-6 | L2 | Supplier RFQ send | `supplier_rfq/send.js:94-100` | Queued; leaves only through the reaper; says "sent" first | move onto P-7 |
| N-7 | L2 | Sourcing network handoff | `sourcing/network/handoff.js:78-90` | Queued in another tenant on purpose; says "notified" | move onto P-7 |
| N-8 | L2 | Marketing send | `marketing/send.js:35`, `:57` | Shares `_lib/marketing-send.js` with M-23 | keep its gates; share the mailer |
| N-9 | L2 | Traveler auto-print | `orders/traveler.js:65-80`; `netsuite/push.js:187` | Print job after a NetSuite push only | keep |
| N-10 | L2 | Quote expiry cron | `quotes/expire.js:25-57`; `cron/daily.js:72` | Ends quote goals; manual path crosses tenants (T-8) | register in P-1 |
| N-11 | L2 | Recurring invoice and AMC visit crons | `billing/recurring_cron.js:84`; `service/amc_cron.js:74` | Write money and visit records with no person | register in P-1 |
| N-12 | L2 | Eval replay and rescore | `eval/replay.js:104`, `:373`; `eval/rescore.js:168` | Caller picks any `tenant_id` (T-13) | register; fix the override |
| N-13 | L2 | Pay-link minting by an agent | `agents/_handlers/ar_collect.js:260` | A legacy portal token per dunning step | keep; review with the portal plan |
| N-14 | L3 | EDI inbound | `edi/inbound.js:22-56` | Writes `edi_envelopes` only; header says it links an order, it does not | adapt onto P-5 later |
| N-15 | L3 | ERP SO attach | `orders/attach_sales_order.js:59`, `:144`, `:179` | The only writer of Mode B evidence; coarse `write` only | keep; gate with `so.write` |
| N-16 | L3 | DocAI sync extract and job enqueue | `docai/extract.js:54`; `orders/extraction_jobs.js:137` | Takes `storage_path` from the body (T-10) | keep; check the path |
| N-17 | L3 | Manual quote reconcile | `orders/reconcile_quotes.js:40` | Rewrites lines at any status, no compare-and-set | move onto P-3 |
| N-18 | L3 | Tally reconcile endpoint | `tally/reconcile.js:33-110` | Hand-set Mode B end; `autoFix` from a `write` body | move onto P-3 |
| N-19 | L3 | Customer merge | `customers/merge.js:54-64` | Moves the customer of approved orders; the approval stays | move onto P-3 |
| N-20 | L3 | Order delete | `orders/[id].js:477-484` | Hard delete at any status; voucher records go with it | move onto P-3 |
| N-21 | L3 | Server reconcile and anomaly trigger | `_lib/order-reconcile.js:404-446` | The only shared post-write step | keep; call from P-3 and P-5 |
| N-22 | L3 | ERP connector result writes | 16 push, retry and sync files (sample `sap/retry.js:36`) | No tenant filter on the update; no Mode B read | move onto P-3 |
| N-23 | L4 | Nav count badges | `src/v3-app/lib/telemetry.ts:83-107` | Tenant-wide counts; PENDING_REVIEW counted twice | keep; read the stage |
| N-24 | L4 | Home "My queue" | `src/v3-app/screens/home.tsx:64`, `:82-84` | Not per user; first 8 of 50 | replace with the worklist (#629) |
| N-25 | L4 | Orders Kanban | `src/v3-app/screens/pipeline-kanban.tsx:61-87` | Only list with a FAILED_TALLY_IMPORT column | keep |
| N-26 | L4 | Background extraction watch | `src/v3-app/components/BackgroundExtractionWatch.tsx:23-28` | Only signal for a finished extraction, while the order is open | keep |
| N-27 | L4 | Admin ERP health banners | `src/v3-app/screens/admin.tsx:2477-2479` | Only place a Tally give-up shows | keep until P-6 notices |
| N-28 | L4 | Thread drawer comms panel | `src/v3-app/components/ThreadDrawer.tsx:156` | Only working reader of `communications` | merge into the order timeline |
| N-29 | L4 | Comms screen | `src/v3-app/screens/comms.tsx:84-95` | Broken; #623 fixes | fix (#623) |
| N-30 | L4 | Manual customer drafts | `comms/dispatch_register.js:86`; `comms/payment_statement.js:96`; `comms/service_report.js:122` | Stored `queued`; the reaper sends a draft (L4-D1) | fix in U-7 |
| N-31 | L4 | Drift report email | `cron/drift-report.js:105-125` | Never queues (L4-D21) | move onto P-6 resolver |
| N-32 | L4 | Signup bell insert | `auth/signup.js:120-134` | A bell writer outside the helper | move onto P-6 |
| N-33 | L4 | Rep touch log | `_lib/rep-touch.js` | A record, not a notice | keep |
| N-34 | L4 | Print jobs relay | `orders/print_jobs.js` | A device queue for an on-site relay | keep |
| N-35 | L4 | Agents screen | `src/v3-app/screens/agents.tsx:71` | Only list of goals and their escalations | keep |

---

## 3. Signal verdicts

| Signal | Verdict | What the audit found |
|---|---|---|
| H-1 Tick never ran | Partly | Repo side Verified: no trigger in the repo, but the repo documents a cron-job.org job (`docs/CRONS.md:8-14`). Live side Not confirmed (A1). A tick that never ran is invisible, because a missing row reads healthy (L1-D06); a tick that stopped leaves a stale row |
| H-2 Routable-only and double crons | Confirmed, wider | Five routable-only crons, not four (N-1 is the fifth). The logistics monitor runs on both paths and can notify twice at 02:30 UTC (Inferred, L1-D28). #640 adds a second double handler |
| H-3 Two staleness maps | Confirmed | `health.js:99-109` has 4 keys, `_lib/heartbeat-check.js:18-50` has 12. The 12 daily rows fall to the 10-minute default, so `/api/_healthz` is 503 for all but about 10 minutes a day even with no tick. With a live tick, 11 syncs, `tally/reconcile`, `plm/sync`, `drift-meter` and `eval/rescore` also fall to 10 minutes, and it is 503 all day (Inferred) |
| H-4 Heartbeat written twice | Confirmed | Two writes per run, three for the logistics monitor. One failure usually adds 2 to `consecutive_failures` (Inferred from `_lib/cron-mux.js:178`, `:233-238`) |
| H-5 Two trust models, no gate | Confirmed, wider | Six trust models (section 4.1, X-9). No actor write passes the transition table or the role gate. `DEFAULT_AGENT_POLICY` is display only. Correction: only `orders/[id].js` imports the gate and the evaluator |
| H-6 Two designs claim `work_items` | Confirmed; partly in conflict with R-M6 | EA-3 builds a subset of WM 4.2 with the same names. Every non-header item must store a status, and `subject_id uuid` cannot point at a derived exception or stage (X-19) |
| H-7 Six queue shapes | Confirmed, wider | Eleven on main, thirteen with #635 and #640. Only the erp-runner shape has a claim, a stuck reset, a cap, backoff and a notice (Appendix B) |
| H-8 Mail leaves only through the goal runner | Confirmed, wider | Eleven producers queue mail. The reaper runs hourly, inside the goal runner, only for tenants with a due goal among the first 50 |
| H-9 One failure, different notices | Confirmed | Tally and NetSuite give-ups tell nobody. SAP give-ups ring a broadcast bell. A first SAP 4xx tells nobody. The recovery goal cannot see SAP failures and is armed only by hand. The #611 sentence on the bell is wrong for Tally |
| H-10 Two manual drains cross tenants | Confirmed | Fixed in open #644 |
| H-11 Eight order creators | Confirmed | Nine insert sites, no shared dedup. Only POST runs mapping, blockers and reconcile. The writeback rewrites lines at any status (#625 fixes) |
| H-12 Several voucher push paths | Confirmed, corrected | Live: manual push then retry, two concurrent pushes, copilot enqueue then push, two overlapping drains. The reconciler re-push is dead on main (its insert fails) and comes alive with #632 |
| H-13 Several resolvers | Confirmed | Thirteen, eight on main. One role reaches different people per channel |
| H-14 Several send rails, false "sent" | Confirmed | One core with six branches and six separate rails. Eight places report "sent" when nothing left |
| H-15 Two inbound email paths | Confirmed, worse | The legacy path also merges different customers' mail into one DRAFT by matching part of the subject (L3-D17) |
| D-1 | Confirmed, a class | Nine manual endpoints and four request inputs cross tenants (T-1 to T-16). #644 fixes T-1 and T-2 |
| D-2 | Confirmed | Tally and NetSuite |
| D-3 | Confirmed | Tally and NetSuite; claim columns from 059 unused; #631 does not add a claim |
| D-4 | Confirmed, worse | The `voice_calls` insert can never succeed (`041:61-71`), and the code still stamps the call as made |
| D-5 | Confirmed | A new row, bell and email every day for one open problem |
| D-6 | Confirmed on main | #623 fixes |
| D-7 | Three confirmed, one partly | PATCH accepts lines on APPROVED; FAILED_TALLY_IMPORT has no move to DRAFT; reconciler errors unchecked (wider). The "skipped stored as gave_up" item does not exist on main; #631 adds it |

---

## 4. O-2. Overlap and conflict

### 4.1 Jobs and how many ways each is done

| Job | Ways on main | Mechanisms | Class |
|---|---|---|---|
| Schedule | 3 triggers: Vercel daily, an outside trigger the repo lacks, manual routes | M-1, M-2, M-3, N-2 | Divergent, Double fire |
| Claim and lease | 3 of 11 shapes claim | M-9 claim, M-11 lease, M-16 token; the rest none | Divergent |
| Retry and give up | 3 backoff copies, 4 "one try" loops, 1 "retry forever" | M-9, M-10, M-8, M-42, M-27 | Duplicate, Divergent |
| Dedup | 6 intake rules, 4 bell rules | M-25, M-28, M-29, M-21, M-22, M-32; M-38, M-44, M-45, #640 | Divergent |
| Decide (policy) | 6 trust models: act after a standing arm (goals), act on an inbound event (intake), propose and self-confirm (copilot, MCP), governed human checklist (operator actions), flag auto-send (dispatch), batch pre-approval (prospecting) | M-12 to M-24 | Divergent |
| Act on an order | 17 writers; 1 passes the gate | M-33 vs M-11, M-20, M-21, M-22, M-28, M-29, M-32, M-35, M-36, M-19, N-17 to N-22 | Gap, Divergent |
| Send outside | 1 core plus 6 rails; 5 producers wait for the tick | M-41, M-42, M-23, M-20, M-39, N-6, N-7 | Divergent |
| Notify a person | broadcast bell, dead push, stamped exception bells, digest | M-38, M-39, M-44, M-45 | Divergent, Gap |
| Track human work | 7 records with an owner-like field | agent_goals, action_proposals, operator_actions, review queue, quote_approvals, logistics owner, #637 work_items | Divergent |
| Escalate | 3 shapes | M-12 broadcast, M-44 breach bell, #640 per person | Divergent, Gap |
| Record the trail | 5 actor shapes | M-47, M-48, M-49, M-40, M-38 | Divergent |
| Report health | 2 maps, 3 writers per run | M-5, M-6 | Duplicate, Divergent |

### 4.2 Conflicts

| ID | Class | Conflict | Evidence | Fixed by |
|---|---|---|---|---|
| X-1 | Divergent | Two triggers: Vercel runs daily; nothing in the repo runs the tick, and the documented cron-job.org job is outside the repo | `vercel.json:12-17`; `cron/tick.js:134` | #566, then U-11 |
| X-2 | Double fire | The logistics monitor runs in tick and daily; both can notify at 02:30 UTC. #640 adds `email/sweep` on both | `cron/tick.js:187`; `cron/daily.js:91`; `_lib/logistics/notifications.js:100-153` | U-11 |
| X-3 | Divergent | Exact-minute gates skip groups when the trigger is late; groups run in sequence, 80 s of budgets at minute 0 against a 60 s limit | `cron/tick.js:143-149`, `:190-217`; `vercel.json:9` | U-11 |
| X-4 | Duplicate | Two staleness maps; a missing row reads healthy; two or three heartbeat writes per run | `health.js:99-109`; `_lib/heartbeat-check.js:18-88`; `_lib/cron-mux.js:178` | U-11 |
| X-5 | Divergent | Eleven queue shapes; Tally and NetSuite copy the retry loop with no claim and no notice; Acumatica's claim always fails | Appendix B; `tally/retry.js:124`; `059:77-81` vs `019:55` | U-9, U-12, U-13 |
| X-6 | Double fire | Every drain has a cron trigger and a manual route; nine manual routes run the all-tenant body | T-1 to T-8, T-16 | U-1, U-14 |
| X-7 | Divergent | Eight order creators with six dedup rules; none on PO number or document hash at create (the duplicate search scores both, but only on request, `duplicates/search.js:19`) | L3 section 3 in the cards | U-25, U-26 |
| X-8 | Divergent | Four dedup rules for one bell table: a 5-minute window, #624's fan-out suppression, #640's ledger, a dated inventory fingerprint | `_lib/notifications.js:50-60`; `_lib/inventory/exceptions-detector.js:66` | U-16 |
| X-9 | Divergent | Six trust models; no actor reads `DEFAULT_AGENT_POLICY`; a tenant cannot stop the goal runner | `_lib/order-exceptions.js:225`, `:280`; `agents/run.js:330-336` | U-22 |
| X-10 | Divergent | Three tool loops share one registry, but two executors (copilot, goal runner) and the goal handler registry share nothing | `copilot/confirm.js:22`; `agents/run.js:98`; `agents/_handlers/index.js:45` | U-23, U-24 |
| X-11 | Gap | Only the PATCH applies the transition table and the role gate; 16 mechanisms write around it; POST accepts APPROVED; the PATCH sets ERP states by hand | `orders/[id].js:67-85`, `:144`; `orders/index.js:35`; L3 section 4 | U-6, U-19 to U-21 |
| X-12 | Double fire | One voucher can be posted twice by four live paths, and by a fifth with #632 | `tally/retry.js:66-101`; `tally/push.js:185-206`; `_lib/tally-enqueue.js:39-52`; `_lib/tally-build-voucher.js:335` | U-3, U-4, U-5 |
| X-13 | Divergent | Blockers stop approve and push; send is checked only in the browser; the handoff (#630) checks terms only; a `so.write` user can clear a blocker by sending it back resolved | `orders/[id].js:245`; `_lib/order-next-step.js:93`; `_lib/blocking-findings.js:64-66` | #622, U-19 |
| X-14 | Divergent | Only the Tally push and retry read Mode B; the copilot enqueue, 15 ERP connectors and the PATCH do not | `tally/push.js:88`; `tally/retry.js:121`; `_lib/so-processing-mode.js:1-11` | U-19, U-20 |
| X-15 | Divergent | One send core, six separate rails; five producers depend on the tick reaper; eight false "sent" results | L4 section 4 in the cards | #623, U-17 |
| X-16 | Divergent | "queued" means "a machine sends later" and also "a person confirms"; the reaper sends both | `_lib/comms-row.js:48-53`; `comms/dispatch_register.js:86` | U-7 |
| X-17 | Gap | Five of six SO events reach no person; intake writes `processing_events` that no screen reads | section 4.3 | U-16 |
| X-18 | Divergent | Thirteen recipient resolvers; one role reaches different people per channel | L4 section 3 in the cards | U-18 |
| X-19 | Divergent | Seven records hold human work; #637 adds an eighth with its own state set; R-M6 needs a pointer to a derived stage or exception | `011:52`, `:69`; `149:12`; `150:14`; `123:28`; `006:622`; `206:59`; #637 `252` | U-27 |
| X-20 | Divergent | Goal escalation rings one broadcast row, gated by the goal's escalate roles (default admin), and never the owner; #640 notifies the person; logistics rings once on breach; nothing else escalates | `agents/run.js:117-127`; #640 `escalation.js` | U-16 |
| X-21 | Divergent | Five actor shapes; agent, cron, webhook and portal rows store a null actor; `processing_events` has no actor; some audit rows are lost (invalid enum, wrong column) | `_lib/audit.js:59-62`; `001:343-353`; L-2, L-3 | U-15 |
| X-22 | Gap | No single order timeline; seven actor paths write nothing keyed to the order | L5 section 3 in the cards | U-28 |
| X-23 | Gap | Manual paths reuse all-tenant bodies; four request inputs are used as keys with no tenant check | T-1 to T-13, T-16 | #644, U-1, U-2 |
| X-24 | Dead | Acumatica retry, portal reorder, reconciler re-push, inventory voice, drift report, catalog embed, web push, three goal types, the signed audit export | section 0 item 7 | U-8, U-9, U-24, U-29 |

### 4.3 One SO event, every channel

On `main`. "Push" means a bell or an email that reaches a person.

| Event | Rows written | Where a person sees it | Push |
|---|---|---|---|
| 1. A PO email arrives | `inbound_emails` row; DRAFT order (tick); audit rows | Email screen, intake screen, a badge, Home | none |
| 2. Background extraction ends or fails | job status; `processing_events`; audit | The extraction watch, only while that order is open | none |
| 3. An order enters PENDING_REVIEW | audit; event; `quote_approvals` row if a threshold matches | Approvals queue, a badge, Home, Kanban | none: the approver is not told |
| 4. An order is approved | audit; event; status | Tally push screen (Mode A), Home, Kanban | none: the submitter is not told |
| 5a. A Tally push fails | status FAILED_TALLY_IMPORT; voucher record; audit; event; retry row if recoverable | HTTP error to the pusher; Kanban. Not on the Tally push screen (L4-D9) | none |
| 5b. A Tally retry gives up | queue and voucher status only | A count on the admin Tally tab | none |
| 5c. An SAP push fails | result field; audit; retry row if recoverable | Audit list | none |
| 5d. An SAP retry gives up | broadcast bell row | Desktop bell, admin and operator only | one |
| 6a. The Mode B handoff is sent | nothing: no send on main | none | none |
| 6b. The SO is keyed in the ERP | `so_voucher_no`; order document; audit | SO register | none |

If #623, #624 and #630 merge: a daily admin bell when the tick is stale; the
bell on the phone for admin and operator; and the handoff email reaches the
processing team. Events 3, 4 and 5a to 5c still reach nobody.

---

## 5. O-3. Target unified model

### 5.1 Which shape

AD-4 asked the audit to compare two shapes.

- **A. Consolidate in place.** Keep the tables. Put shared primitives under
  them, and move each mechanism onto the primitives one PR at a time.
- **B. A new core.** One new work and action spine that every mechanism moves
  onto.

**Recommendation: A.** Every primitive below already has a working seed in the
repo: the erp-runner claim and backoff, #566's handler registry, the PATCH
gate, the propose-and-confirm token, #624's per-person notice,
`sendCommunication`, `resolveInternalRecipients` and `audit_events`. A new core
would be a twelfth queue shape and a seventh trust model until every old path
moved, and the repo's history shows that the move is the part that does not
finish ("built but never wired"). A also keeps each PR small enough to ship its
caller.

### 5.2 The primitives

| ID | Primitive | Where | Grows from | Plan constraint | Moves onto it first |
|---|---|---|---|---|---|
| P-1 | Scheduler registry. One entry per handler: name, path, method, cadence, budget, effects, default on or off. A handler runs when `now - last_run_at >= cadence`, not on an exact minute. One staleness map derived from the cadence; a missing expected row is stale. One heartbeat write per run | `_lib/cron-registry.js` | #566 `TICK_HANDLERS` | 4 | tick, daily, both maps, routable-only crons |
| P-2 | Queue contract. Claim (status or lease), stuck reset, attempts cap, backoff, give-up status, age limit, per-tenant limit, tenant required on manual calls, heartbeat, notice on give-up | `_lib/queue-contract.js` | `_lib/erp-runner.js:64-165` | 5 | Tally and NetSuite retry, drainQueue callers, the reaper, the goal runner |
| P-3 | Order write gate. Authority (role action for a person, autonomy map for a machine), transition table, content rule (lines writable only before approval), blockers for send, approve, push and handoff alike, approval binding, Mode B, compare-and-set, one audit row with the actor kind | `_lib/order-write-gate.js` grown into `applyOrderWrite` | `orders/[id].js:67-295` | 1, 2 | push, retry, reconciler, operator actions, writeback, POST, handoff |
| P-4 | Action gate and one autonomy map. Every machine action (send an email, place a call, create a draft order, queue an ERP push, set a status, arm a goal) goes through one function that reads one map: shadow, propose, apply or human only. Defaults keep today's behavior | `_lib/action-gate.js`; `tenant_settings.so_controls` (266, #611 R-M2) | `copilot/confirm.js`, `_lib/action-proposals.js` | 2, 3 | copilot executor, goal sends and calls, dispatch auto-send |
| P-5 | Intake front door. One function creates every order: a unique source reference, a document hash check, a customer and PO duplicate candidate, then the same post-create steps (customer match, document links, item mapping, blockers, reconcile, anomaly check, extraction enqueue, audit, notice) | `_lib/order-intake.js`; unique `(tenant_id, intake_source, intake_ref)` | `orders/index.js:126-251` | 1, 2 | draft_orders, chat, voice, POST, quote convert, portal reorder |
| P-6 | Notice helper and staff resolver. One row per person, every role, desktop and phone; roles expand through one resolver; one dedup ledger keyed by subject and notice key | `notify()` in `_lib/notifications.js`; `resolveInternalRecipients` | #624; `_lib/internal-recipients.js:127` | 6 | ERP give-ups (Tally included), goal escalation to the owner, logistics and inventory notices, SO events |
| P-7 | Send rail. A row starts as `draft` (a person acts) or `queued` (a machine sends later). The rail reports `sent` only when a provider accepted. Chat channels with no config fail. One customer resolver | `sendCommunication`; `resolveForCustomer` | `_lib/comms-send.js:106`; `_lib/comms-routing.js:134` | 9 | drafts, WhatsApp, invoice, supplier RFQ, sourcing, quote and invoice recipients |
| P-8 | Work record. `work_items` (252) with a `subject_ref` pointer for a derived stage or exception, a status registry per subject type, one priority scale, closing evidence for each order item. An order item never writes `orders.status` | `work_items` (252, adjusted before #637 merges) | WM 4.2; EA-3 | 7 | email actions, goal escalations, logistics exceptions that need an owner, pending approvals |
| P-9 | Event log. `audit_events` gains `actor_kind`, `actor_ref`, `case_id` and `source`. `recordAudit` derives the kind from the context. `processing_events` becomes a view later. One order timeline endpoint reads it | `audit_events` (migration 272); `GET /api/orders/:id/timeline` | `_lib/audit.js:74` | 8 | direct audit inserts, cron order writes, goal steps, copilot confirms |

### 5.3 What stays human

The action gate refuses a machine for these, whatever the map says: approve an
order; accept a high or critical terms flag; cancel or reject; key the SO in
Tally in Mode B; a price outside the tolerance; a new customer, item or
supplier master; the first amendment email to a customer; any policy change.
This matches #611 R-M2.

### 5.4 What the model does not add

No new order status values. No workflow engine or orchestrator. No new queue
table where an existing table works. No Slack or Teams to staff. No external
task tool (#540 dropped them).

---

## 6. O-4. Migration path

Rules for every PR: one primitive or one move; it ships its caller; it keeps
today's behavior or sits behind a flag that defaults to off; it carries its
tests; a retirement first proves zero callers; migrations take numbers from 271
up. "Needs" names the PRs or decisions it waits for.

### 6.1 Stage 0. Safety fixes (no decision needed)

| PR | What | Fixes | Needs | Migration |
|---|---|---|---|---|
| U-1 | Scope the remaining manual drains to the caller's tenant: parse, persist_attachments, quotes/expire, tally-reconcile, drift-report, customer health score; make drift-meter cron only | T-3 to T-8, T-16, L2-D3, L2-D4 | #644 merged (same pattern) | none |
| U-2 | Check request inputs against the tenant: erp_chat `session_id`, extraction `storage_path`, push `subscription_id`, eval `tenant_id` (platform role only); an MCP token stops when its owner leaves | T-9, T-10, T-11, T-13, L-15 | none | none |
| U-3 | Fix the reconciler state read: select `external_voucher_no` and the real columns, read the error, match on the stored voucher number | L3-D2; unblocks #632 | none | none |
| U-4 | Tally retry safety: claim rows with the 059 columns; skip a replay when a voucher record for the same key is already exported or imported | L3-D1, D-3, L1-D13 | none | none |
| U-5 | Copilot Tally enqueue uses the manual push checks (blocker, variance, Mode B, status) and writes the voucher record at enqueue | L2-D7, L3-D11 | none | none |
| U-6 | Remove ERP states from hand moves in the PATCH table; push requires APPROVED or FAILED_TALLY_IMPORT, an unexpired approval and a conditional status update | L3-D31, L3-D9, L3-D10 | #631 merged | none |
| U-7 | Manual customer drafts insert `draft`, not `queued` | L4-D1 | none | none |
| U-8 | Dead writes: draft_orders link without `tenant_id`; WhatsApp links through `order_documents`; portal reorder inserts DRAFT; audit inserts use `actor`; audit export uses `created_at`; catalog embed runs as POST; inventory voice branch removed | L3-D7, L3-D25, L3-D21, L-2, L-6, L1-D10, L4-D6 | none | none |
| U-9 | Acumatica retry queue gets the claim columns and the `processing` value; RLS on with no policy for `audit_failures` and `cron_health` | L1-D04, T-15 | none | 271 |
| U-10 | Attachment persistence and auto OCR pick rows in SQL, so the window moves | L1-D02, L1-D03 | none | none |

### 6.2 Stage 1. Primitives, behavior first

| PR | What | Primitive | Needs | Migration |
|---|---|---|---|---|
| U-11 | `_lib/cron-registry.js` from #566's registry plus the daily entries; due since last run; one heartbeat write; one staleness map; a missing expected row is stale; `health.js` imports it | P-1 | #566 merged; OD-1 | none |
| U-12 | `_lib/queue-contract.js` extracted from erp-runner; erp-runner calls it; no behavior change | P-2 | none | none |
| U-13 | Tally and NetSuite retry move onto the contract: claim, give-up notice | P-2 | U-4, U-12 | none |
| U-14 | drainQueue callers move onto the contract with a claim and a required tenant on manual calls; extraction jobs get an attempts cap | P-2 | U-12 | none |
| U-15 | `audit_events` gains `actor_kind`, `actor_ref`, `case_id`, `source`; `recordAudit` derives them; cron paths pass a system actor; recordEvent also writes the audit row | P-9 | none | 272 |
| U-16 | One notice ledger generalised from #640's before #640 merges; erp-runner, Tally and NetSuite give-ups, goal escalation (to the owner) and logistics and inventory notices call `notify()`; the inventory fingerprint loses its date | P-6 | #624 merged; OD-3 | 273 |
| U-17 | Send rail rules: chat channels fail with no config; no "manual::sent"; invoice and supplier RFQ use the failed-row rule; sourcing sends directly | P-7 | #623 merged | none |
| U-18 | One staff resolver behind `notify()` roles, alerts, handoff and drift report; quote and invoice recipients through `resolveForCustomer` | P-6, P-7 | U-16 | none |
| U-19 | `applyOrderWrite` extracted from `orders/[id].js`; the PATCH calls it; no behavior change | P-3 | #622, #631 merged | none |

### 6.3 Stage 2. Move each mechanism

| PR | What | Primitive | Needs | Migration |
|---|---|---|---|---|
| U-20 | Tally push, retry, reconciler auto-fix and operator status reconcile write through `applyOrderWrite` | P-3 | U-19 | none |
| U-21 | The extraction writeback (#625 logic), the POST initial row, manual quote reconcile, customer merge and the handoff (#630) write through the gate; the handoff checks stored blockers | P-3 | U-19, #625, #630 | none |
| U-22 | `so_controls` (266) and `_lib/action-gate.js`; first use: a per-tenant switch for goal sends | P-4 | OD-2 | 266 |
| U-23 | The copilot executor runs through the action gate | P-4 | U-22 | none |
| U-24 | The goal runner moves onto the contract (claim, failure count, give-up) and the action gate (send and call); the reaper leaves the runner as its own registry entry with a cap and an age limit; the three goal types that read a missing column are fixed or disarmed | P-2, P-4 | U-11, U-12, U-22, OD-8 | none |
| U-25 | `_lib/order-intake.js` with a unique source reference; draft_orders moves first | P-5 | U-19 | 274 |
| U-26 | Chat, voice, POST, quote convert and portal reorder create orders through the front door | P-5 | U-25 | none |
| U-27 | `work_items` gets `subject_ref`, a status registry per subject type and one priority scale, before #637 merges; goal escalations and owned logistics exceptions open items | P-8 | OD-3 | change to 252 before merge |
| U-28 | `GET /api/orders/:id/timeline` over the event log and `communications`; ThreadDrawer and the SO Activity tab call it | P-9 | U-15 | none |

### 6.4 Stage 3. Retire

| PR | What | Needs |
|---|---|---|
| U-29 | Retire the legacy email and WhatsApp webhooks, the half-built web push, the `health.js` map and the direct bell inserts; `notifyAdmins` becomes a wrapper of `notify()` | OD-5, OD-6; zero callers proved |
| U-30 | One daily purge for personal data in logs, on the #642 pattern | OD-11 |

### 6.5 Crosswalk to the existing plans

| Plan item | Where it lands |
|---|---|
| #566 tick scheduler | Input to U-11; merge first, keep its default allow-list |
| #611 C-3 (#622), C-2 (#625) | Feed P-3; U-19 and U-21 build on them |
| #611 C-5 (#623) | Feeds P-7; U-17 builds on it |
| #611 C-17 (#624) | Is P-6; U-16 builds on it |
| #611 C-9 (#626), C-11 (#629) | The stage that P-8 items point at; the worklist reads it |
| #611 C-18 (#630) | Its send uses P-7; its gate moves into P-3 (U-21) |
| #611 R-M2 (266) | Is P-4's map (U-22) |
| #611 R-F6 | Is P-5 (U-25, U-26) |
| WM-5, EA-3 (#637) | P-8; U-27 adjusts 252 before #637 merges |
| EA-6 (#640) | Its ledger becomes the one ledger (U-16) |
| #631, #632, #633, #644 | #631 and #644 come before U-1 and U-6; #632 waits for U-3; #633 is independent |

---

## 7. O-5. Decisions handed back

| # | Decision | Options | Default | Evidence |
|---|---|---|---|---|
| OD-1 | Which trigger runs the tick? | A) GitHub Actions (#566). B) Supabase pg_cron with pg_net. C) cron-job.org | A now for the default allow-list, after the owner disables any live cron-job.org job (two triggers run every drain twice); with U-11 a late run no longer skips a group. Move to B if gaps over 10 minutes are common | X-1, X-3 |
| OD-2 | What is the trust model for machine actions? | A) One action gate with one map; defaults keep today's behavior; add a per-tenant switch for goal sends. B) Same, but goal sends start as "propose". C) No gate | A | X-9, X-10 |
| OD-3 | Where does human work live? | A) One `work_items` table: adjust 252 (U-27) and the notice ledger (U-16) before #637 and #640 merge. B) Email actions keep their own shape; order work comes later | A | X-19, H-6 |
| OD-4 | Does #632 wait? | A) Yes, until U-3. B) Merge now: the risk is limited to tenants with the drift add-on and auto-fix on, and to manual checks with `autoFix: true` | A | X-12, L3-D2 |
| OD-5 | Retire the legacy email and WhatsApp webhooks? | A) Yes, after the owner confirms that no provider posts to them (both env tokens unset or unused). B) Keep, with a tenant-bound secret | A | H-15, T-14 |
| OD-6 | Web push | A) Retire the half that exists; the bell on the phone comes from #624. B) Finish it (C-20) | A | M-39 |
| OD-7 | The turn-on order for tick handlers | A) #566's order, one group at a time, after each group's cleanup SQL. B) All at once | A | #566 body |
| OD-8 | The goal types that cannot run | A) Disarm the three that read a missing column and fix `missing_doc`; fix the object types on the arming path. B) Fix all now | A | L2-D11, L2-D12, L2-D23 |
| OD-9 | Hand-set ERP states | A) Remove EXPORTED_TO_TALLY and RECONCILED from hand moves (U-6); keep the Mode B "imported" mark as unverified (C-D4). B) Keep | A | L3-D31 |
| OD-10 | Who may return an order for a fix? | A) The server requires `so.approve` (#633 option A). B) No change | A | L-21 |
| OD-11 | Retention of personal data in logs | A) Per-table retention on the #642 pattern: message bodies and transcripts 365 days, audit rows kept. B) No purge | A | L-23 |
| OD-12 | Billing that reads the trail | A) The billing owner reviews drift-meter and the outcome billing gaps before the tick runs those handlers. B) No review | A | T-6, L-7, L-8 |

---

## 8. O-6. Defects found, not fixed

The five layers reported 152 findings, and the verifier added one (T-16).
Merged duplicates leave 122: 24 high, 52 medium and 46 low. Five highs are fixed in open PRs (#619, #622, #631,
#644). Every row names its card id; the full failure scenario is in the cards
file. "PR" is the U-PR or open PR that fixes it.

### 8.1 High

| # | Ids | Where | What goes wrong | PR |
|---|---|---|---|---|
| 1 | T-1, D-1 | `agents/handle_replies.js:181` | One tenant's approver handles every tenant's replies | #644 |
| 2 | T-2, D-1 | `voice/process_actions.js:150` | One tenant's approver creates DRAFT orders in every tenant | #644 |
| 3 | T-3, L1-D01, L3-D3 | `inbound/email/parse.js:148` | An approver classifies every tenant's mail with the LLM and reads their ids and intents | U-1 |
| 4 | T-4 | `inbound/email/persist_attachments.js:128` | An approver persists every tenant's attachments | U-1 |
| 5 | T-5 | `cron/tally-reconcile.js:90` | An approver runs every add-on tenant's drift check and auto-fix, and each call adds a billing meter row per tenant (`_lib/tally-reconciler.js:407-418`) | U-1 |
| 6 | T-6, L2-D3 | `cron/drift-meter.js:152-156` | A tenant admin submits every tenant's pending meter rows early and reads their ids and provider errors | U-1 |
| 7 | T-7 | `cron/drift-report.js:266-270` | On day 1, a tenant admin reads every add-on tenant's drift totals and writes a report-sent audit row in each; no email is queued (L4-D21) | U-1 |
| 8 | T-16 | `customers/health_score.js:243-244` | An approver runs LLM health scoring on every tenant's customers and reads their ids and scores | U-1 |
| 9 | T-9, L2-D14 | `erp_chat/send.js:85`, `:105-108` | A known session id feeds another tenant's chat history to the model | U-2 |
| 10 | T-10 | `orders/extraction_jobs.js:126`; `cron/extraction_jobs.js:179` | A body `storage_path` extracts another tenant's file into the caller's order | U-2 |
| 11 | T-12 | `_lib/tally-client.js:155-163` | The env bridge serves every tenant with no company row | #619 |
| 12 | T-13, L2-D5 | `eval/replay.js:373`; `eval/rescore.js:168` | The caller picks any tenant's golden cases and provider key | U-2 |
| 13 | T-14, L2-D8, L3-D17 | `whatsapp/inbound.js:166-179`; `email/inbound.js:125-140` | One global token writes DRAFT orders into any tenant chosen by a header | U-29 (OD-5) |
| 14 | T-15, L-19 | `063:20`; `066:18` | No RLS on `audit_failures` and `cron_health` (Inferred: readable with the anon key) | U-9 |
| 15 | L3-D2 | `_lib/tally-reconciler.js:325-329` | Every exported voucher reads as missing; with #632 and auto-fix on (off by default), every recent one is re-pushed | U-3 |
| 16 | L3-D1 | `tally/retry.js:66-101` | A queued retry replays after a successful re-push: a second voucher | U-4 |
| 17 | L2-D7, L3-D11 | `_lib/tally-enqueue.js:13-56` | The copilot enqueue skips the push checks and writes no voucher record | U-5 |
| 18 | L2-D6, L3-D30 | `orders/index.js:35`, `:58-59` | POST creates an APPROVED order with a client approval | #631 |
| 19 | L3-D31 | `orders/[id].js:70-71` | A PATCH marks an order exported with no voucher | U-6 |
| 20 | L3-D7, L1-D15 | `inbound/email/draft_orders.js:94-103` | Email PO documents never link to the order | U-8 |
| 21 | L1-D02, L3-D6 | `inbound/email/persist_attachments.js:51-57` | After 80 emails, no attachment is stored again | U-10 |
| 22 | L1-D03, L3-D8 | `inbound/auto_ocr.js:43-62` | After 20 documents, nothing new is OCR'd | U-10 |
| 23 | L4-D1 | `comms/dispatch_register.js:86`; `comms/payment_statement.js:96`; `comms/service_report.js:122` | A draft meant for a person's check is sent to the customer by the reaper | U-7 |
| 24 | L3-D4 | `so-workspace.tsx:1160-1163`; `_lib/blocking-findings.js:62-68` | "Run validation" drops the -MOD blocker, so the order can be approved | #622 |

### 8.2 Medium

| Ids | Where | What goes wrong | PR |
|---|---|---|---|
| T-8 | `quotes/expire.js:73-75` | An approver runs the daily quote expiry early and reads other tenants' quote numbers | U-1 |
| T-11 | `push/send.js:29`, `:88` | A push could go to another tenant's device; dormant while nobody can subscribe | U-2 |
| L1-D04 | `acumatica/retry.js:57`; `059:77-81` | Acumatica retries never drain | U-9 |
| L1-D05 | `_lib/cron-mux.js:39-62` | A handler's 500 is recorded as 200 | #566 |
| L1-D06 | `_lib/heartbeat-check.js:63-88` | A worker that never ran reads healthy | U-11 |
| L1-D07 | `health.js:99-109`; `_lib/heartbeat-check.js:18-50` | `/api/_healthz` is 503 most of the day | U-11 |
| L1-D08 | `cron/tick.js:190-217` | Minute 0 needs 80 s against a 60 s limit | U-11 |
| L1-D09 | `cron/tick.js:143-149` | A late trigger skips the 30-minute, hourly and minute-5 groups | U-11 |
| L1-D10 | `cron/daily.js:75`; `catalog/embed.js:122-124` | The catalog embed cron never runs | U-8 |
| L1-D11, L3-D16 | `cron/extraction_jobs.js:145` | A job that kills the function retries every tick with LLM cost | U-14 |
| L1-D12 | `_lib/queue-runner.js:66-86` | Overlapping drains create duplicate DRAFT orders | U-14 |
| L1-D13, L1-D14, D-2, L4-D8 | `tally/retry.js:50-63`; `netsuite/retry.js:103-129` | A give-up tells nobody | U-13, U-16 |
| L1-D17 | `tally/sync.js:151-166` | A re-pulled receipt adds to `paid_amount` again (Inferred) | own PR |
| L2-D9 | `quotes/send.js:57-67` | The first hourly run sends a follow-up right after the quote | U-24 |
| L2-D10 | `agents/_handlers/quote_accept.js:31`, `:88` | Declined or expired quotes keep getting follow-ups | U-24 |
| L2-D11 | three goal handlers | They read `orders.line_items`, which does not exist | U-24 |
| L2-D12 | `agents/_handlers/missing_doc.js:19-27` | It reads `documents.role`, which does not exist | U-24 |
| L2-D13, L1-D21 | `agents/run.js:330-356` | Overlapping runs send twice; a thrown error repeats every hour | U-24 |
| L2-D15 | `voice/webhook.js:93-101`, `:190`, `:202-204` | Two end events enqueue the same actions twice (Inferred) | U-26 |
| L2-D16 | `_lib/chat-intent.js:79` | "report" or "support" becomes an order | U-26 |
| L2-D17 | `operator_actions/reconcile.js:68-71` | A reconcile sets any status around the gate | U-20 |
| L2-D18, L3-D12 | `tally/retry.js:96-100` | The success update has no tenant filter and no status check | #631, U-20 |
| L2-D19, L4-D12 | `agents/run.js:117-127`; `agents/_handlers/ar_collect.js:190` | Goals escalate forever and never tell the owner | U-16, U-24 |
| L3-D5 | `_lib/blocking-findings.js:64-66` | A `so.write` user clears a blocker by sending it back resolved | U-19 |
| L3-D9 | `tally/push.js:107-147`, `:225-228` | A CANCELLED order can be pushed and marked exported | U-6 |
| L3-D10 | `tally/push.js:185-206` | Two concurrent pushes both post | U-6 |
| L3-D13 | `orders/[id].js:210-257`; `_lib/approval-evaluator.js:31-34` | Pending threshold approvals never stop an approve | U-21 |
| L3-D14 | `cron/extraction_jobs.js:785-810` | Background lines replace reviewed lines | #625 |
| L3-D19 | `_lib/so-processing-mode.js:1-11` | Mode B is read only by the Tally push and retry | U-20 |
| L3-D23 | `_lib/inbound-email.js:26-33`, `:93-109` | A second PO with the same subject and opening is dropped as a duplicate (Inferred) | U-25 |
| L4-D2 | `whatsapp/send.js:89-112` | With no provider, a WhatsApp message is stored as an email to a phone number | #623 |
| L4-D3 | `_lib/comms-send.js:142-187` | Chat rows with no config go out through the email provider | U-17 |
| L4-D4 | `_lib/comms-send.js:80-81` | Teams reports sent with nothing sent | #623 |
| L4-D5 | `_lib/logistics/notifications.js:173-186` | A bell that reached nobody is stamped as sent | U-16 |
| L4-D6, L1-D16, D-4 | `_lib/inventory/notifications.js:132-147` | The voice insert always fails and the call is stamped as made | U-8 |
| L4-D7, D-5 | `_lib/inventory/exceptions-detector.js:66` | One problem opens a new row, bell and email each day | U-16 |
| L4-D9 | `src/v3-app/screens/tally-push.tsx:32-33` | A failed push never shows in "Failed" | own PR |
| L4-D10 | `sap/push.js:115-149` | A first 4xx tells nobody; the recovery goal cannot see it | U-16 |
| L4-D11 | `src/v3-app/components/Shell.tsx:135` | An operator cannot mark a bell row read | #624 |
| L4-D13 | `invoices/send.js:177`, `:196` | An unsent invoice email is sent later by the reaper, maybe twice | #623, U-17 |
| L4-D14 | #640 and #641 | Email reminder bell rows open a route that does not exist | fix in #640 |
| L4-D28, D-6 | `_lib/logistics/notifications.js:192-206` | Alert emails have no recipient | #623 |
| L-1 | `_lib/audit.js:39-57` | Failed audit rows go to a table that nobody reads | U-15 |
| L-2 | `inbound/email/webhook.js:248`; `portal/reorder.js:106` | Audit inserts name a column that does not exist; the rows are lost | U-8 |
| L-3 | `email/inbound.js:235`; `whatsapp/inbound.js:197` | An invalid role value loses the audit row | U-15 |
| L-4 | `voice/outbound.js:153`; `tally/reconcile.js:106` | A null `case_id` loses the event | U-15 |
| L-6 | `audit/export.js:55-58` | The signed audit export fails | U-8 |
| L-7 | `tally/retry.js:97-109` | A cron retry exports an order with no audit row; billing and the SO cycle metric miss it | U-15 |
| L-8 | `cron/tally-reconcile.js:47-56` | Cron drift checks write no audit row, so the outcome usage meter misses them; the Stripe and Razorpay meter is still written | U-15 |
| L-9 | `cron/extraction_jobs.js:805-823` | A line rewrite and approval clear leave no order audit row | U-21 |
| L-15, L2-D26 | `_lib/mcp.js:43-54` | An MCP token works after its owner leaves the tenant | U-2 |
| L-23 | section 7 of L5 | No retention for personal data in logs | U-30 |

### 8.3 Low

Each is in the cards file with its scenario and fix.

- L1: L1-D18 (double heartbeat, with L-14), L1-D19, L1-D20, L1-D23 (with
  L-11), L1-D24, L1-D25, L1-D26, L1-D27 (with L2-D20), L1-D28.
- L2: L2-D21 (with L3-D25), L2-D22, L2-D23, L2-D24, L2-D25.
- L3: L3-D15 (#625), L3-D18, L3-D20, L3-D21, L3-D22, L3-D24, L3-D26, L3-D27,
  L3-D28, L3-D29.
- L4: L4-D15, L4-D16, L4-D17 (#624), L4-D18, L4-D19, L4-D20, L4-D21, L4-D22,
  L4-D23, L4-D24, L4-D25 (#640), L4-D26, L4-D27.
- L5: L-5, L-10, L-12, L-13, L-16, L-17, L-18, L-20, L-21 (OD-10).

---

## 9. Verifier pass

A fresh verifier read the document against the code at `931eb143`. It
checked 123 claims: all 25 high rows of the first draft, X-1 to X-24, the 22
verdicts in section 3, section 0 items 1 to 7, the "live: no" cells and 40
medium rows. It found 14 claims wrong or overstated and 3 with minor wording
problems. The lead re-read the main ones in code. All were corrected above:

- T-7 was wrong. The drift report queues no email (it reads a `users` table
  that no migration creates). The row now names the real harm: the response
  and the audit rows.
- A ninth all-tenant manual endpoint was missing: the customer health score
  POST (`customers/health_score.js:243-244`). It is now T-16, high, in U-1.
- `/api/_healthz` is 503 for all but about 10 minutes a day even with no tick,
  because of the daily rows. The first draft tied this to a live tick.
- The repo documents a cron-job.org job for the tick. Section 0, H-1, X-1 and
  OD-1 now say so, and OD-1 asks the owner to disable that job before #566's
  trigger runs.
- The #632 risk applies only to tenants with the drift add-on and auto-fix
  on, and to manual checks with `autoFix: true`. Holding #632 is still right.
- 14 of the 16 other ERP connectors ring the bell, not 15: NetSuite does not,
  and Acumatica never reaches a give-up.
- Section 0 item 1 now gives the counts on `main` (8 resolvers, 2 bell dedup
  rules) apart from the counts with open PRs.
- M-17, M-19 and M-24 are "not confirmed", not "no": SQL can set their flags.
- T-8 and T-11 moved from high to medium. T-5 now names its worst effect:
  each call adds billing meter rows to other tenants. T-6 now names its real
  harm: early submission and a leak.
- The count of order writers that bypass the gate is 16 mechanisms, in every
  place.
- L-8 claimed too much: the Stripe and Razorpay meter does count cron drift
  checks; only the outcome usage meter misses them.
- Minor: X-7 now mentions the advisory duplicate search; X-20 names the
  escalate roles; L-4 cites `:153`.

The verifier did not check X-15, X-18, X-22, H-13 or H-14 in depth, because
they cite only the cards. The cards file keeps each layer report as written;
where it differs from this document, this document wins.

---

## 10. Coverage and limits

- **No live data.** Every "live" cell waits for Appendix A. Until the owner
  runs it, the audit cannot say whether the tick runs, which backlogs exist,
  or which flags are on.
- **Sampled connectors.** The 15 erp-runner connectors were read as one class,
  with SAP as the sample. NetSuite and Tally were read in full.
- **Open PRs.** The overlay read the diffs of #566, #619, #622 to #632, #624,
  #630, #637, #640 and #642 where they touch a mechanism. It did not read
  #635, #636, #639 or #641 in full.
- **Screens.** Screens were read only where they are the only reader of a
  mechanism. Nothing was run on a phone.
- **Inferred items.** Runtime failures marked Inferred (for example L2-D11,
  L2-D15, T-15) need one owner query or one test against the real schema to
  become Verified.
- **This document fixes nothing.** Each defect gets its own PR.

---

## Appendix A. Read-only queries for the owner

Run these in the Supabase SQL editor and return the grids. Every statement is
a SELECT. They return counts and timestamps only: no row content and no
tenant ids. Run step 5 first; skip a statement whose migration is absent.
The "A" numbers in section 2.1 point at these steps (A1 is step 1, A2k is
step 2k).

```sql
-- =====================================================================
-- STEP 1. cron_health. Answers H-1, H-3, H-4. Table 066:18-26.
-- =====================================================================
select to_regclass('public.cron_health') is not null as cron_health_exists;

-- 1a. Every row, with the age and the bound that _lib/heartbeat-check.js:18-50
--     applies. No metadata column (it can carry error text).
select worker,
       last_run_at,
       last_status,
       consecutive_failures,
       age_minutes,
       bound_minutes,
       age_minutes > bound_minutes as stale_by_healthz_map
from (
  select worker, last_run_at, last_status, consecutive_failures,
         round(extract(epoch from (now() - last_run_at)) / 60) as age_minutes,
         case worker
           when 'cron/tick' then 10
           when 'cron/daily' then 1800
           when 'agents/run' then 120
           when 'eval/agent_eval' then 120
           when 'tally/sync' then 75 when 'netsuite/sync' then 75
           when 'sap/sync' then 75 when 'd365/sync' then 75
           when 'acumatica/sync' then 75 when 'p21/sync' then 75
           when 'logistics/monitor_daily' then 1800
           when 'logistics-monitor-tick' then 1800
           else 10
         end as bound_minutes
  from cron_health
) x
order by stale_by_healthz_map desc, worker;

-- 1b. Summary.
select count(*) as rows,
       count(*) filter (where last_status <> 'ok') as not_ok,
       max(consecutive_failures) as max_consecutive_failures,
       max(last_run_at) filter (where worker = 'cron/tick')  as tick_last_run,
       max(last_run_at) filter (where worker = 'cron/daily') as daily_last_run
from cron_health;

-- =====================================================================
-- STEP 2. Queue backlogs. Counts, oldest, newest, tenant count.
-- =====================================================================
-- 2a. extraction_jobs: status 117:51-52, attempts 117:71, created_at 117:76,
--     lease_until 117:85.
select status, count(*) as n, count(distinct tenant_id) as tenants,
       min(created_at) as oldest, max(created_at) as newest,
       max(attempts) as max_attempts,
       count(*) filter (where lease_until > now()) as leased_now
from extraction_jobs group by status order by status;

-- 2b. inbound_emails: status 028:62-63, received_at 028:56.
select status, count(*) as n, count(distinct tenant_id) as tenants,
       min(received_at) as oldest, max(received_at) as newest
from inbound_emails group by status order by status;

-- 2c. Inline attachment bytes still waiting (persist_attachments). attachments 028:54.
select count(*) as emails_with_inline_bytes, count(distinct tenant_id) as tenants,
       min(received_at) as oldest
from inbound_emails where attachments::text like '%"content_b64"%';

-- 2d. The window persist_attachments reads: the oldest 80 rows
--     (inbound/email/persist_attachments.js:51-54). If 2c > 0 and this is 0,
--     the drain is starved (L1-D02).
select count(*) filter (where attachments::text like '%"content_b64"%') as in_window_with_bytes,
       count(*) as window_rows
from (select attachments from inbound_emails order by received_at asc limit 80) w;

-- 2e. Reply-handler backlog: classified_intent 067:18, agent_reply_handled_at 070:11.
select classified_intent, count(*) as n, count(distinct tenant_id) as tenants,
       min(received_at) as oldest
from inbound_emails
where agent_reply_handled_at is null
  and classified_intent in ('payment_acknowledge','delivery_query','complaint')
group by classified_intent order by classified_intent;

-- 2f. inbound_messages: status 039:33-34, received_at 039:36 (no created_at column).
select status, count(*) as n, count(distinct tenant_id) as tenants,
       min(received_at) as oldest, max(received_at) as newest
from inbound_messages group by status order by status;

-- 2g. voice_call_actions: completed 041:102, created_at 041:105.
select completed, count(*) as n, count(distinct tenant_id) as tenants,
       min(created_at) as oldest, max(created_at) as newest
from voice_call_actions group by completed order by completed;

-- 2h. voice_calls: status 041:70-71, started_at 041:67 (no created_at column).
select status, count(*) as n, count(distinct tenant_id) as tenants,
       min(started_at) as oldest, max(started_at) as newest
from voice_calls group by status order by status;

-- 2i. communications: status 189:101-103, created_at 005:39, to_addr 005:31,
--     document_type 189:60, channel 005:28.
select status, coalesce(document_type, '(none)') as document_type, channel,
       count(*) as n, count(distinct tenant_id) as tenants,
       count(*) filter (where to_addr is null) as no_recipient,
       min(created_at) as oldest, max(created_at) as newest
from communications group by 1, 2, 3 order by 1, 2, 3;

-- 2j. push_notifications: status 021:46, attempt_count 021:47, created_at 021:50.
select status, count(*) as n, count(distinct tenant_id) as tenants,
       min(created_at) as oldest, max(attempt_count) as max_attempts
from push_notifications group by status order by status;

-- 2k. Every <erp>_retry_queue that exists, in one SELECT. Columns status,
--     created_at, tenant_id exist in all 17 (015:77, 016:96, 017:60, 018:54,
--     019:55, 030:54, 031:52, 032:52, 040:135, 044:124, 045:122, 046:122,
--     047:120, 048:118, 049:122, 050:119, 051:118).
select t.table_name,
       (xpath('/row/pending/text()',    x))[1]::text::int  as pending,
       (xpath('/row/processing/text()', x))[1]::text::int  as processing,
       (xpath('/row/gave_up/text()',    x))[1]::text::int  as gave_up,
       (xpath('/row/succeeded/text()',  x))[1]::text::int  as succeeded,
       (xpath('/row/tenants_open/text()', x))[1]::text::int as tenants_open,
       (xpath('/row/oldest_open/text()',  x))[1]::text      as oldest_open
from information_schema.tables t,
     lateral query_to_xml(format(
       'select count(*) filter (where status = ''pending'') as pending,
               count(*) filter (where status = ''processing'') as processing,
               count(*) filter (where status = ''gave_up'') as gave_up,
               count(*) filter (where status = ''succeeded'') as succeeded,
               count(distinct tenant_id) filter (where status in (''pending'',''processing'')) as tenants_open,
               min(created_at) filter (where status in (''pending'',''processing'')) as oldest_open
        from public.%I', t.table_name), false, true, '') as x
where t.table_schema = 'public' and t.table_name like '%\_retry\_queue' escape '\'
order by t.table_name;

-- 2l. agent_goals: status 011:46-48, next_run_at 011:57, due_at 011:52, created_at 011:76.
select status, goal_type, count(*) as n, count(distinct tenant_id) as tenants,
       count(*) filter (where next_run_at <= now()) as due_now,
       count(*) filter (where due_at < now()) as past_due_at,
       min(created_at) as oldest
from agent_goals group by status, goal_type order by status, goal_type;

-- 2m. action_proposals: status 149:21-22, created_at 149:26.
select status, count(*) as n, count(distinct tenant_id) as tenants, min(created_at) as oldest
from action_proposals group by status order by status;

-- 2n. operator_actions: status 150:22-23, created_at 150:33.
select status, count(*) as n, count(distinct tenant_id) as tenants, min(created_at) as oldest
from operator_actions group by status order by status;

-- 2o. auto_ocr backlog and its window (inbound/auto_ocr.js:43-62).
--     documents 001:94, metadata 001:105, scan_status 059:263;
--     extraction_runs.source_id is text (029:25).
select count(*) as eligible_docs_without_run, count(distinct d.tenant_id) as tenants,
       min(d.created_at) as oldest
from documents d
where d.scan_status = 'clean'
  and d.metadata->>'source' in ('email_inbound', 'whatsapp_inbound')
  and exists (select 1 from order_documents od where od.document_id = d.id)
  and not exists (select 1 from extraction_runs r
                  where r.tenant_id = d.tenant_id and r.source_id = d.id::text);

select count(*) filter (where w.src in ('email_inbound','whatsapp_inbound') and not w.has_run) as window_eligible_unrun,
       count(*) as window_rows
from (
  select d.metadata->>'source' as src,
         exists (select 1 from extraction_runs r
                 where r.tenant_id = d.tenant_id and r.source_id = d.id::text) as has_run
  from documents d
  where d.scan_status = 'clean'
    and exists (select 1 from order_documents od where od.document_id = d.id)
  order by d.created_at asc limit 20
) w;

-- =====================================================================
-- STEP 3. Open items in each attention place.
-- =====================================================================
-- 3a. admin_notifications: kind 042:92, resolved 042:112, created_at 042:116.
select kind, count(*) as unresolved, count(distinct tenant_id) as tenants,
       min(created_at) as oldest
from admin_notifications where resolved = false
group by kind order by unresolved desc;

-- 3b. logistics_exceptions: status 206:60-61, created_at 206:69.
select status, count(*) as n, count(distinct tenant_id) as tenants, min(created_at) as oldest
from logistics_exceptions group by status order by status;

-- 3c. inventory_exceptions: status 085:366-367, created_at 085:371.
select status, count(*) as n, count(distinct tenant_id) as tenants, min(created_at) as oldest
from inventory_exceptions group by status order by status;

-- 3d. Orders with an unresolved blocking finding. rule_findings 001:149.
--     Predicate copies _lib/blocking-findings.js:22-27.
select o.status, count(*) as orders, count(distinct o.tenant_id) as tenants
from orders o
where exists (
  select 1
  from jsonb_array_elements(case when jsonb_typeof(o.rule_findings) = 'array'
                                 then o.rule_findings else '[]'::jsonb end) f
  where coalesce(f->>'resolved', 'false') <> 'true'
    and (f->>'blocks' = 'true'
         or f->>'code' = 'line_count_shortfall'
         or f->>'rule_id' = 'line_count_shortfall'))
group by o.status order by o.status;

-- 3e. validation_findings: resolved 001:240, created_at 001:243.
select count(*) filter (where resolved = false) as unresolved,
       count(distinct tenant_id) filter (where resolved = false) as tenants,
       min(created_at) filter (where resolved = false) as oldest
from validation_findings;

-- 3f. extraction_review_queue: status 123:39, created_at 123:45.
select status, count(*) as n, count(distinct tenant_id) as tenants, min(created_at) as oldest
from extraction_review_queue group by status order by status;

-- 3g. quote_approvals: status 006:628, created_at 006:631.
select status, count(*) as n, count(distinct tenant_id) as tenants, min(created_at) as oldest
from quote_approvals group by status order by status;

-- =====================================================================
-- STEP 4. Switches on tenant_settings. Counts only.
-- =====================================================================
select count(*) as tenants_with_settings,
  count(*) filter (where to_jsonb(ts)->>'logistics_monitor_enabled' = 'true')            as logistics_monitor_on,   -- 206:93
  count(*) filter (where to_jsonb(ts)->>'operator_actions_enabled' = 'true')             as operator_actions_on,    -- 150:12
  count(*) filter (where to_jsonb(ts)->>'so_processing_mode' = 'B')                      as so_mode_b,              -- 221:27, check A|B
  count(*) filter (where coalesce(to_jsonb(ts)->>'terms_check_mode', 'off') <> 'off')    as terms_check_not_off,    -- 250:203
  count(*) filter (where to_jsonb(ts)->>'so_agent_enabled' = 'true')                     as so_agent_on,            -- 210:21
  count(*) filter (where to_jsonb(ts)->>'dispatch_register_auto_send_enabled' = 'true')  as dispatch_auto_send_on,  -- 205:12
  count(*) filter (where to_jsonb(ts)->>'graph_connected_at' is not null)                as graph_mail_connected,   -- 194:26
  count(*) filter (where to_jsonb(ts)->>'graph_subscription_id' is not null)             as graph_inbound_subscribed, -- 028:105
  count(*) filter (where to_jsonb(ts)->>'inventory_planning_enabled' = 'true')           as inventory_planning_on,  -- 085:55
  count(*) filter (where to_jsonb(ts)->>'order_handoff_enabled' = 'true')                as order_handoff_on        -- 251:58
from tenant_settings ts;

-- =====================================================================
-- STEP 5. Which migrations are applied (one object each), plus L1 objects.
-- =====================================================================
select m.mig, m.object, m.present from (values
 ('059','column tally_retry_queue.claimed_at',  exists (select 1 from information_schema.columns where table_schema='public' and table_name='tally_retry_queue' and column_name='claimed_at')),
 ('059','column acu_retry_queue.claimed_at (expect false, L1-D04)', exists (select 1 from information_schema.columns where table_schema='public' and table_name='acu_retry_queue' and column_name='claimed_at')),
 ('066','table cron_health',                    to_regclass('public.cron_health') is not null),
 ('070','column inbound_emails.agent_reply_handled_at', exists (select 1 from information_schema.columns where table_schema='public' and table_name='inbound_emails' and column_name='agent_reply_handled_at')),
 ('189','communications status check has queued', exists (select 1 from pg_constraint where conname='communications_status_chk' and pg_get_constraintdef(oid) like '%queued%')),
 ('202','index extraction_jobs_one_inflight_per_order', to_regclass('public.extraction_jobs_one_inflight_per_order') is not null),
 ('206','table logistics_exceptions',           to_regclass('public.logistics_exceptions') is not null),
 ('207','column orders.committed_delivery_date', exists (select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='committed_delivery_date')),
 ('208','default docai_provider_order has gemini', exists (select 1 from information_schema.columns where table_schema='public' and table_name='tenant_settings' and column_name='docai_provider_order' and column_default like '%gemini%')),
 ('209','table shipment_lines',                 to_regclass('public.shipment_lines') is not null),
 ('210','column tenant_settings.so_agent_enabled', exists (select 1 from information_schema.columns where table_schema='public' and table_name='tenant_settings' and column_name='so_agent_enabled')),
 ('211','column shipment_lines.source_country', exists (select 1 from information_schema.columns where table_schema='public' and table_name='shipment_lines' and column_name='source_country')),
 ('212','table shipment_eta_observations',      to_regclass('public.shipment_eta_observations') is not null),
 ('213','index shipments_tenant_invoice_uq',    to_regclass('public.shipments_tenant_invoice_uq') is not null),
 ('214','column invoices.customer_po_number',   exists (select 1 from information_schema.columns where table_schema='public' and table_name='invoices' and column_name='customer_po_number')),
 ('215','column quotes.revision',               exists (select 1 from information_schema.columns where table_schema='public' and table_name='quotes' and column_name='revision')),
 ('216','column item_master.weight_source',     exists (select 1 from information_schema.columns where table_schema='public' and table_name='item_master' and column_name='weight_source')),
 ('217','extraction_runs kind check has packing_list', exists (select 1 from pg_constraint where conname='extraction_runs_extraction_kind_check' and pg_get_constraintdef(oid) like '%packing_list%')),
 ('218','column tenant_settings.docai_prompt_variants', exists (select 1 from information_schema.columns where table_schema='public' and table_name='tenant_settings' and column_name='docai_prompt_variants')),
 ('219','column extraction_jobs.extraction_kind', exists (select 1 from information_schema.columns where table_schema='public' and table_name='extraction_jobs' and column_name='extraction_kind')),
 ('220','extraction_runs kind check has sales_order', exists (select 1 from pg_constraint where conname='extraction_runs_extraction_kind_check' and pg_get_constraintdef(oid) like '%sales_order%')),
 ('221','column tenant_settings.so_processing_mode', exists (select 1 from information_schema.columns where table_schema='public' and table_name='tenant_settings' and column_name='so_processing_mode')),
 ('222','order_documents role check has sales_order', exists (select 1 from pg_constraint where conname='order_documents_role_check' and pg_get_constraintdef(oid) like '%sales_order%')),
 ('223','column tenant_settings.docai_density_chunk_enabled', exists (select 1 from information_schema.columns where table_schema='public' and table_name='tenant_settings' and column_name='docai_density_chunk_enabled')),
 ('224','column item_specifications.finish',    exists (select 1 from information_schema.columns where table_schema='public' and table_name='item_specifications' and column_name='finish')),
 ('225','column tenant_settings.eway_threshold_inr', exists (select 1 from information_schema.columns where table_schema='public' and table_name='tenant_settings' and column_name='eway_threshold_inr')),
 ('226','extraction_runs kind check has delivery_note', exists (select 1 from pg_constraint where conname='extraction_runs_extraction_kind_check' and pg_get_constraintdef(oid) like '%delivery_note%')),
 ('227','column customers.owner_user_id',       exists (select 1 from information_schema.columns where table_schema='public' and table_name='customers' and column_name='owner_user_id')),
 ('248','column tenant_settings.docai_gemini_fallback_model', exists (select 1 from information_schema.columns where table_schema='public' and table_name='tenant_settings' and column_name='docai_gemini_fallback_model')),
 ('250','table order_term_flags',               to_regclass('public.order_term_flags') is not null),
 ('251','column orders.handoff_status',         exists (select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='handoff_status'))
) as m(mig, object, present)
order by m.mig, m.object;
-- No migration exists on main for 228 to 247 or 249. Nothing to check there.

-- =====================================================================
-- STEP 6. Rows written per day, last 30 days.
--   agent_steps.created_at 011:119; processing_events.created_at 001:352;
--   audit_events.created_at 001:337; mcp_call_log.created_at 027:54;
--   communications.created_at 005:39.
-- =====================================================================
with days as (
  select generate_series(current_date - 29, current_date, interval '1 day')::date as day
),
s  as (select created_at::date as day, count(*) as n from agent_steps       where created_at >= current_date - 29 group by 1),
pe as (select created_at::date as day, count(*) as n from processing_events where created_at >= current_date - 29 group by 1),
ae as (select created_at::date as day, count(*) as n from audit_events      where created_at >= current_date - 29 group by 1),
mc as (select created_at::date as day, count(*) as n from mcp_call_log      where created_at >= current_date - 29 group by 1),
co as (select created_at::date as day, count(*) as n from communications    where created_at >= current_date - 29 group by 1)
select days.day,
       coalesce(s.n, 0)  as agent_steps,
       coalesce(pe.n, 0) as processing_events,
       coalesce(ae.n, 0) as audit_events,
       coalesce(mc.n, 0) as mcp_call_log,
       coalesce(co.n, 0) as communications
from days
left join s  on s.day  = days.day
left join pe on pe.day = days.day
left join ae on ae.day = days.day
left join mc on mc.day = days.day
left join co on co.day = days.day
order by days.day;
```

Three more queries, from the L3 audit:

```sql
-- 7a. Reconciler findings by kind, last 30 days. All 'missing_in_tally'
--     confirms L3-D2 is live. Columns 095:66-94.
select finding_kind, count(*) as n, count(distinct tenant_id) as tenants
from tally_reconciliation_findings
where created_at >= now() - interval '30 days'
group by finding_kind order by n desc;

-- 7b. Email-drafted orders with no linked document (confirms L3-D7).
select count(*) as email_orders, count(*) filter (where not exists (
         select 1 from order_documents od where od.order_id = o.id)) as without_documents
from orders o
where o.preflight_payload->>'source' = 'inbound_email';

-- 7c. Two more switches for step 4 (095:137, 097:23).
select count(*) filter (where to_jsonb(ts)->>'tally_recon_auto_fix_enabled' = 'true') as recon_auto_fix_on,
       count(*) filter (where to_jsonb(ts)->>'tally_drift_addon_enabled' = 'true')    as drift_addon_on
from tenant_settings ts;
```

Two facts are not in the database: whether `EMAIL_INBOUND_TOKEN` and
`WHATSAPP_INBOUND_TOKEN` are set in Vercel (OD-5), and whether an outside
service calls `/api/cron/tick` (OD-1).

---

## Appendix B. Tick handlers and queue shapes

"hc" is the bound in `_lib/heartbeat-check.js` (used by `/api/_healthz` and
the daily sweep). "h" is the bound in `health.js` (footer). "def" is the
10-minute default (`_lib/heartbeat-check.js:49`; `health.js:108`). Budget is
from `_lib/cron-mux.js:75-105`. Effects marked "per #566" were not re-read.

| Handler | Group | hc | h | Self heartbeat | Budget | External side effects | Backlog risk |
|---|---|---|---|---|---|---|---|
| push/send | ALWAYS | def | def | no | 20 s | Web push to staff (push/send.js:48-50) | Low. Only producer is the manual POST (push/send.js:85-93). One try, then 'failed' (:58-63) |
| extraction/jobs | ALWAYS | def | def | no | 20 s | LLM spend (cron/extraction_jobs.js:35); writes order lines (:808-810) | Every non-terminal job, oldest first (:128-135). Overwrites lines whatever the order status |
| prospecting/run | ALWAYS | def | def | no | 20 s | Marketing email (per #566, M-23) | Every active campaign (prospecting/run.js:138-145) |
| inbound/email/parse | ALWAYS | def | def | no | 20 s | LLM classifier per email (inbound/email/parse.js:65) | Every 'received' email, 25 per call (:119-124) |
| inbound/email/persist_attachments | ALWAYS | def | def | no | 20 s | Storage upload and scan (inbound/email/_lib/persist-attachments.js:52-160) | Starves after 80 rows (persist_attachments.js:51-57). No attempt cap |
| inbound/email/draft_orders | ALWAYS | def | def | no | 20 s | Inserts DRAFT orders (draft_orders.js:75) | Every 'linked' email becomes an order |
| voice/process_actions | ALWAYS | def | def | no | 20 s | Inserts DRAFT orders (voice/process_actions.js:54-69) | Every open action. Manual drain crosses tenants (:150) |
| inbound/process_messages | ALWAYS | def | def | no | 20 s | Inserts DRAFT orders (inbound/process_messages.js:58) | Every 'arrived' message. PO regex over-matches (_lib/chat-intent.js:79) |
| inbound/auto_ocr | ALWAYS | def | def | no | 20 s | LLM extraction (inbound/auto_ocr.js:133-147) | Starves after 20 documents (:43-62, :104) |
| agents/handle_replies | ALWAYS | def | def | no | 20 s | Pauses AR goals 14 days (agents/handle_replies.js:67-90) | Every unhandled actionable email. agent_steps row has no tenant_id (:41, :75) |
| logistics/monitor | ALWAYS | def | def | yes: logistics-monitor-tick, hc 30 h (_lib/heartbeat-check.js:48), h def | 30 s | Bell and queued email (cron/logistics-monitor-tick.js:47-49) | Flag off by default (206:93). Same code runs daily |
| netsuite, tally, sap, d365, acumatica, p21, eclipse, sxe, sage_x3, ifs, oracle_fusion, ramco, jde, plex, jobboss, oracle_ebs, proalpha /retry (17) | ALWAYS | def | def | no | 15 to 30 s (tally 30, sap/ifs/jde/oracle_ebs 25, p21/eclipse/sxe/sage_x3 15, rest 20) | ERP writes (sap/retry.js:16-20; tally/retry.js:73; netsuite/retry.js:34-38). Tally sets order status (tally/retry.js:96-100) | No age limit (_lib/erp-runner.js:82-87; tally/retry.js:124-129). Stale pushes create duplicate SOs. Acumatica never drains (L1-D04) |
| tally, netsuite, sap, d365, acumatica, p21 /sync (6) | 30-min | 75 min (:24-29) | def | no | 20 to 30 s | ERP reads. tally/sync adds a receipt to invoices.paid_amount with no applied check (tally/sync.js:151-166) | First run pulls history |
| eclipse, sxe, sage_x3, ifs, oracle_fusion, ramco, jde, plex, jobboss, oracle_ebs, proalpha /sync (11) | 30-min | def | def | no | 15 to 25 s | ERP reads | Rows read stale 20 of every 30 min |
| tally/reconcile | 30-min | def | def | no | 30 s | Auto-fix re-queues vouchers (per #566, M-36) | Manual drain crosses tenants (cron/tally-reconcile.js:88-90) |
| plm/sync | 30-min | def | def | no | 20 s | PLM reads | n/a |
| agents/run | hourly | 2 h (:21) | 2 h (health.js:106) | no | 20 s | Customer email through the reaper (agents/run.js:276-314); bell on escalation (:120-127); calls (per plan M-12) | Sends up to 100 oldest queued rows per touched tenant, no age limit (:277-283) |
| drift-meter | hourly | def | def | no | 20 s | Stripe or Razorpay billing (cron/drift-meter.js:88-99) | Every unreported meter row (:29-35) |
| eval/agent_eval | minute-5 | 2 h (:22) | 2 h | no | 20 s | None found (per #566) | Low |
| eval/rescore | minute-5 | def | def | no | 20 s | None without EVAL_GOLDEN_TENANT_ID (cron/tick.js:208-210) | Low |
| cron/tick (parent) | every call | 10 min | 10 min | n/a | n/a | none | n/a |
| analytics/refresh | daily | def | def | no | 20 s | DB only | Low |
| fx/cron | daily | def | def | no | 20 s | External FX fetch (fx/cron.js, safeFetch) | Low |
| service/amc_cron | daily | def | def | no | 20 s | Creates service_visits (service/amc_cron.js:74-90) | Due AMC rows |
| rlhf/aggregate | daily | def | def | no | 20 s | DB only | Low |
| quotes/expire | daily | def | def | no | 20 s | Updates quote status (quotes/expire.js:37) | Low |
| billing/recurring | daily | def | def | no | 20 s | Creates invoices (billing/recurring_cron.js:84) | Due schedules |
| eway_bills/expire | daily | def | def | no | 20 s | DB only | Low |
| catalog/embed | daily | def | def | no | 20 s | None today: GET runs the status branch (catalog/embed.js:122-124) | Never runs (L1-D10) |
| forecast/snapshot | daily | def | def | no | 20 s | DB only (POST, cron/daily.js:76) | Low |
| drift-report | daily | def | def | no | 20 s | Queues email (cron/drift-report.js:111-122); only M-42 drains queued email | Monthly |
| eval/quality_alert | daily | def | def | no | 20 s | Admin bell (notifyAdmins in cron/eval_quality_alert.js) | Low |
| docai/extraction_reaper | daily | def | def | no | 20 s | Fails stuck runs (_lib/docai/reap-stale-runs.js:31-41) | Low |
| logistics/monitor_daily | daily | 30 h (:47) | def | yes: logistics-monitor-tick | 30 s | As logistics/monitor | As above |
| eval/replay (only with EVAL_REPLAY_ENABLED) | daily | def | def | no | 55 s (cron/daily.js:95) | LLM spend, bell (eval/replay.js) | Cost-bounded by case cap |
| cron/daily (parent) | daily | 30 h | 30 h | n/a | n/a | none | n/a |

**Counts.** Tick: 11 + 17 ALWAYS, 19 at 30 minutes, 2 hourly, 2 at minute 5:
51. This matches #566's count. #566's table rows match the code that I read.
Its line references drift by a few lines at this base: for example it cites
the order writeback as `cron/extraction_jobs.js:777-795`; at `931eb143` the
read is :785 and the write is :808-810.

**Routable-only crons (5).** `/cron/inventory-positions` (router.js:738),
`/cron/inventory-planning-weekly` (:739), `/cron/inventory-exceptions-tick`
(:740), `/cron/conformal-calibration-weekly` (:741), and
`/customers/health_score` cron branch (router.js:1003;
customers/health_score.js:224-228). The last is new in the audit.

**Double-registered handlers.** One on main: the logistics monitor, as
`logistics/monitor` in tick (cron/tick.js:187) and `logistics/monitor_daily`
in daily (cron/daily.js:91). Detection is safe to repeat (unique open
fingerprint, 206:80-81). Notices use read-then-stamp
(_lib/logistics/notifications.js:100-153), so a tick at 02:30 and the daily
run at 02:30 can both notify [I] (L1-D28). Open PRs add `email/sweep` plus
`email/sweep_daily` (#640) and put the planner into daily (#534). Every
scheduled drain also has its own manual route (section 10, N-2).


| Shape | Table | Claim | Lease or stuck reset | Attempts cap | Backoff | Give-up status | Age limit | Reaper | Heartbeat | Tenant fairness | Notice on give-up |
|---|---|---|---|---|---|---|---|---|---|---|---|
| (a) drainQueue | inbound_emails (028:62), voice_call_actions (041:102), inbound_messages (039:33) | none (_lib/queue-runner.js:66-86) | none | 1 (:96-108) | none | 'failed' or completed=true with error (:99-107) | none | none | caller name | none: global oldest, limit 25 (:73) | none |
| (b) erp-runner | 15 <erp>_retry_queue | conditional UPDATE to 'processing' (_lib/erp-runner.js:49-57) | 15 min reset, per tenant (:73-80) | max_attempts, default 5 (:114) | 5, 15, 60, 240 min in practice (:23, :134) | 'gave_up' (:115, :147) | none (:82-87) | the reset | <erp>/retry | per tenant 50, tenants serial (sap/retry.js:60-69) | admin bell (:123-131, :152-160) |
| (c) Tally copy | tally_retry_queue (016:96) | none (tally/retry.js:124-136) | none; 059 columns unused | 5 (016:106; tally/retry.js:37) | own copy (:26, :40) | 'gave_up', voucher 'failed' (:50-62) | none | none | tally/retry | per tenant 50, serial (:149-158) | none (D-2) |
| (d) NetSuite copy | netsuite_retry_queue (015:77) | none (netsuite/retry.js:136-148) | none | 5 (:90) | own copy (:25, :93) | 'gave_up', order result gave_up (:103-127) | none | none | netsuite/retry | per tenant 50, serial (:170-174) | none |
| (e) extraction_jobs lease | extraction_jobs (117:34) | conditional UPDATE on lease_until (cron/extraction_jobs.js:142-155) | 30 s lease (:114) | chunk 3 (:115); job none (:145) | next tick | 'failed' (:954-959) | none | lease expiry; reaper covers extraction_runs only | extraction/jobs | none: global oldest 3 (:117, :128-135) | processing_events plus audit (:663-664); no bell |
| (f) agent_goals schedule | agent_goals (011:27) | none (agents/run.js:330-336) | none | none; a thrown dispatch keeps next_run_at (:350-356) | cooldown_hours, default 24 (:66); noop sleep (:70-71) | handler give_up -> 'failed' (:59) | due_at, read by some handlers (agents/_handlers/ar_collect.js:190) | none | agents/run | none: global oldest, limit 50 (:329-336) | escalate -> bell (:120-127) |
| (g) comms reaper | communications (005:22; status 189:101-103) | none (agents/run.js:277-307) | none | none | next hourly run | 'failed' only for no recipient (:295-303) | none | none | none of its own | only tenants with a due goal (:361-366); 100 each | none |
| (h) parse loop | inbound_emails | none (inbound/email/parse.js:119-128) | none | 1 (:110-115) | none | 'failed' | none | none | inbound/email/parse | none: global 25 | none |
| (i) handle_replies loop | inbound_emails marker agent_reply_handled_at (070:10-12) | none (agents/handle_replies.js:127-146) | none | 1: an error is marked handled (:140-146) | none | agent_reply_action 'error' | none | none | agents/handle_replies | none: global 50 (:31) | none |
| (j) push loop | push_notifications (021:37) | none (push/send.js:20-23) | none | 1 (:58-63) | none | 'failed' | none | none | push/send | none: global 50 | none |
| (k) window scan | inbound_emails attachments JSON (persist); documents (auto_ocr) | none | none | none: bytes kept for retry (persist-attachments.js:187-191); auto_ocr counts a failed run as done (auto_ocr.js:73) | next tick | none | none | none | caller name | persist: round robin (persist_attachments.js:58-76); auto_ocr: none | none |
| (l) detect-and-notify scan | logistics_exceptions (206:50), inventory_exceptions (085:356) | none | none | n/a | n/a | status open -> resolved by detector | n/a | n/a | logistics-monitor-tick, inventory-exceptions-tick | per enabled tenant, serial | bell and email per row |
| (m) ERP sync cursor | <erp>_sync_state, <erp>_sync_runs | none | none | n/a | next 30 min | sync_state 'error' (_lib/erp-runner.js:276-282) | n/a | none | <erp>/sync | per tenant | none |
| (n) run reaper | extraction_runs (029:20) | n/a | 5 min bound (reap-stale-runs.js:19) | n/a | n/a | 'failed', 'timed_out' (:33-36) | n/a | is the reaper | docai/extraction_reaper | all tenants | none |
| open PR: email/sync (#635) | mailbox connections (267) | conditional lease on sync_lease_until (#635 email/sync.js:+52-55) | lease | consecutive_failures; 'reauth_required' on auth | interval x 2^min(failures,4) (#635 _lib/mail/sync.js:+77) | 'reauth_required' or paused | n/a | lease expiry | email/sync | per connection by next_sync_at | alert at a failure threshold (#635 sync.js "failing") |
| open PR: email/sweep (#640) | email_action_notices (270) | insert as claim, unique key, 23505 skips (#640 escalation.js:+115-118) | none for 'claimed' | 3 | next sweep | 'failed' after 3 | n/a | none | email/sweep, email/sweep_daily | per enabled tenant | the notice is the output |

**Count.** On main, shapes (a) to (k) are 11 queue drains with their own
claim and retry rules, plus 2 scan shapes and 1 reaper. With #635 and #640:
13 drains. H-7 said "at least six"; the real number is larger.

