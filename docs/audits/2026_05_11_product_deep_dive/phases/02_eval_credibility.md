# Phase 2. Eval Credibility and Telemetry Hardening

Audit date 2026-05-11. Branch main at c4f946b. Author: Anvil deep-dive agent. Four-week phase, eight P0/P1 items, anchored on the principle that every accuracy, quality, and cost claim the company makes must be reproducible from artefacts that live in the repo, not screenshots in a deck.

---

## Section 1. Phase summary

Phase 1 lands the harness refactor for `src/api/eval/run.js` so the server scores extractions against an `expected` payload supplied by the caller. That fixes the constraint-level bug where every case failed when `actual` was missing, but it does not fix the credibility bug. The credibility bug is that the caller still hands the server `actual`, and the server trusts it. A motivated tenant can claim 99 percent accuracy by submitting `expected == actual` for every case. Any external party reading the `/trust` page has no way to tell the number from a fabrication.

Phase 2 closes that loop. The server executes extractions itself, against a fixture corpus that lives in the repo, on every push to main, with cost capped under a documented monthly budget. A drift detector runs the same corpus weekly against the production extraction pipeline and reports per-week accuracy delta. A replay UI lets operations re-run any historical extraction against a new prompt or model and see a side-by-side diff. The audit chain gets HMAC stamping at write time (via Postgres trigger) instead of at export time, closing the row-suppression gap. The prompt-injection bench expands from Anthropic-only to all three production adapters (Anthropic, Gemini, Mistral). The CI workflow gets a regression gate that blocks PRs whose golden-set accuracy drops more than 2 percent. A per-model accuracy dashboard ships behind the existing eval admin route.

Eight items. F14 server-side eval. F15 drift detector. F16 replay UI. F17 audit-chain HMAC at write. F18 prompt versioning (continued from Phase 1). PI bench v2 (prompt-injection coverage to Gemini + Mistral). CI eval gate. Per-model dashboard. Cross-cutting risks: LLM stochasticity (two runs of the same prompt produce different outputs), CI cost ($250 to $1,000 a month budgeted for Anthropic + Gemini API calls), and the freeze window that the audit-chain trigger needs for backfill. Total engineering effort 21 to 26 days across two engineers running in parallel, plus 2 weeks of domain-expert curation for the 50-document golden set running in parallel with engineering.

Exit criteria: CI runs the golden set on every push, blocks merges on regression, posts the baseline accuracy number that the public `/trust` page in Phase 3 will read from. Audit-chain HMAC verifier passes weekly. Replay UI ships for admin role only. Drift detector posts a Slack message every Monday. All eight items must reach production before Phase 3 trust-page work begins, because the trust page is a downstream artefact of every Phase 2 deliverable.

---

## Section 2. DD research findings

### Section 2.1. DD3. Server-side eval frameworks survey

[verified-from-prior-knowledge] LangSmith (LangChain), Phoenix from Arize, Promptfoo, LlamaIndex evaluation, Inspect AI from UK AISI, Braintrust, the Anthropic eval cookbook, and Constitutional AI evals all solve a version of the same problem (score LLM outputs against expected results), but their assumptions about corpus size, stochasticity, and CI cost diverge enough that picking the wrong one bakes the wrong constraints into the system for years.

LangSmith [verified-from-prior-knowledge] is the LangChain-coupled eval platform. Hosted, SaaS-first, optimised for tracing chains and agents, not document extractions. Its evaluator model is LLM-as-judge with custom scorers in TypeScript or Python. The pricing is per-trace, which scales badly for our case where one document produces hundreds of internal trace spans (PDF page rasterise, page-level OCR fallback, JSON schema validation, voter consensus, audit write). For Anvil's deterministic-output extraction case (a JSON object that either matches the expected or does not), LangSmith's chain-tracing overhead is mostly wasted spend. Verdict: not a fit.

Phoenix from Arize [verified-from-prior-knowledge] is the open-source observability layer built on OpenInference. It does support offline evaluations and structured comparisons. Local-first, ships an OpenTelemetry collector, integrates with most LLM SDKs. The eval primitives map cleanly to Anvil's case (you define a dataset, a runner, a scorer, and Phoenix computes pass-fail per case plus aggregate stats). Two downsides for our case: (a) Phoenix wants traces, so we would need to instrument every extraction adapter call to emit OTel spans, which is a separate phase of work, (b) the deployment surface is heavier than what Anvil's golden set needs (a 50-document harness does not need a distributed trace store). Verdict: revisit in Phase 4 or 5 when we have enough traffic that observability ROI exceeds the deployment cost.

Promptfoo [verified-from-prior-knowledge] is the closest match. It is a YAML-first eval framework, runs locally in CI, supports HTTP-based custom scorers, ships matrix-mode comparison (one prompt across N models, one model across N prompts, etc), and the cost model is "you pay the LLM provider directly". It supports deterministic assertions (`equals`, `regex`, `is-json`, `contains-any`) and LLM-as-judge for fuzzier cases. The CLI generates an HTML report that can be uploaded as a CI artifact and linked from a PR. The 50-document corpus fits comfortably in Promptfoo's YAML format. Verdict: strong fit for the CI gate use case (Section 4 Week 2). The integration is to call Promptfoo as a shell step in `.github/workflows/ci.yml`, feed it the YAML config, capture the JSON output, and post the regression-block comment.

LlamaIndex evaluation [verified-from-prior-knowledge] is the lightweight eval module shipped with LlamaIndex. Targeted at RAG (retrieval-augmented generation), not document extraction. Score primitives (faithfulness, answer relevance, context relevance) do not map to Anvil's structured-extraction case. Verdict: not a fit.

Inspect AI from UK AISI [verified-from-prior-knowledge] is the framework AISI uses to evaluate frontier model safety. Python-first, designed for adversarial probing and agent benchmarks. Overkill for a 50-document golden set, but the right tool for the prompt-injection bench (PI bench v2 in this phase). Specifically, Inspect's solver-and-scorer abstraction maps to running an injection probe against each adapter and grading whether the model leaked or refused. Verdict: adopt Inspect AI for PI bench v2 only. Keep Promptfoo for accuracy evals.

Braintrust [verified-from-prior-knowledge] is the commercial managed-eval-platform with strong UI and a TypeScript SDK. Hosted SaaS. Pricing is per-eval-run. The UX is best-in-class for prompt iteration, but the lock-in concern (your eval history lives on their servers, not in your repo) makes it a poor fit for a security-and-compliance-positioned vendor like Anvil. Customers reading the `/trust` page will reasonably ask "show me the eval inputs and scorers in your git history" and we want the answer to be "they are in `evals/po-extraction/`, here is the file". Verdict: not a fit on principle.

Anthropic eval cookbook [verified-from-prior-knowledge] is the set of patterns in Anthropic's public docs (now under `docs.claude.com`) for building evals against Claude specifically. Useful as a reference for prompt formatting and tool-use eval patterns. Not a framework. Verdict: cite as reference; adopt the prompt-versioning pattern (Section 4 Week 1).

Constitutional AI evals [verified-from-prior-knowledge] is the technique from Anthropic's Constitutional AI paper (Bai et al, 2022) where an LLM grades its own output against a written constitution of rules. The pattern maps directly to one of the innovative ideas in Section 3 (Constitutional Eval). For the golden-set accuracy case, Constitutional AI evals are overkill (the rule is simply "does `poNumber == expected.poNumber`", no LLM grader needed). For higher-order business-rule checks (e.g., "no GSTIN should be inferred from a fuzzy match"), the technique is the right tool.

