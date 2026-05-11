# A13 Red-Team Synthesis (v3 rewrite)

Scope: a critical pass over the 12 enhanced surface reports (A1 through A12) aggregating roughly 393 findings, re-grounded against `/Users/kenith.philip/anvil/` on `main` at commit `c4f946b`.
Author seat: red-team / critic, sequential re-run after the parallel fleet drifted onto a stale worktree.
Date: 2026-05-11.
Tag legend used throughout: `[verified-on-main]` means I opened the cited file on `main@c4f946b` during this pass; `[verified-from-surface-report]` means the surface report's citation is internally consistent and the file exists on main but I did not re-open it; `[inferred]` means a defensible reading of two or more verified facts; `[speculative]` means market or competitor judgement without a primary citation in this session.

---

## Section 1. Critical orientation: the worktree problem and the path of record

The first parallel run of A1 through A12 read from a stale worktree at `/Users/kenith.philip/anvil/.claude/worktrees/objective-meninsky-15e45d` (commit `a24d582`). Main on commit `c4f946b` is materially different: 103 numbered migrations versus 6, a 67-screen Vite v3-app under `src/v3-app/screens/` versus an absent React tree, 373 API endpoints under `src/api/`, a hardened `ALLOW_ANONYMOUS_TENANT="false"` default with a production startup guard, and a single Vercel function (`api/dispatch.js`) that fans out via `src/api/router.js`. The path of record for this synthesis is `/Users/kenith.philip/anvil/` on `c4f946b`. Worktree references are explicit footnotes only.

The sequential re-run that produced reports 01 through 12 in `/tmp/analysis-v2/` substantially cleaned up worktree references: A1 (`01-landing-onboarding.md:5`), A2 (`02-so-intake-orders.md:6-13`), A4 (`04-erp-integrations.md:1-11`), A5 (`05-data-model.md:2`), A7 (`07-india-stack.md:3`), A8 (`08-ai-surfaces.md:3-8`), A9 (`09-marketplace.md:5-6`), A10 (`10-security.md:1-9`), A11 (`11-obs-admin-pricing.md:4-5`), and A12 (`12-ui-primitives.md:3`) all anchor explicitly on `main@c4f946b`. A6 (`06-inventory-conformal.md:3-6`) is the lone outlier that still names the worktree path inside its opening "Deep audit against `main @ c4f946b`, worktree" sentence even though the file citations themselves resolve on main. Treat A6 citations as main-applicable but expect minor numerical drift on residual counts and migration line numbers because the worktree carried a slightly older inventory snapshot. `[verified-on-main]`

A second class of residual is unavoidable: the surface reports were written before the deferred-tools mechanism was understood as denying WebFetch. A11 and A1 in particular note this explicitly and tag every competitor citation `[verified-from-prior-knowledge]`. A red-team consumer should weight those competitor benchmarks as confident but not freshly checked; the citations are stable URLs and the claims are public-facing marketing, so the failure mode is "Anvil's positioning misreads competitor copy that has since been updated" rather than "the competitor claim was hallucinated".

The path of record consequence is operational: every fix proposal in this synthesis cites a file:line that I or the surface report's author opened on main during the audit window. Any claim tagged `[verified-on-main]` should reproduce on `git checkout c4f946b && grep -n ...`. Any claim tagged `[inferred]` should be re-verified before action.

---

## Section 2. Top 10 must-do items the surface agents got right

Ranked on a five-axis rubric: user-pain (PSev), market-differentiation (MDiff), tech-leverage (TLev), evidence-strength (EStr), strategic-fit (SFit), each scored 1 to 5. Total out of 25.

### 2.1 Tally `VCHTYPE="Sales Order"` defect persists on main; GSTR-1 unreachable

Source surface: A7 (F7.1, `07-india-stack.md:68-99`) and A2/A3 cross-confirm. Verified at `src/api/tally/amend.js:46` where the XML envelope emits `VCHTYPE="Sales Order" ACTION="Alter"` with `<VOUCHERTYPENAME>Sales Order</VOUCHERTYPENAME>`, and at `src/api/tally/push.js:65` where `voucherType = body.voucherType || "SalesOrder"` defaults the same shape for the create path. `[verified-on-main]` The legacy bundler at `src/legacy/so-agent-pocv4.jsx:652` repeats the pattern on its create envelope. `[verified-from-surface-report]`

TallyPrime's Sales Order is a non-accounting order voucher; it does not credit the party ledger, does not debit CGST/SGST/IGST ledgers, and does not surface in GSTR-1. CGST Act Section 31 mandates tax invoices for taxable supplies; Section 122(1)(i) penalises failure to issue at Rs 10,000 per invoice or 100% of tax due whichever is higher. Anvil tenants pushing 500 invoices per month at Rs 2 lakh tax each carry a worst-case Rs 10 crore monthly exposure. `[verified-from-surface-report A7]`

The complete fix is three weeks: introduce a `VoucherEnvelope.salesV2` builder, emit three `<ALLLEDGERENTRIES.LIST>` rows for CGST/SGST/IGST per line item, write a TallyPrime sandbox harness, migrate customers off the SalesOrder path via a feature flag, and add a GSTR-1 dry-run differ against the Tally Day Book. Migration 016 (`016_tally_v2.sql:88-93`) widened `tally_voucher_records.voucher_type` to all ten voucher types, but the XML builder still emits Sales Order. `[verified-from-surface-report A7]`

Score: PSev 5, MDiff 5, TLev 5, EStr 5, SFit 5. Total 25/25.

Simplest fix step one: change the XML literal on `src/api/tally/amend.js:46` to `VCHTYPE="Sales"` and `VOUCHERTYPENAME>Sales`. Step two (same PR): default `voucherType = body.voucherType || "Sales"` on `src/api/tally/push.js:65`. Step three: wire `tenant_settings.tally_voucher_kind` with values `{Sales, Tax Invoice}` default Sales. Step four: emit GST ledger lines.

### 2.2 `auth_magic_links` RLS cross-tenant PII leak

Source surface: A5 (F5.1, `05-data-model.md:118-150`), A10 cross-references. Verified at `supabase/migrations/003_studio_ocr_fx_inventory_lead.sql:241`: `create policy magic_links_select on auth_magic_links for select using (tenant_id is null or tenant_id in (select current_tenant_ids()));`. `[verified-on-main]` Every row is written by `api/auth/magic_link.js:36-42` with `tenant_id` unset (default null), so the policy treats the entire table as world-readable to any authenticated user via PostgREST.

Realistic exploit per A5: `curl -H "Authorization: Bearer <tenant-A-jwt>" "$SUPABASE_URL/rest/v1/auth_magic_links?select=*&order=requested_at.desc&limit=1000"` returns the most recent 1000 magic-link audit rows: emails, IPs, user-agents, outcomes. DPDP Act Section 6 (notice and consent for personal data processing) is breached the moment a tenant queries another tenant's rows. SOC 2 CC6.1 blocks certification while the policy stands. `[verified-from-surface-report A5]`

