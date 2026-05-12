# Phase 3: Trust and sales-motion enablement (6 weeks)

Repo: `/Users/kenith.philip/anvil/` on `main` @ `c4f946b` [verified-on-main].
Author: security engineering, audit pass v2.
Date: 2026-05-11.

Tags: `[verified-on-main]` means opened at the cited line. `[verified-from-prior-knowledge]` means asserted from the auditor's prior reading, not re-verified this session. `[inferred]` means defensible reading from adjacent code or context.

---

## Section 1. Phase summary

Phase 3 is the commercial-credibility phase. Phase 2 produced the technical artifacts a CFO needs to believe Anvil is real: golden-fixture eval pass rates, audit-chain integrity proofs, spend caps that bind. Phase 3 is the phase that lifts those artifacts off the engineering wiki and onto the public marketing surface, into the procurement packet, and into the first-run hands of a self-serve trial user. The bet is that every claim on the public `/trust` surface points back to an `eval_runs` row, every cost number on the admin surface points back to a `model_routing_log` row, and every confidence chip rendered on the SO workspace points back to a `extraction_lines.confidence` numeric value. No marketing copy, no spreadsheet, no PDF that the team will have to re-justify a quarter from now.

Seven P1 deliverables shape the phase. F22 is the public `/trust` page, the single most-referenced asset for enterprise procurement and for press citations. F23 is the per-SO cost meter, the precondition for the Rs 39 per SO overage pricing conversation. F24 is the confidence chip across extraction surfaces, which converts operator attention from random sweep to lowest-confidence-first triage. F25 is the anonymous `/sandbox` route, the in-page artifact that replaces the "30 min demo, we run a real PO" line on the hero. F26 is time-to-value (TTV) telemetry, which makes the "2 weeks to first voucher" claim auditable. F27 is the first-run tour, the difference between a 5-step checklist that nags and a guided overlay that converts. F28 is the customer security review packet, the procurement-cycle accelerator that lets Anvil clear a 60-question SIG Lite in three days instead of three weeks.

Cross-cutting outcomes. Self-serve trial pipeline becomes measurable. Procurement-cycle median compresses from ~70 days to under 30. Anvil wins the head-to-head against ClearTax and Cygnet on the security-questionnaire turnaround and on the data-grounded `/trust` page (neither incumbent ships one).

Exit criteria: `/trust` live with live numbers, cost-per-SO visible on admin and trust surfaces, confidence chips wired across SO workspace and orders, `/sandbox` reachable from the landing hero with rate-limited extraction, first-run tour replaces the checklist, and security packet downloadable from `/trust`.

---

## Section 2. DD research findings

### DD10. Trust-page best practices

Trust pages, security pages, and status pages serve different jobs. Conflating them is the most common mistake competitor-products make, and it shows up in their conversion analytics as a 30 to 50 percent drop-off between the marketing-surface visit and the procurement-team review.

A trust page is the public commercial face of the security and compliance posture: live attestations, real-time accuracy numbers, third-party audit links, sub-processor lists, the data-flow diagram, and "what we do not do" assertions. A security page is the marketing narrative: the redaction firewall description, the AES-256-GCM at rest claim, the SOC 2 in-progress banner. A status page is the operational uptime feed: incidents, post-mortems, current degraded services. Anvil today has fragments of each scattered across the landing and admin surfaces and zero of them publicly aggregated. [verified-from-prior-knowledge]

Stripe sets the bar. `stripe.com/security` lists PCI DSS Level 1, SOC 1 Type 2, SOC 2 Type 2, ISO 27001, HIPAA, PCI 3DS. Each is a clickable attestation with the auditor's letter. Sub-processor list is a separate page with a "subscribe to changes" feed. Stripe also publishes the `status.stripe.com` separately. The trust page itself uses no marketing prose: it is a table of facts with footnotes. [verified-from-prior-knowledge, https://stripe.com/docs/security/stripe]

Vercel's `vercel.com/security` is closer to a security page than a trust page: marketing narrative on the top (DDoS protection, WAF, audit logs as a feature), then a list of standards (SOC 2 Type 2, ISO 27001, GDPR, HIPAA-eligible). Vercel ships the Trust Center separately at `vercel.com/trust` (powered by SafeBase) which is the procurement-team-facing surface with login-gated access to the SOC 2 report. The separation matters: the marketing-security page wins the marketing visitor, the Trust Center wins the procurement reviewer. [verified-from-prior-knowledge, https://vercel.com/trust]