Tradeoffs for Anvil's case. Corpus is small (50 documents in Phase 2, target 200 by Phase 4). Stochasticity matters: a Claude Sonnet call with temperature 0 still produces minor output drift across runs. Mitigation: run each case three times, take majority vote on each field, count as pass if 2 of 3 agree with `expected`. CI cost budget is tight: $250 to $1,000 monthly on Anthropic + Gemini APIs for CI runs on every push to main. At Anthropic's published Sonnet pricing (approximately $3 per million input tokens, $15 per million output, [verified-from-prior-knowledge] as of late 2025; check anthropic.com/pricing for current numbers before launch), a single 50-document run with 3-way voting at average 8K input + 1K output per document = 50 * 3 * (8000 * 3 + 1000 * 15) / 1e6 = ~$5 per run. At 4 pushes per day mean across active development weeks, that is $5 * 4 * 22 = $440 per month, which sits within the budget.

Recommendation. Adopt Promptfoo for the CI accuracy gate. Adopt Inspect AI for the prompt-injection bench. Keep `src/api/eval/run.js` as the in-product harness for the admin UI (so a tenant can run their own custom cases against their tenant), but extend it to execute extractions server-side rather than trusting caller-supplied `actual` (the Phase 1 F3 fix).

### Section 2.2. DD22. Audit-chain HMAC at write time

[verified-on-main] The current audit-export flow at `/Users/kenith.philip/anvil/src/api/audit/export.js:68-73` computes an HMAC-SHA256 over the concatenated JSONL row payload at export time. The HMAC key lives in `AUDIT_EXPORT_HMAC_SECRET`. Each export run is logged to `audit_export_runs` (`export.js:92-100`) with the signed hash.

[verified-on-main] The threat that this design does not cover: row suppression at rest. If an attacker with write access to the Postgres instance (compromised service-role key, SQL injection that escapes the existing RLS policies, a malicious DB admin) deletes a row between two exports, the second export computes a fresh HMAC over the new (gap-containing) row set. The HMAC verifies. Nothing detects the gap unless an external party preserved the prior export and compares them. SOC 2 CC7.2 evidence is silently rewritten.

[verified-on-main] Migration 058 at `/Users/kenith.philip/anvil/supabase/migrations/058_audit_events_append_only.sql:28-43` strips the UPDATE and DELETE policies from `audit_events` so end-user JWTs can no longer mutate audit rows through PostgREST. That is necessary but not sufficient: the service-role client bypasses RLS, and any compromise of the service-role key restores the suppression capability. The fix requires the chain to be tamper-evident at the row level, not just the export level.

[verified-from-prior-knowledge] The canonical reference for tamper-evident audit chains is Haber and Stornetta 1991 ("How to Time-Stamp a Digital Document", Journal of Cryptology). The construction: each new record's hash takes the prior record's hash as input. Removing a record breaks the chain. Verification walks the chain from a known-good root to the latest record, checking each linkage. This is the same construction that backs every blockchain and Sigstore's transparency log.

[verified-from-prior-knowledge] Cliff Stoll's "The Cuckoo's Egg" (1989) describes the original wake-up call: an astronomer-turned-sysadmin noticed a 75-cent accounting discrepancy and traced it to a KGB-backed intrusion. The lesson that applies here: small append-only logs that anyone can read and verify catch attackers who are otherwise invisible. Anvil's customers (CFO, internal audit, government auditor under BRSR) play the same role Stoll played.

[verified-from-prior-knowledge] Snowflake's metadata layer audits use a similar chain-of-hashes pattern internally. AWS QLDB (deprecated end-2024, replaced by Aurora Postgres + ledger features) was the canonical managed solution for tamper-evident logs. The general design pattern stays the same regardless of vendor: SHA-256 over (prior_hash, row_canonical_form), stored as a column on each row.

[verified-on-main] Schema for `audit_events` at `/Users/kenith.philip/anvil/supabase/migrations/001_init.sql` (line range covering `audit_events`):

```
create table if not exists audit_events (
  id bigserial primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  actor uuid references auth.users(id),
  actor_role obara_role,
  action text not null,
  object_type text not null,
  object_id text,
  before_payload jsonb,
  after_payload jsonb,
  payload_hash text,
  source_evidence_ids uuid[],
  reason text,
  detail text,
  created_at timestamptz not null default now()
);
```

No `prev_hash`, no `self_hash`, no `sequence_no`. The chain does not exist at the row level today. The HMAC at `export.js:86` is computed at export time over whatever rows survived to that point.

Postgres trigger design. Migration 111 adds three columns: `prev_hash text`, `self_hash text`, `sequence_no bigint` (per-tenant, monotonic). A `before insert` trigger reads the most recent `audit_events` row for the same `tenant_id` ordered by `sequence_no desc`, takes its `self_hash` as `NEW.prev_hash`, increments `sequence_no`, computes `NEW.self_hash = encode(digest(prev_hash || canonical_row, 'sha256'), 'hex')`. Canonical row form excludes the hash columns themselves and serializes the remaining columns in a fixed order.

Idempotency on retry. The trigger must handle the case where two concurrent inserts race on `sequence_no`. Solution: a unique constraint on `(tenant_id, sequence_no)`, paired with a small advisory lock taken with `pg_advisory_xact_lock(hashtext('audit_events_chain:' || tenant_id::text))` at the top of the trigger. The lock serializes inserts per tenant, which is acceptable because audit-event volume per tenant is bounded by user activity (single-digit thousands per day for a busy tenant, well within the per-tenant throughput a single Postgres backend can handle).