The fix shape already exists in migration 059 for `prospecting_suppressions`: tighten the policy to `tenant_id is not null and tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid` after backfilling `tenant_id` from the email's user record. Backfill SQL is in A5's proposed migration block.

Score: PSev 5, MDiff 4, TLev 5, EStr 5, SFit 5. Total 24/25.

Simplest fix: a single migration `104_magic_link_tenant_scope.sql` doing backfill + policy replace + `set not null` on `auth_magic_links.tenant_id`. Two engineering days; one day staging soak.

### 2.3 Storage bucket policy: cross-tenant document read

Source surface: A5, A10, A1, A9 all cite this. Verified at `supabase/migrations/001_init.sql:480-483`: `create policy "obara documents read" on storage.objects for select using (bucket_id = 'obara-documents' and auth.role() = 'authenticated');`. `[verified-on-main]` No subsequent migration patches the policy through 103. `[verified-from-surface-report A5]`

Risk profile: today's exploit requires an attacker who can enumerate document IDs (UUIDs, low practical entropy). But the policy is structurally wrong: a token leak from any tenant grants cross-tenant document read, and as the platform grows, an insider at Anvil with a test account can read enterprise customer documents. The category benchmark (Hyperscience, Rossum, Conexiom) all scope storage by path-prefix tied to tenant. `[verified-from-surface-report A10]`

Fix: migration that scopes the SELECT/INSERT policies on `storage.objects` to `bucket_id = 'obara-documents' AND (storage.foldername(name))[1] = <tenant-uuid-from-jwt>`. Enforce path convention `<tenant_uuid>/<document_id>/<filename>` on upload. Backfill existing documents that don't match. Add `documents.bucket_path` column for explicit reference.

Score: PSev 5, MDiff 4, TLev 4, EStr 5, SFit 5. Total 23/25.

Simplest fix: three to four engineering days with backfill; production-breaking for any browser-direct `supabase.storage.from()` call, but A5 inventory suggests the SPA goes through the API not direct storage.

### 2.4 Eval credibility: caller-supplied actual results, no CI gate

Source surface: A3 (`03-docai-engine.md` and F3.x series), A11 cross-references. Verified at `src/api/eval/run.js:21-22`: "Caller submits actual extraction results (since this server is generic) and we just score + record." `[verified-on-main]` There is no `.github/workflows/eval*.yml` on main, and the eval harness scores caller-submitted `actual` blocks against caller-stored `expected` blocks with no server-side execution.

Consequence: any frontend regression that drops a line item, normalises a UOM wrong, or coerces a number to a string scores as an LLM accuracy bug. The dashboard at `api/eval/dashboard.js` will show accuracy dropping; the team tunes the prompt; accuracy "recovers" when the client-side bug is also fixed downstream; the prompt change gets the credit. Every product decision downstream of the eval dashboard is suspect. The bet on the `/trust` page (A1, A9) cannot ship until the harness is server-verified.

Fix: refactor `run.js` to accept `{ case_id, document_source_id }` and invoke `runExtractionPipeline()` directly from `src/api/_lib/docai/run.js`. Add HMAC attestation to result rows. Add `eval_runs.prompt_version`, `model_version`, `pipeline_version` columns. Add a GitHub Actions job that runs a 20 to 50 case golden suite on every `main` push and blocks merge on greater than 2% accuracy regression.

Score: PSev 4, MDiff 5, TLev 5, EStr 5, SFit 5. Total 24/25.

Simplest fix: four to five engineering days plus golden-fixture curation. Anthropic API cost approximately $5 to $20 per CI run; budget $250 to $1,000 per month at 50 PRs.

### 2.5 External cron-job.org dependency for `/api/cron/tick`

Source surface: A11, A4, A8 all surface this. Verified at `vercel.json:12-17`: only `/api/cron/daily` is registered at `30 2 * * *`. `[verified-on-main]` The tick handler at `src/api/cron/tick.js:1-19` documents the 5-minute cadence and the per-handler fan-out, but the file is not registered in vercel.json. `docs/CRONS.md` (per A4 and A11) documents the cron-job.org external scheduler dependency. `[verified-from-surface-report A11]`

Failure mode: if the cron-job.org free account lapses (card expired, account banned, operator forgot to set it up), every sub-daily workflow goes silent: email parse, all 17 ERP retry queues, voice, WhatsApp, inventory positions, inventory exceptions, autonomous agents, push notification drain, drift meter, Tally reconciliation. No alert fires because the only signal is the heartbeat row not updating, and the heartbeat-staleness check is itself triggered by the daily cron which fires only at 02:30 UTC.

Fix path A: add `{"path": "/api/cron/tick", "schedule": "*/5 * * * *"}` to `vercel.json`. If the function-count cap blocks (Hobby tier caps at 12 functions; this codebase already consolidates to one via dispatch.js), upgrade the plan. Path B fallback: keep external scheduler but wire a heartbeat-staleness alert into `daily.js`: if `cron_health.last_seen_at` on `tick` is more than 15 minutes stale, fire Sentry plus email on-call. `[verified-from-surface-report A11]`

Score: PSev 5, MDiff 2, TLev 4, EStr 5, SFit 5. Total 21/25.

Simplest fix: one to two engineering days for Path A; three days for Path B.

### 2.6 Service-role bypass plus 359 service-client call sites; tenant isolation rests on `.eq()` discipline

Source surface: A5 (`05-data-model.md:0.10` and F5.1+), A10 (F10.1, `10-security.md:56-119`). Verified inventory: `grep -rln "serviceClient()" src/api/` returns 359 files; `grep -rE '\.eq\("tenant_id"' src/api/ | wc -l` returns 889 occurrences across 299 files. `[verified-from-surface-report A5]` `[verified-from-surface-report A10]` Every business handler uses `serviceClient()` which carries `BYPASSRLS`. The 103 migrations install dozens of tenant policies, but every one is bypassed by the service-role JWT used by Vercel functions.

Concrete risk: A5 surfaced one specific gap in `admin/members.js` (since fixed by audit C1 follow-ups), but the pattern is structural: any new endpoint that omits `.eq("tenant_id", ctx.tenantId)` is silently cross-tenant by default. No CI gate, no Semgrep rule, no nightly cross-tenant integrity scan exists. A10 ranks this Critical with high trust.

Fix: build `scripts/audit-rls-coverage.mjs` (AST walker over every `svc.from(...)` chain). Output coverage report. Wire into `npm run check`. Annotate exempt endpoints (`audit/export`, super-admin endpoints) with `// rls-bypass:reason` comments the linter checks. Phase 2 (longer): migrate selected read paths to user-JWT scoped clients so RLS becomes load-bearing again.

Score: PSev 5, MDiff 3, TLev 5, EStr 5, SFit 5. Total 23/25.

Simplest fix: six to eight engineering days for the static analysis plus two to three days fixing gaps the tool surfaces.

### 2.7 Tally GST envelope: hardcoded `OBARA_STATE = "Maharashtra"` single-tenant constant

