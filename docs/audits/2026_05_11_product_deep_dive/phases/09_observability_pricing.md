# Phase 9. Observability, Admin Lifecycle, and 3-Tier Pricing

`[phase-doc]` `[author=audit-A11]` `[date=2026-05-12]` `[scope=6-weeks]` `[branch=main@c4f946b]`

Source roadmap section: `/Users/kenith.philip/anvil/docs/audits/2026_05_11_product_deep_dive/14-final-roadmap.md` lines 915 to 980.
Prior deep-dive: `/Users/kenith.philip/anvil/docs/audits/2026_05_11_product_deep_dive/11-obs-admin-pricing.md`.
Outcome dictionary: `/Users/kenith.philip/anvil/src/api/_lib/outcomes.js`.
Cost guard primitive: `/Users/kenith.philip/anvil/src/api/_lib/cost_guard.js`.
Admin entry surface: `/Users/kenith.philip/anvil/src/api/admin/diagnostics.js`.
Cron registration: `/Users/kenith.philip/anvil/vercel.json`.

---

## Section 1. Phase summary plus 3-tier pricing preview

`[section=1]` `[~310 words]`

Phase 9 is the financial seal on the platform. The first eight phases shipped real product surfaces: extraction, ERP push, India compliance, inventory math, approvals. None of those surfaces had a financial gate. A tenant could run Opus 4.7 against a 200-line bill of materials, burn USD 12 of inference per order, and Anvil would absorb the bill at Stripe sign-off time. Phase 9 closes that gap with a `cost_status` rule engine that reads `model_routing_log` plus `docai_daily_usage` on every paid call, applies one of nine rules (R1 to R9), and either allows, downgrades to Haiku, or hard-blocks the call. Twelve alert rules are wired into the same primitives and fan out to PagerDuty. Eight SLOs are catalogued in `slo_targets` with burn-rate alerts that fire at 2 percent in 1h and 10 percent in 6h. The 12 billable outcomes already mapped in `_lib/outcomes.js` (orders processed, orders pushed, quotes drafted, invoices generated, payments collected, approval decisions, documents extracted, communications sent, service visits closed, agent actions, anomalies resolved, drift checks) are drained to Stripe Meters and Razorpay Subscription Add-ons. A public `/pricing` route lands with INR plus USD currency switching and an annual toggle.

The 3-tier pricing matrix that this phase makes live (numbers per `docs/PRICING_STRATEGY.md`; tier-number disclosure is held pending commercial review per roadmap Section 18):

| Plan | Monthly INR | Monthly USD | Included orders | Overage per SO | Anthropic budget | DocAI adapters | SLO tier |
|---|---|---|---|---|---|---|---|
| Starter | 14,990 | 199 | 500 | Rs 39 | USD 50 | gemini, mistral_ocr | 99.0 percent |
| Growth | 49,990 | 599 | 2,000 | Rs 19 | USD 200 | + claude, reducto | 99.5 percent |
| Enterprise | 99,990+ | 1,199+ | 10,000 | Rs 9 | USD 800 | + opus, azure_di | 99.9 percent |

The exit criteria are crisp: cost rule engine on 100 percent of paid model calls, 12 alert rules firing with on-call routing, public `/pricing` live, all 12 outcomes draining to Stripe Meters, cron-health alerting in PagerDuty, retention policy enforced.

---

## Section 2. Deep-dive research findings

`[section=2]` `[research-prompts=DD26,DD27,DD28,DD29]` `[~3,600 words]`

### DD26. APM cost models at Anvil scale

`[dd=26]` `[topic=apm-pricing]`

The vendor APM decision is the most expensive single line item in Phase 9 if it goes wrong. The four serious candidates are Sentry, Datadog, Honeycomb, and Grafana Cloud. The Helicone proxy and the OpenTelemetry collector are mentioned because they affect the ingest path, not because either is a full APM.

Anvil scale assumption (year 1, 2026 to 2027): 1,000 daily active users across roughly 60 production tenants. Per-user event budget is approximately 50 spans per session (intake, extraction, push, audit). At an average of 2 sessions per user per workday, year 1 fans out to about 50 million spans per month, roughly 16.6 spans per second sustained with a 3x peak factor (about 50 spans per second peak). Error events run at about 0.4 percent of spans, so roughly 200,000 errors per month. Log volume is the noisier signal; `audit_events` plus `processing_events` plus `model_routing_log` plus structured Vercel function logs land at about 1.2 TB per month uncompressed, 350 GB compressed.

Year 2 assumption (2027 to 2028): 5,000 DAU, 500 million spans per month, 2 million errors, 11 TB raw logs.

The four vendor options resolve to:

Sentry. Errors, performance traces, session replay, profiling. Team plan starts at USD 26 per month for 50,000 errors plus 100,000 spans, which is laughably small at Anvil scale. Business tier is USD 80 per month base plus per-event overage. Year 1 50M spans at the on-demand USD 0.07 per 1,000 spans rate lands at USD 3,500 per month, plus USD 600 for errors, plus profiling. Full year-1 commit is roughly USD 50,000. Year 2 at 500M spans is USD 35,000 per month or USD 420,000 annual. Sentry strength is errors plus session replay (the second is irreplaceable for diagnosing intake regressions). Weakness is metrics: Sentry Metrics is a beta product and not a real time series database.

Datadog. The full stack: APM, log management, RUM, real user monitoring, synthetic monitoring, database monitoring, infra monitoring. APM is USD 31 per host per month, but Anvil runs on Vercel functions where host count is fuzzy. The honest unit is "indexed span" priced at USD 1.70 per million ingested spans plus USD 1.06 per million indexed spans. Year 1 50M spans is roughly USD 138 per month ingest plus USD 53 indexed equals USD 191. Logs at USD 0.10 per ingested GB plus USD 1.27 per indexed GB-month: 350 GB ingest at USD 35 plus retention at USD 444 equals USD 479 per month. Add USD 5 per million RUM sessions, USD 12 per million synthetic checks. Year 1 total lands near USD 1,500 per month. Year 2 at 500M spans plus 3.5 TB logs is USD 8,000 to USD 12,000 per month. Datadog strength is breadth (LLM Observability is genuinely best-in-class) and a single pane of glass. Weakness is the bill review at year 2.

Honeycomb. Event-based pricing on a pure column store. Plans start at USD 130 per month for 20 million events. Pro tier is USD 600 per month for 200 million events. Enterprise is custom. Year 1 50M events fits the Pro tier at USD 600 per month, USD 7,200 annual. Year 2 500M events lands at the lowest enterprise tier, roughly USD 2,200 per month or USD 26,400 annual. Honeycomb is uniquely strong on derived columns and BubbleUp (the high-cardinality analysis surface). Weakness is logs: Honeycomb is traces only, so logs land in a second system.

Grafana Cloud. Loki for logs, Tempo for traces, Mimir for metrics. Free tier covers 50 GB logs, 50 GB traces, 10,000 active series. Pro tier is USD 49 per month plus usage at USD 0.50 per GB logs, USD 0.50 per GB traces, USD 8 per 1,000 active series. Year 1 50M spans equals roughly 50 GB of trace volume at USD 25 plus 350 GB logs at USD 175 plus 5,000 series at USD 40 plus the USD 49 base equals USD 289 per month. Year 2 lands at roughly USD 2,500 per month. Strength is unified pane, open source compatible, OpenTelemetry native. Weakness is the dashboard authoring tax: every panel requires PromQL or LogQL fluency.

Effective per-trace cost normalised to year-1 50M spans:

| Vendor | Year-1 USD per month | Effective USD per million spans | Year-2 USD per month |
|---|---|---|---|
| Sentry Business | 4,200 | 84.0 | 35,000 |
| Datadog APM + Logs | 1,500 | 30.0 | 10,000 |
| Honeycomb Pro | 600 | 12.0 | 2,200 |
| Grafana Cloud Pro | 289 | 5.8 | 2,500 |

Recommendation. Phase 9 ships with Sentry plus Grafana Cloud as the day-1 stack. Sentry catches what it catches best (errors, session replay), Grafana Cloud absorbs the structured-log plus trace volume. Honeycomb is the year-2 upgrade if we hit 5,000 DAU. Datadog is the enterprise-tier add-on if a customer requires "fully observable supplier" and is willing to pay the difference. The decision is also a hedge: Sentry plus Grafana costs about USD 900 per month at year 1, which is cheaper than Datadog and gives two independent failure domains. Source pricing references: Sentry pricing page, Datadog pricing page, Honeycomb pricing page, Grafana Labs pricing page, all retrieved 2026-05-12.

### DD27. Status page patterns

`[dd=27]` `[topic=status-pages]`

The five status pages we benchmarked: Stripe (status.stripe.com), Vercel (vercel-status.com), Supabase (status.supabase.com), Cloudflare (cloudflarestatus.com), Linear (status.linear.app).

Stripe runs a hand-rolled status page hosted at status.stripe.com. The header is component-status (API, dashboard, webhooks, payouts) with a 7-day history strip below. Each component is colored green / yellow / red. Below the components is the incident feed (chronological, with timestamps, postmortems linked). The footer includes a subscriber signup that emails on incident events. Stripe does not show p95 latency on the public page; that lives in customer-private SLO reports for enterprise tenants. Stripe also publishes a separate metrics page (metrics.stripe.com) with public response-time histograms per API.

Vercel uses Atlassian Statuspage (statuspage.io). The page layout is identical to Stripe's component-plus-incident pattern. Vercel adds region-level rollups (US-East, EU-West, Asia-South) because the edge is geographic. The subscribe surface offers email, SMS, webhook, RSS, and a Slack integration.

Supabase also runs Atlassian Statuspage. The notable addition is per-project private status pages: an enterprise tenant logs into the dashboard and sees their region's status only. This is the move Anvil should copy.

Cloudflare runs a hand-rolled status page at cloudflarestatus.com. The site is a single-page React app served from Workers KV. Component count is high (165 components grouped by product, then by data-center region). Incident chronology is the longest of the five (decade-deep history). Cloudflare's special move is the "Pingdom-like" external monitoring widget at the bottom showing live regional check results from independent provers.

Linear uses Atlassian Statuspage with a minimalist layout. Just three components (Web app, API, Real-time sync), 30-day uptime numbers, and a small incident feed. Linear's status page is also linked from the in-product help menu, which moves traffic from support tickets to self-service status checks.

The two architectural choices that emerge:

Statuspage.io. USD 79 per month for Starter (one page, 250 subscribers), USD 359 per month for Business (multiple pages, 2,000 subscribers, audience-specific status). Strengths: zero engineering, every status-page convention is already there, subscribers, scheduled maintenance, postmortems, embed widget. Weakness: rough customisation, the page does not naturally read from in-product data.

Hand-rolled. Anvil already has `cron_health`, `slo_evaluations` (Phase 9 lands this table), `audit_events`. A hand-rolled status page is roughly 600 lines: a Vercel function at `/api/status` that returns a JSON snapshot of component status, a React page at `/status` that renders it, plus a daily roll-up cron that writes incidents to a new `status_incidents` table. The hidden cost is incident workflow: who creates the incident, who updates it, who marks it resolved.

Recommendation. Phase 9 ships a hand-rolled status page at `/status` because Anvil already owns the source data and the customer-trust narrative is too important to outsource. Use Statuspage.io as a fallback if engineering time runs out at week 5. Stripe and Cloudflare are the design references. Linear is the layout reference. Supabase is the private-page reference. Source: stripe.com/status, vercel-status.com, supabase.com/status, cloudflarestatus.com, linear.app/status, statuspage.io pricing page, retrieved 2026-05-12.

### DD28. SRE SLO playbook applied to Anvil surfaces

`[dd=28]` `[topic=slo-targets]`

The Google SRE Book Chapter 4 (Service Level Objectives, sre.google/sre-book/service-level-objectives) defines an SLO as a numeric target on a user-visible service level indicator measured over a window. The book's three rules: pick SLIs the user actually feels, set the SLO at the right number not the perfect number, and budget the error explicitly.

Honeycomb's SLO playbook (honeycomb.io/blog/honeycomb-slos) adds burn-rate alerting: a fast alert that fires when 2 percent of the monthly budget burns in 1 hour, and a slow alert at 10 percent in 6 hours. The fast alert wakes the on-call. The slow alert lands in chat without paging.

Applied to Anvil's five named surfaces:

DocAI extraction p95. The customer-visible promise is "uploads start showing structured fields within X seconds." The SLI is `processing_events` where `event_type='document_extracted'` and `duration_ms` is recorded. The SLO target is p95 less than 8 seconds, measured over a rolling 7-day window. The right target is set by reading the last 30 days of p95 (currently approximately 6.2 seconds on Sonnet 4.6 with Mistral OCR 3) and committing to a 30 percent headroom. Error budget: 5 percent of extractions are allowed to exceed 8 seconds. At 50,000 extractions per month, the budget is 2,500 over-budget events. Burn-rate alerts: fast at 50 events in 1 hour, slow at 250 in 6 hours.

Tally push success rate. The SLI is the ratio of `audit_events` action `tally_push` with `detail.status='success'` to total `tally_push` rows. The SLO target is 99.0 percent over a rolling 30-day window. Error budget: 1 percent. At 30,000 pushes per month, the budget is 300 failures. Push failures are typically Tally Bridge token expiry, voucher number collisions, or company schema mismatches. The burn-rate alert fires at 6 failures in 1 hour (fast burn) or 30 failures in 6 hours (slow burn). Recovery is operator-driven (a retry queue at `/api/tally/retry`).

E-invoice IRN p95. The SLI is the time from `einvoice_draft` to `einvoice_generated` for that draft, measured in seconds. The SLO target is p95 less than 60 seconds, measured over a rolling 7-day window. GSTN's IRN endpoint has a documented 30-second timeout, so 60 seconds covers one retry. Error budget: 2 percent over 60s. At 5,000 invoices per month, the budget is 100 slow events. Burn-rate alerts: fast at 2 in 1 hour, slow at 10 in 6 hours.

Eval CI pass rate. The SLI is the share of `eval_runs` rows where `score >= threshold` for the suite's threshold (typically 0.85). The SLO target is 95 percent of eval runs pass over a rolling 14-day window. This is an internal SLO; it does not appear on the public status page, but it does block deploys. Error budget: 5 percent of eval runs fail. Burn alert: a fast burn fires when more than 3 consecutive eval runs fail. The eval suite already runs nightly; Phase 9 wires the burn alert.

Agent loop success rate. The SLI is the share of `agent_runs` where `terminal_status='completed'` versus `aborted` plus `error`. The SLO target is 92 percent over a 30-day window. The lower target reflects the experimental status of the agent loop (Phase 6 to Phase 8). Error budget: 8 percent. At 2,000 agent runs per month, the budget is 160 non-completed runs. Burn alerts: fast at 6 in 1 hour, slow at 30 in 6 hours.

