# Anvil — Competitive Review (2026-07)

**Status:** strategy / positioning. Not code. Original teardown: multi-agent run 2026-07-04 (16 companies). **Updated 2026-07-17** with 3 additions (Docket, Faction, Canals) → **19 companies**.

This is the canonical write-up of the memory `project_competitive_landscape`. Read it with the **honesty guardrails** at the bottom — conservative OEM / tier-1 buyers test rigorously; do not overclaim.

---

## 1. The one real, defensible wedge

**Forward-looking, BOM-exploded demand-to-preorder for Indian industrial sellers.** Opportunities → EV-weighted pipeline demand → `explodePipelineThroughBom()` → raw-material net requirements → draft procurement plans, running **live** in the `inventory-planning-weekly.js` cron.

**No competitor across all 19 does the forecast→BOM cascade.** Every procurement rival (Lumari, Korso, Hexa, Smartbase, Walter) is **reactive** reorder-point / shortage detection. This is deep, wired-live, and proprietary-data-backed (per-tenant BOM recipes = a switching-cost flywheel).

> "Agentic PO→SO" is **not** the wedge — 12+ rivals converge there (now including Faction, Canals, and the CPQ-flavored Docket).

---

## 2. The crowded cluster (Anvil's home turf — do not compete on it alone)

Agentic RFQ / PO→order / quote engines: **Arzana, Pactle, Comena, Avent, Axal, Soff, Mercura, Hexa, Walter, Smartbase** (mostly YC S24–S26, 2–6 person seed, US/EU) — **plus the 3 new entrants below**.

- **Most-direct full-chain mirrors:** Pactle, Hexa, Korso, Avent, Arzana, Comena, Smartbase, **Faction (new)**.
- **Adjacent / learn-only:** Raven, Dalton Mills, Parrot, Transload, **Canals (new)**, **Docket (new, CPQ axis)**.

---

## 3. New entrants (2026-07-17)

### Docket — `docket.io` (Palo Alto, US)
- **What:** AI agent for **manufacturing sales + CPQ**. Natural-language product configuration against catalogs/specs, real-time **engineering validation against compliance standards** (ATEX, SIL, PED, UL, IEC, FDA, ISO 13485, EU MDR), automated proposal generation. Integrates ERP/CRM/PLM. Tagline: *"From customer request to quote, automated."*
- **Overlap with Anvil:** the **quote / product-configuration** surface, and BOM-accuracy at quote time.
- **Where it's *ahead* of Anvil:** compliance-aware CPQ with engineering validation is a **real capability Anvil does not have** — this is a distinct axis, not just PO→SO extraction. Worth treating as a feature gap, not just a competitor.
- **Where Anvil is different:** no forecast→BOM preorder, no India finance/compliance rails, no downstream procurement/logistics/finance chain. Docket stops at the quote.
- **Threat level:** medium, on the *quote/config* story only — **not** the wedge. US-focused.

### Faction — `faction.ai` (US / global)
- **What:** enterprise AI automation for **manufacturers + distributors**: quoting (email/PDF→quote), order entry (multi-format→ERP), **dynamic pricing**, product-data enrichment, **procurement automation (PO gen + reconciliation)**, **AP/AR automation**, and **24/7 voice AI agents on live ERP data**. ERP integrations: Epicor, SAP, Oracle NetSuite, Infor. Taglines: *"AI for the most ambitious manufacturers and distributors"* / *"Quote faster. Source smarter. Get paid."* Claims 95%+ product-match accuracy, ~12% gross-margin expansion.
- **Overlap with Anvil:** the **closest new full-wedge mirror** — it spans the same doc-in→action-out chain (quote → order → procure → AP/AR) and *adds* dynamic pricing + voice + "get paid" AR, which reach into Anvil's pricing and finance-rails ambitions.
- **Where Anvil is different:** Faction's procurement is **reactive** (PO gen + reconcile), **no forecast→BOM cascade**; its AP/AR is generic, **not** India-specific (no Tally deep-reconcile, GST/e-invoice/e-way, TReDS, TDS/SAP-AP reality). US/global GTM.
- **Threat level:** **high** — the most serious of this batch. It is a broad, polished, ERP-integrated mirror of the crowded-cluster loop; it validates that "agentic quote→order→procure→AP/AR" is table stakes, and pressures Anvil on pricing + AR. It does **not** touch the wedge or the India rails.