Source surface: A7 (F7.3+ series), A5. Verified at `src/scripts/build-unified-app.mjs:1363`: `const OBARA_STATE = "Maharashtra";`. `[verified-on-main]` Interstate-vs-intrastate GST classification is derived against this constant; any non-Maharashtra tenant has every order classified as interstate (IGST) when it should be intrastate (CGST+SGST), or vice versa. `[verified-from-surface-report A7]`

Combined with the VCHTYPE defect (item 2.1), the legacy SO bundler emits structurally wrong GST classification on top of a structurally wrong voucher type. Three separate files (`amend.js`, `push.js`, `build-unified-app.mjs`) contribute to GST incorrectness; fixing only amend.js leaves the bundler path broken for any tenant who runs through the legacy export.

Fix: replace the constant with `tenant_settings.state_code` lookup. Migration to add the column. Derive seller-state from `tally_companies.gstin` (first two digits is the state-code prefix) when state_code is null. Update interstate-vs-intrastate logic to use the resolved state. Add a test fixture covering Maharashtra, Tamil Nadu, Karnataka, and one union territory tenant.

Score: PSev 4, MDiff 3, TLev 4, EStr 5, SFit 5. Total 21/25.

Simplest fix: two to three engineering days.

### 2.8 Anomaly engine: 20 robust-MAD rules ship, but Gaussian client-side path still concatenates

Source surface: A8 (F8.1, `08-ai-surfaces.md:42-55`). Verified that `src/api/anomaly/compute.js` is 770 lines with 20 rules; the client-side `src/scripts/build-unified-app.mjs:962 detectAnomalies` still runs Gaussian mean+std and concatenates onto remote MAD flags at `build-unified-app.mjs:4218-4220`. `[verified-from-surface-report A8]` The MAD treatment is correct (Leys 2013); the Gaussian treatment fires false flags on heavy-tailed B2B procurement data because a single 10x past order balloons mean and std.

Operational consequence: operators see the same anomaly fire twice per order with different z-scores and potentially different severity strings. Alert fatigue in anomaly detection is the proximate cause of every major missed-anomaly breach in the public security literature (Target 2014, FireEye 2020). The fix is a two-day refactor: delete `detectAnomalies` from `build-unified-app.mjs:962-988`, convert the concat at 4220 into an assignment, ship a thin client cache to avoid flag-flicker between client-side initial render and post-extract server-confirmed flags.

Score: PSev 4, MDiff 4, TLev 4, EStr 4, SFit 4. Total 20/25.

Simplest fix: two engineering days. Pair with item 2.9 below.

### 2.9 Autonomous-agent runtime: no kill switch, no budget cap, no spend accounting

Source surface: A8 (F8.3, `08-ai-surfaces.md:73-95`). Verified: `grep -rn "agent_budget|tenants_paused|kill_switch|pause_all" src/api/` returns zero hits. `[verified-from-surface-report A8]` The runner at `src/api/agents/run.js:382-410` reads up to 50 active goals per tick and burns through them in a single pass. Each goal can call Sonnet (about $0.004 per draft), insert `communications` rows that the reaper sends within the same tick via SendGrid, insert `voice_calls` rows that the provider dials immediately, or issue portal pay links.

Hostile email body with prompt-injection that triggers a runaway agent has no spend ceiling. Cooldown corruption (`cooldown_hours = -1` passed via the unvalidated config jsonb at `goals.js:75`) re-fires every tick. SendGrid outage produces dead-letter rows but no exponential backoff. Three concrete fixes are needed: tenant-level kill switch (`tenants.agents_paused_at`), per-tenant per-day spend cap (`tenants.agent_budget_cents_month`) gated pre-dispatch, config-validator on goal arming that rejects `cooldown_hours < 1 or > 720`.

Score: PSev 5, MDiff 3, TLev 4, EStr 4, SFit 4. Total 20/25.

Simplest fix: three migrations plus a pre-dispatch gate in `run.js`. Three to four engineering days plus operator UX.

### 2.10 Prompt-injection bench bypasses the production path; six manual cases, no CI

Source surface: A3 (F3.x series), A8 cross-references. The injection harness exercises a stub call site that does not pass through `_lib/anthropic.js` redaction firewall, and there are only six manual test cases. The browser-direct `callClaude` path in `public/index.html` historically applied no firewall. `[verified-from-surface-report A3]`

Spot-checked on main: `src/api/claude/messages.js:51-59` confirms that `bypassFirewall=true` is gated by `requirePermission(ctx, "admin")`, not write. The surface report's claim that any write-role caller can pass `bypassFirewall` was true on the worktree but is closed on main. `[verified-on-main]` The remaining risk is the browser-direct path (still active in the legacy SPA) and the injection bench's failure to exercise the production code path. PDF metadata vectors are not covered.

Fix: refactor the injection bench to invoke `callAnthropic()` and `callGemini()` post-redaction, add to CI, fail build on any new injection that succeeds. Build a 200-prompt suite covering OWASP LLM Top 10. Verify by running against a known-vulnerable historical commit and observing the bench fail.

Score: PSev 4, MDiff 3, TLev 4, EStr 4, SFit 4. Total 19/25. Slightly lower than the prior v2 ranking because the most-critical "any write user can bypass" framing is no longer accurate on main.

Simplest fix: three engineering days for the bench refactor, plus one to two weeks of corpus curation.

---

## Section 3. Top 10 surface-agent findings that are wrong, padded, or already-fixed on main

These claims have entered the synthesis layer of the fleet but do not survive a spot-check on `c4f946b`.

### 3.1 "ALLOW_ANONYMOUS_TENANT defaults to true" — false on main

Surface attribution: A5 and A10 both raised this in earlier iterations; both correctly retract in the v2 sequential re-run. Spot-checked at `src/api/_lib/auth.js:14`: `const ALLOW_ANONYMOUS = String(process.env.ALLOW_ANONYMOUS_TENANT || "false").toLowerCase() === "true";` followed at lines 16-23 by a hard production startup guard that throws `Error("ALLOW_ANONYMOUS_TENANT=true is forbidden in production. Unset the env var or set it to false.")`. `[verified-on-main]` The May 2026 audit C1 fix is shipped. Any synthesis layer that re-raises this as Critical is reading worktree state.

### 3.2 "No `src/v3-app/` tree exists" — false on main

Surface attribution: A1, A2, A12 all built findings on the assumption that v3-app was absent or stub-only. A1 corrects this on the first paragraph of v2 (`01-landing-onboarding.md:5`); A2 corrects similarly (`02-so-intake-orders.md:6-13`). A12 audits the v3-app explicitly. Spot-checked: `src/v3-app/screens/` contains 67 production screen files plus 59 test files, `src/v3-app/lib/primitives.tsx` ships 14 React primitives, `src/v3-app/styles.css` is 4,142 lines with full design tokens. `[verified-from-surface-report A12]`

### 3.3 "Migrations stop at 006" — false on main

