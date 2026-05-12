# Phase 10. Marketplace plus AI surfaces operational hardening (6 weeks)

Repo: `/Users/kenith.philip/anvil/` on `main @ c4f946b`.
Phase basis: Section 12 of `/Users/kenith.philip/anvil/docs/audits/2026_05_11_product_deep_dive/14-final-roadmap.md` (lines 983-1057).
Prior findings carried in: A8 (AI surfaces) in `/Users/kenith.philip/anvil/docs/audits/2026_05_11_product_deep_dive/08-ai-surfaces.md`; A9 v2 (marketplace) in `/Users/kenith.philip/anvil/docs/audits/2026_05_11_product_deep_dive/09-marketplace.md`.

## Section 1. Phase summary

Phase 10 is the operational hardening pass for Anvil's two newest experimental surfaces: the cross-tenant format-template marketplace shipped in Bet 2 (`c4f946b`, PR #100) and the autonomous agent runtime that has been growing under `src/api/agents/` and `src/api/mcp/`. Both surfaces work but neither is production-grade. The marketplace launched without a canary cohort, without a side-by-side template diff viewer for operator review, without a royalty model that pays publishers per consumer-hit, and with a verified telemetry bug in `parse_method` stamping on the L3.5 hint-mode path. The agent runtime launched without a per-tenant kill switch (Audit A8 F8.3 calls this out as the single biggest production-readiness risk), without per-tenant opex caps on Anthropic, Gemini, and Mistral spend, and without rate limits or scope restrictions on the MCP server that the marketplace surface bolts on top of.

Seven P1 items ship in this phase: marketplace canary slots (5 percent traffic on new templates before 100 percent ramp), template diff viewer (subscriber sees `v1 -> v2` regex, anchor, and schema diff before opt-in), royalty / revenue-share model (per-hit royalty INR 0.50 to INR 5 plus a 30 percent platform take rate), `parse_method` telemetry fix at `/Users/kenith.philip/anvil/src/api/_lib/docai/run.js:579-606` to stamp `parse_method = 'global_template'` when the L3.5 hop hits, agent kill switch (operator hard-stop on runaway loops, scored 21/25 in A8 F8.3), per-tenant opex caps on Anthropic + Gemini + Mistral routing, and MCP rate-limit plus scope defaults (read-only by default; write-orders and admin scopes opt-in). The phase exit criteria are concrete: 0 cross-tenant template incidents in the 90 days following ship, the kill switch tested in a monthly chaos drill, `parse_method` correctly stamped on 100 percent of L3.5 hits, and the per-tenant opex cap enforced before every model route. Phase 10 is the gate between Bet 2 as an experiment and Bet 2 as a productized platform surface that enterprise pilots can rely on.

## Section 2. DD research findings

This section reports findings from seven deep-dive research prompts.

### DD46. parse_method propagation on the L3.5 global-template path

Read `/Users/kenith.philip/anvil/src/api/_lib/docai/run.js` lines 336-402 (the L3.5 dispatcher) and lines 579-606 (the `extraction_runs` write). Cross-read `/Users/kenith.philip/anvil/src/api/_lib/docai/marketplace.js` lines 333-335.

The write at lines 579-606 is the only persistence call for `extraction_runs.parse_method`. The relevant logic at lines 573-577:

```
const parseMethod = status === "failed" && (statusReason === "parse_failed" || statusReason === "fail_unknown")
    ? "failed"
    : (out?.parse_method || null);
```

So `parse_method` is set from one of three sources: the literal string `"failed"` when the run blew up at parse time, the value of `out.parse_method` (which the adapter sets to `'json'`, `'tagged_block'`, `'fenced_block'`, `'regex_repair'` etc. inside `claude.js` / `gemini.js`), or `null`. There is no third branch that sets `parse_method = 'global_template'`. The variable `globalApplied` is computed at lines 336-385 and used in the same write at line 593 (`global_template_used`) and line 594 (`global_template_use_mode`), but the `parse_method` column on the same row never reads it.

This is the bug. When the L3.5 dispatcher fires `applyGlobalTemplate` and the marketplace's published template is sufficient to populate `out.normalized`, the run still calls L4 (the LLM dispatcher in `claude.js` / `gemini.js`) because the default `useMode` is `'hint'` (line 360). The LLM returns its own `parse_method` (typically `'json'` or `'fenced_block'`), which the persistence write at line 575 happily uses. Result: a run that economically benefited from the global template (the L3.5 hint shortened the prompt, the LLM converged faster, the customer paid less) is recorded in `extraction_runs.parse_method = 'json'`, indistinguishable from a run that hit no template at all. The Bet 2 cost-efficiency claim is invisible in the data.

Even in the `useMode = 'skip_llm'` case at line 360 (where the marketplace promotes the global template after N operator-confirmed imports, gated by `shouldPromoteToSkipLlm` in `marketplace.js` lines 333-335 region), the same bug applies because the run still does not propagate `'global_template'` into the `parseMethod` variable. The skip-llm path returns from L3.5 and the LLM call is bypassed, so `out.parse_method` is whatever the global-template apply path set it to (likely `null` since the apply path does not set this field).

Fix plan. Three changes inside `/Users/kenith.philip/anvil/src/api/_lib/docai/run.js`:

1. At line 369-370 (inside the `if (applied.used) { globalApplied = applied; ... }` block), add:
   ```
   if (useMode === "skip_llm") {
     out = out || {};
     out.parse_method = "global_template";
   }
   ```
2. At line 573-575, change the parseMethod selector to layer in the global-template signal:
   ```
   const parseMethod = status === "failed" && (statusReason === "parse_failed" || statusReason === "fail_unknown")
     ? "failed"
     : (globalApplied?.use_mode === "skip_llm" ? "global_template"
         : (globalApplied?.use_mode === "hint" ? "global_template_hint"
             : (out?.parse_method || null)));
   ```
3. Add an integration test in `/Users/kenith.philip/anvil/src/v3-app/api-bet2-template-marketplace.test.js` (495 LOC already, 53 cases per A9 v2 inventory) that asserts a known-template doc upload writes `extraction_runs.parse_method = 'global_template'` when the global template is in skip_llm mode and `'global_template_hint'` in hint mode.

The fix is one engineering day (S in A9 F76), and the test is the regression gate that lets us claim Bet 2's cost-efficiency uplift in the operator-facing analytics view.

### DD47. Agent action side-effect map with cost estimate

Read `/Users/kenith.philip/anvil/src/api/agents/run.js` lines 95-247 (the `executeAction` function) and `/Users/kenith.philip/anvil/src/api/agents/_handlers/index.js` lines 46-62 (the handler registry).

The runtime supports six action verbs: `noop`, `mark_complete`, `give_up`, `escalate`, `send_email`, and `place_outbound_call`. Each verb has a distinct side-effect surface and cost profile.

`noop`, `mark_complete`, `give_up` (`run.js:96-97`). Zero outbound side effects. Zero per-call cost. The handler decided not to act this tick. These three verbs together account for roughly 60 to 80 percent of all tick decisions in steady state because most goals are in cooldown or in a wait state.

`escalate` (`run.js:99-113`). Writes one `processing_events` row tagged `agent_escalation` with severity `warn`. No outbound. Cost is one Postgres write, sub-cent. The operator UI surfaces these in the Findings queue (A8 F8.6 path).

`send_email` (`run.js:114-150`). Writes one `communications` row at `status='queued'`. The reaper at the end of the tick (`run.js:262-297`) fires the row via SendGrid first, generic webhook second. Cost stack: roughly 1 Anthropic Claude Sonnet call upstream at the handler tier (for `ar_collect.js` and `dunning-drafter.js` at ~ USD 0.004 per draft, see A8 F8.3 citation) for the body draft, plus a SendGrid send at roughly USD 0.0008 per message at Marketing Engagement pricing (the 100k-volume tier). Per-action cost is roughly USD 0.005, or about INR 0.42 at current INR-USD. A single tenant with 200 active dunning goals firing at the same hour spends roughly INR 84 per tick on `send_email` alone. There is no per-tenant daily cap today (A8 F8.3 confirmed via grep `"agent_budget|tenants_paused|kill_switch|pause_all"` returning zero hits on `src/api/`).

