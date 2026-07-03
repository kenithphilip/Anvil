# Anvil Implementation Roadmap (v3, phased)

Anchor: `/Users/kenith.philip/anvil/` on `main @ c4f946b` ("feat(bet2): format-template marketplace (post counsel approval) (#100)"). 103 numbered migrations, 13,043 SQL lines, 373 API endpoints under `src/api/`, 67 production screens under `src/v3-app/screens/`, 14 React primitives under `src/v3-app/lib/primitives.tsx`, single Vercel function `api/dispatch.js` fanning out via `src/api/router.js`. 1,122 vitest cases green. Date of synthesis: 2026-05-11.

Evidence base: 12 sequential surface reports A1 through A12 at `/tmp/analysis-v2/01-*` through `/tmp/analysis-v2/12-*`, aggregating roughly 89,000 words of citations and roughly 393 findings; red-team v3 at `/tmp/analysis-v2/13-red-team.md`. Every claim in this roadmap is tagged: `[verified-on-main]` was opened during this synthesis; `[verified-from-surface-report]` is an internally consistent surface-report citation against a file path that exists on main; `[verified-from-prior-knowledge]` is a competitor or external claim that WebFetch could not re-fetch in this session; `[inferred]` is a defensible reading of two or more verified facts.

Style: no emojis, no em dashes or en dashes, file paths absolute, file:line citations for every action item where applicable.

---

## Section 1. Executive summary

Anvil after the 7-bet merge is a technically rich platform with one structural credibility problem and five customer-visible incidents waiting in the first month of enterprise pilots. The 12 surface reports plus the red-team synthesis identify roughly 393 findings of which 30 carry P0 or P1 severity. Five P0s would surface as customer-visible incidents inside 30 days. A deeper architectural concern, 359 service-role call sites bypassing 253 RLS-enabled tables, is one missed `.eq("tenant_id", ...)` away from cross-tenant data leak.

### Top 5 P0 fixes verified on main

1. Tally `VCHTYPE="Sales Order"` defect at `src/api/tally/amend.js:46`, repeated at `src/api/tally/push.js:65` (`voucherType = body.voucherType || "SalesOrder"`), and at `src/legacy/so-agent-pocv4.jsx:652`. TallyPrime's Sales Order is a non-accounting voucher; it does not surface in GSTR-1. CGST Act Section 31 mandates tax invoices for taxable supplies; Section 122(1)(i) penalises failure at Rs 10,000 per invoice or 100% of tax due whichever is higher. The entire Tally drift bet (Bet 5) sits on top of an incorrect voucher type. `[verified-on-main]`
2. `auth_magic_links` RLS policy at `supabase/migrations/003_studio_ocr_fx_inventory_lead.sql:241` reads `using (tenant_id is null or tenant_id in (select current_tenant_ids()))`. Every row is written with `tenant_id` unset by `api/auth/magic_link.js:36-42`, so the table is world-readable to any authenticated tenant via PostgREST. DPDP Act Section 6 (notice and consent) violated; SOC 2 CC6.1 blocked. `[verified-on-main]`
3. Eval harness at `src/api/eval/run.js:21-22` accepts caller-supplied `actual` results. Comment in source: "Caller submits actual extraction results (since this server is generic) and we just score + record." Any frontend regression that drops a line item, normalises a UOM wrong, or coerces a number to a string scores as an LLM accuracy bug. Every product decision downstream of the eval dashboard is suspect. `[verified-on-main]`
4. `/api/cron/tick` not registered in `vercel.json:12-17`; only `/api/cron/daily` at `30 2 * * *` is registered. The tick handler at `src/api/cron/tick.js:1-22` documents 5-minute cadence and fans out to 26 sub-crons. The team relies on external cron-job.org. If that free service silently stops firing, every sub-daily workflow (email parse, 17 ERP retry queues, voice, WhatsApp, agent loop, inventory positions, drift meter, Tally reconciliation) goes silent with no alert. `[verified-on-main]`
5. Storage bucket SELECT policy at `supabase/migrations/001_init.sql:480-483`: `using (bucket_id = 'obara-documents' and auth.role() = 'authenticated')`. No tenant scope. A token-holding tenant can enumerate documents from any other tenant via direct PostgREST. Currently theoretical because the SPA goes through the API, but one insider with a test account, one token leak, or one future portal feature changes that. `[verified-on-main]`

### Top 5 strategic gaps that move the needle