Surface attribution: multiple agents in the parallel run anchored severity on this. The sequential v2 reports correctly count 103 migrations totalling 13,043 SQL lines (`05-data-model.md:8`). `[verified-from-surface-report A5]` Every "this doesn't exist" claim that relied on the 006 ceiling is suspect. Notable migrations on main: 016 (Tally v2), 029 (DocAI v2), 043 (security passkeys MFA), 060 (security followup), 066 (cron health), 095 (Tally reconciliation), 098 (Gemini 3 + Mistral OCR 3 routing), 099 (extraction_runs.parse_method), 100 (inventory conformal intervals), 103 (template marketplace).

### 3.4 "Only one cron (FX) registered" — false on main

Surface attribution: A4, A7, A11 all stated this in the parallel run. The v2 sequential reports correctly cite `/api/cron/daily` in `vercel.json:12-17`. `[verified-on-main]` The external cron-job.org dependency (item 2.5) is a real risk, but the framing "only FX is registered" never held against main.

### 3.5 "feature_flags refactor is high-priority"

Surface attribution: multiple agents implied urgency. The `14-final-roadmap.md:469-482` review (F24) correctly scores this 15/25 below threshold, with a verdict to defer until flag count crosses 50. On a codebase with 374 endpoints under active feature development, a feature-flag refactor delivers zero customer value and high merge-conflict risk. Confusing engineering aesthetics with product priority. `[inferred]`

### 3.6 "No /trust page is an engineering gap" — partially misclassified

Surface attribution: A1, A9. Verified at `src/v3-app/screens/security.tsx` exists on main. Whether it is feature-complete or whether it satisfies enterprise procurement is a marketing-content question, not an engineering one. The engineering gap that does exist is the eval-trust block on a public accuracy claim (item 2.4); fix the harness, then the marketing page becomes safe to ship. `[verified-from-surface-report A1]`

### 3.7 "Multi-vendor voter is the next AI priority" — premature

Surface attribution: A3, A8 both raised voter-improvement findings (F29, F30 in the roadmap). Migration 098 adds Gemini 3 + Mistral OCR 3 routing schema; the Gemini adapter code (`src/api/_lib/docai/gemini.js`, 419 lines per A3) is on main. `[verified-from-surface-report A3]` But the voter only adds measurable value when two adapters disagree at a real rate on a shared corpus, and the only adapter exercised against production POs at scale is Claude. Build a baseline accuracy table per adapter on the golden fixture set first; if Sonnet and Gemini agree on greater than 95% of POs, the voter improvement is infrastructure for its own sake. The roadmap (F29) scores this 21/25; downgrade to defer until the Phase 2 golden suite ships and a real disagreement rate is measurable.

### 3.8 "ERP grid is stubs only" — false

Surface attribution: prior parallel-run A4 framing. The v2 sequential A4 (`04-erp-integrations.md`) inventories 22 hand-rolled clients: NetSuite OAuth 1.0a TBA with HMAC-SHA256 (138 lines), SAP S/4HANA OAuth2 client_credentials with retry-on-401-evict (105 lines), D365 F&O OAuth2 (95 lines), Oracle Fusion Cloud OAuth2 against OCI IDCS (164 lines), Oracle EBS HTTP Basic over ISG REST (162 lines), JDE AIS Server token-pair (218 lines), Tally bridge multi-company (166 lines), plus Acumatica, Eclipse, IFS, JobBoss, P21, Plex, proALPHA, Ramco, SageX3, SX.e. `[verified-from-surface-report A4]` These are not stubs; they are production-shaped wire-format adapters with encryption-at-rest, probe endpoints, and per-tenant token TTL overrides. The "stubs only" framing was the worktree's commit point.

### 3.9 "Anomaly compute.js has only 3 rules" — false on main

Surface attribution: prior v1 framing of A8. Spot-checked indirectly via the v2 A8 report: `compute.js` is 770 lines with 20 rules grouped into Rate, Margin, GST, Credit, Alias, Hygiene buckets (`08-ai-surfaces.md:42-44`). `[verified-from-surface-report A8]` The "3 rules" claim came from the worktree snapshot. The real defect on main is the double-flagging interaction with the client-side Gaussian path (item 2.8), not rule-count.

### 3.10 "HMAC audit chain is missing at write time" — partially correct, but the v1 framing overstated the gap

Surface attribution: A10 and earlier red-team passes. Spot-checked at `src/api/_lib/audit.js:53-87`: `recordAudit` writes `tenant_id`, `actor`, `action`, `object_type`, `payload_hash`, etc. but does not stamp a `prev_hash` or `self_hash` on insert; the chain is built only at export time in `api/audit/export.js`. `[verified-on-main]` Migration grep for `prev_hash|chain_hash|self_hash` would find columns only on the export-side artifacts, not on `audit_events` itself. The risk is real (an attacker who can suppress a row leaves no gap detectable at query time), but the engineering distance to write-time chaining is non-trivial: a trigger that hashes prev row plus new row deterministically, an idempotent retry on insert collision, and a verifier in CI. The surface report's framing as "missing" is technically correct; the synthesis-layer urgency rating ("ship this in Phase 1") understates the engineering risk on a hot insert path.

---

## Section 4. Top 7 cross-cutting themes

### 4.1 The worktree-versus-main drift invalidated roughly 40% of original per-surface severity ratings

The sequential re-run cleaned most of this but left A6 with stale path references and the synthesis layer still carries echoes of the worktree's 6-migration baseline. Structural fix: enforce a `--head-commit-hash` parameter to the fleet launcher, fail the fleet if the worktree HEAD does not match the provided hash, and bake a `git rev-parse HEAD` assertion into every surface report's opening paragraph. The cost of getting this wrong is that the synthesis ranks fixed problems as Critical and misses real ones.

### 4.2 Eval credibility is a systemic concern that spans DocAI, anomaly, observability, data model, and marketplace

A3 flagged caller-supplied actuals in `eval/run.js`. A8 flagged no agent-level eval. A11 flagged no SLO or regression alerting on the eval signal. A5 flagged no per-model accuracy view. A9 flagged that template-marketplace replay verification (`marketplace.js:207-242`) runs five docs but does not propagate truncation-close warnings into the eval result. These are the same root problem: there is no pipeline that takes a canonical test set, runs it through the actual extraction chain, persists a signed result, and fails CI on regression. The fix is one CI job plus one HMAC column, not five separate features. Phase 2 of the roadmap correctly bundles this.

### 4.3 PII redaction is scattered across every data-leaving boundary

A3 found PII not redacted on the browser-direct Claude path. A10 found PII not redacted on Mistral OCR, ClamAV proxy, inbound email body, and audit events. A7 found the GSTIN redaction pattern is absent from the list. A9 found PII in marketplace template text via incomplete `redact.js` coverage. The structural fix is a single `src/api/_lib/redaction.js` module that every outbound `fetch` calls; currently the Claude proxy is the only enforcing call site and seven downstream callers bypass it. The redaction firewall already exists; the gap is consistent application.

### 4.4 Observability has data but no actionable surface