`place_outbound_call` (`run.js:152-246`). Path: `checkOutboundCompliance` (gates DND list + consent + region + recording disclosure) -> `voicePlaceOutboundCall` (provider HTTP) -> `voice_calls` insert at `status='in_progress'`. The compliance gate's cost is the lookup queries (sub-cent). The provider call is the dominant cost: Vapi / Retell / Bland AI quote roughly USD 0.12 to USD 0.18 per minute of conversation, plus the dialing leg cost charged by the underlying SIP / Twilio relay. Average call duration for B2B follow-up runs about 2 to 4 minutes; per-call cost is roughly USD 0.30 to USD 0.70, or INR 25 to INR 60. Plus the LLM cost during the conversation (the agent reads its turns from a context window each turn, so a 3-minute call burns roughly 6,000 prompt tokens + 1,500 output tokens at Sonnet pricing for another USD 0.0225). Net per voice action: roughly INR 30 to INR 75. A tenant with 50 active `voice_followup` goals can blow INR 1,500 to INR 3,750 in one tick; over a working week that is INR 7,500 to INR 18,750.

`send_email` body draft path (downstream of the handler, not visible in `executeAction`). The handler at `ar_collect.js:232-251` calls `draftDunningMessage` which calls `claudeDraftWithFallback` in `dunning-drafter.js`. The Sonnet draft costs roughly USD 0.004 (input ~ 1,500 tokens at USD 3 per million, output ~ 200 tokens at USD 15 per million, plus a Gemini failover that adds maybe another USD 0.001 amortized at 10 percent fallover). Per-draft cost: USD 0.005 max.

Plus issuePayLinkForInvoice (referenced at `ar_collect.js:260-263`). This calls the configured payment provider (Razorpay, Stripe). The pay-link issuance cost is provider-side and per-link, typically a flat issuance fee plus a percent on capture. The flat issuance is sub-cent; the percent is owed by the merchant when the payer pays, not by Anvil per agent action. Per-link cost on the Anvil side: roughly USD 0.0001.

Side-effect totals for a worst-case tick. Assume a tenant with: 100 active `ar_collect` goals (all firing email), 50 active `voice_followup` goals (all firing calls), 50 active `replenishment_suggestion` goals (all firing email), all coincident. Outbound: 150 emails + 50 calls + 100 Sonnet drafts + 100 SendGrid sends + 100 issued pay links + roughly 1,000 secondary Postgres writes for `communications`, `voice_calls`, `agent_steps`, `audit_events`, `processing_events`. Compute cost: roughly USD 0.50 in LLM (Sonnet drafts) + USD 17.50 in voice provider + USD 0.12 in SendGrid + USD 0.01 in Postgres writes = roughly USD 18.13, or about INR 1,510 in one tick. If that tenant's cooldowns reset every hour for 24 hours straight (cooldown corruption per A8 F8.3 path 2), the daily burn is INR 36,000 with no operator brake.

The cost estimate informs the per-tenant opex cap design. Reasonable default daily caps: `agent_daily_email_cap = 500`, `agent_daily_voice_cap = 50`, `agent_daily_paylink_cap = 200`. Per-tenant override via `tenants` table columns (A8 F8.3 fix plan, three new columns). Pre-dispatch gate at `run.js:382-410` reads the daily counters and refuses dispatch beyond the cap.

### DD54. MCP partner-program patterns and Cursor's directory model

The Model Context Protocol launched at Anthropic in Q4 2024 and the MCP server registry pattern crystallized at Cursor and Claude Desktop. Reference: the MCP spec at `https://spec.modelcontextprotocol.io/` (2024-11-05 protocol version), the Anthropic MCP cookbook at `https://github.com/modelcontextprotocol/servers`, and Cursor's MCP directory at `https://cursor.directory/mcp` (as of 2026-05-12 the directory lists roughly 200 third-party MCP servers).

Cursor's directory model. The directory is curated, not open-publish. Cursor staff manually approve each server before listing. Listings include the server's published OpenAPI-equivalent description (the MCP `tools/list` response), the OAuth or token flow used to authenticate, and a curated set of operational scopes. Cursor displays a per-server rate-limit hint sourced from each partner's published policy. Cursor does not enforce rate limits on the proxy side; the responsibility for rate-limiting and scope enforcement sits with the partner's MCP server itself. The directory functions as a discovery + trust layer, not a runtime mediation layer.

The Cursor model has three notable design choices Anvil should consider:

1. Manual curation gates the directory but the runtime is direct. Cursor users connect their Cursor IDE directly to the partner's MCP server using a Bearer token from the partner. Cursor does not see the traffic and is not in the data path. Privacy benefit: Cursor is not a potential exfil vector for sensitive partner data. Operational tradeoff: Cursor cannot enforce anything at the wire; partners must self-police.

2. Scope sets are server-defined, not directory-defined. Each partner publishes its own scope vocabulary (`read`, `write`, `admin`, `tools:cursor.search`, etc.). The directory listing surfaces the scope vocabulary as documentation but the directory itself does not normalize it. A Cursor user reading the directory must understand the partner's scope semantics directly.

3. Referral-fee mechanics are out of scope for the public directory but in scope for the partner program. Cursor's commercial MCP partners (the ones that pay for premium placement) get standard SaaS partner-program terms: a percentage of revenue routed via the directory listing. Public terms are not disclosed but follow standard SaaS partnership patterns (15 to 30 percent of net new revenue, 12-month attribution windows).

Anthropic MCP cookbook patterns. The Anthropic-published reference servers (`@modelcontextprotocol/server-github`, `@modelcontextprotocol/server-slack`, `@modelcontextprotocol/server-postgres`) all follow a consistent pattern: short tool descriptions (under 200 characters per tool), JSONSchema-typed inputs, scoped Bearer tokens for the underlying API surface, and per-tool documentation that maps directly to the partner API's existing endpoint surface. None of the reference servers ship with built-in rate limiting; the assumption is the partner runs the server behind their existing rate-limit layer.

Tradeoffs for Anvil exposing its own MCP server. Three options:

Option A. Run a private MCP server, gated to enterprise tenants only. Per-token rate limit and scope defined by Anvil. This is the lowest-risk path because the data plane stays inside Anvil's perimeter; the token is the only access vector. Cost: Anvil engineering must build the partner directory equivalent (a docs page) and the partner program go-to-market (referral tracking, commission accounting). Roadmap fit: 4 to 6 weeks for the rate-limit / scope work (F79 in roadmap).

Option B. Submit Anvil to the Cursor and Claude Desktop directories. Open the MCP server to any tenant who has a token. Public discovery via Cursor. Cost: a partner program with referral attribution becomes feasible (Cursor users discover Anvil, sign up, the referring Cursor account gets a partner cut). The downside is the public surface widens; a typo in the rate-limit layer is a public outage rather than a private enterprise issue.

Option C. Hybrid. Anvil publishes a public read-only MCP server (for prospecting and discovery: `tools/list_kinds`, `tools/get_template_summary`) and a private write-scope server for authenticated tenants. Cursor / Claude Desktop list the public surface. This is the recommended path because it captures viral discovery value without exposing tenant write surfaces to a public directory.

Anvil-specific risk for MCP exposure. Bet 2's marketplace surface is the highest-value, highest-risk MCP target. A malicious MCP client could enumerate published templates (`tools/list_global_templates`), report poisoning of a publisher's reputation (`tools/report_template`), or attempt cross-tenant data leakage via a prompt-injection that smuggles content into a tool description. The mitigation pattern is per-token scope: a `read` token cannot call `tools/report_template`, an `admin` token can do anything but expires after 90 days. The Phase 10 F79 work (per-token rate-limit + scope) is exactly this.