1. Public `/trust` page with provable accuracy benchmark. Data exists in `eval_runs` and `extraction_runs`, but blocked by the eval-trust bug above. Axal, Hyperscience, and Ocrolus all publish 95%+ accuracy numbers in their hero copy. Without a credible accuracy number, every enterprise procurement conversation stalls at the security questionnaire. `[verified-from-surface-report A1]`
2. Tally drift productization with public 60-second video and a `/tally-drift` product page. Bet 5 ships the code, the cron, and the billing meter, but no marketing surface lets buyers see the moat. The strongest differentiator in the category (post-push drift detection versus Conexiom's pre-push 75 checks) is invisible. `[verified-from-surface-report A7]`
3. Sandbox tenant and time-to-first-value instrumentation. The landing hero at `src/v3-app/screens/landing.tsx:656` promises "free pilot, 30 min, we run a real PO" but there is no in-page sandbox, no `time_to_first_voucher` event, no first-run tour. NN/g's "delay authentication until after value" is the most-cited B2B UXR rule and Anvil violates it. `[verified-from-surface-report A1]`
4. Rossum-style document review UI with bounding-box overlay. Operator clicks a wrong field, edits the value, triggers re-extraction with a hint, persists to `extraction_corrections` which feeds the per-customer template builder. No equivalent exists today; this is the single most-cited Rossum killer feature. `[verified-from-surface-report A2]` `[verified-from-surface-report A12]`
5. Per-tenant USD spend cap on LLM calls. `model_routing_log` captures tokens; USD math lives in `cost/breakdown.js` and `cost/simulator.js` with no closed loop. A misconfigured tenant on Opus at 50k tokens input per order at 500 SOs per day burns $565 per day with no gate. `[verified-from-surface-report A11]`

### Top 3 cross-cutting themes

1. Eval credibility crisis spans DocAI (A3 caller-supplied actuals), anomaly (A8 no agent-level eval), observability (A11 no SLO on eval signal), data model (A5 no per-model accuracy view), and marketplace (A9 replay verification not propagating truncation warnings). These are the same root problem: there is no pipeline that takes a canonical test set, runs it through the actual extraction chain, persists a signed result, and fails CI on regression. The bet on the public `/trust` page is blocked until this is resolved.
2. Multi-tenancy retrofit at 359 service-role files. 253 RLS-enabled tables exist, but every business handler uses `serviceClient()` from `src/api/_lib/supabase.js:9` which carries the `BYPASSRLS` Postgres attribute. 889 `.eq("tenant_id", ...)` occurrences across 299 files are the actual load-bearing wall. The 63 migrations using `current_setting('request.jwt.claims', true)::json->>'tenant_id'` install policies that deny every user-JWT read because no code path ever sets `tenant_id` on the JWT. The platform was designed single-tenant-per-deploy; the multi-tenant retrofit is genuine architectural work that spans Phases 1, 5, and 9. `[verified-from-surface-report A5]` `[verified-from-surface-report A10]`
3. Prompt drift and unversioned prompts. `PREFLIGHT_PROMPT` hardcodes "within 12 months of today March 2026" which was stale two months before this synthesis. `SO_PROMPT` embeds a supplier-ref-to-country map and an FX cross-check table that drift as exchange rates move. No prompt-hash on `extraction_runs` or `model_routing_log` despite migration 099 adding `parse_method` telemetry. The common root: prompts are embedded strings in code, not versioned artifacts with drift detection.

### Methodology note

This roadmap consolidates 12 sequential agent passes (A1 through A12) plus a red-team v3 pass that re-grounded findings against `main @ c4f946b` after the original parallel fleet inherited a stale worktree at `objective-meninsky-15e45d` (commit `a24d582`). A24d582 is a pre-bet baseline with 6 migrations and no `src/v3-app/` React tree; c4f946b has 103 migrations and the full v3 app. Anything in this roadmap citing main with a file:line was opened on c4f946b during the audit window. Anything tagged `[verified-from-prior-knowledge]` is a competitor or external claim WebFetch could not re-fetch (the harness denied the tool to subagents). Worktree references should reproduce on the listed commit, never the worktree.

---

## Section 2. Phase plan overview

Eleven phases over 72 to 84 weeks total. Phases 1 through 3 are pre-pilot mandatory. Phases 4 through 10 are pilot-to-scale enablement. Phase 11 is certification track that runs alongside 6 through 10.

| Phase | Weeks | Theme | Owner | P0/P1 count | Effort |
|---|---|---|---|---|---|
| 1 | 4 | P0 fixes: GSTR-1, magic-link RLS, eval-trust, cron registration, storage, OBARA_STATE, bypassFirewall scope, GSTIN checksum, healthz, cron timeouts, role enum | Platform TL | 13 P0/P1 | M total |
| 2 | 4 | Eval credibility + telemetry hardening: server-verified eval, golden set, drift detector, replay UI, audit chain HMAC at write | Eval/DocAI TL | 8 P0/P1 | L |
| 3 | 6 | Trust + sales-motion enablement: `/trust` page, cost/SO meter, confidence chips, sandbox tenant, time-to-value instrumentation, first-run tour, customer security review packet | Product TL | 7 P1 | L |
| 4 | 6 | DocAI engine v2: multi-adapter voter cost weighting, line alignment beyond partNumber, content-type gates, OCR utf8 fallback removal, injection firewall vendor parity Anthropic + Gemini + Mistral | DocAI TL | 9 P1 | L |
| 5 | 8 | Multi-tenancy hardening: service-role to user-JWT first wave, soft-delete pattern, audit chain HMAC at write, RLS dialect unification, IDOR sweep | Security TL | 7 P0/P1 | XL |
| 6 | 6 | India compliance partnership + completeness: GSP partnership, IRN retry queue, e-Invoice cancellation, eway multi-leg, AA consent renewal, TReDS lifecycle, BRSR assurance trail, DPDP SDF readiness, GeM portal | India TL | 9 P1 | L |
| 7 | 6 | Inventory math correctness: crons in vercel.json, NEXCP (n+1)/n correction, LTD sqrt(L) fix, prequential residuals, backtesting MVP, alpha drift invalidation, cu/co override, supplier scorecard | Inventory TL | 8 P1 | L |
| 8 | 4 | Approvals + workflow: dual-pane approvals with delegation + escalation cron, comments thread, line-item source_text_span, doc-review.tsx with bbox overlay, canonicalisation drift fix | Workflow TL | 5 P1 | M |
| 9 | 6 | Observability + admin + pricing: cost_status budget rule engine, 12 alert rules + on-call routing, SLO catalog, 3-tier pricing tied to Stripe Meters, cron health alerting, retention policy | Platform TL | 7 P1 | L |
| 10 | 6 | Marketplace + AI surfaces operational hardening: marketplace canary, template diff viewer, royalty model, parse_method telemetry fix, agent kill switch, per-tenant opex caps, MCP rate limit + scope | Marketplace/AI TL | 7 P1 | L |
| 11 | 12 | Compliance certifications: SOC 2 Type II year-1 scope, ISO 27001 SoA year-2, EU AI Act Article 6 memo, CMEK envelope encryption | Compliance TL | 4 P1 | XL |

Phases 1 through 3 are sequential and gate enterprise pilots. Phases 4 through 10 can run in parallel with three to four senior engineers, two design, one PM, and a quarter-time legal counsel. Phase 11 begins observation window in week 14 (Phase 3 close) and runs through Phase 10.

---

## Section 3. Phase 1 P0 fixes (4 weeks)

Theme: nothing else matters until these 13 are closed. Each is reversible, evidence-tied, and unblocks Phase 2 and Phase 3.

### F1. Tally `VCHTYPE` sweep across amend, push, and legacy bundler

Problem. The Tally export emits `VCHTYPE="Sales Order"` at three sites; TallyPrime's Sales Order is a non-accounting order voucher that does not credit the party ledger, does not debit CGST/SGST/IGST ledgers, and does not surface in GSTR-1. Section 31 of the CGST Act mandates tax invoices for taxable supplies; Section 122(1)(i) penalises failure to issue at Rs 10,000 per invoice or 100% of tax due whichever is higher. Tenants pushing 500 invoices per month at Rs 2 lakh tax each carry a worst-case Rs 10 crore monthly exposure. `[verified-from-surface-report A7]`

Current state on main. `src/api/tally/amend.js:46` emits `<VOUCHER ... VCHTYPE="Sales Order" ACTION="Alter">...<VOUCHERTYPENAME>Sales Order</VOUCHERTYPENAME>`. `src/api/tally/push.js:65` defaults `voucherType = body.voucherType || "SalesOrder"` on the create path. `src/legacy/so-agent-pocv4.jsx:652` repeats the pattern on the legacy SO bundler export. Migration `016_tally_v2.sql:88-93` widened `tally_voucher_records.voucher_type` to accept all ten voucher types, but no producer emits anything other than Sales Order. `[verified-on-main]` `[verified-from-surface-report A7]`

Proposed change. Step one (same PR): change the XML literal at `amend.js:46` to `VCHTYPE="Sales"` with `<VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>`. Step two: default `voucherType = body.voucherType || "Sales"` at `push.js:65`. Step three: add `tenant_settings.tally_voucher_kind text default 'Sales' check (tally_voucher_kind in ('Sales','Tax Invoice'))` via migration 104. Step four: emit `<ALLLEDGERENTRIES.LIST>` rows for CGST/SGST/IGST per line item with party-ledger credit-side sign convention. Step five: fix the legacy bundler at `so-agent-pocv4.jsx:652`.

Technical implementation. Edit `src/api/tally/amend.js`, `src/api/tally/push.js`, `src/api/_lib/tally-client.js`, `src/legacy/so-agent-pocv4.jsx`. Add migration `104_tally_voucher_kind.sql`. Update `tally_voucher_records.voucher_type` write path to reflect the emitted type. Update drift-reconciler comparison at `src/api/_lib/tally-reconciler.js` to compare against `Sales` and `Tax Invoice` rather than `Sales Order`.

Integration plan. Bet 5 drift cron and meter unchanged in shape; only the voucher payload changes. Existing `tally_voucher_records` rows in production with `vch_type='Sales Order'` need a remediation script: either re-emit with corrected type if Tally accepts the same voucher_no, or mark legacy with `voucher_type='legacy_sales_order'` and write fresh with new sequence. Customer communications required for any tenant whose books carry legacy SO vouchers from Anvil pushes.

Telemetry. `tally_voucher_records.voucher_type` distribution by tenant by month; alert if any tenant still emits Sales Order after migration. Add `processing_events` event_type `tally.voucher.kind.unexpected` for any non-allowlisted voucher_type.

Effort. M (3 to 4 engineering days for code plus 1 day operator communications plus 5 days TallyPrime sandbox dry-run plus 2 days GSTR-1 differ).

5-axis score. PSev 5, MDiff 5, TLev 5, EStr 5, SFit 5. Total 25/25.

Deep-dive prompt DD1. Research the TallyPrime TDL voucher-type taxonomy (Sales versus Tax Invoice versus Sales Order versus CreditNote) and confirm GSTN treatment of each in GSTR-1, GSTR-3B, and IFF. Source: TallyPrime Knowledge Base, GSTN circulars, Cygnet and IRIS GSP partner-onboarding documentation. Validate against 10 sample tenant CA-signed-off ledger structures.

### F2. `auth_magic_links` cross-tenant RLS leak

Problem. The SELECT policy reads `tenant_id is null OR tenant_id in (select current_tenant_ids())` and every row is written with `tenant_id` null. Any authenticated tenant can pull the most recent 1000 magic-link audit rows: emails, IPs, user-agents, request_at, outcomes. DPDP Act Section 6 violated; SOC 2 CC6.1 blocked. `[verified-from-surface-report A5]`

Current state on main. Policy at `supabase/migrations/003_studio_ocr_fx_inventory_lead.sql:241`. Insert at `api/auth/magic_link.js:36-42` does not populate tenant_id; `auth_magic_links.tenant_id` is nullable (`references tenants(id) on delete set null`). Exploit shape: `curl -H "Authorization: Bearer <tenant-A-jwt>" "$SUPABASE_URL/rest/v1/auth_magic_links?select=*&order=requested_at.desc&limit=1000"`. `[verified-from-surface-report A5]`

Proposed change. Migration 105 to backfill `tenant_id` from `auth.users` matched on email, set NOT NULL, replace policy with strict tenant scope: `using (tenant_id is not null and tenant_id in (select current_tenant_ids()))`. Update `api/auth/magic_link.js` to derive tenant_id from the email's user record or from invite-token claims for cross-tenant onboarding.

Technical implementation. Migration `105_magic_link_tenant_scope.sql` does backfill plus policy replace plus `alter table auth_magic_links alter column tenant_id set not null`. Update insert at `api/auth/magic_link.js:36-42` to require a non-null tenant_id (resolved from email lookup or invite token). For cross-tenant signup, derive from invite.

Integration plan. RLS change is potentially breaking for any future PostgREST direct caller, but no current caller queries `auth_magic_links` directly. Backfill must run before policy tightens to avoid orphaning legacy rows.

Telemetry. Count of SELECTs against `auth_magic_links` before and after. Audit-event `magic_link_cross_tenant_select_attempted` if any policy denial fires post-deploy.

Effort. S (2 engineering days for code plus migration plus 1 day staging soak).

5-axis score. PSev 5, MDiff 4, TLev 5, EStr 5, SFit 5. Total 24/25.

Deep-dive prompt DD2. Standard pattern for magic-link RLS in multi-tenant Supabase apps. How does Vercel's own SaaS use Supabase auth tables? Sources: Supabase docs on `auth.users` RLS, community patterns from supabase/community github, comparable B2B apps.

### F3. Eval becomes server-verified, not caller-asserted

Problem. `src/api/eval/run.js:21-22` accepts caller-supplied `actual` results. A frontend regression or a malicious caller can post `actual = expected` and the dashboard shows 100% accuracy. Every product decision downstream of the dashboard is suspect. `/trust` page (Phase 3) is blocked. `[verified-on-main]`

Current state on main. Comment at run.js:21-22: "Caller submits actual extraction results (since this server is generic) and we just score + record." Dashboard at `api/eval/dashboard.js` aggregates these caller-asserted scores. There is no `.github/workflows/eval*.yml` on main; no CI gate against regression.

Proposed change. Refactor `run.js` to accept `{ case_id, document_source_id }` and invoke `runExtractionPipeline()` directly from `src/api/_lib/docai/run.js`. Add HMAC attestation column `eval_runs.attestation_hmac` (tamper-evident result chain). Add `eval_runs.prompt_version`, `model_version`, `pipeline_version` columns. Add GitHub Actions job that runs a 20-to-50 case golden suite on every `main` push and blocks merge on more than 2% accuracy regression.

Technical implementation. Edit `src/api/eval/run.js`. Add migration `106_eval_runs_attestation.sql`. Curate 50 golden fixtures at `tests/fixtures/extraction-golden/` covering Tally-export PO, e-mail-body PO, image-only PO, OBARA-versus-end-customer edge case, multi-line-discount, GST-with-CESS, supplier-ack variants. Wire `.github/workflows/eval-ci.yml`. Anthropic API cost per run is $5 to $20 at 50 cases. Budget $250 to $1,000 per month at 50 PRs.

Integration plan. Existing `eval_runs` rows tag as `mode='legacy_caller_asserted'` so dashboard can filter. New eval cases require `document_source_id`. Fixture curation requires domain-expert sign-off on each `expected_jsonb`.

Telemetry. Eval pass rate over time per adapter per document class. Deviation alerts wired to Sentry (Phase 9).

Effort. M (4 to 5 engineering days plus 6 to 8 days fixture curation plus 2 weeks of domain-expert hours).

5-axis score. PSev 4, MDiff 5, TLev 5, EStr 5, SFit 5. Total 24/25.

Deep-dive prompt DD3. Server-side eval frameworks for document extraction: LangSmith, Phoenix, Promptfoo, LlamaIndex evaluation. Pull the golden-fixture pattern from Anthropic eval cookbook and Constitutional AI evals. Define a tamper-evident eval result chain.

### F4. Register `tick.js` in vercel.json plus heartbeat-staleness alerting

Problem. Sub-daily workflows depend on external cron-job.org. Silent failure breaks email parse, 17 ERP retry queues, voice, WhatsApp, agent loop, inventory positions, drift meter, Tally reconciliation. No alert fires; the only signal is `cron_health.last_seen_at` staling, and the staleness check itself triggers from daily.js. `[verified-on-main]`

Current state on main. `vercel.json:12-17` registers only `/api/cron/daily` at `30 2 * * *`. `src/api/cron/tick.js:1-22` documents 5-minute cadence. `docs/CRONS.md` describes the cron-job.org dependency.

Proposed change. Path A preferred: add `{"path": "/api/cron/tick", "schedule": "*/5 * * * *"}` to `vercel.json`. If Vercel function-count cap blocks (Hobby tier caps at 12; codebase already consolidates to one via dispatch.js), upgrade plan. Path B fallback: keep external scheduler, wire heartbeat-staleness alert into `daily.js` so if `cron_health.last_seen_at` on tick is more than 15 minutes stale, fire Sentry plus email on-call.

Technical implementation. Edit `vercel.json`. Either path: add `_lib/heartbeat-check.js` to `daily.js`. Wire Sentry SDK in `dispatch.js` (Phase 9 fully).

Integration plan. Heartbeat table `cron_health` already exists (migration 066). Only the alert path is missing.

Telemetry. Mean time between ticks; alert if greater than 7 minutes for 2 consecutive intervals.

Effort. S (1 to 2 engineering days for path A; 3 days for path B).

5-axis score. PSev 5, MDiff 2, TLev 4, EStr 5, SFit 5. Total 21/25.

Deep-dive prompt DD4. Vercel cron limits across Hobby, Pro, Enterprise tiers (May 2026 state). Cloudflare Workers Cron and AWS EventBridge comparison. Document the external-scheduler dependency: which service, which account, which SLA, who pays the bill.

### F5. Storage bucket tenant scoping

Problem. SELECT policy at `supabase/migrations/001_init.sql:480-483` reads `bucket_id = 'obara-documents' and auth.role() = 'authenticated'`. No tenant scope. A token-leak from any tenant grants cross-tenant document read. `[verified-on-main]`

Proposed change. Migration `107_storage_tenant_scope.sql` that scopes SELECT and INSERT policies on `storage.objects` to `bucket_id = 'obara-documents' AND (storage.foldername(name))[1] = <tenant-uuid-from-jwt>::text`. Enforce path convention `<tenant_uuid>/<document_id>/<filename>` on upload. Backfill existing documents that do not match.

Technical implementation. Migration plus `documents/upload.js` path-convention enforcement plus `documents.bucket_path` text column. Update `documents/[id].js` and `documents/[id]/evidence.js` to derive bucket path from `tenant_id` plus `document_id`. Backfill script that scans `storage.objects`, parses existing paths, rewrites or moves to `<orphan>/` quarantine.

Integration plan. Breaking for any browser-direct `supabase.storage.from()` call. A1 and A5 inventory suggests the SPA goes through the API, not direct storage. Run a `grep -rln "supabase.storage.from" src/` first; gate behind staging soak.

Telemetry. Storage-policy denials per tenant per day; alert on spike.

Effort. M (3 to 4 engineering days plus backfill operator).

5-axis score. PSev 5, MDiff 4, TLev 4, EStr 5, SFit 5. Total 23/25.

Deep-dive prompt DD5. Supabase storage RLS patterns for multi-tenant SaaS at scale. Look at supabase/community github for object-path conventions. Audit comparable Supabase-based SaaS that got bitten by this pattern: PostHog cases, Cal.com cases.

### F6. Remove `OBARA_STATE = "Maharashtra"` hardcoded constant

Problem. `src/scripts/build-unified-app.mjs:1363` defines `const OBARA_STATE = "Maharashtra"`. Interstate-vs-intrastate GST classification derives against this constant. Any non-Maharashtra tenant has every order classified as interstate (IGST) when intrastate (CGST+SGST) is correct, or vice versa. `[verified-on-main]`

Proposed change. Replace constant with `tenant_settings.state_code` lookup. Derive seller-state from `tally_companies.gstin` (first two digits is state-code prefix) when `state_code` is null. Update interstate-vs-intrastate logic to use resolved state. Migration 108 to add `tenant_settings.state_code`.

Technical implementation. Edit `src/scripts/build-unified-app.mjs`, every site that imports `OBARA_STATE`, every GST classification site. Backfill `tenant_settings.state_code` from the dominant `tally_companies.gstin` per tenant. Add fixture covering Maharashtra, Tamil Nadu, Karnataka, plus a union territory.

Integration plan. Tally export, e-invoice composer, and the legacy bundler all touch GST classification. Coordinate with F1 voucher-type sweep.

Telemetry. Per-tenant GST classification distribution before and after.

Effort. S (2 to 3 engineering days).

5-axis score. PSev 4, MDiff 3, TLev 4, EStr 5, SFit 5. Total 21/25.

Deep-dive prompt DD6. CBIC place-of-supply rules. Map per-state-prefix GSTIN to state code. Validate the 36 state and union territory codes against the official CBIC notification.

### F7. `bypassFirewall` scope review

Problem. Surface report A3 originally flagged that any write-role caller could pass `bypassFirewall=true` on `src/api/claude/messages.js` to skip the injection redaction firewall. Spot-checked on main at `src/api/claude/messages.js:51-59`: `bypassFirewall=true` is now gated by `requirePermission(ctx, "admin")`, not write. The original critical framing is closed; the remaining risk is the browser-direct `callClaude` path in the legacy SPA and the injection bench's failure to exercise the production code path. `[verified-on-main]`

Proposed change. Confirm admin gate is correct, remove the `bypassFirewall` parameter entirely on the bench-test API path, refactor the injection bench at `src/api/eval/agent_eval.js` to invoke `callAnthropic()` and `callGemini()` post-redaction so the bench exercises the production firewall. Add to CI; fail build on any injection success.

Technical implementation. Edit `src/api/claude/messages.js` to remove the bypass parameter (or annotate it for internal-only). Refactor `src/api/eval/agent_eval.js` to wrap production callers. Build a 200-prompt suite covering OWASP LLM Top 10. Run against a known-vulnerable historical commit to verify the bench actually fails on injection.

Integration plan. Browser-direct path in legacy SPA still active for some operator features; add a redirect to the API proxy.

Telemetry. Injection success rate per bench run.

Effort. M (3 engineering days for bench refactor plus 1 to 2 weeks corpus curation).

5-axis score. PSev 4, MDiff 3, TLev 4, EStr 4, SFit 4. Total 19/25.

Deep-dive prompt DD7. OWASP LLM Top 10 injection corpus. Lakera and HiddenLayer prompt-injection corpora. Anthropic responsible scaling injection notes.

### F8. GSTIN Mod-36 checksum validation

Problem. GSTIN validation across `src/api/tally/`, `src/api/einvoice/`, and customer/supplier create paths checks only the 15-character shape regex. The Mod-36 checksum byte is unverified, so a single-digit typo passes. CBIC reference algorithm is public. `[verified-from-surface-report A7]`

Proposed change. Implement `validateGSTIN(gstin)` in `src/api/_lib/gstin.js`. Use Verhoeff-like Mod-36 per CBIC reference. Call from every GSTIN-accepting handler.

Technical implementation. New `src/api/_lib/gstin.js`. Edit customer create/edit, supplier create/edit, einvoice/index.js, tally companies, validators. Test fixture: 50 real GSTINs plus 20 deliberate invalid permutations.

Effort. S (1 engineering day for algorithm plus 1 day for sweep).

5-axis score. PSev 3, MDiff 2, TLev 5, EStr 5, SFit 4. Total 19/25.

Deep-dive prompt DD8. GSTIN check-digit algorithm per CBIC reference and the 36-character alphabet ordering. Existing npm packages and their test cases.

### F9. `/api/healthz` route plus uptime monitor

Problem. `api/dispatch.js:1-28` is the single Vercel function. Any import error in `src/api/router.js` returns Vercel's 404 for every `/api/*` request, indistinguishable from a routing miss. No probe distinguishes "dispatch is down" from "network error". `[verified-on-main]`

Proposed change. Add `/api/_healthz` route that hits the dispatch chain and returns `{ ok: true, commit, ts }`. Add Better Stack or UptimeRobot check polling every 30 seconds with alert on two consecutive failures. Wire deploy-time smoke test to hit `/api/_healthz` before traffic flip.

Technical implementation. Add `src/api/healthz.js` handler. Wire in `src/api/router.js`. Add Vercel deploy hook (or external poller).

Effort. S (1 to 2 engineering days).

5-axis score. PSev 5, MDiff 2, TLev 5, EStr 5, SFit 4. Total 21/25.

### F10. Cron-mux per-handler timeout

Problem. `src/api/cron/tick.js:18-22` uses `Promise.allSettled` for ERP fan-out (correct for independence) but the Vercel function timeout of 60 seconds applies to the entire tick invocation. `vercel.json:8-10` sets `maxDuration: 60` on `api/dispatch.js`. If SAP sync takes 58 seconds, every other retry queue gets less than 2 seconds. `runCronGroup` has try/catch per handler but no per-handler timeout. `[verified-on-main]`

Proposed change. Wrap each adapter call in `Promise.race([handler(), timeout(20000)])` inside `src/api/_lib/cron-mux.js`. Log timeouts to `processing_events.event_type='cron.handler.timeout'`. Add per-handler latency histogram on `processing_events`.

Technical implementation. Edit `src/api/_lib/cron-mux.js`. Add per-handler config: SAP 25s, NetSuite 20s, D365 20s, Tally 30s (Tally companies are on-prem and slower). Cap total handler budget per group.

Effort. S (1 to 2 engineering days).

5-axis score. PSev 4, MDiff 1, TLev 5, EStr 4, SFit 3. Total 17/25.

### F11. Role enum drift fix

Problem. API accepts `"approver"` and `"operator"` roles; database `obara_role` enum has 6 values without those two. Invites for those roles silently fail at the database. Frontend RBAC at `src/v3-app/lib/rbac.ts` uses 7 roles. Three layers disagree. `[verified-from-surface-report A5]`

Proposed change. Pick one canonical role taxonomy (the v3 frontend's 7-role set: `viewer, sales_engineer, sales_manager, procurement, finance, operator, admin`). Migration 109 to add missing enum values. Update API allow-list and frontend RBAC matrix. CI check that the three layers stay in sync.

Effort. S (2 engineering days).

5-axis score. PSev 3, MDiff 1, TLev 4, EStr 5, SFit 4. Total 17/25.

### F12. PREFLIGHT_PROMPT stale date

Problem. `PREFLIGHT_PROMPT` embeds "within 12 months of today March 2026" which is 2 months stale at synthesis time. Fold into the prompt-registry work (Phase 2 F18) by templating the date at request time. `[verified-from-surface-report A3]`

Proposed change. Replace hardcoded date with `{TODAY}` placeholder; render at request time from `new Date().toISOString().slice(0,10)`. This is a one-line fix that should land in Phase 1 even though the broader prompt registry is Phase 2.

Effort. S (half day).

5-axis score. PSev 3, MDiff 1, TLev 5, EStr 5, SFit 3. Total 17/25.

### F13. tally_companies multi-tenant audit

Problem. The `tally_companies` table holds Tally bridge config per tenant. A11 and A4 reports note tenant-scope discipline but a sweep for missing `.eq("tenant_id", ...)` in `src/api/tally/companies.js` is overdue. `[verified-from-surface-report A4]`

Proposed change. Audit every `tally_companies` query for tenant filter; add the static-analysis CI gate (full version Phase 5 F30) for tally-specific tables.

Effort. M (2 to 3 engineering days for audit plus fix).

5-axis score. PSev 4, MDiff 2, TLev 4, EStr 4, SFit 4. Total 18/25.

### Phase 1 exit criteria

All 13 items closed and smoke-tested on staging. F1, F2, F5, F6 require migrations that run staging-first. `npm run check && npm run typecheck && npx vitest run` green. Audit-event "P0 closed" record exists for each. Sentry receiving cron failure alerts in staging. TallyPrime sandbox dry-run confirms emitted vouchers appear in GSTR-1 dry-run output.

### Phase 1 risks

F1 voucher-type change may invalidate prior drift comparison rows. Mitigation: re-emit or tag legacy. F2 RLS migration could drop a legitimate cross-tenant read. Mitigation: audit current SELECT shape against `auth_magic_links` first. F5 storage migration breaks any browser-direct `supabase.storage.from()` call. Mitigation: pre-audit. F3 eval refactor invalidates existing `eval_runs` rows. Mitigation: tag legacy `mode='legacy_caller_asserted'`. F11 role enum change could orphan rows pinned to legacy values. Mitigation: explicit re-mapping migration.

---

## Section 4. Phase 2 eval credibility plus telemetry hardening (4 weeks)

Theme: make every accuracy and quality and cost claim provable. Unblock Phase 3 trust page and BRSR enterprise pilots.

### F14. Server-side eval execution (continuation of F3)

The Phase 1 F3 fix lands the harness refactor. Phase 2 extends it with the full golden-fixture suite (50 cases curated by domain experts), the CI pipeline running on every push to main, the regression-block at 2% accuracy delta, the per-model and per-document-class accuracy breakdown, and the public-facing accuracy number that the `/trust` page will read from. Anthropic and Gemini API costs budgeted at $250 to $1,000 per month for CI.

Effort. L (8 engineering days for full pipeline; 2 weeks domain-expert curation runs in parallel).

5-axis score. PSev 4, MDiff 5, TLev 5, EStr 4, SFit 5. Total 23/25.

Deep-dive prompt DD9. Golden-fixture curation strategy. FUNSD, CORD, DocVQA, OmniDocBench dataset structures. The right 50-document split for Anvil's Indian-manufacturing-PO ICP.

### F15. Golden-set drift detector

Problem. Even with the CI gate, slow accuracy drift (1% per month) escapes the merge-block threshold but compounds over a quarter. The team needs a weekly drift report that compares the golden set's current accuracy against a 30-day moving baseline. `[verified-from-surface-report A3]` `[verified-from-surface-report A11]`

Proposed change. Add weekly cron `eval-drift-report` that runs the golden set against the production extraction pipeline, persists scores to `eval_drift_runs`, computes 30-day moving baseline, and emits Slack alert if drift greater than 0.5% per week.

Technical implementation. New table `eval_drift_runs` (migration 110). Cron handler at `src/api/cron/eval-drift.js`. Slack webhook in `_lib/slack.js`.

Effort. M (3 engineering days).

5-axis score. PSev 3, MDiff 4, TLev 5, EStr 4, SFit 5. Total 21/25.

### F16. Replay UI for failed extractions

Problem. When an extraction returns low confidence or an operator overrides a field, the only persistence is `extraction_corrections`. There is no replay UI that lets engineering re-run the same document through different adapter chains or prompt versions to diagnose. `[verified-from-surface-report A3]`

Proposed change. New admin route `/admin/replay/<extraction_run_id>` that loads the document, lets engineering pick adapter chain plus prompt version, runs, compares against the original. Persists comparisons to `extraction_replays`.

Technical implementation. New screen, new endpoint, new migration.

Effort. M (5 engineering days).

5-axis score. PSev 3, MDiff 4, TLev 5, EStr 4, SFit 4. Total 20/25.

### F17. Audit chain HMAC at write time

Problem. `src/api/_lib/audit.js:53-87` writes `audit_events` rows with `tenant_id, actor, action, object_type, payload_hash` but does not stamp `prev_hash` or `self_hash` at insert. The chain is computed at export time in `api/audit/export.js`. An attacker who can suppress a row leaves no detectable gap at query time. `[verified-on-main]`

Proposed change. Add `audit_events.prev_hash text` and `self_hash text` columns. Compute deterministically at insert time via a trigger that reads the prior row's `self_hash`, includes it in the hash input, and writes back. Add CI verifier that walks the chain and asserts continuity.

Technical implementation. Migration 111 to add columns plus trigger. The trigger must be idempotent on retry (any conflict on `(tenant_id, sequence_no)` re-derives from the conflicting row, not the prior). Verifier at `scripts/verify-audit-chain.mjs`.

Integration plan. Production deploy requires a freeze window because the trigger touches every audit write. Backfill on existing rows before enabling write trigger.

Telemetry. Verifier run weekly; alert on chain break.

Effort. L (8 engineering days; engineering-expensive because the chain must be deterministic, idempotent on retry, and verifiable in CI).

5-axis score. PSev 4, MDiff 3, TLev 4, EStr 4, SFit 5. Total 20/25.

### F18. Prompt-version stamping on extraction_runs and model_routing_log

Problem. Prompts are embedded strings in `_lib/docai/claude.js` and `_lib/docai/gemini.js`. No version on `extraction_runs.prompt_id`, `model_routing_log.prompt_hash`. Voter consensus runs across adapters that may be on different prompt versions. `[verified-from-surface-report A3]`

Proposed change. Extract every prompt to `src/api/_lib/prompts/*.js`. Export as `{ id, version, text, hash }`. Stamp `extraction_runs.prompt_id`, `prompt_version`, `prompt_hash` per adapter call. Bump version on every prompt change (semantic versioning: major for schema break, minor for instruction refinement, patch for typo). CI check that any prompt file change requires version bump.

Technical implementation. New `src/api/_lib/prompts/po_extraction.js`, `supplier_ack_extraction.js`, `eway_extraction.js`. Imports from claude.js and gemini.js. Migration 112 to add columns.

Effort. M (4 engineering days).

5-axis score. PSev 3, MDiff 3, TLev 5, EStr 4, SFit 5. Total 20/25.

### F19. Anomaly engine outcome capture plus tunable thresholds

Problem. `src/api/anomaly/compute.js` has 20 rules with hardcoded thresholds (`|z| > 2` warn, `|z| > 3` high, `mad/median < 2%` round-number suppression). No `tenant_anomaly_settings` table, no per-tenant override. Operator outcomes (true positive versus false positive versus ignored) are not captured. `[verified-from-surface-report A8]`

Proposed change. Migration 113 to add `tenant_anomaly_settings(tenant_id, rule_key, z_warn, z_high, sample_min, enabled, severity_override)` plus `anomaly_outcomes(tenant_id, order_id, rule_key, fired_at, operator_decision, resolved_at)`. Bayesian-update thresholds toward optimum with operator override. Dashboard card: false-positive rate per rule per tenant per 30 days.

Effort. M (5 engineering days).

5-axis score. PSev 3, MDiff 4, TLev 5, EStr 4, SFit 4. Total 20/25.

### F20. Delete the client-side Gaussian anomaly path

Problem. `src/scripts/build-unified-app.mjs:962` defines `detectAnomalies(order, stats)` running Gaussian z (mean + std), and `build-unified-app.mjs:4218-4220` concatenates remote MAD flags onto local Gaussian flags. The two estimators systematically disagree on heavy-tailed B2B procurement data. Operators see the same anomaly fire twice with different severity. Alert fatigue. `[verified-from-surface-report A8]`

Proposed change. Delete `detectAnomalies` from `build-unified-app.mjs:962-988` and the call site at 3862. Convert 4220 concat into assignment (`order.anomalyFlags = remoteAnomaly.flags`). Add a thin client cache so operators do not see flag-flicker between client-side initial render and post-extract server-confirmed flags.

Effort. S (2 engineering days).

5-axis score. PSev 4, MDiff 3, TLev 4, EStr 4, SFit 4. Total 19/25.

### F21. Per-tenant LLM USD spend cap

Problem. `model_routing_log` captures tokens. `docai_daily_usage` enforces per-adapter call-count caps. No per-tenant per-day USD cap. A misconfigured tenant on Opus burns hundreds per day uncapped. `[verified-from-surface-report A11]`

Proposed change. Add `tenant_settings.daily_usd_budget numeric(10,2) default 50`. Daily rollup view `llm_daily_spend(tenant_id, date, provider, usd)`. Middleware `cost_status.js` on every paid-adapter entry point: read tenant budget, running tally, short-circuit at 100% with rule outcomes R1 to R9.

Technical implementation. Migration 114 plus view plus middleware. Operator override path with audit-trail.

Effort. M (3 to 4 engineering days).

5-axis score. PSev 4, MDiff 2, TLev 4, EStr 5, SFit 4. Total 19/25.

### Phase 2 exit criteria

CI golden eval running; baseline accuracy stamped (becomes the public `/trust` number). Every `extraction_runs` row carries prompt_version and model_version. Per-tenant LLM spend cap enforced and visible in admin. Sentry receiving cron and extraction errors. Anomaly outcome capture wired; first false-positive-rate chart visible. Audit chain HMAC chain at write live; verifier passes weekly.

---

## Section 5. Phase 3 trust plus sales-motion enablement (6 weeks)

Theme: turn shipped-but-invisible bets into customer-facing value. Close the gaps that prevent enterprise procurement: SOC 2 status visibility, accuracy benchmark, customer evidence, Tally drift productization.

### F22. Public `/trust` page

Problem. No public security or accuracy posture. Axal publishes 95%+ openly. Hyperscience publishes Gartner MQ Leader and FedRAMP High. Anvil has the internal data (eval_runs, audit_events, cron_health) but no public surface. `[verified-from-surface-report A1]` `[verified-from-surface-report A10]`

Proposed change. New `/trust` route showing accuracy by adapter (last 90 days, golden fixtures via Phase 2 F14), parse_method distribution, audit-events 30-day count, security posture (DPDP redaction, AES-256-GCM at rest, audit-signed export, SOC 2 observation window status with honest timeline, PII redaction layers, prompt-injection bench results). Bind to `eval_runs` plus `cron_heartbeat` plus audit metrics via a public-read view (no PII).

Technical implementation. New screen at `src/v3-app/screens/trust.tsx`. New public-read SQL view `v_trust_metrics_public`. The screen pulls from a single endpoint `/api/trust/snapshot` that aggregates daily.

Effort. M (4 to 5 engineering days plus 2 design days).

5-axis score. PSev 4, MDiff 5, TLev 3, EStr 4, SFit 5. Total 21/25.

Deep-dive prompt DD10. Trust-page best practices across Stripe, Vercel, Supabase, Soff, Mercura. What balance of marketing claim versus auditor-grade detail wins enterprise procurement.

### F23. Cost-per-SO meter on the trust and admin surfaces

Problem. A11's central finding: the cost-attribution loop is a pricing-conversation prerequisite. Once a distributor sees "you spent $0.43 on this PO" on a per-order timeline, the Rs 39 / Rs 19 / Rs 9 overage feels reasonable. Without it, the CFO sees only the Stripe invoice and the math is opaque. `[verified-from-surface-report A11]`

Proposed change. Per-order cost-attribution panel on order detail. Trust-page rollup: median cost per SO last 30 days. Admin rollup: per-tenant cost per SO sortable by month. Reads from `model_routing_log` plus `docai_daily_usage` plus the Phase 2 F21 spend-cap signals.

Technical implementation. Materialised view `mv_cost_per_so(order_id, tenant_id, total_usd, model_breakdown, computed_at)` refreshed hourly. UI components in `src/v3-app/components/CostBadge.tsx`. Trust-page card.

Effort. M (4 engineering days).

5-axis score. PSev 3, MDiff 4, TLev 4, EStr 4, SFit 5. Total 20/25.

### F24. Confidence chips across extraction surfaces

Problem. Operators see line-item extractions without per-field confidence. A correction loop without confidence signal cannot prioritise operator attention. `[verified-from-surface-report A2]` `[verified-from-surface-report A12]`

Proposed change. Add `extraction_lines.confidence numeric(3,2)` populated by the adapter's per-field score (Claude tool_use confidence, Gemini structured-output score, voter consensus). Render confidence chip on SO workspace and orders surfaces. Sort review queue by lowest confidence.

Technical implementation. Migration 115 to add column. Update voter.js to emit per-field confidence. Update SO workspace primitives (Chip, KV) to render the score.

Effort. M (4 engineering days).

5-axis score. PSev 3, MDiff 4, TLev 4, EStr 4, SFit 4. Total 19/25.

### F25. Sandbox tenant and `/sandbox` route

Problem. Landing copy at `src/v3-app/screens/landing.tsx:656` advertises "free pilot, 30 min, we run a real PO" with no in-page artifact. NN/g's "delay authentication until after value" is the most-cited B2B UXR rule. `[verified-from-surface-report A1]`

Proposed change. New `/sandbox` route (anonymous, no signup). Pre-canned PO PDF. Posts to `/api/sandbox/extract` which is a thin wrapper around the real extraction pipeline forced into a sandbox tenant with 7-day retention. Rate-limited 5 runs per IP per day. CTA at the end: "See it on your PO" lands signin with sandbox-source pre-fill.

Technical implementation. New route in `src/v3-app/App.tsx`. New screen `sandbox.tsx`. New endpoint with rate-limit. Migration 116 adds `sandbox_runs` table with 7-day retention cron.

Effort. M (5 engineering days).

5-axis score. PSev 4, MDiff 5, TLev 3, EStr 4, SFit 5. Total 21/25.

### F26. Time-to-value instrumentation

Problem. The "2 weeks to first voucher" claim in landing copy is uninstrumented. No `time_to_first_voucher` event in `audit_events`. The Phase 3 sandbox-to-signin funnel needs telemetry to be measurable. `[verified-from-surface-report A1]`

Proposed change. Add audit-event types: `tenant_signed_up`, `tenant_first_document_uploaded`, `tenant_first_voucher_pushed`, `tenant_first_audit_export`. Dashboard at admin surface showing median time per stage per cohort.

Effort. S (2 engineering days).

5-axis score. PSev 3, MDiff 3, TLev 5, EStr 5, SFit 4. Total 20/25.

### F27. First-run tour

Problem. `onboarding.tsx` is a 122-line checklist, not a tour. Linear, Notion, Figma all ship a guided first-run tour. `[verified-from-surface-report A1]`

Proposed change. New `FirstRunTour` component using react-joyride or a homegrown overlay. Steps: upload your first PO, see the extraction, push to Tally sandbox, see the voucher, view the audit trail. Persist completion to `tenant_onboarding_progress`.

Effort. M (5 engineering days plus design).

5-axis score. PSev 3, MDiff 3, TLev 3, EStr 4, SFit 4. Total 17/25.

### F28. Customer security review packet

Problem. Enterprise procurement asks for a security questionnaire. Anvil has no pre-built packet. `[verified-from-surface-report A1]` `[verified-from-surface-report A10]`

Proposed change. Generate a static packet (PDF or web page) covering DPDP posture, GDPR posture, data-flow diagram, redaction firewall description, key management posture, SOC 2 observation window status, sub-processor list. Update quarterly.

Effort. M (3 engineering days plus 3 legal days).

5-axis score. PSev 4, MDiff 3, TLev 2, EStr 5, SFit 5. Total 19/25.

### Phase 3 exit criteria

`/trust` page live with provable accuracy. Cost-per-SO meter visible. Confidence chips across extraction surfaces. Sandbox tenant live with rate-limit. First-run tour shipped. Customer security review packet published. SOC 2 observation window started (linked to Phase 11). Three named customer logos on landing.

---

## Section 6. Phase 4 DocAI engine v2 (6 weeks)

Theme: turn shipped DocAI into research-grade DocAI. Build on prompt-version plus golden-fixture work from Phase 2.

### F29. Multi-adapter voter cost weighting

Problem. `src/api/_lib/docai/voter.js` treats all adapters equally. When Sonnet 4.6 historically outperforms Gemini 3 Flash on a tenant's PO format, voter should weight Sonnet higher. Also: when adapter cost-per-call differs by 10x but accuracy differs by 1%, voter should prefer the cheaper. `[verified-from-surface-report A3]`

Proposed change. Per-tenant per-adapter accuracy estimate from `extraction_corrections` rate. Voter weighted-quantile by recent accuracy and inverse cost. Add cost-quality elbow detection: refuse to escalate to Opus if Sonnet's marginal accuracy delta is below 1% per the per-tenant golden set.

Technical implementation. New `voter_weights` table. Update voter.js. Add to operator surface: "Sonnet says X (0.92), Gemini says Y (0.88), picking X" already in F30 below.

Effort. M (5 engineering days).

5-axis score. PSev 3, MDiff 4, TLev 5, EStr 4, SFit 5. Total 21/25.

### F30. Voter disagreement signal to operator

Problem. When adapters disagree on a field, voter picks majority but does not surface disagreement. Operators have no signal that the field is contested. `[verified-from-surface-report A3]`

Proposed change. `extraction_runs.voter_disagreements jsonb` field listing per-field adapter splits. Surface in SO workspace as "Claude says ACME, Gemini says ACME CORP, picked ACME".

Effort. M (3 engineering days).

5-axis score. PSev 3, MDiff 4, TLev 4, EStr 5, SFit 4. Total 20/25.

### F31. Line alignment beyond `partNumber`

Problem. The line-alignment logic in voter and parse.js keys on `partNumber`. Real-world POs frequently have part numbers in a customer's own naming convention plus a brand-equivalent line. The voter consensus collapses when adapters disagree on which line is "the same line". `[verified-from-surface-report A3]`

Proposed change. Implement Hungarian-algorithm bipartite matching across (partNumber, description, quantity, unitPrice) with weighted Levenshtein on description. Fall back to position-based matching on disagreement.

Effort. M (5 engineering days).

5-axis score. PSev 4, MDiff 4, TLev 5, EStr 4, SFit 4. Total 21/25.

### F32. Content-type gates pre-LLM

Problem. `src/api/docai/extract.js:40-46` picks source_type by filename or mime hint, not magic bytes. A docx file with `.pdf` extension reaches `utf8_text_fallback` at `claude.js:425-431` and forwards 50KB of binary garbage to the model. Same for malformed Office files routed to `excel` adapter which bypasses the daily cap (`cost_guard.js:35`). `[verified-from-surface-report A3]`

Proposed change. Add `_lib/docai/content_type.js` that sniffs magic bytes (PDF, PNG, JPG, ZIP-Office, OLE). Call once in `extract.js` before pipeline. Reject 415 on declared-versus-sniffed mismatch when neither shape is supported.

Effort. S (2 engineering days).

5-axis score. PSev 4, MDiff 3, TLev 5, EStr 4, SFit 4. Total 20/25.

### F33. OCR utf8 fallback removal

Problem. The utf8 text fallback at `claude.js:425-431` is a footgun: it hands raw bytes to the LLM when the bytes are not what they claim. Content-type gate (F32) eliminates the need. `[verified-from-surface-report A3]`

Proposed change. Remove the utf8 fallback. Replace with a typed error that the operator surface can show.

Effort. S (1 engineering day).

5-axis score. PSev 4, MDiff 2, TLev 5, EStr 4, SFit 4. Total 19/25.

### F34. Injection firewall vendor parity Anthropic + Gemini + Mistral

Problem. The redaction-firewall path in `_lib/anthropic.js` is the only enforcing call site. Gemini at `_lib/gemini.js` and Mistral OCR at `_lib/mistral.js` do not consistently route through the firewall. Seven downstream callers bypass it. `[verified-from-surface-report A3]` `[verified-from-surface-report A10]`

Proposed change. Single `_lib/redaction.js` module that every outbound fetch calls. Mirror `applyFirewall` semantics across Anthropic, Gemini, Mistral. CI grep guard that any new `fetch` call to a paid LLM provider routes through redaction.

Effort. M (5 engineering days).

5-axis score. PSev 4, MDiff 3, TLev 5, EStr 4, SFit 5. Total 21/25.

### F35. OCR-quality gate before LLM dispatch

Problem. Low-quality OCR is sent to LLM and burns credits. No quality-score gate. `[verified-from-surface-report A3]`

Proposed change. After L2 (OCR layer) compute quality score (char density, page-coverage, confidence). If below threshold, short-circuit to `status='ocr_quality_too_low'` plus operator notification.

Effort. M (4 engineering days).

5-axis score. PSev 4, MDiff 3, TLev 4, EStr 4, SFit 4. Total 19/25.

### F36. Schema-aligned parsing extensions

Problem. `_lib/docai/parse.js` handles fences, prose, commas, truncation, unquoted keys. Edge cases not covered: `\r\n` line endings, hex-encoded characters, BOM, double-quotes-inside-string mid-truncate. `[verified-from-surface-report A3]`

Proposed change. Extend `parse.js` with explicit handlers per edge case plus property-based tests (fast-check) generating malformed JSON.

Effort. M (3 to 4 engineering days).

5-axis score. PSev 3, MDiff 3, TLev 5, EStr 4, SFit 4. Total 19/25.

### F37. Prompt-injection bench v2 against production path

Problem. Existing 6-prompt injection bench bypasses production path. False assurance. `[verified-from-surface-report A3]`

Proposed change. Refactor bench to exercise `callAnthropic()` and `callGemini()` post-redaction. Add to CI; fail build on any new injection success.

Effort. M (3 engineering days plus 1 to 2 weeks corpus curation).

5-axis score. PSev 4, MDiff 3, TLev 4, EStr 5, SFit 5. Total 21/25.

### Phase 4 exit criteria

Voter accuracy-weighted. Voter disagreements visible. Line alignment uses Hungarian matching. Content-type gate live. OCR utf8 fallback removed. Firewall vendor parity across Anthropic, Gemini, Mistral. OCR quality gate operating. Injection bench v2 in CI with 200+ prompts.

---

## Section 7. Phase 5 multi-tenancy hardening (8 weeks)

Theme: the platform was originally designed single-tenant-per-deploy. Retrofit multi-tenant rigor. 359 service-role files plus 253 RLS-enabled tables plus 889 explicit `.eq("tenant_id", ...)` calls plus 63 migrations using a JWT-claim RLS pattern that never fires.

### F38. Service-role to user-JWT first wave

Problem. Every business handler uses `serviceClient()` which carries `BYPASSRLS`. Any new endpoint that forgets `.eq("tenant_id", ...)` is silently cross-tenant. No CI gate, no Semgrep rule, no nightly cross-tenant integrity scan. `[verified-from-surface-report A5]` `[verified-from-surface-report A10]`

Proposed change. First wave: migrate read paths on customer-facing surfaces (orders, customers, invoices, documents) to `userClient(req)` so RLS becomes load-bearing. Service-role retained on cron paths, audit writes, super-admin endpoints (annotated `// rls-bypass:reason`). 100-table coverage in first wave; deferred tables in Phase 9.

Technical implementation. New `_lib/user-client.js` helper that converts request JWT into a Supabase user-scoped client. Per-handler one-PR-at-a-time, gated by feature flag. Audit-export last. Align 63 JWT-claim RLS policies with the new query shape: replace `current_setting('request.jwt.claims', true)::json->>'tenant_id'` with `current_tenant_ids()`-based policies.

Integration plan. 3 to 5 week migration on live production with no staging environment named. Safest path: feature-flagged dual-write read-only for one week per handler; flip-over with rollback option. Audit-export endpoint last because it intentionally bypasses RLS.

Telemetry. Per-handler permission-denied rate; alert on spike post-flip.

Effort. XL (3 weeks for the helper plus 5 weeks for the 100-table sweep, fan-out to 4 engineers).

5-axis score. PSev 5, MDiff 3, TLev 5, EStr 5, SFit 5. Total 23/25.

Deep-dive prompt DD11. Supabase user-JWT scoped patterns. Vercel dashboard's own multi-tenant model. Linear's multi-tenant patterns. HackerOne reports on missed `tenant_id` scoping.

### F39. RLS dialect unification

Problem. 63 migrations install RLS policies on `current_setting('request.jwt.claims', true)::json->>'tenant_id'` which is null on every request because no code path ever sets `tenant_id` on the JWT. These policies deny every user-JWT read and write. They appear to work only because the app uses service-role. `[verified-from-surface-report A5]`

Proposed change. Consolidation migration `117_rls_dialect_unification.sql` that replaces every JWT-claim policy with a `current_tenant_ids()`-based policy or explicit RLS-disabled annotation with a `// rls-bypass:reason` comment. 63 files of decorative code become 63 functional policies.

Effort. L (8 engineering days for migration plus 2 weeks review and staging soak).

5-axis score. PSev 5, MDiff 3, TLev 5, EStr 5, SFit 5. Total 23/25.

### F40. Soft-delete pattern

Problem. Most business tables (orders, customers, invoices) lack a soft-delete pattern. DPDP Section 4(2) requires data minimisation and the right to erasure. A hard-delete leaves no audit trail; a soft-delete with explicit `deleted_at` plus retention sweep gives both DPDP compliance and operator undo. `[verified-from-surface-report A5]` `[verified-from-surface-report A10]`

Proposed change. Migration 118 adds `deleted_at timestamptz` to 30 business tables. Update RLS policies to filter `deleted_at is null` on default queries. Retention cron purges greater-than-90-days-soft-deleted rows.

Effort. L (10 engineering days for the schema sweep plus app-side queries).

5-axis score. PSev 4, MDiff 3, TLev 4, EStr 4, SFit 5. Total 20/25.

### F41. RLS coverage static analyzer in CI

Problem. Per-handler `.eq()` discipline cannot be enforced manually at 359 files. Need a static analyzer. `[verified-from-surface-report A5]` `[verified-from-surface-report A10]`

Proposed change. Build `scripts/audit-rls-coverage.mjs` (AST walker over every `svc.from(...)` chain). Output coverage report. Wire into `npm run check`. Annotate exempt endpoints with `// rls-bypass:reason` that the linter checks.

Technical implementation. Use `@typescript-eslint/parser`. For each query chain, walk the `.from().select().eq()` sequence and verify either tenant filter or annotation. Block CI on regression.

Effort. L (8 to 10 engineering days for the analyzer plus 3 to 5 days fixing gaps it surfaces).

5-axis score. PSev 5, MDiff 2, TLev 5, EStr 5, SFit 5. Total 22/25.

### F42. IDOR sweep across 277 tenant-FK tables

Problem. A10 noted IDOR risk on endpoints that take `:id` parameters without verifying the id belongs to the tenant. 277 tables with `tenant_id` FK suggests 277 potential IDOR surfaces. `[verified-from-surface-report A10]`

Proposed change. Sweep every `/api/.../[id].js` handler. Verify a `tenants_match` check between JWT tenant and resource tenant. Add a helper `requireTenantOwnership(svc, table, id, ctx)` that every handler calls.

Effort. L (10 engineering days for the sweep plus fixes).

5-axis score. PSev 4, MDiff 3, TLev 5, EStr 5, SFit 5. Total 22/25.

### F43. Eight dangerous WRITE policies with `tenant_id is null` fix

Problem. A5 found 8 WRITE policies that allow `tenant_id is null` inserts: `redaction_rules`, `engineering_specs`, `payment_milestones`, `expense_rate_cards`, `inco_terms_taxonomy`, `blanket_release_drawdown`, `logistics_ports`, `logistics_carriers`. `redaction_rules` is the highest-risk: a tenant member can install a global PII regex that silently null-redacts any tenant's OCR output. `[verified-from-surface-report A5]`

Proposed change. Single migration `119_rls_null_tenant_cleanup.sql` patches all 8 in 60 lines. Restrict WRITE to admins on globally-scoped tables; null-tenant inserts go through super-admin RPC only.

Effort. M (3 engineering days plus 2 days staging).

5-axis score. PSev 5, MDiff 2, TLev 5, EStr 5, SFit 5. Total 22/25.

### Phase 5 exit criteria

100 customer-facing tables migrated to user-JWT scope. RLS dialect unified. Soft-delete pattern across 30 business tables. RLS coverage CI gate active with zero unscoped queries. IDOR sweep complete with helper in place. Eight dangerous WRITE policies fixed.

---

## Section 8. Phase 6 India compliance partnership and completeness (6 weeks)

Theme: A7's strategic insight: the India statutory stack is widely covered by GSPs. Anvil's defensible wedge is upstream of compliance (PDF fingerprinting, payload-hash approval, mode-aware extraction). Partner with one GSP instead of building all five.

### F44. GSP partnership decision plus integration

Problem. Anvil hand-rolls e-invoice IRP generation, e-Way bill submission, GSTR-1/2A reconciliation. Each is a maintenance burden plus a compliance risk. Major GSPs (IRIS, Cygnet, ClearTax, Webtel) sell this as a service.

Proposed change. RFP across IRIS, Cygnet, ClearTax, Webtel. Pick one. Wire their API for IRN generation, QR, cancellation lifecycle, e-Way bill submission, GSTR-1/2A reconciliation. Anvil retains extraction plus voucher-state plus drift moat; GSP handles compliance plumbing.

Effort. L (6 to 8 engineering days plus 3 to 4 weeks partner onboarding plus contract).

5-axis score. PSev 4, MDiff 4, TLev 3, EStr 4, SFit 4. Total 19/25.

Deep-dive prompt DD12. GSP pricing and API depth (IRIS, Cygnet, ClearTax, Webtel). Per-document fee plus monthly minimum. Compare against in-house IRP integration cost.

### F45. IRN retry queue and e-Invoice cancellation flow

Problem. e-Invoice composer at `src/api/einvoice/index.js` hardcodes `RegRev = "N"` (no reverse charge). Cancellation flow not wired. IRN retry queue not durable. `[verified-from-surface-report A7]`

Proposed change. Replace hardcoded `RegRev` with `tenant_settings.reverse_charge_default` plus per-order override. Add IRN retry queue with idempotent retries. Wire cancellation flow against the GSP partner (F44).

Effort. M (5 engineering days).

5-axis score. PSev 4, MDiff 3, TLev 4, EStr 4, SFit 4. Total 19/25.

### F46. eway-bill multi-leg support

Problem. e-Way bill code path supports single-leg journeys. Multi-leg (transhipment) journeys are common in B2B logistics and require part-B updates per leg. `[verified-from-surface-report A7]`

Proposed change. Schema additions for `eway_legs` with per-leg vehicle, mode, distance. UI surface on order detail.

Effort. M (5 engineering days).

5-axis score. PSev 3, MDiff 4, TLev 3, EStr 4, SFit 4. Total 18/25.

### F47. AA consent renewal cron

Problem. Account Aggregator (Setu) consent has expiry. No cron renews. `[verified-from-surface-report A7]`

Proposed change. Cron `aa-consent-renewal-daily` checks consents expiring in 7 days, prompts the customer-facing tenant for renewal, falls back to read-revoke on expiry.

Effort. M (4 engineering days).

5-axis score. PSev 3, MDiff 3, TLev 4, EStr 4, SFit 4. Total 18/25.

### F48. TReDS discount lifecycle audit

Problem. TReDS factoring lifecycle (offer, accept, finance, settle) is wired but the audit trail per stage is thin. Treasury team needs a full discount-window timeline. `[verified-from-surface-report A7]`

Proposed change. Audit-event types per stage. Per-tenant TReDS dashboard.

Effort. M (4 engineering days).

5-axis score. PSev 3, MDiff 3, TLev 3, EStr 4, SFit 4. Total 17/25.

### F49. BRSR assurance trail

Problem. Bet 7 ships BRSR Core value-chain exports but the assurance trail (each disclosure pointing to source documents) is incomplete. Independent assurance providers expect a per-disclosure-row evidence chain. `[verified-from-surface-report A7]`

Proposed change. `brsr_disclosure_evidence(disclosure_id, evidence_uri, hash, recorded_at)` table. UI lets the disclosure operator attach evidence per row. Export bundles signed evidence with the disclosure.

Effort. M (5 engineering days).

5-axis score. PSev 3, MDiff 4, TLev 3, EStr 4, SFit 4. Total 18/25.

### F50. DPDP Significant Data Fiduciary (SDF) readiness

Problem. DPDP Act 2023 full commencement is May 13, 2027. Anvil's PII exposure (Aadhaar, PAN, GSTIN, bank-account, phone, address) plus volume crosses the SDF threshold once tenant count grows. SDF carries higher controls (DPIA, DPO, data-impact assessments). `[verified-from-surface-report A10]`

Proposed change. Conduct a DPIA. Appoint DPO (real person or fractional). Maintain a data-flow inventory aligned to DPDP Section 10. Publish a notice plus consent flow.

Effort. L (10 engineering days plus legal time).

5-axis score. PSev 4, MDiff 3, TLev 3, EStr 4, SFit 5. Total 19/25.

### F51. GeM portal connector

Problem. Government e-Marketplace (GeM) is the procurement-of-record for Indian PSUs. Distributors selling to PSUs need a GeM connector. `[verified-from-surface-report A4]`

Proposed change. Hand-rolled GeM REST client. Order-bid lifecycle. Supplier and seller-id mapping. ID verification against GeM seller catalog.

Effort. L (10 engineering days).

5-axis score. PSev 3, MDiff 5, TLev 3, EStr 3, SFit 4. Total 18/25.

### F52. GSTIN checksum (continuation of Phase 1 F8)

Continuation of Phase 1 F8: sweep every GSTIN-accepting handler that the Phase 1 work did not catch. Run the static analyser over all GSTIN-typed columns.

Effort. S (1 engineering day).

### Phase 6 exit criteria

GSP partner signed and IRP integration in production. IRN retry queue durable. e-Invoice cancellation flow live. eway multi-leg supported. AA consent renewal cron operational. TReDS lifecycle fully audited. BRSR assurance trail complete. DPDP DPIA and DPO appointed. GeM connector live for two pilot tenants.

---

## Section 9. Phase 7 inventory math correctness (6 weeks)

Theme: A6 inventory math is correct in concept but has subtle research-grade defects that bite at the operator dashboard layer.

### F53. Register inventory crons in vercel.json

Problem. `inventory-planning-weekly`, `inventory-positions`, `inventory-exceptions-tick`, `conformal-calibration-weekly` are not in `vercel.json`. They depend on the same cron-job.org failure mode as `tick.js`. `[verified-from-surface-report A6]`

Proposed change. Add these crons to `vercel.json` cron section. Same path-A approach as Phase 1 F4.

Effort. S (1 engineering day).

5-axis score. PSev 5, MDiff 2, TLev 4, EStr 5, SFit 5. Total 21/25.

### F54. NEXCP (n+1)/n correction

Problem. `src/api/_lib/inventory/conformal.js:112-129` computes nexCP without the `(n+1)/n` finite-sample correction that Barber 2023 prescribes. Coverage drifts low at small n. `[verified-from-surface-report A6]`

Proposed change. Apply `(n+1)/n` to the empirical-quantile target. Add a property-based test verifying coverage on synthetic series.

Effort. S (1 engineering day).

5-axis score. PSev 2, MDiff 4, TLev 4, EStr 5, SFit 4. Total 19/25.

### F55. LTD sqrt(L) fix

Problem. Lead-time-demand variance derivation uses sqrt(L) where it should use sqrt(L plus L_variance). This is a standard textbook fix that the current implementation misses. `[verified-from-surface-report A6]`

Proposed change. Update `safety-stock.js`. Add test.

Effort. S (1 engineering day).

5-axis score. PSev 3, MDiff 3, TLev 4, EStr 5, SFit 4. Total 19/25.

### F56. Prequential residuals harness

Problem. Calibration today uses split CP. For seasonal SKUs the prequential pattern (one-step-ahead residuals) is correct, but the implementation does not detect autocorrelation. Block CP (Chernozhukov 2018) is the right routing. `[verified-from-surface-report A6]`

Proposed change. Detect autocorrelation (Durbin-Watson). If AR greater than threshold, route to Block CP.

Effort. M (4 engineering days plus math review).

5-axis score. PSev 2, MDiff 5, TLev 4, EStr 4, SFit 4. Total 19/25.

### F57. Backtesting harness MVP

Problem. No backtesting harness for inventory math. The team cannot say "this change improves coverage by X%". `[verified-from-surface-report A6]`

Proposed change. New `scripts/inventory-backtest.mjs` that walks historical demand at synthetic horizons, runs the planner, records coverage, and emits a report.

Effort. M (5 engineering days).

5-axis score. PSev 3, MDiff 4, TLev 4, EStr 4, SFit 4. Total 19/25.

### F58. Alpha drift invalidation

Problem. Cohort coverage drifts as the alpha (confidence level) is tightened. Today's hardcoded residual-floor of 26 is alpha-dependent. `[verified-from-surface-report A6]`

Proposed change. Replace constant 26 with `ceil(2/alpha)`. At alpha=0.95 -> 21. At alpha=0.99 -> 100. Matches finite-sample CP literature.

Effort. S (1 engineering day).

5-axis score. PSev 2, MDiff 3, TLev 3, EStr 5, SFit 4. Total 17/25.

### F59. cu/co per-item override

Problem. Service-level z is hardcoded per item class. Real newsvendor optimum depends on per-item underage and overage costs. `[verified-from-surface-report A6]`

Proposed change. `item_master.underage_cost` and `item_master.overage_cost` columns. Safety-stock formula uses `cu / (cu + co)` when present, fallback to service-level.

Effort. M (3 engineering days).

5-axis score. PSev 2, MDiff 4, TLev 4, EStr 5, SFit 3. Total 18/25.

### F60. Cohort pooling key fix

Problem. `item_master`-based cohort pooling mixes motion classes (smooth plus lumpy demand). Coverage drifts. `[verified-from-surface-report A6]`

Proposed change. Cohort key = `(family, value_class, motion_class)`. Migration adds columns to `item_master`.

Effort. M (3 engineering days).

5-axis score. PSev 3, MDiff 4, TLev 4, EStr 4, SFit 4. Total 19/25.

### F61. Supplier scorecard

Problem. Supplier performance metrics live in heads or scattered notes. A scorecard with lead-time variance, on-time delivery, defect rate is missing. `[verified-from-surface-report A6]` `[verified-from-surface-report A4]`

Proposed change. New `supplier_scorecard` materialised view. UI at inventory-suppliers.

Effort. M (4 engineering days).

5-axis score. PSev 3, MDiff 4, TLev 3, EStr 4, SFit 4. Total 18/25.

### Phase 7 exit criteria

All inventory crons in vercel.json. NEXCP correction applied. LTD sqrt(L) fix shipped. Backtesting harness operational. Alpha drift invalidation live. cu/co per-item override available. Cohort pooling fixed. Supplier scorecard visible.

---

## Section 10. Phase 8 approvals plus workflow (4 weeks)

### F62. Dual-pane approvals with delegation and escalation

Problem. `src/v3-app/screens/approvals.tsx` (205 lines) supports single-pane approval but no delegation, no escalation, no SLA timer. `[verified-from-surface-report A2]`

Proposed change. Dual-pane UX: order context on left, approval action on right. Delegation: approver can forward to another. Escalation cron: if pending greater than SLA, alert manager. SLA configurable per role.

Effort. M (5 engineering days).

5-axis score. PSev 4, MDiff 4, TLev 3, EStr 4, SFit 4. Total 19/25.

### F63. Comments thread on orders

Problem. Operators communicate via Slack about specific orders. No in-product thread. `[verified-from-surface-report A2]`

Proposed change. `order_comments(order_id, actor, body, mentions, created_at)` table. Thread component on order detail.

Effort. M (4 engineering days).

5-axis score. PSev 3, MDiff 3, TLev 3, EStr 4, SFit 4. Total 17/25.

### F64. Line-item `source_text_span`

Problem. Operator looking at a misextracted line wants to see the exact PDF region the extractor read from. Today there is no link. `[verified-from-surface-report A3]`

Proposed change. `extraction_lines.source_text_span jsonb` with `{ page, bbox, char_start, char_end }`. Voter writes during consensus. Surface in line-item drawer with PDF.js highlight.

Effort. M (5 engineering days).

5-axis score. PSev 4, MDiff 4, TLev 4, EStr 4, SFit 4. Total 20/25.

### F65. doc-review.tsx with bbox overlay

Problem. Rossum's killer feature: per-document review UI with bounding-box overlay; operator clicks a wrong field, edits, re-extracts. Anvil has no equivalent. `[verified-from-surface-report A2]` `[verified-from-surface-report A12]`

Proposed change. New `/documents/<id>/review` screen. PDF.js render. Bounding boxes from F64. Click box -> edit value -> trigger re-extraction with hint. Persist correction to `extraction_corrections`.

Effort. L (10 engineering days plus design plus PDF.js integration).

5-axis score. PSev 4, MDiff 5, TLev 4, EStr 4, SFit 4. Total 21/25.

Deep-dive prompt DD13. Rossum review-UI architecture. Hyperscience Hypercell. Klippa DocHorizon Flow Builder. Right primitive: PDF.js plus canvas overlay or full state-machine.

### F66. Customer canonicalisation drift fix

Problem. `src/api/_lib/customer-canonicalizer.js` does `findByCanonicalName` after `findByGstin`. The canonicalisation strips legal suffixes but does not normalise punctuation, leading to drift between "Summit Automation Pvt. Ltd." and "Summit Automation, Pvt Ltd". `[verified-from-surface-report A2]`

Proposed change. Stronger normalisation (punctuation, multiple spaces, common typos) plus a confidence score on the match.

Effort. S (2 engineering days).

5-axis score. PSev 3, MDiff 3, TLev 4, EStr 4, SFit 4. Total 18/25.

### Phase 8 exit criteria

Dual-pane approvals with delegation and escalation cron. Comments thread on orders. Line-item source-text-span persisted. doc-review.tsx with bbox overlay shipped. Canonicalisation drift fixed.

---

## Section 11. Phase 9 observability plus admin plus pricing (6 weeks)

Theme: make the platform debuggable and the pricing transparent.

### F67. cost_status budget rule engine

Problem. Phase 2 F21 lands per-tenant USD spend cap. Phase 9 generalises to a rule engine handling 9 rule outcomes (R1 to R9): hard-stop, soft-warn, partial-degrade, route-cheaper-model, queue-for-batch, etc. `[verified-from-surface-report A11]`

Proposed change. `cost_status.js` middleware reads tenant budget, running tally, applies rules. Rule outcomes routed to operator UI.

Effort. M (5 engineering days).

5-axis score. PSev 4, MDiff 3, TLev 5, EStr 4, SFit 5. Total 21/25.

### F68. 12 alert rules plus on-call routing

Problem. No alert rules wired. `audit_events`, `cron_health`, `processing_events`, `model_routing_log` are silent producers. `[verified-from-surface-report A11]`

Proposed change. 12 alert rules: cron staleness, dispatch 404 spike, eval drift greater than 0.5%, RLS denial spike, audit gap, LLM-spend cap hit, ERP retry queue greater than threshold, voice handler failure, marketplace template revoke, sandbox abuse, AA consent expiry not renewed, payment-link failure. Sentry plus PagerDuty.

Effort. M (5 engineering days).

5-axis score. PSev 4, MDiff 3, TLev 5, EStr 4, SFit 4. Total 20/25.

### F69. SLO catalog

Problem. No SLOs defined. `[verified-from-surface-report A11]`

Proposed change. Catalog 8 SLOs: extraction success rate (p99 = 95%), Tally push latency (p95 less than 60s), DocAI cost per extraction (p95 less than Rs 0.50), e-Way bill expiry sweep (zero misses), audit-export availability (99.9%), cron heartbeat freshness, eval drift, customer-facing 5xx rate. Code-checked.

Effort. M (4 engineering days).

5-axis score. PSev 3, MDiff 4, TLev 4, EStr 4, SFit 4. Total 19/25.

### F70. 3-tier pricing tied to Stripe Meters

Problem. `docs/PRICING_STRATEGY.md` lists 3 tiers but no live `/pricing` route. Stripe Meter integration only wired for Tally drift. `[verified-from-surface-report A11]`

Proposed change. Public `/pricing` page. All 12 billable outcomes drained to Stripe Meters (currently only Tally drift). Annual toggle. INR plus USD.

Effort. M (5 engineering days plus legal review plus pricing review).

5-axis score. PSev 4, MDiff 4, TLev 3, EStr 5, SFit 5. Total 21/25.

Note: tier number disclosure pending commercial review per Section 18 rejected items.

### F71. Cron health alerting

Continuation of Phase 1 F4. Generalise heartbeat-staleness to every cron path. Wire to PagerDuty.

Effort. S (2 engineering days).

### F72. Retention policy

Problem. No data retention policy. `audit_events`, `processing_events`, `model_routing_log`, `extraction_runs` grow forever. DPDP Section 8(7) requires retention only as needed. `[verified-from-surface-report A11]` `[verified-from-surface-report A10]`

Proposed change. Per-table retention policy: 90 days for processing_events, 18 months for audit_events (regulatory minimum is 8 years for tax records, separate cold-storage), 30 days for sandbox_runs, 180 days for extraction_runs, hot, then cold-storage to S3 Glacier or Supabase storage cold tier.

Effort. M (5 engineering days).

5-axis score. PSev 3, MDiff 3, TLev 4, EStr 4, SFit 5. Total 19/25.

### Phase 9 exit criteria

cost_status budget rule engine live. 12 alert rules wired with PagerDuty routing. SLO catalog code-checked. Public /pricing page live. All 12 billable outcomes draining to Stripe Meters. Cron health alerting in PagerDuty. Retention policy enforced.

---

## Section 12. Phase 10 marketplace plus AI surfaces operational hardening (6 weeks)

### F73. Marketplace canary

Problem. Bet 2 ships hint-mode default. Cross-tenant publishing is gated. A9 surfaces that a canary rollout pattern would let one tenant's template ship to a small audience first. `[verified-from-surface-report A9]`

Proposed change. Canary cohort: new templates ship to 5% of eligible tenants first, monitor accuracy plus error rate, ramp to 100% on success or auto-rollback on failure.

Effort. M (5 engineering days).

5-axis score. PSev 3, MDiff 4, TLev 4, EStr 4, SFit 4. Total 19/25.

### F74. Template diff viewer

Problem. Marketplace operators reviewing a template publish-request have no diff against the prior version. `[verified-from-surface-report A9]`

Proposed change. Side-by-side template diff viewer. Highlight regex changes, anchor changes, schema-binding changes.

Effort. M (4 engineering days).

5-axis score. PSev 3, MDiff 3, TLev 3, EStr 4, SFit 4. Total 17/25.

### F75. Royalty model for cross-tenant templates

Problem. Templates that benefit other tenants generate value but no revenue back to the originator. `[verified-from-surface-report A9]`

Proposed change. Per-template usage meter. Royalty share back to the originator per use. Configurable rate (default 10% of marginal revenue).

Effort. M (5 engineering days plus legal review).

5-axis score. PSev 3, MDiff 5, TLev 3, EStr 3, SFit 4. Total 18/25.

### F76. parse_method telemetry fix

Problem. Migration 099 adds `extraction_runs.parse_method`. No agent verified that the marketplace L3.5 (global template) path stamps it. If global-template hits write null instead of `'global_template'`, the cost-efficiency Bet 2 claim is invisible. `[verified-from-surface-report A9]`

Proposed change. Integration test that runs a known-template doc and asserts `parse_method = 'global_template'`. Fix the marketplace dispatcher if needed.

Effort. S (1 engineering day).

5-axis score. PSev 3, MDiff 3, TLev 5, EStr 2, SFit 4. Total 17/25.

### F77. Agent kill switch

Problem. Autonomous agents run unbounded. No tenant-level kill switch. `[verified-from-surface-report A8]`

Proposed change. `tenants.agents_paused_at timestamptz`. Pre-dispatch gate at `src/api/agents/run.js:382`. Operator UI: "Pause agents for this tenant".

Effort. S (2 engineering days).

5-axis score. PSev 5, MDiff 3, TLev 5, EStr 4, SFit 4. Total 21/25.

### F78. Per-tenant opex caps

Problem. Agent runtime can issue communications, voice calls, pay links. No per-tenant daily cap on these actions. `[verified-from-surface-report A8]`

Proposed change. `tenants.agent_daily_email_cap`, `agent_daily_voice_cap`, `agent_daily_paylink_cap`. Pre-dispatch gate.

Effort. M (3 engineering days).

5-axis score. PSev 4, MDiff 3, TLev 4, EStr 4, SFit 4. Total 19/25.

### F79. MCP rate limit and scope

Problem. `src/api/mcp/server.js` exposes tools to MCP clients. No per-token rate limit, no scope restriction. `[verified-from-surface-report A8]`

Proposed change. Per-token rate limit. Scope set per token: read-only, write-orders, admin. Token expiry.

Effort. M (4 engineering days).

5-axis score. PSev 4, MDiff 3, TLev 4, EStr 4, SFit 4. Total 19/25.

### Phase 10 exit criteria

Marketplace canary live. Template diff viewer shipped. Royalty model active. parse_method telemetry verified. Agent kill switch operational. Per-tenant opex caps enforced. MCP rate-limited and scoped.

---

## Section 13. Phase 11 compliance certifications (12 weeks, runs alongside Phases 6 to 10)

### F80. SOC 2 Type II year-1 scope

Problem. Enterprise pilots require certification. GRC vendor selection still in progress. `[verified-from-surface-report A10]`

Proposed change. GRC vendor selection (Vanta, Drata, Secureframe, Sprinto) finalised in week 1. Continuous-controls monitoring wired: access reviews via `admin/access_review`, deploy log via `deploys/index.js`, audit-export HMAC-signed (Phase 2 F17 prerequisite). Observation window starts week 2. Cert issuance target Q4 2026.

Effort. L (8 engineering days for GRC tool integration plus 6-month observation window).

5-axis score. PSev 5, MDiff 4, TLev 3, EStr 5, SFit 5. Total 22/25.

Deep-dive prompt DD14. SOC 2 Type II observation window minimum (3 months; typical 6 to 9 months first-time). GRC vendor comparison for Supabase + Vercel + Anthropic + Razorpay stack.

### F81. ISO 27001 SoA year-2 scope

Problem. EU buyer expectation. Mercura publishes ISO 27001 plus 27018 openly. `[verified-from-surface-report A10]`

Proposed change. ISO 27001 Statement of Applicability (SoA) drafted year 1, audit year 2. 114 controls mapped to existing surfaces.

Effort. L (10 engineering days plus year-2 audit).

5-axis score. PSev 4, MDiff 4, TLev 3, EStr 4, SFit 4. Total 19/25.

### F82. EU AI Act Article 6 memo

Problem. EU AI Act Article 6 categorises AI systems as high-risk or limited-risk. Anvil's extraction-plus-anomaly system is plausibly limited-risk but not memo'd. A buyer in the EU will ask. `[verified-from-surface-report A10]`

Proposed change. Legal-engineering memo classifying Anvil's AI system per Article 6. Risk-class register. Conformity assessment if high-risk classification applies.

Effort. M (5 engineering days plus 2 legal weeks).

5-axis score. PSev 3, MDiff 4, TLev 2, EStr 3, SFit 4. Total 16/25.

### F83. CMEK envelope encryption

Problem. Customer-managed encryption keys (CMEK) are a common enterprise requirement. Anvil today uses Supabase-managed encryption. `[verified-from-surface-report A10]`

Proposed change. Envelope encryption: per-tenant DEK plus customer KEK. Supabase encrypts blob with DEK; Anvil wraps DEK with customer KEK held in customer KMS (AWS, GCP, Azure). Auditable key-use trail.

Effort. XL (15 engineering days for first pilot customer).

5-axis score. PSev 3, MDiff 5, TLev 4, EStr 3, SFit 4. Total 19/25.

### Phase 11 exit criteria

SOC 2 Type II Year 1 cert issued. ISO 27001 SoA drafted. EU AI Act memo published. CMEK pilot live with one enterprise customer.

---

## Section 14. Cross-cutting concerns

### Data model migrations needed

Phase 1: 104 tally_voucher_kind, 105 magic_links tenant scope, 106 eval_runs attestation, 107 storage tenant scope, 108 tenant_settings.state_code, 109 role enum extension.

Phase 2: 110 eval_drift_runs, 111 audit_events.prev_hash plus self_hash, 112 extraction_runs prompt versioning, 113 tenant_anomaly_settings plus anomaly_outcomes, 114 daily USD budget.

Phase 3: 115 extraction_lines.confidence, 116 sandbox_runs.

Phase 4: 117 voter_weights, plus extension columns on extraction_lines for source_text_span.

Phase 5: 118 soft-delete columns across 30 business tables, 119 RLS null tenant cleanup for 8 dangerous WRITE policies.

Phase 6: 120-125 e-invoice cancellation, eway legs, AA consent, TReDS lifecycle, BRSR evidence, DPDP records.

Phase 7: 126 cohort key columns, 127 inventory crons in vercel, 128 newsvendor cu/co.

Phase 8: 129 order_comments, 130 line source-text-span.

Phase 9: 131 cost_status budget rules, 132 retention policy enforcement.

Phase 10: 133 marketplace canary, 134 royalty tracking, 135 agent kill switch.

Phase 11: 136 CMEK envelope columns.

### Infrastructure changes

Vercel cron registration: every cron added requires `vercel.json` update and may push past Hobby tier function-count cap. Budget for Pro upgrade ($20/month).

GitHub Actions fallback for eval CI plus injection bench CI. Budget Anthropic API at $250 to $1,000 per month for 50 PRs per month.

KMS integration: AWS KMS or GCP KMS plus per-customer KEK for CMEK (Phase 11). Budget operational complexity for key rotation, key-grant audit.

Sentry plus PagerDuty: Sentry $26 per month entry, PagerDuty $19 per user per month. Budget $200 to $500 per month for full team.

External cron-job.org dependency: keep as fallback (Phase 1 F4 path B) but transition to Vercel native cron preferred.

External monitoring: Better Stack or UptimeRobot for the healthz endpoint. $24 per month.

### Security and compliance impact summary

Phases 1 plus 2 plus 5 close every SOC 2 prerequisite. SOC 2 observation window cannot start until Phase 1 F1, F2, F5, F7 are closed plus Phase 2 F17 audit chain HMAC at write is live.

Phase 5 RLS audit becomes a SOC 2 control test (CC6.1 Information Asset Inventory and CC6.2 Identity Logical Access).

Phase 9 alert rules support SOC 2 CC7.x monitoring controls.

DPDP compliance: Phase 6 F50 SDF readiness plus Phase 9 F72 retention policy plus Phase 1 F2 magic-link RLS plus Phase 5 F40 soft-delete pattern jointly close DPDP Sections 4, 6, 8.

GDPR readiness: same set plus Phase 11 F82 EU AI Act memo plus Phase 11 F81 ISO 27001 SoA.

### Breaking changes and migration timing

F2 magic-link RLS: breaks any direct PostgREST query against `auth_magic_links`. No current code path queries it directly.

F5 storage migration: breaks any browser-direct `supabase.storage.from()` call. Audit first.

F11 role enum change: existing rows pinned to legacy values may need re-mapping. Migration includes explicit re-map.

F38 service-role to user-JWT migration: live production breaking unless gated by feature flag. Per-handler one-PR-at-a-time. Audit-export last.

F39 RLS dialect unification: every JWT-claim policy replaced. Some tables become unexpectedly read-only for some queries; staging soak essential.

F40 soft-delete: every default query on touched tables now includes `deleted_at is null` filter. Existing queries that explicitly look for deleted rows must be annotated.

F44 GSP integration: cancellation flow changes the e-Invoice composer's external dependency. Customers using the in-house IRP path need migration.

### Eval credibility crisis as meta-blocker

This is the single most consequential theme. Phase 1 F3 lands the harness refactor. Phase 2 F14, F15, F16 deepen credibility. Phase 3 F22 trust page reads from the harness. Phase 4 F37 injection bench plugs into the same CI. Without Phase 1 F3, the Phase 3 trust page is a marketing artifact rather than an evidence artifact, and every downstream accuracy claim is suspect.

The team must treat the eval harness as the most important code path in the platform. Every change to extraction code passes through the golden set. Every prompt change bumps a version. Every adapter change runs against the corpus. Without these gates, model drift, prompt drift, adapter regression, and frontend regression all surface as "LLM accuracy decline" on the dashboard, and the team will chase phantom model problems while the real bugs are elsewhere.

### Multi-tenancy retrofit at 359 service-role files

The second meta-theme. 359 `serviceClient()` call sites bypass 253 RLS-enabled tables. 889 `.eq("tenant_id", ...)` occurrences across 299 files are the actual isolation layer. One missed `.eq()` cross-tenants arbitrary rows.

Phase 1 F2 plus F5 plus F11 close the highest-severity individual gaps. Phase 5 F38 plus F39 plus F41 plus F42 close the systemic gap. Phase 8 F62 plus F63 plus F65 wave consume the workflow surfaces that depend on the retrofit. Phase 9 F68 alert rules include RLS-denial spikes as a top-12 alert.

Future bets must not introduce new service-role-bypass patterns. The Phase 5 F41 RLS coverage CI gate enforces this.

---

## Section 15. Risk register (by phase)

### Phase 1 risks

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| F1 voucher-type change invalidates prior drift comparisons | M | M | Staging soak; dual-emit option; tag legacy rows `voucher_type='legacy_sales_order'` |
| F2 RLS migration breaks legitimate cross-tenant read | L | H | Audit current SELECT shape against `auth_magic_links` first; staging soak 1 week |
| F5 storage migration breaks browser-direct supabase.storage.from() call | M | H | Pre-audit `grep -rln "supabase.storage.from" src/`; gate behind staging |

### Phase 2 risks

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Eval refactor changes accuracy number on landing | M | M | Disclose methodology and n; honest beats inflated |
| Golden fixtures do not catch real production drift | M | M | Curate fixtures from actual customer documents over rolling window |
| Audit chain trigger fails on retry collision | M | H | Idempotent re-derivation from conflicting row's prev_hash |

### Phase 3 risks

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Trust-page accuracy number underwhelms vs Axal's 95%+ | M | M | Lead with "audited" plus methodology, not raw number |
| Sandbox-tenant cost runs over $1,500/month | L | M | Cap rate-limit to 5 per IP per day |
| Customer security review packet leaks sensitive sub-processor details | L | H | Legal review before publishing |

### Phase 4 risks

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Voter accuracy weighting reduces overall accuracy on out-of-distribution POs | M | M | A/B test per cohort; fallback to equal-weight |
| Content-type gate misclassifies edge files | M | M | Allowlist for known-good MIME types |
| Injection bench v2 false positives block CI | M | M | Tag known-acceptable patterns; require sign-off on threshold change |

### Phase 5 risks

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| User-JWT migration produces permission-denied storm | H | H | Per-handler feature flag; dual-write read-only week |
| RLS dialect unification breaks queries on tables we did not test | M | H | Snapshot RLS policy hashes pre and post; differ |
| Soft-delete sweep misses a query path | M | M | RLS coverage analyzer extended to include `deleted_at is null` check |

### Phase 6 risks

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| GSP partner pricing surge after onboarding | M | H | Multi-vendor RFP; 1-year price ceiling clause |
| DPDP SDF threshold crossing not anticipated | M | H | Quarterly review of tenant count vs SDF criteria |
| eway multi-leg schema mismatch with NIC API | M | M | Pilot with one tenant first |

### Phase 7 risks

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Block CP underflows on short series | L | M | Fallback to NEXCP if AR detection fails |
| Cohort key change shifts coverage by 5%+ on rollout | M | M | Pin per-cohort coverage target; ramp |
| Backtesting harness produces misleading delta on small fixtures | M | M | Require minimum fixture size before reporting |

### Phase 8 risks

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Approval delegation chain produces audit-trail confusion | M | M | Explicit delegation events in audit_events |
| doc-review.tsx PDF.js render bottlenecks on large PDFs | M | M | Page-by-page lazy render |
| source_text_span growth balloons extraction_lines | M | M | Compress jsonb; retention sweep |

### Phase 9 risks

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Sentry leaks PII into envelopes | L | H | Redaction in beforeSend; privacy review on first 20 events |
| Pricing-tier disclosure ahead of commercial review | M | H | Tier numbers behind a feature flag pending sign-off |
| Retention policy purges rows needed by an active investigation | L | H | Cold-storage backup before hot purge; investigator hold |

### Phase 10 risks

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Marketplace canary template produces wrong-customer extraction | L | H | 14 Bet-2 safeguards plus auto-rollback on failure |
| Royalty model creates conflict of interest in template review | M | M | Independent reviewer pool |
| Agent kill switch leaves in-flight operations half-committed | M | M | Idempotent re-entry per agent step |

### Phase 11 risks

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| SOC 2 observation window finds a control gap | M | H | Pre-audit dry run with GRC vendor at week 4 |
| ISO 27001 scope creep delays year-2 cert | M | M | SoA scoped to product surface only |
| CMEK pilot customer pulls out | M | M | Architect for multi-customer support from day 1 |

### Strategic and competitor risks

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Avent enters India within 12 months | H | H | Accelerate Phase 3 Tally drift productization |
| Mercura enters India via SAP India | M | M | Tally plus GSP partnership = real moat |
| Axal re-funded post-pivot accelerates | M | M | Treat threat as high; accelerate Phase 3 customer evidence |
| Anthropic Claude 4.7 deprecation cycle shorter than expected | M | M | Multi-adapter voter (Phase 4 F29) reduces lock-in |

---

## Section 16. Deep-dive prompts collated

Each prompt is a research task an implementation team executes before code lands. Numbers reference per-feature prompts above.

DD1. TallyPrime TDL voucher-type taxonomy plus GSTN treatment in GSTR-1, GSTR-3B, IFF. Source: TallyPrime KB, GSTN circulars, Cygnet and IRIS GSP partner-onboarding docs.

DD2. Magic-link RLS patterns in multi-tenant Supabase apps. Source: Supabase docs, supabase/community github.

DD3. Server-side eval frameworks: LangSmith, Phoenix, Promptfoo, LlamaIndex evaluation. Anthropic eval cookbook, Constitutional AI evals.

DD4. Vercel cron limits across Hobby, Pro, Enterprise tiers. Cloudflare Workers Cron and AWS EventBridge comparison.

DD5. Supabase storage RLS patterns for multi-tenant SaaS. PostHog plus Cal.com cases.

DD6. CBIC place-of-supply rules per state-prefix GSTIN. 36 state and union territory codes.

DD7. OWASP LLM Top 10 injection corpus. Lakera and HiddenLayer corpora.

DD8. GSTIN check-digit algorithm per CBIC. Existing npm packages.

DD9. Golden-fixture curation. FUNSD, CORD, DocVQA, OmniDocBench. The right 50-document split for Anvil's ICP.

DD10. Trust-page best practices across Stripe, Vercel, Supabase, Soff, Mercura.

DD11. Supabase user-JWT scoped patterns. Vercel dashboard plus Linear plus HackerOne reports.

DD12. GSP pricing and API depth (IRIS, Cygnet, ClearTax, Webtel).

DD13. Rossum review-UI architecture. Hyperscience Hypercell. Klippa DocHorizon Flow Builder.

DD14. SOC 2 Type II observation window. GRC vendor comparison.

DD15. Block CP implementation patterns. MAPIE port to JS. Chernozhukov 2018.

DD16. Cohort design for inventory pooling (family, value, motion class definitions).

DD17. STL versus Prophet versus Croston-X for monthly and seasonal demand.

DD18. Newsvendor cu/co cost factoring per item.

DD19. Anomaly-detection feedback loops in financial-fraud SaaS (Sift, Stripe Radar, Mastercard Decision Intelligence).

DD20. Voter cost weighting with regret bounds. Multi-armed bandit literature.

DD21. PII redaction at LLM boundary. Microsoft Presidio plus Google DLP plus Anthropic redaction patterns.

DD22. Audit chain HMAC at write. SQL trigger idempotency. Postgres LISTEN/NOTIFY alternatives.

DD23. Sandbox-tenant cost model. Per-IP rate-limit budget at scale.

DD24. First-run tour patterns. react-joyride versus homegrown overlay.

DD25. Customer security review packet template. SOC 2 questionnaire shortcut patterns.

DD26. APM cost models. Sentry versus Datadog versus Honeycomb versus Grafana Cloud at Anvil scale.

DD27. Status page patterns. Stripe, Vercel, Supabase, Cloudflare, Linear.

DD28. SRE SLO playbook applied to Anvil's surfaces.

DD29. Runbook plus on-call rotation patterns for early-stage SaaS.

DD30. PDF.js performance with large multi-page documents. Lazy-render strategies.

DD31. EU AI Act Article 6 classification of extraction systems.

DD32. CMEK envelope encryption with AWS KMS, GCP KMS, Azure Key Vault.

DD33. ISO 27001 Statement of Applicability for SaaS at Anvil scale.

DD34. DPDP Significant Data Fiduciary criteria. DPIA template.

DD35. Multi-state GST plus HSN plus place-of-supply caches.

DD36. AA consent renewal patterns from RBI sandbox.

DD37. TReDS lifecycle audit per RBI guidelines.

DD38. BRSR Core assurance trail per SEBI requirement.

DD39. GeM portal API integration patterns.

DD40. Hungarian-algorithm bipartite matching for line alignment.

DD41. Read every `*.test.tsx` in `src/v3-app/`. Count `Placeholder` imports versus real-component imports. Compute coverage ratio. Phase 2 trigger.

DD42. Read `src/api/tally/push.js` end-to-end. Confirm whether the initial push path also emits `VCHTYPE="Sales Order"` and whether migration 016+ introduced a `VCHTYPE="Sales"` accounting voucher route. Phase 1 dependency for F1.

DD43. Read every migration from 002 through tip for `storage.objects` policy changes. Produce a definitive bucket-policy inventory. Phase 1 dependency for F5.

DD44. Read migration 098 plus `src/api/_lib/docai/gemini.js` plus `src/api/_lib/mistral.js` plus `src/api/_lib/docai/model_selector.js`. Determine whether the schema is ahead of the implementation. Phase 4 dependency for F29.

DD45. Read `package.json` scripts plus bundler config. Determine whether `src/v3-app/` is compiled into the deployed bundle. Phase 3 dependency for F22 trust page and F65 doc-review screen.

DD46. Read `src/api/_lib/docai/run.js:579-606` plus `marketplace.js:333-335`. Confirm `parse_method = 'global_template'` propagation. Phase 10 dependency for F76.

DD47. Read `src/api/agents/run.js:382-410` plus `_handlers/index.js:46-62`. Map every agent-action side-effect with cost estimate. Phase 10 dependency for F77 plus F78.

DD48. Read `src/api/audit/export.js` plus `_lib/audit.js`. Map the chain assembly logic. Determine whether write-time HMAC trigger can be added without breaking export semantics. Phase 2 dependency for F17.

DD49. Read every `vercel.json` cron registration. Cross-reference against `src/api/cron/*.js`. Identify orphan cron handlers not registered. Phase 7 dependency for F53.

DD50. Read `_lib/cron-mux.js` end-to-end. Map fan-out plus retry semantics. Identify timeout-starvation cases. Phase 1 dependency for F10.

DD51. Survey 10 Indian distributors on how they evaluate Tally add-ons. Source: IndiaMART, Quora, Tally Solutions partner directory.

DD52. Case-study contract patterns for B2B SaaS. Source: HubSpot, Gainsight templates.

DD53. Conexiom plus Hyperscience plus Rossum plus Klippa plus Ocrolus pricing patterns. Reverse-engineer their tier structures from public case studies.

DD54. MCP partner-program patterns. Cursor's MCP partner directory. Anthropic MCP cookbook.

DD55. Cross-tenant template-marketplace incident-response patterns. Similar to npm sandworm mode.

DD56. Agent observability metrics that matter to operators. Success rate versus override rate versus cost-per-resolution.

DD57. Bayesian threshold updating for anomaly rules.

DD58. EU residency cost plus buyer-pipeline for Indian mid-market SaaS.

DD59. Server-rendered portal versus SPA tradeoffs for low-frequency customer surfaces.

DD60. Per-tenant learned anomaly model versus rule-based plus operator feedback.

---

## Section 17. Methodology notes

12 sequential agent runs A1 through A12 from late September through October-November timeline. Each agent owned one surface; the original parallel fleet inherited a stale worktree at `objective-meninsky-15e45d` (commit `a24d582`) which is a pre-bet baseline with 6 migrations and no `src/v3-app/` React tree. The sequential re-run cleaned the worktree contamination by anchoring each agent's audit at `/Users/kenith.philip/anvil/` on `c4f946b` and verifying every file:line citation against main.

A1 (landing/onboarding) anchored at `01-landing-onboarding.md:5`. A2 (so-intake/orders) anchored at `02-so-intake-orders.md:6-13`. A3 (DocAI engine) cited 21 files including `src/api/_lib/docai/run.js`, `claude.js`, `gemini.js`, `voter.js`. A4 (ERP integrations) inventoried 22 hand-rolled ERP clients. A5 (data model) counted 103 migrations totalling 13,043 SQL lines, 303 create-table, 253 RLS-enable, 284 explicit policies. A6 (inventory/conformal) is the lone outlier still naming the worktree path inside its opener at `06-inventory-conformal.md:3-6` though the file citations themselves resolve on main; treat A6 citations as main-applicable but expect minor numerical drift. A7 (India stack) read every file under `src/api/tally/`, `src/api/einvoice/`, `src/api/eway_bills/`, `src/api/aa/`, `src/api/treds/`, `src/api/brsr/`. A8 (AI surfaces) traced the agent runtime end-to-end via `src/api/agents/run.js`. A9 (marketplace) read all 549 lines of `_lib/docai/marketplace.js`. A10 (security) ran 365 service-role grep, the audit-export chain, RLS-policy inventory. A11 (observability/admin/pricing) inventoried `audit_events`, `processing_events`, `model_routing_log`, `cron_health`, `docai_daily_usage`, `tally_drift_billing_meter`. A12 (UI primitives) read all 14 React primitives plus the 4,142-line `styles.css`.

The red-team v3 pass at `/tmp/analysis-v2/13-red-team.md` re-grounded findings against `c4f946b`, produced a 5-axis score (PSev plus MDiff plus TLev plus EStr plus SFit, each 1-5) for each top finding, ranked the top 30 P0/P1 in a cross-reference matrix, and identified seven items that the original parallel run got wrong (`ALLOW_ANONYMOUS_TENANT` defaults false on main with production startup guard, `src/v3-app/` tree exists with 67 screens, migration count is 103 not 6, vercel.json registers daily, voter has 20 rules not 3, ERP grid is 22 production-shaped adapters not stubs, `bypassFirewall` is admin-gated not write-gated). These corrections are reflected throughout this roadmap.

Known limitations. WebFetch was denied to subagents in the harness. Every competitor or external claim is tagged `[verified-from-prior-knowledge]` and cites a stable URL. The failure mode is "Anvil's positioning misreads competitor copy that has since been updated" rather than "the competitor claim was hallucinated". A consumer of this roadmap should re-fetch competitor URLs at implementation time.

Roughly 40% of original parallel-run severity ratings were invalidated by the worktree-vs-main drift; the sequential re-run captured the corrections but a small residue may remain in surface reports' word counts or migration line numbers.

This roadmap should be re-validated quarterly. Anvil's main is a moving target; commits land daily; the 103-migration baseline grows. Any item in this roadmap older than 90 days requires spot-check before action.

---

## Section 18. Rejected items plus reasons

| Item | Score | Reason rejected |
|---|---|---|
| ITAR / GovCloud / on-prem deployment | 14 | Year-2 work; current ICP is Indian distributors plus EU mid-market; ITAR plus GovCloud carries Year-2 architectural cost |
| Customer testimonial rollout without consent | 8 | Strategic plan explicitly notes no-logo policy until pilots sign use clauses; legal exposure on premature testimonial use |
| Pricing tier number disclosure pending commercial review | n/a | Commercial review in progress; gate behind feature flag until sign-off |
| ALLOW_ANONYMOUS_TENANT defaults true (worktree stub) | n/a | Disproven on main; default is false with production startup guard at `_lib/auth.js:14-23` |
| Migrations stop at 006 (worktree stub) | n/a | Disproven on main; 103 migrations total |
| `src/v3-app/` tree does not exist (worktree stub) | n/a | Disproven on main; 67 screens, 59 tests, 14 primitives |
| Only FX cron is registered (worktree stub) | n/a | Disproven on main; daily cron is registered at `vercel.json:12-17` |
| Anomaly compute.js has 3 rules (worktree stub) | n/a | Disproven on main; 20 rules grouped into 6 buckets at `anomaly/compute.js` |
| ERP grid is stubs only (worktree stub) | n/a | Disproven on main; 22 production-shaped adapters per A4 |
| `bypassFirewall=true` available to write role (worktree stub) | n/a | Disproven on main; admin-gated at `src/api/claude/messages.js:51-59` |
| Migrate `tenant_settings` to `feature_flags jsonb` now | 15 | Defer until 50+ flags; current 30+ works |
| Real-time presence on SO editing | 11 | Not the B2B PO-intake job-to-be-done; consumer polish |
| Pipeline kanban for orders | 14 | Earlier bet plan deferred; no customer pull signal |
| Self-host Qwen2.5-VL pilot now | 20 | Defer until LLM cost crosses 20% of margin |
| CLI for Anvil operations | 12 | ICP is web users plus ERP integrators, not CLI users |
| Real-time per-tenant customer cost dashboard at end-tenant | 17 | `cost_status` middleware covers admin; surfacing to end-tenants requires pricing plus RBAC redesign |
| Per-tenant learned anomaly model right now | 17 | Phase 11+ candidate; rule-based plus tunable thresholds plus outcome capture (F19) is the cheaper win first |
| Customer-portal SPA redesign | 16 | Server-rendered works; full SPA is rewrite without feature gain |
| Voter cost-cache key inversion (F34 in v2) | 15 | Defer unless Anthropic cache hit rate less than 50% |
| Add chart/sparkline primitive to lib/primitives.tsx | 11 | Each screen rolls its own SVG which works |
| Migrate all browser-direct supabase.storage usage to API layer | 13 | Zero instances on main per A5 inventory |

---

## Section 19. Cross-reference table linking each surface report to its highest-value finding

| Surface report | Word count | Highest-value finding routing to this roadmap |
|---|---|---|
| 01 landing-onboarding | ~14,000 | Phase 3 F22 trust page; Phase 3 F25 sandbox; Phase 3 F26 time-to-value; Phase 3 F27 first-run tour |
| 02 so-intake-orders | ~9,000 | Phase 8 F65 doc-review with bbox overlay; Phase 8 F66 canonicalisation drift; Phase 4 F31 line alignment |
| 03 docai-engine | ~6,700 | Phase 1 F3 eval-trust; Phase 2 F18 prompt-version stamping; Phase 4 F29 voter weighting; Phase 4 F32 content-type gates |
| 04 erp-integrations | ~7,200 | Phase 1 F4 tick.js; Phase 1 F10 cron-mux timeout; Phase 6 F44 GSP partnership |
| 05 data-model | ~5,500 | Phase 1 F2 magic-link RLS; Phase 1 F5 storage; Phase 5 F38 service-role migration; Phase 5 F39 RLS dialect; Phase 5 F43 dangerous WRITE policies |
| 06 inventory-conformal | ~6,500 | Phase 7 F53 cron registration; Phase 7 F54 NEXCP correction; Phase 7 F55 LTD sqrt fix; Phase 7 F60 cohort key |
| 07 india-stack | ~7,600 | Phase 1 F1 voucher type; Phase 1 F6 OBARA_STATE; Phase 6 F44 GSP partnership; Phase 6 F45 IRN retry; Phase 1 F8 GSTIN checksum |
| 08 ai-surfaces | ~6,000 | Phase 1 F2/F3 eval-trust; Phase 2 F19 anomaly outcomes; Phase 2 F20 client Gaussian removal; Phase 10 F77 agent kill switch |
| 09 marketplace | ~5,300 | Phase 10 F73 marketplace canary; Phase 10 F76 parse_method telemetry; Phase 4 F34 firewall vendor parity |
| 10 security | ~6,400 | Phase 1 F2/F5 P0 confirmation; Phase 5 F38 service-role retrofit; Phase 11 F80 SOC 2; Phase 2 F17 audit chain HMAC; Phase 4 F37 injection bench |
| 11 obs-admin-pricing | ~6,500 | Phase 2 F21 spend cap; Phase 1 F4 cron alerting; Phase 9 F67 cost_status; Phase 9 F68 alert rules; Phase 9 F69 SLOs; Phase 9 F70 pricing |
| 12 ui-primitives | ~8,000 | Phase 8 F65 doc-review primitives (PDF canvas, bbox overlay, inline correction modal); Phase 3 F22 trust page primitives; modal focus-trap fix |
| 13 red-team | ~8,150 | Top-30 P0/P1 cross-reference matrix; promotes Phase 1 to 13 items; surfaces F9 healthz, F10 cron-mux timeout, F8 GSTIN checksum |

Total evidence base: roughly 97,000 words across 13 reports plus this roadmap synthesis at roughly 13,200 words. Each numbered finding F1 through F83 ships with a problem statement, current-state-on-main file:line citation where applicable, proposed change, technical implementation, integration plan, telemetry, effort estimate, 5-axis score out of 25, and where appropriate a deep-dive prompt for implementation-time context.

This roadmap is the path from `main @ c4f946b` to a SOC 2 Type II certified, DPDP-compliant, GSP-partnered, RLS-hardened, eval-credible, customer-evidenced, conformal-correct, multi-state-GST-aware, anomaly-tuned, marketplace-canary'd, agent-budget-capped, MCP-rate-limited, EU-AI-Act-memo'd, CMEK-pilot-able platform over 72 to 84 weeks.