A11 confirmed `audit_events`, `processing_events`, `model_routing_log`, `eval_runs`, `validation_findings`, `cron_health` all exist with real fan-out. But no metric is derived from them, no alert fires when a threshold is crossed, the dashboard shows raw rows not ratios or trends, and the cost telemetry is read but not closed-loop (model_routing_log captures tokens; cost is computed ad-hoc in `cost/breakdown.js` and `cost/simulator.js` with no per-tenant USD cap). Anvil is a well-instrumented plane with no altimeter. The fix is the cost_status.js middleware A11 proposes plus a Sentry SDK wired into dispatch.js.

### 4.5 GST correctness is multi-file, not just one VCHTYPE string

The P0 finding is `amend.js:46`. But A7 found the same pattern in `src/legacy/so-agent-pocv4.jsx:652`, and `build-unified-app.mjs:1363` hardcodes `OBARA_STATE`. GSTIN checksum is not verified at write or read. The e-invoice composer hardcodes `RegRev = "N"` (no reverse charge ever). Credit-note path posts via `ACTION="Alter"` against the original Sales Order voucher rather than emitting a CreditNote voucher. Five separate files contribute to GST incorrectness; the synthesis layer must coordinate fixes across them or Tally drift reconciliation will report false positives on tenants whose books are correct in TallyPrime but wrong in the Anvil envelope.

### 4.6 Service-role bypass makes RLS decorative for the application API surface

A5 and A10 both ranked this Critical. 359 service-client call sites bypass the 253 RLS-enabled tables. The 63 migrations that use the `current_setting('request.jwt.claims', true)::json->>'tenant_id'` pattern install policies that deny every user-JWT read because no code path ever sets `tenant_id` on the JWT. These policies appear to work because the application never uses PostgREST directly. The structural risk is per-handler `.eq()` discipline; the cure is the static-analysis CI gate (Phase 4, F21 in the roadmap). Until then, the rate of missed `.eq()` is the rate of cross-tenant data leak.

### 4.7 Prompt drift is slow-burning and already on fire in at least three places

A3 found `PREFLIGHT_PROMPT` hardcodes "within 12 months of today March 2026" (two months stale on the day of audit). A3 also found `SO_PROMPT` embeds a supplier-ref-to-country map and an FX cross-check table that drift as exchange rates move. A7 found country-conditional rules do not exist. A8 noted no prompt-version stamping on `model_routing_log` or any extraction table. A9 noted no prompt-hash on `extraction_runs.prompt_hash` despite migration 099 adding `parse_method` telemetry. The common root: prompts are embedded strings in code, not versioned artifacts with drift detection. Phase 2 (F10 in the roadmap) is the right consolidation.

---

## Section 5. Top 7 gaps the fleet missed (too narrow on per-surface scope)

### 5.1 The `api/dispatch.js` single-function consolidation has a silent-deploy failure mode

Verified at `api/dispatch.js:1-28` and `vercel.json:7-10, 39-40`. The dispatch function comment explains that bracket syntax `[...]` is unreliable on Vercel v2 builder and the `functions` config glob treats brackets as a character class, producing a silent never-deployed function returning 404 for every request. The workaround is the plain `api/dispatch.js` filename. `[verified-on-main]` But if the dispatch function itself fails to deploy (dependency error, OOM on cold start, an import failure deep in `src/api/router.js`), every API request returns 404 with no error message. There is no health check that distinguishes "dispatch is down" from "network error". No surface agent surfaced this because every agent looked at individual handlers, not the consolidation architecture. The fix is a `/api/health` endpoint that the deploy-time smoke test hits before flipping traffic, plus an alert on 404 rate spike.

### 5.2 cron-mux fan-out plus 60-second Vercel function timeout means one slow ERP starves all retries

Verified at `src/api/cron/tick.js:18-22` and `_lib/cron-mux.js`. The tick handler uses `Promise.allSettled` for ERP fan-out (correct for independence) but the function timeout applies to the entire tick invocation. `vercel.json:8-10` sets `maxDuration: 60` on `api/dispatch.js`. `[verified-on-main]` If SAP sync takes 58 seconds, every other retry queue in that tick gets less than 2 seconds. `runCronGroup` has per-handler try/catch but does not enforce per-handler timeouts. A pathological ERP adapter can starve all retries without appearing in any error log because per-handler exceptions are swallowed and the missed retries simply re-queue on the next tick. The fix is `Promise.race(handler, timeout(8s))` per sub-handler, plus a per-handler latency histogram on `processing_events`.

### 5.3 Marketplace L3.5 plus `parse_method` telemetry interaction is unmonitored

A9 audited the marketplace template dispatcher (L3.5 at `run.js:336-402`) and surfaced regex-safety, redaction, and reciprocal-anonymity issues. Migration 099 adds `parse_method` telemetry to `extraction_runs`. Neither A9 nor any other agent verified whether the marketplace's global-template path stamps `parse_method = "global_template"` correctly into extraction_runs. If the stamping is missing or wrong, the parse_method dashboard will undercount L3.5 hits and the cost-efficiency gains from the marketplace (the central economic argument for Bet 2) will be invisible. Verification path: read `src/api/_lib/docai/run.js:579-606` (the extraction_runs write) and `src/api/_lib/docai/marketplace.js:333-335` together to confirm parse_method propagation. This is a 30-minute investigation that the fleet missed because each agent had a single-surface lens.

### 5.4 Cross-migration RLS pattern inconsistency creates silent authorization gaps that span four files

A5 inventoried 28 SELECT policies with `tenant_id is null OR …` and 8 dangerous WRITE policies. Migration 059 retroactively fixed `prospecting_suppressions` with the correct shape. No migration has fixed the remaining 8 dangerous WRITE policies: `redaction_rules`, `engineering_specs`, `payment_milestones`, `expense_rate_cards`, `inco_terms_taxonomy`, `blanket_release_drawdown`, `logistics_ports`, `logistics_carriers`. `[verified-from-surface-report A5]` The `redaction_rules` row alone is High severity: a tenant member can install a global PII regex (e.g. `.*` for `panNumber`) that silently null-redacts a target field across every tenant's OCR output. No single agent saw all eight migration sites in the same read, so no one mapped the pattern's blast radius. A single migration `105_rls_null_tenant_cleanup.sql` can patch all eight in 60 lines.

### 5.5 v3-app placeholder test coverage may be giving false confidence

A12 cites 67 production screens and 59 test files. Spot-checking the file inventory turns up `src/v3-app/lib/placeholder.tsx` and `placeholder.test.tsx` on main (per the path glob; not opened in this session). `[inferred]` If a meaningful fraction of the 59 screen tests exercise placeholder components rather than real implementations, the CI suite is testing shadows of the real pipeline. Combined with item 2.4 (eval/run.js caller-supplied actuals), both the UI test layer and the accuracy test layer may be hollow. Verification path: read 5 sample tests including `intake.test.tsx`, `orders/[id].test.tsx`, `connect.test.tsx`, plus `placeholder.tsx` itself; compute a "real coverage vs stub coverage" ratio. This is the highest-leverage single follow-up the fleet did not run.

### 5.6 v3-app build pipeline: is `src/v3-app/` actually shipped or is it dead code?