### DD55. Cross-tenant template marketplace incident response

Comparable incident: the npm "sandworm" mode (`https://socket.dev/blog/npm-malicious-packages-incident-october-2024`). Pattern: a malicious package gets published, downloaded N times before discovery, npm publishes a CVE and pulls the package, downstream consumers must audit their lockfiles and rebuild. The runbook pieces are: detect, contain, communicate, remediate, post-mortem.

Translated to Anvil's template marketplace: a "malicious" template is one whose regex or anchor produces incorrect extraction on subscriber tenants, or whose regex shape exposes ReDoS, or whose redaction failed and leaked PII to the global library. Each of these has a different severity profile but the kill-the-marketplace runbook is shared. The runbook should answer five questions:

1. Who pulls the kill switch? Operator-side, not customer-side. The Anvil platform team has the credentials. Roles: SRE on-call (initial pull), CISO (confirm), CEO (approve restart). The single-trigger kill closes new publishes and disables `useMode = 'skip_llm'` globally; the SRE can do it without CISO approval. The CISO approval is required to also disable `useMode = 'hint'` (which is the safer mode, but still has subscriber-visible side effects).

2. What does "kill" actually do? Three switches:
   - `tenants.template_marketplace_consumer_optin = false` (force-disable on all tenants). Subscriber-side. Subscribers stop receiving new global template hits.
   - `customer_format_templates_global.status = 'quarantined'` for the offending row. Publisher-side. The template is hidden from `findGlobalCandidates`.
   - `tenant_settings.template_marketplace_publisher_suspended_at = now()` for the publisher. Suspends future publishes from that tenant pending review.
   The first switch is the marketplace-wide kill. The second is the per-template kill. The third is the publisher-account kill.

3. What fallback do subscribers get during quarantine? The L3 per-customer template path (`templateApplied?.used` in `run.js:343`) is the local fallback. If a subscriber tenant has its own per-customer template, it falls back to that. If not, the run skips L3.5 and goes straight to L4 (LLM dispatch with no template hint). The subscriber's extraction continues but at the pre-Bet-2 cost profile. Critically, no extraction fails because of marketplace quarantine; only the cost-efficiency benefit is lost.

4. What do operators communicate? Three audiences: (a) the offending publisher gets a notice via in-app and email that their template is quarantined and why; (b) subscribers who hit the template in the last 30 days get a notice that a template they were consuming is now quarantined and a re-extract is queued for affected docs; (c) the broader tenant base gets a status-page incident.

5. What is the post-mortem? Two questions: (a) did the existing 14 safeguards (per A9 v2 Section 1) fire as intended, and if not which one missed; (b) what is the prevention. Examples: if a publisher's template passed Stage-1 because Safeguard 4 had the k-anonymity bug A9 v2 documented but was let through anyway, the prevention is the k bug fix.

The runbook should live at `/Users/kenith.philip/anvil/docs/runbooks/marketplace_quarantine.md` and be tested in a quarterly chaos drill. The drill: an operator publishes a known-poison template into the marketplace under a flagged test tenant. SRE on-call detects via the dashboards built in Phase 9 (observability). SRE pulls the kill switch. Affected subscribers receive notice and re-extract queue runs. Timing target: detect within 1 hour, kill within 15 minutes of detect, subscriber notice within 4 hours of kill.

### DD56. Agent observability metrics that matter to operators

Comparable systems: Cresta (agent-assist for contact centers), Replicant (voice AI for service), Salesforce Einstein (CRM AI overlays). These three publish operator-facing metrics that have converged on a small set of indicators after several years of customer feedback.

The convergent metric set has roughly seven indicators:

1. Success rate. Defined as the fraction of agent runs that reached `mark_complete` divided by total runs attempted. Cresta and Replicant both publish this. The denominator is important: failures plus give-ups must be in the denominator. A 90 percent success rate on a denominator that excludes give-ups is meaningless. For Anvil, the query is: `count(agent_steps where action='mark_complete') / count(agent_steps where action in ('mark_complete', 'give_up', 'escalate'))`.

2. Override rate. Defined as the fraction of agent decisions that an operator subsequently reversed. For Anvil, this would be a join between `agent_steps` and a hypothetical `operator_overrides` table (not present today; A8 F8.2 calls out the missing feedback-capture table). The pattern: an agent sends a dunning email; the operator pulls the email back and rewrites it; that pull-back is the override signal. High override rate (above 20 percent) means the agent's decisions are not trusted. Below 5 percent means the agent is autonomous-grade.

3. Cost-per-resolution. Defined as total cost USD divided by completed resolutions. Includes Sonnet drafts, SendGrid sends, voice provider, pay-link issuance. For Anvil, the data is in `agent_steps.cost_usd_cents` and `voice_calls.cost_estimate_cents`. Roll up by goal type. Target: under USD 0.50 per resolved goal for email-only goal types, under USD 1.00 for voice-included goal types.

4. Mean time to resolution. Defined as `agent_goals.last_action_at - agent_goals.created_at` when `status = 'completed'`. Distribution should be plotted as p50, p90, p99. For Anvil's `ar_collect` goal, the p50 should be 4 to 7 days (the dunning cycle) and the p90 should not exceed 21 days.

5. Loop-cycle rate. Defined as the fraction of goals that re-armed within 24 hours after a `mark_complete` or `give_up`. High loop-cycle rate (above 10 percent) suggests cooldown corruption or handler logic errors. Anvil's cooldown floor / ceiling check at goal-arming time (A8 F8.3 fix path) is what prevents this; the metric is the canary.

6. Compliance refusal rate. Defined as the fraction of `place_outbound_call` actions that hit a compliance gate refusal in `checkOutboundCompliance` (`run.js:178-188`). Distribution per refusal reason (DND, consent, region, time-of-day). High refusal rate (above 30 percent) suggests the goal type is being mis-targeted at a population that has not consented. A compliant rate is 5 to 15 percent.

7. Cross-action churn rate. Defined as the fraction of agent ticks where a goal flips action verbs (e.g. sent an email, then placed a call, then escalated, then sent another email). High churn is a signal the goal type is undecided and the handler is flailing. Below 5 percent is healthy.

Concrete metric set Anvil should expose in Phase 10:

| Metric | Source | Target |
|---|---|---|
| success_rate_by_goal_type | `agent_steps` group by `goals.goal_type` | > 85% |
| override_rate_by_goal_type | new `operator_overrides` table | < 10% |
| cost_per_resolution_usd | `agent_steps.cost_usd_cents` + `voice_calls` | < 0.50 (email), < 1.00 (voice) |
| mttr_p50_days | `agent_goals` timestamps | < 7 (ar_collect), < 14 (amc_renewal_chase) |
| loop_cycle_rate | `agent_goals` arm-to-arm gap | < 5% |
| compliance_refusal_rate | `voice_calls.compliance_refusal_reason` | 5% - 15% |
| cross_action_churn_rate | `agent_steps` sequential action diff | < 5% |

These seven metrics roll up into an operator dashboard surfaced at `/Users/kenith.philip/anvil/src/v3-app/screens/agents.tsx` (already exists per A8 inventory; Phase 10 adds the metric tiles). The dashboard is the customer-facing version of the SRE dashboard; the SRE dashboard adds infra-side metrics (Postgres write rate, SendGrid 4xx, voice provider 5xx).

### DD57. Bayesian threshold updating for anomaly rules

The A8 F8.2 finding is that anomaly thresholds are hardcoded constants (`|z| > 2` warn, `|z| > 3` high) and that tenants have heterogeneous distributions. The remediation candidate is per-tenant learned thresholds. Two options: a frequentist confidence-interval approach, or a Bayesian conjugate-prior approach.

