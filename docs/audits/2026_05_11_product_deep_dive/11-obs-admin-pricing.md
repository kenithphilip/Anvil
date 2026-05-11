# A11 Deep-Dive v2: Observability, Admin Tools, Pricing, Metering, SLOs, Incident Response

**Agent:** A11 sequential re-run (prior parallel attempt hit usage limits).
**Scope:** observability (logs, metrics, traces), admin lifecycle, RBAC, billing meter, three-tier pricing proposal, status page, SLO targets, alerting, incident response, cron health.
**Repo state audited:** main @ `c4f946b` (read-only from `/Users/kenith.philip/anvil/`, never from worktree).
**Date:** 2026-05-11.
**Tagging convention used below:** `[verified-on-main]` (read directly from a file path on the main branch), `[verified-from-fetch]` (WebFetch return value), `[verified-from-prior-knowledge]` (WebFetch denied by harness, citing source URL inline), `[inferred]` (derived but not directly stated).

WebFetch was denied across the board in this run, so external citations are tagged `[verified-from-prior-knowledge]` with the canonical source URL inline. Internal code references are file-and-line precise.

---

## TL;DR (one paragraph per dimension)

**What exists on main.** Anvil ships a working observability stack: `audit_events` plus a sentinel table `audit_failures` (migration 063), `processing_events` for per-case timeline with `duration_ms`, `model_routing_log` for Anthropic call cost telemetry, `cron_health` (migration 066) populated by a `recordCronHeartbeat` helper called from both `/api/cron/tick` (every 5 min, external cron-job.org) and `/api/cron/daily` (02:30 UTC, Vercel), `deploy_events` (migration 079) for SOC 2 CC8.1 change management evidence, `docai_daily_usage` (migration 093) for per-tenant per-adapter cost-guard counters, `tally_drift_billing_meter` (migration 097) for Bet 5 metered usage drained to Stripe Meters + Razorpay Subscription Add-ons, and a billing-outcomes meter (`src/api/_lib/outcomes.js`, 147 lines) that maps 96 audit verbs onto 12 billable outcomes with a USD-cents price card. There are 223 files writing to `audit_events` via `recordAudit()` and 23 writing to `processing_events` via `recordEvent()`. `[verified-on-main]`

**Admin surface.** `src/api/admin/` ships 16 endpoints: `access_requests`, `access_review`, `contracts`, `customer_locations`, `diagnostics`, `docai_settings`, `equipment`, `fx_rates`, `holidays`, `install_vertical_pack`, `inventory`, `item_master`, `lead_times`, `lost_reasons`, `members`, `notifications`, `quote_approvals`. RBAC enum has 7 roles (`viewer`, `sales_engineer`, `sales_manager`, `procurement`, `finance`, `operator`, `admin`) with a permission ladder (`read`/`write`/`approve`/`admin`) enforced in `src/api/_lib/auth.js:38-43`. Access review (`/api/admin/access_review`) writes SHA-256 signed snapshots into `access_reviews` for SOC 2 evidence. `[verified-on-main]`

**Pricing model.** `docs/PRICING_STRATEGY.md` lays out a three-tier model (Starter Rs 14,990, Growth Rs 49,990, Enterprise Rs 99,990+, with overage rates Rs 39 / Rs 19 / Rs 9 per SO). `docs/BILLING_OUTCOMES.md` cross-references the 12-outcome meter at default USD-cents prices. Stripe Connect + Razorpay are wired through `_lib/stripe-client.js` and `_lib/razorpay-client.js`. `[verified-on-main]`

**The gaps.** Despite the strong primitives, the observability layer is not yet wired into operator workflows. There are no SLO targets, no alert rules, no public status page, no cost-attribution loop on `model_routing_log` (tokens are recorded but USD is computed ad-hoc in `cost/breakdown.js` rather than at insert time), no per-tenant Anthropic spend cap that fires before $400-2000/day in burn lands, no outcomes-to-Stripe-Meter pipeline (only the Tally drift meter is drained), no annual pricing, no currency switcher for non-INR customers, no incident-response runbook in the repo. The pricing card uses Rs 39 / Rs 19 / Rs 9 per-SO overage but the outcomes meter publishes $0.50 per order processed; the two pricing views are not reconciled. `[verified-on-main]`, `[inferred]`

The 18 numbered findings below propose concrete fixes with implementation prompts, prices, and SLO targets.

---

## Section 1: Inventory of observability signals on main

Before the findings, a compressed catalog of what exists. Each row cites the file path and line where the signal is written or read.

| Signal | Writer | Reader | Cost telemetry? | SLO target on main? |
|---|---|---|---|---|
| `audit_events` | `_lib/audit.js:74` (`recordAudit`) | `api/audit/index.js`, `api/billing/usage.js` | No | No |
| `audit_failures` | `_lib/audit.js:28` (`recordSentinel`) | none in repo | n/a | No |
| `processing_events` | `_lib/audit.js:105` (`recordEvent`) | `api/events/index.js` | `duration_ms` recorded | No |
| `model_routing_log` | `_lib/anthropic.js:246` | `api/claude/messages.js?routing=1`, `api/kb/ask.js` | Tokens yes, USD no | No |
| `eval_runs` + `eval_case_results` | `api/eval/run.js` | `api/eval/dashboard.js` | n/a | No (target is the eval score) |
| `cron_health` | `_lib/cron-mux.js:144` (`recordCronHeartbeat`) | `api/health.js:107` (`probeCron`) | n/a | Stale window: 10 min for tick, 30h for daily |
| `deploy_events` | `api/deploys/index.js` | `api/deploys/index.js` GET | n/a | No |
| `docai_daily_usage` | migration 093 (cost-guard recordCall path) | dispatcher in `_lib/docai/` | Per-adapter call count + estimated_cost_usd | No (daily cap, not SLO) |
| `tally_drift_billing_meter` | `_lib/tally-reconciler.js` | `api/cron/drift-meter.js` -> Stripe + Razorpay | Yes (per-row Stripe meter event) | n/a |
| `validation_findings`, `extraction_runs` | docai pipeline | `api/documents/*` | n/a | No (drift target inferred) |

The shape is healthy: the data exists, the writers fan out broadly (audit verbs cover 11+ subsystems, see `_lib/outcomes.js:24-87`), the cron heartbeat fires on every sub-handler. What is missing is the synthesis layer: rules over these signals, public roll-ups, alert pipelines, and the bridge to per-tenant billing.

---

## F11.1 Cost telemetry is recorded but not closed-loop. P0.

### Problem

Every Anthropic call writes `model_routing_log` rows with `total_input_tokens` / `total_output_tokens` plus optional cache token columns, but the per-token USD math is duplicated in two places (`api/cost/breakdown.js:8-22` and `api/cost/simulator.js:8-21`) and there is no per-tenant daily USD cap that trips before a runaway Sonnet/Opus session lands a $400-2000/day bill. The `docai_daily_usage` table (migration 093) covers DocAI adapter calls, but Claude calls coming through `_lib/anthropic.js:246` do not pass through the cost-guard layer.

### Current state on main

- `src/api/cost/breakdown.js:8-22` defines `PRICING` for three Claude models and aggregates `api_usage` JSON from `orders` to compute total USD. `[verified-on-main]`
- `src/api/cost/simulator.js:8-21` defines a near-identical pricing table for `haiku/sonnet/opus` and produces scenario forecasts. `[verified-on-main]`
- `src/api/_lib/anthropic.js:246-258` inserts the `model_routing_log` row but does not compute USD or check a tenant cap before issuing the next call. `[verified-on-main]`
- `migrations/093_cost_optimized_adapters.sql` adds `docai_daily_limits` jsonb (`{"claude": 50, "reducto": 100, ...}`) and `docai_daily_usage`, but the cap applies to the docai dispatcher only. `[verified-on-main]`
- `src/api/admin/diagnostics.js:29` lists `model_routing_log` in `CRITICAL_TABLES` so row count appears in the diagnostics tab, but there is no USD aggregation. `[verified-on-main]`

### Competitor state

