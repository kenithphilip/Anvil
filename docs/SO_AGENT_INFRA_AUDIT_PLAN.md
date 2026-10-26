# Sales order agent infrastructure: audit plan

Plan document, 2026-10-26. Docs only. This is the plan for an audit. The
audit has not started, and nothing is changed.

- **Base.** `origin/main` at `931eb143` (2026-10-26). File references are
  `path:line` at that commit. Migration references are `NNN:line`. Open work
  is named by PR number.
- **Why.** The owner thinks that the infrastructure that sales order (SO)
  "agent" work runs on is spread over many separate mechanisms, and that these
  mechanisms should be one. This plan says what the audit inspects, in which
  order, which questions it answers, what evidence it collects, and what it
  delivers.
- **Names used here.** Mechanisms are M-1 to M-49 (section 4). Questions are
  Q1 to Q18 (section 5). Signals to test are H-1 to H-15 (section 8).
  Decisions before the audit are AD-1 to AD-8 (section 9). Outputs are O-1 to
  O-6 (section 7). Defects already seen are D-1 to D-7 (section 8.1). The PRs
  that the audit will propose get the prefix U-.
  C-n, R-x and C-Dn come from `SO_EXECUTION_COHESION.md` (#611). WM-n comes
  from `WORK_MANAGEMENT_SCOPE.md`. EA-n and ED-n come from
  `EMAIL_ACCOUNTABILITY_SCOPE.md` (#634, open).
- **Live database.** As last recorded (`SO_EXECUTION_COHESION.md`, header,
  and the 2026-10-13 apply): migrations up to 227, plus 248, 250 and 251. The
  audit writes no migration. The next free number is 271.
- **House rules used here.** Something built but never wired counts as not
  built. State comes from records, not from a hand-set field. The server holds
  the rules, not the screen. Merged is not applied. Roles are named, people
  are not. No customer, person or part names.

---

## 0. Summary

1. **The question.** What is the smallest set of shared parts that SO agent
   work needs, and how does the repo move from today's mechanisms to that set
   in small PRs that each ship their caller?
2. **The surface is large.** This plan verified 49 mechanisms on `main` in five
   layers: the clock and its drains, the actors, the SO record path, the
   attention and message channels, and the trail. Open PRs add about 10 more
   (section 4.6).
3. **The first fact to settle is the clock.** `vercel.json:12-17` schedules
   only `/api/cron/daily`. Nothing in the repo calls `/api/cron/tick`. If no
   external trigger exists, every 5-minute and hourly drain is dormant: the
   agent runner, the queued mail reaper, inbound email, chat and voice intake,
   all 17 ERP retry queues and web push (H-1). Every "is it live" answer
   depends on this, so the audit starts there.
4. **Early signals.** Section 8 lists 15 signals found while this plan was
   written. Examples: two trust models for automated writes, and no automated
   writer passes the order gate (H-5); two designs that both claim the
   `work_items` table (H-6); six queue shapes (H-7); a Tally push that gives
   up tells nobody, while the other ERPs ring the bell (H-9); eight paths that
   create an order (H-11); and two cron staleness maps that disagree (H-3).
   They are hypotheses. The audit confirms or rejects each one with evidence.
   Section 8.1 lists defects already seen. One of them crosses tenants (D-1, H-10)
   and should not wait for the audit.
5. **Method.** Read only. One base commit. Every claim carries `path:line`.
   Live facts come only from SELECT queries that the owner runs. A second
   reader verifies every inventory row and every conflict cell.
6. **Outputs.** An inventory (O-1), an overlap and conflict matrix (O-2), a
   target unified model (O-3), a migration path in small PRs (O-4), the owner
   decisions that the audit hands back (O-5), and a list of defects found and
   not fixed (O-6). All go into one docs file, `docs/SO_AGENT_INFRA_AUDIT.md`,
   in one docs-only PR.
7. **Before the audit starts,** the owner decides 8 things (section 9). The
   most important: whether the email accountability stack waits for the
   audit's target model before `work_items` (migration 252, #637) merges
   (AD-5).

---

## 1. The question and the layers

"Agent work" here means any work that a machine starts or carries for an SO
without a person clicking each step: scheduled drains, autonomous goals, LLM
proposals, inbound classification, retries, reconcilers, reminders, and the
notices that tell a person to act.

The audit sorts every mechanism into one of five layers. The layers are the
groups in section 4 and the phases in section 6.2.

| Layer | What it answers | Examples |
|---|---|---|
| L1. Clock and drains | What makes work run, and how a unit of work is claimed, retried and given up | tick, daily, cron-mux, cron_health, queue-runner, erp-runner |
| L2. Actors | What decides to act, and with what authority | agent goals, copilot, erp_chat, MCP, operator actions, voice, chat intake |
| L3. SO record path | What the actors act on, and which gate a write passes | inbound email, extraction jobs, orders, approval gate, exceptions, Tally push, retry and reconcile, Mode B handoff |
| L4. Attention and messages | How a person learns that work waits, and how a message leaves Anvil | bell, notify, web push, communications, mailer, exception tables, work items |
| L5. Trail | What records that something happened, and who did it | audit_events, processing_events, agent_steps, mcp_call_log, cron_health |

---

## 2. Scope

**In scope.**

- Every mechanism in section 4, on `main` at the base commit.
- The open PRs that change those mechanisms, as an overlay: what O-1 and O-2
  look like if each PR merges (section 6.2, phase 6).
- Configuration that switches a mechanism on or off: env vars, flags and
  `tenant_settings` columns.
- The tests that cover each mechanism.

**Out of scope.**

- The 16 ERP connectors other than Tally, one by one. Fifteen share
  `src/api/_lib/erp-runner.js`; NetSuite keeps its own retry copy (M-10). The
  audit treats the fifteen as one class, reads one of them (SAP) as the sample,
  and reads NetSuite with Tally.
- Extraction quality inside the DocAI pipeline. The audit reads only the job
  queue, the lease, the reaper and the writeback to the order.
- Pricing, margin, logistics planning and inventory planning logic. The audit
  reads only their exception and notice outputs.
- Screen design. A screen is in scope only when it is the only reader of a
  mechanism.
- Secret storage (#619) and portal authentication. Other plans own them.
- Any fix. Defects go to O-6 and get their own PRs.

---

## 3. Prior analysis that the audit reuses

The audit re-verifies a claim from these documents before it uses it. It
does not copy a claim. If the code changed, the audit says so.

| Document | What it already settled | What the audit still checks |
|---|---|---|
| `SO_EXECUTION_COHESION.md` (#611) | The SO journey and its seams; the collaboration capability table (section 2); the autonomy map and `so_controls` (R-M2, migration 266); the thin order-first slice of the work layer (R-M6); C-1 to C-38 | Whether its section 2 table is still true at the base commit; where each mechanism in it sits in O-2; which C-PRs already merged or are open (#622 to #630) |
| `WORK_MANAGEMENT_SCOPE.md` | `work_items`, links, events, watchers and automation rules (sections 4.2 to 4.8); why `agent_goals`, `processing_events`, `operator_actions` and the exception tables are not the task table (section 4.11); reusable primitives (section 2.4) | Whether EA-3's `work_items` subset (#637) matches section 4.2; whether section 4.8's inline `emitWorkEvent` is still the right trigger once a scheduler exists |
| `AGENT_READY_SO_FLOW.md` | The exceptions work queue, `agentPolicyFor`, `DEFAULT_AGENT_POLICY`, the next-step function, solo mode (off) | That no tenant setting is read (section 5); that "the agent runner" for exceptions is still not built (section 7) |
| `ANVIL_MCP_SO_TOOLS_DESIGN.md` | MCP reuses the erp_chat tool registry; `write.*` tools are propose-only through `action_proposals` | Which phase 2 action tools exist; whether every write tool goes through `createProposal` |
| `OPERATOR_ACTIONS_DESIGN.md` | A governed path for systems with no API; migration 150; flag `operator_actions_enabled` (off) | Whether anything calls it; whether it overlaps the Mode B "keyed in ERP" step that #611 keeps human |
| `CRONS.md` | The tick and daily fan-out; the external trigger assumption; the heartbeat sweep | Whether the handler list is current; #566 rewrites this file |
| `GENAI_FOR_MANUFACTURING.md` | The copilot substrate; the two trust models (section 8: "never let a chat turn silently execute a write") | Whether the two trust models are reconciled anywhere in code |
| `EMAIL_ACCOUNTABILITY_SCOPE.md` (#634, open) | Mailbox sync, rules, the action register on `work_items`, reminders and escalation, migrations 252 and 267 to 270 | How its sync runner, sweep, reminder ledger and notices map onto L1 and L4; whether they add a seventh queue shape |
| PR #566 body (open) | The 51 tick handlers with side effects, backlog risk and a turn-on order | Use as the starting L1 inventory; re-verify each `path:line` |
| Sibling session notes (#631, #632, #633, #634) | Found-not-fixed items on the approval gate, the Tally retry queue and the reconciler | Carry each into O-6 if still present |

---

## 4. Mechanism inventory to verify

Each row was checked on `main` at the base commit for this plan: the file
exists, and the named function or table exists at the line given. "Live"
means a trigger that fires in production calls it. The audit fills the
"Live" column with evidence. This plan does not claim that any row is live.

**Status codes.** *Wired*: a trigger calls it in code (a schedule may still be
missing). *Routable*: a route exists, but no schedule or screen calls it.
*Flag off*: wired behind a flag that defaults to off. *Open PR*: not on
`main`. *Designed*: a document only.

### 4.1 L1. Clock and drains

| ID | Mechanism | Entry | Tables | Trigger | Status on main | Open PRs |
|---|---|---|---|---|---|---|
| M-1 | Vercel cron | `vercel.json:12-17` | none | Vercel, 02:30 UTC daily | Wired. The only schedule in the repo | none |
| M-2 | Tick multiplexer: ALWAYS group, 30-minute group, hourly group, minute-5 group | `cron/tick.js:134`, `:152`, `:194`, `:198`, `:149` | none | GET with `CRON_SECRET`; no caller in the repo | Wired, not scheduled (H-1) | #566 adds an allow-list registry and a GitHub Actions trigger |
| M-3 | Daily multiplexer | `cron/daily.js:58` | none | M-1 | Wired | #534 adds the inventory planner; #623 adds `bellStaleTick`; EA-6 and EA-8 add `email/sweep_daily` and `email/purge` |
| M-4 | Fan-out runtime: mock request, per-handler budget, parallel group | `_lib/cron-mux.js:130`, `:192`, `:75` | none | M-2, M-3 | Wired | #566 fixes the mock `statusCode` |
| M-5 | Heartbeats | `_lib/cron-mux.js:220`; `066_cron_health.sql:18` | `cron_health` | Every handler run (H-4) | Wired | none |
| M-6 | Staleness checks: two maps, the public probe, the daily sweep | `_lib/heartbeat-check.js:18`, `health.js:99`, `healthz.js:74`; sweep at the end of `cron/daily.js` | `cron_health` | `/api/health`, `/api/_healthz`, M-3 | Wired. The sweep only logs (`heartbeat-check.js:98-108`) | #623 adds a bell row for a stale tick |
| M-7 | Crons with a route and no schedule | `router.js:738-741` (inventory positions, planning, exceptions, conformal calibration) | inventory tables | HTTP only | Routable | #534 schedules the planner only |
| M-8 | Generic status-flip drain | `_lib/queue-runner.js` (`drainQueue`), 3 callers | the caller's table | M-2 | Wired, not scheduled | none |
| M-9 | Shared ERP retry and sync runtime (15 connectors) | `_lib/erp-runner.js:64` (`drainRetryQueue`), `:49` (claim), `:23` (backoff) | `<erp>_retry_queue`, `<erp>_sync_runs` (015 to 019 and later) | M-2 RETRIES and SYNCS | Wired, not scheduled | none |
| M-10 | Tally and NetSuite retry queues (own copies) | `tally/retry.js:140`, `:26`, `:124`; `netsuite/retry.js:152`, `:25` | `tally_retry_queue` (`016:96`), `netsuite_retry_queue` (`015:77`) | M-2 RETRIES | Wired, not scheduled. No claim; no bell on give-up | #631 adds a retry guard and a tenant filter |
| M-11 | Background extraction jobs and the run reaper | `cron/extraction_jobs.js:923`, `:142` (lease), `:808` (writes order lines); `cron/extraction_reaper.js:23` | `extraction_jobs` (`117:34`), `extraction_runs` (029) | M-2 ALWAYS; reaper in M-3; jobs queued at `orders/extraction_jobs.js:137` | Wired, not scheduled | #566 makes this the default handler; #625 guards reviewed lines |

### 4.2 L2. Actors

| ID | Mechanism | Entry | Tables | Trigger | Status on main | Open PRs |
|---|---|---|---|---|---|---|
| M-12 | Autonomous goal runner | `agents/run.js:316`, `:98` (`executeAction`), `:28` | `agent_goals` (`011:27`), `agent_steps` (`011:104`), `communications`, `voice_calls` | M-2 hourly | Wired, not scheduled | #566 keeps it off by default |
| M-13 | Goal types and arming | `agents/_handlers/index.js:45` (16 handlers); `agents/goals.js:21` (by hand); `quotes/send.js:60-79` (the only automatic arming) | `agent_goals` | Screen `agents.tsx`; quote send | Wired | #623 arms quote goals only after a real send |
| M-14 | Reply handler for classified inbound mail | `agents/handle_replies.js:164`, `:126` | `inbound_emails`, `agent_goals`, `agent_steps` | M-2 ALWAYS; manual drain (H-10) | Wired, not scheduled | none |
| M-15 | erp_chat tool loop and the shared tool registry | `erp_chat/send.js:53`; `_lib/erp-chat-tools.js:785` | `erp_chat_sessions`, `erp_chat_messages` (026) | Screen (Ask Anvil) | Wired | none |
| M-16 | Propose and confirm | `_lib/action-proposals.js:20`, `:45`; `copilot/confirm.js:22`, `:96`; `copilot/proposals.js` | `action_proposals` (`149:12`) | M-15 and M-18 write tools; confirm screen | Wired | #623 reports unsent mail on confirm |
| M-17 | Ask Anvil personas | `agent/personas.js:20`; `_lib/agent-personas.js:39` | `tenant_settings.so_agent_enabled` (210) | Screen | Flag off | none |
| M-18 | MCP server | `mcp/server.js:22`; `_lib/mcp.js:87`; `mcp/tokens.js` | `mcp_tokens` (`027:13`), `mcp_call_log` (`027:41`) | External MCP client with a scoped token | Wired | none |
| M-19 | Operator actions | `operator_actions/index.js:24`; `operator_actions/reconcile.js:71` (writes order status) | `operator_actions` (`150:14`) and its steps and evidence | HTTP; no screen found | Flag off (`operator_actions_enabled`) | none |
| M-20 | Voice intake and outbound | `voice/webhook.js:122`; `voice/process_actions.js:99`, `:54` (inserts an order) | `voice_call_actions` (`041:95`), `voice_calls` (`041:57`) | Provider webhook; M-2 ALWAYS; screen for outbound | Wired, not scheduled | none |
| M-21 | Chat intake (Slack, Teams, WhatsApp) | `inbound/{slack,teams,whatsapp}/webhook.js`; `inbound/process_messages.js:160`, `:58` (inserts an order) | `inbound_messages` (`039:10`) | Provider webhooks; M-2 ALWAYS | Wired, not scheduled | none |
| M-22 | Legacy WhatsApp intake | `whatsapp/inbound.js:252` (inserts an order) | `orders`, `documents` | Webhook with one global token | Wired | none |
| M-23 | Prospecting dispatch | `prospecting/run.js:129`; `_lib/marketing-send.js:90` | campaign tables, `communications` | M-2 ALWAYS | Wired, not scheduled | none |
| M-24 | Dispatch register auto-send | `_lib/dispatch-register-send.js:76`, `:86` | `communications` | Inline, after a person writes despatch lines | Flag off | none |

Checked and left out, because they write no business object: `delays/scan.js`,
`anomaly/explain.js`, `eval/*`, `rlhf/*` and `claude/messages.js`.

### 4.3 L3. SO record path

| ID | Mechanism | Entry | Tables | Trigger | Status on main | Open PRs |
|---|---|---|---|---|---|---|
| M-25 | Inbound email webhook and dedup | `inbound/email/webhook.js:208`; `_lib/inbound-email.js` | `inbound_emails` (`028:38`), `inbound_email_threads` | Postmark or Graph webhook | Wired | none |
| M-26 | Inbound email classifier | `inbound/email/parse.js:131`; `_lib/email-classifier.js:16` | `inbound_emails` | M-2 ALWAYS | Wired, not scheduled | none |
| M-27 | Attachment persistence | `inbound/email/persist_attachments.js:38` | `documents` | M-2 ALWAYS | Wired, not scheduled | none |
| M-28 | Draft orders from email | `inbound/email/draft_orders.js:58`, `:75` | `orders`, `order_documents` | M-2 ALWAYS | Wired, not scheduled | none |
| M-29 | Legacy inbound email | `email/inbound.js:196`; route `router.js:1030` | `orders`, `documents` | Webhook with one global token | Wired (H-15) | none |
| M-30 | Auto OCR of intake documents | `inbound/auto_ocr.js:103`, `:181` | `extraction_runs` (029) | M-2 ALWAYS | Wired, not scheduled | none |
| M-31 | Extraction review queue | `docai/review_queue.js:83` | `extraction_review_queue` (`123:28`) | Screen | Wired | none |
| M-32 | Other order creators | `orders/index.js:187`, `quotes/convert.js:162`, `portal/reorder.js:79` | `orders` (`001:134`) | Screens and portal | Wired | none |
| M-33 | Order transitions and approval | `orders/[id].js:67` (`ALLOWED_TRANSITIONS`); `_lib/order-write-gate.js:57` (role gate); `_lib/approval-evaluator.js:56`; `admin/quote_approvals.js:48` | `orders`, `quote_approvals` (`006:622`) | PATCH from screens | Wired | #622 move gate; #627 no TTL in Mode B; #631 approval defects; #626 derived stage |
| M-34 | Exceptions, findings and the next step | `_lib/order-exceptions.js:225` (`DEFAULT_AGENT_POLICY`), `:280`; `orders/exceptions.js:69`; `_lib/blocking-findings.js:28`; `_lib/order-anomaly-check.js:59`; `findings/index.js`; `_lib/order-next-step.js:89` | `orders.rule_findings` (jsonb), `validation_findings` (`001:228`), `order_term_flags` (250) | Computed on read; inline after writes | Wired. Derived list, no table | #622, #625 |
| M-35 | Tally push and enqueue | `tally/push.js:58`; `_lib/tally-enqueue.js:13` | `tally_voucher_records`, `tally_retry_queue` | Screen; copilot confirm | Wired | #632 reconciler re-queue |
| M-36 | Tally sync, reconciler and drift meter | `tally/sync.js:202`; `cron/tally-reconcile.js:72`; `_lib/tally-reconciler.js:263`; `cron/drift-meter.js:145` | `tally_voucher_state` (016), `tally_reconciliation_runs` (`095:33`), `tally_reconciliation_findings` (`095:66`), `tally_drift_billing_meter` (097) | M-2 30-minute and hourly groups | Wired, not scheduled | #632 |
| M-37 | Mode B setting and handoff settings | `_lib/so-processing-mode.js:33`; `admin/order_handoff_settings.js:103` | `tenant_settings.so_processing_mode` (`221:27`), `orders.handoff_*` (251) | Admin screen | Wired; no send on main | #630 handoff send; #628 lane readiness |

### 4.4 L4. Attention and messages

| ID | Mechanism | Entry | Tables | Trigger | Status on main | Open PRs |
|---|---|---|---|---|---|---|
| M-38 | Bell | `_lib/notifications.js:34`; `admin/notifications.js:21`; bell in `Shell.tsx:600` | `admin_notifications` (`042:89`) | About 12 helper calls in 7 files, 1 direct insert | Wired. One row per tenant; admin and operator only | #624 a row per person, every role, phone |
| M-39 | Web push | `push/send.js:69`; `v3-app/lib/push.ts:37` (no caller) | `push_subscriptions` (`021:8`), `push_notifications` (`021:37`) | M-2 ALWAYS; manual send | Dormant: nobody can subscribe | none |
| M-40 | Communications record | `_lib/comms-row.js:23`; 19 insert sites | `communications` (`005:22`, 189) | Many | Wired | #623 |
| M-41 | Send rails | `_lib/comms-send.js:106` (Graph, mailer, webhook, chat); `_lib/mailer.js:130` (direct); `whatsapp/send.js:63`; `_lib/marketing-send.js:90` | `communications` | Inline | Wired | #623 honest status; #630 direct handoff send |
| M-42 | Queued mail reaper | `agents/run.js:276`, `:358-364` | `communications` | Inside M-12 only | Wired, not scheduled (H-8) | none |
| M-43 | Recipient resolvers | `_lib/comms-routing.js:49`; `_lib/internal-recipients.js:127`; `_lib/assignee.js:15` | `customer_contacts`, `tenant_members` | Inline | Wired | #623 `alertRecipientsForRoles`; #624 `notify()` |
| M-44 | Logistics exceptions and notices | `cron/logistics-monitor-tick.js`; `_lib/logistics/notifications.js:74` | `logistics_exceptions` (`206:50`) | M-2 ALWAYS and M-3 | Flag off (`logistics_monitor_enabled`) | #623 recipients and an email budget |
| M-45 | Inventory exceptions and notices | `_lib/inventory/exceptions-detector.js:249`; `_lib/inventory/notifications.js:60` | `inventory_exceptions` (`085:356`), `voice_calls` | M-7 only | Routable | #623 recipients and an email budget |
| M-46 | Pull lists | Approvals queue (`admin/quote_approvals.js:48`); the exceptions card (M-34); Home (`home.tsx:63`); the extraction review queue (M-31) | as listed | Screens | Wired. Nothing pushes them to a person | #629 every screen reads the stage |

### 4.5 L5. Trail

| ID | Mechanism | Entry | Tables | Trigger | Status on main | Open PRs |
|---|---|---|---|---|---|---|
| M-47 | Audit log | `_lib/audit.js:74` (`recordAudit`) | `audit_events` (`001:323`), `audit_failures` (063) | About 480 calls in 310 files | Wired | none |
| M-48 | Processing events | `_lib/audit.js:139` (`recordEvent`); direct inserts such as `agents/run.js:108` | `processing_events` (`001:343`) | 29 files plus about 13 direct inserts | Wired. Display only: no code acts on an event type | none |
| M-49 | Per-mechanism logs | `agent_steps`, `mcp_call_log`, `erp_chat_messages`, `<erp>_sync_runs`, `tally_reconciliation_runs`, `cron_health` | as listed | Their mechanisms | Wired | none |

### 4.6 New mechanisms in open PRs

| PR | Adds | Layer |
|---|---|---|
| #566 | The tick handler registry with a cadence per handler, the `CRON_TICK_HANDLERS` allow-list, a GitHub Actions trigger | L1 |
| #622 | `_lib/order-move-gate.js`: the server refuses a move that an open exception blocks | L3 |
| #623 | `bellStaleTick`, `_lib/alert-email-budget.js`, `alertRecipientsForRoles`, `failUnsentRow` | L1, L4 |
| #624 | `notify()`, a notice per person (migration 253) | L4 |
| #626 | `_lib/order-stage.js`: one derived stage | L3 |
| #630 | `_lib/order-handoff.js` and `/api/orders/handoff`: the Mode B handoff send | L3, L4 |
| #635, #636 (EA-1, EA-2) | Mailbox connections and `email/sync` in the tick | L1, L4 |
| #637 (EA-3) | `work_items` (252), `email_actions`, `email_rules` (268) | L4 |
| #640 (EA-6) | A notice ledger (270) and `email/sweep` in tick and daily | L1, L4 |
| #642 (EA-8) | `email/purge` in daily, email health | L1 |

---

## 5. Questions for each mechanism

### 5.1 The standard card (every mechanism)

The audit fills one card per mechanism. A blank answer is "not confirmed",
never a guess.

| # | Question | Evidence to collect |
|---|---|---|
| Q1 | What job does it do, in one sentence? Which PR or document asked for it? | Header comment `path:line`; PR number |
| Q2 | Is it live: does a trigger that fires in production call it? | The trigger `path:line`; the schedule; the flag default; the live SQL in section 6.4 |
| Q3 | What starts it, and how often? | Cron group and minute gate, webhook route, screen button, inline call |
| Q4 | What is the unit of work? Which table, which status column, which values, and which code sets each value? | `NNN:line` for the table and the CHECK; `path:line` for each writer |
| Q5 | How does it claim a row, and what happens if two runs overlap? | Lease or claim columns; the conditional UPDATE; a reaper |
| Q6 | How does it retry? What is the backoff, the give-up state, the age limit and the dead letter? | Constants; status values; the code that stops retrying |
| Q7 | What makes it idempotent? What is the dedup key? | Unique index `NNN:line`; hash or fingerprint `path:line` |
| Q8 | How does it keep tenants apart? Service client or RLS? Does every query filter on `tenant_id`? | Each `.from()` call without a tenant filter |
| Q9 | What authority does it act with? Which permission or server action? Shadow, propose or apply? Does a person confirm each action? | `requirePermission`, `hasAction`, `SERVER_ACTIONS`; confirm step |
| Q10 | What does it do outside Anvil? Email, WhatsApp, voice, ERP write, billing, LLM cost? | The call `path:line`; the provider; the env var |
| Q11 | Does it write an order (status, lines in `orders.result`, approval)? Does the write pass the transition rule (`orders/[id].js:67`), the role gate (`order-write-gate.js`) and the approval evaluator, or none of them? | Each write `path:line`; which checks it passes |
| Q12 | Where does a failure go? Who sees it, and can that person act on it? | Failure table, notice, log; the screen that reads it |
| Q13 | What trail does it leave? Is the actor recorded as a person, an agent or the system? | `audit_events`, `processing_events`, own log; actor id (`ctx.user.id`, not `ctx.userId`) |
| Q14 | How does on-call know it is healthy? | `cron_health` worker name; staleness bound in both maps; metrics |
| Q15 | Which config switches it? What are the defaults? | Env var, flag, `tenant_settings` column `NNN:line` |
| Q16 | Which tests cover it? | Test file; what the test does not cover |
| Q17 | Which other mechanism does the same job for the same object? | Row ids from section 4 |
| Q18 | Which plan owns its future? | C-n, WM-n, EA-n or PR number; "none" |

### 5.2 Questions per layer

**L1. Clock and drains.**

1. Does anything call `/api/cron/tick` in production today? When did it last
   run? (The `cron_health` row for `cron/tick`.)
2. Which handlers run from tick, which from daily, which from both, and which
   are only routable? (The four inventory crons are routable only:
   `router.js:738-741`.)
3. How many queue shapes exist? For each: claim, lease, attempts, backoff,
   give-up, age limit, reaper and heartbeat.
4. Is every heartbeat name in a staleness map, with a bound that matches its
   cadence? Do the two maps agree (`health.js:99`, `heartbeat-check.js:18`)?
5. How many times does one handler run write its heartbeat, and does a failure
   count once?
6. What happens to the minute-gated groups (30-minute, hourly, minute 5) when
   the trigger is late? (#566 notes that GitHub schedules start late.)
7. Does the sum of the per-handler budgets fit inside the 60 s function limit
   with the ALWAYS group at full size?
8. Which drains act on an old backlog the first time they run, and what does
   each send or create? (Start from #566's table.)

**L2. Actors.**

1. How many tool registries and action executors exist? Which ones share code?
2. For each actor: can it create an order, change an order's status or lines,
   send a message outside Anvil, or queue an ERP push? Evidence for each yes.
3. Which trust model does each actor use: act directly, propose and confirm,
   or human only? Is there one autonomy setting that all actors read?
4. Does a write by an actor pass the same server gate as the same write by a
   person?
5. How does an actor's escalation reach a person, and is it the same channel
   for every actor?
6. Which actors run only inside the tick, and so are dormant if H-1 holds?

**L3. SO record path.**

1. How many paths create an order? Do they share one dedup rule
   (`payload_hash`, PO number, document hash)?
2. List every state machine on the path: orders, inbound email, extraction
   jobs, the Tally retry queue, the handoff. Where does each transition rule
   live, and does any screen hold a rule that the server does not?
3. How many exception sources exist (computed `order-exceptions.js`, stored
   `rule_findings`, anomaly flags, logistics and inventory exceptions)? Is
   there one blocker rule, enforced on the server?
4. How many paths can push a voucher again after a failure (the per-ERP
   retry queue, the reconciler auto-fix, the copilot `post_tally_voucher`
   confirm, a manual push)? Can two of them push the same voucher? The
   `failed_push_recovery` goal only escalates; who arms it?
5. In Mode B, which record marks the end of the order, and which mechanism
   writes it?

**L4. Attention and messages.**

1. List every channel that can tell a person that an SO needs action.
2. For six SO events (a PO email arrives, extraction finishes, an order needs
   approval, an order is approved, an ERP push fails, the handoff is sent or
   the SO is keyed in the ERP), list every row written and every screen that
   shows it.
3. How many resolvers turn a role into a person or an address? Do they agree?
4. How many send rails exist? Which ones deliver without the tick? Which ones
   report "sent" when nothing was sent?
5. Which channels have dedup, read, acknowledge, resolve and escalate? Which
   have none?

**L5. Trail.**

1. Can one timeline read every event for an order, from every actor?
2. Is the actor kind (person, agent, system) recorded the same way in every
   log?
3. Which logs hold personal data, and what is their retention?

---

## 6. Method

### 6.1 Rules

- **Read only.** No code change, no migration, no write to any database, no
  call to an external service, no cron trigger. The audit never runs a handler.
- **One base commit.** The audit records the SHA of `origin/main` when it
  starts. At the end it re-reads every cited line against the current
  `origin/main` and moves any reference that shifted.
- **Evidence for every claim.** `path:line` at the base commit, `NNN:line` for
  a migration, or a PR number and file for open work. A claim with no
  reference is removed or marked "not confirmed".
- **Three labels.** *Verified*: read in code. *Inferred*: follows from
  verified facts, and the steps are written down. *Not confirmed*: neither.
- **Wired is not live.** A function that no trigger calls is "built, not
  wired". A wired handler with no schedule is "wired, not scheduled".
- **Live facts come from the owner.** The audit asks the owner to run the
  SELECT queries in section 6.4 and labels each answer "live, as of date".
  Without them, a live claim is "not confirmed".
- **Prior documents are inputs, not evidence.** Section 3 applies.
- **No names.** No customer, person or part names. No tenant ids in the
  document.
- **A verifier pass.** A second reader re-checks every O-1 row and every O-2
  cell marked as a conflict, and the audit corrects what the verifier finds.
  (In #611, the verifier changed several traces.)

### 6.2 Order of inspection

The order follows dependency. The clock decides what is live. The SO record
path is what every actor acts on. The actors are measured against the gate
that the record path defines.

| Phase | Layer | Mechanisms | Why in this place |
|---|---|---|---|
| 1 | L1 clock and drains | M-1 to M-11 | If the tick never fires, half of L2 and L4 is dormant. Every later "live" answer depends on it |
| 2 | L3 SO record path | M-25 to M-37 | The object that everything acts on: its state machines, its gate and its retry paths |
| 3 | L2 actors | M-12 to M-24 | Each actor is checked against the gate from phase 2 |
| 4 | L4 attention and messages | M-38 to M-46 | The six-event trace (section 5.2, L4 question 2) needs phases 1 to 3 |
| 5 | L5 trail, and cross-cutting checks | M-47 to M-49; tenant, auth and config | Uses the cards from phases 1 to 4 |
| 6 | Open PR overlay | #566, #534, #619, #622 to #633, #634 to #642 | What changes in O-1 and O-2 if each PR merges |
| 7 | Synthesis | O-2 to O-6 | The verifier pass, then the owner review |

### 6.3 Evidence per mechanism

One card per mechanism, in this shape. The cards go into an appendix of the
audit document. O-1 is the table of the cards' first fields.

```
M-n  <name>                                   layer: L?
status on main: wired | routable | flag off | open PR | designed
live: yes | no | not confirmed   (evidence: query n in 6.4, date)
Q1  job:
Q3  trigger:                      path:line
Q4  unit of work: table, status values   NNN:line
Q5  claim:            Q6  retry:            Q7  dedup:
Q8  tenant:           Q9  authority:        Q10 outside effects:
Q11 order writes:                 path:line (checks passed)
Q12 failure goes to:  Q13 trail:            Q14 health:
Q15 config:           Q16 tests:
Q17 overlaps: M-x, M-y            Q18 owner plan:
notes / defects (to O-6):
```

### 6.4 Read-only queries for the owner

The audit sends these queries to the owner as one script. Before it sends
them, it checks each table and column against its migration at the base
commit. Every query is a SELECT. The owner runs them in the Supabase SQL
editor and returns counts only. No row content leaves the database.

1. `cron_health`: every row (`worker`, `last_run_at`, `last_status`,
   `consecutive_failures`). This answers H-1 and H-3.
2. Each queue table, grouped by status, with the oldest `created_at`:
   `extraction_jobs`, `inbound_emails`, `inbound_messages`,
   `voice_call_actions`, `voice_calls`, `communications`,
   `push_notifications`, `tally_retry_queue`, the other `<erp>_retry_queue`
   tables that exist, `agent_goals`, `action_proposals`, `operator_actions`.
3. Open items in each attention place: `admin_notifications` unresolved,
   `logistics_exceptions` and `inventory_exceptions` open, orders with an
   unresolved blocking entry in `rule_findings`, `validation_findings`
   unresolved, `extraction_review_queue` open, `quote_approvals` pending.
4. `tenant_settings`: how many tenants have each switch on
   (`logistics_monitor_enabled`, `operator_actions_enabled`, the SO processing
   mode, `terms_check_mode`, `so_agent_enabled`,
   `dispatch_register_auto_send_enabled`, a Graph mail connection). Counts
   only.
5. Which migrations from 206 to 251 are applied: one object per migration
   (a table through `to_regclass()`, or a column through
   `information_schema.columns`).
6. Activity in the last 30 days: rows written per day to `agent_steps`,
   `processing_events`, `audit_events`, `mcp_call_log` and `communications`.

### 6.5 Staffing and cost

- One lead session owns the document and the synthesis.
- Up to five read-only search subagents, one per layer, run in parallel in
  phases 1 to 5. Each gets the card template and the questions for its layer.
- One verifier subagent in phase 7.
- No multi-agent workflow unless the owner asks for one. This stays under the
  session guideline of 10 agents.
- Time box: three working sessions. Phase 1 and the owner's queries come
  first, because they change what the rest of the audit reads.

---

## 7. Planned outputs

All outputs go into `docs/SO_AGENT_INFRA_AUDIT.md`, in one docs-only PR, with
the cards as an appendix.

### O-1. Mechanism inventory

One row per mechanism: id, name, layer, entry `path:line`, tables, trigger,
status on main, live (with evidence), owner plan, and the open PRs that
change it. The audit adds any mechanism it finds that section 4 does not
list, and marks it "new in the audit".

### O-2. Overlap and conflict matrix

Two matrices.

**Mechanism by job.** Rows are mechanisms. Columns are the jobs that a
unified core must do once:

| Schedule | Claim and lease | Retry and give up | Dedup | Decide (policy) | Act on an order | Send outside | Notify a person | Track human work (owner, due) | Escalate | Record the trail | Report health |
|---|---|---|---|---|---|---|---|---|---|---|---|

Each cell says how that mechanism does the job, with `path:line`, or stays
blank. Each pair of non-blank cells in one column gets a class:

- *Duplicate*: the same job with the same rules. Merge.
- *Divergent*: the same job with different rules (backoff, dedup key, actor
  record, recipient). Pick one rule.
- *Double fire*: two paths run the same work (for example, a handler in both
  tick and daily, or two retry paths for one voucher).
- *Dead*: built, not wired.
- *Gap*: a job that no mechanism does for an SO (a column with no live cell).

**Event by channel.** Rows are the six SO events (section 5.2, L4 question 2).
Columns are the attention and message channels. Each cell lists the row that
the event writes and the screen that shows it. This matrix shows how many
places a person must watch.

### O-3. Target unified model

A short design. It names the shared primitives that SO agent work needs, and
for each existing mechanism it says *keep*, *adapt onto a primitive*,
*merge*, or *retire*. The audit proposes. The owner decides (O-5).

The model must meet these constraints. They come from the house rules and
from #611:

1. No new status values on `orders`. Stage comes from records (R-M1).
2. One server gate for every write to an order, whatever the actor: a person,
   an agent goal, the copilot, MCP, voice or chat intake.
3. One autonomy map that every actor reads (shadow, propose, apply, human
   only), stored once (`so_controls`, R-M2, migration 266).
4. One scheduler registry with a cadence and an allow-list per handler (the
   shape #566 proposes), and one staleness map.
5. One queue contract: claim, lease, attempts, backoff, give-up, age limit and
   heartbeat. Each queue table may stay. The contract is shared code.
6. One notice helper that reaches a named person on desktop and phone, with
   dedup (#624 is the candidate).
7. One record for human work with an owner and a due time, which points at a
   stage or an exception and never carries a second status for the order
   (R-M6). This settles H-6.
8. One event log that a timeline can read, with the actor kind on every row.
9. Every outbound message goes through one send rail that reports only what
   the provider confirmed.

### O-4. Migration path in small PRs

A list of PRs U-1 to U-n in merge order. Each PR:

- changes one primitive or moves one mechanism onto a primitive;
- ships its caller (no unwired code);
- keeps today's behavior, or sits behind a flag that defaults to off;
- carries its tests;
- names the mechanism it retires, with a "zero callers" check before any
  delete;
- uses migration numbers from 271 up, and names them;
- maps to the C-n, WM-n, EA-n or open PR that it builds or replaces.

The path starts with the steps that need no decision. It names the first
three PRs in full and the rest in one line each.

### O-5. Owner decisions handed back

Each decision with options, a default, and the evidence behind it. Expected
topics: the trust model for automated writes, the home of human work items,
the scheduler (GitHub Actions, cron-job.org or pg_cron), which dormant
mechanisms to retire, and the turn-on order for drains with a backlog.

### O-6. Found, not fixed

Defects found while reading, each with `path:line`, the failure scenario and
a suggested PR. The audit fixes nothing. Section 8.1 seeds this list, after
a re-check at the audit base commit.

---

## 8. Early signals to test

These came up while this plan was written. Each one is a hypothesis with the
evidence seen so far. The audit confirms or rejects each one.

| # | Signal | Evidence seen | What the audit must settle |
|---|---|---|---|
| H-1 | The 5-minute tick may never have run in production | `vercel.json:12-17` schedules only `/api/cron/daily`. `docs/CRONS.md:7-10` relies on a cron-job.org trigger set up by hand. Nothing in the repo calls `/api/cron/tick` (#566). #623 (open) adds a bell row when the tick is stale | Live query 1. If the tick is dead, mark every ALWAYS, 30-minute and hourly handler "wired, not scheduled" |
| H-2 | Some crons are routable only, and one handler runs on two paths | The four inventory crons have routes and no schedule (`router.js:738-741`); #534 (open) adds one to daily. The logistics monitor is in tick (`tick.js:186`) and in daily (`daily.js:93`) on purpose | The full list of routable-only and double-registered handlers, and whether each double path is safe |
| H-3 | Two cron staleness maps that disagree | `health.js:99-108` has 5 keys. `heartbeat-check.js:18-49` has 12. Daily sub-handler rows (written at `daily.js:108`) and 30-minute rows such as `tally/reconcile` fall to the 10-minute default (`heartbeat-check.js:49`). `/api/_healthz` answers 503 when any row is stale (`healthz.js:74`) | Whether `/api/_healthz` is 503 most of the day; one map |
| H-4 | One handler run writes its heartbeat two or three times | Inline in `runCronHandler` (`cron-mux.js:178`), again in the result loop (`tick.js:239`, `daily.js:108`), and inside some handlers (`inventory-exceptions-tick.js:54`). A failure reads, then writes `consecutive_failures` (`cron-mux.js:234-236`) | Whether one failure counts as two |
| H-5 | Two trust models for automated writes, and no shared gate | Agent goals send email and place calls with no per-action confirm (`agents/run.js:98`, `:165`, `:221`, `:276`). Copilot, erp_chat and MCP write tools only propose (`_lib/action-proposals.js:20`), and the proposer must confirm with `approve` (`action-proposals.js:45-67`, `copilot/confirm.js:96`). Intake workers insert DRAFT orders directly (`voice/process_actions.js:54`, `inbound/process_messages.js:58`, `inbound/email/draft_orders.js:75`, `whatsapp/inbound.js:252`). Operator actions change an order's status directly (`operator_actions/reconcile.js:71`). Only `orders/[id].js`, `admin/quote_approvals.js`, `_lib/order-margin.js` and `_lib/auth.js` import the order write gate or the approval evaluator. `DEFAULT_AGENT_POLICY` is code only (`_lib/order-exceptions.js:225`) | Which writes need the gate; one autonomy map for every actor (O-3 constraints 2 and 3) |
| H-6 | Two designs claim the `work_items` table | `WORK_MANAGEMENT_SCOPE.md` section 4.2 (WM-5) and EA-3 (#637, migration 252, a subset with its own state set, `EMAIL_ACCOUNTABILITY_SCOPE.md` section 6.5). #611 R-M6 says an order item must never carry a second status | Whether one table serves email actions and order work; settle before #637 merges (AD-5) |
| H-7 | At least six queue shapes | (a) `drainQueue` status flip (`_lib/queue-runner.js`, 3 callers). (b) The generic ERP retry queue: atomic claim, a 15-minute stuck reset, backoff from 1 to 720 minutes (`_lib/erp-runner.js:23`, `:49-57`, `:80-90`). (c) The Tally retry queue: its own copy of the backoff (`tally/retry.js:26`) and no claim (select, then replay, `tally/retry.js:124`), although migration 059 added the claim columns. (d) `extraction_jobs` with a lease and a daily reaper for runs (`cron/extraction_jobs.js`, `cron/extraction_reaper.js`). (e) `agent_goals` by `next_run_at` (`011_agent_goals.sql`). (f) Queued `communications` drained by the reaper (`agents/run.js:276`). Inbound parse, persist_attachments (no status, no attempt cap), auto_ocr and handle_replies each own a select-and-limit loop. EA adds `email/sync` and `email/sweep` | The queue contract in O-3 constraint 5, and which shapes move onto it |
| H-8 | Queued mail leaves only through the agent runner | The only drain of queued `communications` is `reapQueuedCommsForTenant`, called only for tenants with a due goal (`agents/run.js:358-364`), hourly, from the tick. #623 (open) makes quote send direct | Every producer of queued mail and its real delivery path |
| H-9 | The same failure reaches people differently, by mechanism | A non-Tally ERP push that gives up writes an admin bell row (`_lib/erp-runner.js:118-130`). A Tally push that gives up writes only status columns (`tally/retry.js:50-60`), and no notice. The `failed_push_recovery` goal escalates to the bell (`agents/run.js:108`, `:120`), but only `quotes/send.js:60-79` arms goals automatically, so this goal exists only if a person creates it. #611 section 2 says "only a failed Mode A ERP push writes an admin bell row"; for Tally, the main ERP, that looks untrue | The event by channel matrix in O-2 |
| H-10 | Two manual drains cross tenants | `agents/handle_replies.js:181` and `voice/process_actions.js:152` call `drainOnce(svc)` after a tenant user passes `approve`. Neither `drainOnce` filters on `tenant_id` (`handle_replies.js:126-132`, `process_actions.js:99`) | A defect, not a design question. Goes to O-6 at once, with its own fix PR |
| H-11 | Eight paths create an order, and a background job rewrites lines | Order inserts: `orders/index.js:187`, `quotes/convert.js:162`, `portal/reorder.js:79`, `inbound/email/draft_orders.js:75`, `email/inbound.js:196`, `inbound/process_messages.js:58`, `voice/process_actions.js:54`, `whatsapp/inbound.js:252`. The background extraction job writes `orders.result` directly (`cron/extraction_jobs.js:808`); #625 (open) guards reviewed lines. The transition rule lives in `orders/[id].js:67`; `_lib/order-write-gate.js` is a role gate, not a state gate | The dedup rule on each path (L3 question 1); which writes bypass the transition rule |
| H-12 | Several paths can push one Tally voucher | The retry queue drain with no claim (H-7 c), the reconciler auto-fix re-queue (`_lib/tally-reconciler.js`; #632 adds a one-push guard), the copilot `post_tally_voucher` confirm (`_lib/tally-enqueue.js:13`, which does not check Mode B; the drain refuses instead), and a manual push (`tally/push.js`) | Whether two paths, or two overlapping drains, can create the same voucher twice (`ACTION="Create"`) |
| H-13 | Several resolvers turn a role into a person or an address | `notifyAdmins` roles (`_lib/notifications.js:34`), `resolveInternalRecipients` (`_lib/internal-recipients.js:127`), customer routing `resolveRecipients` (`_lib/comms-routing.js:49`), `resolveAssignee` (`_lib/assignee.js:15`). #623 adds `alertRecipientsForRoles`. #624 adds a notice per person | One resolver for staff, one for customer contacts |
| H-14 | Several send rails, some of which reported "sent" with nothing sent | `sendCommunication` (`_lib/comms-send.js:106`), direct `sendEmail` (`_lib/mailer.js:130`), `whatsapp/send.js`, voice outbound, prospecting's marketing send, the dispatch register auto-send. #623 (open) fixes the Teams and WhatsApp false successes | One send rail that reports only what the provider confirmed (O-3 constraint 9) |
| H-15 | Two inbound email paths | The current path: `inbound/email/webhook.js` writes `inbound_emails` with message-id and 7-day hash dedup (`_lib/inbound-email.js`), then parse and draft_orders run in the tick. A legacy path: `/email/inbound` (`router.js:1030`, `email/inbound.js`) authenticates with one global token, classifies by regex and inserts a DRAFT order at once (`email/inbound.js:196`). It never writes `inbound_emails`, so the dedup does not apply | Whether any provider still posts to the legacy path; retire it or route it through `inbound_emails` |

### 8.1 Defects already seen (seed for O-6)

Each was read in code on `main` at the base commit. None is fixed here.

| # | Defect | Evidence | Note |
|---|---|---|---|
| D-1 | A manual drain by one tenant's approver processes every tenant's rows | `agents/handle_replies.js:126-132`, `:181`; `voice/process_actions.js:99`, `:152` | Cross-tenant. Fix now, in its own PR |
| D-2 | A Tally or NetSuite push that gives up tells nobody | `tally/retry.js:50-60`; no `notifyAdmins` in `tally/retry.js` or `netsuite/retry.js` | The 15 connectors on `erp-runner.js` ring the bell (`:123`) |
| D-3 | The Tally retry drain has no claim, so two overlapping drains can replay one row | `tally/retry.js:124`; claim columns from 059 unused | Matters once a scheduler runs the tick |
| D-4 | Inventory alerts queue a voice call that nothing dials | `_lib/inventory/notifications.js:136`; no reader of queued `voice_calls` | |
| D-5 | The inventory exception fingerprint includes today's date, so one open problem gets a new row every day | `_lib/inventory/exceptions-detector.js:66`, `:77`, `:87` | |
| D-6 | Logistics and inventory alert emails are queued with no recipient | `_lib/logistics/notifications.js:192`; `_lib/inventory/notifications.js:113` | #623 fixes this |
| D-7 | Sibling findings from #631 and #632: PATCH accepts `result` on an APPROVED order; `FAILED_TALLY_IMPORT` has no move to DRAFT; a skipped retry is stored as `gave_up`; reconciler update errors are not checked | Session notes for #631 and #632 | Re-check at the base commit |

---

## 9. Decisions before the audit starts

| # | Decision | Options | Default |
|---|---|---|---|
| AD-1 | What is the baseline? | A) `main` only. B) `main` plus the open PRs as an overlay. C) `main` with the open stacks merged in a scratch branch | B. The baseline stays `main`; phase 6 shows each open PR's effect |
| AD-2 | May the audit ask for live read-only queries? | A) Yes, the section 6.4 list, run by the owner. B) No, code only | A. Without it, H-1 stays "not confirmed" and so does every "live" cell |
| AD-3 | How wide is "SO agent infrastructure"? | A) The SO path plus every shared mechanism, with non-Tally ERPs as one class. B) All 51 tick handlers one by one. C) The SO path only | A |
| AD-4 | How far may the target model go? | A) Consolidate in place: shared primitives under the existing tables. B) A new core (one work and action spine) that the old mechanisms move onto. C) The audit compares A and B and recommends | C |
| AD-5 | Does the email accountability stack wait for the audit? | A) EA-1 and EA-2 (mail sync) may merge; EA-3 and later (`work_items`, migration 252) wait for O-3. B) Nothing waits. C) The whole stack waits | A. EA-3 fixes the shape of `work_items`, and H-6 asks whether that shape serves the order path too |
| AD-6 | Does #566 (the tick scheduler) wait for the audit? | A) No: it defaults to extraction jobs only, and the audit needs to know whether the tick runs. B) Yes | A |
| AD-7 | What does the audit deliver? | A) One docs file and one docs-only PR. B) Also a shared artifact page | A |
| AD-8 | What is the time box? | A) Three working sessions. B) One session, phase 1 and the inventory only | A |

---

## 10. Not covered by this plan

- The audit itself. This plan names mechanisms and verified that each one
  exists. It did not answer Q2 to Q18 for any of them.
- Live state. No production data was read.
- The open PRs were read from their descriptions and file lists. Only the
  bodies of #566 and #623 and the plan file of #634 were read in full. The
  diffs of #637 and #640 were scanned for tables and schedulers only.
- Screens. The plan names a screen only where a prior document did.