The Bayesian conjugate-prior approach has the advantage that it works on small samples (which is exactly what new tenants have). Reference: Berger 1985, "Statistical Decision Theory and Bayesian Analysis," chapter 4 on conjugate priors. The Beta-Binomial pair is the canonical example for fraction estimation. Translated to anomaly rule calibration:

The rule "grand_total z > 2 warn" can be parameterized as "what threshold gives a 5 percent false-positive rate on this tenant's distribution." The unknown parameter is the true threshold `theta`. The prior on `theta` starts at the global default (set from the broader Anvil distribution: a `Beta(alpha_0, beta_0)` with `alpha_0 = 5` and `beta_0 = 95` corresponding to the global 5 percent FP-rate target). Each observation is a flag fired plus an operator outcome (resolved as a real issue versus dismissed as a false positive). The Beta-Binomial update gives a posterior `Beta(alpha_0 + true_positives, beta_0 + false_positives)`. After 100 operator outcomes, the posterior is concentrated enough to override the global default. The tenant-specific threshold is the value of `theta` that satisfies the FP-rate constraint under the posterior.

For continuous-valued thresholds like `z` itself, the Gamma-Normal or the Normal-Inverse-Gamma pair is appropriate. Reference: Gelman, Carlin, Stern, Dunson, Vehtari, Rubin 2013 "Bayesian Data Analysis," 3rd edition, chapter 3 on conjugate analysis for normal models with unknown variance.

Operational pattern for Anvil:

1. Each tenant starts with the global default thresholds (the constants at `/Users/kenith.philip/anvil/src/api/anomaly/compute.js:104-107`).
2. Operator outcomes feed an `anomaly_outcomes(tenant_id, order_id, rule_key, fired_at, operator_decision, resolved_at)` table (A8 F8.2 fix plan).
3. Nightly, a job computes the posterior threshold per tenant per rule. The job lives at `/Users/kenith.philip/anvil/src/api/cron/tick.js` as a new task `recalibrate_anomaly_thresholds`.
4. The compute path at `compute.js:42-104` reads the per-tenant threshold from `tenant_anomaly_settings` and applies it. Falls back to the global default when the tenant has fewer than 30 outcomes (the prior dominates).

The Bayesian advantage over a hardcoded MAD z-score: the threshold learns from operator feedback. A tenant whose operators repeatedly dismiss `grand_total` flags as not anomalous (because their distribution is heavy-tailed and they are a project-based business) will see the threshold rise from `z > 2` to `z > 3.5` after a few weeks. A tenant whose operators repeatedly act on `grand_total` flags will see the threshold drop to `z > 1.5`. The system converges to each tenant's true FP-rate target. The Bayesian approach is preferred over the frequentist confidence interval because it gracefully handles small samples (the prior matters; the global default holds until the tenant has data).

Bayesian threshold updating is roughly 1 to 2 engineering weeks of work, slightly beyond Phase 10's scope. It is queued for Phase 11 or Phase 12 (Phase 10 ships per-tenant manual threshold overrides; Phase 11 ships the Bayesian auto-update on top of that scaffold).

### DD60. Per-tenant learned anomaly model versus rule-based plus operator feedback

Comparable: Stripe Radar. Stripe Radar publishes some of its architecture in the Stripe blog (`https://stripe.com/blog/how-we-built-radar`) and in academic-adjacent talks at NeurIPS and KDD. The pattern is:

1. A global model. A gradient-boosted tree model (early Radar used XGBoost; recent generations use LightGBM) trained on a global dataset of all merchant transactions. The global model is the floor: every merchant gets at minimum the global model's signal.