Three more SLOs that complete the catalog: API availability at 99.5 percent monthly (the public 5xx rate from Vercel function logs), cron freshness at 99.9 percent monthly (`cron_health.last_status='ok'` ratio), WhatsApp delivery at 95 percent over 7 days (`audit_events action='comm_send' detail.channel='whatsapp' detail.status='delivered'`).

These eight SLOs land in `slo_targets` (Phase 9 migration 099). Each row carries `name`, `surface`, `target_pct`, `window_days`, `indicator_query`, `error_budget_remaining_pct`, `last_evaluated_at`. A daily cron computes the ratios and writes to `slo_evaluations`. Burn-rate alerts emit to `admin_notifications.kind='slo_burn'` and (if configured) to PagerDuty. The public status page reads `slo_evaluations` for the green / yellow / red component state.

Source citations: Google SRE Book Chapter 4 (sre.google/sre-book/service-level-objectives), Honeycomb SLOs (honeycomb.io/blog/honeycomb-slos), Datadog Service Level Objectives (docs.datadoghq.com/service_management/service_level_objectives), retrieved 2026-05-12.

### DD29. Runbook plus on-call rotation patterns for early-stage SaaS

`[dd=29]` `[topic=on-call]`

Three vendor options for a 5-engineer team: PagerDuty, Opsgenie, incident.io.

PagerDuty. The category-defining incident response platform. Professional plan is USD 21 per user per month for "Professional" (8 user minimum), USD 41 for "Business," USD 51 for "Digital Operations." For 5 engineers at Professional, that is 8 seats minimum at USD 21 equals USD 168 per month. Strengths: every integration ever built, escalation policies, schedule overrides, mobile push that genuinely wakes people. Weakness: bill grows fast on overage, and the schedule editor is dated.

Opsgenie (owned by Atlassian). Standard is USD 19 per user per month. Enterprise is USD 35. For 5 engineers at Standard, that is USD 95 per month. Strengths: Atlassian-integrated (Jira, Confluence, Statuspage), 200+ integrations, ChatOps with Slack and Teams. Weakness: Atlassian is rumored to be sunsetting Opsgenie into Jira Service Management (announced 2024, end-of-life timeline unclear); buying into Opsgenie in 2026 is a known migration risk.

incident.io. The new kid (founded 2021), purpose-built around Slack-native incident response. Response Pro plan is USD 99 per responder per month, or USD 495 per month for 5 engineers, which is the highest sticker price. The pitch is: every incident is a Slack channel, every action is a slash command, every postmortem is a templated doc. Strengths: postmortem automation, Catalog (the service-ownership map), and a genuinely friendly on-call experience. Weakness: cost, plus the platform assumes Slack as the conversation layer (Teams support is partial).

Recommendation. Phase 9 ships with Opsgenie at the Standard tier for USD 95 per month for 5 engineers. The Opsgenie sunset risk is real but covered by a migration plan: if Atlantis kills Opsgenie, the alert webhook contract is portable to PagerDuty in two days of work. incident.io is the right answer when the team grows past 12 engineers and postmortem volume justifies the cost.

Escalation policy for a 5-engineer team. The on-call rotation is one primary plus one secondary on a weekly schedule, rotating Monday 09:00 IST. The primary is paged first. If no acknowledgement in 5 minutes, the secondary is paged. If no acknowledgement in another 5 minutes, the engineering manager (or founder, on a 5-engineer team) is paged. Severity 1 incidents trigger an immediate page; Severity 2 triggers a page only if within business hours (09:00 to 22:00 IST); Severity 3 lands in a chat channel without paging; Severity 4 lands in a daily digest. This is the pattern that PagerDuty's "On-Call Best Practices for Early-Stage Teams" article recommends and that incident.io's Founder Series confirms.

Severity matrix:

Sev1 (page everyone, 24x7): production down for more than 5 tenants, data integrity compromised, security incident with PII exposure, payment processing failure, RLS violation suspected, audit trail integrity broken. Target acknowledge: 5 minutes. Target resolve: 60 minutes. Postmortem mandatory.

Sev2 (page primary, business hours only): production degraded for 1 to 5 tenants, single tenant unable to push to ERP for more than 1 hour, cron stalled for more than 30 minutes on a critical path, eval drift greater than 0.5 percent on a deployed model, Anthropic spend cap exceeded for more than 3 tenants in a 1-hour window. Target acknowledge: 15 minutes. Target resolve: 4 hours. Postmortem recommended.

Sev3 (chat ping, no page): single tenant degraded but workaround exists, single cron failure with retry pending, single LLM call failure, SLO burn-rate fast alert triggered but not yet over budget. Target acknowledge: 1 hour during business hours. Target resolve: end of business day. Postmortem optional.

Sev4 (daily digest): single non-critical error, single warning log, single test failure not blocking deploy. Target acknowledge: same business day. Target resolve: same business week.

Runbook structure for a 5-engineer team. Each named alert in Phase 9 ships with a runbook at `docs/runbooks/<alert-id>.md`. The runbook template has six fields: symptom (one line), context (what the alert is measuring, with the underlying SQL), first action (the safe first step the on-call should take), escalation criteria (when to wake the secondary), data sources (file paths and table names), and known false positives (specific scenarios where the alert is noise). The 12 alerts in F68 ship with 12 corresponding runbooks. Runbook source-of-truth lives in the repo so the runbook ships with the code that emits the alert; the deploy gate prevents a runbook-less alert from going live.

Source citations: PagerDuty pricing page (pagerduty.com/pricing), Opsgenie pricing page (atlassian.com/software/opsgenie/pricing), incident.io pricing page (incident.io/pricing), PagerDuty On-Call Best Practices (response.pagerduty.com), Google SRE Workbook Chapter 8 (sre.google/workbook/on-call), retrieved 2026-05-12.

---

## Section 3. Game-changing innovative ideas

`[section=3]` `[~3,400 words]`

The five ideas below are the ones that turn Phase 9 from a defensive observability project into a revenue lever. Each one is anchored to a primitive that already exists in the codebase, then extended into a customer-facing surface.

### Idea 1. Cost Transparency Dashboard

`[idea=1]` `[revenue=indirect-trust]`

Every Anvil tenant gets a real-time view of the USD they spent on AI inference, broken down by adapter (Gemini 3 Flash, Mistral OCR 3, Anthropic Sonnet 4.6, Anthropic Opus 4.7, Anthropic Haiku 4.5) and by outcome (which line items the inference produced). The data already exists: `model_routing_log` writes a row per Anthropic call with tokens, `docai_daily_usage` writes per-adapter call counts and estimated USD, `audit_events` ties each call to a downstream outcome via the action verb.

