# GenAI for Manufacturing — Anvil's Agentic Copilot

**Status:** Design / parked (not yet scheduled). This is the product‑management pathway and the north‑star user story. Implementation follows once a phase is greenlit.
**Author:** drafted with Claude Code, grounded in a code audit of the live repo (Jul 2026).
**Related:** [DEFERRED_ROADMAP.md](DEFERRED_ROADMAP.md), [COMPETITIVE_REVIEW_2026-07.md](COMPETITIVE_REVIEW_2026-07.md), [ANVIL_MCP_SO_TOOLS_DESIGN.md](ANVIL_MCP_SO_TOOLS_DESIGN.md), [LOGISTICS_OPS_DESIGN.md](LOGISTICS_OPS_DESIGN.md). Tracked as GitHub epic **#297** (this copilot) and issue **#296** (PDM / drawing extraction, which feeds it).

---

## 0. TL;DR

> **One trusted layer between a manufacturing SME and everything Anvil knows about their business — ask in plain language, get a governed, auditable answer (the number, how it was computed, and a chart), and let it propose the next action, one click, RBAC‑gated and fully audited.**

Wren AI ([getwren.ai](https://getwren.ai)) proves the "Agentic GenBI" half: NL → governed answer → SQL shown → chart, with a semantic layer so everyone gets the *same* trusted number. Anvil already ships **~60–70 % of the agentic runtime** needed to do that *and go further* — because Anvil is not a read‑only warehouse, it is the **system of record and the system of action** for an industrial supplier. It already ingests the operational graph (POs, BOMs, spares, quotes, inventory, forecasts, AR/AP, service, suppliers) and already has a tool‑using LLM loop with a human‑in‑the‑loop **propose → confirm → execute** safe‑action path.

The wedge is therefore **not** "build a copilot from scratch." It is: **(1)** add the one thing Wren has that Anvil lacks — a **governed semantic / metric layer** so analytical answers are consistent and auditable; **(2)** **fuse** the existing fragments (`erp_chat`, `kb/ask`, `copilot/proposals`, the autonomous `agents` engine, MCP) into **one conversational front door** per persona; **(3)** widen the tool registry to cover all nine domains; **(4)** add the few missing computations (DPMO/six‑sigma, churn, scenario forecasting, labour/machine capacity). Read **and** act. That read‑plus‑act, in a manufacturing vertical, is the moat a horizontal GenBI tool cannot copy.

---

## 1. Why now — the wedge

- **The buyer has no data team.** Anvil's customers are Indian industrial SMEs. Their data lives in Tally, Excel, WhatsApp and paper. They will never write SQL or stand up a warehouse — but they *will* ask "which customers are slipping and what's it costing me?" in plain language.
- **Anvil already normalized the graph.** Unlike a horizontal BI tool that must first connect and model a warehouse, Anvil already owns clean, tenant‑scoped operational tables. The "connect your data" step — the hardest part of GenBI adoption — is already done.
- **Anvil already has the action surface.** It can create a quote, push a Tally voucher, RFQ a supplier, reorder a spare, chase AR. GenBI answers a question; **GenOps** takes the next step. Only a system of action can do the second half.
- **The runtime is largely built** (see §3). What's missing is trust‑grade analytics (the semantic layer) and productization, not plumbing.
- **Frontier models make it viable now** — reliable tool‑use, multi‑step planning, and structured output at SME‑affordable cost via the existing model‑tiering/caching path.

---

## 2. What we're copying, and where we diverge (Wren AI teardown)

| Wren AI concept | What it is | Anvil adaptation | Build state |
|---|---|---|---|
| **Semantic / modeling layer** | Metrics + entities defined once so answers are consistent | **Anvil Metric Catalog** — governed, versioned, tenant‑scoped metric + entity definitions ("on‑time delivery", "gross margin", "spare fill rate", "DPMO") | **MISSING — the core new build** |
| **Governed answer: number + SQL + chart** | Every answer shows the query behind it and a chart; auditable | Answers show the **metric + the resolved query + provenance ("computed from X as of Y") + a chart**, tenant‑scoped by RLS | Partial (answers today cite the *tool/table*, not a governed metric or chart) |
| **Agentic project** (plan multi‑step; Knowledge; Skills; Memories; GenBI Apps) | Agent plans across steps, learns team context, runs saved procedures, remembers prefs, builds mini‑apps | **Anvil Copilot**: plan across domains; **Knowledge** = tenant context Anvil already learns (customer terms, format templates, learned corrections); **Skills** = saved playbooks; **Memories** = the existing RLHF/learning loop; **Apps** = saved views / cockpit widgets | Fragments exist; not fused |
| **Classic project** (guided Q&A + dashboards + curated Q‑SQL pairs) | Traditional BI workflow | **"Guided" mode** for non‑technical owners — curated question chips over the cockpit | Cockpit exists (`sales-ops.tsx`); no NL layer |
| **Trust / auditability** | Same answer for C‑suite and engineers | Inherit Anvil RLS + RBAC + `audit_events` + `model_routing_log`; abstain when not modelable | **Strong — inherited for free** |
| — (Wren is read‑only) | — | **GenOps: read *and* act** via the existing propose → confirm → execute loop | **Anvil‑only differentiator** |

**Where a vertical, action‑capable copilot beats horizontal read‑only GenBI:**
1. **Vertical ontology** — it already speaks BOM, spare, gun/asset, quote, AR aging, DPMO. No modelling from a blank warehouse.
2. **System of action (GenOps)** — it can *do* the next step, not just chart the problem.
3. **India‑first** — Tally, GSTIN/e‑invoice, WhatsApp/voice, offline SMEs. Baked in, not a plugin.
4. **Governed by construction** — multi‑tenant RLS + RBAC + audit are already the platform's spine.

**Anti‑patterns to avoid (Wren gets these right, and so must we):**
- **Raw text‑to‑SQL over a ~170‑migration schema** → hallucinated joins and wrong numbers. Answers must resolve against the **Metric Catalog**, not arbitrary tables.
- **Ungoverned metrics** → two screens, two definitions of "margin." Define once, reuse everywhere.
- **Silent tenant leakage** → every tool call goes through `resolveContext` + tenant‑scoped queries; never trust a model‑supplied tenant id.
- **Overselling autonomy** → default to propose‑and‑confirm; the model augments judgment, it doesn't replace it.

---

## 3. What Anvil already has (the ~60–70 % that's built)

Grounded in a code audit — this is the substrate the copilot is *assembled from*, not rebuilt.

- **Tool‑use agent loops** — `src/api/erp_chat/send.js` (sessions persisted to `erp_chat_sessions`/`erp_chat_messages`, `MAX_LOOPS=5`) and `src/api/kb/ask.js` (inside‑sales Q&A) both run an Anthropic tool‑use loop over one shared registry.
- **The tool registry (the crown jewel)** — `src/api/_lib/erp-chat-tools.js`: ~14 scoped tools. **Read:** `search_orders`, `search_invoices`, `search_customers`, ERP mirrors (`search_netsuite/sap/d365/acu_sales_orders`), `search_inventory` (4‑ERP union), `open_invoices_aging` (AR buckets), `get_quote_status`, `summarize_open_pipeline`, `customer_history`, `last_purchase_price`, `catalog_lookup`. **Write (propose‑only):** `create_lead`, `draft_and_send_comms`. The model never sees SQL — it picks a tool + args; the server runs a known tenant‑scoped query.
- **Human‑in‑the‑loop safe‑action loop** — `_lib/action-proposals.js` + `copilot/proposals.js` + `copilot/confirm.js`: a `write.*` tool calls `createProposal()` → `action_proposals` row (preview + single‑use `confirm_token`, 15‑min TTL). An **approver** calls `/api/copilot/confirm`, which atomically consumes the token (tenant‑ + user‑bound; replay → 409, wrong user → 403, expired → 410, cross‑tenant → 404) **before** executing, then audits `copilot_action_executed`. Today `executeAction()` binds exactly two actions — the switch is meant to grow.
- **External access via MCP** — `_lib/mcp.js` + `mcp/server.js`: compliant JSON‑RPC MCP server exposing the same registry to Claude Desktop / ChatGPT with sha256 scoped tokens (default‑deny on `write.*`) and `mcp_call_log` audit.
- **Autonomous agent engine** — `agents/run.js` (hourly cron) over `agent_goals` → `agent_steps`, with **16 goal handlers** (`quote_accept`, `ar_collect`, `expiring_quote_nudge`, `replenishment_suggestion`, `amc_renewal_chase`, …). Can send email (via `communications` queue), place compliance‑gated voice calls, escalate. **Note: this engine acts *without* per‑action confirm — a different trust model the copilot must reconcile (see §8).**
- **Production LLM plumbing** — `_lib/anthropic.js` (`callAnthropic`: prompt‑injection firewall, PII redaction, model tiering, prompt caching, confidence fallback, `model_routing_log` telemetry, retry) and `_lib/llm.js` (`callLLM`: per‑tenant/per‑feature Claude↔Gemini routing). The copilot inherits safety + cost controls by routing through these.
- **Per‑domain LLM scorers** — `customers/health_score.js` (`ai_health_score`/band), `sales/score_lead.js` (`ai_score`), `sales/predict_opportunity.js` (`ai_probability`). Structured output already; just not yet copilot‑callable.
- **Governed model + eval loop** — DocAI extraction learning loop (`learned_corrections`, prompt‑versions, golden set, DPMO/sigma on the extraction eval), `rlhf/feedback.js` (thumbs + corrections), `eval/agent_eval.js` (drift scoring). A day‑1 quality harness for copilot answers.
- **RBAC + audit spine** — `_lib/auth.js` `requirePermission(read/write/approve/admin)`, `recordAudit`/`recordEvent`, `audit_events`, `model_routing_log`, `mcp_call_log`. Every new copilot endpoint inherits authz + a full trail.

---

## 4. The gap (what's actually missing)

1. **No governed semantic / metric layer.** Analytics today are *fixed‑shape* endpoints (`analytics/funnel.js`, `winloss.js`, `ops_kpis.js`) and pre‑baked snapshots. There is **no NL→metric resolver** and **no place metrics are defined once**. This is Wren's core and Anvil's #1 build.
2. **No unified conversational UI.** `agents.tsx` is a goals console; `studio.tsx` is DocAI profile CRUD; `erp_chat` exposes session APIs but there is **no streaming chat screen** that renders citations + inline propose→confirm cards. The fragments are siblings, not one orchestrator.
3. **Thin tool + action coverage.** ~14 tools cover orders/invoices/customers/inventory/pipeline; **forecasts, opportunities, analytics, service/AMC/CAR, spares, procurement plans, anomalies have tables + endpoints but no tool.** Only 2 write actions are wired.
4. **A few missing computations.** No DPMO/six‑sigma/Cp‑Cpk/SPC/FMEA math (quality is free‑text CAR + anomaly flags); no churn/renewal‑risk model beyond a health band; no scenario/what‑if or ML sales forecast; only *material* capacity (no labour/machine/shop‑floor scheduling); no support ticket/SLA/CSAT model.

---

## 5. The user & the jobs‑to‑be‑done

One copilot, persona‑default lenses:

| Persona | Core job ("as X, I want to…") | Primary domains |
|---|---|---|
| **Owner / MD (SME)** | know how the business is doing and **what needs my attention today** | analytics, all |
| **Sales head** | see pipeline health, quote win‑rate, at‑risk accounts, and act | GTM, forecasting, CS |
| **Plant / ops manager** | plan capacity, clear inventory exceptions, hit spare fill | resource planning, continuous improvement |
| **Procurement** | know what to reorder and how suppliers are performing | forecasting→procurement, logistics |
| **Finance** | AR/AP status, cashflow, TDS, Tally reconciliation | analytics, AR |
| **Customer success / support** | order status, ETAs, complaints, renewals | CS, support |

The same governed answers and the same confirm‑gated actions — the persona only changes the default home briefing and the enabled action set (via RBAC).

---

## 6. The north‑star user story (the one to nail)

> **As an SME owner, I ask Anvil: "Which customers are slipping, and what's it costing me?"**
>
> Anvil returns the **at‑risk accounts** — computed from a *governed* churn/late‑delivery metric (it shows the number, the resolved query, and "as of today"), rendered as a ranked chart. It **explains why** each is at risk (late shipments, price disputes, overdue AR — each a drill‑down to the underlying orders/invoices). Then it **proposes three next actions**, each a one‑click, RBAC‑gated, audited card in the thread:
> 1. *Expedite these 4 open SOs* (→ delivery‑ETA follow‑ups / arm a goal)
> 2. *Send these 2 payment reminders* (→ `draft_and_send_comms`, approver‑confirmed)
> 3. *Flag this quote for re‑pricing* (→ quote status change, confirmed)
>
> The owner confirms #2, cancels #1, edits #3. Every answer is traceable; every action is logged.

This single story exercises the whole product: **NL question → governed multi‑domain answer → explanation with provenance → proposed actions → confirm/cancel → audit.** If we can ship *this* end‑to‑end for one metric and two actions, we've proven the platform. Everything after is breadth.

---

## 7. Capability map — the nine domains

Readiness legend: 🟢 data‑backed & copilot‑ready (wire tools) · 🟡 partial (needs one computation/model) · 🔴 needs new data/compute.

| # | Domain | Anvil today (grounded) | Copilot move | Readiness |
|---|---|---|---|---|
| 4 | **GTM / Sales** | `leads`, `opportunities`, `quotes`, `orders`, cockpit, DocAI PO intake; `summarize_open_pipeline`, `get_quote_status`; `score_lead`/`predict_opportunity` scorers | add opportunity/lead read tools + next‑best‑action; expose scorers as tools | 🟢 |
| 5 | **Forecasting** | *two* engines — sales (`forecast_snapshots`, weighted pipeline) + demand (`demand_forecasts`, conformal intervals, `forecast_runs`) | forecast tools + **scenario/what‑if** simulation | 🟢 (scenario 🟡) |
| 6 | **Business analytics** | `analytics_funnel_daily`, `analytics_winloss_daily`, `ops_kpis` (live AR aging + cycle‑time), `sales_history` price bands | **Metric Catalog + NL→metric tool** (the core build) | 🟢 data / 🔴 semantic layer |
| 1 | **Resource / capacity planning** | `inventory_positions`, `procurement_plans` (EOQ/coverage/RL), `inventory_exceptions`, supplier lead‑times; weekly planner cron | expose plan/exception tools + "reorder" action | 🟢 *material*; 🔴 labour/machine/shop‑floor scheduling |
| 3 | **Customer success** | `contracts`, `amc_schedules`→`service_visits`, `installed_base`, `equipment_hierarchy`, `recommended_spares`, `ai_health_score`; renewal/visit agents | expose health + AMC/renewal tools; **churn‑risk model** | 🟡 (needs churn model) |
| 2 | **Customer support** | rich channels (`inbound_emails`, WhatsApp, voice w/ consent+DND, `communications`, portal) + `erp_chat` | **new ticket/case/SLA/CSAT model**, then support copilot | 🔴 (no case model — confirmed absent) |
| 7 | **Continuous improvement / quality** | `car_reports` (5‑Why), `anomaly/compute.js` (18‑rule robust‑z), extraction eval + DPMO on *extraction*, `supplier_scorecards` | **DPMO/six‑sigma/Cp‑Cpk/SPC over CAR+anomaly**, then quality copilot | 🟡 (data present, math absent) |
| 8 | **New business models** | template marketplace, TReDS discounting, BRSR/ESG cascade, network sourcing — data present, isolated silos | expose as tools once core lands; monetization analytics | 🔴 (siloed, low priority) |
| 9 | **New customers & growth** | `prospecting_*` (SendGrid + ZoomInfo/Apollo hooks, likely stubbed), `score_lead`, customer dedup/golden‑record | ICP/intent model + growth analytics; wire `create_lead` propose‑path | 🟡 (enrichment stubbed) |

**The pattern:** for five domains the gap is *tool wiring, not data*. That's where P0–P2 win fast.

---

## 8. Architecture — built on the existing substrate

```
                 ┌──────────────────────────────────────────────┐
   "ask Anvil"→  │  Copilot orchestrator (new: fuses erp_chat +  │
   (one thread)  │  kb + agents; streaming; per-persona home)    │
                 └───────────────┬──────────────────────────────┘
                                 │ callAnthropic / callLLM (firewall, PII, tiering, telemetry) ✅ exists
                 ┌───────────────┴──────────────┬─────────────────────────┐
        READ tools                       METRIC tool (new)          WRITE tools (propose-only)
   erp-chat-tools.js ✅            resolve NL → Metric Catalog     createProposal() ✅
   (+ forecasts, analytics,       (governed; number+query+chart)   → action_proposals
    opportunities, CAR, spares…)          │                        → /api/copilot/confirm ✅
                 └───────────────┬─────────┴──────────────┬─────────────────┘
                    tenant-scoped queries (RLS ✅)   approver-confirmed execute + audit ✅
                                 │                          │
                     provenance: "computed from X    long-running follow-through →
                      as of Y" + drill-down            arm an agent goal ✅ (agents/run.js)
```

**Key design decisions:**
- **Metric Catalog is the trust boundary.** A new `metric_catalog` (tenant‑scoped, versioned): each metric declares its name, definition, the governed query/aggregation, dimensions, unit, and owner. The NL→metric tool resolves a question to a *catalog entry*, never free‑form SQL. Seed it from the existing fixed‑shape analytics (`ops_kpis`, funnel, win‑loss) so P0 reuses proven math. This is the single most important new artifact.
- **Answer contract:** every analytical answer returns `{ value, metric_id, resolved_query, as_of, chart_spec, provenance, drill_down }`. Non‑modelable question → **abstain** ("I can't compute that from your governed metrics yet") rather than guess.
- **Reuse the safe‑action loop verbatim.** Each new action = one `createProposal` call + one `executeAction` branch. Grow the switch (create quote, update order status, adjust price, reorder spare, push Tally) incrementally, each behind an RBAC scope.
- **Reconcile the two trust models.** Copilot chat = **propose‑by‑default** (approver confirms). Long‑running or recurring follow‑through = **arm an agent goal** (the autonomous engine already exists). A per‑tenant *autonomy* setting decides when the copilot may arm a goal vs. must propose. Never let a chat turn silently execute a write.
- **Evaluation from day one.** Add a `copilot` surface to `rlhf_feedback`; score answer/action quality with the `agent_eval` drift harness. Wren‑style "same trusted answer" is only credible if regressions are caught.
- **MCP is free distribution.** The moment a tool exists in `erp-chat-tools.js` it is also reachable (scope‑gated) from Claude Desktop/ChatGPT via the existing MCP server — the copilot ships to external assistants with zero extra backend.

---

## 9. The pathway (phased)

Each phase is independently shippable and de‑risks the next. Sizes are rough.

- **P0 — Metric Catalog + "Ask Anvil" (read, governed).** Build `metric_catalog` + the NL→metric tool over **8–12 seeded metrics** (revenue, on‑time delivery, quote win‑rate, AR aging, inventory exceptions, spare fill). Ship a **streaming chat screen** that renders number + resolved query + chart + provenance, tenant‑scoped. One domain, maximal trust. *This is the keystone; everything else composes onto it.*
- **P1 — Breadth via tool wiring.** Expose the already‑built domain endpoints as tools (forecasts, opportunities, analytics snapshots, procurement plans/exceptions, service/AMC/CAR, spares, supplier scorecards) + the three LLM scorers. Multi‑domain planning. Add **Knowledge/Memories** reuse (learned corrections, RLHF) so answers improve per tenant.
- **P2 — GenOps (read → act).** Wire the north‑star's three actions through the existing propose→confirm loop; move the confirm affordance **inline** into the chat as cards. Grow `executeAction` (create quote, order status, reorder, payment reminder). This is the differentiator turned on.
- **P3 — Proactive briefings + Skills/Apps.** Per‑persona home: *"3 things need you today"* (compose metrics + anomaly flags + agent suggestions). **Skills** = saved playbooks ("month‑end AR sweep"); **Apps** = saved views. Optional per‑tenant autonomy → arm goals.
- **P4 — Fill the compute gaps.** DPMO/six‑sigma over CAR+anomaly (continuous improvement); churn/renewal‑risk model (CS); scenario/what‑if forecasting; then support ticket/SLA model. Each unlocks its domain's copilot.
- **P5 — Growth & new business models.** ICP/intent + prospecting enrichment; expose marketplace/TReDS/BRSR as tools; monetization analytics; strategic "explore a new business model" prompts grounded in the tenant's own data + the moat theses (forecast→procurement, India inbound front‑door, BRSR cascade).

**Sequencing rationale:** P0 builds the trust foundation the whole product needs; P1 is cheap breadth (wiring, not building); P2 lights up the moat; P3 makes it *sticky* (proactive, not just reactive); P4/P5 are depth once the loop is proven.

---

## 10. Governance, trust & honesty guardrails

- **Governed‑only answers.** Analytical answers resolve to Metric Catalog entries; abstain otherwise. No raw text‑to‑SQL free‑for‑all.
- **Tenant isolation is absolute.** Every tool call → `resolveContext` + tenant‑scoped query under RLS. A model‑supplied tenant id is never trusted.
- **RBAC on every read and write.** `requirePermission`; writes are approver‑gated; the MCP surface is default‑deny on `write.*`.
- **Everything auditable.** `model_routing_log` (every model call), `audit_events` (every action), `mcp_call_log` (every external call), `action_proposals` (every proposed write, with single‑use tokens).
- **Confirm before act.** Default propose‑and‑confirm; autonomy is opt‑in per tenant and always logged.
- **Honesty.** Show assumptions and "as of" timestamps; say when a number is an estimate; never fabricate a metric. The copilot augments judgment — it does not replace the operator, and it never hides how it got a number.
- **PII / IP boundary.** Inherit the DocAI firewall + PII redaction; respect the part‑drawing `internal`‑only boundary (issue #296) — supplier‑only data is never surfaced to a customer‑facing persona.

---

## 11. Success metrics

- **Adoption:** weekly active askers / tenant; questions per active user.
- **Trust:** % questions answered from the catalog (vs abstained); answer thumbs‑up rate (RLHF); # of "show me the query" expansions (a good sign, not a bad one).
- **Action:** proposal → confirm acceptance rate; actions executed per week; time saved per action.
- **Quality:** copilot answer drift score (agent_eval); zero cross‑tenant incidents (hard gate).
- **Business:** attach to a north‑star outcome — e.g. AR days reduced, quote cycle‑time reduced, stockouts avoided — measured against the tenant's own governed metrics.

---

## 12. Relationship to the existing backlog & moats

This copilot is the **front door** that surfaces work already underway:
- **Forecast → procurement vision** — becomes "ask what to preorder, then confirm the plan."
- **System of action** (issues/tasks for `propose_erp_push`, checklist UI, CUA driver) — becomes the copilot's action set.
- **DocAI extraction learning loop + golden set** — the pattern (governed, improving) the copilot's eval reuses.
- **DPMO/six‑sigma** (already on the *extraction* pipeline) — generalized to shop‑floor quality in P4.
- **PDM / drawing extraction** (issue #296) — feeds the spare/manufacture answers ("which assembly is this spare in, and how is it made?").
- **Competitive moats** (forecast→BOM preorder, India inbound front‑door, BRSR cascade) — P5 turns these into copilot‑surfaced growth prompts.

---

## 13. Open questions & risks

- **Metric Catalog authoring** — who curates metrics per tenant? Ship a seeded default set + an admin editor; treat it like the DocAI template/profile studio.
- **Autonomy boundary** — where exactly is propose‑and‑confirm mandatory vs. arm‑a‑goal acceptable? Needs a per‑tenant policy + an audit review.
- **Cost at SME price points** — lean on the existing model‑tiering + prompt caching; measure tokens/answer; cap loops.
- **"Same trusted answer" is a promise** — it only holds if the catalog is the single source of metric truth *and* screens migrate to read from it too (avoid the two‑definitions‑of‑margin trap).
- **Don't boil the ocean** — the temptation is to wire all nine domains at once. P0's one‑metric, two‑action slice is the discipline that makes this real instead of a demo.

---

*Parked design doc. Pick up at P0 (Metric Catalog + Ask‑Anvil) when scheduled; the runtime it composes onto already exists in `src/api/_lib/erp-chat-tools.js`, `src/api/copilot/*`, `src/api/_lib/anthropic.js`, and `src/api/agents/*`.*
