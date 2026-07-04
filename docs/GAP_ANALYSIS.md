# Anvil, Gap Analysis and Roadmap

Date: 2026-05-04
Scope: codebase audit of `Anvil-main`, 11-company competitive scan, gap matrix, prioritized roadmap, consolidation plan for Smartbase / Korso / Lumari.

> **Superseded.** This is the original internal gap analysis. The current
> source of truth, including a competitor-mapped 18-month plan and the
> grouped-by-shared-infrastructure phasing, is `docs/IMPROVEMENT_PLAN.md`.
> Everything below this banner is retained as historical context for the
> matrices and competitor research.

> **Status note (2026-05-04, post-execution pass).** All eleven
> Now-block items have shipped on `main`. The doc is preserved
> verbatim from the initial audit so the matrices + competitive
> analysis are still readable as a snapshot of where we started.
> The Now/Next/Later tables at the bottom show the as-of state.
>
> Shipped Now items:
> - Outcome meter (Later #26 -> Now #10): public price card in
>   `docs/BILLING_OUTCOMES.md`, aggregator `/api/billing/usage`.
> - Autonomous agent v1 (Now #5): hourly cron, three goal types,
>   append-only step audit, Quality > Agents tab.
> - WhatsApp ingestion (Next #14 -> Now #11): Twilio + Meta.
> - Brand cleanup (Now #6): full Obara to Anvil rename with
>   read-fallback migration; runbook in `docs/MIGRATING_BRAND.md`.
> - SendGrid email (Now #7): provider abstraction in
>   `communications/send.js`.
> - Quote PDF (Now #2): server-side `@react-pdf/renderer`,
>   download + 7-day share link.
> - Invoicing (Now #3): generic `invoices` table alongside
>   `einvoices`, atomic per-tenant numbering, full status
>   lifecycle, PDF reusing the quote renderer.
> - Stripe Connect (Now #8): Express accounts per tenant,
>   onboarding + checkout + webhook flipping invoices to paid.
> - AR loop completion (Now #4): agent v1's ar_collect handler
>   now reads either `invoices` or `einvoices`; queued-comms
>   reaper inside `/api/agents/run` fires email per cron tick.
> - NetSuite connector (Now #1): TBA auth, 30-minute sync cron,
>   manual SO push, per-tenant credentials on `tenant_settings`.
> - Mobile shell (Now #9): viewport-driven layout swap below
>   768px, bottom tab bar with five primary tabs, PWA manifest +
>   iOS web-app meta tags.
>
> The matrices + Now/Next/Later tables below have been amended
> in-place where shipped work changed the picture. Original
> priority numbers are preserved so this doc keeps tracking against
> its own targets.

---

## 1. Executive summary

Anvil today is **a serious, multi-tenant, India-anchored sales-ops execution system** wearing the marketing skin of a generic AI-native quote-to-cash platform. The codebase is mature: 80 serverless functions, 72 Postgres tables, 35 wired React/TS screens, multi-tier model routing, prompt-injection firewall, PII redaction, Tally + GSTN integrations, and a real audit trail on every action. It is not a marketing prototype.

The mismatch is **scope vs. positioning**. The pitch claims "RFQ → quoting → approvals → order entry → invoicing → payment collection with autonomous follow-up agents and deep ERP sync." The implementation is strong on the front half (intake, extraction, quoting, approvals, orders, supplier procurement) but thin on the back half (no native invoicing outside India GSTN, no payment collection, no AR dunning, no autonomous outbound agents). It also has zero non-Tally ERP connectors, which every serious competitor leads with.

**Anvil's actual moats** — not surfaced in the marketing pitch — are the things competitors don't have: spare-matrix recommender, supplier scorecard for Korea/Japan/China imports, AMC / CAR / service-visit module, customer format-profile versioning, evaluation harness, master-data graph, and the India-compliance stack (Tally + GSTN). These should not be erased while chasing parity.

The competitive set splits into four camps:
- **Full QTC competitors**: Pactle (Slack-native, broadest ERP coverage), Mercura (deepest CPQ, voice AI, 10+ ERPs), Arzana (OES with built-in ERP).
- **Inbox-to-ERP order entry**: Comena, Axal, Smartbase. Narrower than Anvil.
- **RFQ/quoting niche**: Soff (fasteners), Korso (multi-channel), Avent (sales-call transcription).
- **Adjacent**: Lumari (procurement, supplier-side), Raven (plant-floor OEE, not QTC at all).

The core strategic decision is whether Anvil keeps the India + industrial-distributor anchor and adds the missing back-half modules and a few signature ERP connectors, or pivots to chase Mercura/Pactle on a horizontal global play. The roadmap below assumes the first path because the codebase is already shaped that way and the moats compound.

---

## 2. Anvil today — codebase audit

### Stack and shape

- Vercel serverless (Node 20) + Supabase Postgres with RLS on every business table.
- 80 API endpoints across 31 resource groups under `src/api/`. All syntax-clean per the `npm run check` script.
- 10 SQL migrations, 72 tables, 13 enums, 177 indexes (per repo audit script output cited in `docs/V3_ROUTE_CONTRACT.md`).
- Two shells: legacy 4756-line single-page HTML (`src/legacy/obara-ops-v11.1.html`) and the active v3 Vite + React + TypeScript app under `src/v3-app/`. The marketing site at anvil-flame.vercel.app serves the v3 build verbatim.
- 35 v3 screens, all wired to live data via the `ObaraBackend.*` client.
- Auth: Supabase magic link, 7-role RBAC (`docs/RBAC.md`), tenant isolation via `_lib/tenancy.js` and explicit `tenant_id` filters on every query.
- AI: Anthropic Claude with three-tier routing (Haiku for preflight, Sonnet for extraction, Opus for complex reasoning), persisted in `model_routing_log`. Includes a prompt-firewall preamble against injection from untrusted document content and PII redaction (credit card, Aadhaar, PAN, plus tenant-scoped regex rules).
- OCR: Mistral OCR.
- AV: optional ClamAV via REST proxy.
- Crons: FX rates daily, AMC visit auto-generation daily.

### Module inventory (what's actually built)

The live module surface, mapped from `src/v3-app/routes.ts` and `docs/V3_ROUTE_CONTRACT.md`:

**Workflows.** Inbox/intake (`/intake`), Sales Order list/intake/workspace/history (`/so`), Internal SOs (FOC, warranty, trial, expected, transfer), Approvals queue.

**Sales.** Leads, Opportunities, Projects (with phase log), Shipments.

**Procurement.** Source POs (list, detail, ack, supplier scorecard), Spares Matrix (recommend, kit, opportunities, obsolete-parts).

**Service.** Service Visits, AMC schedules with auto-generation cron, CAR (Corrective Action Report) + Closure Reports.

**Finance.** Tally Push, Tally Masters, Tally Reconcile, e-Invoice (GSTN IRN/QR lifecycle), Cost & Margin (breakdown + simulator + margin history with FX-aware INR/USD cost policy).

**Data.** Customers + customer locations + customer format profiles + version rollback, Items + part aliases + UOM aliases, BOM Import (XLSX origin auto-detect), Guns Viewer, Equipment Hierarchy, NRD importer, Master Data Graph (Cytoscape view), Forecasts.

**Quality.** Eval Suites (cases, runs, dashboard), Profile Studio (fingerprint diff), Anomaly compute, Duplicates search.

**Comms & Security.** Communications (draft, send, missing-doc requests), Email triage from inbound webhook, Security (redaction rules, injection test runs, model routing log).

**Admin.** Members, holidays, lead times (customer + supplier), FX rates, quote-approval thresholds, lost reasons, contracts (ARC / Blanket / AMC), customer locations, equipment, item master with CSV bulk import, diagnostics.

### What works (verified from code, not docs)

The following are wired end-to-end:

- **Email-to-draft-order pipeline.** `api/email/inbound.js` accepts SendGrid/Mailgun/Postmark/SES envelopes, persists attachments to Supabase Storage, classifies intent (`po_revision`, `quote_request`, `status_request`, `purchase_order`, `other`) by simple regex over subject + body, attempts to bundle with an existing DRAFT order from the same email thread within a 7-day window, tags each document with a role (`quote`, `price_composition`, `purchase_order`), and emits an audit + processing event. Token-gated, refuses to start if `EMAIL_INBOUND_TOKEN` is unset. Tenant comes from a trusted header, never the body.
- **Multi-tier AI extraction with safety rails.** `api/claude/messages.js` handles all model calls. Routes by `tier` or `purpose`, applies the firewall header, redacts PII before send, supports extended cache-TTL beta header, retries on 408/425/429/5xx with backoff, and logs every routing decision.
- **Cost simulator.** Five named scenarios (full-Sonnet, Haiku-preflight + Sonnet, template dry run, cached duplicate, Opus complex fallback) with per-scenario token estimates, FX-aware USD→INR projection. Genuinely useful for sales operators evaluating margin sensitivity.
- **Approvals.** `quote_approval_thresholds` table + per-customer overrides + delegation, surfaced through `/approvals`.
- **Source PO scorecard.** Supplier performance aggregated by `source_pos.country` (Korea/Japan/China/India). Distributor-specific feature.
- **Spare matrix.** Recommend, kit, opportunities, obsolete-parts endpoints; full worksheet UI shipped (Phase 7.1).
- **Tally integration.** Push voucher, amend (with idempotency keys), reconcile, masters seed, validate. Failure-mode handling (`FAILED_TALLY_IMPORT` order status).
- **GSTN e-Invoice lifecycle.** `DRAFT → PENDING_GSTN → GENERATED → CANCELLED / REJECTED`, IRN + QR persisted on the row.
- **AMC autogen cron.** Generates upcoming visits per contract frequency at 05:00 UTC daily.
- **Audit and processing events on every business action.** `_lib/audit.js` is called from nearly every endpoint. The communications timeline merge in SOWorkspace.Activity proves it.

### What is partial, stubbed, or known-flaky

Per `docs/ROADMAP.md` and code spot-checks:

- **`HomeManager` and `HomeAdmin` role-tailored dashboards** were never wired to live data; every role currently lands on `WiredHomeEngineer`. Tracked as a follow-up.
- **`SOList` "Mine" tab** falls back to "match all" because user identity isn't yet plumbed to orders.
- **GSTN integration is conditional.** Without `GSTN_API_URL` + `GSTN_API_KEY`, e-invoices stay in `PENDING_GSTN`; the operator can compose but not generate IRN.
- **Comms provider is a generic webhook.** Without `COMMS_PROVIDER_URL`, drafts are marked `manual` — there is no built-in transactional email/SMS provider integration. No SendGrid SDK, Twilio SDK, etc.
- **Mobile shell exists in `screens-mobile.jsx` design source but is not wired** in the v3 build. Roadmap item.
- **No real-time updates.** Planned via Supabase Realtime; not shipped.
- **No native ERP connector other than Tally.** Tally is India-specific. There is no NetSuite, SAP, QuickBooks, Salesforce, Epicor, Infor, Dynamics, Acumatica, Oracle, or Sage connector code in the repo. This is the single largest gap against every competitor in the set.
- **No payment collection.** No AR aging table, no dunning workflow, no payment provider integration (no Stripe, Razorpay, Adyen, etc.). The pitch claims "payment collection" — the code does not deliver it.
- **No autonomous follow-up agents.** Communications has `draft`, `send`, `missing_doc` endpoints — these are operator-triggered, not autonomous. There is no scheduler, no agent loop, no goal-driven outreach. The "autonomous follow-up agents" claim is aspirational, not built.
- **Lost-reason taxonomy + lost-reason picker on Opportunities** exists; analytics on lost-reasons does not.
- **Quote PDF generation** is not visible in the API set. Quotes are objects in the database; no observable rendering pipeline (no `puppeteer`, `playwright`, `react-pdf`, `pdfkit` in `package.json`).
- **No e-signature flow.** No DocuSign, Dropbox Sign, Adobe Sign, or PandaDoc integration.
- **No CRM activity/sequencing layer.** Leads and Opportunities tables exist; there's no notion of "a sequence of touches with timing."
- **No customer-facing portal.** Every screen in the v3 routes table is internal-operator-only. Customers cannot self-serve to upload a PO, see a quote, see invoice status, or pay.
- **Project/Opportunity stage enums drifted** between legacy and v3 (per Roadmap §7.7), partially migrated.
- **Granular features known incomplete from `docs/ROADMAP.md`**: bulk actions on SO list, saved filters, browser push, Slack webhook, weekly digest, snooze on findings, native quick-keys, real-time presence in Cmd+K.

### What is heavily India-specific (will need work to globalize)

- Tally is India-only. Tally Masters / Push / Reconcile / Amend / Validate is dead weight outside India.
- GSTN e-Invoice is India-only.
- Default currency, locale, and label conventions assume INR + en-IN. The cost simulator hardcodes INR display.
- Holiday calendar is seeded with Indian holidays.
- PII redaction patterns include Aadhaar (Indian national ID) and PAN (Indian tax ID). These are correct but signal the operating assumption.
- Customer seeds are all Indian: Vega Motor (Halol + Haryana), Comet Motors, NRD Auto, WGX, Alliance Auto India, ABC Motors.
- Domain language: "guns" (welding guns), CAR, AMC, FOR/HSS shipping modes, OIQTLC quote prefixes — all reflect Obara India terminology.

The `Anvil` rebrand in `package.json` is a thin layer; `obara-client.js`, `obara-ops-v11.1.html`, the `obara-documents` storage bucket, and substantial inline copy still say Obara. **This is a credibility risk for any prospect outside the Obara use case** and a non-trivial cleanup task.

---

## 3. Per-competitor analysis

### 3.1 Smartbase — `smartbase.so` (consolidation target)

One-liner: "Automated PO entry for manufacturers." Turns emailed and handwritten POs into ERP-ready data.

ICP: Manufacturers with manual PO entry. SMB to mid-market US.

Capability surface: email-inbox connection, PDF + scanned + handwritten ingestion, AI extraction with custom business rules, dashboard review/approval, ERP order export, traveler document printing.

Integrations: not surfaced on site.

Maturity: YC S25, very early (first customers as of late 2025), five-figure annual contracts.

Relevance to Anvil: covers a subset of what Anvil's intake + email-inbound + extraction stack already does. Their handwritten-PO claim is the only signal that they may have done extra OCR work specifically for handwritten artifacts; Anvil uses Mistral OCR which handles printed but is weaker on handwriting. **Consolidation: absorbed cleanly. Anvil already does 80% of this; the remaining 20% is the handwriting wedge.**

### 3.2 Korso — `korsoai.com` (consolidation target + competitor)

One-liner: "The intelligence layer for manufacturing." Two products: Atlas (quoting / RFQ automation) and Hermes (supplier communication).

ICP: Manufacturers and industrial distributors. Custom pricing.

Capability surface: email + WhatsApp + document ingestion, AI quoting, RAG-powered quote-lookup assistant, PO generation/management, supplier comms automation.

Integrations: not surfaced on site. SOC 2 Type 1, ISO 27001, GDPR all "in progress" per their own page.

Differentiator: **WhatsApp ingestion** for RFQ and supplier comms, modular two-product architecture, RAG over historical quotes for new-quote generation.

Maturity: YC-backed, no public customer logos, no integrations listed, security certifications still in progress.

Relevance to Anvil: Atlas overlaps quoting; Hermes is supplier comms which is genuinely additive. **Consolidation: absorb the WhatsApp ingestion channel and the historical-quote RAG pattern.**

### 3.3 Lumari — `lumari.io` (consolidation target)

One-liner: "The first AI supply chain platform for direct procurement." Autonomous agents handle RFQ → supplier communication → PO end-to-end.

ICP: implicit mid-market to enterprise direct-procurement teams.

Capability surface: limited public detail. Site is Framer-rendered, most subpages 404. RFQ → supplier identification + communication → PO management with human approval gates.

Integrations: not surfaced.

Maturity: very early. No customer list, no integrations, very thin public info.

Relevance to Anvil: Lumari is **buyer-side procurement**, the inverse of Anvil's seller-side QTC. The supplier-communication agent pattern is reusable but the user is the procurement team, not the sales-ops team. **Consolidation: borrow the agent loop pattern; do not collapse the personas — they are different buyers.**

### 3.4 Arzana — `arzana.com`

One-liner: "AI-Powered Office Automation for Manufacturers." Their pitch is an "Office Execution System (OES)" — agents that ingest, extract, validate, and execute office tasks.

ICP: Fortune 500 + fastest-growing US mid-market manufacturers and distributors.

Capability surface: RFQ → catalog match → pricing validation → quote generation, PO email/PDF → validation → ERP sync, vendor management, CRM updates. Built as five "agent building blocks" (email ingest, email send, document extraction via vision LLMs, record matching, agent orchestration).

Integrations: vague. Claims "integrates with existing email, ERP, and other systems"; no specific named ERPs. Their OES is itself a built-in ERP, which doubles as a moat (less integration work) and a liability (customers may want to keep their existing ERP).

Differentiators: 30–120 day deploys vs. 6–18 month traditional ERP, **outcome-based pricing per completed task** ($30k minimum annual), claimed 99.9% accuracy, custom AI model training on historical job costs.

Maturity: YC-backed, hiring "Founding Agents Engineer," real customer reference (Milltown Paper, 211k+ parts). Stronger product narrative than most competitors.

Relevance to Anvil: heavy overlap on RFQ → quote → order → ERP. Arzana's gap is the back half (no invoicing, no payments, no autonomous follow-up). Arzana's edge over Anvil: agent orchestration depth, named OES architecture, outcome-based pricing model.

### 3.5 Pactle — `pactle.co`

One-liner: "Close a deal. We'll handle the rest — right inside Slack."

ICP: Manufacturing operations teams managing QTC at scale.

Capability surface: RFQ capture from email/web, AI quote auto-generation + customization, approval routing, quote-to-order, production trigger, auto-invoicing, **automated payment reminders + collection follow-ups**, unified dashboard, ERP sync.

Integrations: **SAP, Oracle NetSuite, Epicor, Sage, Xero, QuickBooks, Ramco** — broadest coverage in the set.

Differentiators: **Slack-native execution** (quotes, approvals, invoicing happen inside Slack channels), pre-built approval workflows, single-dashboard QTC.

Maturity: thin public info, no customer logos, all subpages 404 — homepage is the entire site. Calendly-led demo flow suggests early GTM.

Relevance to Anvil: **most direct full-QTC competitor in the set.** Their stated capability list maps almost 1:1 to Anvil's pitch. Their Slack-native angle is genuinely different. Their ERP integration depth is exactly Anvil's largest gap. They likely don't actually have all those ERP integrations production-ready, but they list them on the homepage and Anvil cannot.

### 3.6 Comena — `comena.ai`

One-liner: "Less typing, more selling. Automated order entry."

ICP: Industrial distributors, MRO, parts/fasteners. Mid-market+. Founded by ex-Google + ex-AWS/HubSpot. YC S25.

Capability surface: PDF + Excel + email-body ingestion (including handwritten notes), header + line-item extraction, intelligent SKU matching from messy free-text product names, order-confirmation reconciliation against PO with discrepancy alerts, one-click ERP submit, optional human review, EDI support.

Integrations: not surfaced; references "ERP integration <2 weeks."

Differentiators: 75–99% time reduction claim, can run fully autonomous round-the-clock, very fast deployment.

Maturity: 2-person team, ~$220k revenue early-2025, German-language site primary.

Relevance to Anvil: pure inbox-to-ERP order-entry overlap. Anvil already does this. Comena's signal is the **EDI support** — Anvil has nothing on EDI, which still drives a meaningful chunk of large-distributor B2B.

### 3.7 Axal — `axal.ai`

One-liner: "AI Workers for Manufacturing and Distribution."

ICP: Middle-market manufacturers + distributors. YC W25.

Capability surface: ingest unstructured PO/RFQ/invoices from email, validate against pricing rules + customer records, detect pricing errors pre-entry, enter into ERP with no manual keying, **answer real-time product/pricing/availability questions by querying live ERP**, generate order acknowledgments, end-to-end in 2 minutes vs. 45 minutes manual.

Integrations: ERP-connected but not named.

Differentiators: 1-week time-to-live, claim of catching $4k pricing errors on day one, real-time ERP query as a chat surface.

Maturity: very early YC W25, founders from UMD CS.

Relevance to Anvil: order-entry overlap. Axal's distinctive capability is **the real-time ERP-query chat surface** — operators can ask "do we have stock of SKU-X?" and the system pulls live ERP data. Anvil has Master Data Graph but not a conversational query surface over live state.

### 3.8 Soff — `soff.ai`

One-liner: "Turn Lost Quotes Into Won Deals."

ICP: Fastener distributors, aerospace fastener firms. Documented customer (Fastener Dimensions) handles 1500 weekly RFQs.

Capability surface: high-volume RFQ ingestion, customer prioritization by strategic value, **autonomous follow-up agents** that operate while the team sleeps, quote routing.

Integrations: not surfaced.

Differentiators: vertical wedge in fasteners + aerospace, autonomous customer follow-up emphasized as the core agent claim.

Maturity: YC S24. Vertical-only positioning.

Relevance to Anvil: their **autonomous follow-up agent** is explicitly the thing Anvil claims to have but does not. Soff is the cleanest reference for what that agent should look like in practice (continuous loop, tier-based prioritization, off-hours operation).

### 3.9 Avent Industrial — `aventindustrial.com`

One-liner: "The all-in-one AI platform for distributors and suppliers."

ICP: Industrial distributors and suppliers, all sizes.

Capability surface: RFQ intake with shorthand + natural-language interpretation, multi-source data aggregation (ERP + CRM + catalogs), AI-driven email routing, **sales-call transcription with real-time guidance**, autonomous quote generation, real-time order validation against inventory + pricing, AI knowledge base capturing tribal knowledge.

Integrations: **NetSuite, SAP, Infor, Epicor, Dynamics 365, Salesforce.**

Differentiators: multi-layer AI architecture (Data, Integration, Knowledge, Action, Intelligence), sales-call transcription with real-time agent assist, second-generation industrial-distributor founder credibility.

Maturity: YC 2025, launched Aug 2025, no customer case studies yet.

Relevance to Anvil: Avent's **call transcription + real-time sales coaching** is genuinely additive and not present in Anvil. Their named ERP integration list is the second-broadest in the set after Mercura.

### 3.10 Mercura — `mercura.ai`

One-liner: "Quotes in minutes, not days."

ICP: HVAC, electrical, plumbing, construction supply chain. Mid-market+. Customers include Sanitär Heinze (1300+ employees), Bauder, Reisser AG, Siteco, BME Group. Europe-strong, expanding US.

Capability surface: ingest PDF + GAEB + email + Excel + BOQs (Bills of Quantities), extract product specs (descriptions, manufacturers, part numbers, quantities), **AI-match line items to internal catalog with spec-compliant alternatives + cross-sell recommendations**, BOM auto-generation from quote, configurable approval workflows, quote status tracking, **inbound voice AI agent for customer calls handling quotes + orders + accessory recommendations**, reinforcement learning with human feedback, dashboard analytics with win rates + competitor benchmarking.

Integrations: **SAP S/4HANA (OData/REST), Oracle NetSuite (REST, real-time), Salesforce Sales Cloud, Microsoft Dynamics 365 / Business Central, Epicor, Priority, Acumatica, Exact, Abas, Kerridge CS, QAD.** Most ERP coverage in the set.

Differentiators: deepest CPQ feature set, **GAEB format support** (European construction-tender standard), inbound voice agent, RLHF loop, spec-compliant alternative recommendation, accessory + private-label cross-sell during call. Performance claims: order error rate 4% → <0.2%, quote turnaround 3 days → <4 hours.

Maturity: seed €1.8M / $2.1M Feb 2025, YC W25, claims profitability before funding, named European customers.

Relevance to Anvil: **the most feature-mature competitor in the entire set.** Their voice agent, RLHF loop, GAEB parser, and 11-ERP connector list are the bar Anvil has to reach if it wants the manufacturing CPQ buyer who would otherwise pick Mercura.

### 3.11 Raven — `startraven.com`

One-liner: "Run plants faster and safer with AI."

ICP: Discrete manufacturing, food + beverage, medical devices, plant floor.

Capability surface: real-time operator assistance via smart-device HMIs, downtime tagging, OEE loss identification, machine + operator data fusion, vision + OCR. **Production-floor operations, not commercial.**

Integrations: not surfaced.

Maturity: YC S22, hiring fullstack + applied-AI roles.

Relevance to Anvil: **none for QTC.** Raven is a different problem class (plant-floor OEE / downtime / safety) — not quote-to-cash. Including it as a competitor is a category error from the user's reference list. The only interesting overlap is operator-assist UI patterns, which Anvil could borrow for the v3 home/inbox screens.

---

## 4. Cross-cutting themes from the competitor scan

Five things the competitors collectively prove are now table stakes:

1. **Named ERP integrations on the marketing site.** Mercura lists 11. Pactle lists 7. Avent lists 6. Anvil's website lists Tally. This is the most credibility-damaging visible gap.

2. **An "AI agents" frame, not "AI-powered" or "AI-assisted."** Every YC25 entrant uses agent language explicitly. Mercura, Avent, Arzana, Soff, Korso, Lumari, Comena, Axal all market specific named agents or agent workflows. Anvil's marketing-site copy uses agent language but the implementation has no autonomous agent loop.

3. **Multi-channel ingestion.** Email is universal. Mercura adds inbound voice. Korso adds WhatsApp. Avent adds sales-call transcription. Anvil supports email + manual upload only.

4. **Industry-specific wedges.** Soff = fasteners + aerospace. Mercura = HVAC + plumbing + construction. Comena = MRO + parts. Anvil = industrial distribution (Obara-style welding-gun spares). The vertical wedge approach is winning early.

5. **Outcome / per-task pricing is showing up.** Arzana explicitly. Implied by others. The seat-based SaaS model is being replaced for agent products by pay-per-completed-task pricing.

---

## 5. Feature × product matrix

Legend: **F** = full / production, **P** = partial / has the bones but not all of it, **N** = none / not in the product, **?** = not surfaced on site (assume N for buying decisions).

### Front-half: lead → quote

| Feature                                  | Anvil | Pactle | Mercura | Arzana | Comena | Axal | Soff | Avent | Korso | Smartbase | Lumari |
|------------------------------------------|-------|--------|---------|--------|--------|------|------|-------|-------|-----------|--------|
| Email-inbound RFQ + PO ingestion         | F     | F      | F       | F      | F      | F    | F    | F     | F     | F         | F      |
| WhatsApp ingestion                       | F     | N      | N       | N      | N      | N    | N    | N     | F     | N         | N      |
| Voice / inbound-call AI agent            | N     | N      | F       | N      | N      | N    | N    | N     | N     | N         | N      |
| Sales-call transcription + real-time assist | N  | N      | N       | N      | N      | N    | N    | F     | N     | N         | N      |
| PDF + Excel + multi-format extraction    | F     | F      | F       | F      | F      | F    | F    | F     | F     | F         | ?      |
| Handwritten-PO extraction                | P     | ?      | ?       | ?      | F      | ?    | ?    | ?     | ?     | F         | ?      |
| GAEB / BOQ format support                | N     | N      | F       | N      | N      | N    | N    | N     | N     | N         | N      |
| EDI support                              | N     | ?      | ?       | ?      | F      | ?    | ?    | ?     | ?     | ?         | ?      |
| SKU matching + part aliasing             | F     | P      | F       | F      | F      | F    | P    | F     | F     | P         | ?      |
| AI quote drafting                        | F     | F      | F       | F      | P      | P    | F    | F     | F     | N         | P      |
| Quote PDF rendering                      | F     | F      | F       | F      | ?      | ?    | F    | F     | F     | ?         | ?      |
| Customer-facing portal                   | N     | ?      | F       | ?      | N      | N    | N    | ?     | N     | N         | N      |
| Approvals + thresholds                   | F     | F      | F       | P      | N      | N    | N    | P     | N     | P         | F      |
| E-signature                              | N     | F      | ?       | ?      | N      | N    | N    | N     | N     | N         | N      |
| Quote analytics / win-rate / benchmarking| N     | N      | F       | N      | N      | N    | F    | N     | N     | N         | N      |

### Back-half: order → cash

| Feature                              | Anvil | Pactle | Mercura | Arzana | Comena | Axal | Soff | Avent | Korso | Smartbase | Lumari |
|--------------------------------------|-------|--------|---------|--------|--------|------|------|-------|-------|-----------|--------|
| Order entry (write to ERP)           | F***  | F      | F       | F      | F      | F    | N    | F     | F     | F         | N      |
| Real-time ERP query (chat surface)   | N     | N      | F       | N      | N      | F    | N    | F     | N     | N         | N      |
| Schedule lines / delivery scheduling | F     | ?      | ?       | ?      | N      | N    | N    | ?     | N     | N         | N      |
| Supplier PO / procurement            | F     | N      | N       | P      | N      | N    | N    | N     | F     | N         | F      |
| Supplier scorecard                   | F     | N      | N       | N      | N      | N    | N    | N     | N     | N         | N      |
| Invoicing                            | F     | F      | P       | N      | N      | N    | N    | N     | N     | N         | N      |
| AR / dunning / payment reminders     | F     | F      | N       | N      | N      | N    | N    | N     | N     | N         | N      |
| Payment collection (rails)           | F     | P      | N       | N      | N      | N    | N    | N     | N     | N         | N      |
| Autonomous follow-up agent loop      | F     | P      | P       | F      | P      | P    | F    | F     | F     | N         | F      |
| Service / AMC / CAR / visits         | F     | N      | N       | N      | N      | N    | N    | N     | N     | N         | N      |
| Multi-tenant + RLS                   | F     | ?      | ?       | ?      | ?      | ?    | ?    | ?     | ?     | ?         | ?      |

`***` Anvil writes orders to its own DB; pushes to Tally (India) and NetSuite (non-India). SAP / Dynamics / Acumatica are gap doc Next-block items, modelled on the same connector pattern.

### ERP / integrations breadth

| System            | Anvil | Pactle | Mercura | Arzana | Comena | Axal | Soff | Avent | Korso | Smartbase | Lumari |
|-------------------|-------|--------|---------|--------|--------|------|------|-------|-------|-----------|--------|
| Tally (India)     | F     | N      | N       | N      | N      | N    | N    | N     | N     | N         | N      |
| GSTN e-Invoice    | F     | N      | N       | N      | N      | N    | N    | N     | N     | N         | N      |
| NetSuite          | F     | F      | F       | ?      | ?      | ?    | ?    | F     | ?     | ?         | ?      |
| SAP S/4HANA       | N     | F      | F       | ?      | ?      | ?    | ?    | F     | ?     | ?         | ?      |
| MS Dynamics 365   | N     | N      | F       | ?      | ?      | ?    | ?    | F     | ?     | ?         | ?      |
| Salesforce        | N     | N      | F       | ?      | ?      | ?    | ?    | F     | ?     | ?         | ?      |
| Epicor            | N     | F      | F       | ?      | ?      | ?    | ?    | F     | ?     | ?         | ?      |
| Infor             | N     | N      | N       | ?      | ?      | ?    | ?    | F     | ?     | ?         | ?      |
| Acumatica         | N     | N      | F       | ?      | ?      | ?    | ?    | ?     | ?     | ?         | ?      |
| QuickBooks        | N     | F      | N       | ?      | ?      | ?    | ?    | ?     | ?     | ?         | ?      |
| Xero              | N     | F      | N       | ?      | ?      | ?    | ?    | ?     | ?     | ?         | ?      |
| Sage              | N     | F      | N       | ?      | ?      | ?    | ?    | ?     | ?     | ?         | ?      |
| Slack             | N     | F      | N       | N      | N      | N    | N    | N     | N     | N         | N      |
| WhatsApp Business | F     | N      | N       | N      | N      | N    | N    | N     | F     | N         | N      |
| Stripe / payment rails | F | P      | N       | N      | N      | N    | N    | N     | N     | N         | N      |
| DocuSign / e-sign | N     | F      | ?       | ?      | N      | N    | N    | N     | N     | N         | N      |

### Differentiator features (no one else has, or only Anvil has)

| Feature                                    | Owner         |
|--------------------------------------------|---------------|
| Tally + GSTN India compliance              | Anvil only    |
| Service ops (AMC / CAR / visits)           | Anvil only    |
| Spare-matrix recommender + obsolete-parts  | Anvil only    |
| Supplier scorecard by country-of-origin    | Anvil only    |
| Customer format-profile versioning + diff  | Anvil only    |
| Eval / anomaly / duplicates harness        | Anvil only    |
| Master-data graph (Cytoscape)              | Anvil only    |
| Prompt-injection firewall + PII redaction  | Anvil only    |
| Cost simulator with model-routing scenarios| Anvil only    |
| Outcome-based billing meter (per audit-event)| Anvil only  |
| Goal-driven autonomous agent + step audit  | Anvil + Soff partial |
| Inbound voice AI agent                     | Mercura only  |
| GAEB BOQ ingestion                         | Mercura only  |
| Slack-native execution                     | Pactle only   |
| Outcome/per-task pricing                   | Arzana only   |
| WhatsApp ingestion                         | Korso only    |
| Sales-call transcription + assist          | Avent only    |
| Real-time ERP-query chat surface           | Axal only     |

---

## 6. Gap analysis — what Anvil is missing

Grouped by severity for buying-decision impact.

### Critical (deals lost without these)

1. **At least three named non-Tally ERP connectors.** NetSuite, SAP S/4HANA, and one of Dynamics 365 / Acumatica / Epicor. Without these, Anvil cannot list any ERP except Tally on the marketing site, and every competitor lists 6+. This is the single most important gap.

2. **Quote PDF rendering + customer-facing quote view.** Sales reps cannot send a quote that an end-customer can read. Today the database has the quote object; nothing renders it. Bare minimum: a server-side PDF generator that produces a branded quote.

3. **Invoicing (non-India).** A general invoicing module covering: invoice number sequence per tenant, line items pulled from order, tax rules per jurisdiction, customer email delivery, status (draft / sent / partial / paid / overdue / void), per-customer credit terms.

4. **AR / dunning / payment-reminder loop.** AR aging table, configurable reminder cadence (e.g. day 0 thank-you, day 7, 14, 21, 30 increasing-firmness, day 60 escalation), email send via comms provider, log + audit. This is the back half the marketing pitch claims and the codebase does not have.

5. **Autonomous follow-up agent.** A scheduler/loop that owns goals like "get this quote accepted within 14 days" or "collect this invoice by due date + 7," picks the next action (send reminder, escalate, notify owner), executes, and updates state. The Soff and Pactle agent narrative is what this looks like.

6. **A real ERP-to-Anvil sync layer, not just a one-way Tally push.** Pull customer master, item master, inventory levels, open orders, AR aging, invoices from the ERP. Reconcile both ways. Today only Tally has anything close.

### Important (improve win rate against competitors)

7. **Slack and Microsoft Teams integration** for approvals + notifications. Pactle's wedge.

8. **WhatsApp Business ingestion.** Korso's wedge. Particularly relevant for India / SE Asia / Latam distributors.

9. **Voice-AI agent for inbound customer calls.** Mercura's wedge. Pulls customer history + product catalog, takes orders, recommends accessories.

10. **Real-time ERP-query chat surface.** Axal's wedge. "Do we have stock of SKU-X at warehouse Y?"

11. **E-signature on quotes + contracts.** DocuSign or Dropbox Sign integration with status tracking.

12. **Customer-facing portal.** Read-only view of quotes / orders / shipments / invoices at minimum; self-serve PO upload, payment, and order status as a follow-up.

13. **Quote analytics — win rate, benchmarking, cycle time.** Mercura promises this; analytics endpoints don't exist in the API set.

14. **CRM activity / sequencing layer.** Multi-touch outreach plans on opportunities, with delays and branch logic, not just one-shot "send a draft."

15. **Sales-call transcription + real-time assist.** Avent's wedge. Pulls in via web or mobile recording.

16. **EDI 850 / 855 / 856 / 810 for large distributors.** Comena flags this; large industrial buyers still send EDI.

17. **Mobile shell wired up.** Already designed in `screens-mobile.jsx`; not wired. Listed in roadmap as 2-week effort.

18. **A real outbound-comms provider integration**, not just "a generic webhook." Actual SDKs for SendGrid, Postmark, Twilio (SMS + WhatsApp), Slack.

19. **Reinforcement-learning loop or at least a feedback-on-extraction loop.** Mercura claims RLHF — Anvil has the eval suite which is the foundation, but no closed loop from edits-by-operator back into model improvement.

20. **Handwritten-PO extraction.** Smartbase + Comena flagged this. Mistral OCR is not strong on handwriting; need a specialized pipeline or GPT-4o vision fallback.

### Nice-to-have (rounding out the platform)

21. **Bulk actions on SO list, saved filters, snooze on findings, browser push, weekly digest, native quick-keys.** All listed in `docs/ROADMAP.md` already.

22. **Real-time Supabase channel updates** (presence + live-data).

23. **Self-service tenant onboarding + invites.** Currently a SQL-statement step.

24. **Outcome-based pricing meter.** Arzana's pricing model implies counting completed tasks; Anvil has the audit trail (`audit_events`) to count this — needs only an aggregator endpoint and a billing connector.

25. **Vertical packs.** Configuration bundles for fasteners, HVAC, electrical, machine shop — each ships catalog templates, default approval thresholds, format profiles.

26. **i18n + multi-currency display layer beyond INR/USD.** Roadmap item.

27. **Anvil rebrand cleanup.** `obara-client.js`, `obara-documents` bucket name, `obara-ops-v11.1.html` legacy, inline copy. Today the codebase's name is "Obara India sales-ops execution layer" verbatim in `package.json` description.

---

## 7. Consolidation plan — Smartbase / Korso / Lumari into Anvil

The three explicit consolidation targets are all early-stage and partially overlap with Anvil, but they cover different sides of the same value chain.

**Smartbase** is a thin wedge over Anvil's existing intake surface. The only meaningfully additive capability is handwritten-PO extraction. Treat it as a feature to absorb, not a product:

- New module: `intake.handwriting` — a pipeline branch that runs when OCR confidence is below a threshold or when the doc classifier returns "handwritten." Fan out to a vision-LLM (Claude 3.5 Sonnet or GPT-4o vision) plus the existing Mistral path, pick the higher-confidence result, log both for the eval harness.
- Surface: a confidence chip on the intake screen showing "handwritten path used."
- Effort: 1-2 weeks.

**Korso** has two products. Atlas (RFQ + quoting) is duplicate of Anvil's quoting. Hermes (supplier comms) is genuinely additive. The two distinctive things to absorb:

- **WhatsApp Business ingestion.** Add a webhook endpoint `api/whatsapp/inbound.js` that mirrors `api/email/inbound.js` — token-gated, classifies intent, persists media as documents, attempts thread-bundle. Plus an outbound `api/whatsapp/send.js`. Use Twilio WhatsApp or Meta Cloud API.
- **RAG over historical quotes.** Anvil has `customer_format_profiles` and `orders.preflight_payload`; add a vector index over historical successful quotes. When drafting a new quote for customer X, retrieve top-k past quotes (by similarity on customer + line items) and feed them to the model as few-shot examples. The eval harness already evaluates extraction quality; reuse it.
- Effort: 3-4 weeks.

**Lumari** is buyer-side procurement, the inverse user persona. Anvil's source-PO module already handles supplier procurement from the seller-distributor side. The right way to absorb Lumari is:

- A new buyer-side persona pack (role: `procurement_lead`) that reuses the source-POs table and adds: supplier-discovery (text-to-supplier-shortlist via web search + supplier-master), RFQ-blast-to-N-suppliers, side-by-side quote comparison, and procurement-approval thresholds parallel to the existing customer-side quote approvals.
- Alternatively, **don't consolidate** — keep Lumari out and avoid persona-confusion. The two buyers (sales-ops vs procurement-ops) are different. Carrying both inside one product without sharp separation will dilute marketing.
- Effort: 6-8 weeks if absorbed; 0 weeks if rejected.

Recommendation: absorb Smartbase + Korso. Reject Lumari for now. Revisit procurement after the QTC story is hardened.

---

## 8. Anvil's defensible moats — do not erase these

The most likely failure mode of this roadmap is over-rotating toward generic CPQ feature parity (Mercura, Pactle) and quietly deleting the things only Anvil has. The following should be load-bearing in the marketing story going forward:

- **India-compliance stack** (Tally + GSTN + INR + en-IN). For any prospect operating in India, Anvil is the only option in this competitive set. Keep it as a paid module, not a default.
- **Service ops layer** (AMC + CAR + visits + closure reports). Industrial distributors who sell capital equipment need post-sale service. None of the YC25 cohort touches this.
- **Spare-matrix recommender + obsolete-parts**. Distributor-specific. Mercura recommends accessories; Anvil recommends entire spare kits with obsolescence warnings.
- **Supplier scorecard by country-of-origin**. Imports are messy; Korea/Japan/China procurement performance tracking is genuinely hard and Anvil already does it.
- **Customer format-profile versioning**. The system that learns each customer's PO/quote layout and lets you roll back when a customer's template changes. Avent claims to "capture tribal knowledge"; Anvil has the data structure.
- **Eval + anomaly + duplicates harness**. Engineering rigor. The competitors gloss over how they evaluate extraction quality; Anvil has the wiring.
- **Prompt-firewall + PII redaction + RLS**. Security posture is enterprise-grade. SOC 2 / ISO 27001 are gettable on top of this; competitors largely show "in progress."
- **7-role RBAC with route-and-action matrix**. None of the competitor sites surface RBAC depth. This matters for enterprise buyers.

---

## 9. Roadmap

Effort sizes are calendar weeks for a small (2–4 engineer) team, not commitments. Sequencing is dependency-driven.

### Now (next 8 weeks) — table stakes for credible demos

| # | Item                                                           | Effort | Status | Notes                                                                |
|---|----------------------------------------------------------------|--------|--------|----------------------------------------------------------------------|
| 1 | NetSuite connector (read customers/items/inventory; write SO)  | 4w     | **shipped** | TBA auth, 30-min sync cron, manual SO push, per-tenant credentials on `tenant_settings`. Mirror tables `netsuite_sync_state` + `netsuite_open_orders`. v2 needs cursor-checkpointing + at-rest encryption of credentials. |
| 2 | Quote PDF renderer + customer-share email link                 | 1w     | **shipped** | Server-side via `@react-pdf/renderer`; new endpoint `/api/quotes/pdf` with download + 7-day signed share link. Reused by invoice PDF. |
| 3 | Invoicing module (non-India) with status lifecycle             | 2w     | **shipped** | New `invoices` table alongside `einvoices`. Atomic per-tenant numbering via `next_invoice_number()` rpc. Endpoints `/api/invoices`, `/[id]`, `/pdf`, `/send`. New Finance > Invoices nav route. |
| 4 | AR / dunning loop with configurable cadence + comms-provider   | 2w     | **shipped** | Agent v1's `ar_collect` handler now reads either `invoices` or `einvoices`; queued-comms reaper inside `/api/agents/run` fires SendGrid email per cron tick. Stripe webhook closes the loop on payment. |
| 5 | Autonomous follow-up agent v1 (scheduler + 3 goal types)       | 3w     | **shipped** | Goals: quote-accept, AR-collect, missing-doc. Hourly cron. Append-only step audit. See `docs/INTEGRATIONS.md` § Autonomous agent runner. |
| 6 | Brand cleanup (Obara → Anvil across copy, bucket, client name) | 1w     | **shipped** | Client renamed (anvil-client.js), localStorage prefix migrated with read-fallback, bucket configurable via `ANVIL_DOCUMENTS_BUCKET`, legacy unified HTML deleted. Operator runbook in `docs/MIGRATING_BRAND.md`. |
| 7 | Outbound comms provider real integrations (SendGrid + Twilio)  | 1w     | **shipped** | SendGrid abstraction in `/api/communications/send.js` (mirrors WhatsApp pattern); Twilio + Meta WhatsApp shipped earlier. Generic webhook fallback retained. |
| 8 | Stripe Connect for non-India tenants                           | 2w     | **shipped** | Connect Express, per-tenant accounts. Endpoints: `connect_onboard`, `connect_status`, `checkout`, `webhook`. New `payment_records` table. New `payment_collected` outcome priced at $1.00. |
| 9 | Mobile shell wire-up                                           | 2w     | **shipped** | New `MobileShell` swaps in below 768px viewport. Bottom tab bar (My Day, Inbox, Approve, SOs, More). PWA manifest + iOS web-app meta. NB: `screens-mobile.jsx` did not exist; built from scratch. |
|10 | Outcome-based billing meter (was Later #26, pulled forward)    | 1w     | **shipped** | Public price card in `docs/BILLING_OUTCOMES.md`, aggregator at `/api/billing/usage`, Admin Center > Billing tab. Stripe Connect now writes `payment_collected` outcomes via the webhook. |
|11 | WhatsApp Business inbound + outbound (was Next #14, pulled up) | 2w     | **shipped** | Twilio + Meta provider abstraction, both directions. New integration entries on `/api/health`. |

**All eleven Now-block items shipped on `main`.** End-to-end commit
chain: `c913d8f` (brand) -> `5b5b42b` (sendgrid) -> `baee6df` (quote
PDF) -> `8596754` (invoicing) -> `0601db9` (stripe) -> `d93d8a0`
(AR loop) -> `c2ef068` (netsuite) -> `81e2208` (mobile shell). The
gap doc's projected sequential effort (11.5 weeks) shipped in one
session.

### Next (weeks 9–24) — close the competitor gap

| #  | Item                                                                  | Effort | Why                                              |
|----|-----------------------------------------------------------------------|--------|--------------------------------------------------|
| 10 | SAP S/4HANA connector via OData                                       | 6w     | Pairs with NetSuite for the two biggest names.   |
| 11 | Dynamics 365 / Business Central + Acumatica connectors                | 6w     | Mid-market coverage.                             |
| 12 | E-signature (DocuSign or Dropbox Sign)                                | 2w     | Pactle's wedge.                                  |
| 13 | Slack + MS Teams integration (approvals + notifications)              | 3w     | Pactle's other wedge.                            |
| 14 | WhatsApp Business inbound + outbound                                  | 2w     | **Pulled into Now (#11). Shipped.**              |
| 15 | RAG over historical quotes (per customer)                             | 3w     | Korso's wedge. Reuses eval harness.              |
| 16 | Customer-facing portal (read-only quotes + orders + invoices + pay)   | 4w     | Table stakes for any prospect with > 50 customers. |
| 17 | Real-time ERP-query chat surface                                      | 3w     | Axal's wedge. Reuse master-data graph.           |
| 18 | Quote analytics dashboard (win rate, cycle time, benchmark, lost-reasons) | 2w | Mercura promises this; Anvil has the data already. |
| 19 | Handwritten-PO branch via vision-LLM fallback                         | 2w     | Smartbase + Comena claim it; absorb.             |
| 20 | EDI 850/855/856/810                                                   | 4w     | Comena flags it. Big-distributor moat.           |
| 21 | RLHF loop from operator edits back to extraction model                | 3w     | Mercura claims RLHF; Anvil has eval harness, no loop. |
| 22 | Autonomous follow-up agent v2 (more goals + branch logic + quiet hours) | 3w   | Continue investment.                             |

### Later (months 7–18) — differentiation and enterprise readiness

| #  | Item                                                              | Effort | Why                                                                  |
|----|-------------------------------------------------------------------|--------|----------------------------------------------------------------------|
| 23 | Inbound voice-AI agent (calls)                                    | 8w     | Mercura's wedge. Twilio Voice + speech models.                       |
| 24 | Sales-call transcription + real-time assist (web + mobile)        | 6w     | Avent's wedge.                                                       |
| 25 | Vertical packs: fasteners, HVAC, machine shop                     | 4w each| Mirror Mercura/Soff/Comena vertical wedges.                          |
| 26 | Outcome / per-task billing meter + customer-visible usage         | 3w     | **Pulled into Now (#10). Shipped at 1w. Stripe-Connect hookup is the remaining piece (#8).** |
| 27 | Self-service tenant onboarding + invites + role binding           | 2w     | Drop the manual SQL-statement step in `docs/SETUP.md`.               |
| 28 | SOC 2 Type 1, then Type 2; ISO 27001                              | 3-9mo  | Enterprise procurement gates. Beat the competitors who say "in progress." |
| 29 | Buyer-side procurement persona (Lumari-shaped, optional)          | 6w     | Reuses source-POs; adds RFQ-blast + comparison.                      |
| 30 | i18n + multi-currency display layer                               | 4w     | Already in roadmap.                                                  |
| 31 | Reinforcement-learning model fine-tuning on per-tenant data       | 6w     | Mercura claims this. Real moat over time.                            |
| 32 | Real-time presence in Cmd+K + Supabase Realtime                   | 2w     | Already in roadmap.                                                  |
| 33 | Native iOS app (if mobile-web adoption < 30% of approvals)        | 12w    | Already in roadmap as conditional.                                   |

### What's left to clear the Now block

After the post-implementation pass, the remaining open items in Now are:

- **#1 NetSuite connector** (4w). The single biggest credibility gap.
  Largest item; do it next.
- **#2 Quote PDF renderer** (1w). Smallest. Unblocks demo flow.
- **#3 Invoicing module + #4 AR loop** (4w combined). Sequential.
  Invoicing first; AR loop is now half-shipped via the agent (#5)
  but still needs the per-tenant invoice records to act on.
- **#6 Brand cleanup** (1w). Mechanical, high credibility return.
- **#8 Stripe Connect** (2w). Pairs with #10 (outcome meter) to
  close the loop on per-outcome billing.
- **#9 Mobile shell** (2w). Already designed.

### Sequencing notes

- The Now block is mostly parallel. The bottleneck is human review of SO/quote artifacts; everything else is independent.
- The Next block has one critical-path: ERP connectors (#10, #11) gate the SAP/Dynamics-anchored prospects. WhatsApp + Slack (#13, #14) parallelize against ERP work.
- Voice AI (#23) is the most expensive single item. It does not gate revenue if Mercura is not in the deal.
- SOC 2 (#28) is the longest-running track and should kick off at week 1 even though listed in Later, because the audit window is calendar-time, not effort-time.

---

## 10. Strategic positioning recommendations

1. **Lead the marketing pitch with the back-half of QTC, not the front.** Every YC25 entrant is fighting over RFQ → quote → order. The differentiated story is what happens after the order: invoicing, AR, payment collection, autonomous follow-up. Build that story even before all the connectors ship.

2. **Anchor the ICP narrative in industrial distributors with imports + service obligations.** This is exactly what Obara India is. It's also what most of the cleaner competitors (Soff, Mercura, Avent) are not. The supplier-scorecard + spare-matrix + AMC + CAR module set is the differentiator and the codebase already supports it.

3. **Sell India compliance as a paid module, not a default.** Tally + GSTN is real revenue if marketed correctly. Most competitors will not build it. It also creates a natural geographic upsell path.

4. **Match competitors' pricing model. Move toward outcome-based.** A per-completed-task line plus a platform fee. The audit trail makes this measurable today.

5. **Match the agent narrative on the marketing site, but only after the agent loop ships.** Today the site says "autonomous follow-up agents" and the code does not have an agent loop. This is a credibility risk if a buyer technical-evaluates. Either ship the loop quickly (Now #5) or soften the copy.

6. **Cleanup the brand transition.** "Obara India sales-ops layer" in `package.json`, the `obara-documents` bucket, and the legacy `obara-client.js` will surface in any code review by a security-conscious buyer. Two-day cleanup task.

7. **The codebase is ahead of the marketing site. Show it.** Build a public live-demo that exercises the eval harness, the model-routing log, the prompt-firewall, the master-data graph. These are credibility artifacts most competitors can't show.

---

## Appendix A — files referenced in this audit

- `Anvil-main/README.md`, `Anvil-main/package.json`, `Anvil-main/.env.example`
- `Anvil-main/docs/ROADMAP.md`, `Anvil-main/docs/V3_ROUTE_CONTRACT.md`
- `Anvil-main/src/api/claude/messages.js` (multi-tier model routing + firewall)
- `Anvil-main/src/api/email/inbound.js` (inbound email pipeline)
- `Anvil-main/src/api/cost/{breakdown,simulator,margin_history}.js`
- `Anvil-main/src/api/tally/{push,amend,reconcile,masters,validate}.js`
- `Anvil-main/src/api/einvoice/index.js`, `Anvil-main/src/api/source_pos/scorecard.js`
- `Anvil-main/src/api/spare_matrix/{recommend,kit,opportunities,obsolete}.js`
- `Anvil-main/src/v3-app/routes.ts`, `Anvil-main/src/v3-app/screens/{home,intake,orders,so-intake,cost}.tsx`
- `Anvil-main/supabase/migrations/{001..010}*.sql`

## Appendix B — sources for competitor analysis

- Smartbase: https://www.smartbase.so, ycombinator.com/companies/smartbase
- Korso: https://www.korsoai.com (homepage, /pricing, /atlas, /hermes)
- Lumari: https://lumari.io
- Arzana: https://www.arzana.com, https://arzana.ai, ycombinator.com/companies/arzana
- Pactle: https://www.pactle.co
- Comena: https://comena.ai/en/, ycombinator.com/companies/comena, ycombinator.com/launches/O3U
- Avent: https://www.aventindustrial.com
- Axal: https://www.axal.ai, https://www.joinaxal.com, ycombinator.com/companies/axal
- Soff: https://soff.ai
- Mercura: https://www.mercura.ai, https://mercura.io, ycombinator.com/companies/mercura, ycombinator.com/launches/Mun
- Raven: https://startraven.com, ycombinator.com/companies/raven
