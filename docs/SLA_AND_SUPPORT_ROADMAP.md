# SLA Engine + Customer Support — Feature Roadmap (PARKED)

Status: **Parked roadmap** (2026-06-25). Design only — no code. Large module;
build in phases after the lead→opp→quote→PO core + RFQ capture are solid.

Two intertwined modules:
- **A. SLA engine** — per-team/function timers (internal) + external (vendor)
  SLAs, with breach detection, nudges, and attainment analytics.
- **B. Customer Support** — issues → responses → actions (CAR, warranty
  claim, FOC internal order / stock consumption, support stock reorder), each
  governed by SLAs from module A.

## Reuse what exists (don't rebuild the timer)

| Need | Existing asset |
|---|---|
| Deadline-driven nudges/escalation | `agent_goals` (migrations 011/078) + `src/api/agents/**` handlers (quote_accept, supplier_ack_followup, ar_collect, missing_doc, replenishment_suggestion) |
| Stage timing / cycle-time | `processing_events`, `analytics_funnel_daily`, `opportunity_stage_events` |
| Breach detection pattern | `delays/scan` (flags overdue POs/work orders by severity) |
| Business-hours / working days | admin `holidays` + lead-times |
| CAR reports | `screens/car.tsx` + car table |
| Service / preventive | service-visits, AMC schedule |
| Internal / FOC orders | `src/api/sales/internal_so.js` |
| Stock + reorder | inventory positions/net-req/safety-stock/exceptions, `portal/reorder.js`, replenishment_suggestion agent |
| Breach surfacing | My Day, exceptions inbox, anomaly |

The SLA engine is essentially: **a policy table + a clock table + start/stop
event hooks + a breach cron that arms `agent_goals` and raises exceptions.**

## SLA matrix — what to measure (start → stop, default target, breach action)

Targets are defaults (tenant-tunable, business-hours via `holidays`).

### Internal — Sales / Quote
| Function | Metric | Start event | Stop event | Default | Owner | On breach |
|---|---|---|---|---|---|---|
| Sales | Lead response | lead created | first contact logged | 4 bus-hrs | sales_engineer | nudge → escalate to manager |
| Sales | Lead qualification | lead created | opp created (or disqualified) | 2 bus-days | sales_engineer | nudge |
| Quote preparation | Quote draft ready | quote requested / opp won | quote DRAFT lines+composition ready | 1 bus-day | quote team | nudge → manager |
| Quote submission | Quote sent | quote APPROVED | quote SENT to customer | 4 bus-hrs | sales_manager | nudge |
| Response to (customer) RFQ | First response | inbound RFQ email/PO classified | first reply / quote sent | 1 bus-day | sales | nudge → escalate |
| Order processing | SO acknowledged | PO received (draft order) | SO confirmed + ack sent | 1 bus-day | sales ops | nudge |

### External — Vendor (track + chase, not enforce)
| Function | Metric | Start | Stop | Default | On breach |
|---|---|---|---|---|---|
| RFQ → vendor quote | Vendor response | supplier RFQ sent | supplier_quote captured | 3 cal-days | reminder email (supplier_ack_followup pattern) |
| PO acknowledgement | Vendor ack | source PO sent | ack received | 2 cal-days | reminder |
| Vendor delivery | On-time delivery | PO confirmed | goods received | per `default_lead_time_days` | flag delay (delays/scan) |

### Customer Support
| Function | Metric | Start | Stop | Default (by severity) | On breach |
|---|---|---|---|---|---|
| Issue acknowledgement | First response | case opened | first response logged | P1 2h / P2 8h / P3 1d | nudge → escalate |
| Issue resolution | Time to resolve | case opened | case resolved/closed | P1 1d / P2 3d / P3 7d | escalate |
| CAR | Corrective action cycle | complaint → CAR raised | CAR closed (root cause + action verified) | 14 cal-days (8D-style stages) | nudge per stage |
| Warranty claim | Claim turnaround | claim raised | decision + replacement dispatched | 7 cal-days | escalate |
| FOC internal order | Fulfilment | support action → FOC SO created | FOC SO shipped | 3 bus-days | nudge |
| Support stock reorder | Replenishment | support stock consumed below reorder point | reorder PO raised | same day (auto) | auto-raise via replenishment agent |

## Data model sketch

**SLA engine**
- `sla_policies` (tenant, function_key, metric_key, scope/applies_to, severity, target_minutes, business_hours bool, owner_role, escalate_role, active).
- `sla_clocks` (tenant, policy_id, subject_type, subject_id, started_at, due_at, paused_total, stopped_at, status: running|met|breached|paused, breach_at). Start/stop driven by event hooks on the source records; a cron flips `breached`, arms an `agent_goal`, and raises an exception.

**Customer Support**
- `support_cases` (tenant, customer_id, customer_contact_id, channel, type: issue|complaint|warranty|query, severity, status, opened_at, closed_at, owner, sla_policy refs).
- `support_case_events` (case_id, kind: response|status_change|note|comms, actor, at) — the timeline + SLA stop signals.
- `support_case_actions` (case_id, kind: car|warranty_claim|foc_order|stock_consumption|reorder, ref_table, ref_id, status) — links to the existing `car`, `internal_so`, inventory consumption, and reorder records rather than duplicating them.

## Phases (each a shippable PR + migration + gates)

- **P1 — SLA engine core.** `sla_policies` + `sla_clocks`, start/stop hooks on
  the highest-value events (quote sent, RFQ→vendor, PO ack), breach cron
  (reuse delays/agent_goals), admin policy editor, "SLA" dashboard + breaches
  in My Day. Ships value immediately on flows that already exist.
- **P2 — Customer Support core.** `support_cases` + events + responses; wire
  ack + resolution SLAs. Inbound support email → case (rides the email rail).
- **P3 — Support actions.** Link/raise CAR, warranty claim, FOC internal order
  (reuse internal_so), record stock consumption — each as a `case_action`.
- **P4 — Support stock reorder.** Tie support consumption into inventory net-
  req so consumed support stock auto-triggers replenishment (existing agent).
- **P5 — SLA analytics.** Per-team attainment %, breach trends, cycle-time;
  feed the Sales-Ops cockpit + a manager view.

## Guard rails / philosophy
- **Track-and-nudge, don't block.** SLAs raise visibility + escalation; they
  never gate the work (consistent with the no-bottleneck principle).
- **External SLAs are advisory** — chase vendors, flag delays; never enforce.
- **Auto-derive clocks** from events the system already emits (zero data
  entry) rather than manual timers.
- Business-hours via `holidays`; targets tenant-tunable per severity.

Related: [[project-supplier-rfq-flow]] (vendor SLA source events),
[[backlog-parked-prs]] (sequencing), the zero-data-entry roadmap (auto-derive
clocks), and the Outlook plan (inbound support email → case).
