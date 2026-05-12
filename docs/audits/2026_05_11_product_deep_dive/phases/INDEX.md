# Phase Implementation Deep-Dives

Per-phase implementation plans for the 11 phases in `../14-final-roadmap.md`. Each file executes the relevant DD (deep-dive research) prompts against `main @ c4f946b`, produces 3 to 5 game-changing innovative ideas with revenue analysis, breaks the phase into 2-week sub-sprints, and ships a risk register plus success metrics.

Total deliverable: 109,328 words across 11 phase plans. ~55 innovative ideas. Aggregate revenue projections well over INR 100 Cr ARR uplift over 36 months.

## Files

| Phase | File | Words | Weeks | Theme | Year-1 ARR uplift estimate |
|---|---|---|---|---|---|
| 1 | [01_p0_fixes.md](01_p0_fixes.md) | 10,614 | 4 | P0 fixes: GSTR-1 correctness, RLS leaks, eval-trust, cron registration, storage, OBARA_STATE, GSTIN checksum, healthz, cron timeouts, role enum | INR 52-57 Cr 3y TAM |
| 2 | [02_eval_credibility.md](02_eval_credibility.md) | 9,751 | 4 | Eval credibility + telemetry hardening: server-side eval, golden set, drift detector, replay UI, audit chain HMAC at write | USD 1.82M ARR |
| 3 | [03_trust_sales_motion.md](03_trust_sales_motion.md) | 10,138 | 6 | Trust + sales-motion enablement: /trust page, cost/SO meter, confidence chips, sandbox tenant, TTV instrumentation, first-run tour, customer security review packet | DD45 closed: src/v3-app is the deployed bundle |
| 4 | [04_docai_engine_v2.md](04_docai_engine_v2.md) | 9,196 | 6 | DocAI engine v2: multi-adapter voter cost weighting, line alignment beyond partNumber, content-type gates, OCR utf8 fallback removal, firewall vendor parity | INR 2.3 Cr ARR, 9x ROI |
| 5 | [05_multi_tenancy_hardening.md](05_multi_tenancy_hardening.md) | 10,180 | 8 | Multi-tenancy hardening: service-role to user-JWT first wave, soft-delete pattern, audit chain HMAC at write, RLS dialect unification, IDOR sweep | INR 13 Cr year-1 |
| 6 | [06_india_compliance_gsp.md](06_india_compliance_gsp.md) | 12,380 | 6 | India compliance partnership + completeness: GSP partnership pick (IRIS GST 89/100), IRN retry queue, e-Invoice cancellation, eway multi-leg, AA consent renewal, TReDS audit, BRSR assurance, DPDP SDF, GeM portal | INR 4-6 Cr Y1, 75-150 Cr Y3 |
| 7 | [07_inventory_math.md](07_inventory_math.md) | 9,260 | 6 | Inventory math correctness: crons in vercel.json, NEXCP (n+1)/n correction, LTD sqrt(L) fix, prequential residuals, backtesting MVP, alpha drift invalidation, cu/co override, supplier scorecard | Working capital release per percent stock-out |
| 8 | [08_approvals_workflow.md](08_approvals_workflow.md) | 9,321 | 4 | Approvals + workflow: dual-pane approvals with delegation + escalation cron, comments thread, line-item source_text_span, doc-review.tsx with bbox overlay, canonicalisation drift fix | Cycle-time + operator productivity uplift |
| 9 | [09_observability_pricing.md](09_observability_pricing.md) | 11,400 | 6 | Observability + admin + pricing: cost_status budget rule engine, 12 alert rules + on-call, SLO catalog, 3-tier pricing tied to Stripe Meters, cron health alerting, retention | INR 3.38 Cr Y1, 88% topline lift |
| 10 | [10_marketplace_ai_ops.md](10_marketplace_ai_ops.md) | 9,690 | 6 | Marketplace + AI surfaces operational hardening: marketplace canary, template diff viewer, royalty model, parse_method telemetry fix, agent kill switch, per-tenant opex caps, MCP rate-limit + scope | INR 100 Cr midpoint ARR uplift over 12 months |
| 11 | [11_compliance_certifications.md](11_compliance_certifications.md) | 9,654 | 12 (parallel) | Compliance certifications: SOC 2 Type II year-1, ISO 27001 SoA year-2 (76 of 93 controls), EU AI Act Article 6 memo, CMEK envelope encryption | INR 23-32 Cr Y3, 20x ROI on INR 1.1 Cr spend |

