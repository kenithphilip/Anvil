# Product Deep Dive, May 2026

Comprehensive multi-agent audit of Anvil grounded against `main @ c4f946b`. Each surface file benchmarks the current implementation against competitors, OSS analogues, frontier-lab patterns, research papers, and authoritative regulatory sources, then identifies value-adding gaps with proposed implementations, integration plans, telemetry, effort estimates, and follow-up deep-dive prompts.

## Run summary

- Path of record: `/Users/kenith.philip/anvil/` on `main @ c4f946b`.
- Methodology: 12 sequential surface agents (one per cluster), then a red-team adversarial pass, then a synthesis layer producing the phased implementation roadmap.
- Aggregate: ~230,000 words, ~393 surface-level findings consolidated into 83 numbered roadmap items (F1 to F83) and 60 deep-dive research prompts (DD1 to DD60).
- Tagging convention used throughout: `[verified-on-main]`, `[verified-from-surface-report]`, `[verified-from-prior-knowledge]`, `[inferred]`, `[speculative]`.
- Style: no emojis, no em or en dashes (commas, colons, periods, parentheses only).

## File map

| File | Surface | Words | Findings | Notes |
|---|---|---|---|---|
| [01-landing-onboarding.md](01-landing-onboarding.md) | Landing, signin, onboarding, passkey, TOTP, magic link, trust page | ~13,000 | 25 (F1.1 to F1.25) | New: format-guide as public surface, advanced-toggle paint flash, magic-link callback as static HTML |
| [02-so-intake-orders.md](02-so-intake-orders.md) | SO intake, orders, approvals, customer match, secondary parties | ~15,376 + appendix | 22 (F2.1 to F2.22) | New: canonicalisation drift (13 vs 9 patterns), approval delegation + escalation cron, doc-review screen, line-item source_text_span |
| [03-docai-engine.md](03-docai-engine.md) | DocAI extraction, parser, voter, prompts, evals, firewall, redaction | ~11,673 | 20 (F3.1 to F3.20) | Bet 1 + Bet 4 confirmed live on main; flagged content-type gate, truncated_close, utf8 fallback, textual-only injection firewall |
| [04-erp-integrations.md](04-erp-integrations.md) | 22 ERP clients, Tally, e-invoice, eway-bills, EDI, channels | ~28,000+ | 53 (F4.1 to F4.53) | Verified on main: amend.js VCHTYPE still broken, tick.js not in vercel.json, email HMAC missing, 22 client files confirmed |
| [05-data-model.md](05-data-model.md) | Migrations, RLS, multi-tenancy, audit chain, soft-delete | ~11,000 | 27 (F5.1 to F5.27) | 359 serviceClient sites, 889 .eq("tenant_id"), 45 tenant_id-is-null OR policies, ALLOW_ANONYMOUS now defaults false |
| [06-inventory-conformal.md](06-inventory-conformal.md) | Inventory planning, conformal prediction, safety stock, supplier scoring | ~13,187 + backtest spec | 58 (F6.1 to F6.58) | Inventory crons NOT in vercel.json, LTD sqrt(L) bug, cu/co absent from UI, cron heartbeats unsigned |
| [07-india-stack.md](07-india-stack.md) | Tally, GST e-invoice, eway, AA, TReDS, BRSR, DPDP | ~10,692 + appendix | 38 (F7.1 to F7.38) | amend.js VCHTYPE still wrong, OBARA_STATE hardcoded, GSTIN checksum absent, AA/TReDS UAT-only, e-invoice retry queue absent |
| [08-ai-surfaces.md](08-ai-surfaces.md) | Anomaly, autonomous agents, MCP, voice AI, prospecting | ~14,600 | 40 (F8.1 to F8.40) | 20 anomaly rules confirmed, Gaussian dup in build-unified-app.mjs:962-988 still present, MCP server exposed, no kill switch, no opex caps |
| [09-marketplace.md](09-marketplace.md) | Bet 2 template marketplace, redaction, regex-safety, k-anonymity | ~11,000+ | 31 (F9.1 to F9.31) | 9 of 14 safeguards inline, IFSC not redacted, k-anonymity hardcoded 5, no global kill switch, L3.5 parse_method not stamped, no royalty model |
| [10-security.md](10-security.md) | Auth, RLS, audit chain, prompt-injection firewall, SOC 2 / ISO 27001 / DPDP readiness | ~21,300 | 31 (F10.1 to F10.31) | bypassFirewall admin-gated, HMAC at export only, no TOTP recovery codes, secrets not KMS-backed, EU AI Act 3 months out |
| [11-obs-admin-pricing.md](11-obs-admin-pricing.md) | Observability, admin, pricing meters, SLOs, alerting | ~10,400 | 20 (F11.1 to F11.20) | 4 P0: cost-status budget rule engine, SLO absence, 12 alert rules absent, cron fallback. 3-tier pricing matrix |
| [12-ui-primitives.md](12-ui-primitives.md) | Primitives, modals, tables, a11y, dark theme, CmdK | ~12,000 | 28 (F12.1 to F12.28) | Placeholder false-positive disproven (0 of 59 imports), 16 primitives, a11y gaps on 3 sampled screens, dark theme user-toggle only |
| [13-red-team.md](13-red-team.md) | Adversarial pass across the 12 surface reports | ~8,149 | top-30 P0/P1 matrix | bypassFirewall reclassified as admin-only; ALLOW_ANONYMOUS resolved; F1, F2, F3, F4, F5 all confirmed persistent |
| [14-final-roadmap.md](14-final-roadmap.md) | Phased implementation roadmap synthesis | ~14,976 | F1 to F83 + DD1 to DD60 | 11 phases, 19 sections, cross-cutting concerns, risk register, methodology, rejected items, cross-reference table |