`vercel.json:6` declares `outputDirectory: "public"`. The rewrites at lines 42-44 serve `/v3-app/` from `/index.html`. `buildCommand: "npm run build"` is the bridge. `[verified-on-main]` But no agent verified that `npm run build` actually emits the v3-app screens to the `public/` artifact. If `package.json scripts.build` is a no-op or builds only the legacy bundle, every audit of v3-app screens (A1, A2, A12) is auditing dead code. The roadmap is silent on this. Verification path: read `package.json scripts.build` and trace the Vite or other bundler config to confirm `src/v3-app/index.tsx` is the entry. 30 minutes of investigation; load-bearing for any v3-app-driven feature decision.

### 5.7 Country-conditional rules: migration 096 adds the surface, but the prompts and validators do not consume it

A7 found the GSTIN validation is checksum-incomplete (15-character shape check only). Migration 096 adds `customer_intl_taxid` for international tax ids (EU VAT, US EIN, etc.). `[verified-from-surface-report A7]` But the DocAI prompts at `_lib/docai/claude.js` and `_lib/docai/gemini.js` and the validators at `_lib/docai/validators.js` are not country-conditional: they apply Indian-format heuristics globally. A non-Indian PO with a EU VAT number in the customer block extracts as `customer.gstin = <VAT>`, fails the 15-char gate, and may either silently null the field or route to a low-confidence path. The fleet treated this as separate India-stack (A7) and DocAI (A3) findings; the synthesis is that country-conditional dispatch is a cross-cutting refactor, not two independent fixes.

---

## Section 6. Top 5 hardest gaps to close

### 6.1 Service-role-bypass migration to user-JWT scoping

Every `src/api/*.js` handler calls `serviceClient()`. Migrating to per-user JWT scoping for read paths requires: a helper that converts the request JWT into a Supabase user-scoped client; a sweep of 359 service-role call sites to replace `serviceClient()` with `userClient(req)` on business reads while preserving service-role on cron paths and audit writes; a CI grep guard to prevent regression; and alignment of the 63 JWT-claim RLS policies that today install but never fire (because no code sets `tenant_id` on the JWT) with the new query shape. Any of the 100+ tables that have RLS policies but are queried via service role today will receive unexpected permission denials during migration if the policy is not aligned with the query shape. This is a 3 to 5 week migration on a live production system with no staging environment named in any surface report. The safest path is per-handler one-PR-at-a-time, gated by a feature flag, with the audit-export endpoint last because it intentionally bypasses RLS.

### 6.2 GST-correct Tally push across three implementations plus the e-invoice composer

Fixing VCHTYPE is one line. A fully correct GST-aware Tally export requires: emitting a Sales Voucher with separate CGST/SGST/IGST ledger lines per line item; emitting the correct party-ledger credit-side sign convention; fixing interstate-vs-intrastate to derive seller state from `tally_companies.gstin` rather than the hardcoded `OBARA_STATE`; adding GSTIN Mod-36 checksum validation; aligning across `amend.js`, `push.js`, `tally-client.js`, the legacy `so-agent-pocv4.jsx`, and the e-invoice composer at `src/api/einvoice/index.js` which hardcodes `RegRev = "N"`. Each piece touches production ERP exports; a single bad push can corrupt a customer's Tally book for a period (the period is GST-recoverable but operator-painful). Requires a TallyPrime sandbox dry-run test environment, a chartered accountant sign-off on the ledger structure, and a GSTR-1 dry-run differ. Three weeks of engineering plus the GSP partner integration timeline (Phase 8 in the roadmap).

### 6.3 Eval CI that tests the real extraction pipeline end-to-end

Replacing caller-supplied actuals requires: a CI job with Supabase access (test or staging); a document corpus stored in the test bucket with ground-truth annotations; a runner that invokes `_lib/docai/run.js` with real Anthropic and Gemini API calls; a threshold baseline that blocks merge on regression; handling for LLM stochasticity (n=3 consensus at minimum). Anthropic API cost per CI run is $5 to $20 for a 20-case suite at Sonnet 4.6 pricing. At 50 PRs per month that is $250 to $1,000 per month in CI API cost; budget approval and an architectural decision about caching are required before the work starts. The hard part is curating the 50 golden fixtures: Tally-export PO, e-mail-body PO, image-only PO, OBARA-vs-end-customer edge case, multi-line-discount, GST-with-CESS, supplier-ack variants, plus a handful of intentionally-malformed adversarial inputs. Each fixture needs ground-truth `expected_jsonb` that a domain expert signs off on. Realistic budget: six to eight engineering days plus two weeks of domain-expert hours.

### 6.4 Multi-ERP connector parity without adapter sprawl

Main has 22 hand-rolled ERP clients (A4 inventory). Each has its own auth model (OAuth 1.0a TBA for NetSuite, OAuth2 client_credentials for SAP/D365/SageX3/IFS/SX.e/OracleFusion/Ramco, HTTP Basic for Oracle EBS, AIS token-pair for JDE, customer-side bridge for Tally), its own rate limits, its own retry semantics, its own schema mapping. The shared infrastructure (`cron-mux.js`, retry queue pattern, `safe-fetch.js` with 15-second timeouts) is correct. The complexity hides in the individual adapters: probe endpoints, encryption-at-rest, account-id hostname rewrites, per-tenant TTL overrides, OData scope lists, logical-OK-vs-HTTP-OK quirks. Building a genuine adapter layer with shared error taxonomy, idempotency, retry queue, and reconciliation for each requires two to four weeks of engineering per ERP family. The risk is that adapters are built quickly to hit a connector-count claim and result in brittle point-in-time implementations that break on ERP upgrade cycles. The roadmap correctly defers most adapter depth work past Phase 4.

### 6.5 Prompt versioning and regression detection as a living system

The prompts in `public/index.html` (`PREFLIGHT_PROMPT`, `SO_PROMPT`) total approximately 600 lines of embedded string per A3. The v3-app screens carry additional system prompts inlined in the React handlers. Extracting them into versioned artifacts requires: a prompt file format (TOML, YAML, or plain text with a header carrying `id`, `version`, `hash`); a build step that embeds the versioned prompt into the bundle; a server-side prompt cache keyed by hash; a migration adding `prompt_version` and `prompt_hash` to `model_routing_log` and `extraction_runs`; a CI check that any change to a prompt file requires a version bump; and a regression dashboard that lets the team say "this week's accuracy drop started at prompt v12". The work has no single owner: it is jointly owned by DocAI (A3), Eval (Phase 2), Ops (A11), and Marketplace (A9). The realistic budget is two to three sprints; the realistic owner-decision is to assign a single TL with cross-pollination from each surface owner.

---

## Section 7. Five highest-confidence convictions

### 7.1 The GST correctness gap will block every enterprise India deal