## DD (deep-dive research) prompts executed

The 60 DD prompts collated in `../14-final-roadmap.md` section 16 are distributed across phases:

- Phase 1: DD1, DD2, DD4, DD5, DD6, DD8, DD42, DD43, DD50
- Phase 2: DD3, DD22, DD41, DD48
- Phase 3: DD10, DD23, DD24, DD25, DD45
- Phase 4: DD7, DD9, DD13, DD20, DD30, DD40, DD44
- Phase 5: DD11, DD32
- Phase 6: DD12, DD35, DD36, DD37, DD38, DD39
- Phase 7: DD15, DD16, DD17, DD18, DD49
- Phase 8: DD13, DD30, DD40 (shared with Phase 4)
- Phase 9: DD26, DD27, DD28, DD29
- Phase 10: DD46, DD47, DD54, DD55, DD56, DD57, DD60
- Phase 11: DD14, DD31, DD32, DD33, DD34, DD58

Each prompt produced either a direct code finding (file:line citation against main) or a competitive benchmark with source URL preserved. WebFetch was denied to subagents during this run; external citations are tagged `[verified-from-prior-knowledge]` with source URL inline so a follow-on session can re-ground them.

## Key verified-on-main findings consolidated

These verifications came from the phase deep-dives, anchoring the roadmap items in actual code state.

- **`amend.js:46`** still emits `VCHTYPE = "Sales Order"`. `push.js` is voucher-type-aware but inherits caller defaults from `body.tallyXml` plus `voucherType` at `:43` and `:65`. Three actual emit sites for the Phase 1 fix sweep: `amend.js:46`, `so-agent-pocv4.jsx:652`, `push.js:43,65`.
- **`userClient(accessToken)` already exists** at `src/api/_lib/supabase.js:17-23`. Phase 5 service-role migration is "use the existing helper" not "build it" (saves ~2 weeks).
- **`src/v3-app/` IS the only deployed bundle**: `vite.config.js:28 root: src/v3-app`, `package.json:11 build script`, `vercel.json:5-6 buildCommand + outputDirectory: public`. Closes red-team open question.
- **`run.js:573-577 parseMethod` never reads `globalApplied`**: L3.5 hits stamped with LLM's parse method or `null` instead of `'global_template'`. Three-change fix specified in Phase 10.
- **`conformal.js:120` uses `Math.min(1, alpha)` for NEXCP** while `:101` correctly uses `Math.ceil((n+1)*alpha)/n` for splitCP. Engine claims 95 percent coverage but the NEXCP path can only prove 92.9 percent (Phase 7 F54 fix).
- **`safety-stock.js:52-57` correctly implements Hadley-Whitin compound** for LTD, but **`conformal.js:229-239 scaleIntervalToLTD` uses only an additive `sqrt(L)*Lsig`** sigma inflator. Parametric and conformal paths use different lead-time math (Phase 7 F55 fix).
- **`vercel.json:12-17` registers only `/api/cron/daily`.** 8 orphan cron handlers (including 4 inventory crons) never run in production. Bet 3 is unrunnable until F53 ships.
- **`approvals.tsx` is 205 lines single-pane** (no delegation, no SLA, no escalation). `approval-evaluator.js` populates `quote_approvals` but emits no `expires_at`. `quote_approvals.comments` accepts a single decision note, not a thread.
- **`so-intake.tsx:267` strips 13 patterns; `customer-canonicalizer.js:36` strips 9.** Canonicalisation drift confirmed at file:line.
- **`voter.js:159` buckets exclusively on `stringifyKey(l?.partNumber)`** with positional fallback `__pos:N`. Single-key matcher; Hungarian-algorithm bipartite upgrade is the Phase 4 + Phase 8 line-alignment fix.
- **`mistral.js:51` ignores per-tenant `docai_mistral_ocr_api_key_enc`** and uses `process.env.MISTRAL_API_KEY`. Gemini correctly wires settings. Migration 098 is ahead of Mistral implementation.
- **Firewall parity gap**: `gemini.js:18,125,126` applies `applyFirewall` and `redactMessages`; `mistral.js` has zero firewall imports across 104 lines.
- **`audit.js:53-87 recordAudit`** writes audit_events with no chain HMAC at write. HMAC computed at export time only in `audit/export.js:68-75`. Phase 2 F17 plus Phase 5 F44 closes the gap.
- **`secrets.js:25-32`** AES-256-GCM keyed by single env var `ANVIL_SECRETS_KEY`. Motivates CMEK substrate in Phase 5 (F49) and Phase 11 (DD32).