- Stripe Meters (https://docs.stripe.com/api/meters) supports a single price-per-event configuration with idempotent ingestion via `identifier`. Anvil already uses this for the Tally drift add-on (`_lib/stripe-client.js:64-77`). `[verified-from-prior-knowledge]`
- Lago (https://www.getlago.com/) offers per-tenant usage-budgets with prepay and an `alerts` API that fires webhooks at 50% / 75% / 100% thresholds. `[verified-from-prior-knowledge]`
- Helicone (https://helicone.ai) instruments Anthropic + OpenAI traffic at the proxy layer and exposes per-tenant per-model per-day USD with no code change beyond setting `OPENAI_BASE_URL`. `[verified-from-prior-knowledge]`
- Datadog APM cost attribution (https://docs.datadoghq.com/llm_observability/) ships an "LLM Observability" product that tags every span with model, tokens, USD computed from a model-pricing table, and offers anomaly detection on top. `[verified-from-prior-knowledge]`

### Adjacent insight

The cost-attribution loop is a pricing-conversation prerequisite. Once an Indian distributor sees "you spent $0.43 on this PO" on a per-order timeline, the Rs 39 / Rs 19 / Rs 9 overage feels reasonable. Without it, the CFO sees only the Stripe invoice and the conversion math is opaque. The unit-economics table in `docs/PRICING_STRATEGY.md:46-50` (Rs 2.40 token cost per SO) is fragile because it depends on token volumes the operator cannot inspect.

### Research insight

Anthropic 2026 pricing: Claude Haiku 4.5 ~$1/M in $5/M out, Claude Sonnet 4 $3/M in $15/M out, Claude Opus 4.7 ~$15/M in $75/M out (https://www.anthropic.com/pricing). `[verified-from-prior-knowledge]` Even a single misconfigured tenant running Opus against 18-line POs at 50k tokens input / 5k tokens output per order can hit $1.13 per order. At 500 SOs/day, that is $565/day. With no cap, the platform absorbs the bill at sign-off time. The `tally_drift_addon_billing_plan='trial'` path in `api/cron/drift-meter.js:71-86` is the only place that gates a paid feature on a per-tenant flag today.

### Proposed change

Add a `cost_status.js` module that runs as a middleware on every paid-adapter entry point. It reads `tenant_settings.daily_usd_budget` (new column), the running tally for the current UTC day from `model_routing_log` + `docai_daily_usage`, and short-circuits with R1-R9 rule outcomes:

- R1: cap not configured -> allow (record advisory only)
- R2: under 50% of cap -> allow
- R3: 50-75% -> allow + notify admin via `admin_notifications.kind='cost_threshold'`
- R4: 75-90% -> allow + notify + force-route through Haiku
- R5: 90-99% -> allow only Haiku
- R6: 100%+ -> block paid calls, return `{code:'COST_BUDGET_EXHAUSTED'}` with reset time
- R7: previous day was 90%+ -> raise the warning at 25% on the current day
- R8: tenant on `enterprise` plan -> caps are soft (log only, never block)
- R9: tenant in `trial` -> log only, with a UI banner

### User-facing behavior

A new "Spend" tab in Admin Center, Billing section, with a stacked bar by day, by model. A budget input. When threshold tripped, the SO intake page shows a banner: "AI budget at 78% for today; Sonnet replaced with Haiku to extend the day's budget. Adjust at Admin / Billing / Spend." Operators on Enterprise see the banner but no enforcement.

### Technical implementation

1. Migration `099_cost_status.sql` adds `tenant_settings.daily_usd_budget numeric(8,2)`, `monthly_usd_budget`, `cost_status_overrides jsonb`.
2. `_lib/cost-status.js` exports `assessTenantCost(tenantId, intentModel)` returning one of `R1..R9` plus `{allowed, replacement_model, reason}`.
3. `_lib/anthropic.js` calls `assessTenantCost` before the SDK call; respects `replacement_model`.
4. `_lib/docai/run.js` calls the same helper before paid adapters.
5. Cron `daily.js` writes a daily `cost_summaries` row per tenant with the model breakdown.
6. UI: `screens/admin.tsx` adds a "Spend" tab (new id `spend`) that calls `GET /api/admin/cost_status`.

### Integration plan

Land migration + helper behind a feature flag `COST_STATUS_ENABLED` defaulting off. Roll to one test tenant for 7 days. Once the daily roll-up matches manual SQL, flip the flag in production.

### Telemetry

`processing_events` rows with `event_type='cost_status_decision'` and `detail={rule, intent_model, replacement_model, daily_spend_usd}`. New audit verb `cost_budget_exhausted` for R6.

### Non-goals

- Predictive forecasting (the Datadog product does this; not worth the build).
- Per-call USD aggregation in real time (use the daily roll-up; per-call is too noisy).

### Open questions

- Is the budget a hard ceiling or a soft signal? Recommend: hard for Starter / Growth, soft for Enterprise.
- Day rollover at UTC midnight or IST midnight? Default IST since the buyer is Indian.

### Effort

M.

### 5-axis score

PSev 5 (silent cost bleed kills margin), MDiff 3 (additive, no breaking changes), TLev 4 (one helper, two integration points), EStr 4 (multi-quarter compounding savings), SFit 5 (clear product narrative). Total **21/25**.

### Deep-dive prompt for implementation

> Build `src/api/_lib/cost-status.js` with a single exported function `assessTenantCost(ctx, intent)` returning `{rule_id, allowed, replacement_model, reason, daily_spend_usd, daily_budget_usd}`. Wire it into `src/api/_lib/anthropic.js` before the SDK call and into `src/api/_lib/docai/run.js` before each paid adapter. Add migration `099_cost_status.sql` with the schema in F11.1. Add `screens/admin.tsx` Spend tab. Default the feature flag `COST_STATUS_ENABLED` to off. Write 8+ unit tests covering R1-R9 and the rollover edge case.

---

## F11.2 No SLO targets defined for any extraction or push flow. P0.

### Problem

`eval_runs` measures per-suite accuracy and the dashboard aggregates by suite + field (`api/eval/dashboard.js`), but nothing in the repo encodes "extraction accuracy must stay above 95% over a 7-day rolling window" or any equivalent. A regression that drops accuracy from 96% to 88% is visible only if an engineer opens the eval dashboard. Same for `processing_events.duration_ms`: recorded but never compared against a target.

### Current state on main

- `eval_runs` table aggregates accuracy scores per suite. No SLO target column. `[verified-on-main]`
- `processing_events.duration_ms` is recorded but never grouped into p50/p95. `[verified-on-main]`
- No `slo_targets` table. No alert pipeline. `[verified-on-main]`

### Competitor state

- Google SRE handbook (https://sre.google/sre-book/service-level-objectives/) defines SLOs as user-visible behaviors with explicit numeric targets and error budgets. `[verified-from-prior-knowledge]`
- Honeycomb's SLO product (https://www.honeycomb.io/blog) exposes burn-rate alerts (fast: 2% of budget in 1h, slow: 10% in 6h). `[verified-from-prior-knowledge]`
- Linear's status page (https://linear.app/status) publishes a rolling 30-day uptime number per surface (web app, API, search). `[verified-from-prior-knowledge]`

### Adjacent insight

Pricing tiers reference "99.0% / 99.5% / 99.9% uptime SLA" in `docs/PRICING_STRATEGY.md:144,161,178` but there is no measurement. Selling an SLA without a measurement table invites a credit dispute the first time a customer notices a 3-hour outage. The Enterprise BAA / DPA evidence package will also require the SLO definition.

### Research insight

Datadog and Honeycomb both treat SLOs as code: a YAML or JSON document with `objective`, `indicator_query`, `window`, `target`. Burn-rate alerts are derived, not configured separately. Anvil already has the data; what is missing is the SLO catalog and the burn-rate alerter.

### Proposed change

Land `migrations/099_slo_targets.sql` with:

```sql
create table slo_targets (
  id uuid primary key,
  name text not null,
  surface text not null,  -- 'extraction', 'tally_push', 'ingest', 'api'
  target_pct numeric(5,2) not null,
  window_days int not null,
  indicator_query text not null,  -- SQL fragment over audit_events / processing_events
  error_budget_remaining_pct numeric(5,2),
  last_evaluated_at timestamptz
);
```

Seed with 8 SLOs:

| Name | Surface | Target | Window | Indicator |
|---|---|---|---|---|
| Extraction accuracy | extraction | 95% | 7d | `eval_runs.score` median |
| Tally push success | tally_push | 99.0% | 30d | `audit_events action=tally_push success/total` |
| Ingest under 60s | ingest | 95% | 7d | `processing_events.duration_ms` p95 < 60000 |
| API availability | api | 99.5% | 30d | health checks ok / total |
| Cron freshness | cron | 99.9% | 30d | `cron_health.last_status='ok'` ratio |
| GSTN e-invoice success | invoice | 98% | 30d | `audit_events action=einvoice_generated success` |
| WhatsApp delivery | comms | 95% | 7d | `audit_events action=comm_send` with `detail.status='delivered'` |
| Drift reconciler closeout | reconciler | 95% | 30d | tally drift `resolved/detected` ratio |

Cron `daily.js` calls a new `evaluateSlos(svc)` step that joins the indicator query and writes the result to `slo_evaluations`. Burn-rate alert: fast burn at 2% of monthly budget in 1h, slow at 10% in 6h, emitted to `admin_notifications.kind='slo_burn'` and (if configured) to a Slack webhook.

### User-facing behavior

New `/admin/slos` tab showing each target with a current value, error budget remaining, and a 30-day sparkline. The public status page (see F11.3) reads the same table.

### Technical implementation

1. Migration with `slo_targets` + `slo_evaluations`.
2. `_lib/slo.js` exports `evaluateSlos(svc)` and per-target evaluators.
3. `cron/daily.js` calls `evaluateSlos` after analytics refresh.
4. `screens/admin.tsx` adds a "SLOs" tab.
5. Alert path: insert into `admin_notifications`; optionally POST to `tenant_settings.slo_alert_webhook`.

### Integration plan

Land the schema + 4 SLOs first (extraction accuracy, ingest p95, cron freshness, Tally push). Verify the daily-roll-up SQL on staging tenant data. Add the remaining 4. Add the burn-rate alerter last.

### Telemetry

`audit_events action=slo_burn_triggered` with `detail={slo_id, burn_rate, window, target}`. `processing_events event_type=slo_evaluated` per target per day.

### Non-goals

- Per-tenant SLOs (Anvil-wide for now; per-tenant once Enterprise commits >5).
- Multi-window burn-rate alerts (ship one window, observe, iterate).

### Open questions

- Should the public status page show the absolute SLO target or only "ok/degraded/down"? Recommend: per-surface ok/degraded with a tooltip showing the rolling number.

### Effort

L.

### 5-axis score

PSev 5 (SLO is the gating artifact for Enterprise), MDiff 3 (touches cron, schema, UI), TLev 4 (clean abstraction), EStr 5 (renewal lever), SFit 4. **21/25**.

### Deep-dive prompt

> Land migration 099 with `slo_targets` and `slo_evaluations`. Seed 8 SLOs from F11.2 table. Build `src/api/_lib/slo.js` with `evaluateSlos(svc)` calling per-target indicator queries. Hook into `cron/daily.js`. Add `screens/admin.tsx` SLOs tab. Add burn-rate alert path writing into `admin_notifications` with `kind='slo_burn'` and posting to optional `tenant_settings.slo_alert_webhook`.

---

## F11.3 No public status page. P1.

### Problem

`docs/CRONS.md:147-167` documents cron output inspection via cron-job.org's "Save responses" feature. There is no `/status` HTML page that an Indian distributor can bookmark to verify "is Anvil up before I open a support ticket". Buyers in 2026 expect a public status page, especially in the SOC-2 / B2B segment.

### Current state on main

- `api/health.js` returns a JSON blob with `db_ok`, `integrations[]`, `cron`, `runtime`. Used by the shell footer. `[verified-on-main]`
- No HTML `/status` route. The Vercel routes pass everything to `api/dispatch.js` or the SPA. `[verified-on-main]`
- The `cron` object in `health.js:131-136` has `tick_stale`, `daily_stale`, `any_stale`, `workers[]`. `[verified-on-main]`

### Competitor state

- Atlassian Statuspage (https://www.atlassian.com/software/statuspage) is the category leader; $29 / $99 / $399 / $1,499 per month tiers, supports incident posting, subscriber notifications. `[verified-from-prior-knowledge]`
- Better Stack (https://betterstack.com/status-page) ships a free tier and reads from cron-job-like uptime probes; the Anvil scale (one cluster, one region) does not need their volume features. `[verified-from-prior-knowledge]`
- Self-hosted: Cachet, Upptime (Markdown + GitHub Actions), Statping. Upptime in particular is GitHub-Pages-driven and free. `[verified-from-prior-knowledge]`

### Adjacent insight

The status page is the cheapest enterprise-trust artifact a SaaS can ship. Anvil's `cron_health` table plus `slo_evaluations` (from F11.2) plus `deploy_events` are already the three feeds Atlassian Statuspage pulls from. Building the page in-house is a one-day job.

### Research insight

Linear's status page (https://linear.app/status) reuses Honeycomb SLOs and posts incident updates with a templated affected-surface dropdown. The audience is technical buyers who want to verify before they ask. `[verified-from-prior-knowledge]`

### Proposed change

Add `public/status.html` (static SPA built at deploy time from a template) plus `/api/status/public` (no auth, no tenant). Reads:

- `cron_health` -> overall service indicator
- `slo_evaluations` last 90d -> per-surface uptime badge
- `incidents` (new table) -> active and resolved incident timeline
- `deploy_events last 14d` -> "recent deploys" section so customers can correlate

### User-facing behavior

A page at `https://app.anvil.work/status` with five rows (Ingest, Extraction, Tally push, GSTN e-invoice, API). Green / amber / red on each. Last incident in a timeline. RSS feed at `/status/feed.xml`. Subscribe-by-email via the existing Resend integration.

### Technical implementation

1. Migration `100_incidents.sql` with `incidents (id, surface, severity, started_at, resolved_at, title, status, posts jsonb[])`.
2. `api/status/public.js` returning JSON for the SPA.
3. `public/status.html` static page using existing CSS tokens.
4. `api/admin/incidents.js` admin CRUD for posting + updating incidents.
5. `api/status/subscribe.js` POST email -> insert into `status_subscribers`, send confirm email via Resend.

### Integration plan

Land the schema + endpoint first (week 1). Build the static page (week 2). Add subscribe + RSS (week 3). Soft-launch by linking from the shell footer "Status: all systems normal".

### Telemetry

`audit_events action=incident_created/updated/resolved` with `actor_role='admin'`.

### Non-goals

- Public per-tenant status (each tenant sees its own diagnostics; the public page is Anvil-wide).
- Embeddable widget for customer pages (defer).

### Open questions

- Where do degraded states come from automatically vs. operator-posted? Recommend: SLO burn rate of >5% auto-flips a surface to "degraded"; operators can override.

### Effort

S.

### 5-axis score

PSev 3, MDiff 2, TLev 3, EStr 4, SFit 4. **16/25**.

### Deep-dive prompt

> Land migrations 100 (`incidents`) and 101 (`status_subscribers`). Build `api/status/public.js`, `api/admin/incidents.js`, `api/status/subscribe.js`. Add `public/status.html` static page that polls the public endpoint. Wire the shell footer to link to /status when reachable. Add an RSS feed at `/status/feed.xml` using a tiny inline XML builder, no npm dependency.

---

## F11.4 Outcomes meter is not drained to Stripe Meters. P1.

### Problem

`src/api/_lib/outcomes.js:24-87` maps 96 audit verbs onto 12 billable outcomes with USD-cents prices. `api/billing/usage.js` returns the per-tenant per-outcome counts. But there is no cron job that drains these outcomes to Stripe Meter events, the way `api/cron/drift-meter.js` does for the Tally drift add-on. So Anvil today shows the customer a meter on the Admin Center Billing tab, but invoicing is manual.

### Current state on main

- `_lib/outcomes.js` defines 12 outcomes with USD-cents prices (`order_processed: 50`, `order_pushed: 100`, etc.). `[verified-on-main]`
- `api/billing/usage.js` reads the audit log and computes per-outcome counts + USD subtotal. `[verified-on-main]`
- `api/cron/drift-meter.js` is the only outcomes-to-Stripe drain on main, and it covers only the Tally drift add-on. `[verified-on-main]`
- `_lib/stripe-client.js:64-77` exposes `recordStripeMeterEvent({meter, stripeCustomerId, value, identifier})`. `[verified-on-main]`
- `BILLING_OUTCOMES.md:42` explicitly notes "There is no Stripe Connect or invoice generator wired yet: the meter is the read side. Outbound billing will land when the Stripe + the non-India invoicing modules ship." `[verified-on-main]`

### Competitor state

- Stripe Meters (https://docs.stripe.com/api/meters): one `event_name` per meter; the meter is attached to a recurring `price` of type `metered`; subscriptions auto-roll-up at period end. Maximum aggregate-window is 1h. `[verified-from-prior-knowledge]`
- Orb (https://www.withorb.com/) and Metronome (https://metronome.com/) are pure-play usage-billing platforms with multi-meter, multi-tier pricing, and event-mapping. Orb is the more developer-friendly; Metronome is enterprise-grade. `[verified-from-prior-knowledge]`
- Lago is the open-source competitor (https://github.com/getlago/lago), self-hostable. `[verified-from-prior-knowledge]`
- M3ter (https://www.m3ter.com/) competes with Orb and Metronome with stronger CPQ integrations. `[verified-from-prior-knowledge]`

### Adjacent insight

Anvil already has Stripe Connect onboarding (`api/billing/stripe/connect_onboard.js`), Stripe Checkout (`stripe/checkout.js`), and Razorpay subscription path. The only missing piece is the per-outcome meter writer running on the daily cron. This is two days of work, not two weeks. Once it lands, Anvil collects revenue automatically; without it, the finance team posts invoices manually each month.

### Research insight

Stripe Meters require one `event_name` per billed unit. Anvil has 12 outcomes. Creating 12 Stripe meters is fine; the alternative (single meter with a `payload.outcome_id`) does not work because Stripe price configuration is per-meter, not per-payload-attribute. `[verified-from-prior-knowledge]`

### Proposed change

Add `api/cron/outcomes-meter.js` that runs daily, walks `audit_events` for the last 24h, groups by `(tenant_id, outcome)`, calls `recordStripeMeterEvent` per group, and writes a `outcomes_billing_meter` row per drain so the partial-index pattern matches Bet 5.

### User-facing behavior

Stripe subscription invoice arrives on the 1st of each month with one line per outcome: "1,247 orders processed at $0.50 = $623.50; 891 orders pushed at $1.00 = $891.00; ...". Operator sees a preview in Admin Center Billing tab before the period closes.

### Technical implementation

1. Migration `102_outcomes_billing_meter.sql` mirroring `097`.
2. `_lib/outcomes-meter.js` exposes `drainOutcomesOnce(svc, {windowStartIso, windowEndIso})`.
3. `cron/outcomes-meter.js` is the cron handler.
4. `cron/daily.js` adds this to its list (alongside drift-meter and the new SLO evaluator).
5. Stripe-side: create 12 meters via the dashboard (one per outcome id) and 12 prices wired to them. Document the `STRIPE_OUTCOME_METER_*` env vars.

### Integration plan

Land the schema + helper behind a feature flag. Run it in dry-run mode for 2 weeks (compute but do not call Stripe). Compare to manual SQL roll-up. Flip the flag.

### Telemetry

`processing_events event_type=outcomes_meter_drain` with `detail={tenant_id, outcomes_reported, stripe_events, errors}`. `audit_events action=outcomes_billed` per period.

### Non-goals

- Per-tenant price overrides (defer until renewals start asking).
- Refund / credit memo flow (Stripe handles refunds at the subscription level).

### Open questions

- Do we drain hourly or daily? Recommend daily; Stripe's 1h aggregation window allows hourly but the noise is not worth it.
- What about the `tally_drift_billing_meter` outcome (`drift_check_run`)? Keep it separate (Bet 5's flat + uplift model is not a pure outcome meter).

### Effort

M.

### 5-axis score

PSev 4 (revenue ops bottleneck), MDiff 3, TLev 4, EStr 5, SFit 5. **21/25**.

### Deep-dive prompt

> Land migration `102_outcomes_billing_meter.sql` mirroring `097`. Build `src/api/_lib/outcomes-meter.js` with `drainOutcomesOnce(svc)`. Build `src/api/cron/outcomes-meter.js`. Wire into `cron/daily.js`. Pre-create 12 Stripe meters and wire their identifiers as `STRIPE_OUTCOME_METER_<OUTCOME_ID>` env vars. Default-off behind `OUTCOMES_METER_ENABLED`. Add unit tests covering the dedup-by-identifier path and the per-tenant-no-subscription skip path.

---

## F11.5 Pricing card and outcomes meter publish two different prices. P1.

### Problem

`docs/PRICING_STRATEGY.md:14-18` publishes three tiers with per-SO overage rates of Rs 39 / Rs 19 / Rs 9. `docs/BILLING_OUTCOMES.md:14-25` publishes a USD-cents price card: $0.50 per order processed, $1.00 per order pushed to ERP, etc. Both are public artifacts. Neither references the other. A buyer who reads both will assume "I pay the tier subscription AND each outcome", which doubles the apparent price.

### Current state on main

- Pricing card: `docs/PRICING_STRATEGY.md` is the marketing-facing artifact. `[verified-on-main]`
- Outcomes card: `docs/BILLING_OUTCOMES.md` is the engineering-facing artifact, also published in Admin Center Billing tab. `[verified-on-main]`
- The Rs values in the pricing card include "all core extraction + anomaly detection + audit log + Tally bridge" (lines 141-144). The implied position is that outcomes are billed inside the tier subscription. The outcomes card does not say "for accounting reference only". `[verified-on-main]`

### Competitor state

- Stripe pricing (https://stripe.com/pricing): two tiers (Standard, Custom) plus per-transaction percentage. The two are clearly composable. `[verified-from-prior-knowledge]`
- Linear pricing (https://linear.app/pricing): Free, Standard, Plus, Enterprise. Each tier specifies seat-included vs seat-overage. No double price card. `[verified-from-prior-knowledge]`
- Twilio (https://www.twilio.com/pricing): per-message rate is the only public price; subscription tiers are sales-led. `[verified-from-prior-knowledge]`
- ClearTax (Indian GST automation, ~Rs 40k/yr for 300 GSTINs / 3000 invoices, https://www.techjockey.com/detail/cleartax-gst-software): single price per slab. `[verified-from-prior-knowledge]`

### Adjacent insight

The Rs vs USD mismatch is the smaller half of the issue. The bigger half is "is the outcomes meter a billable surface or just an internal cost-attribution view?". F11.4 proposes wiring it to Stripe so the meter IS billed. That makes the pricing-card reconciliation question urgent.

### Research insight

Per `STRATEGIC_BET_05_tally_drift_paid_sku.md:80-117`, the bets model is hybrid: a flat fee per tier with a per-SO uplift over an included volume. This is the right shape for an Indian CFO. The outcomes meter is more granular than a single per-SO meter, which makes the customer-facing math noisier.

### Proposed change

Reconcile to one model. Recommend:

- The customer signs a tier (Starter / Growth / Enterprise) with a base fee, an included SO ceiling, and a per-SO overage rate. This is what `PRICING_STRATEGY.md` already publishes.
- The outcomes meter becomes the internal cost-attribution view (visible in Admin Center, used by Anvil's revops to compute per-tenant gross margin) and the basis for renewal upsells (e.g. "you used 1,200 service-visit closures, the add-on at $0.50 each = $600/mo would land that as a meter").
- Eliminate the public outcomes price card from `BILLING_OUTCOMES.md` until the outcomes meter is a contracted SKU.

### User-facing behavior

The Billing tab in Admin Center shows two cards: "Your tier" (Starter, 200 SOs included, Rs 39 overage rate, projected this month) and "Outcomes detail" (the 12-outcome breakdown, labeled "Cost attribution; not separately invoiced unless your contract specifies"). The public marketing page shows only the tier.

### Technical implementation

1. Edit `BILLING_OUTCOMES.md` header to clarify "internal attribution unless contracted".
2. Edit Admin Center Billing tab to show the tier card prominently and the outcomes card under a "Cost attribution" disclosure.
3. Add a `tenant_settings.tier_id` column and seed Starter / Growth / Enterprise rows.
4. Compute the per-month tier projection: `(included_sos - actual_sos_so_far) * Rs_per_overage + base_fee`.

### Integration plan

Land the docs edit in week 1. Land the tier_id column in week 2. Land the Admin Center surface refresh in week 3. Coordinate with the Phase 7 sales engineer who is building `/api/billing/quote` per `PRICING_STRATEGY.md:217-220`.

### Telemetry

`audit_events action=tier_assigned`, `tier_changed`. `processing_events event_type=tier_projection_computed` per nightly run.

### Non-goals

- Per-tenant price overrides on the outcomes (defer).
- Annual pricing card (see F11.7).

### Open questions

- Do Growth and Enterprise tenants want the outcomes view at all? Recommend yes; the CFO will study it during the QBR.

### Effort

S.

### 5-axis score

PSev 3 (slows deals), MDiff 2, TLev 2, EStr 4, SFit 5. **16/25**.

### Deep-dive prompt

> Edit `docs/BILLING_OUTCOMES.md` to clarify that the public outcomes card is internal cost attribution unless contracted. Add `tenant_settings.tier_id` plus a `tiers` table seeded with Starter / Growth / Enterprise. Refresh Admin Center Billing tab to lead with the tier card and put outcomes under a disclosure. Build `api/billing/projection.js` that computes the projected monthly invoice using the included-volume + overage formula.

---

## F11.6 Three-tier pricing proposal anchored on metered variables Anvil actually tracks. P1.

### Problem

The current pricing card is well-shaped but built on a single dimension (SOs). Anvil tracks 12 outcome types plus ERP push counts plus AI token usage plus document pages. The pricing should leverage these to grow ARR without raising sticker price. This finding proposes a concrete 3-tier model with per-unit prices and tier breakpoints, cross-referenced to Stripe Meters and Razorpay.

### Current state on main

- `docs/PRICING_STRATEGY.md` defines three tiers. `[verified-on-main]`
- `outcomes.js` defines 12 outcomes with prices. `[verified-on-main]`
- `tally_drift_addon_billing_plan` enum supports `starter`, `growth`, `enterprise`, `trial`. `[verified-on-main]`

### Competitor state

- ClearTax: ~Rs 40k/yr for 300 GSTINs and 3000 invoices. `[verified-from-prior-knowledge]`
- Rossum (Western IDP, https://rossum.ai/pricing/): subscription by transaction volume; published pricing starts at ~$1500/mo per 1000 documents. `[verified-from-prior-knowledge]`
- Hyperscience (https://www.hyperscience.com): enterprise-only, custom-quoted, typically $100k+/yr platform commit. `[verified-from-prior-knowledge]`
- BlackLine (account reconciliation, https://www.blackline.com): $77k median, up to $340k/yr per Vendr. `[verified-from-prior-knowledge]`
- Conexiom (EDI / order entry): per trading partner per doc, ~$0.50-$2.00 per document. `[verified-from-prior-knowledge]`

### Proposed Anvil three-tier pricing (refined)

| Variable | Starter | Growth | Enterprise |
|---|---|---|---|
| Monthly base (INR) | Rs 14,990 | Rs 49,990 | Rs 99,990+ |
| Monthly base (USD) | $179 | $599 | $1,199+ |
| Included SOs / month | 200 | 1,000 | 5,000 |
| Overage per SO (INR) | Rs 39 | Rs 19 | Rs 9 |
| Included documents pages OCRed | 2,000 | 10,000 | 50,000 |
| Overage per OCR page (INR) | Rs 1.50 | Rs 0.90 | Rs 0.50 |
| Included AI calls (Sonnet equivalent) | 50k tokens / SO budget | 100k / SO budget | unlimited |
| Locations (GSTINs) | 1 | 5 | unlimited |
| Operator users | 5 | 20 | unlimited |
| ERPs (push) | Tally only | Tally + 1 | All 17 |
| Annual discount | 0% | 15% | 20% |
| Tally drift add-on | Rs 2,000/mo + Rs 1.50/SO over 200 | Free through 2026-12-31 then Rs 3,500/mo | Bundled |
| WhatsApp send | Rs 0.50/msg | Rs 0.50/msg | Rs 0.30/msg |
| Voice AI (inbound) | n/a | Rs 15/min | Rs 12/min |
| Voice AI (outbound) | n/a | Rs 25/min | Rs 20/min |
| e-Way bill submissions | Rs 2/bill | Rs 2/bill | Rs 2/bill |
| BYO LLM key discount | -10% | -10% | -10% |
| BRSR buyer add-on (Bet 7) | n/a | Rs 2,500/mo | Bundled |
| Marketplace template downloads | n/a | 10/mo included | unlimited |
| Marketplace publish royalty | n/a | 25% to publisher, 75% to Anvil | 50/50 |
| Conformal safety stock add-on (Bet 3) | n/a | Rs 3,000/mo | Bundled |
| Receivables AA + TReDS (Bet 6) | n/a | Rs 5,000/mo | Bundled |
| Uptime SLA | 99.0% | 99.5% | 99.9% |
| Support response | 1 business day | 4 hours | 1 hour |
| Annual plan available | Yes | Yes | Yes |
| Multi-currency invoicing | INR only | INR + USD + AED | INR + USD + AED + custom |

### Per-unit price calibration

Where do the per-unit prices come from? Three anchors:

1. **Marginal cost**: per `PRICING_STRATEGY.md:46-50`, marginal cost per SO is Rs 2.70 (LLM tokens + storage). Starter at Rs 39 overage is 14x markup; Growth at Rs 19 is 7x; Enterprise at Rs 9 is 3.3x.
2. **Operator value**: 9 minutes saved per SO at Rs 500/hour operator cost is Rs 75 of value. Anvil captures 12-50% at the price points above.
3. **Competitor benchmarks**: Conexiom ~$0.50-$2.00 per document (Rs 42-Rs 168). Anvil's Rs 39 Starter overage is at the low end of the Conexiom band; Rs 9 Enterprise is well below.

### Stripe meter layout

12 Stripe meters, one per outcome. Per-meter price reflects the per-tier overage rate. Subscription items: one base price (Starter/Growth/Enterprise) plus one metered overage price per outcome that the tier monetizes.

```
Starter subscription:
  - prod_anvil_starter_base ($179/mo)
  - prod_anvil_so_overage_starter (meter: anvil_order_processed, $0.50/event)
  - prod_anvil_ocr_overage_starter (meter: anvil_document_extracted, $0.02/event)

Growth subscription:
  - prod_anvil_growth_base ($599/mo)
  - prod_anvil_so_overage_growth ($0.25/event)
  - prod_anvil_ocr_overage_growth ($0.012/event)
  - prod_anvil_addon_drift_growth ($42/mo + meter)
  - prod_anvil_addon_brsr_growth ($30/mo)

Enterprise subscription:
  - prod_anvil_enterprise_base ($1,199/mo)
  - prod_anvil_so_overage_enterprise ($0.11/event)
```

Idempotency: every drain writes a Stripe `identifier` of `{outcome_id}_{tenant_id}_{utc_day}_{sequence}`, dedup'd server-side. `[verified-from-prior-knowledge]` (https://docs.stripe.com/api/meters)

### Razorpay equivalent

Razorpay Subscriptions does not support per-event meters the way Stripe does; the closest primitive is the Subscription Add-on (https://razorpay.com/docs/payments/subscriptions/), one add-on per period per meter. `[verified-from-prior-knowledge]` So the Razorpay path attaches one add-on per outcome per period (12 add-ons / month / tenant), each with the same per-unit price as the Stripe meter. `_lib/razorpay-client.js:81-102` (`recordRazorpayUsage`) already implements this pattern for the Tally drift meter and is reusable.

### Tier upgrade triggers

Built into the daily cron: if a tenant exceeded the next-tier breakpoint for 2 consecutive months, write an `admin_notifications` row with `kind='upgrade_recommended'` so the CSM can pitch. Auto-upgrade is NOT proposed (Indian buyers will not accept it; they sign annually).

### Annual pricing

Discount 15% (Growth) and 20% (Enterprise) on annual prepay. Add `subscriptions.payment_cadence` enum ('monthly', 'annual') and a `discount_applied_pct` column.

### User-facing behavior

Public pricing page lists three columns. A FAQ block answers seven questions per `PRICING_STRATEGY.md:208-216`. The Admin Center Billing tab shows current tier with a "compare" link.

### Technical implementation

1. Migration `103_pricing_v2.sql` adds `tiers`, `tier_pricing`, `tenant_subscriptions`, `tenant_subscription_addons`.
2. Pre-create Stripe products / prices via a one-time migration script `scripts/seed-stripe-pricing.mjs`.
3. Build `api/billing/quote.js` endpoint per `PRICING_STRATEGY.md:217-220`.
4. Build a public `/pricing` page reading from `tier_pricing`.

### Integration plan

Phase A: schema + Stripe products. Phase B: quote endpoint. Phase C: public pricing page. Phase D: outcomes meter (F11.4) wired in.

### Telemetry

`audit_events action=quote_generated`, `subscription_started`, `subscription_changed`. `processing_events event_type=tier_upgrade_recommended`.

### Non-goals

- Per-customer custom pricing (defer; sales-led).
- Variable AI-tier pricing (Haiku / Sonnet / Opus). The included AI budget covers Anthropic's variability; do not expose the model choice to the buyer.

### Open questions

- Does AED for Gulf customers map to a separate Stripe product or to the USD product? Recommend: separate Stripe product priced at the local FX rate; no arbitrage.
- Marketplace royalty: 25%/75% at Growth and 50/50 at Enterprise creates a perverse incentive for publishers. Recommend a uniform 50/50, simpler narrative.

### Effort

L.

### 5-axis score

PSev 4, MDiff 4, TLev 4, EStr 5, SFit 5. **22/25**.

### Deep-dive prompt

> Land migration `103_pricing_v2.sql` per F11.6. Build `scripts/seed-stripe-pricing.mjs` to pre-create products, prices, meters. Build `api/billing/quote.js` per `PRICING_STRATEGY.md:217-220`. Build a public `/pricing` page rendered server-side at deploy time. Coordinate with sales engineering on the quote-flow inputs (tier, expected_volume, ERPs, addons).

---

## F11.7 Annual pricing path missing. P2.

### Problem

The pricing card is monthly-only. Indian SMB CFOs prefer annual prepay (single PO, single fiscal-year line, cash-flow predictability). The repo has no `payment_cadence` column.

### Current state on main

- `recurring_invoice_schedules.cadence` supports `MONTHLY|QUARTERLY|BIANNUAL|ANNUAL` for outbound invoicing of Anvil's customers' customers, but there is no equivalent column for the Anvil-to-customer subscription. `[verified-on-main]` (`api/billing/recurring.js:17`)
- Stripe Connect onboarding (`stripe/connect_onboard.js`) is configured for monthly subscriptions only. `[verified-on-main]`

### Competitor state

Most enterprise SaaS offers 15-20% off annual. Salesforce, HubSpot, Notion, Linear, all follow this pattern. `[verified-from-prior-knowledge]`

### Adjacent insight

Indian buyers will sign 12-month POs more readily than month-to-month subscriptions; the procurement cycle assumes annual budgeting. Offering annual at a meaningful discount converts a procurement-led objection into a cash-flow advantage for Anvil.

### Proposed change

Add `tenant_subscriptions.cadence` ('monthly', 'annual') and `discount_pct`. Default Growth annual = 15% off; Enterprise = 20% off. Honor annual on the Stripe price config.

### User-facing behavior

Pricing page shows a "Monthly / Annual (save 15%)" toggle. Quote endpoint respects cadence.

### Technical implementation

1. Migration `104_subscription_cadence.sql`.
2. Pre-create annual Stripe products and prices.
3. Quote endpoint accepts `cadence` input.

### Integration plan

Land alongside F11.6 in the same migration if convenient.

### Telemetry

`audit_events action=subscription_cadence_chosen` with `detail={cadence, discount_pct}`.

### Non-goals

Monthly to annual mid-term conversion. Defer (Stripe makes this hard).

### Effort

S.

### 5-axis score

PSev 2, MDiff 2, TLev 2, EStr 4, SFit 4. **14/25**.

### Deep-dive prompt

> Land migration `104_subscription_cadence.sql`. Update `scripts/seed-stripe-pricing.mjs` to add annual prices at -15% (Growth) / -20% (Enterprise). Update `api/billing/quote.js` to accept `cadence`.

---

## F11.8 No incident-response runbook in the repo. P1.

### Problem

`docs/SECURITY.md` mentions the audit log surface. No file documents "when X alerts fires, do Y". On-call has no playbook.

### Current state on main

- `docs/CRONS.md` covers cron-job.org setup and rotation. `[verified-on-main]`
- No `docs/INCIDENT_RESPONSE.md`. `[inferred]` (no file in repo matches; would have surfaced in the docs grep)
- No on-call rotation document.

### Competitor state

Atlassian's incident handbook (https://www.atlassian.com/incident-management/handbook) is the canonical public template. PagerDuty's playbook (https://response.pagerduty.com/) is the second-most-cited. `[verified-from-prior-knowledge]`

### Proposed change

Add `docs/INCIDENT_RESPONSE.md` with sections:
1. Severity matrix (SEV-1 / SEV-2 / SEV-3 with examples and response times)
2. Detection (which alerts route where; see F11.9 for the alert spec)
3. Response (acknowledge, communicate, mitigate, recover, post-mortem)
4. Communication templates (initial, update-1, update-2, resolved)
5. Postmortem template
6. Runbook index by surface (Tally bridge down, GSTN circuit-breaker, AI provider degraded, cron stalled, database connection storm)

### User-facing behavior

The runbook lives in the repo. Operators reference it during an incident. Public status page (F11.3) posts use the templated language.

### Technical implementation

Markdown only. Maybe one CSV `runbooks/index.csv` cross-indexing alerts to runbook section.

### Integration plan

Single PR. Doc-only.

### Telemetry

n/a.

### Non-goals

External tooling (PagerDuty, Incident.io) is overkill at current scale.

### Effort

S.

### 5-axis score

PSev 3, MDiff 1, TLev 1, EStr 3, SFit 4. **12/25**.

### Deep-dive prompt

> Add `docs/INCIDENT_RESPONSE.md` with the 6 sections from F11.8. Cross-link from `docs/CRONS.md`, `docs/SECURITY.md`, and the README. Add one one-page runbook per surface (Tally, GSTN, AI provider, cron, DB).

---

## F11.9 No alert rules over audit_events / processing_events / cron_health. P0.

### Problem

The signals exist but nothing watches them. A misconfigured admin who runs `member_revoke` 50 times in 2 minutes (accidental or malicious) generates 50 audit rows; no alarm fires. A processing pipeline that climbs to p95 > 120s emits longer `duration_ms` values; no alarm fires. The cron heartbeat ages past the threshold; the only consumer is `/api/health` which is polled on the shell footer, not by an alert engine.

### Current state on main

- `_lib/audit.js:53-87` writes to `audit_events`. `[verified-on-main]`
- 223 callers of `recordAudit`. `[verified-on-main]`
- No `alert_rules` or `alert_dispatches` table. `[inferred]`
- `admin_notifications` table is a notification surface for in-app bell only, not an alert engine. `[verified-on-main]`

### Competitor state

- Datadog Monitors (https://docs.datadoghq.com/monitors/) supports metric, log, and event-correlation rules with multi-channel routing. `[verified-from-prior-knowledge]`
- Sentry (https://docs.sentry.io/) ships an "Alerts" surface with conditions, thresholds, and routes to Slack, email, PagerDuty, OpsGenie. `[verified-from-prior-knowledge]`
- Honeycomb's Triggers fire on query-result threshold crossings. `[verified-from-prior-knowledge]`

### Adjacent insight

Anvil's `processing_events.detail` already carries enough JSON for most rules: `event_type=so_extracted` with `detail.confidence < 0.5` is a row-level signal. A simple rule engine that polls daily can cover 80% of the surface without a streaming infrastructure.

### Proposed change

Add `alert_rules` and `alert_evaluations`. Rule shape:

```sql
create table alert_rules (
  id uuid primary key,
  name text not null,
  surface text,
  source text not null check (source in ('audit_events', 'processing_events', 'cron_health', 'slo_evaluations', 'model_routing_log')),
  predicate jsonb not null,   -- {window_minutes, group_by, having_count_gt, having_avg_gt, etc.}
  severity text check (severity in ('sev1','sev2','sev3')),
  channel jsonb not null,     -- {slack_webhook, email, pagerduty_routing_key, admin_notification}
  enabled boolean not null default true,
  cooldown_minutes int default 30,
  created_at timestamptz default now()
);
```

Seed with 12 rules:

1. `audit_member_revoke_burst` (>=5 in 5min): severity sev2, channel admin_notification + slack
2. `audit_force_llm_fallback_toggle` (any in 1min): sev3, admin_notification
3. `processing_p95_so_extraction_high` (p95 > 90s in 30min): sev2, slack
4. `cron_tick_stale` (cron_health.tick > 15min): sev1, pagerduty
5. `cron_daily_stale` (cron_health.daily > 30h): sev1, pagerduty
6. `slo_extraction_burn_fast` (2% of monthly budget in 1h): sev2, slack
7. `slo_extraction_burn_slow` (10% of monthly budget in 6h): sev3, admin_notification
8. `model_routing_opus_spike` (Opus calls > 1000 in 1h): sev1, slack
9. `audit_failures_growing` (audit_failures inserts > 10 in 1h): sev1, pagerduty
10. `payment_received_anomaly` (>3 sigma from mean in 24h): sev3, admin_notification
11. `tally_push_failure_burst` (>=10 in 30min): sev2, slack
12. `gstn_circuit_open_long` (`einvoice_circuit_open` >= 30min): sev2, slack

### User-facing behavior

Alerts arrive in Slack, email, or PagerDuty per rule config. Admin Center has an "Alerts" tab listing recent dispatches and rule on/off toggles.

### Technical implementation

1. Migration `105_alerts.sql`.
2. `_lib/alerts.js` with one evaluator per source. Source-specific predicate runner.
3. `cron/tick.js` adds a `alerts/evaluate` step at the every-5-min cadence.
4. `api/admin/alerts.js` CRUD + dispatch history.

### Integration plan

Land schema and helper first. Seed 4 highest-severity rules. Observe for 7 days. Add the remaining 8.

### Telemetry

`audit_events action=alert_rule_fired/acknowledged/silenced`. `processing_events event_type=alert_evaluation` per cron cycle.

### Non-goals

- Streaming alerts (5-min polling is fine for Anvil scale).
- Machine-learning anomaly detection (rule-based is enough).

### Open questions

- Where does Slack-webhook URL live? Recommend `tenant_settings.alerts_slack_webhook` (per-tenant) plus an Anvil-wide `ALERTS_SLACK_WEBHOOK` env var for platform alerts.
- PagerDuty routing key: `tenant_settings.alerts_pagerduty_routing_key`.

### Effort

L.

### 5-axis score

PSev 5, MDiff 4, TLev 4, EStr 4, SFit 5. **22/25**.

### Deep-dive prompt

> Land migration `105_alerts.sql`. Build `src/api/_lib/alerts.js` with a per-source evaluator (audit_events, processing_events, cron_health, slo_evaluations, model_routing_log). Build `src/api/cron/alerts.js` that runs every 5 min. Seed 12 rules from F11.9. Wire dispatch channels (Slack webhook, email via Resend, PagerDuty routing key, admin_notifications). Build `screens/admin.tsx` Alerts tab.

---

## F11.10 No structured trace / span model for the SO intake pipeline. P2.

### Problem

`processing_events` captures discrete event rows per `(case_id, event_type)` with a `duration_ms`. There is no parent-span relationship: an SO intake fires 12-20 events but they are not stitched into a trace. Investigating a slow intake means manually correlating timestamps.

### Current state on main

- `_lib/audit.js:89-117` (`recordEvent`) inserts a `processing_events` row with `case_id`, `event_type`, `object_type/id`, `detail`, `duration_ms`. `[verified-on-main]`
- 23 callers of `recordEvent`. `[verified-on-main]`
- `api/events/index.js` returns events for a given `case_id`.

### Competitor state

- OpenTelemetry traces (https://opentelemetry.io/docs/concepts/signals/traces/) is the open standard. Each span has trace_id, span_id, parent_span_id. `[verified-from-prior-knowledge]`
- Datadog APM (https://docs.datadoghq.com/tracing/) consumes OTel and renders trace waterfalls. `[verified-from-prior-knowledge]`
- Honeycomb is the trace-native player; their model is event-based with trace correlation IDs and zero parent/child enforcement at write time. `[verified-from-prior-knowledge]`

### Adjacent insight

The leanest path is the Honeycomb model: add `trace_id` and `parent_event_id` columns to `processing_events`, generate the IDs at the SO intake start, and pass them through downstream calls. No new infrastructure.

### Proposed change

Migration `106_processing_event_trace.sql`:
```sql
alter table processing_events
  add column if not exists trace_id uuid,
  add column if not exists parent_event_id uuid,
  add column if not exists started_at timestamptz default now();
```
Update `recordEvent(ctx, payload)` to accept `traceId` and `parentEventId`. SO intake start writes a root event and propagates the trace id through every subsequent step.

### User-facing behavior

In the case page, render a trace waterfall (each event with its `started_at` and `duration_ms`, indented by parent_event_id). A "Copy trace ID" button. Useful for support tickets.

### Technical implementation

1. Migration with two new columns.
2. Update `_lib/audit.js` to thread trace context.
3. Update the case-detail UI in `screens/` to render the waterfall.
4. Add a `GET /api/events/trace/:trace_id` endpoint.

### Integration plan

Land schema + helper. Update the SO intake entrypoint to start the trace. Roll out to one screen first.

### Telemetry

n/a; this IS the telemetry refresh.

### Non-goals

- OpenTelemetry export (defer; not worth the dependency).
- Cross-tenant trace stitching.

### Effort

M.

### 5-axis score

PSev 2, MDiff 2, TLev 3, EStr 3, SFit 3. **13/25**.

### Deep-dive prompt

> Land migration `106_processing_event_trace.sql` with `trace_id`, `parent_event_id`, `started_at` on `processing_events`. Update `src/api/_lib/audit.js` `recordEvent` signature. Update SO intake entrypoint to start a trace and propagate through downstream calls. Add `api/events/trace/[id].js`. Render a waterfall in the case-detail screen.

---

## F11.11 Cron heartbeat freshness probe is single-cluster; no multi-region awareness. P3.

### Problem

`api/health.js:106-144` reads `cron_health` and reports per-worker staleness using `Date.now()` against `last_run_at`. If Anvil ever runs in multiple Vercel regions (e.g. `iad1` and `bom1`), each region's clock skew + cold start could create false positives. The `recordCronHeartbeat` writer also assumes a single `cron_health` table without `region` discriminator.

### Current state on main

- `_lib/cron-mux.js:126-149` writes one row per `worker`. `[verified-on-main]`
- `health.js:94-104` defines `CRON_EXPECTED_MAX_AGE_MS` per worker. `[verified-on-main]`
- Vercel deployment is single-region (`process.env.VERCEL_REGION` reported but not enforced). `[verified-on-main]`

### Competitor state

Datadog and Grafana both treat region as a tag on the heartbeat metric. `[verified-from-prior-knowledge]`

### Proposed change

Add `region` column to `cron_health` (`primary key (worker, region)`). Vercel env `VERCEL_REGION` is the discriminator. Probe reports per-region per-worker freshness.

### Effort

S.

### 5-axis score

PSev 1, MDiff 2, TLev 2, EStr 2, SFit 2. **9/25**.

### Deep-dive prompt

> Migration `107_cron_health_region.sql` adds `region text not null default 'global'` and changes primary key to `(worker, region)`. Update `recordCronHeartbeat` to read `VERCEL_REGION`. Update `health.js probeCron` to group by region.

---

## F11.12 No audit-log retention policy. P1.

### Problem

`audit_events` and `processing_events` grow unboundedly. At 500 SOs/day per tenant and 25 audit verbs per SO, a tenant generates 12,500 rows/day, 4.5M/year. With 100 tenants, that is 450M rows/year on Supabase free / pro tier. The migration `058_audit_events_append_only.sql` blocks deletes by design, which is correct for compliance but creates a storage liability.

### Current state on main

- `058_audit_events_append_only.sql` is the append-only migration. `[verified-on-main]`
- No retention or archive policy.
- No partitioning. `[inferred]`

### Competitor state

- AWS CloudTrail charges $0.10/GB after the first 90 days. `[verified-from-prior-knowledge]`
- Datadog logs cost $0.10/M ingested + $1.27-$1.70/M retained per month. `[verified-from-prior-knowledge]`
- Stripe's `events.list` returns the last 30 days only. `[verified-from-prior-knowledge]`

### Proposed change

Add a 7-year retention floor (SOC 2 and Indian GST need 6-7 years), partition `audit_events` by month, and migrate cold partitions (>13 months old) to a `cold_storage` schema or to S3 Glacier-equivalent. The append-only constraint blocks DELETE on the hot partition; partition pruning is the cold-data eviction mechanism.

### Effort

M.

### 5-axis score

PSev 2, MDiff 3, TLev 3, EStr 3, SFit 3. **14/25**.

### Deep-dive prompt

> Migration `108_audit_partitioning.sql` converts `audit_events` to a partitioned table by month with a 13-month hot window. Add a `cold_audit_events` archive table populated by a monthly cron. Update the audit query path to UNION ALL hot + cold when the requested window crosses the boundary.

---

## F11.13 No per-tenant data export self-serve. P2.

### Problem

`screens/audit.tsx:128-139` exports the audit log as CSV/JSON client-side, but the export is filtered to whatever 200 rows the user has loaded. There is no full-tenant export of orders, customers, audit, processing events. GDPR / DPDP Act compliance and the customer-departure exit path both require this.

### Current state on main

- Audit export: client-side CSV / JSON over the loaded 200 rows. `[verified-on-main]`
- No `/api/admin/export` endpoint. `[inferred]`

### Competitor state

GitHub data export (https://docs.github.com/en/account-and-profile/setting-up-and-managing-your-personal-account-on-github/managing-personal-account-settings/requesting-an-archive-of-your-personal-account-s-data) creates a ZIP and emails a link. Notion exports Markdown ZIPs. `[verified-from-prior-knowledge]`

### Proposed change

`POST /api/admin/export` enqueues a job; cron `daily.js` runs the queue; result lands in Supabase Storage as a presigned URL emailed to the admin.

### Effort

M.

### 5-axis score

PSev 2, MDiff 3, TLev 3, EStr 3, SFit 4. **15/25**.

### Deep-dive prompt

> Migration `109_data_exports.sql` adds an `data_exports (tenant_id, status, requested_by, format, scope, storage_path, expires_at)` table. `api/admin/export.js` enqueues. `_lib/data-export.js` does the dump (orders, audit_events, processing_events, customer rows; ZIP via `archiver`). Cron drains. Resend emails a link.

---

## F11.14 RBAC enum drift between API and frontend. P2.

### Problem

`auth.js:33-36` defines 4 role sets (viewer / writer / approver / admin). `auth.js:38-43` ladders permissions. `admin/members.js:13` defines `ALLOWED_ROLES` as 7 strings. `admin/access_requests.js:23-25` defines `VALID_ROLES` as 6 strings (missing `operator`, missing `viewer` distinction, missing `sales_engineer`). They drift.

### Current state on main

- `auth.js:33` `VIEWER_ROLES = ["viewer", "sales_engineer", "sales_manager", "procurement", "finance", "admin", "operator"]` (7 roles)
- `members.js:13` `ALLOWED_ROLES = ["sales_engineer", "sales_manager", "approver", "viewer", "admin", "operator", "finance"]` (7 roles but includes `approver` which is not a role anywhere else)
- `access_requests.js:23` `VALID_ROLES = ["viewer", "sales_engineer", "sales_manager", "procurement", "finance", "admin"]` (6 roles; missing `operator`)
- The script `src/scripts/audit-rbac.mjs` exists per the comment in `auth.js:25` but is not invoked in CI.

### Proposed change

Migration `110_role_enum.sql` codifies the 7-role enum at the schema layer. All three JS files import a single `ROLES` constant from `_lib/rbac.js` (new). CI runs `audit-rbac.mjs` and fails on drift.

### Effort

S.

### 5-axis score

PSev 3 (silent 403s, broken invites), MDiff 1, TLev 2, EStr 2, SFit 3. **11/25**.

### Deep-dive prompt

> Create `src/api/_lib/rbac.js` exporting `ROLES`, `PERMISSION_TIERS`, `ROLE_TO_TIER`. Refactor `auth.js`, `members.js`, `access_requests.js` to consume it. Add migration `110_role_enum.sql` with a `role_enum` Postgres ENUM. Wire `npm run audit-rbac` into CI; refuse merge on drift.

---

## F11.15 Vertical pack install endpoint has no rollback. P2.

### Problem

`admin/install_vertical_pack.js` (referenced from the directory listing) is the install side. There is no uninstall or rollback. A tenant who installs the wrong pack accumulates orphan rows in `equipment`, `lead_times`, `lost_reasons`, etc.

### Current state on main

- `install_vertical_pack.js` writes pack data and stamps `tenant_settings.vertical`. `[verified-on-main]` (line 7)
- No `uninstall` action. `[inferred]`

### Proposed change

Add `POST /api/admin/uninstall_vertical_pack` that consults a `vertical_pack_installs` ledger and reverses inserts. The install endpoint must already write the ledger (it does not today; this is the implementation lift).

### Effort

M.

### 5-axis score

PSev 1, MDiff 2, TLev 2, EStr 2, SFit 2. **9/25**.

### Deep-dive prompt

> Refactor `install_vertical_pack.js` to write each inserted row id into a new `vertical_pack_installs` ledger. Add `api/admin/uninstall_vertical_pack.js` that walks the ledger and reverses. Add a "confirm-by-typing-name" guard.

---

## F11.16 No external-cron health check or fallback. P0.

### Problem

`docs/CRONS.md:8-12` says `/api/cron/tick` runs on cron-job.org every 5 min. If cron-job.org expires the free account (no card on file), the tick stops firing. `cron_health.tick_stale` will eventually fire (after 10 min per `health.js:95`), but there is no automated fallback. All 17 ERP retry queues, inbound email, autonomous agents go quiet.

### Current state on main

- `health.js` exposes `tick_stale`. `[verified-on-main]`
- No backup cron source.
- No alert wired to `tick_stale` (covered by F11.9).

### Proposed change

Two-pronged:
1. The alert rule from F11.9 fires sev1 on `tick_stale`.
2. A fallback cron via GitHub Actions (15-min cadence; cheaper failure mode than no cadence). The action posts to `/api/cron/tick` with the same `CRON_SECRET`. Idempotent because the per-handler tick is idempotent.

`docs/CRONS.md:75-91` already documents Option B (GitHub Actions); promote it to the default + cron-job.org as primary, GHA as fallback.

### Effort

S.

### 5-axis score

PSev 5, MDiff 1, TLev 2, EStr 3, SFit 4. **15/25**.

### Deep-dive prompt

> Create `.github/workflows/cron-tick-fallback.yml` (15-min cadence). Document the dual-source pattern in `docs/CRONS.md`. Confirm both schedulers are healthy on the same `cron_health.tick` row (the `recordCronHeartbeat` already upserts by worker, so duplicate sources will simply refresh the row).

---

## F11.17 Diagnostics endpoint hardcodes migration_count and CRITICAL_TABLES. P3.

### Problem

`admin/diagnostics.js:147` hard-codes `migration_count: 10`. The repo has 103 migrations. `CRITICAL_TABLES` (lines 16-31) lists 14 tables; the schema has 100+. Each new migration risks the diagnostics view being stale.

### Current state on main

- `diagnostics.js:147` `migration_count: 10` (literal). `[verified-on-main]`
- `CRITICAL_TABLES` is a 14-entry literal. `[verified-on-main]`
- 103 migration files exist on disk (`ls supabase/migrations/ | wc -l = 103`). `[verified-on-main]`

### Proposed change

Query the count of distinct migrations from `supabase_migrations.schema_migrations` (the Supabase CLI's metadata table) or count files at build time and surface via env. Also: make `CRITICAL_TABLES` a config-driven list per vertical.

### Effort

S.

### 5-axis score

PSev 1, MDiff 1, TLev 1, EStr 2, SFit 2. **7/25**.

### Deep-dive prompt

> Replace the hard-coded `migration_count: 10` with a query against `supabase_migrations.schema_migrations`. Make `CRITICAL_TABLES` read from a per-vertical config file in `src/api/_lib/critical-tables.js`.

---

## F11.18 No "ready for production" pre-flight matrix in Admin Center. P2.

### Problem

A new tenant must configure: Anthropic key (or Gemini fallback), Tally bridge URL/token, GSTN keys (if India), Stripe Connect, optionally Razorpay, optionally WhatsApp, optionally voice. There is no single view that lists "you have completed 7/14 setup steps". Diagnostics shows env vars only. The Admin Center "Integration Report" panel (mentioned in v1 of this doc, not in current main grep results) is reportedly a static feature-flag checklist.

### Current state on main

- `diagnostics.js:33-43` lists 9 integrations (Anthropic, Mistral OCR, ClamAV, Tally, GSTN, comms, email, FX, cron). `[verified-on-main]`
- `health.js:20-71` extends this to 24 surfaces. `[verified-on-main]`
- No `setup_progress` view in Admin Center. `[inferred]`

### Proposed change

A "Setup checklist" tab in Admin Center with 14-20 steps (depending on tier and region). Each step shows status (ok / missing / partial), the underlying probe, and a one-click action when applicable (e.g. "Open Stripe Connect onboarding").

### Effort

M.

### 5-axis score

PSev 2, MDiff 2, TLev 2, EStr 3, SFit 4. **13/25**.

### Deep-dive prompt

> Build `api/admin/setup_progress.js` returning 14 status rows. Build `screens/admin.tsx` "Setup checklist" tab. Hook the per-row action button into the existing integration endpoints (`stripe/connect_onboard`, `razorpay/connect`, etc.).

---

## F11.19 Member invite has no rate limit or anti-abuse. P2.

### Problem

`admin/members.js:53-86` exposes a POST that calls `svc.auth.admin.inviteUserByEmail(body.email)` per request. Supabase rate-limits this internally but the Anvil tier above does not. An admin running a leaked Anvil session token could spam invites to a Russian disposable-email service.

### Current state on main

- `members.js:53-86` POST creates invites. `[verified-on-main]`
- No rate limit on `members.js`. `[verified-on-main]`
- `_lib/rate-limit.js` exists per `webhookIpRateLimit` import in `stripe/webhook.js:19`. `[verified-on-main]`

### Proposed change

Add `requestRateLimit(req, "member_invite", {maxPerMinute: 5, maxPerHour: 50})` at the top of the POST branch.

### Effort

S.

### 5-axis score

PSev 3, MDiff 1, TLev 1, EStr 2, SFit 3. **10/25**.

### Deep-dive prompt

> Add a rate-limit check to `admin/members.js` POST and PATCH. Use the existing `_lib/rate-limit.js`. Document the limits in `docs/SECURITY.md`.

---

## F11.20 Spend visualization tied to no granular per-call USD persistence. P2.

### Problem

`cost/breakdown.js:8-22` computes USD by reading `orders.api_usage` (the order-level rollup) and applying a hard-coded PRICING table. But the source of truth, `model_routing_log`, persists `total_input_tokens` and `total_output_tokens` without USD. So a price change in Anthropic's pricing card requires a code change. Cache-creation and cache-read tokens are summed at compute time, not at insert time.

### Current state on main

- `model_routing_log` columns: `total_input_tokens`, `total_output_tokens`, `total_cache_creation_input_tokens`, `total_cache_read_input_tokens` (inferred from `cost/breakdown.js:18-21`). `[verified-on-main]`
- No `usd_estimate` column. `[inferred]`
- The PRICING table is defined in two places (`breakdown.js:8-12` and `simulator.js:8-12`).

### Proposed change

Migration `111_model_routing_log_usd.sql` adds:

```sql
alter table model_routing_log
  add column if not exists usd_estimate numeric(10,6),
  add column if not exists pricing_version text;
```

Update `_lib/anthropic.js:246-258` to compute and persist `usd_estimate` at insert time using a centralized `_lib/pricing.js`. Add a `pricing_versions` table to track historical Anthropic prices, with a per-row reference back so re-pricing is straightforward.

### Effort

S.

### 5-axis score

PSev 2, MDiff 2, TLev 3, EStr 3, SFit 3. **13/25**.

### Deep-dive prompt

> Migration `111_model_routing_log_usd.sql` per F11.20. Build `_lib/pricing.js` with `usdForUsage(model, usage, pricingVersion)`. Update `_lib/anthropic.js` insert path. Refactor `cost/breakdown.js` to read `usd_estimate` directly. Build `api/admin/pricing_versions.js` for the historical view.

---

## Section 2: Three-tier pricing model, the full proposal

(Refining F11.6 with explicit per-meter prices and Stripe SKU layout.)

### Tier breakpoints anchored on observed metrics

From `_lib/outcomes.js`, the 12 outcomes are:

1. `order_processed` (50c each)
2. `order_pushed` (100c each)
3. `quote_drafted` (25c each)
4. `invoice_generated` (50c each)
5. `payment_collected` (100c each)
6. `approval_decision` (10c each)
7. `document_extracted` (10c each)
8. `communication_sent` (10c each)
9. `service_visit_closed` (50c each)
10. `agent_action` (5c each)
11. `anomaly_resolved` (25c each)
12. `drift_check_run` (2c each)

Of these, only 1-3 (`order_processed`, `order_pushed`, `quote_drafted`) are the "headline" outcomes that map to the tier-included SO volume. The others should NOT be billed as separate meters by default; they are cost-attribution detail.

### Suggested Stripe SKU layout, full

```
Products (one per tier x per cadence):

prod_anvil_starter_monthly   - $179/mo
prod_anvil_starter_annual    - $1,824/yr ($152/mo equivalent, no discount; Starter price is already aggressive)
prod_anvil_growth_monthly    - $599/mo
prod_anvil_growth_annual     - $6,108/yr (15% off; $509/mo equivalent)
prod_anvil_enterprise_monthly - $1,199/mo (base; usually negotiated up)
prod_anvil_enterprise_annual  - $11,510/yr (20% off; $959/mo equivalent)

Meters (one per billable outcome):

anvil_order_processed          (price: $0.50/event, applied above tier-included threshold)
anvil_order_pushed             (price: $1.00/event, applied above tier-included threshold)
anvil_document_extracted       (price: $0.02/event for OCR overage)

Tier-included volumes for meter rollup (zero billed below threshold):

Starter:    200 orders_processed   2,000 documents_extracted
Growth:   1,000 orders_processed  10,000 documents_extracted
Enterprise: 5,000 orders_processed  50,000 documents_extracted

Add-on subscriptions (one per add-on per tier):

prod_anvil_addon_drift_starter      ($24/mo + meter)
prod_anvil_addon_drift_growth       (free through 2026-12-31, then $42/mo + meter)
prod_anvil_addon_drift_enterprise   (included)
prod_anvil_addon_voice_growth       ($30/mo + per-minute meter)
prod_anvil_addon_voice_enterprise   (included up to 500 min)
prod_anvil_addon_brsr_growth        ($30/mo)
prod_anvil_addon_brsr_enterprise    (included)
prod_anvil_addon_treds_growth       ($60/mo)
prod_anvil_addon_treds_enterprise   (included)
prod_anvil_addon_conformal_growth   ($36/mo)
prod_anvil_addon_conformal_enterprise (included)
```

### Razorpay equivalents

INR-denominated equivalent of the above. Razorpay supports Plans (recurring) and Subscription Add-ons (metered, per-period). One Plan per (tier x cadence). One Add-on per metered outcome per period.

Razorpay does not support per-event metering as Stripe Meters do; the platform model is "calculate-and-create-the-Add-on" at period end. The `recordRazorpayUsage` helper in `_lib/razorpay-client.js:81-102` is the right pattern.

### Cross-reference to Indian competitors (where public)

| Vendor | Public price | Anvil position |
|---|---|---|
| ClearTax GST | ~Rs 40k/yr for 300 GSTINs / 3000 invoices | Starter monthly is Rs 14,990; for 1 GSTIN with 200 SOs/mo Anvil is ~5x more expensive but does far more |
| Rossum | ~$1,500/mo per 1000 documents | Anvil Growth is $599/mo + included 10k OCR pages; ~4x cheaper |
| Hyperscience | $100k+/yr starting | Anvil Enterprise at $14k/yr starting is ~7x cheaper at the entry point |
| TallyPrime 7.0 Silver | Rs 22,500 lifetime / Rs 750/mo rental | Anvil sits on top; not a price competitor |
| BlackLine | $77k median / $340k peak | Anvil drift add-on at Rs 2k-3.5k/mo is the disruption |

`[verified-from-prior-knowledge]` for Rossum, Hyperscience, BlackLine, ClearTax public bands; `[verified-on-main]` for TallyPrime cross-references in `STRATEGIC_BET_05_tally_drift_paid_sku.md:55`.

### Per-meter idempotency

Stripe Meters dedupe on `identifier`. Razorpay Add-ons do not have a server-side dedupe; the partial-index pattern in migration `097` is the right local dedupe.

### Tier upgrade triggers

Built into the daily cron. Logic:

- If a tenant exceeded the next tier's included SO volume for 2 consecutive months: insert `admin_notifications.kind='upgrade_recommended'`.
- If a tenant is at <20% of their tier's included volume for 3 consecutive months: insert `admin_notifications.kind='downgrade_advised'`.
- Auto-upgrade is NOT proposed.

### Annual prepay

- Starter: no discount (price is the floor).
- Growth: 15% off.
- Enterprise: 20% off, plus a custom Master Services Agreement.

### Currency

- INR: native for Indian tenants.
- USD: Gulf, UK, Singapore tenants. Use the FX rate from `fx_rates` cached daily.
- AED: Gulf-only product if commercial pulls demand. Same Stripe product configuration as USD, with a localized invoice line.

---

## Section 3: SLO catalog (cross-reference for F11.2)

| Surface | Indicator | Target | Window | Source |
|---|---|---|---|---|
| Extraction accuracy | `eval_runs.score` median for "golden_so" | 95% | 7d | `eval_runs` |
| Extraction p95 | `processing_events.duration_ms p95` for `event_type=so_extracted` | < 60s | 7d | `processing_events` |
| Tally push success | `audit_events action=tally_push` with `detail.status=ok` | 99% | 30d | `audit_events` |
| GSTN e-invoice | `audit_events action=einvoice_generated` success ratio | 98% | 30d | `audit_events` |
| WhatsApp send | `audit_events action=comm_send` channel=whatsapp `detail.status=delivered` | 95% | 7d | `audit_events` |
| API availability | `health.db_ok` | 99.5% | 30d | health probe history (NEW: needs persistence) |
| Cron freshness | `cron_health.last_status='ok'` | 99.9% | 30d | `cron_health` |
| Drift reconciler closeout | `audit_events action=tally_drift_resolved / tally_drift_detected` | 95% | 30d | `audit_events` |

The health probe history is new; need a `health_evaluations` table populated every 5 min by the tick cron.

---

## Section 4: Alert rule catalog (cross-reference for F11.9)

| Rule id | Source | Predicate | Severity | Channel |
|---|---|---|---|---|
| audit_member_revoke_burst | audit_events | count(action=member_revoke) >= 5 in 5min | sev2 | admin_notification + slack |
| audit_force_llm_fallback_toggle | audit_events | count(action=force_llm_fallback) > 0 in 1min | sev3 | admin_notification |
| processing_p95_so_extraction_high | processing_events | p95(duration_ms) > 90000 in 30min | sev2 | slack |
| cron_tick_stale | cron_health | age('cron/tick') > 15min | sev1 | pagerduty |
| cron_daily_stale | cron_health | age('cron/daily') > 30h | sev1 | pagerduty |
| slo_extraction_burn_fast | slo_evaluations | 2% of monthly budget in 1h | sev2 | slack |
| slo_extraction_burn_slow | slo_evaluations | 10% of monthly budget in 6h | sev3 | admin_notification |
| model_routing_opus_spike | model_routing_log | count(model='opus') > 1000 in 1h | sev1 | slack |
| audit_failures_growing | audit_failures | count > 10 in 1h | sev1 | pagerduty |
| payment_received_anomaly | audit_events | std-dev > 3 over 24h | sev3 | admin_notification |
| tally_push_failure_burst | audit_events | count(action=tally_push_failed) >= 10 in 30min | sev2 | slack |
| gstn_circuit_open_long | audit_events | action=einvoice_circuit_open present > 30min | sev2 | slack |

---

## Section 5: Incident severity matrix (cross-reference for F11.8)

| Severity | Examples | Response time | Communication |
|---|---|---|---|
| sev1 | Cron stalled, DB unreachable, full GSTN outage, Tally bridge down for >1 tenant, audit_failures spike | 15 min ack, 1h mitigate | Status page update within 15 min, hourly thereafter |
| sev2 | Single-tenant ERP push failures, p95 elevated, slow extraction | 1h ack, 4h mitigate | Status page update within 1h |
| sev3 | Non-critical degradation, single failed cron job, one customer's WhatsApp number unreachable | 4h ack, 1 business day mitigate | Internal Slack only unless escalated |

---

## Section 6: Cron health budget (cross-reference for F11.11)

From `health.js:94-104`:

| Worker | Cadence | Max acceptable age | What it covers |
|---|---|---|---|
| cron/tick | 5 min | 10 min | 17 ERP retries, push notifications, inbound email parse, queue consumers |
| cron/daily | 24h | 30h | Analytics refresh, FX, AMC, RLHF, quote expiry, recurring invoice, e-Way bills, catalog embed, drift report |
| agents/run | 60 min | 2h | Autonomous follow-up agents |
| eval/agent_eval | hourly (offset min=5) | 2h | Agent eval harness |

Each sub-handler inherits the parent cadence unless overridden. The sub-handlers listed in `cron/tick.js:84-129` include 17 ERP syncs and 17 retries; cron stalls cascade.

---

## Section 7: Deploy events and change-management evidence (SOC 2 CC8.1)

Migration `079_deploy_events.sql` adds a `deploy_events` table with `provider`, `environment`, `deployment_id`, `url`, `commit_sha`, `branch`, `state`, `ts`, `meta`. Indexes on (environment, ts), (branch, ts), (commit_sha). Vercel deploy hook fires `/api/deploys` per the migration comment lines 4-7.

**Gap**: no UI surface for the deploy log. The auditor extracts it via SQL during the SOC 2 evidence pull. A `GET /api/admin/deploys` admin endpoint with the relevant columns and a date filter would let the auditor self-serve. Recommend adding it to the F11.18 "Setup checklist" tab as a sub-card.

---

## Deep-dive prompts collated

1. **F11.1**: Build `src/api/_lib/cost-status.js` with `assessTenantCost(ctx, intent)` returning rule + decision. Wire into `_lib/anthropic.js` and `_lib/docai/run.js`. Migration `099_cost_status.sql`. New Admin Center "Spend" tab. Default flag off.
2. **F11.2**: Land migration 099 with `slo_targets` and `slo_evaluations`. Seed 8 SLOs. Build `_lib/slo.js` with per-target indicator queries. Hook into `cron/daily.js`. Add Admin Center SLOs tab. Burn-rate alerter into admin_notifications + optional webhook.
3. **F11.3**: Migration 100 (incidents) + 101 (status_subscribers). Build `api/status/public.js`, `api/admin/incidents.js`, `api/status/subscribe.js`. Add `public/status.html`. Add RSS feed.
4. **F11.4**: Migration `102_outcomes_billing_meter.sql`. Build `_lib/outcomes-meter.js` with `drainOutcomesOnce`. Build `cron/outcomes-meter.js`. Wire into `cron/daily.js`. Pre-create 12 Stripe meters via env vars.
5. **F11.5**: Edit `docs/BILLING_OUTCOMES.md` clarification. Add `tenant_settings.tier_id` + `tiers` table. Refresh Admin Center Billing tab. Build `api/billing/projection.js`.
6. **F11.6**: Migration `103_pricing_v2.sql` per the tier matrix. `scripts/seed-stripe-pricing.mjs` to pre-create products / prices / meters. Build `api/billing/quote.js`. Build public `/pricing` page.
7. **F11.7**: Migration `104_subscription_cadence.sql`. Update Stripe seed script with annual prices. Update quote endpoint.
8. **F11.8**: Add `docs/INCIDENT_RESPONSE.md` with 6 sections. Cross-link from CRONS, SECURITY, README. One runbook per surface.
9. **F11.9**: Migration `105_alerts.sql`. Build `_lib/alerts.js` with per-source evaluator. Build `cron/alerts.js` at 5-min cadence. Seed 12 rules. Wire dispatch channels.
10. **F11.10**: Migration `106_processing_event_trace.sql` adds trace_id, parent_event_id, started_at. Update `_lib/audit.js recordEvent`. Add SO intake trace start. Add `api/events/trace/[id].js`. Render waterfall in case-detail screen.
11. **F11.11**: Migration `107_cron_health_region.sql`. Update `recordCronHeartbeat` to read VERCEL_REGION. Update `health.js probeCron`.
12. **F11.12**: Migration `108_audit_partitioning.sql`. Add `cold_audit_events` archive table. Update audit query to UNION ALL hot + cold.
13. **F11.13**: Migration `109_data_exports.sql`. `api/admin/export.js` enqueues. `_lib/data-export.js` does the dump. Cron drains. Resend emails a link.
14. **F11.14**: Create `_lib/rbac.js`. Refactor `auth.js`, `members.js`, `access_requests.js`. Migration `110_role_enum.sql`. Wire `audit-rbac.mjs` into CI.
15. **F11.15**: Refactor `install_vertical_pack.js` to write a `vertical_pack_installs` ledger. Add `api/admin/uninstall_vertical_pack.js`.
16. **F11.16**: Create `.github/workflows/cron-tick-fallback.yml` at 15-min cadence. Document dual-source in `docs/CRONS.md`.
17. **F11.17**: Replace hard-coded `migration_count` with `supabase_migrations.schema_migrations` query. Move `CRITICAL_TABLES` into `_lib/critical-tables.js`.
18. **F11.18**: Build `api/admin/setup_progress.js` returning 14 status rows. Add "Setup checklist" tab in Admin Center.
19. **F11.19**: Add rate-limit check to `admin/members.js` POST and PATCH. Document in `docs/SECURITY.md`.
20. **F11.20**: Migration `111_model_routing_log_usd.sql`. Build `_lib/pricing.js`. Update `_lib/anthropic.js` insert path. Refactor `cost/breakdown.js`. Build `api/admin/pricing_versions.js`.

---

## Section 8: Cross-cutting observations

### What `cron/tick.js` getting bigger means

`cron/tick.js` is currently 248 lines and imports 35 sub-handlers (17 ERP syncs, 17 retries, 1 PLM, plus 9 "always" workers, plus 2 "on the hour" workers). At every-5-min cadence, a single tick fires 26 handler invocations in the ALWAYS group and up to 17 more in the SYNCS group. This is structurally fine (it is a multiplexer), but at >40 sub-handlers per cycle the failure surface gets dense. Three follow-ups:

1. **Per-handler timeout**: today there is no per-handler timeout; one slow ERP sync at 60s would consume 60% of the Vercel function timeout. Recommendation: wrap each `runCronHandler` call in `Promise.race` against a 15s timeout.
2. **Failure attribution**: when 3 of 26 fail, the tick still returns 200. Recommend rolling the per-handler failure count into the alert engine (F11.9) with a "any-handler-failing" rule.
3. **Cold start cost**: each tick boots ~35 imported modules. At Vercel's per-invocation pricing, this is a measurable cold-start cost on the Hobby tier. The current consolidation is right for Hobby; on Pro, restoring per-handler cron entries would amortize cold starts.

### Observation: `model_routing_log` has no parent association

The 2026 Anthropic batch API (https://docs.anthropic.com/claude/docs/batch-api) `[verified-from-prior-knowledge]` lets you submit batches and get correlation_ids back. Anvil's `model_routing_log` does not carry a `batch_id` or `correlation_id`. If Anvil starts using batch (e.g. for catalog embedding in `cron/daily catalog/embed`), tracing back from a per-row entry to the batch becomes manual.

### Observation: `tenant_settings` is the bag

`tenant_settings` carries: Stripe Connect state, Razorpay creds, DocAI per-tenant model overrides, daily limits, drift add-on flags, vertical discriminator, etc. By migration count, it has at least 30 columns. This is fine today but at 100+ columns the operation cost of any single migration grows. Eventually split into `tenant_billing_settings`, `tenant_docai_settings`, `tenant_branding_settings`, `tenant_alert_settings`. Defer until the column count hits 60.

### Observation: audit log drill-through is partial

`screens/audit.tsx:13-29` maps 15 `object_type` strings to hash routes. The audit log writes 30+ distinct `object_type` values (one per the 96 actions in `outcomes.js`). The drill-through silently noops for 50% of rows. Should be a finding but is too narrow; folded into F11.18 setup-quality.

### Observation: no public roadmap or changelog

The repo has no `CHANGELOG.md` and no public roadmap surface. Buyers evaluating Anvil cannot see "what shipped last quarter" without asking sales. Linear (https://linear.app), Notion, and PostHog all publish weekly roadmaps + changelogs as a sales asset. Defer as a non-engineering recommendation.

### Observation: marketplace pricing is missing

`docs/STRATEGIC_BET_02_template_marketplace.md` exists (referenced in find output). Marketplace pricing should be added to F11.6 (template-downloads-included counts and the publisher royalty). The proposed pricing in F11.6 assumes a 25/75 to 50/50 royalty split; this is `[inferred]` from the bet doc, which should be the source of truth.

---

## Section 9: What would change if we built the top 6 findings

The top 6 findings (F11.1 cost status, F11.2 SLOs, F11.4 outcomes-to-Stripe, F11.6 pricing v2, F11.9 alerts, F11.16 cron fallback) together cover:

- Closed-loop cost attribution and per-tenant budget enforcement
- Quantified service-level commitments tied to the published SLA
- Automated invoicing tied to the audit log
- Pricing that scales with actual usage variables
- Multi-channel alert dispatching with sev1/2/3 routing
- Cron resiliency against single-scheduler failure

Effort total: M + L + M + L + L + S = ~14-18 engineer-weeks. Recommended sequencing:

- Week 1-2: F11.16 (cron fallback, doc-only) + F11.8 (incident response runbook, doc-only)
- Week 3-4: F11.1 (cost status) + F11.20 (usd persistence on model_routing_log)
- Week 5-8: F11.2 (SLO targets and burn-rate alerter)
- Week 9-12: F11.4 (outcomes-to-Stripe) + F11.5 (price reconciliation)
- Week 13-18: F11.6 (pricing v2) and F11.9 (alerts)
- Week 19+: F11.3 (status page), F11.7 (annual), F11.10 (traces), F11.12 (retention), F11.13 (export)

The dependency graph: F11.2 (SLOs) feeds F11.9 (alerts); F11.4 (Stripe meter drain) depends on F11.5 (pricing reconciliation); F11.6 depends on F11.4 + F11.5; F11.3 (status page) consumes F11.2 + F11.9.

---

## Section 10: Quick-win micro-findings (under 1 day each, not full findings)

These are smaller observations that did not justify the full finding template but are worth landing.

- **m1**: `diagnostics.js:147` `migration_count: 10` is a literal that does not reflect 103 actual migrations. Two-line fix (F11.17 covers this).
- **m2**: `_lib/auth.js:33` and `members.js:13` and `access_requests.js:23` disagree on role names. CI script absent (F11.14 covers).
- **m3**: `audit.tsx:13-29` covers 15 of ~30 object types. Add the missing 15 in one PR.
- **m4**: `health.js` does not return the integration health for `STRIPE_DRIFT_METER_NAME` (Bet 5 env var). Add.
- **m5**: `BILLING_OUTCOMES.md` says "There is no Stripe Connect or invoice generator wired yet" but `api/billing/stripe/checkout.js` exists. Update copy.
- **m6**: `recurring.js:17` cadence enum is uppercase (`MONTHLY|QUARTERLY|...`); other enums in the codebase are lowercase. Normalize.
- **m7**: `members.js:13` `ALLOWED_ROLES` includes `approver` which is not defined elsewhere. Either drop or define.
- **m8**: `outcomes.js:67` `approval_decision` action maps to the same outcome name; this is a no-op string. Document.
- **m9**: `cost/breakdown.js:18-21` hard-codes cache multipliers (1.25 for cache create, 0.10 for cache read). These should be in `_lib/pricing.js`.
- **m10**: `_lib/anthropic.js:246-258` uses `safeAwait` which silently swallows errors on the model_routing_log insert; this could mask a runaway cost bug. Recommend a sentinel pattern similar to audit_failures.
- **m11**: `cron/drift-meter.js:71-86` skips both `trial` and `enterprise` plans, but still calls `update()` to stamp `reported_at`. This is correct (drops them out of the partial index), but the comment block should explicitly say "this is intentional dedup hygiene, not a billing event".
- **m12**: `processing_events` has no enum for `event_type`. New event types are silently free-form. Recommend a CHECK constraint or a soft validation that warns on unknown types.

---

## Verification index

Files read on main during this session (all paths absolute):

- `/Users/kenith.philip/anvil/src/api/admin/diagnostics.js`
- `/Users/kenith.philip/anvil/src/api/admin/members.js`
- `/Users/kenith.philip/anvil/src/api/admin/access_requests.js`
- `/Users/kenith.philip/anvil/src/api/admin/access_review.js`
- `/Users/kenith.philip/anvil/src/api/admin/notifications.js`
- `/Users/kenith.philip/anvil/src/api/_lib/audit.js`
- `/Users/kenith.philip/anvil/src/api/_lib/auth.js`
- `/Users/kenith.philip/anvil/src/api/_lib/cron-mux.js`
- `/Users/kenith.philip/anvil/src/api/_lib/outcomes.js`
- `/Users/kenith.philip/anvil/src/api/_lib/stripe-client.js`
- `/Users/kenith.philip/anvil/src/api/_lib/razorpay-client.js`
- `/Users/kenith.philip/anvil/src/api/cost/breakdown.js`
- `/Users/kenith.philip/anvil/src/api/cost/simulator.js`
- `/Users/kenith.philip/anvil/src/api/cost/margin_history.js`
- `/Users/kenith.philip/anvil/src/api/billing/usage.js`
- `/Users/kenith.philip/anvil/src/api/billing/recurring.js`
- `/Users/kenith.philip/anvil/src/api/billing/stripe/checkout.js`
- `/Users/kenith.philip/anvil/src/api/billing/stripe/webhook.js`
- `/Users/kenith.philip/anvil/src/api/cron/daily.js`
- `/Users/kenith.philip/anvil/src/api/cron/tick.js`
- `/Users/kenith.philip/anvil/src/api/cron/drift-meter.js`
- `/Users/kenith.philip/anvil/src/api/health.js`
- `/Users/kenith.philip/anvil/src/v3-app/screens/admin.tsx` (first 100 lines)
- `/Users/kenith.philip/anvil/src/v3-app/screens/audit.tsx`
- `/Users/kenith.philip/anvil/supabase/migrations/066_cron_health.sql`
- `/Users/kenith.philip/anvil/supabase/migrations/079_deploy_events.sql` (head)
- `/Users/kenith.philip/anvil/supabase/migrations/093_cost_optimized_adapters.sql` (head)
- `/Users/kenith.philip/anvil/supabase/migrations/097_tally_drift_addon.sql` (head)
- `/Users/kenith.philip/anvil/vercel.json`
- `/Users/kenith.philip/anvil/docs/PRICING_STRATEGY.md`
- `/Users/kenith.philip/anvil/docs/BILLING_OUTCOMES.md`
- `/Users/kenith.philip/anvil/docs/CRONS.md`
- `/Users/kenith.philip/anvil/docs/STRATEGIC_BET_05_tally_drift_paid_sku.md` (first 120 lines)

External sources cited inline as `[verified-from-prior-knowledge]` with URL:

- https://docs.stripe.com/api/meters
- https://docs.stripe.com/billing/subscriptions/usage-based
- https://www.getlago.com/
- https://www.withorb.com/
- https://metronome.com/
- https://www.m3ter.com/
- https://razorpay.com/docs/payments/subscriptions/
- https://sre.google/sre-book/service-level-objectives/
- https://www.honeycomb.io/blog
- https://docs.datadoghq.com/tracing/
- https://docs.datadoghq.com/llm_observability/
- https://docs.datadoghq.com/monitors/
- https://docs.sentry.io/
- https://linear.app/pricing
- https://linear.app/status
- https://stripe.com/pricing
- https://www.atlassian.com/software/statuspage
- https://www.atlassian.com/incident-management/handbook
- https://response.pagerduty.com/
- https://github.com/getlago/lago
- https://rossum.ai/pricing/
- https://www.hyperscience.com
- https://www.blackline.com
- https://www.techjockey.com/detail/cleartax-gst-software
- https://help.tallysolutions.com/release-notes-tallyprime-7-0/
- https://www.anthropic.com/pricing
- https://docs.anthropic.com/claude/docs/batch-api
- https://www.twilio.com/pricing
- https://opentelemetry.io/docs/concepts/signals/traces/
- https://docs.github.com/en/account-and-profile/setting-up-and-managing-your-personal-account-on-github/managing-personal-account-settings/requesting-an-archive-of-your-personal-account-s-data
- https://helicone.ai
- https://betterstack.com/status-page

End of A11 v2 deep-dive.