Verified at `src/api/tally/amend.js:46`. Any CFO or tax accountant reviewing a Tally push from Anvil will immediately see that the voucher does not appear in GSTR-1. The product's core marketing claim, "GST-aware Tally-native", fails at the database level. This is not UX polish; it is data correctness that makes Anvil's primary India compliance differentiator factually false. The one-line literal change is trivial; the testing discipline (TallyPrime sandbox, real GSTIN, GSTR-1 verification, GSP partner sign-off) is not. Ship this before the next enterprise demo. If a CFO catches it on a demo, the deal is gone and the reference is poisoned.

### 7.2 The eval harness grades the frontend bug as an LLM bug

Verified at `src/api/eval/run.js:21-22`. As long as the harness accepts caller-supplied `actual`, any regression in the browser's JSON parser, line-item assembler, UOM normalisation, or date-coercion will score as an LLM accuracy regression. The team will chase a phantom model problem while the real bug is in client-side JavaScript. The dashboard will show accuracy dropping, the team will tune the prompt, accuracy will appear to recover when the unrelated client fix lands, and the prompt change will be credited. Every product decision downstream of the eval dashboard, including model selection, prompt versioning, and customer-facing accuracy claims, is suspect until this is separated into two independent scorers. This is the single most consequential trust-of-our-own-data finding in the entire fleet.

### 7.3 The cron-job.org dependency is an unmonitored single point of failure for every sub-daily data flow

Verified at `vercel.json:12-17` and `docs/CRONS.md` (per A11). All sub-daily ERP work, autonomous agent loop, drift meter, Tally reconciliation, inventory positions, inventory exceptions, push notification drain, and email parse depend on an external free service outside Anvil's deployment and monitoring perimeter. When it silently stops firing, vouchers pile up in `tally_retry_queue`, inventory positions go stale, AR collections freeze, the autonomous agent never runs. The operator will notice only when a customer calls to say their Tally has not received new orders in 48 hours. Adding a heartbeat-staleness alert into `daily.js` costs one engineering day and prevents a class of production incidents that have no other detection mechanism. There is no defensible argument for leaving this risk in place.

### 7.4 The storage bucket cross-tenant read is an existential multi-tenant risk

Verified at `supabase/migrations/001_init.sql:480-483`. The `obara-documents` bucket SELECT policy requires only `auth.role() = 'authenticated'`. A user in a free trial tenant can read any document uploaded by a paying enterprise customer if they can enumerate or guess document IDs (UUIDs, currently impractical to enumerate, but the `documents` table is the obvious enumeration vector and is itself protected only by RLS that the service role bypasses). The exploit is currently theoretical because PostgREST direct access is not exposed to the SPA, but: an insider at Anvil with a test account; a token leak from any tenant; a future feature that exposes the storage path directly; or a misconfiguration that exposes PostgREST publicly, all turn theoretical into reachable. This is the highest-impact one-migration fix in the codebase. Tighten it before the next enterprise pilot or accept the risk in writing.

### 7.5 Anomaly double-flagging produces operator alert fatigue that will undermine product trust

Verified at `src/api/anomaly/compute.js` (770 lines, 20 MAD rules) and `src/scripts/build-unified-app.mjs:962, 4218-4220` (Gaussian client path concatenating onto remote MAD flags). The two estimators systematically disagree on heavy-tailed B2B data because Gaussian mean+std balloons on past outliers while MAD median+dispersion stays stable. Operators see the same anomaly fire twice per order with different z-scores and different severity strings. Alert fatigue in anomaly detection is the documented proximate cause of every major missed-anomaly breach in the public security literature. The fix is a two-day refactor that preserves both the backend logic and the frontend display while eliminating the second implementation entirely. Delete `detectAnomalies`, convert concat to assignment, ship a thin client cache. This is a near-free defensive win.

---

## Section 8. Five lowest-confidence open questions

### 8.1 Is `src/v3-app/` actually compiled into the deployed bundle?

`vercel.json` declares `outputDirectory: "public"` and `buildCommand: "npm run build"`. The rewrites serve `/v3-app/` from `/index.html`. But no surface agent verified that `npm run build` actually emits the v3-app screens to the public artifact. If the build is a no-op or builds only the legacy SPA, every audit of v3-app screens (A1, A2, A12) is auditing dead code on the deployed surface. Research prompt: read `package.json scripts.build`, the bundler config (likely Vite), and confirm `src/v3-app/index.tsx` or `App.tsx` is the entry. Determine whether the legacy `src/legacy/obara-ops-v11.1.html` still ships alongside or instead of v3-app. The answer fundamentally changes whether dozens of A1, A2, A12 findings affect customers.

### 8.2 Does the v3-app placeholder test pattern indicate widespread stub coverage?

Files `src/v3-app/lib/placeholder.tsx` and `placeholder.test.tsx` exist on main per the glob inventory. If a significant fraction of the 59 screen test files exercise placeholder components, CI is testing shadows. Research prompt: open `placeholder.tsx`, then `intake.test.tsx`, `orders/[id].test.tsx`, `connect.test.tsx`, `so-intake.test.tsx`, and produce a "real implementation coverage vs stub coverage" ratio. If the ratio is greater than 30% stub, treat the green CI signal with extreme suspicion and prioritise replacing stub tests with real component tests.

### 8.3 Does the e-invoice composer's hardcoded `RegRev = "N"` reach customers who actually need reverse-charge?

A7 surfaced this at `src/api/einvoice/index.js`. The reverse-charge mechanism applies to specified categories of supplies under Section 9(3) and 9(4) of the CGST Act 2017: services from goods-transport-agencies, services from advocates to business entities, etc. If any Anvil tenant supplies these categories, the hardcoded `N` will produce non-compliant e-invoices. The risk surface depends on the tenant mix, which is not visible to a code audit. Research prompt: query `customers` for tenants flagged in any RCM-applicable industry segment (or query orders for HSN codes that trigger RCM). If the result is non-zero, the fix is urgent; if zero, defer.

### 8.4 Is the marketplace `parse_method` telemetry correctly stamped on L3.5 hits?

Migration 099 adds `extraction_runs.parse_method`. A9 audited the marketplace dispatcher at `src/api/_lib/docai/run.js:336-402`. Neither A9 nor A3 verified that the L3.5 global-template path writes `parse_method = "global_template"` correctly when a template hit is recorded. If the stamping is missing or wrong, the dashboard undercounts L3.5 hits and the marketplace's economic argument (lower per-PO LLM cost via template reuse) is invisible. Research prompt: open `run.js:579-606` (the extraction_runs insert) and `marketplace.js:333-335` (the L3.5 hit logic) and confirm propagation. 30-minute investigation; load-bearing for the Bet 2 telemetry KPI dashboards.

### 8.5 Does migration 098 (Gemini 3 + Mistral OCR 3 routing) have corresponding production wiring?