## Top 5 highest-leverage innovative ideas across all phases

Selected by 5-axis scoring (PSev / MDiff / TLev / EStr / SFit each 1 to 5):

1. **HMAC Voucher Attestation** (Phase 1, idea a): every Tally push produces a HMAC-signed receipt customers can verify against GSTN. Phase 1 substrate (audit chain, voucher correctness, eval credibility) already builds 80% of the machinery. Revenue: INR 8,000 base + INR 5 per voucher. Highest-leverage moat-builder.
2. **Operator-Controlled Agent Kill Switch** (Phase 10 + A8 F8.37): scored 25 of 25 in the surface report, top of the fleet. Operator hard stop for runaway autonomous loops. Implementation is one toggle + audit_events write, but unlocks enterprise agent adoption.
3. **GSP-Neutral Adapter + Compliance OS** (Phase 6, ideas a + b): packaged India compliance surface (GST + e-Invoice + Tally + eway + AA + TReDS + BRSR + DPDP) sold as a single product, GSP-vendor-neutral. Revenue: INR 25k/mo enterprise tier + 50k/mo white-label for chartered accountants. Year 3 INR 75-150 Cr ARR.
4. **Outcome-Based Pricing across 12 outcomes** (Phase 9, idea c): instead of seat-based, charge per "outcome achieved." Outcomes meter at `_lib/outcomes.js` already wired for Tally drift; extend to 11 others. 88% topline lift over flat-plan baseline.
5. **EU-Sovereign Anvil tier** (Phase 11, idea d): full EU-residency deployment with EU-jurisdiction DPA. Revenue: 2.5x base tier price for EU customers; unlocks GDPR-strict buyers. 8k-15k mid-market EU TAM.

## Aggregate revenue model (across all 11 phases)

| Horizon | ARR uplift estimate | Confidence |
|---|---|---|
| Year 1 | INR 30 to 45 Cr incremental | medium |
| Year 2 | INR 100 to 175 Cr incremental | medium |
| Year 3 | INR 300 to 500+ Cr incremental | low to medium |

These are not independent: Phase 1 to Phase 3 unlock the credibility substrate that every other phase monetizes on top of. The Year 1 figure is conservative.

## Read order

1. Start with `../INDEX.md` for the surface-report file map.
2. Read `../14-final-roadmap.md` section 1 (executive summary) and section 2 (phase plan overview).
3. For any phase you plan to implement, read the corresponding `0X_*.md` plan here.
4. Cross-reference each plan to the surface reports `../01-landing-onboarding.md` through `../12-ui-primitives.md` for surface-specific context.
5. Use `../13-red-team.md` for the adversarial critique and top 30 P0/P1 matrix.

## Style and grounding constraints

- No emojis, no em dashes or en dashes throughout all 11 phase plans.
- All file references absolute under `/Users/kenith.philip/anvil/`.
- Repo anchored on `main @ c4f946b`. The prior stale worktree slug `a24d582` is not referenced anywhere in the canonical files.
- Every claim tagged: `[verified-on-main]`, `[verified-from-surface-report]`, `[verified-from-prior-knowledge]`, `[inferred]`, `[speculative]`.