### Canals — `canals.ai` (US / global, 100+ distributors)
- **What:** AI workflow automation for **distributors / manufacturers / contractors** in construction + industrial supply (electrical, plumbing, HVAC, MRO, lumber, building materials). Sales-order + quote generation from emails/PDFs/**handwritten notes/voicemails**, touchless **AP** invoice processing, **PO/receipt tracking with discrepancy flagging**, **part-number conversion across product lists**, customer chatbot. ML trained on industry complexity, **no templates**. Tagline: *"AI That Keeps Material Moving."*
- **Overlap with Anvil:** order-entry + RFQ→quote, PO/receipt discrepancy flagging (mirrors Anvil's logistics receiving/GRN), and notably **part-number conversion** — cross-catalog matching that overlaps Anvil's `item_master` matcher.
- **Where Anvil is different:** reactive order processing, **no forecast**, distribution/construction vertical (not manufacturer BOM/spares depth), no India rails.
- **Threat level:** medium — reinforces that cross-catalog **matching** is being commoditized (feeds the "close the data-flywheel seams" defensive move). A distribution-vertical play, adjacent to Anvil's manufacturer beachhead.

**Net effect of the 3 additions:** the wedge (forecast→BOM preorder) and the India rails remain **uncontested**. But the crowded cluster got more crowded and more *complete* — Faction adds breadth (pricing + AR + voice), Docket adds a compliance-CPQ depth Anvil lacks, Canals adds matching pressure. The takeaway is unchanged and reinforced: **do not compete on the agentic quote/order loop alone.**

---

## 4. Whitespace nobody else has

1. Forecast→BOM preorder (the wedge).
2. India finance/compliance rails — Tally deep-reconcile, GST/e-invoice/e-way, TReDS, TDS/SAP-AP reality.
3. Ocean LCL/FCL freight leg.
4. The single continuous doc-in→action-out chain: sales → procurement → logistics → finance.
5. India-tax-aware preflight.
6. Manufacturer BOM + spares + price-composition depth.
7. BRSR/ESG supplier-carbon (`src/api/brsr`) — un-marketed, a real India-regulatory moat that cascades from listed OEMs to Anvil's tier-1/2 buyers.

---

## 5. Threats (ranked)

- **Faction (new) — high.** Broadest full-chain mirror; pressures pricing + AR. Not India, not forecast→BOM.
- **Pactle** — the only India-native rival (same loop + Tally/GST). Thin: solo founder / ~9 people / unfunded; distribution is *inferred* from ex-OfBusiness/Bizongo pedigree, not proven.
- **Hexa** — OpenAI + YC; closest full-wedge mirror in the original set.
- **Zoho** (Chennai) — real GST rails + huge SMB reach; arguably a bigger India threat than Pactle.
- **Tally-native AI** (~2M installs) — owns the endpoint.
- **Docket (new) — medium.** A CPQ-compliance *feature gap* more than a wedge threat.
- **ERP incumbent copilots** (SAP Joule / D365 / NetSuite) — attack "smarter-than-ERP" from above.
- **LLM + MCP commoditization** of PO→SO extraction — the biggest structural risk to the whole cluster (Faction/Canals/Docket all ride it).

---

## 6. Honesty guardrails (load-bearing — do NOT overclaim)

- **Drop** the "rivals only integrate Western ERPs, Anvil can't be followed" line. Anvil already ships **16 Western ERP connectors** (netsuite/d365/p21/oracle_ebs/fusion/jde/acumatica/sage_x3/eclipse/plex/ifs/jobboss/ramco/proalpha/sxe/sap) + Tally — **connector breadth is parity, not a moat** (Faction integrates Epicor/SAP/NetSuite/Infor too). The India moat is compliance rails + the forecast→BOM core, defensible on **GTM focus + proprietary data**, not integration difficulty (GST rules are public; a funded rival + one Bangalore hire replicates the tax stack in 1–2 quarters).
- **Not shipped / do not demo as live:** freight "bidding" is manual CRUD (USD-defaulted bug); TReDS/e-invoice/e-way run sandbox/DRAFT (need GSP/M1xchange commercial agreements); TDS-aware AR unbuilt; order-level auto-approval-without-human does the **opposite** (approval-evaluator creates PENDING human gates); "probabilistic forecasting" is EV-weighted today (conformal intervals shipped behind a flag; the reliability/failure-driven demand is behind `reliability_demand_enabled`, dark). Duplicate-PO / wrong-vendor / quote-mismatch checks live only in the legacy POC, not the multi-tenant `validators.js`.
- Convert **≥1 finance leg** (one real IRN or TReDS disbursement) to live **before** it's load-bearing in the pitch.

---

## 7. Top moves

1. Honest **"buy-before-the-shortage"** hero demo (won-opp → BOM-explode → preorder + WhatsApp PO → preflight → Tally → dunning).
2. Weaponize shipped depth as **INR proof tiles** + a welding/servo-gun beachhead page (mostly GTM, not build).
3. **IndiaMART / JustDial / TradeIndia inbound connector** — closes the one top-of-funnel flank Pactle owns; builds on the shipped WhatsApp/email inbound pattern.
4. **SOC 2 Type II** + an India trust page.
5. Close the **data-flywheel seams** (composition `supplier_name` FK, first-class BOM recipes / freight lanes) — the real defense vs LLM/matching commoditization that Faction/Canals/Docket embody.

> Pricing / unit-economics were never analyzed — an untested assumption. **Distribution (not product) is the real contested surface.**

Relates to: `project_forecast_procurement_vision`, `project_po_to_so_flow`, `project_payment_reality`, `project_spare_intelligence_bridge`, `backlog_moat_bets`.