## Top 5 persistent P0 findings on main

1. **F1** Tally `VCHTYPE = "Sales Order"` at `src/api/tally/amend.js:46` and legacy callers feeding `push.js:65`. GST returns will not populate from Anvil data on amendments of all 9 non-SalesOrder voucher types.
2. **F2** `auth_magic_links` RLS leak at `supabase/migrations/003_studio_ocr_fx_inventory_lead.sql:241`. Cross-tenant email, IP, user-agent exposure via PostgREST.
3. **F3** Eval-trust caller-supplied actuals at `src/api/eval/run.js:21-22`. Meta-blocker for every public accuracy number.
4. **F4** `vercel.json:12-17` registers only `/api/cron/daily`. `tick.js`, inventory crons, drift cron, conformal calibration all silent without cron-job.org.
5. **F5** Storage bucket policy at `supabase/migrations/001_init.sql:480-483` allows any authenticated user to read any tenant document.

## Severity downgrades vs prior synthesis

- `bypassFirewall` flag at `src/api/claude/messages.js:54-59`: was P0, now P2. Already admin-gated on main; removal still warranted but not production-bleeding.
- `ALLOW_ANONYMOUS_TENANT`: was P0 candidate, **resolved on main** with `"false"` default plus production startup guard.
- Placeholder-test stub coverage (prior F56 in v2 roadmap): **disproven**. 0 of 59 test files import `placeholder.tsx`; the real CI gap is auto-generated 29-line smoke tests (F12.5).

## Highest-leverage new findings

- **F8.37** operator-controlled agent kill switch (5-axis score 25 of 25, highest in fleet)
- **F10.27** EU AI Act Article 6 classification: high-risk obligations live 2 Aug 2026
- **F11.1 + F8.40** per-tenant opex caps absent; misconfigured tenant can burn $565+/day at Opus rates with no upper bound
- **F6.12** inventory crons code exists but never runs in production until `vercel.json` is patched
- **F9.27** marketplace adversarial template (prompt injection through L3.5 hint values) not blocked
- **F7.36 + F10.28** DPDP Significant Data Fiduciary readiness gap

## Limitations and caveats

- `WebFetch` was denied to subagents during this run. Competitor and research citations are tagged `[verified-from-prior-knowledge]` with the source URL preserved inline so a follow-on session can re-ground them with real external reads.
- The first parallel agent run hit usage limits across most agents. The sequential re-run captured here is the canonical pass.
- Some surface reports still carry minor residual references to the prior worktree slug (`a24d582`). The red-team pass and the roadmap synthesis re-anchor all citations to `/Users/kenith.philip/anvil/` on `c4f946b`.
- Synthesis-layer scoring uses a 5-axis rubric (PSev or user-pain, MDiff or market-differentiation, TLev or technical-leverage, EStr or evidence-strength, SFit or strategic-fit), each 1 to 5, total out of 25.

## How to read the roadmap

Start with `14-final-roadmap.md` section 1 (executive summary) and section 2 (phase plan overview). Each subsequent section covers one phase with per-feature specs (problem, current state on main, proposed change, technical implementation, integration plan, telemetry, effort, 5-axis score, deep-dive prompt). Use the cross-reference table in section 19 to jump from a surface report finding back to the roadmap item that integrates it.