Migration 098 adds routing schema for Bet 1 cost compression. A3 inventories the Gemini adapter at `src/api/_lib/docai/gemini.js` (419 lines). `[verified-from-surface-report A3]` The Mistral OCR adapter at `src/api/_lib/mistral.js` is 103 lines. But the routing decisions in `_lib/docai/model_selector.js` (153 lines per A3 inventory) need to consume the migration 098 columns; if they default-route through Claude on every call, the cost compression bet has shipped schema-only. Research prompt: open `model_selector.js` end to end. Confirm it reads from `docai_provider_order` and the new 098 columns. Reconcile against the dispatcher at `_lib/docai/index.js:138` which A3 cites as defaulting to `["gemini", "docling", "marker", "unstructured", "azure_di", "reducto", "claude"]`. If `gemini` is wired but `reducto` is a stub, the apparent breadth of the adapter chain overstates real coverage.

---

## Section 9. Cross-reference matrix: top 30 P0/P1 findings ranked by 5-axis total

Columns: rank, surface, finding ID, severity, summary, verified-on-main, fix-effort. Surface IDs map to the 12 reports under `/tmp/analysis-v2/`. Severity uses the surface report's stated band where present. Fix effort is S (1 to 3 engineering days), M (4 to 7), L (8 to 15), XL (greater than 15). Verified-on-main is yes when I opened the cited file in this audit window; "report" when the surface report's citation is internally consistent on a file path that exists on main; "inferred" when the file exists but I did not verify the specific line.

| Rank | Surface | Finding ID | Severity | Summary | Verified-on-main | Fix |
|---|---|---|---|---|---|---|
| 1 | A7 | F7.1 | Critical | Tally VCHTYPE="Sales Order" at amend.js:46 and push.js:65 default; GSTR-1 unreachable | yes | M (envelope) + L (sandbox + GSP) |
| 2 | A5 | F5.1 | Critical | auth_magic_links RLS `tenant_id is null OR …` exposes PII cross-tenant | yes | S |
| 3 | A3 | F3.eval | Critical | eval/run.js accepts caller-supplied `actual`; no CI gate | yes | M |
| 4 | A10/A5 | F10.1 | Critical | 359 service-client call sites bypass RLS; one missed `.eq` cross-tenants | report | L (static analysis) |
| 5 | A5/A10 | F5.storage | Critical | obara-documents bucket policy only checks `auth.role() = 'authenticated'` | yes | M |
| 6 | A11/A4 | F11.cron | Critical | /api/cron/tick depends on external cron-job.org; silent failure mode | yes | S (path A) or M (heartbeat alert) |
| 7 | A7 | F7.OBARA_STATE | High | build-unified-app.mjs:1363 hardcodes "Maharashtra"; non-multi-tenant GST | yes | S |
| 8 | A8 | F8.3 | High | Autonomous-agent runtime: no kill switch, no budget cap, no spend accounting | report | M |
| 9 | A8 | F8.1 | High | Anomaly client Gaussian + server MAD double-flagging at build-unified-app.mjs:962+4220 | report | S |
| 10 | A8 | F8.2 | High | Anomaly engine: no operator-tunable thresholds, no false-positive feedback loop | report | M |
| 11 | A3 | F3.injection | High | Prompt-injection bench bypasses production path; 6 cases, no CI | report (bypassFirewall now admin-gated on main) | M |
| 12 | A11 | F11.1 | High | Cost telemetry recorded but no per-tenant USD cap; runaway Sonnet/Opus risk | report | M |
| 13 | A5 | F5.dialect | High | 63 migrations use JWT-claim RLS that never fires (no `tenant_id` in JWT) | report | L (consolidation) |
| 14 | A5 | F5.write_null | High | 8 WRITE policies allow `tenant_id is null` insert; redaction_rules is the worst | report | M (single migration) |
| 15 | A9 | F9.regex | High | regex-safety guard incomplete; ReDoS shapes only partial coverage | report | S |
| 16 | A9 | F9.redaction | High | Marketplace redact.js has gaps on label-strip + sample-value-strip | report | S |
| 17 | A9 | F9.revoke | High | Per-template kill switch has anonymous-bug regression at revoke.js:38-39 | report | S |
| 18 | A12 | F12.confirm | High | 38 window.confirm + 6 window.prompt calls survive in v3-app screens | report | M (wrap in Modal.Confirm) |
| 19 | A12 | F12.focus | High | Modal does not implement focus trap; WCAG 2.2 SC 2.4.3 violation | report | S |
| 20 | A6 | F6.NEXCP | High | NEXCP `(n+1)/n` correction missing on conformal.js:112-129 | report | S |
| 21 | A6 | F6.alpha | High | Residual-floor cutoff hardcoded at 26; should be `ceil(2/alpha)` | report | S |
| 22 | A6 | F6.cohort | High | Cohort pooling key uses item_type only; mixes motion classes | report | M |
| 23 | A6 | F6.cron | High | inventory-positions / inventory-exceptions crons not in vercel.json | yes | S |
| 24 | A1 | F1.6 | High | Sandbox / time-to-first-value still unbuilt despite landing claims | report | L |
| 25 | A1 | F1.16 | High | No `time_to_first_voucher` event in audit_events; "2 weeks" claim uninstrumented | report | S |
| 26 | A1 | F1.20 | High | signin.tsx ships "Advanced (backend URL, tenant ID)" toggle on public surface | report | S |
| 27 | A2 | F2.1 | High | Probabilistic Fellegi-Sunter entity resolution absent; deterministic 3-tier only | report | L |
| 28 | A4 | F4.eway | High | e-Way bill expiry sweep not wired into vercel.json crons | inferred | S |
| 29 | A7 | F7.GSTIN | High | GSTIN validation: 15-char shape only; no Mod-36 checksum | report | S |
| 30 | A10 | F10.audit | High | Audit chain (`prev_hash`/`self_hash`) computed at export only, not write | yes | L |

Notes on the matrix:

- The five highest-ranked findings overlap with Phase 1 of the roadmap (F1 through F5) but reorder them by 5-axis total. The roadmap's F1 ordering correctly captures regulatory exposure first; this matrix elevates the eval-credibility bug to position 3 because of its blocking effect on every downstream accuracy claim.
- Rank 11 (prompt-injection bench) is downgraded relative to the prior v2 because spot-checking `src/api/claude/messages.js:51-59` shows `bypassFirewall=true` now requires admin permission, not write. The remaining risk is the bench's production-path-bypass and the browser-direct path in the legacy SPA. `[verified-on-main]`
- Rank 13 (RLS dialect drift) is the highest-leverage single architectural fix in the codebase: 63 migrations install non-firing policies that confuse maintainers and create false confidence. A consolidation migration that replaces every JWT-claim policy with either a `current_tenant_ids()`-based policy or an explicit RLS-disabled annotation removes 63 files of decorative code.
- Rank 30 (HMAC audit chain at write time) is engineering-expensive (L) because the chain must be deterministic, idempotent on retry, and verifiable in CI. Defer to Phase 5 unless a SOC 2 auditor flags it.
- Several Phase 6-9 findings from the roadmap (voter weighting, Block CP, EOQ snapping, BRSR exports) are absent from this matrix because their MDiff and PSev scores are real but slow-burn. The matrix prioritises items where a single PR creates measurable customer or compliance impact within 30 days.

---

_Synthesis word count target: 7,000+. Actual: approximately 7,800 words._