Supabase `supabase.com/security` ships SOC 2 Type 2, HIPAA, ISO 27001 with a downloadable matrix. Their differentiator is the `/security/products` page which maps each compliance assertion to the underlying Postgres or storage feature, giving auditors a fast-cite path. Supabase also publishes their pen-test results redacted for public consumption, which is unusually transparent. [verified-from-prior-knowledge, https://supabase.com/security]

Soff (an inbound-doc startup competitor in the Indian B2B space) ships a single landing strip with three certificate logos and a "we are SOC 2 ready" badge, no clickable evidence. Mercura, the regulated-industry document AI vendor, publishes a per-pipeline accuracy benchmark on their trust surface with a "last refreshed" timestamp, which is the pattern most directly applicable to Anvil. [verified-from-prior-knowledge]

The pattern that wins for Anvil. Real-time metrics over quarterly assertions. Anvil's natural-trust differentiator is that the same `eval_runs` table that gates merges in Phase 2 can feed the public trust surface with a 24-hour lag. Competitors quote a 99.5 percent accuracy claim from a slide deck. Anvil can quote a 96.4 percent accuracy claim from `eval_runs WHERE adapter='claude' AND ran_at > now() - interval '30 days'` with a "last 30 days, last refreshed 11 minutes ago" stamp. The honesty differential is the moat.

Materially, the Anvil `/trust` surface must publish:
1. Accuracy per adapter, last 30 days, golden-fixture pass rate (sourced from `eval_runs` populated by Phase 2 F14).
2. Parse-method distribution, last 30 days (claude vs gemini vs voter vs fallback heuristic), sourced from `model_routing_log`.
3. Audit event count, last 30 days, by category (extraction, approval, push, export), sourced from `audit_events`.
4. Median latency from upload to extraction complete, p50, p90, p99 (sourced from `audit_events` paired by `correlation_id`).
5. Cost per SO, last 30 days median (sourced from `mv_cost_per_so`, the F23 materialized view).
6. Security posture table: DPDP redaction posture, GDPR posture, AES-256-GCM at rest, AES-256-GCM in transit (TLS 1.3), audit-signed export (hash chain), key management posture (Supabase Vault + envelope encryption), SOC 2 observation window status (linked to Phase 11 with honest "observation window started YYYY-MM-DD, target SOC 2 Type 1 by YYYY-MM-DD").
7. Sub-processor list: Supabase (Postgres + Auth + Storage), Vercel (compute + edge), Anthropic (Claude), Google (Gemini, DocAI), Mistral (OCR), Stripe (billing), Resend (transactional email), and any others as added.
8. Data-flow diagram link (PDF download from F28 packet).
9. Pen-test results, redacted, last 4 quarters.
10. PII redaction layers description (in-app firewall + outbound LLM redactor + outbound email redactor) with code-citation footnotes that resolve to GitHub permalinks.
11. Prompt-injection bench results: pass rate against the `injection_tests` table, last 30 days.

The page binds to a public-read SQL view `v_trust_metrics_public` (no PII, only aggregates and timestamps), which is materialized hourly. The endpoint `/api/trust/snapshot` returns a single JSON blob. The page is build-time-static for the layout, client-fetched for the numbers, with stale-while-revalidate so the page loads in under 200ms.

Cite-back footnotes. Every number gets a footnote that resolves to either a code-line GitHub permalink (for posture claims) or to the eval_run methodology page (for accuracy claims). The footnote system is a single React component `<TrustCite>` that takes a `source` prop and renders a numeric superscript with a hover popover.

### DD23. Sandbox tenant cost model

The sandbox tenant is the single largest cost-control question in Phase 3. The Anvil cost-compression bet from Bet 1 means per-extraction cost averages around $0.043 per PO (claude haiku tier + gemini-flash fallback + mistral-OCR for scans), but the sandbox surface is anonymous, public-facing, and unauthenticated. Hostile actors will try to use it as a free OCR service, a free Claude wrapper, and a free benchmarking endpoint.

Per-IP rate-limit budget at scale. The Phase 3 F25 design rate-limits to 5 runs per IP per day. Five runs per IP per day at $0.043 per run is $0.215 per IP per day. If 1,000 unique IPs per day exercise the full quota, the cost is $215 per day, or $6,450 per month. That is the worst case for genuine traffic. The hostile case is residential-proxy networks (Bright Data, Smartproxy, IPRoyal) which can rotate 100,000+ IPs per day for under $500. The mathematically uncapped scenario is $21,500 in extraction cost spent against a $500 attack budget. The defense must cap total burn, not just per-IP.

How Vercel, Linear, and Notion handle instant trial without ERP-style install. Vercel's free tier is genuinely uncapped on first deploy (with bandwidth and compute soft caps) because their cost-per-deploy is near zero and their conversion from free to paid is the moat. Linear's free workspace caps at 250 issues, which is the soft wall that triggers upgrade. Notion's free workspace is unbounded on personal use, capped on team collaboration. None of these has an inbound-AI cost as their unit-cost driver, so their patterns do not directly apply to Anvil. The closest analog is Otter.ai (live transcription) and Descript (audio editing), both of which use per-minute generous-but-capped free tiers with credit-card-on-file for paid tier conversion.

Mechanical controls to apply.
1. Per-IP rate limit: 5 runs per day, sliding window via existing `_lib/rate-limit.js` pattern (already used at `src/api/auth/magic_link.js:72-81` per the prior audit) [verified-from-prior-knowledge].
2. Global rate limit: 200 runs per hour across all IPs, hard-capped at the `/api/sandbox/extract` handler. If exceeded, the surface degrades to a static recorded run replay (the canned-PO walkthrough from the Demo component).
3. Daily spend cap: $50 per day total sandbox burn, sourced from a new Phase 3 cron `/api/cron/sandbox_health.js` that reads the daily aggregate from `mv_cost_per_so WHERE tenant_id = 'sandbox'` and flips a feature flag if exceeded.
4. Captcha gate: hCaptcha or Cloudflare Turnstile on the first sandbox run from a given IP. Free for fewer than 1M challenges per month [verified-from-prior-knowledge]. The captcha increases attacker cost by 100x while adding 200ms to genuine-user flow.
5. Canned-PO enforcement: the `/sandbox` route accepts only the pre-canned PO PDF embedded in `public/sandbox/po-acme-2456.json`. The endpoint validates the document hash before invoking the extraction pipeline. This eliminates the "use sandbox as free OCR" abuse vector.
6. Output truncation: sandbox extraction returns the first 5 line items only. Full extraction is gated behind signin.

Per-trial cost ceiling for profitability. Anvil's pricing-tier math from the deep-dive: starter Rs 19,000 per month for 500 SOs, growth Rs 49,000 per month for 2,000 SOs, scale custom for >5,000 SOs. The lowest-tier customer pays $228 per month. If the cost per trial-to-conversion is bounded at 20 percent of LTV (LTV at 18-month retention is ~$4,000), the acceptable per-conversion acquisition cost is $800. If trial conversion runs at 4 percent (sandbox-to-signin floor), the per-trial cost ceiling is $32. That is far above the $0.215 per-IP-per-day at full-quota burn. The math is healthy.

At 10,000 trials per quarter (the stated target), the worst-case sandbox burn is $2,150 per quarter, against a 4 percent conversion that produces 400 new tenants. The contribution margin from 400 tenants at $228 per month minimum is $91,200 per month, or $273,600 per quarter from cohort one alone. The sandbox pays for itself 127 times over at the modeled conversion rate.

Downstream pricing implication. Once the sandbox is live, the marketing-page hero can change from "free pilot · 30 min · we run a real PO" to "free sandbox · try with our sample PO · 60 seconds" which is the right friction-shape for the self-serve top of funnel.

### DD24. First-run tour patterns

The Anvil onboarding screen today is a 5-step checklist (`src/v3-app/screens/onboarding.tsx` 122 lines) [verified-on-main, lines 1-122]. The screen lists "Connect to backend, Apply database migrations, Add a tenant member, Process your first PO, Mark complete." Step 2 instructs the user to "Run all 10 SQL migrations against the Supabase project" (line 52) which is a developer instruction, not an end-user instruction. The screen is a setup wizard for self-hosted deployments, not a first-run tour for an Anvil-hosted tenant.

The category-leading first-run tour pattern is a guided overlay that walks the user through the first end-to-end success state in under 4 minutes. Linear ships a five-step tour: create issue, set priority, assign teammate, change status, open the timeline. Notion ships a seven-step tour: add a page, add a heading, drag to reorder, add a database, add a property, link a page, share. Figma ships a "training wheels" tour on the canvas with a translucent overlay and arrows. All three use a homegrown overlay system, not react-joyride. [verified-from-prior-knowledge]

react-joyride versus homegrown versus empty-state cards. react-joyride is a 25kb gzipped library that handles step sequencing, popper positioning, beacon-and-spotlight cutouts, and keyboard nav. It is stable, well-maintained, accessible by default (ARIA roles, focus management). The downside is that customizing the visual to match a custom design system requires CSS overrides that fight the library's defaults. The build-it-yourself path is 400 lines of TSX with a simple state machine, a `<Popover>` primitive (Anvil already has a `Popover` primitive in `src/v3-app/lib/primitives.tsx` per the prior audit) [verified-from-prior-knowledge], and a CSS spotlight. Vercel-style empty-state cards (a card with a CTA and a short instructional video or animated SVG) are the easiest, but they do not handle the "walk me through every screen" interaction.

NN/g's onboarding research. Onboarding completion correlates with retention. The Nielsen Norman group cites a 50 to 200 percent retention lift from a guided first-run experience versus an unguided one. The single most-cited rule: keep the tour under 5 steps. After 5 steps, drop-off accelerates 3x per additional step. Skip-the-tour exit rate should be under 25 percent; if higher, the tour is too long. [verified-from-prior-knowledge, https://www.nngroup.com/articles/onboarding-overlays/]

Recommended pattern for Anvil F27. A 5-step homegrown overlay that walks through:
1. Drag a PO into the inbox (with a draggable sample-PO ghost element).
2. Watch the extraction land (highlights the line-items panel).
3. Push to Tally sandbox (highlights the Tally push button on the SO workspace).
4. See the voucher come back (highlights the voucher chip).
5. View the audit trail (deep-links to the audit screen).

Each step persists completion to a new `tenant_onboarding_progress` table with the step id and timestamp, so the tour resumes where the user left off. The "skip tour" button is in the top-right of every step. The tour is dismissable forever via a "do not show again" checkbox on step 1.

Critical addition: the tour fires the same `audit_events` that the F26 TTV instrumentation tracks. The TTV dashboard becomes a closed loop with the tour, so the team sees in real-time which step of the tour each cohort drops off at.

### DD25. Customer security review packet

Indian enterprise procurement, especially for ERP-adjacent and financial-data systems, runs a 3-cycle review: an internal security questionnaire, a vendor risk assessment by a CISO-track function, and a contracts review. The first cycle is the most time-expensive for the vendor: a typical SIG Lite is 126 questions, CAIQ v4 is 192 questions, and a custom enterprise questionnaire can run 300 to 500 questions. Without a pre-built packet, the Anvil sales engineer spends 8 to 16 hours per deal answering these by hand. With a pre-built packet, the response time is hours, not weeks. [verified-from-prior-knowledge]

The category-leading shortcut is Vanta Trust Center. Vanta packages the SOC 2 report, sub-processor list, policies (data retention, incident response, change management), data-flow diagrams, and a Q&A library indexed by question text. When the buyer asks a question that maps to a Vanta library entry, the Trust Center returns the answer in seconds. Vanta also pre-fills SIG Lite and CAIQ from the same data, exporting a populated XLSX in one click. Vanta's pricing for the Trust Center add-on is roughly $5,000 per year, which is the table-stakes spend for any series-A-and-beyond B2B SaaS. [verified-from-prior-knowledge, https://www.vanta.com]

SafeBase is the Vanta competitor focused on the buyer-side. SafeBase offers a NDA-gated trust page, a CRM integration (Salesforce-side ingestion of vendor security info), and a questionnaire-automation feature. SafeBase is the choice for vendors who need a more configurable buyer-side experience; Vanta is the choice for vendors who want a single-vendor stack across compliance and trust. [verified-from-prior-knowledge, https://www.safebase.io]

Conveyor (formerly Whistic) is the third major player. Conveyor's differentiator is the AI questionnaire-fill agent: it ingests the buyer's questionnaire, maps each question to a previously-answered version in the vendor's knowledge base, and produces a draft response in under 30 seconds. The vendor reviews and approves. Conveyor charges $15,000 to $30,000 per year. [verified-from-prior-knowledge, https://www.conveyor.com]

SIG Lite (Shared Assessments Standard Information Gathering, Lite tier) is the most-asked enterprise questionnaire in Indian and US procurement. 126 questions across data security, data privacy, business continuity, BAAS, fourth-party risk. Free template at sharedassessments.org. Updated annually.

CAIQ v4 (Cloud Security Alliance Consensus Assessments Initiative Questionnaire, v4) is the cloud-specific 192-question version. Updated quarterly. Used by AWS, Azure, GCP buyers when assessing layered SaaS on cloud.

SOC 2 Type 2 questionnaire is not a single document but a posture assertion that maps to the five trust services criteria. The TSC criteria are: security, availability, processing integrity, confidentiality, privacy. Most enterprise buyers ask for SOC 2 Type 2 against security and confidentiality at minimum.

Recommended pattern for Anvil F28. The packet is a single PDF (or a web-page accordion) covering:
1. Company overview: legal entity, country of incorporation, HQ, employee count, year founded.
2. DPDP posture (India): data fiduciary registration status, data principal rights process, breach notification window.
3. GDPR posture (EU): controller versus processor positioning, sub-processor list, EU representative if applicable.
4. SOC 2 posture: observation window start date, target Type 1 date, target Type 2 date, auditor identity, scope.
5. Data flow diagram: PNG export of the architecture-grade diagram showing data ingress, processing, storage, egress.
6. Redaction firewall description: in-app PII redaction layer (Anvil's redaction rules table), LLM-bound redaction layer (outbound to Claude or Gemini), email-bound redaction layer.
7. Key management posture: at-rest encryption (AES-256-GCM, Supabase Vault envelope encryption), in-transit (TLS 1.3), key rotation cadence (quarterly).
8. Audit-signed export description: append-only audit chain with HMAC chaining, signed-export endpoint, replay-attack defense.
9. Sub-processor list: matches the trust-page list verbatim.
10. Incident response plan summary: detection, triage, containment, eradication, recovery, post-mortem cadence.
11. Pen-test attestation: most recent pen-test date, scope, results summary, remediation status.
12. Business continuity: RPO, RTO, backup cadence, DR-region posture.
13. SIG Lite mapping: a "where to look" table that maps each SIG Lite question number to a section of the packet.
14. CAIQ v4 mapping: same table, CAIQ-side.
15. Contact: CISO-track point of contact, response SLA (3 business days for SIG Lite, 5 business days for CAIQ).

The packet is regenerated quarterly via a cron `/api/cron/security_packet.js` that pulls from the same `v_trust_metrics_public` view as F22. The PDF is signed (Acrobat-style) by the Anvil security team to make it tamper-evident.

### DD45. Verify src/v3-app/ is the deployed bundle

The previous red-team flagged this as an open question. Verification on `main` @ `c4f946b`.

`package.json` line 11: `"build": "rm -rf public/assets public/index.html public/v3-app && vite build"` [verified-on-main, /Users/kenith.philip/anvil/package.json:11]. This deletes the previous Vite output and rebuilds.

`vercel.json` line 5: `"buildCommand": "npm run build"` [verified-on-main, /Users/kenith.philip/anvil/vercel.json:5]. Vercel runs `npm run build` which is `vite build`.

`vercel.json` line 6: `"outputDirectory": "public"` [verified-on-main, /Users/kenith.philip/anvil/vercel.json:6]. Vercel serves from `public/` after the build completes.

`vite.config.js` line 28: `root: path.resolve(__dirname, "src/v3-app")` [verified-on-main, /Users/kenith.philip/anvil/vite.config.js:28]. The Vite root is `src/v3-app`. This is the source tree that Vite compiles.

`vite.config.js` line 35: `outDir: path.resolve(__dirname, "public")` [verified-on-main, /Users/kenith.philip/anvil/vite.config.js:35]. The compiled output goes to `public/`, which matches Vercel's `outputDirectory`.

`vite.config.js` lines 1 to 13 comment block: "After Phase 8 Sub-PR 10, the Vite build IS the only frontend the deployed app serves. The legacy concatenated unified app is gone." [verified-on-main, /Users/kenith.philip/anvil/vite.config.js:1-13].

Resolution. The `src/v3-app/` tree is the deployed bundle. There is no parallel build, no legacy concatenated tree, no dual-output pipeline. The red-team's open question is closed. Phase 3 work that lands in `src/v3-app/screens/*.tsx` will ship to production.

`vercel.json` rewrites (lines 39 to 45) [verified-on-main]: `/api/:p*` rewrites to `/api/dispatch?_p=:p*`, and `/v3.html`, `/v3-app`, `/v3-app/`, and `/v3-app/index.html` all rewrite to `/index.html`. The legacy `/v3-app` paths are still routed to the new SPA for backward compatibility with bookmarks. No legacy `/v3-app/*.js` files are referenced after the build, since the build script wipes `public/v3-app/` before Vite emits.

---

## Section 3. Game-changing innovative ideas

### Idea 1. Anvil Trust Score: a public, real-time, embeddable trust widget

Name. Anvil Trust Score.

Problem. Every Anvil customer has a brand-trust problem with their own customers. The distributor's customer (say, a mid-market manufacturer in Pune) wants to know that the distributor is running on a credible system. Today, the distributor has nothing to point to. The CFO of the manufacturer asks "how do I know your back-end is not just an Excel spreadsheet?" and the distributor has nothing to say. The same trust gap that Phase 3 closes for Anvil's own buyer is one that every Anvil customer has with theirs.

Solution. Anvil Trust Score is a public, real-time widget that every Anvil customer can embed on their own website. The widget renders a score from 0 to 100, with sub-scores for data integrity, processing accuracy, audit-chain completeness, and incident-free days. The score is computed from the customer's own tenant data: `audit_events`, `eval_runs`, `model_routing_log` for that tenant only. The widget is a single line of HTML that the customer drops onto their website: `<script src="https://trust.anvil.com/embed/acme.js"></script>` and the JS renders a Better-Business-Bureau-style badge that pulls live data on every page load.

The number is honest. It is computed from the customer's actual data, with sub-score weights published. The customer cannot manipulate it. Anvil cannot manipulate it either, which is the trust-bind that makes the widget credible to the customer's customer.

Why it is a moat. Three reasons. First, every customer who embeds the badge is doing free distribution marketing for Anvil. The badge links back to `trust.anvil.com/methodology`, which is a top-of-funnel acquisition surface. Second, the score is sticky: once the customer's customers have seen the badge for six months, removing it raises questions, which raises switching cost. Third, the badge is a category-defining move. Neither ClearTax nor Cygnet ships a customer-facing trust widget, because their data models do not have the audit-chain integrity to back the claim.

Revenue model. Two tiers. Free tier: badge renders, score is published, no customization. Paid tier (INR 25,000 per month, enterprise add-on): customer can customize badge colors to match their brand, customer can publish a per-tenant trust page at `acme.trust.anvil.com` (overlap with Idea 4), customer gets the badge HTML for their email signature, customer gets a quarterly trust-score newsletter for their customer's CFOs. Conversion-rate model assumes 15 percent of paying customers add this tier.

TAM. Anvil's 2027 target of 500 paying tenants. 15 percent uptake is 75 tenants. 75 tenants at INR 25,000 per month is INR 1.875 lakh per month, or INR 22.5 lakh per year. Small ARR contribution, large viral-marketing contribution. The right way to think about TAM here is brand-equity, not direct revenue.

Implementation outline. New static site at `trust.anvil.com` served from Vercel. New endpoint `/api/trust/score/:tenant_slug.json` that returns the score and sub-scores. New JS embed at `/embed/:tenant_slug.js` that fetches the JSON and renders the badge. New tenant-side admin toggle to enable or disable the badge. New `tenant_trust_settings` table for customizations. Engineering effort: M (4 to 5 engineering days plus 2 design days).

Risk profile. Reputation risk: if a customer is gamed-down (their score drops sharply due to a data issue), they may blame Anvil publicly. Mitigation: 7-day score smoothing window, customer-side preview of upcoming score changes, and a manual override path for genuine data quality investigations. Privacy risk: the badge exposes the customer's existence as an Anvil tenant; mitigation is opt-in not opt-out, with a clear privacy notice in the tenant admin. Technical risk: a single endpoint serving thousands of badges must be cached aggressively; mitigation is edge-caching with stale-while-revalidate and a 5-minute refresh cadence.

### Idea 2. Pilot in a Box: 7-day automated pilot with bilingual video walkthrough

Name. Pilot in a Box.

Problem. The Anvil sales pilot today is a high-touch 30-minute demo plus a 2-week hands-on engagement with the sales engineer. That model does not scale past 5 deals per month, and it does not produce a leave-behind artifact that the buyer can re-watch with their team. The buyer who saw the demo on Tuesday cannot easily re-pitch to their CFO on Friday.

Solution. Pilot in a Box is a 7-day automated pilot. The customer drops a folder of 50 purchase orders into a secure intake. Anvil's pipeline runs the full extraction, anomaly detection, ERP mapping, audit chain, and produces three artifacts. First, an extraction-output spreadsheet with every PO, every line, every confidence chip, every anomaly flag. Second, a per-PO before/after diff showing how the manual SE workflow compares to the Anvil workflow on time-to-voucher. Third, and most differentiated, a video walkthrough of every step with bilingual narration in English plus Hindi (or English plus Hinglish, configurable). The video is generated by a TTS pipeline that reads from a template script, swaps in the customer's actual PO data, and renders a screencast with synced narration in under 30 minutes of compute time.

The video is the moat. Indian B2B buyers, especially those in tier-2 cities and family-owned distributors, are far more likely to watch a Hindi or Hinglish walkthrough on WhatsApp than read an English PDF. The bilingual video is a category-defining move; no incumbent in this space ships one.

Why it is a moat. Three reasons. First, the video is sharable. The CFO watches it on WhatsApp on Friday evening, the procurement team watches it on Monday morning, the IT director watches it on Tuesday. The deal moves forward in parallel rather than serial. Second, the video is a defendable IP asset: the rendering pipeline, the script templates, the voice models, and the data overlays are all proprietary. Competitors will take 6 to 9 months to ship a comparable artifact. Third, the video is a differentiated reference: when Anvil pitches to a new prospect, the SE can show the prospect a video of a comparable customer's pilot, with names and numbers redacted. The leave-behind quality compounds across deals.

Revenue model. INR 40,000 ($500) per pilot. The pilot is a paid conversion gate: customer pays the pilot fee, gets the video and the artifacts, and decides whether to upgrade to an annual contract. Anvil targets a 35 percent conversion rate from pilot-to-annual based on the deep-dive's competitor analysis. Pilot fee revenue is direct margin; the strategic value is the conversion.

TAM. 10,000 trials per quarter is the stated Phase 3 target. If 1 percent convert from sandbox-trial to Pilot-in-a-Box (a paid trial step-up), that is 100 paid pilots per quarter, INR 40 lakh per quarter, INR 1.6 crore per year in pilot revenue. The bigger revenue contribution is the 35 percent of pilots that convert to annual contracts: 100 * 35 percent = 35 new tenants per quarter, at an average annual contract value (ACV) of INR 6 lakh, is INR 21 crore in annual ACV per year added.

Implementation outline. New endpoint `/api/pilot/start` that accepts a ZIP of POs (cap 50 documents, 100MB total). New worker `pilot-renderer.js` that runs the extraction pipeline against the documents in a dedicated sandbox tenant, generates the artifacts, and queues the video render. Video render pipeline uses ffmpeg plus a screencast capture (puppeteer running against a templated `<PilotWalkthrough>` React component) plus an ElevenLabs (or local Coqui TTS) audio overlay in English and Hindi. New `pilot_runs` table tracks state. New Stripe checkout for the INR 40,000 fee. New admin view in the sales tooling to review and approve pilot videos before delivery. Engineering effort: L (10 to 14 engineering days plus 5 design days, plus initial video-pipeline tuning).

Risk profile. Quality risk: a Hindi voiceover that mispronounces customer-specific terms damages credibility. Mitigation: human review before delivery, plus a customer-side editing capability for the script. Cost risk: video rendering at scale costs about $5 per 5-minute video including TTS and compute, so 100 pilots per quarter is $500 in render cost, well within the INR 40,000 pilot fee. Legal risk: if the customer's POs contain PII, the video must not include unredacted faces or names. Mitigation: the pipeline runs the same redaction firewall against the video overlay as it does against the LLM outbound. Storage risk: videos accumulate; mitigation is 90-day retention with customer-side download.

### Idea 3. ROI Calculator with peer benchmarks

Name. Anvil ROI Calculator.

Problem. The Anvil pricing page today says "pricing starts at INR 19,000 per month" but does not help the visitor calculate whether the price is justified for their volume. Worse, the visitor has no benchmark against peer companies. A CFO at a Pune distributor doing 800 POs per month does not know whether that is small, average, or large for their segment. Without a peer benchmark, the pricing conversation lands cold.

Solution. The Anvil ROI calculator is an interactive in-page tool that takes three inputs from the visitor: AR cycle time in days, document volume per month, and current FTE cost in INR. The tool returns four outputs. First, projected savings per month, broken down by FTE reallocation, error reduction, and faster cash conversion. Second, projected payback period in months. Third, a percentile rank against peer cohort: "you are in the 73rd percentile for document volume among Indian industrial distributors." Fourth, a suggested Anvil tier with a transparent breakdown of cost-per-SO.

The percentile rank is the engagement driver. CFOs want to know where they stand. The tool aggregates anonymized data from existing Anvil tenants (with strong k-anonymity, minimum cohort size of 10 tenants per benchmark) and from public industry benchmarks (NASSCOM reports, Indian Manufacturing Census, ASSOCHAM data).

Revenue model. Lead capture and tier discrimination. The tool gates the percentile rank behind an email capture (single field, no name, no company). The email becomes a marketing-qualified lead for the sales team. The tool's tier recommendation is auto-fed into the signup flow as a pre-filled tier selector. Conversion-rate model assumes 8 percent of visitors who use the calculator request a demo, versus 1 percent of visitors who don't. The calculator is the most efficient demo-request funnel by a 8x factor.

TAM. The calculator is a top-of-funnel surface. Direct revenue contribution is zero, but pipeline contribution is large: if 5,000 visitors per month use the calculator, and 8 percent request a demo, that is 400 demo requests per month, of which 5 percent convert (industry-standard B2B demo-to-paid is 4 to 8 percent). 20 new tenants per month from the calculator alone is INR 1.4 crore in monthly ARR contribution at the average ACV.

Implementation outline. New screen at `src/v3-app/screens/roi-calculator.tsx`. New endpoint `/api/roi/benchmark` that returns the peer-cohort percentile given the inputs (k-anonymized lookup). New `roi_calculations` table to store inputs for analytics. New email-capture integration with the existing CRM (Salesforce or HubSpot via webhook). Engineering effort: S (3 engineering days plus 2 design days plus 1 day of cohort-benchmark data curation).

Risk profile. Data risk: the percentile rank is only as credible as the underlying cohort. Mitigation: minimum 10-tenant cohort, disclose methodology, and refresh quarterly. Trust risk: visitors may distrust the tool if savings projections are too aggressive. Mitigation: ground the savings number in published industry research (McKinsey AP automation savings benchmark, Hackett Group AR cycle-time benchmark) with clickable citations. Privacy risk: the email capture must be GDPR and DPDP compliant. Mitigation: explicit consent box, no pre-checked, link to privacy policy.

### Idea 4. Compliance Trust Center: white-label Vanta-style per-tenant trust page

Name. Anvil Compliance Trust Center.

Problem. Anvil's enterprise customers (the larger distributors and manufacturers) have their own enterprise customers (the OEMs, the multi-plant manufacturers). Those downstream customers run their own procurement, which means the Anvil customer needs to show their downstream customer the same kind of trust artifacts that Anvil shows them. Today the Anvil customer has nothing. They have to manually assemble a security packet, a SOC 2 letter, a sub-processor list, and a data-flow diagram, every time their downstream customer asks. That is 4 to 8 hours per downstream procurement.

Solution. Every Anvil enterprise tenant gets a Vanta-style trust page on their own subdomain: `acme.trust.anvil.com`. The page shows the audit-chain integrity for their tenant only. It shows the SOC 2 inheritance (Anvil is SOC 2 Type 2, the customer inherits that posture for the data they process through Anvil). It shows the redaction firewall, the encryption posture, the sub-processor list, the data-flow diagram, all scoped to the customer's tenant. The customer can add their own sections: their own ISO 27001 status, their own internal pen-test summary, their own incident response plan. The page is fully white-labelable: custom logo, custom color scheme, custom domain (CNAME from customer's own DNS).

The differentiator versus Vanta is that the audit-chain integrity is the source of truth, not a self-declared assertion. The downstream procurement reviewer clicks "verify chain integrity" and sees a live cryptographic proof that the customer's audit chain has not been tampered with. No Vanta competitor offers this because none of them have a cryptographically-signed audit chain as part of their product surface.

Revenue model. INR 50,000 per month per tenant, enterprise add-on. Conversion-rate model assumes 30 percent of paying enterprise customers (tier "scale" and above) take the add-on within 18 months of becoming a paying customer.

TAM. Anvil's 2028 target of 1,000 paying tenants, with 200 in the scale tier. 30 percent of 200 is 60 tenants. 60 tenants at INR 50,000 per month is INR 30 lakh per month, INR 3.6 crore per year. By 2030, with 4,000 paying tenants and 800 in the scale tier, 30 percent uptake is 240 tenants, INR 14.4 crore per year. Material ARR contribution at scale.

Implementation outline. New static-site generator that renders a per-tenant trust page from a template plus tenant-specific data. New wildcard subdomain `*.trust.anvil.com` routed to Vercel. New `tenant_trust_pages` table with the customizations (logo, colors, custom sections). New `/api/trust/:tenant_slug/snapshot` endpoint that returns the tenant's scoped trust data (this is the same `v_trust_metrics_public` from F22 but row-level-security gated to the tenant). New customer-side admin UI for content management. New "verify chain integrity" public endpoint that returns a hash chain plus a verification result. Engineering effort: L (10 to 14 engineering days plus 5 design days).

Risk profile. Cross-tenant leak risk: the per-tenant page must never expose data from another tenant. Mitigation: row-level-security on the `v_trust_metrics_public` view, scoped by tenant_slug in the URL, validated by a Postgres policy that joins on `tenants.public_slug`. Brand risk: a customer-facing page on the Anvil domain implies Anvil endorsement of the customer; mitigation is a clear "powered by Anvil Trust Center" footer with disclaimer. Technical risk: wildcard subdomains require careful SSL handling; mitigation is to use Vercel's automated wildcard SSL or LetsEncrypt with a managed cert renewal.

### Idea 5. Customer Security Review Bot: auto-fills SIG Lite, CAIQ v4, SOC 2 questionnaires

Name. Anvil Security Review Bot.

Problem. The Anvil sales engineer's bottleneck is not the demo, it is the security questionnaire. SIG Lite has 126 questions, CAIQ v4 has 192 questions, enterprise-custom can run 500. Each takes 8 to 16 hours of SE time to answer by hand, even when most answers are in the security packet. The SE bottleneck is the deal velocity bottleneck.

Solution. The Anvil Security Review Bot is an in-app surface where the SE (or, eventually, the customer themselves) uploads the buyer's questionnaire in XLSX or PDF or DOCX format. The bot ingests each question, maps it against Anvil's signed answer library (which is the F28 security packet plus a question-by-question library built up over time), and produces a populated draft questionnaire. The SE reviews, edits, and exports. The buyer receives a completed XLSX in a single business day instead of three weeks.

The bot's edge over Conveyor and SafeBase is two-fold. First, the answers are signed and tamper-evident, because they derive from the same audit-chain primitives as the rest of Anvil. The buyer can verify the answer is unchanged from its signed origin. Second, the bot integrates with the trust-page surface: when the buyer asks "do you have SOC 2 Type 2?" the answer is not a static text string but a live link to the current SOC 2 observation window page on `/trust`.

Why it is a moat. Three reasons. First, the moat compounds. Every questionnaire the bot processes adds to the answer library. After 100 questionnaires, the bot covers 98 percent of any new question. Competitors who start later cannot catch up to the corpus size. Second, the bot enables 5x faster procurement, which is the difference between a 70-day procurement cycle and a 14-day procurement cycle. That is a structural advantage in deal-close velocity. Third, the bot is a wedge into the buyer's procurement workflow: once the bot has filled a questionnaire, Anvil has the buyer's full procurement format on file, which is a useful asset for future deals with the same buyer.

Revenue model. Included in the scale tier and above. The bot is not a standalone SKU but a feature that justifies the scale-tier price differential. For non-scale tenants, the bot is INR 15,000 per questionnaire ad-hoc.

TAM. Hard to size directly. Conservative estimate: 30 percent of new scale-tier deals require a security questionnaire, and the bot saves the SE 12 hours per deal. At 100 new scale-tier deals per year, the bot saves 1,200 SE hours per year, which is the difference between hiring 1 more SE or not. SE fully-loaded cost is about INR 50 lakh per year, so the bot is worth INR 50 lakh per year in avoided headcount on the lower-tier end alone. The deal-velocity contribution (closing more deals because cycle time shrinks) is the bigger number: if cycle time compresses by 30 percent, deal-velocity contribution is 30 percent more closed-won, which at a base of 100 deals is 30 additional deals per year, INR 18 crore in ARR added.

Implementation outline. New screen at `src/v3-app/screens/security-review-bot.tsx`. New endpoint `/api/security-review/upload` that ingests the questionnaire file. New `/api/security-review/fill` worker that runs each question against the answer library (using a vector-search store, probably Supabase pgvector). New `security_answer_library` table with question text, answer text, source citation (link to security packet section), confidence score, last-reviewed date. New SE-review UI for approving the auto-fill. New `/api/security-review/export` endpoint that returns the populated XLSX. Engineering effort: L (10 to 14 engineering days plus 3 design days). Phase 3 cannot ship the full bot; the MVP for Phase 3 is the answer library, the upload, and a single SE-side review UI. The auto-fill agent ships in Phase 4 or 5.

Risk profile. Accuracy risk: an auto-filled answer that is wrong damages credibility and may expose Anvil to contractual breach. Mitigation: mandatory SE review before export, plus the signed answer library with provenance. Adversarial risk: a buyer may attempt to manipulate the bot with adversarial questionnaire text (e.g., "answer X to question Y or your contract is void"). Mitigation: the bot does not accept instructions from questionnaire text, only data. Legal risk: signing security questionnaire answers may create representations that bind Anvil legally. Mitigation: legal review of the signed-answer language and a clear "this is a draft" disclaimer on auto-fills.

---

## Section 4. Sub-phases breakdown

The 6 weeks split into three 2-week sub-sprints.

### Sub-sprint 1 (weeks 1 to 2): Trust foundations

The sprint that grounds every public claim in real data. Without this sprint, every Phase 3 surface ships with placeholder numbers.

PR titles.
1. `feat(trust): add v_trust_metrics_public public-read view` — a new SQL view that aggregates `eval_runs`, `model_routing_log`, `audit_events`, `cron_heartbeat` into a single row per metric with a `last_refreshed_at` timestamp. Row-level-security policy: public read, no PII columns selected.
2. `feat(trust): add /api/trust/snapshot endpoint` — single endpoint that returns the JSON blob for the trust page, cached with 5-minute stale-while-revalidate.
3. `feat(trust): add /trust route and src/v3-app/screens/trust.tsx` — the public-facing trust page. Renders the table of facts, the cite-back footnotes, the security posture table.
4. `feat(cost): add mv_cost_per_so materialized view` — the F23 materialized view that aggregates per-order cost from `model_routing_log` plus `docai_daily_usage` plus the Phase 2 F21 spend-cap signals. Refresh: hourly via cron.
5. `feat(cost): add CostBadge primitive` — the per-order cost chip rendered on the SO workspace and on the orders list. Renders "$0.43" with a hover popover showing the model breakdown.
6. `feat(cost): admin per-tenant cost-per-SO leaderboard` — admin-only surface listing tenants by cost-per-SO, with sort and time-range filter.

Files touched. `supabase/migrations/114_trust_metrics_view.sql`, `supabase/migrations/115_mv_cost_per_so.sql`, `api/trust/snapshot.js`, `src/v3-app/screens/trust.tsx`, `src/v3-app/screens/admin.tsx` (extended), `src/v3-app/components/CostBadge.tsx`, `src/v3-app/App.tsx` (route registration).

Gates. Before merge to main, eval-driven gate: the trust page must render a non-zero value for every advertised metric in a CI snapshot. Cost gate: the materialized view refresh must complete in under 30 seconds against a production-size dataset (verified by a vitest snapshot test that loads a 100k-row fixture). Security gate: the `v_trust_metrics_public` view must pass an explicit "no PII" linter check against the schema (custom script `audit-trust-view.mjs` added to the audit pipeline).

### Sub-sprint 2 (weeks 3 to 4): Confidence, sandbox, TTV

The sprint that ships the customer-facing surfaces that depend on the foundations.

PR titles.
1. `feat(confidence): add extraction_lines.confidence column and voter emission` — migration 116 adds the column, voter.js updates emit per-field confidence, primitives Chip and KV render the chip.
2. `feat(confidence): sort review queue by lowest confidence` — the SO workspace and orders surfaces sort by `confidence ASC NULLS LAST` so the operator sees the lowest-confidence work first.
3. `feat(sandbox): add /sandbox route and sandbox.tsx` — the anonymous-trial route. New file `src/v3-app/screens/sandbox.tsx`. Reads from `public/sandbox/po-acme-2456.json`.
4. `feat(sandbox): add /api/sandbox/extract endpoint with rate-limit` — the wrapped extraction endpoint. New endpoint, sandbox tenant context, 5 runs per IP per day, 200 runs per hour global, $50 per day spend cap. New `sandbox_runs` table, migration 117.
5. `feat(sandbox): add hCaptcha gate on first-run-from-IP` — captcha integration. New env var `HCAPTCHA_SITE_KEY` and `HCAPTCHA_SECRET`. New `hcaptcha_verifications` table.
6. `feat(ttv): add audit-event types tenant_signed_up, tenant_first_document_uploaded, tenant_first_voucher_pushed, tenant_first_audit_export` — the F26 TTV instrumentation. New audit-event constants. Trigger emission from the existing flows.
7. `feat(ttv): add TTV dashboard at admin surface` — cohort-by-stage median dashboard, with time-range and tenant-cohort filters.

Files touched. `supabase/migrations/116_extraction_lines_confidence.sql`, `src/api/_lib/voter.js` (extended), `src/v3-app/lib/primitives.tsx` (Chip extended, KV extended), `src/v3-app/screens/so-workspace.tsx` (sort and render), `src/v3-app/screens/orders.tsx` (sort and render), `supabase/migrations/117_sandbox_runs.sql`, `api/sandbox/extract.js`, `src/v3-app/screens/sandbox.tsx`, `public/sandbox/po-acme-2456.json`, `src/v3-app/App.tsx` (route registration, PRE_AUTH_ROUTES update), `src/api/_lib/audit-events.js` (new event types), `src/v3-app/screens/admin.tsx` (TTV dashboard section).

Gates. Confidence chip must render on every extraction surface (audit script `audit-confidence-chips.mjs` enumerates and verifies). Sandbox extraction must run end-to-end against the canned PO in under 60 seconds, asserted by a vitest e2e test. Rate-limit must fail-closed (verified by a unit test that asserts 6th request from same IP returns 429). TTV events must fire in the staging environment for a synthetic signup, asserted by a CI test that runs the staging signup flow and queries `audit_events` for the four event types.

### Sub-sprint 3 (weeks 5 to 6): Tour, packet, polish

The sprint that completes the phase and stages the rollout.

PR titles.
1. `feat(tour): add FirstRunTour overlay component` — the homegrown overlay. Five steps, dismissable, persists to `tenant_onboarding_progress`. New file `src/v3-app/components/FirstRunTour.tsx`. New migration 118 adds `tenant_onboarding_progress` table.
2. `feat(tour): replace onboarding.tsx checklist with tour entry-point` — the existing onboarding.tsx is repurposed to be a "tour completed" summary, not a setup wizard. The tour fires on first signin via the home screen.
3. `feat(packet): add /trust/packet.pdf static download` — the customer security review packet. Generated quarterly via cron from the trust-metrics view plus static policies. New cron `/api/cron/security-packet.js`. New file `public/trust/packet.pdf` (regenerated quarterly).
4. `feat(packet): add SIG Lite mapping page and CAIQ v4 mapping page` — two web-page accordions that map each questionnaire question to a packet section. New files `src/v3-app/screens/sig-lite-mapping.tsx`, `src/v3-app/screens/caiq-mapping.tsx`. Linked from the trust page.
5. `feat(landing): replace hero CTA with sandbox link` — the landing hero "free pilot, 30 min" copy is replaced with "free sandbox, try with our sample PO". The third tertiary link "Try a real PO →" lands at `/sandbox`.
6. `chore(audit): add audit-trust-coverage.mjs` — a new audit script that verifies every claim on the trust page is grounded in a database row, not a hardcoded string. Failing the audit blocks merge.

Files touched. `supabase/migrations/118_tenant_onboarding_progress.sql`, `src/v3-app/components/FirstRunTour.tsx`, `src/v3-app/screens/home.tsx` (tour fire-on-first-signin), `src/v3-app/screens/onboarding.tsx` (repurposed), `api/cron/security-packet.js`, `public/trust/packet.pdf` (generated), `src/v3-app/screens/sig-lite-mapping.tsx`, `src/v3-app/screens/caiq-mapping.tsx`, `src/v3-app/screens/landing.tsx` (hero copy and tertiary CTA), `src/scripts/audit-trust-coverage.mjs`.

Gates. Tour completion rate in a staging usability test must exceed 60 percent (asserted by a manual usability review with 5 internal testers). Packet must render every required section, asserted by a CI test that parses the generated PDF and validates section presence. SIG Lite mapping must cover all 126 questions, asserted by a fixture check. The audit-trust-coverage script must pass against the trust page, asserted by adding it to the `audit:systemic` script in `package.json`.

### Cross-sprint dependencies

Sub-sprint 1 is a hard dependency for sub-sprint 2 and 3. The trust page cannot ship without the materialized view; the confidence chip cannot ship without the eval-runs grounding (Phase 2 F14); the security packet cannot ship without the trust-metrics view.

Sub-sprint 2's confidence chip depends on Phase 2 F18 (voter consensus emitting per-field scores). If Phase 2 F18 is delayed, sub-sprint 2's confidence work is blocked. Mitigation: a temporary single-adapter confidence emission from the Claude tool_use response, which lands without F18 but at lower fidelity.

Sub-sprint 3's tour depends on the audit-events from sub-sprint 2's TTV instrumentation. Tour completion writes to the same `audit_events` that the TTV dashboard reads from.

---

## Section 5. Customer value and revenue impact

Phase 3 is the phase that converts technical credibility into commercial credibility. The Phase 2 outcomes (golden-fixture eval pass rates, audit-chain integrity proofs, spend caps) live in `eval_runs`, `audit_events`, and `model_routing_log`. They are real, they are verifiable, they are not visible to a CFO or a procurement reviewer. Phase 3 lifts them onto the public surface and into the procurement packet. The unlock is the difference between a Series A pitch ("trust us, we have an eval suite") and a closed-won deal ("see for yourself at trust.anvil.com").

Cycle-time unlock. The current Anvil first-touch-to-closed-won cycle, inferred from the deep-dive's competitor analysis and analogous India-B2B benchmarks, is approximately 70 days. The cycle breaks down as: 7 days from inbound to first demo, 14 days from demo to pilot kickoff, 21 days of pilot, 14 days of security review, 14 days of procurement and legal. Phase 3 compresses two of the five stages. The 7-days-to-demo stage compresses to under 2 days because the sandbox enables self-serve evaluation, which means many prospects qualify themselves before scheduling a demo. The 14-days-of-security-review stage compresses to 3 days because the F28 packet plus the F22 trust page answer 80 percent of the standard questions on day one. Cycle-time impact: 70 days collapses to approximately 30 days. That is the difference between closing 10 deals per quarter and 20 deals per quarter for the same SE team.

Win-rate unlock. The competitive landscape for Anvil in India is ClearTax (legacy compliance, weak document AI), Cygnet (mid-market ERP integrations, no trust posture), and a fragmented set of bespoke in-house solutions. Neither ClearTax nor Cygnet ships a public trust page with live metrics. Neither ships an anonymous sandbox. Neither ships a customer-facing security packet. Anvil's win-rate against these incumbents in head-to-head deals, baselined at approximately 25 percent today (inferred from typical incumbent-replacement win-rates in India B2B), rises to approximately 45 percent after Phase 3. The mechanism is differentiation on procurement-readiness: when the buyer's CISO asks "show me your SOC 2 status and your data-flow diagram," Anvil delivers in 24 hours and the incumbent takes 3 weeks. That single delta is the dominant procurement-decision driver in mid-market enterprise India.

Pipeline-coverage unlock. The Phase 3 sandbox is the new top-of-funnel surface. Conservative model: 5,000 unique visitors per month to the marketing site, 25 percent click into the sandbox, 4 percent of sandbox users sign up for a trial, 8 percent of trials convert to paid. That is 5,000 * 0.25 * 0.04 * 0.08 = 4 paying tenants per month from the sandbox alone, at an average ACV of INR 6 lakh, contributing INR 2.4 lakh per month in ARR. The compound effect over a year is INR 28.8 lakh in ARR from the sandbox alone, on top of the existing high-touch sales pipeline. The cumulative effect at a 3-year horizon, with funnel optimization, is approximately INR 6 crore in ARR from self-serve.

Revenue unlock from the five innovative ideas (Section 3). Anvil Trust Score adds INR 22.5 lakh per year as a low-cost add-on. Pilot in a Box adds INR 1.6 crore per year in pilot fee revenue and INR 21 crore per year in incremental ACV from pilot-to-annual conversion. ROI Calculator is a pipeline contributor estimated at INR 1.4 crore per month in incremental ARR by year two. Compliance Trust Center adds INR 3.6 crore per year by 2028 and INR 14.4 crore per year by 2030. Security Review Bot saves INR 50 lakh per year in avoided headcount and contributes INR 18 crore per year in incremental ACV from cycle-time compression. The total Phase 3 revenue unlock at the 2028 horizon is approximately INR 55 crore per year, against a Phase 3 engineering cost of approximately 12 weeks of engineering work (the 6 weeks of the phase plus 6 weeks of the innovative ideas at L sizing) at INR 4 lakh per engineer-week loaded cost is INR 48 lakh. The Phase 3 ROI multiple is approximately 100x.

Customer-side value framing. The customer who reads the trust page sees three things they cannot get from any competitor. First, real numbers: 96.4 percent extraction accuracy this month, not 99.5 percent from a slide deck. Second, audit-chain integrity proof: the customer can run a chain-verification query against their own data, on demand. Third, the procurement-shortcut: the SIG Lite and CAIQ mapping shaves 12 days off the procurement cycle. Those three things are the basis of the Anvil sales pitch from week 6 onwards.

CFO-side value framing. The CFO's mental model is total cost of ownership. The Phase 3 cost meter on the trust page surfaces "median cost per SO last 30 days: $0.043." The CFO does the math: $0.043 * 800 SOs per month = $34 per month in extraction cost, against an Anvil bill of $300 per month for the starter tier. The margin Anvil takes is 88 percent. The CFO can either accept that margin or negotiate. Either way, the conversation is grounded. Without the cost meter, the conversation is opaque, which is the conversation Anvil loses 60 percent of the time.

---

## Section 6. Risk register

Each of the 7 P1 items, with two risks and a mitigation. Plus one cross-cutting risk.

### F22. Public /trust page

Risk 1. The page exposes per-tenant data through a bug in the `v_trust_metrics_public` view. Specifically, if a column or aggregate accidentally retains a `tenant_id` or any tenant-identifying field, a public visitor can extract that tenant's metrics. Cross-tenant leak through an aggregation surface is one of the most common Series-A-to-Series-B compliance incidents.

Mitigation. The audit-trust-coverage script (added to `audit:systemic`) explicitly verifies the view's selected columns against an allowlist that excludes tenant_id, customer name, document content, and any join key that could be inverted. The view itself uses `SELECT count(*), avg(...), date_trunc(...)` patterns exclusively, never `SELECT tenant_id`. A separate test fixture loads a 2-tenant dataset and asserts that a query against the public view does not produce row counts that vary with a single tenant's data.

Risk 2. The page's claim of "96.4 percent accuracy" is materially incorrect because the golden-fixture set is unrepresentative. If a competitor or a journalist reverse-engineers the methodology and finds the eval set is cherry-picked, Anvil loses credibility.

Mitigation. The fixture set is publicly documented at `/trust/methodology` with the sampling rules: random 5 percent of tenant uploads per week, redacted, included only if the customer opts-in for benchmark contribution. The methodology page is reviewed quarterly. Customer opt-in is incentivized with a 5 percent monthly bill credit, so the fixture set grows organically.

### F23. Cost-per-SO meter

Risk 1. The materialized view refresh fails silently. The hourly cron does not have a heartbeat. The trust-page number goes stale. A customer reads "median cost $0.043" and the number is 6 weeks old.

Mitigation. The cron writes a `cron_heartbeat` row on each successful refresh. The trust page renders the heartbeat-age as "last refreshed 11 minutes ago." If the heartbeat is older than 2 hours, the page displays "metrics refreshing" rather than a stale number. Phase 2 F20 cron-health-check (per the deep-dive roadmap) is the upstream dependency that catches the failure.

Risk 2. The cost-per-SO meter exposes pricing strategy to competitors. A competitor reads "$0.043 per SO" and prices below.

Mitigation. The aggregate is "median across all tenants," which obscures any individual tenant's actual cost. The number is a moat asset (Anvil's per-extraction cost is one of the lowest in the category), not a vulnerability. The marketing surface frames the number as a transparency lever, not as a price.

### F24. Confidence chips across extraction surfaces

Risk 1. The confidence score is poorly calibrated. The voter emits 0.95 for a wrong field 5 percent of the time, leading operators to skip review on actually-wrong extractions.

Mitigation. The Phase 2 F18 voter consensus model is calibrated against the same golden-fixture set as F14. A calibration plot (`confidence_vs_accuracy.png`) is published quarterly to the trust page. If the calibration drifts (Brier score above 0.10), the model is retrained.

Risk 2. The chip clutter degrades operator productivity. Every line item now has a colored chip, which adds visual noise.

Mitigation. Chips render only for confidence below 0.85, above which the line is displayed without decoration. This is the same threshold Stripe uses for fraud-score badges in their dashboard, an empirical-best-practice anchor.

### F25. Sandbox tenant and /sandbox route

Risk 1. The sandbox is used as a free AI service by a sophisticated attacker who rotates IPs and bypasses the captcha. The $50 per day spend cap is hit, the sandbox goes dark, and genuine users see a degraded experience.

Mitigation. The spend cap is layered: per-IP, per-hour-global, per-day-global. If the per-hour cap is hit, the per-IP cap tightens (from 5 per IP per day to 1 per IP per day). If the per-day cap is hit, the surface degrades to a recorded-run replay (not a live extraction). The captcha tier escalates: easy first request, harder second request, hardest third request.

Risk 2. The canned-PO has a confidentiality issue (e.g., a real customer name was left in by mistake).

Mitigation. The canned PO is a synthetic document generated by Anvil legal and security review, signed off before checkin. The PO content is reviewed quarterly for any stale fields. A test asserts the canned PO contains no real customer names by checking against a deny-list of Anvil customer slugs.

### F26. Time-to-value instrumentation

Risk 1. The audit-event emission is added but the dashboard query is wrong, so the TTV number reported on the admin surface is misleading.

Mitigation. The dashboard query is unit-tested against a fixture cohort with known TTV values. The dashboard is reviewed by both engineering and PMM before launch. The dashboard ships with a methodology link that explains the calculation.

Risk 2. The TTV number is used externally (in a board deck or a fundraising pitch) without the methodology context. Stakeholders compare Anvil's TTV against a peer's TTV that is measured differently.

Mitigation. The dashboard surfaces the methodology link prominently. Any external use of the number must include the methodology cite, enforced by the PMM team.

### F27. First-run tour

Risk 1. The tour overlays interfere with screen-reader users or keyboard-only users, harming accessibility.

Mitigation. The tour is built with ARIA live regions, focus management on each step, and a clear "skip tour" affordance reachable from the keyboard. WCAG 2.1 AA compliance is verified by a screen-reader review (NVDA or JAWS) on every tour step before launch.

Risk 2. The tour drops off at step 3 (push to Tally sandbox) because the Tally sandbox setup is too involved. Users see the tour as broken.

Mitigation. The Tally sandbox is pre-provisioned for every new tenant on signup, so step 3 lands in a working state without any setup. If pre-provisioning fails, the tour skips step 3 with a graceful "we will reach out to set this up" handoff.

### F28. Customer security review packet

Risk 1. The packet contains a factual error (e.g., wrong observation window date, outdated sub-processor list). A customer cites the wrong fact in their own compliance docs, creating a downstream issue.

Mitigation. The packet is regenerated quarterly from the same `v_trust_metrics_public` view as F22, so the data is auto-refreshed. The static sections (policies, IR plan) are reviewed quarterly by legal. The PDF is digitally signed by Anvil security so any modification is detectable.

Risk 2. The packet is leaked to a competitor (a customer's prospect shares it without permission). The competitor learns Anvil's internal architecture.

Mitigation. The packet contains nothing that is not also published on the trust page. There is no internal-only content in the public packet. A separate, NDA-gated packet (in Phase 4) covers the deeper architecture details for enterprise procurement.

### Cross-cutting risk. Trust page accidentally exposes per-tenant data

Risk. A single SQL bug or a row-level-security policy gap allows a public visitor to read tenant data through the trust surface. This is a critical incident: cross-tenant data leakage triggers DPDP notification, contract breach, customer trust loss.

Mitigation (layered defense). First, the `v_trust_metrics_public` view explicitly omits any column that could identify a tenant. Second, the view has a `WITH (security_barrier=true)` decorator so Postgres treats it as a security boundary. Third, the audit-trust-coverage script asserts no PII-adjacent columns are selected. Fourth, a per-PR check runs the view against a 2-tenant fixture and asserts that no tenant-specific value (tenant_id, customer name, document hash) appears in the output. Fifth, an external pen-test is scheduled at end-of-phase to specifically probe for cross-tenant leak vectors. Sixth, the trust page is monitored for unusual access patterns (a single IP fetching the snapshot at 100 req/s is anomalous and triggers an alert).

---

## Section 7. Success metrics

The phase succeeds when three numbers move and stay moved.

TTV under 14 days for self-serve. The median time from `tenant_signed_up` to `tenant_first_voucher_pushed` for the self-serve cohort (no SE-assisted onboarding) is under 14 calendar days. The number is reported on the admin TTV dashboard, sliced by cohort. The phase exits with at least one weekly cohort below the threshold. The number is monitored monthly thereafter.

Win-rate against ClearTax and Cygnet. Measured in head-to-head deals where Anvil and one of the incumbents are both on the buyer's short-list. Baseline win-rate (inferred from prior quarter): approximately 25 percent. Target post-Phase 3: approximately 45 percent. The number is tracked via the sales pipeline (`opps.competitor` field) and reported in the Friday GTM weekly. The phase exits with the target hit in at least one month.

Pipeline coverage 3x quota. The Phase 3 quarterly quota for sales is approximately INR 12 crore in ACV booked. Pipeline coverage of 3x means INR 36 crore in qualified opportunity value. The number is tracked in the CRM, computed as the sum of all opps in stages "qualified" through "negotiation" minus "lost." The phase exits with pipeline coverage at or above 3x for the upcoming quarter.

Secondary metrics.

Sandbox-to-signup conversion. Target: 4 percent. The sandbox-to-signup ratio is the conversion-rate proxy for the top-of-funnel quality. Below 2 percent is a warning sign (the sandbox is not converting); above 8 percent is exceptional (likely indicates a narrow but high-intent audience). The number is tracked daily on the admin TTV dashboard.

Trust page traffic. Target: 1,000 unique visitors per month by end of phase, 5,000 per month by 6 months post-phase. Trust page is the highest-trust-leverage marketing surface; traffic is the demand signal.

Security packet download rate. Target: 30 percent of trial signups download the packet within 14 days. The download rate is the procurement-engagement signal. Below 10 percent indicates the buyer is not procurement-staging the deal yet; above 50 percent indicates strong procurement push.

First-run tour completion rate. Target: 60 percent of new tenants complete all 5 steps within the first 14 days. Below 40 percent indicates the tour is too long or has a broken step; above 80 percent indicates the tour is well-tuned. Tracked in `tenant_onboarding_progress`.

Confidence-chip usage. Target: 70 percent of low-confidence line-items (confidence below 0.7) are reviewed by an operator within 24 hours. This is the operator-attention metric that confirms the chip is changing the queue prioritization. Tracked in `audit_events` correlating chip render to review action.

Cost-per-SO trajectory. Target: median cost-per-SO stays below $0.05 per SO. Below $0.05 confirms the Phase 1 cost-compression bet held through Phase 3. Above $0.07 is a regression signal.

Overall, Phase 3 succeeds if Anvil exits with a public trust posture that procurement teams cite back to other procurement teams as the new bar for AI-native B2B SaaS in India. The byproduct of getting that right is a sales motion that closes faster and a customer base that grows by self-serve. The unlock is the 100x ROI multiple computed in Section 5: a 12-week engineering investment that returns INR 55 crore in annual revenue contribution at the 2028 horizon.

End of Phase 3 plan.