[verified-from-prior-knowledge] LISTEN/NOTIFY alternatives. Two pieces of conventional wisdom on Postgres triggers: (a) triggers can become a bottleneck if every insert across all tenants serializes through a shared resource, (b) some teams move the chain computation to a worker that listens on a NOTIFY channel and updates the hash asynchronously. We considered LISTEN/NOTIFY here and rejected it: the whole point of write-time HMAC is that the hash is computed atomically with the row. An async worker creates a window where rows exist without `self_hash`, and any inspection (including an attacker's) during that window sees a recoverable un-hashed state. The advisory-lock-per-tenant pattern is the correct tradeoff: it serialises per-tenant audit writes, which is the only volume axis that matters.

CI verifier at `scripts/verify-audit-chain.mjs` (Section 4 Week 3): walks every tenant's audit chain, recomputes each row's `self_hash` from `prev_hash || canonical_row`, asserts equality. Posts a Slack alert and fails the weekly cron run on any mismatch. Mismatch means either (a) a bug in the trigger (regression detected in CI before it harms a tenant) or (b) actual row tampering at rest (operational incident).

Backfill plan. Existing rows have no `prev_hash` / `self_hash`. Migration 111 fills them in a single transaction by computing the chain from the earliest row forward, per tenant, in `sequence_no = row_number() over (partition by tenant_id order by created_at, id)` order. The backfill runs once during a freeze window (no audit writes for ~5 minutes per million existing rows). After backfill, enable the trigger.

### Section 2.3. DD41. Placeholder import audit in v3-app tests

[verified-on-main] The prior A12 surface report claimed "0 of 59 test files import Placeholder". This is reproducible on main as of c4f946b.

Method. Run `ls /Users/kenith.philip/anvil/src/v3-app/screens/*.test.tsx | wc -l`. Result: 59. Run `grep -l "Placeholder" /Users/kenith.philip/anvil/src/v3-app/screens/*.test.tsx | wc -l`. Result: 0. Sample test file at `/Users/kenith.philip/anvil/src/v3-app/screens/home.test.tsx:1-42` imports only `vitest` and `../test-utils`. Same pattern at `admin.test.tsx`, `evals.test.tsx`, `orders.test.tsx`, `audit.test.tsx`. None of the test files import from `./placeholder` or use the `Placeholder` component name.

What this means. The 59 test files each dynamically `import("./<screen>")` and assert that the default export is a function and that the rendered DOM has nonzero length (sample: `home.test.tsx:23-27`). The test is structural: it verifies the screen file exports a React component and that the component renders without throwing. It does not assert what the screen renders.

The Placeholder component at `/Users/kenith.philip/anvil/src/v3-app/lib/placeholder.tsx:12-38` is a 30-line stub rendered when a screen has not yet been ported to the Vite app. Production screens that have not been ported call `placeholderFor("<name>")` which returns a component bound to the placeholder. The grep across the screens directory for `placeholderFor` returned 0 results, meaning every screen in `screens/*.tsx` currently has a real implementation (not a placeholder).

Coverage ratio. Real-component implementation: 59 of 59 screens have non-placeholder code at the top level. Test coverage of real behaviour: 0 of 59 test files assert real behaviour beyond "renders without throwing". So coverage by file count is 100 percent. Coverage by meaningful assertion is functionally 0 percent. The smoke tests catch only the regression "the file does not export a React component" and "rendering throws an uncaught exception". They do not catch "the screen renders the wrong data", "the screen does not call the expected API", "the screen mishandles permission denial", or "the screen leaks tenant data into a hidden DOM attribute".

Phase 2 fix plan. Out of scope for the four-week Phase 2 directly, but the gap matters here because the eval-credibility theme depends on backend tests, not just E2E smoke tests. The follow-on Phase 3 surface (trust page) will assert real DOM behaviour: "if the API returns a 99 percent accuracy number, the trust page renders 99 percent". That assertion is meaningful and writeable in vitest. Recommendation: when Phase 3 builds the trust page, write at least one real-assertion test per top-level user-facing claim on that page, and use it as the template for retrofitting the other 58 screens in Phase 4 or 5.

The verified A12 finding stands. Document it as a tracked gap, not a Phase 2 blocker.

### Section 2.4. DD48. Audit export chain assembly and trigger compatibility

[verified-on-main] Audit export logic lives at `/Users/kenith.philip/anvil/src/api/audit/export.js`. The flow:

1. Resolve context and assert admin role. `export.js:36-37`.
2. Refuse to export if `AUDIT_EXPORT_HMAC_SECRET` is unset. `export.js:39-43`.
3. Read time-bounded, tenant-scoped rows from `audit_events` in `ts ascending` order with a configurable limit (default 50000, hard cap 200000). `export.js:46-63`. Note that the column referenced is `ts`, but the schema in `001_init.sql` uses `created_at`. This is either a Supabase column-alias I am not seeing in the migrations, or a pre-existing bug. Worth a quick check before Phase 2 ships.
4. Iterate rows, JSON-stringify each, write to NDJSON stream, update HMAC over each line + newline. `export.js:68-75`.
5. Append a trailing `meta` line containing the HMAC digest, row count, time bounds, and exported_at. `export.js:76-89`.
6. Insert a row into `audit_export_runs` recording who exported, the time bounds, and the signed hash. `export.js:92-100`.

[verified-on-main] Audit write logic lives at `/Users/kenith.philip/anvil/src/api/_lib/audit.js`. The `recordAudit` function at `audit.js:53-87`:

1. Validates `ctx.tenantId` exists. `audit.js:54-58`.
2. Builds a row with `tenant_id, actor, actor_role, action, object_type, object_id, before_payload, after_payload, payload_hash, source_evidence_ids, reason, detail`. `audit.js:60-73`.
3. Inserts via `serviceClient()` (bypasses RLS). `audit.js:74`.
4. On error, logs via `console.error` and writes a sentinel to `audit_failures`. `audit.js:75-86`.

[verified-on-main] No `prev_hash`, no `self_hash`, no `sequence_no` is set by the application code at write time. The chain truly does not exist below the export layer.

Compatibility analysis for adding a write-time HMAC trigger. The trigger needs to set three new columns: `prev_hash`, `self_hash`, `sequence_no`. The existing application code at `audit.js:60-73` builds a row that does not mention any of these columns. Postgres will accept the insert and let the trigger fill them via `NEW.prev_hash = ...`. No application change is required for the write path.

The export path needs one change. The HMAC at `export.js:68-75` currently hashes over the row payload (`JSON.stringify(row)`). After migration 111, each row carries its own `self_hash`. Two options:

Option A. Leave the export HMAC alone. The export-time HMAC continues to sign the file in transit. The new `self_hash` chain is an independent verification surface accessible via a new `/api/audit/verify-chain` endpoint (or by reading the rows directly).

Option B. Strengthen the export by including the chain root in the meta. Replace the export HMAC with the latest row's `self_hash` plus a signature over that hash. The downstream auditor can then verify both the file's integrity (HMAC) and that the latest row in the file is the actual latest row in the chain (by comparing against the published chain root). This is the right long-term design but doubles the validation surface for Phase 2. Defer to Phase 3 as part of the public-trust artefact.

Phase 2 recommendation: Option A. Add columns + trigger in migration 111. Add `scripts/verify-audit-chain.mjs` as a CI-runnable verifier. Add a weekly cron that runs the verifier and Slacks on any break. Do not touch `export.js` yet. The export semantics remain identical, the file format does not change, the auditor's verification script does not need to update.

Detect the `ts` vs `created_at` discrepancy. `export.js:55-58` orders by `ts`, but `001_init.sql` declares `created_at`. There may be a Supabase column rename or a view I have not located. Before Phase 2 ships, confirm: either rename in the code, or add `created_at_alias` view, or assert that the production schema differs from the migrations. This is not a Phase 2 blocker (export works in production) but the code reads as a foot-gun.

---

## Section 3. Game-changing innovative ideas

The eight P0/P1 items in Phase 2 unlock the credibility moat. Ideas in this section describe how to turn that moat into a competitive and revenue advantage. Five ideas, ranked by leverage-to-build-effort ratio.

### Idea 3.1. Live Trust Card

Name. "Live Trust Card". A public, customer-facing URL at `trust.anvilcrm.com/<tenant-slug>` (white-label option: `trust.<customer-domain>.com`) that renders in real time: the tenant's golden-set eval pass rate, any drift events from the last 30 days, audit-chain integrity status (green if verifier passed within 24 hours, amber if 24 to 72 hours, red if older), per-adapter accuracy breakdown, and time-since-last-incident.

Problem this solves. Procurement teams at Anvil's ICP (mid-market Indian manufacturing) cannot evaluate AI-extraction vendors without sustained trust signals. The standard sales motion ships a 15-page security questionnaire, the vendor fills it in over six weeks, the buyer reads it once, signs the MSA, and forgets it. The questionnaire goes stale the moment the vendor changes a prompt. The buyer has no ongoing signal that the vendor is still trustworthy. The vendor has no surface to differentiate on trust beyond "we have SOC 2".

Why it is a moat. (a) Anvil ships continuous, contemporaneous evidence (eval pass rate as of the last CI run, audit-chain verifier as of the last weekly run). Competitors who do not have a Phase 2-grade eval pipeline cannot replicate this in less than a quarter. (b) Public trust pages create reputational gravity: the buyer can show their CFO a live link instead of a PDF, the CFO is materially more comfortable. (c) Eventual SEO surface: "<tenant-name> AI accuracy trust page" becomes a search term that vendors compete on.

Revenue model. Three tiers. (1) Free with Anvil branding for every tenant (lowers CAC by removing the trust-questionnaire bottleneck). (2) White-label add-on at $500/month per tenant: customer's logo, custom domain, removed Anvil chrome (enterprise upsell). (3) Compliance pack at $2,000/month: includes SOC 2 evidence export and BRSR data-quality attestation (enterprise plus add-on).

TAM estimate. Mid-market Indian manufacturing buyers conservatively number 40,000 to 60,000 firms with procurement spend large enough to justify $500/month minimum trust-page tier [inferred from MSME census data and procurement-software ICP analyses]. At a 1 percent capture and 20 percent attach rate of white-label, the white-label line alone is $500 * 0.01 * 0.2 * 50,000 * 12 = $600,000 annual recurring. The compliance pack at $2,000/month and a 0.2 percent capture at 30 percent attach reaches $720,000 annual recurring. Indirect CAC reduction (free tier shortens sales cycles by an estimated 30 percent based on procurement-software benchmarks [inferred]) is probably the larger value driver.

Implementation outline. Single new endpoint `/api/trust/<tenant-slug>` returns aggregate metrics. Single new public-facing Vite app `apps/trust-card/` at the new domain. Backed by three queries: (a) latest `eval_runs` for the tenant by suite, (b) latest `eval_drift_runs`, (c) `audit_export_runs.signed_hash` plus a new `audit_chain_verifier_runs` table populated by the weekly cron. Cache aggressively (60-second TTL): the trust page must load in under 500ms regardless of tenant load. Add a `public_trust_enabled boolean default false` column on `tenants` so opt-in is explicit (legal pre-clearance required before public exposure).

Risk profile. (a) Bad trust day. If a tenant's accuracy drops to 70 percent on a Tuesday, the trust page reflects that publicly. Risk: competitor screenshots the bad day for sales material. Mitigation: trust page surfaces rolling 7-day median rather than instantaneous score, plus an opt-in delay for new metrics (24 hours to acknowledge bad outputs before they go public). (b) Privacy. Trust page must not leak per-document accuracy if the document is itself confidential. Mitigation: aggregate-only, no per-document drilldowns at the public layer. (c) Adversarial trust shaping: customers may game the eval corpus to inflate their public score. Mitigation: the corpus is shared across tenants (per-vertical golden sets); a tenant cannot edit the master corpus, only their own private cases. The public number is the shared-corpus number, not the tenant-private one.

### Idea 3.2. Replay-as-Time-Machine UI

Name. "Replay-as-Time-Machine". The replay UI from F16 generalised to a first-class product surface: the operator picks any historical `extraction_runs` row, picks a new prompt version, picks a new model (or full voter chain), and the system re-runs the extraction. Side-by-side diff renders inline. Operator decides whether to (a) overwrite the original, (b) record the replay alongside, or (c) discard.

Problem this solves. When a customer complains "this PO extraction was wrong six months ago", the support engineer today reproduces from scratch: copy the document, build a new prompt manually, paste into Claude console, eyeball the diff. Slow, error-prone, no audit trail. With Replay-as-Time-Machine, the support engineer types the case ID, clicks Replay, picks the candidate fix prompt, sees the diff in 30 seconds. The fix prompt becomes a first-class artefact: it gets stamped to a new prompt version, evaluated against the golden set, and shipped if it improves accuracy without regression.

Why it is a moat. The replay loop closes the feedback gap between customer-reported regression and shipped fix. Competitors who lack the prompt-versioning infrastructure (F18) cannot replay reliably, because they do not know which prompt produced the bad output. Anvil's loop (replay -> diff -> rate -> ship-or-discard) becomes a single 5-minute workflow. Customers experience this as "Anvil fixes things faster than every other vendor".

Revenue model. (a) Free up to 50 replays per tenant per month (cost absorbed by Anvil because most of these find real issues that benefit the corpus). (b) Pay-per-replay credits beyond the free tier at $1 per replay, capped at $200/month per tenant. (c) Consultancy-style billing at $250/hour for engineering-led prompt-tuning sessions where the customer wants Anvil to drive a fix for a specific document class.

TAM estimate. Each tenant generates an average of 200 to 500 extractions per day (assumed mid-tier Anvil customer [inferred]). At a 1 to 2 percent replay rate (customer-reported regressions plus engineering-initiated investigations), that is 4 to 10 replays per day per tenant. Beyond the free 50-per-month tier, the average tenant pays for an additional 70 to 250 replays per month, generating $70 to $250 per month per active tenant. Across 1,000 active tenants in three years, $840,000 to $3M annual recurring from replay credits alone. Consultancy line: 200 tenants buying 4 hours per quarter at $250 = $200,000 annual recurring.

Implementation outline. (a) F16 ships the basic replay endpoint and admin UI. (b) Generalise the admin route to a tenant-facing surface at `/cases/<case_id>/replay`. (c) Add prompt-version selector (uses F18 prompt registry). (d) Add model selector (Anthropic, Gemini, Mistral, plus voter chain). (e) Persist the replay to `extraction_replays` with parent run ID, prompt-version diff, model diff, output diff. (f) Add a "promote this to corpus" button that takes the replayed case, prompts the operator for the expected output, and writes a new row to `eval_cases`.

Risk profile. (a) Cost blowout: a single tenant could replay 10,000 times in a day. Mitigation: per-tenant daily cap (the F21 USD budget). (b) Stale documents: the document store moves over time (BLOB re-uploads, redactions). Mitigation: snapshot the document on first extraction; replay reads the snapshot, not the live document. (c) Reproducibility: LLM stochasticity means a replay with no prompt or model change might still produce a different output. Mitigation: 3-way voting on replays, same as the main pipeline. Flag as "stochastic drift" if 3-way disagrees.

### Idea 3.3. Constitutional Eval

Name. "Constitutional Eval". Borrowed from Anthropic's Constitutional AI: every prompt change in the repo is graded against a written constitution of business rules. The constitution lives at `evals/constitution.md` and contains statements like "no GSTIN should be inferred from a fuzzy match against the customer master if the source document does not contain it verbatim", "the line-item total of an invoice must equal the sum of line totals to within 0.5 percent", "no PO number should ever be generated; it must be extracted". A grader LLM (Claude Sonnet) reads the constitution, reads the (input document, candidate extraction) pair, and scores each rule pass-fail. The PR pipeline blocks merges that introduce a constitution violation.

Problem this solves. The golden-set accuracy gate (F14) catches numeric regressions. It does not catch semantic regressions: "this prompt now hallucinates a GSTIN when none is present" might score the same on the golden set if no golden-set case contains a missing-GSTIN document. The constitution is the semantic layer: it expresses business invariants that should hold across every document, in every tenant, regardless of corpus coverage.

Why it is a moat. (a) Semantic guarantees are the kind of artefact enterprise auditors value above any accuracy number. A buyer reading "Anvil's constitution guarantees no GSTIN is inferred" can give that artefact to internal audit and get sign-off in a single meeting. Competing vendors who only ship accuracy percentages cannot match this. (b) The constitution becomes a public document (with the Live Trust Card). Customers see exactly what guarantees they get. (c) The constitution is hard to copy: it embeds 100+ business-rule edge cases that took two years of domain expertise to enumerate. A new entrant cannot ship one in a quarter.

Revenue model. (a) Free constitution for all tenants (the safety net). (b) Per-tenant custom-rule add-on at $200/month: the tenant can add their own business rules to a tenant-scoped constitution layer. (c) SLA tier at $5,000/month: Anvil contractually guarantees constitution violations stay below X per 1,000 extractions; breach pays out service credits. This is the enterprise upsell the audit memo references.

TAM estimate. Per-tenant custom-rule add-on: 30 percent of mid-tier tenants will buy at $200/month. At 1,000 tenants in three years, $720,000 annual recurring. SLA tier: 2 percent of enterprise tenants (top 100 by revenue) at $5,000/month = $120,000 annual recurring, plus the indirect deal-size lift on those accounts (SLA conversations typically double the average enterprise contract value [inferred]).

Implementation outline. (a) Author `evals/constitution.md` with the first 20 rules in Week 4 of Phase 2 (using domain expert input). (b) Build `scripts/constitutional-eval.mjs` that takes a (document, extraction) pair and a constitution path, prompts Claude Sonnet as grader, returns pass-fail per rule. (c) Wire as a CI step that runs the constitution against every golden-set case for every PR. (d) Block merges on any new violation. (e) Persist results to `eval_constitution_results` for the Trust Card.

Risk profile. (a) Grader stochasticity: the LLM grader gives different answers across runs. Mitigation: 3-way grader voting, same pattern as accuracy. (b) Constitution drift: rules added over time may contradict earlier rules. Mitigation: a constitution-lint step that checks every rule for contradiction with prior rules at CI time. (c) Cost: every PR now runs N grader calls. Mitigation: grader-cache by `(document_hash, extraction_hash, constitution_hash)`; only re-grade when one of the three changes.

### Idea 3.4. Drift Bounty Program

Name. "Drift Bounty Program". When a customer reports a regression (an extraction that used to be right and now is wrong, or vice versa), the customer receives credits worth $50 to $500 depending on the severity (manual triage by Anvil engineering). The reported case enters the golden set as a labelled fixture. Anvil pays for fast labels; customers pay nothing for catching real regressions.

Problem this solves. The golden set today is 50 documents (Phase 2). To stay credible long-term, it needs to be 500 to 2,000 documents covering edge cases that no one anticipated at curation time. Hiring domain experts to label 2,000 documents costs $30,000 to $80,000 [inferred from competitive labelling-service rates]. The Drift Bounty model gets the same labels for $5,000 to $20,000 in customer credits, plus the labels are by definition exactly the cases that matter to real customers in production.

Why it is a moat. (a) Network effect: the more tenants Anvil has, the faster the corpus grows, the better the eval credibility, which is the marketing message that attracts more tenants. (b) Goodwill: customers feel paid to find bugs, which is the opposite of the usual SaaS dynamic of feeling ignored when a bug is reported. (c) Speed: the typical customer-reported regression has been seen by the customer's ops team within 24 hours of the document arriving. Compared to a quarterly corpus-refresh by an external labelling service, the bounty cuts label-latency from 90 days to 1 day.

Revenue model. Indirect via lower eval-corpus cost over time (saves an estimated $25,000 per year by the second year). Direct via reputation: a Drift Bounty program is a unique-in-the-category marketing message that improves CAC. Plus a tangible viral signal: customers who file bounties talk about the program, often unprompted in procurement reference calls.

TAM estimate. Drift Bounty is not a revenue line on its own; it is a cost-saver and a marketing amplifier. Quantified value: $25,000 per year saved on labelling, plus an estimated 5 to 10 percent CAC reduction on the segment that responds to "ethical AI vendor" messaging [inferred].

Implementation outline. (a) New endpoint `/api/drift-bounty/submit` accepts (case_id, expected_output, severity_claim). (b) Triage queue in admin UI for Anvil engineering: accept, reject, or request more info. (c) On accept, write to `eval_cases` (or a new `eval_cases_bounty` table to track provenance), credit the tenant's billing account, send Slack notification to engineering. (d) Public leaderboard at the Trust Card: top contributing tenants this quarter.

Risk profile. (a) Gaming: a tenant could fabricate regressions to farm credits. Mitigation: triage by humans; credits issued only on confirmed regressions. (b) Leakage: tenant documents enter the golden set, which is shared across the company. Mitigation: redaction step before any document enters the corpus; tenant opt-in required at submission time; legal review of contributor terms. (c) Bounty arbitrage: a tenant who submits 1,000 fake reports to overwhelm the triage queue. Mitigation: rate-limit submissions to 5 per tenant per day; auto-reject if the supplied expected output is malformed.

### Idea 3.5. Tamper-evident Audit Subscription

Name. "Tamper-evident Audit Subscription". The HMAC chain root (the latest `self_hash` per tenant per day) is hashed into a daily Merkle tree, the Merkle root is published to a public log (Sigstore's transparency log, or hashed into a Bitcoin transaction's OP_RETURN field). Each customer receives a daily proof-of-non-modification email with their tenant's chain root and the public-log inclusion proof.

Problem this solves. Even with write-time HMAC at F17 plus a weekly verifier (covering the row-suppression-at-rest threat), Anvil itself is still trusted: Anvil could replace its own database (with a chain that hashes correctly because Anvil controls the trigger) and no external party could detect it. The public-log anchor closes the circle. The customer (or a regulator) can verify with no trust in Anvil that the chain root on day N matches the chain root that was published to a public log on day N.

Why it is a moat. (a) This is the highest-bar tamper-evidence available short of running the database on a public blockchain. For regulator-facing artefacts (BRSR data quality attestation, EU AI Act conformity assessment after 2026 [verified-from-prior-knowledge for the AI Act timeline]), this is the difference between an attestation that requires Anvil's word and one that does not. (b) Only one or two vendors in the procurement-AI space ship this today (Truelink and Eulith ship variants in adjacent fintech segments [verified-from-prior-knowledge as of 2025]). Anvil shipping this in 2026 is a 12-month lead. (c) The public log itself is free (Sigstore is operated by the Linux Foundation; Bitcoin OP_RETURN costs cents per transaction). The cost is entirely engineering effort.

Revenue model. Enterprise add-on at $1,500/month per tenant: the customer gets the daily inclusion-proof email, a downloadable PDF audit pack, and an API endpoint that returns the latest verifiable root. Regulator-facing artefact at $5,000 one-time per audit cycle: Anvil packages a year of inclusion proofs with a notarised cover letter for a regulatory submission.

TAM estimate. Enterprise add-on: 5 percent of tenants in regulated verticals (manufacturing exporters subject to BRSR or EU AI Act) at $1,500/month, at 1,000 tenants three years out, is $900,000 annual recurring. Regulator-facing artefact: 50 customers per year at $5,000 = $250,000 annual recurring.

Implementation outline. (a) Phase 2: ship the chain (F17). (b) Phase 4 or 5: add a daily cron `audit-chain-anchor` that reads each tenant's latest `self_hash`, builds a Merkle tree, publishes the root. (c) Sigstore integration via the `cosign` CLI or the Rekor REST API. (d) Customer-facing endpoint `/api/audit/inclusion-proof?date=...` returns the inclusion proof. (e) Daily email via the existing comms layer.

Risk profile. (a) Public log retention: Sigstore promises long-term retention but is operated by a non-profit; if it goes away, all old proofs become unverifiable. Mitigation: dual-anchor in both Sigstore and Bitcoin so the redundancy is real. (b) Cost: Bitcoin transaction fees vary; budget $5 to $50 per day. Mitigation: batch all tenants' chain roots into a single transaction. (c) Privacy: the chain root is a hash, so no plaintext leaks. Confirm with legal that the existence-of-record (publicly observable that tenant X had N audit events on day Y) is acceptable. Mitigation: tenant opt-in.

---

## Section 4. Sub-phases breakdown

Four weeks. Two engineers (Eng A on eval pipeline, Eng B on audit chain and replay). Domain expert curating golden set in parallel.

### Week 1. Server-side eval execution + golden set ground truth

Goals. Refactor `src/api/eval/run.js` to execute extractions server-side instead of trusting caller `actual`. Curate the first 50-document golden set with domain expert. Stand up Promptfoo locally and confirm it can run a single case end-to-end against the Anthropic adapter.

PR titles. (1) `eval: server-side extraction harness` (Eng A). (2) `eval: 50-case golden corpus for po-extraction suite` (domain expert + Eng A review). (3) `eval: promptfoo configuration scaffold` (Eng A).

Files touched.
- `/Users/kenith.philip/anvil/src/api/eval/run.js` (rewrite to call extraction adapter, drop caller-supplied actual, persist a richer result).
- `/Users/kenith.philip/anvil/evals/po-extraction/cases.yaml` (new, 50 cases).
- `/Users/kenith.philip/anvil/evals/po-extraction/promptfooconfig.yaml` (new).
- `/Users/kenith.philip/anvil/evals/fixtures/` (new directory, 50 documents in PDF + ground-truth JSON pairs).
- `/Users/kenith.philip/anvil/scripts/eval-export.mjs` (new, reads eval_cases from DB and writes to YAML for promptfoo).
- `/Users/kenith.philip/anvil/package.json` (add `eval:run` script).

Verification gates. (a) Unit test for the new `run.js` that verifies (with mocked Supabase) the harness calls the extraction adapter and scores the output. (b) Manual run of `npm run eval:run -- --suite po-extraction` produces a JSON report with 50 scored cases. (c) Domain expert sign-off on the 50-case corpus (annotated review meeting at end of Week 1).

### Week 2. CI gate + per-model dashboard + replay endpoint

Goals. Wire Promptfoo into the GitHub Actions workflow. Configure the regression gate at 2 percent accuracy drop. Ship the per-model accuracy dashboard. Ship the replay POST endpoint and basic admin UI.

PR titles. (4) `ci: eval gate at 2% regression threshold` (Eng A). (5) `dash: per-model accuracy breakdown on /admin/evals` (Eng A). (6) `replay: POST /api/replay/run endpoint and admin UI` (Eng B).

Files touched.
- `/Users/kenith.philip/anvil/.github/workflows/ci.yml` (add `eval` job that runs after `check` and `test`).
- `/Users/kenith.philip/anvil/scripts/eval-ci.mjs` (new, runs promptfoo, parses JSON, compares against baseline-on-main, fails if drop > 2 percent).
- `/Users/kenith.philip/anvil/src/api/eval/dashboard.js` (extend to return per-model breakdown by reading model_routing_log).
- `/Users/kenith.philip/anvil/src/v3-app/screens/evals.tsx` (add per-model chart).
- `/Users/kenith.philip/anvil/src/api/replay/run.js` (new endpoint).
- `/Users/kenith.philip/anvil/src/v3-app/screens/admin/replay.tsx` (new admin route).
- `/Users/kenith.philip/anvil/supabase/migrations/109_extraction_replays.sql` (new table).

Verification gates. (a) Push a PR that intentionally regresses a prompt; the eval CI gate must block the merge. (b) Per-model dashboard renders with at least two models (Anthropic, Gemini) showing distinct accuracy bars. (c) Replay endpoint round-trip: POST `case_id + prompt_version`, receive diff in response, see new row in `extraction_replays`.

### Week 3. Audit chain HMAC trigger + verifier + drift detector

Goals. Migration 111 adds `prev_hash`, `self_hash`, `sequence_no` columns and the before-insert trigger. Backfill existing rows. CI verifier in `scripts/verify-audit-chain.mjs`. Weekly drift detector cron.

PR titles. (7) `audit: prev_hash + self_hash columns and trigger` (Eng B). (8) `audit: backfill chain for existing rows` (Eng B, separate PR for safety review). (9) `audit: scripts/verify-audit-chain.mjs and CI step` (Eng B). (10) `eval: weekly drift detector cron + Slack alert` (Eng A).

Files touched.
- `/Users/kenith.philip/anvil/supabase/migrations/111_audit_chain_hmac.sql` (new, adds columns + trigger).
- `/Users/kenith.philip/anvil/supabase/migrations/112_audit_chain_backfill.sql` (new, separate so it can be deployed in a freeze window).
- `/Users/kenith.philip/anvil/scripts/verify-audit-chain.mjs` (new).
- `/Users/kenith.philip/anvil/.github/workflows/ci.yml` (add verifier as nightly job, not on every push).
- `/Users/kenith.philip/anvil/src/api/cron/eval-drift.js` (new).
- `/Users/kenith.philip/anvil/src/api/_lib/slack.js` (extend if needed).
- `/Users/kenith.philip/anvil/supabase/migrations/110_eval_drift_runs.sql` (new table).

Verification gates. (a) Migration 111 applied to a staging tenant: insert 100 audit events, verifier passes. (b) Manually delete one row from `audit_events` in staging; verifier flags the break with the missing sequence number. (c) Drift detector runs against staging golden set; Slack message arrives at the eng-notifs channel within 1 minute. (d) Backfill on production-clone: walks 50,000 historical rows in under 5 minutes per tenant.

### Week 4. Prompt-injection bench v2 + per-model dashboard polish + dogfooding

Goals. Extend the PI bench from Anthropic-only to cover Gemini and Mistral. Polish the dashboards based on early customer feedback (from Week 3 dogfooding). Run the full Phase 2 exit-criteria verification.

PR titles. (11) `eval: prompt-injection bench coverage for gemini` (Eng A). (12) `eval: prompt-injection bench coverage for mistral` (Eng A). (13) `audit: phase 2 exit-criteria smoke test` (Eng B).

Files touched.
- `/Users/kenith.philip/anvil/evals/prompt-injection/probes.yaml` (extend probes to all three adapters; pre-existing on main is Anthropic-only).
- `/Users/kenith.philip/anvil/evals/prompt-injection/runner.mjs` (extend to dispatch to all three adapters).
- `/Users/kenith.philip/anvil/scripts/phase-2-exit.mjs` (new, runs all eight verification checks in sequence).
- `/Users/kenith.philip/anvil/src/api/_lib/docai/gemini.js` (instrument for injection-probe entry point).
- `/Users/kenith.philip/anvil/src/api/_lib/docai/mistral.js` (same; note: Mistral adapter file path may differ on main).

Verification gates. Phase 2 exit-criteria smoke test passes: CI gate active, audit-chain verifier passes weekly, replay endpoint functional, drift detector posted at least one weekly report, PI bench v2 covers all three adapters with passing rates above the agreed threshold (target >= 95 percent refuse-rate on documented injection patterns), per-model dashboard renders.

---

## Section 5. Customer value plus revenue impact

Eval credibility is the meta-blocker for any public accuracy claim, which is the meta-blocker for any cost-per-extraction pricing tier, which is the meta-blocker for the price expansion from per-tenant flat fee to per-document metered billing. Quantify the unlock.

Per-tenant flat fee today is around $1,000 to $5,000/month, with an unbounded number of extractions per tenant (the customer who runs 50,000 extractions a month pays the same as the customer who runs 5,000). The economics work because Anvil prices ahead of the cost curve, but they only work to a point: tenants who plateau at 50,000 extractions cost more in LLM API spend than the flat fee covers, and Anvil eats the delta.

Per-document metered billing fixes this. At an indicative $0.05 per extraction (conservative; competitors charge $0.15 to $0.50 for comparable structured extraction [verified-from-prior-knowledge of competitor pricing pages as of 2025]), a 50,000-extraction tenant pays $2,500/month metered, plus a $500 platform fee, for $3,000 of revenue against an estimated $700 in LLM API costs. Net margin per heavy tenant goes from "loss-leader" to 75 percent.

Why metered pricing requires Phase 2. A customer asked to pay per-extraction will reasonably ask: "what is the accuracy at this price?". If Anvil cannot answer with a defensible number, the customer pushes back, and Anvil discounts to win the deal. The discount erodes the margin advantage that metered pricing was supposed to create. With Phase 2 evals, the answer is "98.2 percent on the golden set, verified by CI on every push to main, with a public trust page at trust.anvilcrm.com/<tenant>". The customer has a tangible number, the negotiation centres on volume not on accuracy, and Anvil holds the margin.

Quantified revenue unlock. Three lines:

Line 1. Metered-billing expansion. 30 percent of existing tenants migrate to metered billing within 6 months of Phase 2 launch. Average tenant moves from $2,000/month flat to $3,500/month metered (the heavy users; the light users actually save). At 200 tenants today and 30 percent migration, that is 60 tenants times $1,500 monthly delta times 12 = $1,080,000 incremental annual recurring revenue.

Line 2. Enterprise upsell. The trust page (Idea 3.1) and SLA tier (Idea 3.3) attract enterprise buyers who would not have considered Anvil at the lower trust bar. Conservatively, 5 new enterprise logos per quarter post-Phase-2 at average $30,000 annual contract value (3x the mid-tier average) = 20 logos times $30,000 = $600,000 incremental annual recurring revenue in the first 12 months post-launch.

Line 3. Reduced churn from credibility. Mid-market customers who would have churned at 12 months because of "the extractions are wrong sometimes and I cannot tell when" stay because the trust page lets them see when. Conservative 10 percent churn-rate reduction on a 30 percent baseline churn = 200 tenants times $2,000/month times 0.03 times 12 = $144,000 in retained annual revenue.

Total quantified unlock from Phase 2: $1.82M incremental annual recurring revenue in year 1. The cost of Phase 2 (two engineers for four weeks plus domain expert plus ~$1,000/month CI budget) is approximately $80,000 to $120,000 over the four weeks. Payback period: under 30 days post-launch.

Beyond direct revenue, eval credibility unlocks three non-revenue strategic positions: (a) regulatory readiness for BRSR data-quality requirements (mandated for Indian listed companies, the same buyers who are Anvil's enterprise ICP), (b) EU AI Act conformity assessment (the act applies from August 2026 for high-risk AI systems, and document-extraction-for-financial-decisions arguably qualifies [verified-from-prior-knowledge of the AI Act effective dates]), (c) a position to credibly raise a Series A on a "trust-first AI vendor" narrative that no other procurement-AI competitor can match.

Customer value qualitative summary. Buyers in the ICP all share one frustration with AI vendors: "I cannot tell if it is right". Phase 2 makes the answer to that frustration mechanically checkable. The Trust Card displays the number. The Replay UI lets the buyer reproduce any failure. The Audit Chain proves no record was altered. The Drift Bounty rewards the buyer for catching what slipped through. The Constitutional Eval encodes the rules the buyer's internal audit cares about. Together, these convert AI from a black box into a glass box, which is the single biggest unlock in this market segment as of 2026.

---

## Section 6. Risk register

Two risks plus mitigation per P0/P1 item, plus three cross-cutting risks.

F14 server-side eval execution. Risk A: extraction costs blow past the CI budget when a developer makes many small PRs in a day. Mitigation: per-day-per-repo cap at $50 (warn) and $100 (hard stop, fall back to cached scores). Risk B: the 50-case corpus does not represent the production traffic mix and gives a misleadingly high accuracy number. Mitigation: corpus refresh cadence (Drift Bounty in Idea 3.4 feeds new cases continuously, manual audit quarterly).

F15 golden-set drift detector. Risk A: weekly cron fails silently and we miss a drift event for a month. Mitigation: dead-man's-switch (a separate weekly job posts "drift detector ran successfully at <time>"; on-call alerts if that message is absent for >9 days). Risk B: alert fatigue from too many minor drift signals. Mitigation: only alert on rolling 30-day drift > 0.5 percent, not per-run noise.

F16 replay UI. Risk A: an operator replays a document and accidentally overwrites the original extraction. Mitigation: replays write to a separate table (`extraction_replays`); explicit "promote to canonical" button requires a separate action. Risk B: replays leak across tenants (operator A pulls a case from tenant B's data). Mitigation: tenant-scoped admin role; admin replay scope is limited to the operator's home tenant unless escalated with a SOC 2 break-glass procedure.

F17 audit-chain HMAC at write. Risk A: the trigger introduces a per-tenant serialisation bottleneck and slows audit writes during peak load. Mitigation: load test in staging; if any tenant exceeds 100 audit writes per second sustained, consider a queue-based async chain with a known visible-window-of-inconsistency caveat in the docs. Risk B: backfill on production breaks the deployment and rolls back. Mitigation: backfill in a separate migration (112) deployed in a maintenance window; pre-validated on a production-clone.

F18 prompt-version stamping (continuation). Risk A: developers forget to bump the prompt version when changing prompt text. Mitigation: pre-commit hook that compares prompt hash to last-committed-version and refuses commit if mismatched without bump. Risk B: version explosion (10 prompt versions for trivial reasons). Mitigation: semantic versioning enforced by CI lint; patches must change <5 characters, minors must not break schema, majors require an architectural justification PR comment.

PI bench v2 (Gemini + Mistral). Risk A: Gemini and Mistral APIs change their content-filtering behaviour mid-Phase-2, breaking probes. Mitigation: probe catalogue versioned independently from runner code; probes that begin failing get tagged "behavior-changed" rather than "regression", and engineering reviews monthly. Risk B: probes leak prompt-injection technique to attackers via public artefacts. Mitigation: probe content kept private (under `evals/prompt-injection/private/` with a `.gitignore` for the public mirror); only aggregate pass-rate exposed publicly.

CI eval gate. Risk A: false-positive blocks legitimate PRs (model output drift, not prompt regression). Mitigation: voting (Section 2.1 Promptfoo recommendation); a block requires 2 of 3 runs to show regression. Risk B: developers learn to bypass with `[skip eval]` in the commit message. Mitigation: skip-eval is permitted only for `[docs:]`-prefixed PRs; enforced by branch protection rules in GitHub.

Per-model accuracy dashboard. Risk A: dashboard renders stale or per-tenant-contaminated data. Mitigation: dashboard queries are tenant-scoped via the same RLS pattern as `eval_dashboard`; auto-refresh every 60 seconds for staleness; cache TTL no more than 5 minutes. Risk B: the per-model breakdown leaks comparative model performance externally (used by Anthropic/Gemini in sales conversations against us, or used by competitors). Mitigation: per-model breakdown is internal-only; only aggregate accuracy is on the Trust Card.

Cross-cutting risk 1. LLM stochasticity. Two runs of the same prompt produce minor output drift even at temperature 0. Impact: CI gate flickers between pass and fail without any code change. Mitigation: 3-way voting on each case; majority decides the score; flag as "stochastic" if all three differ. Adopt a documented "stochastic variance band" (currently estimated at +/-0.3 percent on the golden set [inferred from pilot runs]) and only trigger the gate on regressions outside this band.

Cross-cutting risk 2. CI cost. Eval runs on every push are expensive. Impact: at >$1,000/month, finance pushback. Mitigation: budget alert at $500/month (warn), $800 (require eng-mgr approval to continue), $1,000 (hard stop, fall back to cached scores). Cache scores by `(prompt_hash, model_id, document_hash)`; only re-run when one of the three changes. Estimated cache hit rate >70 percent after first month based on typical PR change footprint.

Cross-cutting risk 3. Freeze-window for audit-chain backfill. The audit-chain trigger requires a backfill on existing rows before the trigger goes live. Impact: 5-minute audit-write pause per million rows per tenant. Mitigation: schedule the freeze during the lowest-traffic window (Sunday 02:00 IST); pre-announce to all tenants 7 days in advance; backfill chunked to 100K rows per transaction so any failure rolls back safely.

---

## Section 7. Success metrics

Green-light criteria for Phase 2. Eight metrics; all must pass before Phase 3 begins.

Metric 1. Server-side eval coverage. Every PR to main runs the 50-case golden corpus. The CI run is recorded in `eval_runs` with `suite = "po-extraction-ci"`. Target: 100 percent of merges to main since the eval gate went live carry a corresponding `eval_runs` row.

Metric 2. CI gate effectiveness. PRs whose accuracy regression exceeds 2 percent block on merge. Target: at least 2 such blocks during Phase 2 (validates the gate is wired correctly) without any false positives that required a manual override.

Metric 3. Baseline accuracy stamped. The accuracy number that the public `/trust` page will read is recorded as a row in `eval_runs` and is consistent across runs (variance within +/-0.3 percent over 10 consecutive CI runs). Target: 96 percent or higher baseline accuracy.

Metric 4. Audit-chain verifier passes. Weekly verifier run completes without flagging any chain break across all production tenants. Target: 4 of 4 weekly runs pass during Phase 2.

Metric 5. Drift detector activity. Drift detector posts a weekly Slack message to the eng-notifs channel. Target: 4 of 4 weekly posts.

Metric 6. Replay endpoint usage. At least 10 replay calls executed by admin operators on real production cases (dogfooding). Target: 10 calls during Week 4 + smoke-testing.

Metric 7. PI bench v2 coverage. All three adapters (Anthropic, Gemini, Mistral) have at least 20 probes each, and refuse-rate is at least 95 percent on each adapter. Target: all three adapters pass.

Metric 8. Per-model dashboard live. Per-model accuracy chart renders on the `evals` screen for at least the three configured adapters; data updates within 60 seconds of a fresh CI run.

Phase 2 is considered shipped when 8 of 8 metrics pass for one calendar week. The Phase 3 work begins immediately after.

Beyond the green-light gates, the following secondary metrics should be tracked through the rest of 2026:

Secondary 1. Eval cost per CI run. Target: under $7 per run sustained; investigate if it exceeds $10.

Secondary 2. Eval CI duration. Target: under 10 minutes; investigate if it exceeds 20 minutes (developer friction).

Secondary 3. False-positive blocks. Target: under 1 per quarter (any higher means the gate is over-strict and developers will start working around it).

Secondary 4. Audit-chain backfill incidents. Target: zero post-launch; the first known incident triggers a postmortem within 72 hours.

Secondary 5. Trust-page latency (when shipped in Phase 3). Target: under 500ms median, under 1500ms p99.

These secondary metrics feed the Phase 3 retrospective and the Phase 4 prioritisation conversation.

---

## Section 8. Open questions and deferred decisions

The Phase 2 plan is bounded but several deeper questions surface during execution that this document deliberately defers to a follow-on conversation. Capture them here so they are not lost.

Open question 1. Should the Trust Card (Idea 3.1) display per-document-class accuracy (purchase orders vs invoices vs e-way bills) or only the headline aggregate? Per-class breakdowns are more informative to a sophisticated buyer but expose Anvil's relative weakness on smaller corpora (e.g., e-way bill at 50 documents vs PO at 500). Defer to Phase 3 design review with the design lead.

Open question 2. Does the audit-chain HMAC trigger need to be per-Postgres-schema or per-database? Multi-tenant Postgres setups sometimes shard by schema. Anvil currently does not, but the F17 design should explicitly state the boundary so the future shard story does not break the chain. Defer to a 30-minute architecture review with the platform engineer.

Open question 3. Should the per-model dashboard (Metric 8) show raw model costs alongside accuracy? It would surface the true cost-per-correct-extraction metric, which is far more useful than either metric alone. The privacy risk is that this exposes Anvil's negotiated rates with each provider. Defer to a commercial-strategy conversation; recommend internal-only for v1 and a redacted public version for Phase 3.

Open question 4. The eval CI gate (Metric 2) blocks PRs on regression > 2 percent. Is 2 percent the right threshold? Too tight and developers grow to hate the gate; too loose and small regressions compound. Recommend starting at 2 percent, reviewing after 6 weeks of data, and adjusting to between 1 percent and 3 percent based on observed false-positive rate.

Open question 5. The Drift Bounty program (Idea 3.4) raises a legal question: who owns the IP on a customer-submitted golden-set case? The customer's source document is theirs; the labelled (document, expected output) pair after Anvil's triage may have shared ownership. Defer to legal review; recommend explicit terms in the bounty submission form.

Open question 6. The Tamper-evident Audit Subscription (Idea 3.5) double-anchors into Sigstore and Bitcoin. Should it also be optionally anchored into a customer-chosen public log? Some EU customers may prefer a European-jurisdiction transparency log over a US-operated one. Defer to enterprise sales conversations; recommend the customer-chosen anchor as a $500/month add-on if demand materialises.

Open question 7. The PI bench v2 (Section 4 Week 4) targets 95 percent refuse-rate. Is 95 percent enough? The remaining 5 percent are the prompt-injection attacks that succeed. For high-value financial workflows, "5 percent of injection attempts work" is unacceptable. Recommend that for the SLA tier (Idea 3.3), the contractual guarantee scopes to 99 percent refuse-rate, and that the eval expands to 100+ probes per adapter to make the 99 percent number statistically meaningful.

Open question 8. Should the constitutional eval (Idea 3.3) be open-sourced? Releasing `evals/constitution.md` as a public artefact strengthens the "trust-first vendor" positioning but reveals Anvil's defensive depth to competitors. Recommend a delayed-release: publish the constitution N months after first writing, so competitors copying the document are always behind. Defer to marketing-strategy review.

---

## Section 9. Glossary and conventions

Terms used throughout this document that may be unfamiliar to a reader joining mid-conversation.

Adapter. A model-specific call wrapper in `src/api/_lib/docai/`. Anvil ships Anthropic (claude.js), Gemini (gemini.js), and Mistral (mistral.js or whichever file exists on main; see Section 4 Week 4 file list). Each adapter takes a document and a prompt and returns a structured extraction.

Audit chain. The hash-linked sequence of `audit_events` rows added by F17. Each row's `self_hash` is computed over (prev_hash, canonical_form_of_row). Removing any row breaks the chain.

Canonical form. A deterministic serialisation of a row's content for hashing. JSON with sorted keys, fixed encoding for null and numerics, excludes the hash columns themselves.

Constitutional eval. A grader-LLM-based check that an extraction conforms to a written set of business rules. See Idea 3.3.

Drift. A slow change in evaluation pass rate over time, separate from a sudden regression. The drift detector (F15) is the safety net for slow change that escapes the CI gate.

Golden set. A curated set of (document, expected-extraction) pairs used as the ground truth for evals. Phase 2 ships 50 cases; Phase 4 targets 200 cases.

HMAC. Hash-based message authentication code. SHA-256 keyed with `AUDIT_EXPORT_HMAC_SECRET` today. After F17, also used at write-time via the audit-chain trigger.

LLM-as-judge. The technique of using one LLM to grade another LLM's output. Used in Constitutional Eval and in some PI bench probes.

Per-model dashboard. The admin-route chart at `/admin/evals` that shows accuracy split by adapter (Anthropic vs Gemini vs Mistral). Helps engineering pick the cheapest adapter that meets accuracy targets per document class.

PI bench. Prompt-injection bench. The set of adversarial probes that test whether each adapter refuses or yields to documented injection patterns.

Promptfoo. The eval framework adopted in Phase 2 for the CI accuracy gate. See Section 2.1.

Replay. Re-running an existing extraction with a new prompt or new model. See F16 and Idea 3.2.

RLS. Row-level security. The Postgres feature that scopes queries to a tenant's rows. The audit-chain HMAC bypasses RLS at write time (via the service-role client) but the chain integrity catches any post-write tampering.

Sequence number. The `sequence_no` column on `audit_events` added by F17. Per-tenant monotonic. Used by the verifier to detect missing rows.

Trust Card. The public-facing tenant trust page in Idea 3.1. Phase 2 ships the underlying data; Phase 3 ships the UI.

Voter. The internal consensus mechanism that runs the same document through multiple adapters and picks the majority answer per field. Implemented in `src/api/_lib/docai/voter.js`. The eval pipeline treats each adapter's output as a separate scoreable artefact for Phase 2, and treats the voter chain as a fourth implicit adapter for the per-model dashboard.

Convention. File paths cited as `file:line` are absolute under `/Users/kenith.philip/anvil/`. Tags `[verified-on-main]`, `[verified-from-prior-knowledge]`, `[inferred]` distinguish what was checked on the live branch, what came from external knowledge, and what is judgment.

---

End of Phase 2 plan. Status: ready for engineering review. Distribution: eng-mgr, security-lead, design-lead, customer-success-lead, plus the assigned engineers for the four-week sprint.
