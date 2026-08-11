# Anvil, Gap Analysis and Roadmap

Date: 2026-05-04
Scope: codebase audit of `Anvil-main`, 14-company competitive scan (11 original + 3 added 2026-07-17: Docket, Faction, Canals), gap matrix, prioritized roadmap, consolidation plan for Smartbase / Korso / Lumari.

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

## 0. Refresh — 2026-07-29 (read this first)

**The May-2026 audit below is now substantially out of date, and its central
thesis is inverted.** It described a system "strong on the front half, thin on
the back half, with zero non-Tally ERP connectors." That is no longer true. All
figures verified against current code (`supabase/migrations`, `src/api/router.js`,
`src/v3-app/screens`, `src/api/_lib/*client*.js`).

**Scale, then vs. now:**

| | May 2026 (below) | 2026-07-29 |
|---|---|---|
| SQL migrations | 10 | **195** |
| Routed API endpoints | ~80 | **454** |
| v3 screens | 35 | **157** |
| Named ERP / accounting connectors | Tally (+NetSuite in flight) | **17** |

**The "critical gaps" (§6 #1–#6) are essentially all closed:**

- **ERP breadth (was "the single most important gap").** 17 connectors now exist:
  Tally, NetSuite, SAP S/4HANA, Microsoft Dynamics 365, Acumatica, Oracle EBS,
  Oracle Fusion, IFS, JD Edwards, Infor SX.e, Epicor Prophet-21, Epicor Eclipse,
  ProAlpha, Ramco, Plex, JobBoss, Sage X3 (`src/api/_lib/*-client.js` + per-ERP
  route groups). Depth varies (push vs. bidirectional sync) — that's the remaining
  work, not presence.
- **Back-half (order→cash) is built:** generic `invoices` + GSTN `einvoices`,
  AR aging (`_lib/ops-kpis.js`), a GRN-aware payment statement, and **payment
  rails** (Stripe Connect + Razorpay).
- **Autonomous agents:** `agents/run.js` is a goal-driven loop (`ar_collect`,
  quote-chase, `handle_replies`) with an append-only step audit + a queued-comms
  reaper.
- **E-signature:** DocuSign (`src/api/esign/*` + `_lib/docusign-client.js`, migration 023).
- **ERP sync (not just push):** several connectors do scheduled pulls, not only
  one-way voucher push.

**Also new since May (whole modules the doc doesn't mention):**

- **Customer-communications suite (design items 0–8 + reply-loop):**
  function-based routing matrix, Outlook/Microsoft-Graph + SendGrid providers,
  dispatch register, template-driven service report, GRN payment statement, five
  governed comms-analytics metrics, a structurally-separate marketing path
  (consent/suppression/unsubscribe), and inbound reply attribution. See
  `docs/CUSTOMER_COMMS_DESIGN.md`.
- **GenAI copilot / "real-time ERP-query chat" (was gap #10, Axal's wedge):**
  `copilot/`, `erp_chat/`, an **MCP server** (`mcp/server.js` + scoped tokens),
  and a **governed metric catalog** (`_lib/metrics/catalog.js`, ~24 metrics) with
  a `{value, unit, provenance, as_of}` contract.
- **Customer-facing portal (was gap #12):** `portal/` — view quotes/orders/
  invoices, accept a quote, pay, reorder, invoice PDF, token-scoped access.
- **Multi-channel inbound (was gaps #7/#8/#9):** email, WhatsApp, Slack, Teams,
  and **voice** (`voice/` — webhook, outbound, consent, DND, handoff).
- **Drawing extraction + PDM, Logistics Ops, Spare-Intelligence bridge, generalized
  BOM ingestion** — all post-May.

**What is genuinely still open (the real 2026-07-29 gaps):**

1. **ERP connector DEPTH + marketing-site proof** — many are push-first; deepen to
   bidirectional master/inventory/AR sync, and actually list them publicly.
2. **De-Obara cleanup** — branding + customer IP/PII still throughout the repo (a
   real credibility + compliance risk; the one §2 claim that still holds).
3. **Compliance posture** — SOC 2 / ISO 27001 / data-residency for enterprise
   vendor-security review (deal-unblockers).
4. **Comms follow-ups** — GRN-aged AR view, Graph-reply retry worker, admin UIs
   (Graph connect, marketing-consent capture), the DPDPA retention decision.
5. **Handwritten-PO extraction + an RLHF/edit-feedback loop** (the eval harness is
   the foundation; the closed loop isn't built).
6. **Front-end maintainability** — a few mega screens (`admin.tsx` ~6k lines).
7. **Forecast→BOM raw-material preorder** (the north-star wedge) — still the
   highest-leverage differentiator to finish.

**Everything from `---` onward is the preserved May-2026 snapshot** (matrices +
competitor research remain useful); read its "missing/partial/gap" claims through
the corrections above. The per-competitor section has been kept current (§3.12–3.24; §3.22–3.24 = Shielded, Naïve, Spaceflow, added 2026-08-07).

---

## 1. Executive summary

> **Amended — see §0 (2026-07-29).** This summary's "thin back half / zero
> non-Tally ERP" thesis no longer holds: the back half (invoicing, AR, payment
> rails), 17 ERP connectors, autonomous agents, e-sign, a customer portal, a
> GenAI copilot, and the customer-comms suite have all shipped. The text below is
> the May-2026 snapshot.

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

> **Mostly superseded (§0, 2026-07-29).** Most items below are now shipped:
> non-Tally ERP connectors (17 of them), payment collection (Stripe + Razorpay),
> autonomous agents, a real SendGrid **and** Outlook/Graph comms provider, quote
> PDF, e-signature, and a customer-facing portal. The still-accurate items are the
> De-Obara branding/PII cleanup and some role-tailored-dashboard / mobile polish.
> Read the rest as a May-2026 snapshot.

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

### Additions — 2026-07-17

Three companies added for future reference. Detail below is from each company's own site (limited public depth; `?` in the matrix = not surfaced).

### 3.12 Docket — `docket.io`

One-liner: "From customer request to quote, automated."

ICP: Manufacturing sales + application/technical-engineering teams — industrial automation, electrical power, building products, high-tech electronics, medical/life sciences.

Capability surface: natural-language product configuration matched against catalogs + technical specs; **real-time engineering validation against compliance standards** (ATEX, SIL, PED, UL, IEC, FDA, ISO 13485, EU MDR); automated proposal/quote generation from validated configs; reasons over technical drawings, application notes, and regulatory documents rather than just querying a DB.

Integrations: ERPs, CRMs, PLM systems, technical document repositories (specific systems not named on site).

Differentiators: **compliance-aware CPQ with engineering validation** — collapses quote cycles from weeks to minutes with compliance-first recommendations.

Maturity: US (Palo Alto); positioned as an always-on AI agent for manufacturing sales.

Relevance to Anvil: overlaps the **quote / product-configuration** surface and BOM-accuracy-at-quote-time. Docket's edge over Anvil: standards-validated CPQ is a real capability Anvil lacks. Docket's gap vs Anvil: it stops at the quote — no forecast→BOM preorder, no procurement / logistics / finance chain, no India compliance rails. Treat compliance-CPQ as a **feature gap to note**, not a wedge threat.

### 3.13 Faction — `faction.ai`

One-liner: "AI for the most ambitious manufacturers and distributors" / "Quote faster. Source smarter. Get paid."

ICP: mid-market to enterprise distributors + manufacturers.

Capability surface: quoting (email/PDF → quote), order entry (multi-format → ERP), **dynamic pricing optimization**, product-data enrichment + standardization, **procurement automation (PO generation + reconciliation)**, **AP/AR automation**, AI chatbot for product search + order tracking, **24/7 voice AI agents on live ERP data**. Claims 95%+ product-match accuracy, ~12% gross-margin expansion.

Integrations: **Epicor, SAP, Oracle NetSuite, Infor.**

Differentiators: breadth — the widest full-chain automation in the set (quote → order → price → procure → AP/AR) with voice + live-ERP grounding.

Maturity: US / global; polished multi-ERP positioning.

Relevance to Anvil: **the most direct new full-QTC competitor.** It spans the same doc-in→action-out chain as Anvil AND adds dynamic pricing + AR ("get paid"), reaching into Anvil's pricing + finance-rails ambitions. Faction's gap vs Anvil: **reactive** procurement (PO gen + reconcile, no forecast→BOM cascade), and generic AP/AR (no Tally deep-reconcile, GST/e-invoice/e-way, TReDS, TDS/SAP-AP). Highest-priority new threat on the crowded cluster; does not touch the forecast→BOM wedge or the India rails.

### 3.14 Canals — `canals.ai`

One-liner: "AI That Keeps Material Moving."

ICP: distributors, manufacturers, contractors in construction + industrial supply (electrical, plumbing, HVAC, mechanical, industrial/MRO, lumber, building materials); 100+ distributors claimed.

Capability surface: sales-order entry + quote generation from emails/PDFs/**handwritten notes/voicemails**, touchless **AP** invoice processing, **PO + receipt tracking with discrepancy flagging**, **part-number conversion across product lists**, AI chatbot for customer inquiries. ML trained on industry complexity, **no templates / no per-customer setup**.

Integrations: major ERPs (not individually named on site).

Differentiators: template-free self-improving matching; multi-format intake incl. handwriting + voicemail; cross-catalog part-number conversion.

Maturity: US / global; 100+ distributor logos claimed.

Relevance to Anvil: overlaps order-entry + RFQ→quote, PO/receipt discrepancy flagging (mirrors Anvil's logistics receiving / GRN), and notably **part-number conversion**, which overlaps Anvil's `item_master` matcher — reinforcing that cross-catalog matching is commoditizing. Canals' gap vs Anvil: reactive order processing, no forecast, distribution/construction vertical (not manufacturer BOM/spares depth), no India rails.

#### New-entrants at a glance

Compact matrix for the 3 additions (same legend as §5: **F** full · **P** partial · **N** none · **?** not surfaced). Kept separate from the 11-column §5 tables since public detail is thin.

| Dimension                              | Anvil | Docket | Faction | Canals |
|----------------------------------------|-------|--------|---------|--------|
| Multi-format intake (email/PDF)        | F     | F      | F       | F      |
| Handwritten / voicemail intake         | P     | ?      | ?       | F      |
| Voice AI agent                         | N     | N      | F       | P      |
| SKU / part-number matching             | F     | F      | F       | F      |
| AI quote drafting                      | F     | F      | F       | F      |
| CPQ engineering / compliance validation| N     | **F**  | N       | N      |
| Order entry → ERP                      | F     | ?      | F       | F      |
| Dynamic pricing optimization           | P     | N      | **F**   | N      |
| Supplier PO / procurement              | F     | N      | F       | P      |
| **Forecast→BOM preorder (the wedge)**  | **F** | N      | N       | N      |
| AP / AR / "get paid"                   | F     | N      | F       | P      |
| **India rails (Tally / GST / e-invoice)** | **F** | N   | N       | N      |
| Named ERP breadth                      | 16+Tally | unnamed | Epicor/SAP/NetSuite/Infor | unnamed |

The two bold rows are the ones no entrant contests. Docket's bold cell (compliance-CPQ) is the one capability Anvil should note as a gap.

### Additions — 2026-07-22 (adjacent-learn-only: revenue intelligence + sales productivity)

Two US SaaS-sales tools reviewed at the user's request. **Neither is a competitor** — both serve quota-carrying B2B *software*-sales teams on top of Salesforce, a different problem class from Anvil's India-manufacturing transactional order flow (like Raven §3.11, they are adjacent-learn-only). The value is UX/AI *patterns* Anvil should borrow for its GenAI copilot, forecast, and sales-ops cockpit — not features to match. Do **not** chase their enterprise-SaaS-sales core (rep coaching, multi-threading, CRM-hygiene-for-its-own-sake); Anvil's users are ops/procurement, not quota-carrying AEs.

### 3.15 Backstory.ai — `backstory.ai/solutions/revenue-decisions` (adjacent-learn-only)

One-liner: "Straight answers grounded in what's actually happening" — evidence-based revenue intelligence.

ICP: CROs / VP-Sales, RevOps, sales managers in enterprise SaaS sales.

Capability surface: auto-captures all customer comms (email/meetings/calls/chat) and matches them to deals + accounts; AI insights engine (deal momentum/risk, single-threaded-deal + stakeholder-coverage gaps, expansion signals); dashboards (pipeline health, rep-behavior patterns, **forecast-variance waterfall**); NL Q&A where **every answer shows the underlying conversations/data** (a defensible, not asserted, forecast).

Differentiators: evidence-grounded reasoning (drill to source), passive capture (no rep workflow change), business-specific training, transparent AI.

Relevance to Anvil: **borrow 3 patterns.** (1) **Evidence-grounded / defensible answers** — harden Ask Anvil + the metric-catalog provenance contract so a plant-head/CFO gets a *defensible* forecast with drill-to-evidence, not just a number (directly strengthens the forecast→BOM wedge / BET 1). (2) **Forecast-variance waterfall** — a concrete cockpit / inventory-planning UI to explain the QoQ change in raw-material demand (new opps, won/lost, probability shifts, BOM edits). (3) **Passive activity capture → order/account timeline with risk signals** (a PO at risk of a delivery slip, a quote stalling), built on Anvil's shipped WhatsApp/email/comms inbound. Its rep-coaching / multi-threading core is irrelevant to Anvil.

### 3.16 Scratchpad — `scratchpad.com/use-cases` (adjacent-learn-only)

One-liner: "Remove admin work. Execute flawlessly. Win more deals."

ICP: sales + ops leaders on Salesforce.

Capability surface: AI auto-drafts CRM updates and **backfills fields**, post-call follow-up email drafting, instant call coaching with custom prompts, deal assessment vs a sales methodology, **closed-lost reason capture**, one-click exec summaries, and **sales→post-sales handoff** packets. Deep Salesforce integration.

Differentiators: adoption without forced compliance ("built into how we run deals … without adding more work").

Relevance to Anvil: **borrow 3 patterns.** (1) Validates + extends Anvil's shipped **GenOps propose→confirm** loop — auto-draft order acknowledgements / quote follow-ups / field-backfills as safe actions. (2) **Closed-lost / won-pattern capture** — a real Anvil analytics GAP: capture quote-lost reasons + order-won patterns to feed the sales-ops cockpit. (3) **One-click exec + handoff summaries** — a cockpit exec summary + an order→production/logistics handoff summary via GenAI. Design principle: meet ops users inside their workflow; don't force compliance.

**Net (both):** the transferable value is a **defensible, evidence-grounded, admin-removing UX** layered on Anvil's copilot + forecast + cockpit — not their enterprise-SaaS-sales product. Concrete items folded into §6 (Important) and parked in the backlog (memory `backlog_revenue_intel_ux`).

### Additions — 2026-07-27 (adjacent-learn-only: drawing intelligence)

One drawing-intelligence tool reviewed at the user's request. **Not a sales-ops competitor** — it operates on the *engineering-drawing QA* step, not the order/procurement flow. It is adjacent to Anvil's own **drawing extraction + PDM** line (memory `project_drawing_extraction_pdm`; PRs #288–293 extract part/assembly CAD drawings into BOM/item data for spare ordering). Hera does drawing → *review*; Anvil does drawing → *data*. The value is capability + positioning patterns for Anvil's extraction pipeline, not features to match.

### 3.17 Hera — `manufacturingintelligence.org` (adjacent-learn-only)

One-liner: "The physical economy runs on drawings. Review takes days. Hera takes minutes." Automated engineering-drawing review (by GIM Corp, YC-backed).

ICP: manufacturing engineering + quality teams who review technical drawings before parts ship.

Capability surface: a "Design Intelligence" console that runs four checks on a technical drawing in minutes — **GD&T conformance**, **code compliance**, **tolerance-stack analysis**, and **drawing-integrity verification** — validating GD&T callouts, datums, and tolerances against **ASME Y14.5-2018, ASME BPVC, B31, and AWS** standards.

Differentiators: deep GD&T/standards parsing (callouts + datums + tolerances, not just OCR); standards-conformance as the value prop; the days→minutes time-compression wedge.

Relevance to Anvil: **learn, don't chase.** (1) **Deeper drawing parse** — Anvil's drawing extraction reads part/assembly data for BOM/spare ordering; Hera shows the depth achievable on the *same artifact* (GD&T callouts, datums, tolerance stacks) that Anvil's P2/P3 (DXF/DWG, part_drawing) could mine for richer item attributes. (2) **Standards-conformance as a manufacturing-credibility signal** — the ASME/AWS framing is a trust cue Anvil can echo where it touches engineering data. (3) **Same days→minutes wedge** Anvil uses for PO extraction, applied to a different artifact — validates the time-compression pitch. Do **not** build engineering-drawing QA/GD&T review: Anvil's wedge is order/procurement flow + forecast→BOM, and drawing QA is a different buyer (design/quality, not ops/procurement).

### Additions — 2026-07-29 (adjacent-learn-only: process-plant document intelligence)

Two more reviewed at the user's request. Operon is a **document-intelligence** adjacency (same class as Hera §3.17 and Anvil's own DocAI / drawing-extraction line); Bizmark is an early, content-light entry. Neither is a sales-ops competitor.

### 3.18 Operon Solutions — `operonsolutions.com` (adjacent-learn-only)

One-liner: "The context layer for process & manufacturing." AI plant-documentation intelligence (by Operon, YC-backed).

ICP: process/manufacturing operators — chemical, oil & gas, cement, electronics — and EPC (engineering-procurement-construction) service providers.

Capability surface: digitizes P&IDs, isometrics, and compliance records into a queryable **"typed plant graph"** connecting equipment + instruments across documents; AI symbol/tag recognition ("97%+ detection accuracy"); a knowledge **chat with source citation**; automated compliance-document generation (LDAR, MOC, HAZOP); agentic workflows over REST/GraphQL/SDK; cloud + on-prem.

Differentiators: the typed cross-document graph as a reusable context layer; citation-grounded plant Q&A; compliance-doc automation for a regulated buyer.

Relevance to Anvil: **learn, don't chase.** (1) **"Typed graph + cited chat"** is the same evidence-grounded pattern Anvil is hardening for Ask Anvil + the metric-catalog provenance contract — Operon validates the drill-to-source UX on engineering documents. (2) **Material take-offs for procurement** from digitized drawings is a genuine bridge into Anvil's forecast→BOM wedge (extracted plant items → spare/BOM demand). (3) **On-prem + SDK** posture is a reminder that process-industry buyers often require on-prem — relevant to Anvil's enterprise-readiness (compliance/CISO backlog). Do **not** build P&ID/plant-compliance tooling (LDAR/HAZOP): that's a different buyer (plant safety/operations, not sales-ops/procurement).

### 3.19 Bizmark — `bizmark.ai` (adjacent-learn-only, early / thin)

One-liner: "Every process, run with the intelligence you already have" — "Systems of Applied Intelligence for the Real Economy."

ICP: not stated on the site.

Capability surface: **content-light** — the public site describes a positioning (applied-intelligence over existing business data to optimize processes) but names no specific product, platform, or case study. Assessment is provisional pending more material.

Relevance to Anvil: **watch, low signal.** The "run existing processes with intelligence you already have" framing rhymes with Anvil's copilot-over-your-own-ERP-data thesis, but with no disclosed product there's nothing concrete to learn or counter yet. Revisit if they ship specifics; do not act on this entry alone.

### Additions — 2026-08-01 (field-service management: a thread to follow)

Reviewed at the user's request, with a deliberate steer: **field service management (FSM) is an adjacency worth following, not dismissing.** FSM is structurally close to **maintenance management** — both revolve around *deploying the right engineer to the right job*, which is a constrained-planning problem (engineer **availability** × **geography/route** × **skill/certification match** × job **demand/priority/SLA** × **parts-on-hand**). That is the same optimization *family* Anvil already runs elsewhere — forecast→BOM procurement planning, spare/installed-base intelligence (FMECA/MEIO), and freight bidding — and it sits directly on top of Anvil's existing **Service** module (Service Visits, AMC Schedule, CAR reports). So this entry is filed as "learn + candidate expansion," not "don't chase."

### 3.20 Kebra — `kebra.com` (adjacent — field-service thread to follow)

One-liner: "AI-native field service." AI agents that automate the **back office** of field-service companies — turning a completed job into structured documentation, warranty recovery, invoicing, and follow-up.

ICP: HVAC (and similar trades) field-service contractors — field technicians and service-company owners — looking to cut post-job admin.

Capability surface: AI agents that (1) **structure job documentation** from field data (notes, photos, equipment models, diagnostics, parts used); (2) **recover warranty revenue** by auto-submitting claims to manufacturer portals (their demo shows a recovered Trane claim); (3) **QA the job** — flag missing info and prompt the tech to complete it before leaving site; (4) **sync back-office** — parts ordering/inventory, invoice creation, customer follow-up/upsell. Integrations: **ServiceTitan** (job management), **QuickBooks** (invoicing), manufacturer warranty portals, parts suppliers, email/SMS.

Differentiators: an **AI-native post-job automation layer** that sits *on top of* the incumbent FSM system-of-record (ServiceTitan) rather than replacing it; **warranty-claim recovery** as a hard-dollar wedge; capture-at-the-truck QA so documentation is complete before the tech leaves.

Maturity: early; narrow (HVAC back office); positions as AI-native. Note the scope boundary — **Kebra automates the back office; it does not own dispatch/scheduling** (ServiceTitan does). The dispatch-planning engine is the harder, more defensible part of FSM, and Kebra deliberately doesn't build it.

Relevance to Anvil: **follow the thread — this is Anvil's Service module's future, not a QTC competitor.** Three concrete pulls: (1) **Engineer-deployment planning is the real prize.** Kebra sidesteps dispatch; Anvil should lean *into* it. Scheduling service/AMC engineers by availability × skill × route × SLA × spare-on-hand is the same constrained-assignment problem as forecast→BOM preorder and freight bidding — Anvil already has the planning substrate and the installed-base + spare-intelligence data (FMECA/MEIO, spare matrix) that make service demand *forecastable*, which pure FSM tools lack. That is a differentiated wedge: **maintenance/AMC → predicted service demand → engineer + spare-part deployment plan.** (2) **Capture-at-the-truck QA** — the "don't let the job close with missing data" pattern maps directly onto Anvil's Service Visit / CAR capture, and onto the same evidence-grounded, complete-before-commit ethos Anvil enforces on extraction. (3) **Warranty/entitlement recovery** connects to the parked support-desk / warranty-entitlement backlog — a hard-dollar reason to hold installed-base + service-history data that Anvil already stores. Do **not** clone Kebra's HVAC back-office niche; **do** treat FSM engineer-deployment planning as a candidate expansion of the Service module, powered by Anvil's forecasting + spare-intelligence spine.

### 3.21 Agency Tool Company — `agencytool.com` (category error — robotics fleet infra, not QTC)

One-liner: "Tools for everyone fielding robots." OTA software-deployment + fleet management infrastructure for robotics companies (by the founders of Scythe Robotics, launched mid-2026).

ICP: robotics companies fielding fleets in production — agriculture, construction, logistics, autonomous vehicles. The buyer is a **robotics/embedded software team**, not a sales-ops or procurement function.

Capability surface: **ATC Deploy** (live, beta) — OTA updates to individual robots or fleets, delta-compressed ("20x faster than a docker pull", ships only changed bytes, resumable over flaky networks), fleet segmentation + targeted rollouts, config/calibration artifact management, role-based approval workflows, per-robot versioning + fleet-convergence visibility, full deployment history/audit, web console + CLI; works with ROS 2, Docker images, arbitrary filesets. **ATC Build** (coming) — CI/CD on hosted embedded hardware (NVIDIA Jetson Orin/NX/AGX/Thor, Raspberry Pi), running tests on the real target instead of emulation; integrates GitHub Actions / GitLab CI.

Maturity: very early (launched ~mid-2026, 3 launch partners, waitlist-gated), but credible founders (built + sold Scythe Robotics, fielded hundreds of autonomous mowers).

Relevance to Anvil: **none for QTC — a category error from the reference list** (same class as Raven §3.11's plant-floor OEE). Agency Tool is robotics DevOps/edge-fleet infrastructure; Anvil is quote-to-cash + procurement + forecasting for industrial sales-ops. There is no product, buyer, or data overlap. Two faint, transferable *patterns* only — do not act on this entry alone: (1) **staged-rollout governance** (fleet segmentation + role-based approval + version-convergence visibility + audit trail) is a clean template for any future Anvil deploy/rollout-governance surface, but Anvil is multi-tenant SaaS, not an edge-fleet operator, so the analogy is loose; (2) **offline-tolerant, resumable sync** over intermittent networks is genuinely relevant *if* Anvil ever builds field/edge data capture — which is exactly where the Kebra §3.20 field-service thread points (service engineers capturing job data at low-connectivity Indian industrial sites). That connectivity-resilience requirement is the one thread worth remembering; the OTA/robotics product itself is not a competitor.

### 3.22 Shielded — `shieldedglobal.com` (adjacent-learn-only — risk-intelligence overlay)

One-liner: "The Unified Intelligence Layer for Business Risk." Real-time risk intelligence that maps external events (tariffs, commodities, freight, FX, disruptions) to financial impact.

ICP: ERP-using mid-market to enterprise firms exposed to tariff/commodity/freight/FX volatility, tailored to three verticals — Manufacturing & Defense (tariff exposure, BOM cost changes, program margin), Food & Beverage (ingredient/landed cost by SKU), Transportation & Logistics (fuel/freight volatility). US-centric (USMCA framing), not India-first.

Capability surface: a **read-only sense-and-recommend overlay**. Ingests internal data (ERP export or spreadsheet) + external feeds and continuously maps drivers to margin change by supplier/SKU, BOM cost change, landed cost, and program margin. Outputs a "what changed / financial impact / priority action" feed, proactive alerts, duty/tariff + USMCA-exclusion calculations, and recommended mitigations (re-source, hedge, re-price). No quoting, no PO/SO extraction, no RFQ, no order processing — **not a system of action**.

Integrations: "Connect ERP systems, spreadsheets, and external intelligence." None named; on-ramp is a spreadsheet export.

Differentiators: a **cause-to-margin mapping engine** (external event → BOM cost → SKU/program margin, quantified with a time horizon); proactive alerts + recommended mitigations rather than a static dashboard; concrete tariff/duty + USMCA logic.

Maturity: YC S26, backed by YC + Susa Ventures. No funding amount, logos, team size, or pricing disclosed; demo/login-gated. Seed-stage.

Relevance to Anvil: partial adjacency, sitting one layer **above** Anvil's transactional core — a risk-intelligence overlay, not a QTC or procurement rival, so no overlap on extraction/quoting/RFQ/order processing. But the overlap lands squarely on **Anvil's moat**: Shielded's "external cost driver → BOM cost → margin impact, with alerts + re-source recs" is exactly the lens Anvil's forecasting-driven procurement + ocean-freight modules would benefit from — and Anvil already **owns** the BOM explosion, supplier data, and freight bids Shielded can only import from a static spreadsheet, so Anvil can compute this on **live** transactional data. **Verdict: LEARN-ONLY.** Take the cost-risk exposure lens — a live "landed-cost / margin-at-risk by BOM component and by opportunity" view driven by tariff/commodity/FX/freight deltas, with proactive alerts and a re-source/hedge recommendation, layered onto the forecast-to-preorder pipeline. Not a consolidation target (different category, US/tariff-centric, seed-stage); not yet a positioning threat.

### 3.23 Naïve — `usenaive.ai` (category error — horizontal AI-agent infra, not QTC)

One-liner: "Ship Apps. Agents. Companies. One prompt. One config file. All your infrastructure." Unified runtime/infra for AI agents.

ICP: developers and AI engineers building agentic apps and "AI-native" businesses (automation agencies, autonomous content channels, solo builders wiring agents into Cursor/Claude Code). Buyer = the developer/founder; self-serve, 30k+ signups. **Not** sold to industrial sales/procurement/ops teams.

Capability surface: a horizontal "autonomous company runtime" — agent cloud infra (Postgres/auth/storage/realtime/edge fns), a governance control plane (policy + audit logs + **hard spend caps enforced before a transaction**), scoped virtual cards + invoicing, a durable multi-agent runtime, 300+ model routing, per-agent KYC/KYB + automated US LLC/EIN formation, 100+ connectors, TypeScript IaC.

Integrations: Stripe, Supabase, Vercel, QuickBooks, PostHog, Rippling, Brave + 100+ — dev/SaaS building blocks, **not** manufacturing ERPs (no Tally/SAP/Zoho/IndiaMART/CAD-PLM).

Differentiators: giving each agent a real-world **legal + financial identity** (auto LLC/EIN, KYB, scoped cards) fused with a durable runtime and a pre-transaction governance plane. (Caveat: a community post alleges they forked a ~41k-star OSS project and stripped its license — an originality flag, noted not endorsed.)

Maturity: YC Spring 2025; $28.5M Series A led by Nexus Venture Partners (~$32M total) with notable angels; ~10 FTEs; 30k+ developer customers. Well-funded but land-grab-stage infra.

Relevance to Anvil: **Verdict: CATEGORY-ERROR.** Naïve is horizontal AI-agent infrastructure for developers — it competes with Vercel/Supabase/agent-ops infra, not with any part of Anvil's seller-side QTC, extraction, RFQ, spares, freight, or forecasting. Different buyer, job, and vertical; nothing to consolidate or defend against. The only tangency is Anvil-**as-a-customer**, not competitor: its governance pattern (policy + audit log + hard spend cap enforced *before* an agent transacts) is a clean reference for guardrails on Anvil's copilot/agents. Keep it **out** of the QTC/procurement matrix; LEARN-ONLY at most for agent governance.

### 3.24 Spaceflow — `spaceflow.tech` (procurement-inverse, learn-only)

One-liner: "Enterprise AI, without the transformation." A managed runtime for enterprise AI agents; procurement "AI employees" for the buy side.

ICP: enterprises on heavily-customized legacy/on-prem systems (perpetual licenses, air-gapped) whose procurement teams do high-volume quote comparison + invoice-to-PO matching. Current logos are Turkish foodservice/enterprise (100+ locations); manufacturing, banking, defense named as target regulated verticals.

Capability surface: the **buy-side** document loop end-to-end — read supplier emails; extract price/lead-time/MOQ from quotes, normalize units, rank responses; consolidate RFQ replies into comparison tables; draft POs with threshold approval routing; match supplier invoices to POs and contract prices line-by-line; vendor scorecards + late-delivery/shipment-delay alerts. Every action proposed, logged, human-approved. Claims: RFQ 4 days → <1 hour, 42% less maverick spend, 3× RFQ throughput, ~$120k/yr savings/deployment, "$400M annual supplier spend runs through Spaceflow."

Integrations: ERP (explicitly **SAP ECC 6.0 with heavy Z-tables**), email, spreadsheets, documents, supplier portals; positions as **MCP-native**. Not a broad named-connector list — the pitch is adapting to one customer's customized stack, not connector breadth.

Differentiators: **on-prem / customer-cloud deployment with model inference inside the customer boundary** ("your transactional data never travels"); a governance gateway with identity passthrough + immutable audit logging; learns existing custom tables/pricing/approval chains without re-implementation (targets decades-old ECC 6.0); remote install "in days"; framed as a managed agent runtime, not a point app.

Maturity: YC S26; ~$1M raised, six-figure ARR; Turkish-founded, now SF; angels from Airbnb, Volvo Cars, Google, Encord, Sequoia. Named Turkish customers. Early but real, content-rich site (Security / Trust Center / KVKK).

Relevance to Anvil: Spaceflow automates the **buy side** of the very RFQ → quote → PO → invoice loop Anvil runs on the **sell side** — the procurement inverse of Anvil's QTC. It mirrors Anvil's supplier-RFQ/quote-capture subsystem and KR/JP/CN supplier scorecard, but as the customer's own procurement cockpit, not a seller's tool, so it is **not** a head-to-head QTC rival. Anvil already does supplier RFQ, quote capture, and vendor scorecards; Spaceflow's genuine edge is **architectural** — on-prem/air-gapped deployment with in-boundary inference, a governance gateway, and immutable audit logging, which is exactly the **TISAX / enterprise-vendor-security posture Anvil's compliance/CISO backlog flags as a deal-unblocker**. **Verdict: LEARN-ONLY** (procurement-inverse, not a seller-side rival). Take the on-prem + governance-gateway + MCP-native managed-runtime deployment model for regulated/air-gapped buyers. **Watch:** if Spaceflow bolts a sell-side module onto the same runtime, it becomes a **THREAT** to Anvil's SAP-ECC-heavy Indian enterprise ICP.

### Additions — 2026-08-11 (AI-native freight forwarding)

One reviewed at the user's request. **`shieldedglobal.com` was also requested and is already covered above at §3.22** (reviewed 2026-08-01, verdict LEARN-ONLY — risk-intelligence overlay); re-reading it against the live site confirms that entry still holds, so it is not duplicated here.

Derya is a different shape from everything else in this scan: it is not software Anvil competes with, it is a **service provider inside a market Anvil already builds a bidding module for**.

### 3.25 Derya — `usederya.com` (adjacent — potential channel/integration, not a rival)

One-liner: AI-native freight forwarding — booking, exporter→port, port→port with customs clearance, and final delivery to the importer, coordinated by AI agents.

ICP: importers/exporters wanting a managed international shipment; also sells *to* freight forwarders (lead generation, deal sourcing) and to carriers (pre-qualified, fully-documented loads).

Capability surface: FCL, LCL, and air freight; quote generation "within one business day"; carrier coordination; customs clearance; automated chasing of missing documentation; and **trade financing on shipments above $20,000**. Positions "AI agents in real time to coordinate tasks, answer questions, and maintain team alignment" across the traditional forwarding desk functions (sales, pricing, ops).

Geography: Turkey-based with a partner network; corridors advertised include Sudan–Turkey, Malaysia–Turkey, Brazil–Ukraine. **Not an India-first lane set**, and not the KR/CN/JP group-subsidiary corridors Anvil's primary tenant imports on.

Maturity: early; site is marketing-led, no pricing, no named enterprise logos, no public API/docs found. Treat capability claims as unverified.

Relevance to Anvil: **this is the one entry in the scan that is plausibly a partner rather than a competitor, and the distinction is load-bearing.** Anvil's logistics P4 shipped a freight-bidding module — `freight_consolidations` / `freight_bids` (migration 145), `_lib/freight-consolidation.js` (`estimateContainers` + `consolidatePlans`), and `/api/logistics/consolidations` + `/api/logistics/freight_bids` (build/list/status, quote/award) — which solicits FCL/LCL bids **from forwarders**. Derya *is* a forwarder, on the sell side of that exact transaction. Anvil is the buyer's cockpit; Derya is a vendor Anvil's module would invite to bid.

Three takeaways:

1. **Channel, not chase.** If Derya (or any AI-native forwarder) exposes a quote API, it becomes a bid source for `freight_bids` — turning Anvil's award flow from "email the forwarders" into a live-rate comparison. Worth watching for a public API; there isn't one today.
2. **The document-chasing pattern is the transferable idea.** "Automatically handles missing documentation" is the same rail Anvil already runs for POs (DocAI extract → validators → chase) applied to shipping docs — B/L, packing list, certificate of origin. Anvil's shipment stack (`shipments`, `shipment_lines` mig 209, `logistics_monitor` mig 206) captures the records but does **not** chase the documents; that gap is real and is Anvil's to close, independent of Derya.
3. **Trade finance is a genuine adjacency, and out of scope.** Financing shipments >$20k sits beside Anvil's AR/collections line ([[project_payment_reality]]: OEMs paying via SAP AP bank transfer with TDS). Note it; do not build it.

**Verdict: LEARN-ONLY, with a watch item.** No feature overlap — Derya moves cargo, Anvil runs quote-to-cash. Do **not** build forwarding operations. **Watch:** if Derya moves up-stack into shipper-side software (rate management, landed-cost, procurement-adjacent tooling), it stops being a channel and starts overlapping Anvil's logistics module — the same up-stack risk flagged for Spaceflow in §3.24.

---

## 4. Cross-cutting themes from the competitor scan

Five things the competitors collectively prove are now table stakes:

1. **Named ERP integrations on the marketing site.** Mercura lists 11. Pactle lists 7. Avent lists 6. Anvil's website lists Tally. This is the most credibility-damaging visible gap. — **_Update (§0, 2026-07-29): the code gap is closed — 17 connectors now exist. What remains is (a) deepening several from push to bidirectional sync and (b) actually listing them on the marketing site._**

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

> **Amended (§0, 2026-07-29).** The Anvil column below is a May snapshot. Current
> Anvil connector coverage is **F** for NetSuite, SAP S/4HANA, Dynamics 365,
> Acumatica, Oracle EBS, Oracle Fusion, IFS, JD Edwards, Infor SX.e, Epicor
> Prophet-21, Epicor Eclipse, ProAlpha, Ramco, Plex, JobBoss, Sage X3 (+ Tally,
> GSTN), plus Stripe **and** Razorpay payment rails, DocuSign e-sign, and Slack +
> Teams. Depth varies (push vs. bidirectional).

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

> **Superseded by §0 (2026-07-29).** Critical gaps #1–#6 and important gaps
> #7/#9/#10/#11/#12/#13/#18 are now **built** (17 ERP connectors, invoicing, AR +
> dunning agent, payment rails, autonomous agent loop, e-sign, customer portal,
> copilot/real-time-ERP chat, multi-channel inbound incl. voice, comms provider
> integrations). The list below is the May-2026 snapshot; the **current** open
> gaps are enumerated in §0 ("What is genuinely still open"). Retained for history.

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

### From the 2026-07-22 revenue-intelligence scan (Backstory.ai / Scratchpad — §3.15–3.16)

These are UX/AI patterns to *borrow*, not competitors to match. Ranked by leverage on Anvil's actual users (ops/procurement, not AEs):

28. **Evidence-grounded, defensible answers (Backstory).** Every copilot/forecast answer should drill to its source rows. Anvil's metric-catalog answer contract (`{value, unit, provenance, as_of}`) is the seam — surface the provenance in Ask Anvil and the cockpit so a plant-head/CFO gets a *defensible* forecast, not an asserted number. Highest leverage: it's what turns the forecast→BOM wedge into a board-credible story.
29. **Forecast-variance waterfall (Backstory).** A cockpit / inventory-planning view that decomposes the QoQ change in raw-material net demand into drivers (new opps, won/lost, probability shifts, BOM edits). Directly extends `explodePipelineThroughBom` output; makes "buy before the shortage" explainable.
30. **Closed-lost / won-pattern capture (Scratchpad).** A genuine analytics gap — capture quote-lost reasons + order-won patterns as first-class fields feeding the sales-ops cockpit. Cheap, high-signal, no new infra.
31. **One-click exec + handoff summaries (Scratchpad).** GenAI exec summary on the cockpit; an order→production/logistics handoff packet. Reuses the copilot + GenOps propose→confirm loop already shipped.
32. **Passive activity capture → order/account timeline with risk signals (Backstory).** Auto-match inbound comms (WhatsApp/email — already ingested) to orders/accounts and surface risk (a PO at risk of delivery slip, a quote stalling). Extends the shipped inbound pattern; feeds the cockpit's "what needs attention."

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

> **Amended (§0, 2026-07-29).** The entire "Now (next 8 weeks)" block below has
> **shipped**, and much of "Next" too (ERP connectors, e-sign, portal, WhatsApp,
> real-time ERP chat, comms provider). The **current** roadmap seed is §0's "What
> is genuinely still open" — ERP-sync depth + public listing, De-Obara cleanup,
> SOC 2/ISO, the comms follow-ups, handwritten-PO + RLHF loop, front-end
> maintainability, and finishing the **forecast→BOM raw-material preorder** wedge.
> The tables below are the May-2026 plan, retained for history.

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
- Shielded: https://www.shieldedglobal.com, ycombinator.com/companies/shielded (YC S26, Susa Ventures)
- Naïve: https://usenaive.ai, ycombinator.com/companies/naive, techcrunch.com/2026/08/06 ($28.5M Series A, Nexus)
- Spaceflow: https://www.spaceflow.tech, ycombinator.com/companies/spaceflow-technologies-inc (YC S26)