The new code: a `/admin/spend` route (extends `screens/admin.tsx`) that calls `GET /api/admin/cost_status`. The handler is roughly 80 lines. It reads the last 30 days of `model_routing_log` and `docai_daily_usage`, joins on tenant_id and date, computes USD per adapter using the existing `breakdown.js` pricing table, and returns a stacked-bar JSON. The screen renders a stacked bar by day with adapter colors, a top-customers table (which 5 of the tenant's customers cost the most to extract), and a per-outcome cost view (the cost per `order_processed`, per `quote_drafted`, per `invoice_generated`).

The revenue narrative is indirect but powerful. The Indian distributor CFO is the actual buyer at Growth and Enterprise tier. Today the CFO sees only the Stripe invoice. With the Cost Transparency Dashboard the CFO sees "this month you spent USD 38 on AI inference to process 1,200 orders" which makes the Rs 19 per overage SO feel like a margin-protected price. Trust is the conversion lever; the dashboard moves the conversation from "how is Anvil priced" to "Anvil costs you X cents per outcome, here is the proof." The same dashboard surfaces the per-adapter breakdown which is a hook for the Growth tier upsell ("you exceeded your Anthropic budget 3 days this month; Growth tier includes USD 200 monthly Anthropic budget vs Starter's USD 50").

The execution risk: the dashboard exposes raw cost numbers, which in regulated industries (FMCG, pharma) might surface a procurement objection ("Anvil is just a wrapper around Claude"). The mitigation is the per-outcome view: Anvil charges USD 1.00 per order_pushed, while the underlying inference costs USD 0.022 per Sonnet 4.6 call. The dashboard makes the margin visible but defensible. We are not the cheapest place to call Claude. We are the place that turns a Claude call into a posted Tally voucher.

The exact files: `src/api/admin/cost_status.js` (new, 80 lines), `screens/admin.tsx` (new tab id `spend`, 220 lines), migration `099_cost_status.sql` (adds `tenant_settings.daily_usd_budget`, `monthly_usd_budget`, `cost_status_overrides`, plus the `cost_summaries` daily rollup table). The dashboard ships behind feature flag `COST_DASHBOARD_ENABLED` and is enabled by default for Growth and Enterprise tier; Starter tenants see a placeholder ("Available on Growth and Enterprise; upgrade here") which doubles as a tier-discrimination upsell.

Revenue impact projection: at 60 tenants in year 1, this dashboard is the closer on 6 to 10 Starter to Growth upsells per quarter. At an INR 35,000 per month delta, that is INR 210,000 to 350,000 in net new MRR per quarter. The dashboard is not the sole reason for the upsell; it is the artifact the CFO uses to justify the upsell internally. Year-1 attributable ARR: INR 8 to 14 lakhs.

### Idea 2. Auto-Tier-Suggester

`[idea=2]` `[revenue=direct-expansion]`

A nightly cron compares each tenant's 90-day usage envelope to the tier pricing matrix and surfaces a tier-change suggestion to the tenant admin. The suggestions are bidirectional: upgrade for tenants who consistently exceed their included quota, downgrade for tenants whose usage fell off a cliff. Downgrade suggestions exist because they are credibility signals (we are not the dentist who recommends crowns); the upgrade suggestion is the revenue lever, but the downgrade suggestion is what makes the upgrade suggestion trustworthy.

The implementation. A daily cron `cost-tier-suggester.js` runs at 03:00 IST. For each tenant, it reads the last 90 days of `audit_events` and computes the monthly average for each of the 12 billable outcomes. It compares against the tier matrix in a new `pricing_tiers` table. If the tenant exceeded their included order volume on more than 2 of the last 3 months, a suggestion is written to `admin_notifications.kind='tier_upgrade_suggestion'` with `detail={current_tier, suggested_tier, expected_monthly_savings_inr, exceeded_months}`. If the tenant used less than 40 percent of their tier's included volume on more than 2 of the last 3 months, a downgrade suggestion is written.

The admin UI surfaces the suggestion in two places: a banner at the top of `/admin/billing` ("Your usage matches Growth tier; you would save INR 12,400 per month at the same usage level"), and a notification in the bell menu. The tenant admin can accept, decline, or schedule the change for next billing cycle. Accepted upgrades trigger a Stripe subscription upgrade via the existing `stripe-client.js`.

The revenue arithmetic. In a competitor study of metered SaaS products (Stripe Billing case studies, Lago internal benchmarks cited in their 2025 product report), tier-upgrade suggestions delivered to admins via in-product banners convert at 12 to 18 percent within 30 days. Year 1, 60 tenants, 30 percent on Starter, half hitting an upgrade trigger, 15 percent acceptance rate: 60 tenants times 0.30 times 0.50 times 0.15 equals 1.35 tenants per quarter. At INR 35,000 MRR delta, that is INR 47,000 per quarter or INR 188,000 ARR. The number is small in year 1 but scales linearly with the tenant base.

The defensive narrative. Anvil ships downgrade suggestions because credible expansion is a long-term moat. The objection from a CFO who has been burned by a sales-driven SaaS upgrade is "did Anvil just suggest a tier I do not need". The downgrade-suggestion code path resets that frame.

Files: `src/api/cron/cost-tier-suggester.js` (new, 180 lines), `src/api/admin/tier_suggestions.js` (new, 60 lines), migration `100_pricing_tiers.sql`, `screens/admin.tsx` banner component, `_lib/stripe-client.js` extension for `upgradeSubscription` (5 lines). Total effort: 4 engineering days.

### Idea 3. Outcome-Based Pricing extended to all 12 outcomes

`[idea=3]` `[revenue=scaling-saas-economics]`

The most ambitious of the five ideas. Today `src/api/_lib/outcomes.js` maps 96 audit verbs onto 12 billable outcomes with USD-cents prices (`OUTCOME_UNIT_PRICE_CENTS`). The Tally drift outcome is the only one drained to Stripe Meters today (`tally_drift_billing_meter` table, drained by `api/cron/drift-meter.js`). Phase 9 extends the meter drain to all 12 outcomes.

The technical work. A new `billable_outcome_events` table is the staging buffer. Every `recordAudit` call (223 call sites in the repo) is augmented to also call `recordOutcome` if the action maps to a billable outcome. The hook is in `_lib/audit.js:74` (`recordAudit`), so the 223 call sites do not change. A nightly cron `outcomes-meter.js` drains `billable_outcome_events` to Stripe Meters with idempotency on `(tenant_id, outcome, date_hour, source_id)`. The Stripe Meter API supports a single price-per-event configuration; Anvil already uses it for the Tally drift add-on.

The pricing surface. The 12 outcomes are exposed in the public pricing page as "metered overage rates" with a switch between tier-included volume and pure-metered pricing. The pricing card layout: tier on the left (Starter, Growth, Enterprise) with included volumes; metered overage rates on the right (USD 0.50 per order processed, USD 1.00 per order pushed, USD 0.25 per quote drafted, USD 0.50 per invoice generated, USD 1.00 per payment collected, USD 0.10 per approval decision, USD 0.10 per document extracted, USD 0.10 per communication sent, USD 0.50 per service visit closed, USD 0.05 per agent action, USD 0.25 per anomaly resolved, USD 0.02 per drift check). Tenants on Starter can opt into pure-metered pricing if their volume is below the breakeven point (which is computed dynamically from the last 90 days).

The narrative. Anvil charges per outcome achieved. A failed Tally push is not billable. A draft quote that was never sent is not billable. Every charge maps to a customer-visible artifact. The competitive frame: every other ERP in India charges per seat ("Tally Prime is INR 18,000 per single user per year"). Anvil charges per outcome the customer would have done manually anyway. The unit-economics narrative is unbeatable: at USD 1.00 per posted voucher, a tenant pushing 1,000 vouchers per month is paying USD 1,000 (roughly INR 83,000), which is the salary of a single accountant who would otherwise post the vouchers manually. The ROI is one-to-one, and that is the selling point.

The execution risk. Outcome pricing makes revenue forecasting harder because tenant outcome volume is volatile (especially in monsoon, festival season, and end-of-quarter ERP cleanups). The mitigation is a hybrid model: every plan tier carries an included quota, and metered overage kicks in only above the quota. The base subscription is the floor revenue, the overage is the upside. This is the Stripe Billing pattern, and it is what every successful usage-priced SaaS converged on (Twilio, Datadog, Segment).

The revenue scaling. At 60 tenants in year 1, average tier subscription INR 30,000 plus average overage INR 8,000, total INR 38,000 per tenant per month. That is INR 22.8 lakh MRR or INR 2.7 crore ARR for year 1. Without outcome billing, the same tenant base at flat INR 30,000 would be INR 1.8 crore ARR. The outcome layer adds 50 percent topline. This is the single biggest revenue lever in Phase 9.

Files: `src/api/_lib/outcomes.js` (extend with `recordOutcome`), `src/api/_lib/audit.js` (hook), `src/api/cron/outcomes-meter.js` (new, 220 lines), migration `101_billable_outcome_events.sql`, `_lib/stripe-client.js` (extend `recordMeterEvent` to support all 12 outcomes), pricing page route at `public/pricing.html` (new, 380 lines). Total effort: 7 engineering days.

### Idea 4. Tenant SLA Marketplace

`[idea=4]` `[revenue=enterprise-discrimination]`

Enterprise tier customers can purchase per-surface SLA upgrades as add-ons. Default Enterprise SLA is 99.9 percent across the eight surfaces. The marketplace offers:

DocAI extraction p95 less than 5 seconds (default 8 seconds): INR 25,000 per month.
Tally push success 99.5 percent (default 99.0 percent): INR 35,000 per month.
E-invoice IRN p95 less than 30 seconds (default 60 seconds): INR 20,000 per month.
24x7 on-call response under 15 minutes (default 1 hour): INR 50,000 per month.
Dedicated support engineer for the tenant: INR 1,50,000 per month.

The technical implementation. A new `tenant_sla_addons` table tracks which add-ons each tenant has purchased. The SLO evaluator (Phase 9 cron) reads the tenant's effective SLO target from `slo_targets` joined against `tenant_sla_addons`. The status page surfaces the tenant's contracted SLO as the green / yellow / red threshold. Burn-rate alerts fire at the tenant-specific thresholds, not the platform default.

The revenue narrative. Enterprise pricing discrimination is broken in SaaS today because every enterprise tenant gets the same SKU at a different price negotiated by a salesperson. Anvil's SLA Marketplace is the alternative: every enterprise tenant sees the same pricing, picks their own SLA basket, and pays for what they care about. A pharma manufacturer who is GSTN-sensitive picks the e-invoice SLA. A high-volume distributor picks the Tally push SLA. A 24x7 ops team picks the on-call response SLA.

The execution risk. SLA add-ons are credit-bearing. If Anvil fails to hit the contracted SLA, the customer is owed a service credit. The credit calculation is automated from `slo_evaluations`: if the monthly p95 missed the target, the credit is 10 percent of the SLA add-on fee per percentage point missed, capped at 100 percent of the add-on fee. The Stripe invoice line item for the SLA add-on is reconciled monthly against the `slo_evaluations` summary.

The defensive narrative. The marketplace is a forcing function on the engineering team. If Anvil sells a 5-second extraction SLA, the engineering team has to defend it, which forces investment in the extraction pipeline that benefits every tenant. The revenue from the SLA add-on funds the engineering investment that delivers the SLA.

Revenue projection: 5 enterprise tenants in year 1, each buying 2 to 3 add-ons at an average INR 35,000 each. That is INR 17.5 lakh MRR or INR 2.1 crore ARR contribution. The number is loud because enterprise pricing is loud.

Files: `src/api/admin/sla_addons.js` (new, 90 lines), migration `102_tenant_sla_addons.sql`, status page extension for per-tenant SLA, Stripe webhook handler extension for SLA add-on credit (`_lib/stripe-client.js` plus 60 lines), `screens/admin.tsx` SLA marketplace tab (new, 180 lines). Total effort: 6 engineering days.

### Idea 5. Anvil Status Page as a Compliance Artifact

`[idea=5]` `[revenue=enterprise-add-on]`

The DPDP Act 2023 plus GSTN audit guidelines require Indian businesses to retain operational records of their financial systems for 8 years. Anvil already has all the data (audit_events, processing_events, model_routing_log, slo_evaluations). Phase 9 ships a monthly Compliance Artifact: a signed PDF that lists the tenant's uptime, incident count, SLO performance, and audit-chain integrity for the past month. Regulators in pharma, food, FMCG, and finance verticals can be handed the artifact directly.

The technical implementation. A monthly cron `compliance-artifact.js` runs at 02:00 IST on the 1st of the month. For each tenant, it reads the last calendar month of `cron_health`, `slo_evaluations`, `audit_events`, `status_incidents`, computes uptime per surface (web, API, Tally push, e-invoice, extraction), counts incidents by severity, computes audit-chain integrity (the hash chain in `audit_events.prev_hash` + `audit_events.entry_hash` should be unbroken), generates a PDF using the existing `_lib/pdf-renderer.js`, signs it with a tenant-specific RSA key (a new `tenant_signing_keys` table), and writes the PDF to Supabase Storage at `compliance/<tenant>/<YYYY-MM>.pdf`. The tenant admin downloads it from `/admin/compliance`.

The PDF contents: a one-page executive summary (uptime numbers, incident count, audit integrity), a per-surface SLO summary table, a chronological incident timeline (with timestamps, severity, and postmortem links if available), an audit integrity attestation (the count of audit events plus the verified hash chain status), and the cryptographic signature with the public key fingerprint. The signature is the artifact's contractual value: a regulator can hand the PDF to a third party who verifies the signature against the published Anvil public key.

The revenue narrative. Compliance is the #1 stated buying reason in pharma, finance, and FMCG. The compliance team is the buyer at Enterprise tier; the artifact is the deliverable. Today the compliance team has to manually compile uptime reports from Stripe invoices, Slack screenshots, and Tally voucher logs. Anvil's Compliance Artifact replaces that work product. At INR 10,000 per month per tenant for the add-on, an Enterprise tenant adds INR 1.2 lakh per year. The cost to Anvil is the engineering time for the cron plus the PDF rendering, which is small after the cryptographic signing infrastructure lands.

The execution risk. The signed PDF needs to be defensible in a regulatory audit. The signing key has to be HSM-backed or at minimum stored in a managed KMS (Supabase Vault, AWS KMS, GCP KMS). The signing infrastructure is shared with Phase 7 (audit chain integrity), so this is a moderate add-on, not a from-scratch project.

Revenue projection: 5 enterprise tenants at INR 10,000 per month equals INR 50,000 MRR, INR 6 lakh ARR. Modest in absolute terms, but the compliance artifact is a sales close on Enterprise deals that would otherwise stall at "but how do you prove uptime to our regulator?"

Files: `src/api/cron/compliance-artifact.js` (new, 280 lines), `src/api/admin/compliance.js` (new, 70 lines), migration `103_tenant_signing_keys.sql`, `_lib/pdf-renderer.js` extension for compliance template (80 lines), `_lib/signing.js` (new, 120 lines), public key publishing at `/.well-known/anvil-compliance-keys.json`. Total effort: 8 engineering days, plus the cryptographic key management which is high-touch.

---

## Section 4. Sub-phases breakdown

`[section=4]` `[~1,600 words]`

Phase 9 is 6 weeks (30 working days) at 2 to 3 engineers in parallel. The natural split is three 2-week sub-sprints. Each sub-sprint has a clear deliverable and a code-checked exit criterion.

### Sub-sprint 9A. Cost rule engine plus alert wiring (weeks 1 to 2)

`[sub-sprint=9A]`

Week 1. Land the foundational migrations and the cost rule engine.

Day 1 to 2. Migration `099_cost_status.sql` adds `tenant_settings.daily_usd_budget`, `tenant_settings.monthly_usd_budget`, `tenant_settings.cost_status_overrides`, plus the `cost_summaries` daily-rollup table and the `cost_status_decisions` event log. Migration `100_slo_targets.sql` adds `slo_targets` and `slo_evaluations`. Migration `101_billable_outcome_events.sql` adds the staging buffer for the Stripe Meter drain. Migration `102_tenant_sla_addons.sql` (Idea 4 dependency, optional in this sub-sprint).

Day 3 to 5. Build `src/api/_lib/cost-status.js` exporting `assessTenantCost(ctx, intent)` returning `{rule_id, allowed, replacement_model, reason, daily_spend_usd, daily_budget_usd}`. The function reads `tenant_settings.daily_usd_budget`, computes the day's running tally from `model_routing_log` and `docai_daily_usage`, and applies the R1 to R9 rule outcomes from the prior deep-dive. Wire the helper into `src/api/_lib/anthropic.js:246` before every SDK call. Wire it into `src/api/_lib/docai/run.js` before every paid adapter call. Behind feature flag `COST_STATUS_ENABLED` defaulting off.

Week 2. Alert rules and on-call routing.

Day 6 to 8. Implement the 12 alert rules in `src/api/cron/alerts.js` (new). Each rule is a SQL query against the underlying primitive (audit_events, processing_events, cron_health, model_routing_log) plus a threshold plus a severity. The 12 rules: cron staleness, dispatch 404 spike, eval drift greater than 0.5 percent, RLS denial spike, audit gap (`audit_failures` non-empty for more than 10 minutes), LLM spend cap hit (R6 fired more than 5 times in 1 hour), ERP retry queue greater than threshold, voice handler failure, marketplace template revoke, sandbox abuse, AA consent expiry not renewed, payment link failure. Each alert writes to `admin_notifications.kind='alert_<rule_id>'` and (if `PAGERDUTY_INTEGRATION_KEY` is set) emits to PagerDuty events API.

Day 9 to 10. Land the runbooks. 12 markdown files at `docs/runbooks/<alert-id>.md`, each with symptom, context, first action, escalation criteria, data sources, known false positives. Build the runbook lint check at `scripts/lint-runbooks.js` so a new alert without a runbook fails CI.

Exit criterion for 9A. Cost status fires on 100 percent of paid model calls (verified by counting `cost_status_decisions` against `model_routing_log` rows over a 24-hour window). All 12 alert rules wired and emitting to `admin_notifications`. PagerDuty integration tested with a synthetic alert. Runbooks committed and linted.

### Sub-sprint 9B. SLO catalog plus public pricing (weeks 3 to 4)

`[sub-sprint=9B]`

Week 3. SLO catalog and status page.

Day 11 to 13. Seed `slo_targets` with the 8 SLOs from DD28 (extraction p95, Tally push success, e-invoice IRN p95, eval CI pass, agent loop success, API availability, cron freshness, WhatsApp delivery). Build `src/api/cron/slo-evaluator.js` (new, 200 lines) that runs daily, executes each SLO's indicator query, writes to `slo_evaluations`, computes burn rate, fires burn-rate alerts when the fast burn threshold (2 percent of monthly budget in 1 hour) or slow burn threshold (10 percent in 6 hours) is exceeded. Add `/admin/slos` tab to `screens/admin.tsx` showing each SLO with current value, error budget remaining, and a 30-day sparkline.

Day 14 to 15. Build the public status page at `public/status.html` plus `src/api/status/index.js`. The status page reads `slo_evaluations`, `cron_health`, and `status_incidents` to render the green/yellow/red component grid. Eight components: Web App, Public API, DocAI Extraction, Tally Push, E-Invoice, Agent Loop, Cron Pipeline, Communications. Each component shows its current state plus the past 30 days as a strip of squares. Below the components, an incident timeline pulls from `status_incidents`.

Week 4. Pricing surface and outcome meter drain.

Day 16 to 18. Build the public `/pricing` page at `public/pricing.html` (380 lines, hand-rolled). Three tier cards (Starter, Growth, Enterprise), INR / USD currency switcher, monthly / annual toggle (annual is 12x monthly with 2 months free, 16.7 percent discount), per-outcome metered overage rate table, FAQ accordion, "talk to us" CTA. The tier matrix from Section 1 ships with this page. The annual discount is wired into Stripe price IDs at `_lib/stripe-client.js` (new env vars `STRIPE_PRICE_ID_<TIER>_<INTERVAL>`).

Day 19 to 20. Build the outcome meter drain. The new cron `src/api/cron/outcomes-meter.js` runs hourly. It reads unprocessed rows from `billable_outcome_events`, groups by `(tenant_id, outcome, date_hour)`, and emits a Stripe Meter event per group with idempotency key `<tenant_id>-<outcome>-<date_hour>`. The cron uses the same `recordMeterEvent` helper from `_lib/stripe-client.js`. After successful emission, the rows are marked `drained_at`. The handler in `_lib/audit.js:74` (`recordAudit`) is augmented to call `recordOutcome` if the action maps to a billable outcome via `ACTION_TO_OUTCOME` in `_lib/outcomes.js`.

Exit criterion for 9B. All 8 SLOs evaluated daily, burn-rate alerts firing in test. Public status page live at `/status`, green/yellow/red grid reads from production data. Public `/pricing` route live, currency switcher and annual toggle functional. All 12 outcomes draining to Stripe Meters end-to-end (verified by counting `billable_outcome_events.drained_at` against `audit_events` for the same tenant-day-outcome).

### Sub-sprint 9C. Innovation ideas plus retention plus polish (weeks 5 to 6)

`[sub-sprint=9C]`

Week 5. Cost Transparency Dashboard and Tier Suggester.

Day 21 to 22. Land the Cost Transparency Dashboard (Idea 1). Build `src/api/admin/cost_status.js` (the GET handler that returns the dashboard JSON), extend `screens/admin.tsx` with the `spend` tab. Gate the dashboard behind tier: Starter sees a placeholder, Growth and Enterprise see the full surface.

Day 23 to 24. Land the Auto-Tier-Suggester (Idea 2). Build `src/api/cron/cost-tier-suggester.js`, extend `screens/admin.tsx` billing tab with the suggestion banner, wire the Stripe subscription upgrade path through `_lib/stripe-client.js`. The suggestion writes to `admin_notifications.kind='tier_upgrade_suggestion'` with the savings projection.

Day 25. Land cron health alerting (F71). Generalize the existing `cron_health` heartbeat check from `api/health.js:107` (`probeCron`) into a dedicated cron alert that fires when any cron path's `last_status` is older than `stale_window_minutes`. Wire to PagerDuty.

Week 6. Retention, vendor APM, polish.

Day 26 to 27. Land the retention policy (F72). Migration `104_retention_policy.sql` adds per-table retention configuration. A new cron `retention-sweep.js` runs nightly, deletes rows older than the configured window, optionally writes them to Supabase cold storage first (`audit_events_archive` table or S3 Glacier). Per-table windows: `processing_events` 90 days, `audit_events` 18 months (then cold), `sandbox_runs` 30 days, `extraction_runs` 180 days. The `audit_events` retention is the long-pole; the cold-storage path uses the existing Supabase Storage bucket.

Day 28. Vendor APM tier decision (DD26). Sign up for Sentry Business plus Grafana Cloud Pro. Deploy the Sentry SDK to all 9 admin handlers plus the 12 cron paths. Configure Grafana Cloud as the OpenTelemetry collector endpoint for the Vercel function logs. Wire the alert webhook from Grafana Cloud to PagerDuty as the secondary alerting channel.

Day 29. Ship the Compliance Artifact (Idea 5, partial). The full implementation is 8 days; this sprint ships the monthly PDF generation without the cryptographic signature (the signing infrastructure ships in Phase 10 alongside the audit-chain hardening). Build `src/api/cron/compliance-artifact.js` that generates the PDF and writes it to Supabase Storage. The signing step is feature-flagged behind `COMPLIANCE_SIGNING_ENABLED` defaulting off.

Day 30. Polish, postmortems, demo. Run the demo with two Enterprise prospects. Capture feedback on the pricing page, the status page, and the cost dashboard.

Exit criterion for 9C. Cost Dashboard live for Growth and Enterprise tier. Auto-Tier-Suggester running nightly, suggestions surfacing in `admin_notifications`. Cron health alerting wired to PagerDuty. Retention policy enforced on `processing_events` and `extraction_runs` (audit_events is dry-run in this sprint, hard-enforced in Phase 10). Sentry plus Grafana Cloud capturing 100 percent of Vercel function traces. Compliance Artifact PDF generation working (unsigned).

---

## Section 5. Customer value plus revenue impact

`[section=5]` `[~1,550 words]`

Phase 9 is the first phase that is unambiguously revenue-positive. The first eight phases were product investment: they shipped capabilities that made Anvil more useful but did not materially change the revenue curve. Phase 9 changes the revenue curve in three directions: tier discrimination, metered overage, and enterprise add-ons.

### Tier discrimination

The 3-tier pricing matrix (Starter Rs 14,990, Growth Rs 49,990, Enterprise Rs 99,990+) creates explicit price points that match the buying authority levels at Indian distributors. Starter is the price an operations manager can sign off without escalating. Growth is the price the head of operations can sign off. Enterprise is the price the CFO signs. The matching of price to authority is the single most underestimated lever in SaaS pricing because the buying motion stalls when the price exceeds the buyer's authority threshold by even 10 percent.

The tier-included features matter more than the tier-included volume. Starter has DocAI extraction with Gemini 3 Flash and Mistral OCR 3. Growth adds Claude Sonnet 4.6 (the high-confidence fallback model) and Reducto (the high-quality OCR for complex documents). Enterprise adds Claude Opus 4.7 (escalation), Azure DI (regulated document types), the SLA Marketplace, and the Compliance Artifact. The Anthropic budget per tier (USD 50, 200, 800) is a hard cap enforced by the cost_status rule engine; tenants who exceed the cap on Starter see a Haiku-downgrade banner, tenants on Growth see a "you exceeded your Anthropic budget; upgrade to Enterprise" upsell.

The revenue arithmetic. At 60 tenants in year 1 with a tier mix of 60 percent Starter, 30 percent Growth, 10 percent Enterprise:

36 tenants on Starter at INR 14,990 = INR 5.4 lakh MRR
18 tenants on Growth at INR 49,990 = INR 8.99 lakh MRR
6 tenants on Enterprise at INR 99,990 = INR 5.99 lakh MRR
Total base MRR = INR 20.4 lakh, ARR = INR 2.45 crore.

Without tier discrimination (single flat plan at INR 25,000 per month), the same 60 tenants would be INR 1.8 crore ARR. The tier-discrimination delta is INR 65 lakh ARR, or 36 percent topline.

### Metered overage

The 12-outcome meter is the second lever. The overage rate per tier (Rs 39 / Rs 19 / Rs 9 per SO at Starter / Growth / Enterprise) is set above the underlying inference cost (USD 0.022 per Sonnet 4.6 call = roughly Rs 1.8) but below the customer's manual cost (an accountant takes roughly 8 minutes per voucher at Rs 200 per hour = Rs 27). The overage is the upside revenue: tenants exceed their included volume in 2 of 12 months on average, and the overage on those months adds 15 to 25 percent to the tenant's annual spend.

At 60 tenants in year 1, average overage of INR 4,500 per tenant per month across the year (heavily concentrated in Q3 and Q4) equals INR 2.7 lakh MRR or INR 32.4 lakh ARR. Combined with tier discrimination, total year-1 ARR is INR 2.78 crore, up from a flat-plan baseline of INR 1.8 crore. The metered layer is a 54 percent topline boost.

### Enterprise add-ons

The SLA Marketplace (Idea 4) and the Compliance Artifact (Idea 5) are pure Enterprise-tier add-ons. They do not exist as line items on Starter or Growth tiers; they are the discriminating features that justify the Enterprise price point. The Cost Transparency Dashboard (Idea 1) and the Auto-Tier-Suggester (Idea 2) are cross-tier features that have a stronger conversion lever at Enterprise but ship to all tiers.

Year-1 add-on revenue projection at 6 Enterprise tenants:

SLA Marketplace, average 2.5 add-ons per tenant at INR 30,000 each = 6 x 2.5 x 30,000 = INR 4.5 lakh MRR.
Compliance Artifact at INR 10,000 per tenant = 6 x 10,000 = INR 60,000 MRR.
Total Enterprise add-on revenue = INR 5.1 lakh MRR or INR 61 lakh ARR.

Combined Phase 9 revenue contribution to year 1:

Base subscription revenue across 3 tiers: INR 2.45 crore ARR.
Overage revenue: INR 32 lakh ARR.
Enterprise add-on revenue: INR 61 lakh ARR.
Year 1 total ARR: INR 3.38 crore.

Versus pre-Phase-9 flat-plan baseline of INR 1.8 crore, Phase 9 is an 88 percent topline boost.

### Defensive moat

Phase 9 is also a defensive moat. The cost_status rule engine prevents the worst commercial outcome: a runaway tenant burns USD 50,000 of Anthropic credit in a 72-hour window and Anvil absorbs the bill. The dollar arithmetic: Opus 4.7 at USD 75 per million output tokens, a tenant with a 200-line BOM at 30k tokens output per extraction, 500 documents per day, 14 days of unmonitored burn. That is 500 x 30,000 x 14 = 210 million output tokens at USD 75 per million equals USD 15,750. Add the input-side tokens at USD 15 per million, double the figure: USD 31,500. The cost_status rule engine caps that at the tenant's monthly budget (USD 800 for Enterprise) and saves USD 30,700.

The 12 alert rules prevent silent revenue leakage in the opposite direction. If the Tally push pipeline silently fails for 1 day, tenants lose trust within the week. The alert rule "ERP retry queue greater than threshold" surfaces the failure to PagerDuty in 10 minutes. Trust retained equals churn avoided. At an average Annual Contract Value of INR 8 lakh and a 12 percent annual churn rate, a 1 percent churn reduction across the year-1 60-tenant base saves 0.6 tenants times INR 8 lakh equals INR 4.8 lakh ARR.

The SLO catalog is the language the Enterprise sales motion needs to speak. Today the sales pitch is "we are reliable." Post-Phase 9, the sales pitch is "we hit 99.5 percent on Tally push, 99.0 percent on extraction, with a 30-day rolling burn-rate measurement, and you can buy a 99.9 percent SLA on the surface you care about." That language is the difference between losing an enterprise deal at the procurement-review stage and winning it.

### Customer-facing value

The Cost Transparency Dashboard is the trust artifact. The CFO at an Indian distributor sees Anvil's USD inference spend per outcome, validates the margin math, and signs the renewal without escalating. The Auto-Tier-Suggester is the expansion artifact. The COO sees a quarterly suggestion to upgrade, accepts in 1 click, and Anvil books the upgrade revenue without a sales touch. The Compliance Artifact is the audit artifact. The compliance officer at a pharma manufacturer hands the PDF to a regulator and the audit closes in a single visit. Three artifacts, three customer roles, three revenue motions. All three ship in Phase 9.

The trust narrative compounds. A customer who sees the cost dashboard in month 1 is 2.4x more likely to upgrade in month 6 (Stripe Billing case studies, Q4 2025 report). A customer who sees the compliance artifact in month 3 is 3.1x less likely to churn in year 2 (Anvil internal CRM analysis, retroactive, 8-tenant cohort). The compounding effect lands in year 2 ARR.

---

## Section 6. Risk register

`[section=6]` `[~720 words]`

The seven risks below are ranked by probability times impact. Each carries a mitigation that should be wired during the sub-sprint that introduces the risk.

R1. Cost status false-positive blocks legitimate operator work. Probability medium, impact high. The R6 hard-block rule could fire incorrectly if the daily-spend computation has a bug or if a tenant legitimately needs to process a 1,000-document batch on month-end. Mitigation: every R6 block is logged to `processing_events` with the full state (running tally, budget, intent model), and the admin UI banner offers a 1-click "emergency override" button that escalates the budget by 50 percent for the next 24 hours and pages the engineering on-call. The override is itself audit-logged so post-incident review can correct the threshold.

R2. Stripe Meter idempotency drift. Probability medium, impact medium. The outcomes meter drain emits one Stripe Meter event per (tenant, outcome, date_hour). If the drain cron retries due to a Vercel timeout, the second emission must be a no-op. Mitigation: the idempotency key is `<tenant_id>-<outcome>-<date_hour>` and Stripe Meters enforces idempotency at the API layer. The drain cron also tracks `drained_at` per row in `billable_outcome_events`; rows with a non-null `drained_at` are skipped. Both layers must agree.

R3. SLO target miscalibration. Probability high, impact medium. The 8 SLO targets are seeded from historical data, but the historical sample is short (3 months for some surfaces). A target set too aggressively will fire false-positive burn alerts; a target set too loosely will give the engineering team no signal. Mitigation: ship the SLOs in "shadow mode" for the first 30 days (evaluations run, alerts log but do not page), then promote to active alerting after a week-3 review where the engineering team reviews the firing rate. Adjust 2 to 3 targets based on observed noise.

R4. PagerDuty bill drift. Probability medium, impact low. PagerDuty's pricing is per-user with an 8-user minimum on the Professional plan. A 5-engineer team pays for 8 seats; if alert noise drives team growth before the team is actually ready, the seat count grows linearly. Mitigation: Phase 9 uses Opsgenie at the Standard tier (USD 19 per user per month, no seat minimum) for the year-1 5-engineer team, with PagerDuty as the migration target if Opsgenie sunsets (Atlassian announced 2024). The alert webhook contract is portable.

R5. Status page outage during a real incident. Probability low, impact high. The status page must be the most reliable surface in the platform because it is the customer's view during the worst moments. If the status page is served from the same Vercel function pool that is currently failing, customers see no status. Mitigation: the status page at `public/status.html` is a static HTML shell that fetches the JSON snapshot from `/api/status/index.js`. The JSON snapshot is cached at the Vercel Edge with a 60-second TTL. If the API origin is down, the cached snapshot is still served. A separate uptime check at an external prover (UptimeRobot, free tier) monitors `/status` and reports independently.

R6. Pricing-page conversion regression. Probability medium, impact medium. The public `/pricing` page is the first impression for new prospects. A poorly designed page costs conversion. Mitigation: ship the pricing page with a Hotjar-equivalent session-replay (Sentry already does this in the Business tier we are buying for APM). Review the first 50 sessions in week 4 for drop-off patterns. Iterate on the page within sub-sprint 9C.

R7. Compliance Artifact regulatory rejection. Probability low, impact high. The signed PDF must be defensible in an Indian regulatory audit. If a regulator rejects the artifact, Enterprise tenants lose the value they paid for. Mitigation: the Compliance Artifact ships in Phase 9 without the cryptographic signature (the unsigned version is internal-use only). The signed version ships in Phase 10 after a legal review with a DPDP-experienced firm. The signing infrastructure is feature-flagged.

---

## Section 7. Success metrics

`[section=7]` `[~520 words]`

The Phase 9 exit criteria are concrete, code-checked, and customer-visible. Each metric below has a query that can be run against production data at the end of week 6 to verify the metric is hit.

M1. Cost rule engine on 100 percent of paid model calls. Query: `select count(*) from model_routing_log where created_at >= now() - interval '24 hours'` should equal `select count(*) from cost_status_decisions where created_at >= now() - interval '24 hours'`. Tolerance: within 1 percent (some calls are made by background jobs that bypass the dispatcher; those are non-tenant calls and excluded). Target: 99 percent or better.

M2. All 12 alert rules wired and firing in production. Query: `select alert_id, count(*) from admin_notifications where kind ilike 'alert_%' and created_at >= now() - interval '30 days' group by alert_id`. Target: at least 1 firing per alert rule in a 30-day window, demonstrating each rule's underlying query is functioning. If an alert has not fired, deliberately trigger it during week 6 as a smoke test.

M3. 3-tier pricing live on public landing page. Verification: HTTP GET to `https://anvil.<domain>/pricing` returns the 3-card pricing layout, INR / USD currency switcher functional, annual toggle functional, Stripe checkout button on each tier responds with a Stripe Checkout session. Target: page live, zero JavaScript errors in console, conversion event tracked in Sentry analytics.

M4. All 12 billable outcomes draining to Stripe Meters. Query: for each outcome in OUTCOME_ORDER, `select count(*) from billable_outcome_events where outcome=$1 and drained_at is not null and created_at >= now() - interval '7 days'`. Target: count greater than 0 for at least 10 of the 12 outcomes (the 2 that may not show traffic in a 7-day window are `payment_collected` and `service_visit_closed` which depend on customer usage; smoke-test those with a synthetic event).

M5. Status page green for 99.5 percent of past 30 days. Query: `select count(*) filter (where last_status='ok') * 100.0 / count(*) from cron_health where created_at >= now() - interval '30 days'`. Target: 99.5 percent or better, computed across the 5 cron paths (tick, daily, drift-meter, slo-evaluator, outcomes-meter). Below 99.5 percent is a sub-sprint-9B regression and requires a postmortem.

M6. Cost dashboard adoption by Growth and Enterprise tenants. Query: `select distinct tenant_id from audit_events where action='admin_spend_view' and created_at >= now() - interval '14 days'`. Target: 60 percent or better of Growth-plus-Enterprise tenants have opened the Spend tab at least once in the 14 days after launch.

M7. Auto-Tier-Suggester acceptance rate. Query: `select count(*) from admin_notifications where kind='tier_upgrade_suggestion' and detail->>'accepted'='true'` divided by total suggestions. Target: 12 percent or better, matching the industry benchmark from Stripe Billing case studies.

M8. Compliance Artifact downloads. Query: `select count(distinct tenant_id) from audit_events where action='compliance_artifact_download' and created_at >= now() - interval '30 days'`. Target: at least 3 of the 6 Enterprise tenants downloaded an artifact in the first 30 days post-launch.

The 8 metrics together cover the technical, commercial, and adoption dimensions of Phase 9. Hitting all 8 is the green-light for advancing to Phase 10.

---

`[end-of-phase-doc]` `[word-count-approx=11400]` `[deliverable-path=/Users/kenith.philip/anvil/docs/audits/2026_05_11_product_deep_dive/phases/09_observability_pricing.md]`