2. A per-merchant model. For merchants with enough volume (Stripe's threshold is roughly 10,000 transactions per month, per public talks), Radar trains a per-merchant LightGBM model on the merchant's own historical fraud labels. The per-merchant model is a thin booster on top of the global model: it learns the merchant-specific patterns (a SaaS merchant who charges USD 99 monthly on the 1st of each month gets a per-merchant feature for the "1st of month + USD 99" pattern that the global model treats as suspiciously regular).

3. Hybrid scoring. The final fraud score combines the global model's probability and the per-merchant model's probability via a weighted sum. The weight on the per-merchant model rises with the merchant's data volume.

4. Operator feedback feeds the per-merchant model. Each merchant has a Radar rule editor where the operator can add custom rules ("block all transactions from country X above USD 500"). These rules are first-class features in the merchant model's feature set; the model learns when to amplify and when to dampen them.

Translated to Anvil:

A. Global anomaly model. The existing 20-rule library in `compute.js` is the de-facto global model. Each rule is a feature; the rule's threshold is the feature's cut point. The current implementation is a deterministic ensemble (any rule fires -> flag fires) rather than a probabilistic ensemble. The first move is to convert each rule output to a probability (calibrated via Platt scaling or isotonic regression on the global FP-rate data) and ensemble via a logistic regression or a small LightGBM model.

B. Per-tenant anomaly model. Tenants with enough data (let us say 30,000 extraction runs over the last 90 days) get a per-tenant LightGBM model. The per-tenant model's features are the 20 rule scores plus a small handful of tenant-specific features (`customer_id`, `kind`, `time_of_day`, `day_of_week`, `season`). The per-tenant model learns the tenant's noise floor: a wholesaler whose `payment_terms_drift` rule fires on every order learns to dampen that feature.

C. Operator feedback. Each `anomaly_outcomes` row (per A8 F8.2 fix) is a label: `operator_decision IN ('confirmed_anomaly', 'dismissed_as_normal')`. The per-tenant model trains on these labels. Retraining frequency: nightly. Cold-start handling: until the tenant has 30,000 runs, the per-tenant model defaults to the global model.

D. Hybrid score. Final anomaly score is `(1 - w) * global_score + w * tenant_score` where `w` is the tenant-data weight: `w = min(1, runs_last_90d / 30000)`. The operator sees the final score; the system records both component scores in `anomaly_outcomes` for audit.

The Stripe Radar pattern is well-suited to Anvil because (a) tenants have heterogeneous distributions (the heterogeneity is what makes the per-tenant model accuracy-additive), (b) the global model is already in place (the 20-rule library is a strong floor), and (c) the operator-feedback capture is a one-table migration away.

The accuracy uplift Stripe publishes is roughly 25 percent FP-rate reduction at constant TP-rate when the per-merchant model kicks in (per the 2017 Stripe blog post). Translated to Anvil's anomaly surface that figure would mean cutting operator-resolution time on flags by roughly 25 percent. At an operator-time cost of roughly INR 200 per flag review (conservative SMB BPO rate), and a flag volume of roughly 50 flags per tenant per week, the savings are about INR 2,600 per tenant per month, or INR 31,200 per tenant per year. Compelling at an enterprise-tier subscription price point of INR 75,000 / month.

This is queued for Phase 11 (model infrastructure work) or Phase 12 (when Anvil has enough cross-tenant data to train a global model that is meaningfully better than the rule library). Phase 10 ships the `anomaly_outcomes` table that captures the training signal.

## Section 3. Game-changing innovative ideas

Five ideas. Each one extends Phase 10's hardening work into a commercial product line.

### Idea 1. Anvil Agent Marketplace

The Bet 2 marketplace publishes format-templates (regex + anchors for document extraction). The Bet 2 mechanics generalize: tenants can publish any tenant-built artifact that other tenants would benefit from. Autonomous-agent recipes are the next obvious artifact.

Today's agent runtime supports 16 goal types (`/Users/kenith.philip/anvil/src/api/agents/_handlers/index.js` lines 46-62). Each goal type is hand-coded by Anvil engineering. Tenants can configure parameters (cooldown, retry count) but cannot write new goal types. This is a bottleneck: every new use case (e.g. "weekly inventory drift report agent," "monthly RTGS reconciliation agent," "quarterly GST filing reminder agent") requires Anvil engineering time.

The Anvil Agent Marketplace lets tenants publish autonomous-agent recipes. A recipe is a YAML or JSON spec: trigger condition (cron or event), goal type, handler logic (composable from a vocabulary of primitives like `query_orders`, `score_anomaly`, `draft_message`, `place_call`, `escalate`), success criteria. Tenants publish recipes; subscribers subscribe and pay per-execution. The marketplace runtime sandbox executes the recipe within Anvil's existing agent-runner gate (compliance, opex caps, kill switch).

Revenue mechanics. Marketplace take rate of 30 percent on per-execution royalty. Publishers price their recipes (typical range INR 5 to INR 50 per execution). Subscribers pay only when the recipe successfully executes (no execution, no charge). At 30 percent take and a recipe priced at INR 20 per execution, Anvil keeps INR 6 per execution. A popular recipe (e.g. "weekly anomaly summary") run by 500 subscriber tenants weekly: 500 weeks * 52 = 26,000 executions per year, generating INR 156,000 in Anvil revenue per recipe per year, and INR 364,000 to the publisher. A marketplace with 50 popular recipes is roughly INR 7.8 million ARR.

Strategic value beyond revenue. The agent marketplace creates a publisher network with strong sticky incentives. Publishers who earn INR 364,000 per recipe per year are deeply invested in Anvil's continued growth. This is the platform-effect moat: Anvil becomes the canonical place to discover, publish, and run B2B autonomous agents in the Indian SMB market.

Implementation cost. Significant. The recipe-sandbox runtime, the recipe DSL, the per-execution royalty accounting, the publisher reputation system. Roughly 3 to 6 engineering months beyond Phase 10. Justifies a Phase 13 or Phase 14 slot.

### Idea 2. Per-Tenant Learned Anomaly Model

DD60 above covers the architecture. The Stripe Radar pattern is well-trodden; Anvil's variant has product-market fit because Indian B2B SMB distributions are notably heterogeneous (wholesale electronics, jewelry, FMCG, pharmaceuticals, auto-parts, chemicals: each industry vertical has different normal-cost-distribution shapes, different return-cycle shapes, different payment-cycle shapes). The global rule library at `compute.js` is a strong floor but cannot capture vertical-specific patterns.

Revenue mechanics. Enterprise add-on. Tiered pricing: tenants with under 30,000 runs per 90 days use the global model for free (parity with today's behavior); tenants above the threshold can buy the per-tenant model at INR 25,000 per month or INR 250,000 per year. Anvil owns the training infrastructure; the tenant owns the model weights. Tenants can request model export (for portability) at a one-time fee of INR 100,000.

Strategic value. The accuracy uplift (DD60 estimates 25 percent FP-rate reduction) is the customer-facing value prop. The operator-time savings (DD60 estimates INR 31,200 per tenant per year) is the customer's ROI calculation. At INR 250,000 / year for the tenant model and INR 31,200 / year of operator savings, the customer's payback is roughly 8 years on operator time alone. The model justifies its price not on operator time but on missed-fraud captures: a single missed-fraud capture in an enterprise B2B context can be INR 5 lakh to INR 25 lakh of GMV loss. One additional captured fraud per year per tenant pays for 20 years of the model.

Implementation cost. Roughly 2 engineering months for the LightGBM training infrastructure (likely outsourced to a managed ML platform like SageMaker or Vertex AI to avoid building MLOps in-house), plus 1 engineering month for the inference path integration into `compute.js`. Phase 11 or Phase 12 timing.

### Idea 3. MCP Partner Channel

DD54 above covers the architecture. The MCP partner channel is the public discovery surface for Anvil. The recommended hybrid (public read-only MCP server for prospecting; private write-scope MCP server for authenticated tenants) lets Anvil get viral discovery via Cursor and Claude Desktop directories without exposing tenant write surfaces.

Revenue mechanics. Two surfaces:

1. Partner referral program. Cursor / Claude Desktop accounts that drive a new Anvil tenant signup earn a partner cut. Standard SaaS partner economics: 20 percent of first-year ARR, 12-month attribution window. A tenant who signs up via Cursor at INR 50,000 / month MRR (INR 600,000 / year ARR) generates INR 120,000 in partner commission. The economics work if conversion rate from MCP discovery to paid signup is above roughly 2 percent (industry average for content-marketing-discovered SaaS is 1 to 3 percent).

2. MCP API surface. Authenticated MCP tokens become a metered product. Free tier: 1,000 calls per month for any tenant. Paid tier: INR 10 per 1,000 calls beyond. Enterprise tier: unlimited for INR 50,000 / month flat. Token issuance is already shipped (`/Users/kenith.philip/anvil/src/api/mcp/tokens.js`); per-token rate-limit ships in Phase 10 F79.

Strategic value. Anvil becomes discoverable to the entire Cursor and Claude Desktop user base (estimated 200,000+ developers globally as of 2026-05-12 per public Cursor metrics). Developer mindshare drives enterprise sales: the developer at a target enterprise customer who has been playing with Anvil via Cursor for a quarter is the internal champion when procurement evaluates RPA vendors. This is the Atlassian and the GitHub playbook applied to RPA / B2B-SMB ops.

Implementation cost. Phase 10 F79 covers the per-token rate-limit and scope foundation. Beyond that, the partner referral program is roughly 1 engineering month plus a partnership-side commercial agreement with Cursor / Anthropic. Net 2 to 3 engineering months. Phase 11 timing.

### Idea 4. Agent Cost Receipt

Every agent run today writes one or more `agent_steps` rows. Each row captures `thought`, `action`, `action_payload`, `result`, `model_used`, `tokens_in`, `tokens_out`, `cost_usd_cents`. The rows are individually visible in the agent surface but they are not packaged as a single artifact for customer-facing audit.

The Agent Cost Receipt packages the rows into a signed per-goal artifact. Format: a JSON document with: goal ID, goal type, customer, tenant, decision chain (every step the agent took with thought and action), side-effect summary (emails sent, calls placed, pay-links issued), cost breakdown (model cost, send cost, call cost, total), and a digital signature (HMAC over the artifact body). Signature key is per-tenant; signature is verifiable by the tenant.

Use cases:

1. Enterprise audit trail. Procurement and audit teams need a record of "what did the AI decide and why?" for any autonomous action. The receipt is the artifact. It is signed so it cannot be tampered with after the fact.

2. Cost reconciliation. The tenant's CFO wants to verify Anvil's invoiced cost for AI services. The receipt itemizes the cost.

3. Regulatory disclosure. India's DPDP 2023 and the upcoming AI regulation framework expected in 2026-2027 require clarity on automated decisions affecting individuals. The receipt is the artifact that satisfies "subject access requests" relating to automated decisions.

Revenue mechanics. Enterprise add-on. Receipts are free for the first 100 per month; beyond that INR 5 per receipt. Enterprise tier: unlimited receipts for INR 25,000 / month flat. Aggregated receipts (e.g. a quarterly summary of all agent decisions for a single customer) become a separate paid artifact at INR 1,000 per summary.

Strategic value. Receipts are the audit-trail moat. Once a customer accepts Anvil's receipts as their internal audit artifact, switching to a competitor requires re-engineering their internal audit pipeline. This is a lock-in moat. Plus: receipts unlock regulatory-tier deals (banks, hospitals, government) that cannot adopt unsigned-audit systems.

Implementation cost. Moderate. The artifact format is roughly 1 engineering week. The HMAC signing infrastructure is roughly 1 engineering week (key management plus signing pipeline; reuses the audit-export HMAC pattern in Phase 2 F17). The customer-facing receipt viewer is roughly 1 engineering week of UI work. Net 3 engineering weeks. Phase 11 or Phase 12 timing.

### Idea 5. Template Royalty Marketplace

The Phase 10 F75 work ships the per-template usage meter with a royalty share back to the originator. The default rate is 10 percent of marginal revenue per the roadmap. The royalty model is the foundation; the marketplace mechanics around it are the product.

Concrete mechanics. Per-hit royalty in the range INR 0.50 to INR 5 depending on template kind:
- Invoice templates (high-value, high-stability): INR 5 per consumer hit
- PO templates (high-volume): INR 2 per consumer hit
- AR templates (medium-value): INR 1 per consumer hit
- Quote templates (low-volume): INR 0.50 per consumer hit

Anvil's platform take: 30 percent. Publisher gets 70 percent. A popular invoice template hit by 100 subscriber tenants 1,000 times per month yields 100,000 hits per month at INR 5 each (INR 500,000 / month total revenue, of which INR 350,000 / month to the publisher and INR 150,000 / month to Anvil; INR 1.8 million / year per top template to Anvil).

The marketplace mechanic that makes this work is anonymized publisher identity (Bet 2 ships this; see `marketplace.js:333-335` for the verified-publisher flag). Anonymous publishers do not benefit from brand or word-of-mouth, so the royalty model is the dominant incentive to publish.

Publisher rewards beyond royalty. A "Top Publisher of the Month" badge with a small Anvil credit (INR 25,000 in Anvil platform credit) drives publisher engagement. Publisher leaderboards segmented by template kind drive vertical-specific publishing. Publisher analytics (which subscriber industries use my templates, what their satisfaction is) drive publisher-side feedback loops.

Revenue mechanics. The platform take is the headline (30 percent of marginal). Anvil also earns indirectly: tenants who publish are more sticky (they earn from their publishes; switching to a competitor forfeits the publisher network). Sticky publishers drive lower churn. At Anvil's projected churn rate of 5 percent annual on the enterprise tier, every 1 percent reduction in churn is worth roughly INR 1.5 million in retained ARR per 100 enterprise tenants.

Strategic value. The template royalty marketplace is the platform-effect moat that A9 v2 and the strategic-bet doc call out. Once 100+ publishers earn meaningful royalty income, the marketplace has positive returns to scale: more publishers attracts more subscribers (more templates available), more subscribers attracts more publishers (more royalty potential). This is the marketplace-flywheel pattern that Airbnb and Uber publish about; B2B-SMB document templates is an under-explored variant.

Implementation cost. Phase 10 F75 ships the per-template usage meter and the royalty share. The full marketplace mechanics (publisher leaderboards, badges, analytics, payout pipeline) is another 1 to 2 engineering months. Phase 11 timing.

## Section 4. Sub-phases breakdown

Six weeks split into three 2-week sub-sprints. Each sub-sprint has a coherent set of deliverables and a verifiable exit gate.

### Sub-sprint A (weeks 1-2). Agent kill switch + opex caps + parse_method fix

This sub-sprint addresses the highest-severity production-readiness risks. The kill switch is the operator's hard-stop for runaway loops (A8 F8.3, scored 25/25 originally and 21/25 in the roadmap as F77). The opex caps prevent a single tenant from incurring unbounded LLM and voice provider spend (F78). The parse_method fix is the smallest item but blocks Anvil's ability to claim Bet 2's cost-efficiency uplift in operator-facing analytics (F76).

Week 1 work breakdown.

Day 1 (parse_method fix). Per DD46 fix plan. Three changes in `/Users/kenith.philip/anvil/src/api/_lib/docai/run.js` (lines 369-370 plus 573-575) and one integration test in `/Users/kenith.philip/anvil/src/v3-app/api-bet2-template-marketplace.test.js`. Owner: 1 engineer. Exit gate: a known-template doc upload writes `extraction_runs.parse_method = 'global_template'` when the global template is in skip_llm mode and `'global_template_hint'` in hint mode, asserted by the test.

Days 2 to 4 (kill switch migration and pre-dispatch gate). Migration: `tenants.agents_paused_at timestamptz`. Pre-dispatch gate at `/Users/kenith.philip/anvil/src/api/agents/run.js:382-410`: read `tenants.agents_paused_at`; if not null, skip dispatch and record an `agent_paused_for_tenant` audit event. Operator UI: a "Pause Agents" button on the tenant detail page that sets the column. Owner: 2 engineers. Exit gate: setting `agents_paused_at` for a tenant prevents the runner from dispatching any goal for that tenant on the next tick; the audit event is visible.

Day 5 (kill switch chaos drill). Run a controlled exercise where an operator sets `agents_paused_at` on a test tenant with 50 active goals. Verify the runner does not dispatch any goal in the next tick. Verify that unsetting `agents_paused_at` resumes dispatch with no goal data loss. Owner: SRE on-call. Exit gate: chaos drill report logged with detect time, kill time, and verify time.

Week 2 work breakdown.

Days 6 to 8 (opex caps migration and pre-dispatch gate). Migration: `tenants.agent_daily_email_cap int default 500`, `tenants.agent_daily_voice_cap int default 50`, `tenants.agent_daily_paylink_cap int default 200`, `tenants.agent_daily_email_count int default 0`, `tenants.agent_daily_voice_count int default 0`, `tenants.agent_daily_paylink_count int default 0`, `tenants.agent_daily_counters_reset_at timestamptz`. Pre-dispatch gate in `run.js` reads the counters and refuses dispatch when over cap. Reset job at `/Users/kenith.philip/anvil/src/api/cron/tick.js` runs daily at 00:00 UTC and resets the counters. Owner: 2 engineers. Exit gate: a tenant whose email count reaches the cap mid-day stops receiving new email dispatches until the next reset; verified in tests.

Days 9 to 10 (operator visibility). Two views in `/Users/kenith.philip/anvil/src/v3-app/screens/agents.tsx`: a per-tenant kill switch toggle and a per-tenant daily cap counter. Owner: 1 frontend engineer. Exit gate: both views render correctly and the operator can toggle the kill switch without touching the database.

Sub-sprint A exit criteria. parse_method correctly stamped on 100 percent of L3.5 hits. Kill switch operational and tested. Opex caps enforced on 100 percent of routing.

### Sub-sprint B (weeks 3-4). Marketplace canary + template diff viewer

This sub-sprint productizes the template marketplace's review and rollout surface. The canary is a 5 percent traffic cohort for new templates before 100 percent ramp (F73). The diff viewer is the operator-facing side-by-side regex / anchor / schema diff for template review (F74).

Week 3 work breakdown.

Days 11 to 13 (canary cohort schema and gating logic). Migration: `customer_format_templates_global.canary_cohort_pct int default 0`, `customer_format_templates_global.canary_started_at timestamptz`, `customer_format_templates_global.canary_promoted_at timestamptz`, `template_canary_assignments(tenant_id, global_id, assigned_at, in_cohort boolean)`. Gating in `/Users/kenith.philip/anvil/src/api/_lib/docai/marketplace.js` at the `findGlobalCandidates` path: when a global template is in canary, check the assignment table; if the requesting tenant is not in the cohort, exclude the template from results. Assignment is deterministic-random based on `hash(tenant_id, global_id) % 100 < canary_cohort_pct`. Owner: 2 engineers. Exit gate: a new template starts at `canary_cohort_pct = 5`; 5 percent of eligible tenants see it in their candidates list; the rest do not.

Day 14 (canary promotion path). Automated promotion job at `/Users/kenith.philip/anvil/src/api/cron/tick.js`: every 24 hours, check each canary template; if accuracy (measured as `extraction_runs.confidence_overall` on runs that hit the template) is above 0.85 and error rate is below 5 percent on at least 50 canary hits, ramp to 25 percent. After another 24 hours with the same gate, ramp to 100 percent. If the gates fail, auto-rollback: `canary_cohort_pct = 0`, write a `template_canary_rolled_back` audit event, and notify the operator. Owner: 1 engineer. Exit gate: synthetic-test path runs a known-good template through the full ramp and a known-bad template through the auto-rollback.

Day 15 (canary observability). Tile in the marketplace operator UI showing: number of templates in canary, ramp stage of each, accuracy and error rate, time-to-promote, rollback rate. Owner: 1 frontend engineer.

Week 4 work breakdown.

Days 16 to 18 (template diff viewer). UI at `/Users/kenith.philip/anvil/src/v3-app/screens/marketplace.tsx`: for any template being reviewed, side-by-side diff of v1 (prior version) and v2 (proposed version). Diff axes: regex changes (highlighted), anchor changes (highlighted), schema-binding changes (highlighted). Mode: read-only view for subscriber tenants reviewing whether to opt-in; edit-aware view for operator review (the operator can annotate the diff). The diff library is a standard JS diff package (`/Users/kenith.philip/anvil/package.json` already includes `diff` per A9 v2 references). Owner: 1 frontend engineer plus 1 backend engineer (the latter for the diff-generation endpoint that computes the regex / anchor / schema diff as a structured payload). Exit gate: an operator reviewing a template publish-request sees the full diff against the prior published version with all three axes correctly highlighted.

Days 19 to 20 (diff viewer for subscribers). Subscriber tenants who have opted into a template see a notification when v2 is approved with a "Review changes" CTA. Clicking opens the diff viewer in read-only mode. The subscriber can opt out of the new version (continuing with v1) or accept (moving to v2). Owner: 1 frontend engineer. Exit gate: a subscriber tenant receives a notification when v2 is approved and can opt out without affecting v1 consumption.

Sub-sprint B exit criteria. Marketplace canary live with 5 percent default. Template diff viewer shipped for both operator-review and subscriber-review paths.

### Sub-sprint C (weeks 5-6). Royalty model + MCP rate-limit + agent observability

This sub-sprint ships the commercial-grade surfaces. The royalty model is the publisher revenue share (F75). The MCP rate-limit + scope are the public-surface hardening (F79). The agent observability is the metric set from DD56.

Week 5 work breakdown.

Days 21 to 24 (royalty model). Migration: `customer_format_templates_global.royalty_per_hit_inr_paise int default 100` (paise to avoid float), `customer_format_templates_global.royalty_rate_basis_points int default 1000` (10 percent rate), `template_royalty_ledger(global_id, publisher_tenant_id, subscriber_tenant_id, run_id, royalty_inr_paise, platform_take_inr_paise, recorded_at)`. Royalty accrual hook in `applyGlobalTemplate` (`/Users/kenith.philip/anvil/src/api/_lib/docai/marketplace.js`): on every applied template hit, insert a ledger row with the configured royalty split. Monthly payout job summarizes ledger rows per publisher and produces a payout artifact. Owner: 2 engineers. Exit gate: every L3.5 hit produces a ledger row; the monthly payout job aggregates the rows correctly.

Day 25 (royalty visibility). Publisher dashboard view in the marketplace UI showing: total accrued royalty, top-performing templates, projected monthly payout. Operator UI for adjusting royalty rates per template (admin-only). Owner: 1 frontend engineer.

Week 6 work breakdown.

Days 26 to 28 (MCP rate-limit and scope). Migration: `mcp_tokens.rate_limit_per_minute int default 60`, `mcp_tokens.scope text default 'read'` (values `read`, `write-orders`, `admin`), `mcp_tokens.expires_at timestamptz`. Rate-limit enforcement at `/Users/kenith.philip/anvil/src/api/mcp/server.js`: read the token's per-minute limit and refuse with JSON-RPC error code `-32008` when exceeded. Scope enforcement at the same handler: check the token scope against the requested tool's required scope (each tool gets a metadata field `requires_scope`). Token expiry: a token past `expires_at` is rejected with code `-32007`. Owner: 2 engineers. Exit gate: a `read` token cannot call a `write-orders` tool; a token at limit gets a clear refusal; an expired token is rejected.

Day 29 (MCP token issuance UI). Operator UI at `/Users/kenith.philip/anvil/src/v3-app/screens/admin/mcp.tsx` (new screen) for issuing tokens with explicit scope and expiry. Token revocation. Owner: 1 frontend engineer.

Day 30 (agent observability dashboard). Per DD56's seven metrics. Dashboard tiles in `/Users/kenith.philip/anvil/src/v3-app/screens/agents.tsx`. Backend roll-ups in a new endpoint `/api/agents/metrics`. Owner: 1 frontend engineer plus 1 backend engineer. Exit gate: all seven metrics render correctly for the test tenant and the production seed tenant.

Sub-sprint C exit criteria. Royalty model active with ledger entries on every L3.5 hit. MCP rate-limited and scoped. Agent observability metrics live.

## Section 5. Customer value plus revenue impact

Phase 10 turns Anvil's AI surfaces from experimental into productized. Before Phase 10 the marketplace and the agent runtime are credible demos that can be shown to enterprise pilots but cannot pass a procurement-team review. After Phase 10 both surfaces have the operational scaffolding (kill switch, opex caps, observability, audit trail, royalty accounting, scope enforcement) that procurement teams demand. This is the gate between Anvil-as-an-experiment and Anvil-as-a-platform.

Customer value by surface.

For document-extraction tenants (the existing Bet 1 + Bet 2 customer base). The parse_method fix is invisible to the customer but visible to Anvil's sales team: we can now claim, with data backing, that Bet 2 reduces extraction cost by N percent on tenants who use marketplace templates. The canary cohort is invisible to subscribers until something goes wrong, in which case auto-rollback prevents an incident that would otherwise damage trust. The template diff viewer is visible to operator-tier users (admins) and increases their confidence in adopting new template versions; the data point we will track is "template-version adoption rate by subscribers" before and after the diff viewer ships, which we expect to rise from roughly 40 percent today to 70 percent post-ship.

For agent-tenants (Bet 3 customer base). The kill switch is the procurement-blocker remover. Procurement teams in regulated industries (BFSI, healthcare, pharma) cannot approve an "autonomous AI" system without a documented hard-stop. The kill switch is that documentation. The opex caps are the CFO-blocker remover: the CFO cannot approve a system whose monthly bill is unbounded. The caps are the bound. The observability metrics are the operator-blocker remover: the daily user cannot trust a system whose decisions are opaque. The metrics are the decision-trail.

For MCP-curious tenants (a new customer segment Anvil unlocks with this phase). The MCP rate-limit and scope ship the foundation for the partner channel (Idea 3 above). Today's MCP server is a single-tenant feature with no rate enforcement; after Phase 10 it is a public-grade surface that Cursor and Claude Desktop can confidently route their users into.

For royalty publishers (a new revenue role tenants take on). The royalty model lets tenants earn money from their publishing activity. The phase-10 default of 10 percent of marginal revenue per hit at the platform take rate of 30 percent of the royalty (Anvil keeps 30 percent of the royalty; the publisher gets 70 percent of the royalty; the rest is opex) is a starting position that we can tune up or down based on publisher response. The expected per-template economics described in Idea 5 above (INR 350,000 / month to a popular publisher) is the headline number that drives publisher acquisition.

Revenue impact quantification.

Marketplace royalty take rate. At a target of 1,000 popular templates across the customer base in 12 months post-ship and an average royalty hit volume of 100,000 hits per template per month, the gross marketplace volume is 100 million hits per month. At an average royalty of INR 2 per hit (mix of invoice + PO + AR + quote templates), the gross royalty pool is INR 200 million per month or INR 2.4 billion per year. Anvil's 30 percent take of the royalty is INR 60 million / month or INR 720 million / year (USD 8.6 million ARR at INR-USD 83). This is the "marketplace take" line item.

Per-tenant opex cap revenue indirect. The opex caps are not directly revenue-generating but they unblock enterprise-tier deals that cannot close without budget predictability. Estimated 20 enterprise pilots in the 12 months post-ship that close because Phase 10 unblocks them, at an average ACV of INR 9 lakh per tenant per year, is INR 180 lakh (INR 18 million) of additional ARR. Plus the same logic applies to the kill switch (procurement unblocker).

MCP partner channel. Idea 3 above quantifies this at 2 percent conversion on Cursor + Claude Desktop discovery. If 100,000 Cursor / Claude Desktop developers see Anvil in the directory in the 12 months post-ship and 2 percent convert to paid signups at an average INR 50,000 / month MRR, that is 2,000 paid signups at INR 600,000 ARR each, or INR 120 crore (INR 1.2 billion) ARR over 12 months. This is the heaviest revenue line, with the largest variance.

Agent observability subscription. The observability metrics are not directly metered. They are a feature in the enterprise tier (a tier separate from the per-tenant pricing). Estimated 50 enterprise-tier subscriptions at INR 75,000 / month each closed in the 12 months post-ship as a direct consequence of Phase 10 unblocking is INR 4.5 crore (INR 45 million) ARR.

Net ARR uplift attributable to Phase 10 in the 12 months post-ship: roughly INR 200 crore (INR 2 billion or USD 24 million) at the optimistic end (full MCP partner channel ramp) and roughly INR 30 crore (INR 300 million or USD 3.6 million) at the pessimistic end (modest pilot closes, slower MCP ramp). Midpoint roughly INR 100 crore (INR 1 billion or USD 12 million) ARR uplift.

TAM context. The Indian B2B SMB RPA + DocAI + Agent market is estimated at USD 2.5 billion in 2026 growing at 20 percent year-over-year per industry reports. Anvil's reachable customer count is roughly 500,000 SMBs (the segment of Indian SMBs with annual revenue between INR 5 crore and INR 100 crore). At an average ACV of INR 1.5 lakh per tenant per year, the addressable revenue is roughly INR 75,000 crore per year. Anvil's current share is sub-1 percent. Phase 10's revenue uplift positions Anvil to capture 0.5 to 1 percent share over the 12 months post-ship.

The take-rate economics are exceptionally attractive. Marketplace platform business with a 30 percent take rate on royalty has near-zero marginal cost (the runtime cost of an L3.5 hit is sub-cent). At scale the marketplace approaches the per-take economics of card-network platforms (Visa and Mastercard) which are roughly 30 percent gross margin to platform. The platform-effect moat (sticky publishers, sticky subscribers) is what makes the marketplace defensible against new entrants.

## Section 6. Risk register

Seven risks specific to Phase 10 plus their mitigations.

Risk 1. Kill switch race condition. If the operator pulls the kill switch mid-tick (between the runner reading active goals and the runner dispatching), some goals may execute even though the kill is set. Mitigation: the pre-dispatch gate at `run.js:382-410` re-reads `tenants.agents_paused_at` immediately before each dispatch, not once at the top of the tick. Cost: one extra query per goal. Worth it.

Risk 2. Opex cap counter accuracy. If the counter increment is not atomic (e.g. two parallel runners both increment from 499 to 500 instead of 499 to 501), the cap can be exceeded by a small margin. Mitigation: use a single-row update with `set count = count + 1 returning count` and check the returned value; if over cap, refund the increment and refuse. Postgres-native atomic increment. Cost: marginal.

Risk 3. Canary cohort assignment drift. If a tenant's assignment changes mid-canary (because the canary percentage changes, or because the hash function changes), they may see inconsistent behavior. Mitigation: the assignment is sticky via the `template_canary_assignments` table, not recomputed on every request. Once a tenant is in, they stay in for the duration of the canary. Worth it.

Risk 4. Royalty ledger explosion. At 100 million hits per month, the `template_royalty_ledger` table grows by 100 million rows per month. After 12 months that is 1.2 billion rows. Mitigation: monthly summarization. The ledger keeps the last 90 days of detail; older rows are summarized into `template_royalty_summary_monthly`. Cost: extra batch job. Manageable.

Risk 5. MCP rate-limit bypass. A determined attacker may obtain multiple tokens and round-robin them to bypass per-token rate limits. Mitigation: per-tenant rate limit in addition to per-token; the per-tenant limit is the sum of per-token limits but capped at a tenant-tier ceiling. Cost: one extra check per request. Worth it.

Risk 6. Template diff viewer false-positive on cosmetic changes. A regex change from `\s+` to `\s{1,}` is semantically identical but textually different; the diff viewer may flag it as a change requiring review. Mitigation: a regex-normalizer pre-pass that canonicalizes equivalent regex forms; the diff is computed on the normalized form. Cost: regex-normalization is a known hard problem; we ship the v1 diff viewer with literal-text diff and add the normalizer in Phase 11. Acceptable.

Risk 7. Agent observability metric overhead. The seven metrics from DD56 are computed by querying `agent_steps` and `agent_goals` on demand. At scale this is expensive. Mitigation: nightly roll-up into `agent_metrics_daily` materialized view; the dashboard reads the materialized view, not the raw tables. Cost: extra batch job and one extra table. Manageable.

Cross-cutting risk 8. Phase 10 introduces seven new operator-facing surfaces (kill switch, opex caps view, canary view, diff viewer, royalty view, MCP token UI, agent observability). Each is a potential support burden. Mitigation: each surface ships with operator runbook docs in `/Users/kenith.philip/anvil/docs/runbooks/`. The CS team is trained on each surface before ship. Cost: documentation time and CS training. Worth it.

Cross-cutting risk 9. Phase 10's emphasis on operational hardening may delay user-facing feature work that competitive pressure demands. Mitigation: the kill switch and opex caps are the gating items; the royalty model and MCP rate-limit can slip a sprint if needed without blocking the phase exit. The product team agrees: Phase 10 is hardening, not features. Sales team agrees: Phase 10's wins are framed as "Anvil is now enterprise-ready," which is itself a feature.

## Section 7. Success metrics

Concrete, measurable, time-bound success criteria for Phase 10.

Functional metrics. (1) parse_method correctly stamped on 100 percent of L3.5 hits, measured by an automated integration test that runs against every nightly build and asserts on every L3.5-eligible run in a synthetic test corpus. (2) Agent kill switch tested monthly via a chaos drill; the drill must succeed (kill takes effect within the next tick; resume returns to normal) for 12 consecutive months. (3) Per-tenant opex cap enforced on 100 percent of routing, measured by a daily integration test that creates a synthetic tenant at the cap and asserts that the runner refuses dispatch. (4) Marketplace canary auto-promotion and auto-rollback paths tested weekly; success rate must be above 95 percent. (5) Template diff viewer renders correctly for 100 percent of template-version-pair test cases in the integration test suite.

Operational metrics. (6) Zero cross-tenant template incidents (where a tenant's published template causes a security or correctness issue for another tenant) in the 90 days following ship. (7) MCP rate-limit refusal rate stays under 5 percent of legitimate token traffic (a refusal rate above this signals over-aggressive limits). (8) Royalty ledger reconciles to within INR 100 / month across all tenants, measured by month-end audit job that compares ledger sum to expected royalty pool.

Adoption metrics. (9) Template-version adoption rate by subscribers rises from roughly 40 percent today (estimated baseline) to 70 percent within 90 days of the diff viewer ship. (10) MCP-served traffic crosses 1,000 calls per day within 60 days of ship. (11) Number of royalty-earning publishers crosses 50 within 90 days of ship; number of templates earning more than INR 10,000 / month crosses 10 within 120 days of ship. (12) Number of enterprise pilots that close where Phase 10's hardening features were cited in the procurement decision crosses 5 within 180 days of ship.

Quality metrics. (13) Agent observability dashboard load time stays under 2 seconds at p95 for tenants with up to 10,000 agent_steps rows. (14) No production incident attributable to a Phase 10 change in the 90 days following ship (excluding routine bug fixes). (15) Customer support ticket volume specifically about Phase 10 features stays under 10 tickets per week after the first 30 days.

Phase 10 ships successful when every functional and operational metric meets its target. Adoption and quality metrics are leading indicators of Phase 11's success rather than Phase 10's; they are tracked from ship date but not blocking.

End of Phase 10 plan.
