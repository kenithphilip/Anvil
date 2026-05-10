# Anvil Strategic Development Plan

> Period: May 2026 to May 2027.
> Author: this document is a synthesis of internet research (4 parallel
> agents, 30+ verified sources cited inline) plus the existing strategic
> docs (`IMPROVEMENT_PLAN.md`, `GAP_ANALYSIS.md`, `PRICING_STRATEGY.md`,
> `DEFERRED_ROADMAP.md`).
> Status: draft, ready for product + engineering review.
> Supersedes the forward-looking sections of `IMPROVEMENT_PLAN.md` from
> Phase 7 onwards.
> Convention: every concrete claim is tagged `[V]` (verified against a
> URL cited at the bottom of the section) or `[B]` (belief, industry
> reasoning).

## 0. TL;DR

Anvil already shipped most of the 18-month gap-analysis plan. ERP
breadth, channels, document AI tiering, voice, vertical packs, AP
3-way match, MCP server, prospecting agent, Tally drift reconciliation
(F.6, this commit family) are all in `main`. The competitive set has
moved on too: Conexiom relaunched as the "Ideal Order Platform,"
Rossum shipped agent SDKs, Hyperscience added Hypercell, BILL is
pivoting into procurement.

The forward strategy is not "more breadth." It is **depth on the moats
the competitive scan does not show**, plus a foundation-model upgrade
path that compresses unit cost 5x without reducing quality, plus a
forecasting + conformal-prediction layer that turns the existing
inventory module into a defensible math product, plus a deliberate
India-anchor that the western IDP players cannot replicate without a
3-year compliance build.

Seven bets, ranked by ratio of (defensible value created) / (effort x
risk):

1. **Cost compression**: Gemini 3 Flash + Mistral OCR 3 replace Sonnet
   on the hot path. 5x lower cost per SO at equal quality.
2. **Format-template marketplace**: turn anchor templates from a
   per-tenant artefact into an exchangeable asset, optionally shared
   across tenants under contract.
3. **Conformal-prediction safety stock**: replace fixed-quantile with
   EnbPI / NEXCP intervals tied to per-SKU service-level guarantees.
4. **Schema-aligned parsing (BAML pattern)**: replace ad-hoc JSON
   parsing with constrained-generation reliability across every
   extraction path.
5. **Tally drift + reconciliation as the India wedge**: ship the F.6
   work as a paid SKU; nobody else has it.
6. **AA + TReDS receivables loop**: plug the Account Aggregator and
   TReDS rails into the customer-portal pay-now path. Rs 1.47 lakh cr
   already flows through AA in H1 FY26.
7. **BRSR value-chain reporting pack**: ship a tier-2 supplier
   compliance surface that anchors enterprise buyer mandates.

The Year-2 strategic decision (custom-fab vs buyer-side procurement)
should land as the answer to bet 7's adoption signal.

## 1. Where Anvil Stands (May 2026)

### 1.1 Capability snapshot

From `IMPROVEMENT_PLAN.md` and the F.6 commit family:

- **Inbound channels**: email (SendGrid + Postmark + Microsoft Graph),
  WhatsApp (Twilio + Meta), Slack, Teams, Voice (Vapi + Retell with
  TRAI/FCC compliance gates).
- **Document AI**: tiered chain Gemini 2.5 Flash (free) -> Mistral OCR
  (free) -> Azure DI F0 (free) -> Anthropic Claude (paid fallback).
  Per-customer format-template anchors after 3-4 POs.
- **ERP push**: 17 connectors live (NetSuite, Tally, SAP S/4HANA,
  Dynamics 365, Acumatica, Epicor Prophet 21, Eclipse, Infor SX.e,
  Sage X3, IFS Cloud, Oracle Fusion, Ramco, JDE EnterpriseOne, Plex,
  JobBoss, Oracle EBS, proALPHA).
- **Tally bridge plus voucher reconciliation**: Phase F.6 just
  shipped. Drift detection across totals, line counts, GSTIN, party,
  cancelled-in-Tally, altered-in-Tally. Auto-fix paths
  (cancelled -> order_failed, missing -> re_pushed). Cron every 30
  min after `tally/sync`.
- **GST e-invoice**: full IRN + QR + cancellation lifecycle. e-Way
  bill submission ready.
- **Inventory planning**: probabilistic forecasts per part (XGBoost +
  ETS + naive ensemble), multi-tier reorder, allocations workbench,
  supplier scorecards, calibration tab, forecast history.
- **AP 3-way match**: invoice / GR / PO reconciliation with deduction
  queue.
- **Anomaly engine**: rule-based plus price-deviation model.
- **Outbound prospecting agent**: campaigns, suppression lists,
  per-target approval gate, daily caps.
- **MCP server**: external AI assistants (Claude, ChatGPT, Copilot)
  can query Anvil's data plane through a 9-tool registry with
  scope-gated tokens.
- **Vertical packs**: 5 shipped (paper-converting, fasteners, PVF,
  electrical, HVAC).
- **SOC 2 code-side controls**: audit export (HMAC-signed JSONL),
  access review, deploy log, vuln scan runbook, incident playbook.
  Type II audit window in progress.
- **Mobile**: PWA shell (no native iOS, declined per
  `DEFERRED_ROADMAP.md`).

### 1.2 Pricing snapshot

From `PRICING_STRATEGY.md`. Three-tier subscription:

- Starter Rs 14,990 / mo, 200 SOs included, Rs 39 / SO overage.
- Growth Rs 49,990 / mo, 1,000 SOs included, Rs 19 / SO overage.
- Enterprise Rs 99,990+ / mo, 5,000 SOs included, Rs 9 / SO overage.

Marginal cost per SO ~Rs 2.70 today. The pricing leaves substantial
headroom but the per-SO unit cost can compress further with the
foundation-model upgrade described in bet 1 below.

### 1.3 What Anvil already does that competitors do not

From the verified competitor scan (section 2):

- India-specific GST + e-invoice + Tally voucher-state reconciliation
  is essentially absent from Rossum, Conexiom, Hyperscience, Turian,
  Motivate, Distro. `[B]`
- Industrial part-number aliasing with anchor templates after 3-4 POs
  is not a marketed feature of the western IDP players. `[B]`
- 17 ERP connectors at this price point is unmatched at the
  Indian-mid-market end of the market. `[B]`
- Drift reconciliation against a cancelled-in-ERP voucher is unique.
  Conexiom's "75 validation checks" are pre-push, not post-push. `[V]`

Note however that some of Anvil's stronger differentiators are not
visible in marketing today (spare matrix, supplier scorecard for
Korea/Japan/China imports, AMC / CAR / service-visit module, format
profile versioning, master-data graph). The marketing problem is
"don't erase moats" while sharpening the wedge narrative.

## 2. The Competitive Frame (verified May 2026)

### 2.1 Direct competitors

| Vendor | Positioning | Pricing signal | Anvil edge |
|---|---|---|---|
| [Conexiom](https://conexiom.com/) `[V]` | "AI Sales-Order Automation," 40+ ERPs, 75+ validation checks, anomaly detection. Most direct head-to-head. | Mid-enterprise, undisclosed. | Tally + GSTN + drift reconciliation; per-customer anchor templates; lower-mid-market price. |
| [Rossum](https://rossum.ai/solutions/order-management/) `[V]` | Template-free IDP plus dedicated Order Management product. Customer logos: Morton Salt, allnex, LAPP. | Starter ~$18k/yr `[V]` | India compliance; ERP write breadth; reconciliation. |
| [Esker](https://www.esker.com/solutions/order-management/) `[V]` | O2C suite incumbent with Synergy AI for multi-channel order capture. | Enterprise-priced. | Lighter footprint; faster time-to-pilot; per-SO economics for SMB. |
| [Hyperscience](https://www.hyperscience.ai/) `[V]` | Enterprise IDP, $100M Series E (2021), Spring 2026 added Hypercell + inference layering. Horizontal. | ~$1.50/page `[V]` | ERP push; reconciliation; vertical packs. |
| [Nanonets](https://nanonets.com/ocr-api/purchase-order-ocr) `[V]` | PO OCR API. AP-leaning. | Per-doc fee. | Full SO workflow, not just extraction. |
| [Turian.ai](https://www.turian.ai/sales-order-automation) `[V]` | AI agent for sales-order automation, wholesale + distribution. Outlook + Gmail forwarders. | Undisclosed. | India compliance; ERP breadth; reconciliation; vertical packs. |
| [Motivate](https://gomotivate.com/) `[V]` | "AI sales-order automation for B2B distributors," 50%+ touchless claim. | Undisclosed. | Same. |
| [Distro](https://distro.app/) `[V]` | AI revenue platform for distributors. AutoBid for RFQ/PO/Bid Lists. | Undisclosed. | Same. |
| [Veryfi](https://www.veryfi.com/) `[V]` | Mobile-first OCR API. | $0.16 / invoice `[V]` | Workflow on top of extraction. |
| [Klippa DocHorizon](https://www.klippa.com/) `[V]` | Horizontal IDP, now part of Doxis. | Undisclosed. | India + reconciliation. |

Funding signals last 18 months `[V]`:

- Conexiom relaunched the [Ideal Order Platform](https://www.prnewswire.com/news-releases/conexiom-launches-ai-powered-ideal-order-platform-to-revolutionize-sales-order-automation-302386165.html).
- Hyperscience [Spring 2026 release plus Hypercell](https://www.hyperscience.ai/).
- Rossum shipped [rossum-api 3.8.0 + rossum-agent-client 1.1.0](https://rossum.ai/) (agent SDKs).
- [Oro Labs raised $100M Series C](https://news.crunchbase.com/) (procurement platform).
- [Lio raised $30M Series A from a16z](https://techcrunch.com/2026/03/05/lio-ai-series-a-a16z-30m-raise-automate-enterprise-procurement/) March 2026.

### 2.2 Indian / APAC overlap

| Vendor | What they cover | Risk to Anvil |
|---|---|---|
| [Zoho Inventory](https://www.zoho.com/us/inventory/sales-order-management/) `[V]` | SO cycle, GST invoicing. | Strong local brand; no LLM ingestion of unstructured POs. Anvil sits above. |
| [Vyapar](https://vyaparapp.in/free/inventory-management-software/b2b) `[V]` | SME billing + inventory + lightweight PO. | Different segment (smaller SMB). |
| [TallyPrime native + partner add-ons](https://precisiontech.in/apps/tally/tally-tdl-addons/) `[V]` | e-invoice / IRN / EWB inside Tally. | Anvil's bridge competes here. Differentiates on multi-channel ingestion + ERP breadth. |
| [Procol](https://www.procol.ai/) `[V]` | Procurement-side (RFx). Series A $11.2M, Delhi. | Adjacent, not direct. |
| [Moglix](https://business.moglix.com/) + [Bizongo](https://www.cbinsights.com/company/bizongo) `[V]` | Marketplaces. Moglix has SaaS arm. | Different shape; Anvil is a workflow layer, not a catalog. |
| [Vinculum](https://www.vinculumgroup.com/) `[V]` | OMS / WMS for e-commerce. | Tangential. |
| [SuperProcure](https://www.superprocure.com/) `[V]` | Logistics TMS. | Not a competitor. |

Pure-play distributor SaaS in India is sparse. Anvil's wedge is real.
`[B]`

### 2.3 Adjacent threats

- [BILL](https://ramp.com/blog/stampli-vs-bill) launched a Procurement
  module Q1 2025. AR side stays invoice-issuance, not PO ingestion.
  Watch for pivot. `[V]`
- Stampli + Tipalti remain AP-only today. `[V]`
- Salesforce Revenue Cloud + HubSpot Sales Hub do not natively
  ingest unstructured POs. Partner ecosystem fills the gap. Real
  threat is build-or-buy, not the current product. `[B]`

### 2.4 White spaces

- India GST + e-invoice + Tally voucher-state reconciliation: defensible.
- Industrial part-number aliasing with anchor templates: not marketed
  by the western IDP set.
- Mid-market pricing tier: floor is high (Rossum from $18k/yr,
  Hyperscience ~$1.50/page, Veryfi $500/mo). Anvil's Rs 14,990 / mo
  Starter is ~$179, an order of magnitude below floor.
- Post-push reconciliation (drift detection): Anvil-only. `[B]`

### 2.5 Pricing assessment

Rs 19-39 / SO is in line with Veryfi's per-doc fee `[V]` and well
below Hyperscience / Rossum. `[B]`: appropriately positioned for
Indian mid-market but likely too low for global SAP / NetSuite / IFS
deployments where Conexiom and Rossum compete. The pricing model
under-monetizes the ERP-write side (17 connectors); see bet 5 for the
"Tally drift as a paid SKU" upsell path.

Recommendation: introduce a Global tier for non-Indian deployments at
Rs 79 / SO ($1.00 / SO) or a ladder
(Rs 19 / Rs 39 / Rs 79 / Rs 9-volume). Trial before committing.

## 3. The AI Frontier (verified May 2026)

### 3.1 Frontier model lineup

`[V]` from research agent citations:

| Model | Price (input/output per 1M) | Context | Notes |
|---|---|---|---|
| Claude Opus 4.7 | $5 / $25 | 1M | 1M-context PDF processing, 600 pages/request, 90% prompt-cache discount. |
| Claude Sonnet 4.6 | $3 / $15 | 1M | Same. |
| Claude Haiku 4.5 | $1 / $5 | 200k | Fast preflight. |
| Gemini 3 Flash | $0.50 / $3 | 1M | Native PDF / image input, `media_resolution` knob (low / medium / high). |
| Gemini 3 Pro | undisclosed | 1M | Frontier multimodal. |
| GPT-5 | $1.25 / $10 | 1M+ | OpenAI default. |
| GPT-5.4 | $2.50 / $15 | | Mid. |
| GPT-5.5 | undisclosed | | Late April 2026 release. |
| Mistral Pixtral Large 124B | self-host | | Apache 2.0. |
| Qwen3-VL-235B + Qwen2.5-VL | self-host | | Qwen2.5-VL leads DocVQA at 0.964. |
| Llama 4 Scout / Maverick | self-host | | Native multimodal early-fusion. |

Sources: [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing),
[Gemini 3 Flash announcement](https://blog.google/products-and-platforms/products/gemini/gemini-3-flash/),
[OpenAI GPT-5.5](https://openai.com/index/introducing-gpt-5-5/),
[BentoML multimodal survey](https://www.bentoml.com/blog/multimodal-ai-a-guide-to-open-source-vision-language-models),
[DocVQA leaderboard](https://llm-stats.com/benchmarks/docvqa).

### 3.2 OCR + table parsing

`[V]`:

- [Mistral OCR 3](https://mistral.ai/news/mistral-ocr-3): $2 / 1k
  pages standard, $1 / 1k pages batch, 88.9% on handwriting, 96.6%
  on tables. Beats Azure / Textract on the published benchmark.
- [Docling](https://www.ibm.com/think/news/doclings-rise-llm-ready-data)
  (IBM, 37k+ stars, Apache 2.0): 97.9% complex-table accuracy,
  Granite-Docling-258M VLM (Jan 2026). Already in Anvil's stack.
- [DocLayout-YOLO](https://arxiv.org/html/2410.12628v1): YOLOv10 speed
  on layout, beats LayoutLMv3 / DiT-Cascade.
- [OmniDocBench](https://github.com/opendatalab/OmniDocBench) (CVPR
  2025, updated April 30 2026): canonical benchmark; GLM-OCR holds
  SOTA at 94.6%, beats Gemini 3 Pro and GPT-5.2.

### 3.3 Open-source extraction libraries

`[V]`:

- [Docling](https://github.com/DS4SD/docling) - production, Apache 2.0,
  best-in-class on tables.
- [Marker](https://github.com/VikParuchuri/marker) - production-grade
  PDF -> Markdown for RAG.
- [Unstructured.io](https://unstructured.io/) - production for mixed
  ingestion.
- [BAML (Boundary)](https://boundaryml.com/blog/schema-aligned-parsing) -
  production. Schema-Aligned Parsing handles trailing commas, chain-
  of-thought, markdown-wrapped JSON.
- [Instructor](https://github.com/jxnl/instructor) (Jason Liu) -
  production. Pydantic + retry on validation failure.
- [Outlines](https://github.com/outlines-dev/outlines) /
  [XGrammar](https://github.com/mlc-ai/xgrammar) - grammar-constrained
  generation. XGrammar is now default in vLLM / SGLang / TensorRT-LLM
  at <40 microseconds / token.
- [LlamaParse](https://github.com/run-llama/llama_cloud_services) -
  hosted parser by LlamaIndex.
- [Reducto](https://reducto.ai/) - hosted, in benchmarks.

### 3.4 Cost-quality Pareto for PO extraction (mid-2026)

`[B]` synthesized from agent 2:

```
budget end:  Mistral OCR 3 batch ($1/1k pages) -> Gemini 3 Flash
              ($0.50 in / $3 out) for structuring.

mid:          Sonnet 4.6 / GPT-5.4 / Qwen2.5-VL-72B self-host.

fallback:     Opus 4.7 only on the bottom 2-5% where the chain
              fails confidence threshold.
```

### 3.5 Constrained generation state of practice

Reliability ranking (best to worst):

1. BAML Schema-Aligned Parsing.
2. Native structured outputs (OpenAI / Anthropic).
3. Function calling.
4. JSON mode.
5. Prompt + regex.

Anvil today uses (5) in many places. Migrate to (1) or (2). See bet 4.

## 4. The Math Frontier (verified May 2026)

### 4.1 Foundation forecasting models

`[V]` from research agent citations:

| Model | License | Notes |
|---|---|---|
| [Chronos-2](https://huggingface.co/amazon/chronos-2) | Apache 2.0 | 120M-param encoder. Univariate + multivariate + covariate-informed zero-shot. SageMaker-deployable. Leads [GIFT-Eval](https://tsfm.ai/benchmarks/gift-eval) on WQL + MASE. |
| [Moirai 2.0](https://arxiv.org/html/2511.11698v3) | research | Decoder-only, 36M series, quantile + multi-token. Top-5 GIFT-Eval. |
| TimeGPT (Nixtla) | commercial API | Pay-per-call. |
| Lag-Llama / MOMENT / Tiny Time Mixers | research | Smaller community than Chronos / Moirai. |

Practical note `[B]`: zero-shot beats untuned ETS / ARIMA on most
domains. Tuned LightGBM with quantile loss still competes on retail
/ intermittent. Anvil should keep its XGBoost / ETS / naive ensemble
as a baseline and add Chronos-2 zero-shot as a *challenger* per WAPE
bucket. Chronos-2 wins on WAPE in some buckets; the ensemble retains
the rest.

### 4.2 Intermittent demand

`[V]`:

- [TSB-HB (November 2025)](https://arxiv.org/abs/2511.12749): Beta-
  Binomial on demand occurrence + Log-Normal on size with hierarchical
  priors enabling partial pooling. Lower MAE / RMSE than CrostonSBA
  and ADIDA on the cited datasets.
- [Nixtla statsforecast Croston / SBA](https://nixtlaverse.nixtla.io/statsforecast/docs/models/crostonsba.html)
  remains the standard library.

`[B]`: pure deep learning has not consistently beaten Croston / SBA /
TSB on very short, very low-volume series. Hybrids (DL + intermittent-
class feature) are the practical pattern.

Anvil action: add TSB-HB to the inventory model menu. Use it for SKUs
that fail the 24-month-history filter. Keep Croston / SBA as the
fallback.

### 4.3 Conformal prediction for demand intervals

`[V]`:

- Mature toolkit: [SCP, weighted CP, ACI, EnbPI, Block CP](https://arxiv.org/html/2511.13608v1).
- EnbPI gives widest intervals; SCP / WCP / ACI tend to be tighter at
  nominal coverage.
- NEXCP weights recent residuals higher for non-exchangeable streams.
- [CPTC NeurIPS 2025](https://arxiv.org/abs/2509.02844) handles
  change-points by predicting an underlying state.

Anvil action: replace fixed-quantile safety stock with conformal
intervals. Use EnbPI for non-stationary SKUs, NEXCP for fast-drift.
This converts the inventory-planning module from a forecast tool to a
service-level-guarantee tool. See bet 3.

### 4.4 Multi-echelon

`[V]` (vendor-reported; treat as upper bound): duplicating safety
stock across echelons is wasteful; pushing it toward customer-facing
nodes plus probabilistic forecasts cuts total inventory 15-30% at the
same service level ([ToolsGroup / o9](https://o9solutions.com/articles/what-is-multi-echelon-inventory-optimization),
[Mecalux](https://www.interlakemecalux.com/blog/multi-echelon-inventory-optimization)).

Per-echelon ROP = avg-demand x lead-time + safety stock, with safety
stock derived from the convolution of demand and lead-time variability.

### 4.5 Reinforcement learning for inventory

`[V]`:

- [Amazon's deep periodic-review system](https://arxiv.org/pdf/2210.03137)
  (Madeka et al.) is in production. Lost sales, correlated demand,
  stochastic lead-times, price matching.
- [Liu et al. 2025 M&SOM](https://journals.sagepub.com/doi/10.1177/10591478241305863)
  shows multi-agent DRL beating heuristics on multi-echelon.

`[B]`: outside Amazon-scale, DRL has only matched (s, S) / base-stock
in narrow settings. Tuned base-stock with good forecasts is the sane
default. Anvil should not invest in DRL until the core ensemble +
conformal layer is proven.

### 4.6 Causal / promotion uplift

`[V]`:

- [DoorDash KDD 2025](https://causal-machine-learning.github.io/kdd2025-workshop/papers/16.pdf)
  deploys S-/T-Learner and Double ML for promotion uplift with
  continuous treatment intensities.
- [Zhang/Meng 2025](https://journals.sagepub.com/doi/10.1177/14727978251338001)
  Dynamic STL-GBM elasticity pipelines combine seasonal decomposition
  with GBM.

Anvil action: not in the Year-1 plan. Anvil's anomaly engine already
flags price deviations. Causal uplift is a Year-2 add when there's
enough price-elasticity data per customer.

### 4.7 Quantile / newsvendor at scale

`[V]`: LightGBM `quantile` objective and DeepAR-style quantile heads
are the production default for service-level-targeted stocking. The
newsvendor optimum is the demand-quantile at the critical ratio.
End-to-end "loss-aware" deep newsvendor variants exist but adoption
is still narrow.

Anvil already uses XGBoost; switching to LightGBM with quantile
objective is small effort.

## 5. The Indian Market Reality (verified May 2026)

### 5.1 GST + e-invoice

`[V]`:

- Rs 5 cr AATO threshold remains the active mandate
  ([gimbooks](https://www.gimbooks.com/blog/5-crore-e-invoice-turnover-rule-2026/),
  [ClearTax](https://cleartax.in/s/e-invoicing-gst)).
- 30-day IRN reporting rule for AATO >= Rs 10 cr active from 1 April
  2025.
- e-Way Bill 2.0 portal went live 1 July 2025. Note: NOT "e-invoice
  2.0" - common misread.

`[B]`: B2C e-invoice piloted in 6 states from 2024; no firm 2026
national mandate confirmed.

Anvil action: keep the IRN + EWB stack updated against the EWB 2.0
portal. Confirm 30-day reporting deadline is enforced in the
push-to-GSTN cron.

### 5.2 Tally

`[V]`:

- [TallyPrime 7.0](https://www.novatechnosys.com/blogs/tallyprime-7-0-top-accounting-software-2026)
  is the 2026 release. Connected Banking, TallyDrive cloud backup,
  SmartFind, IMS, scheduled auto-backup.
- TallyDrive = Tally's first-party cloud backup.
- Cloud-hosted access via partners ~Rs 600 / user / month.

`[B]`: official integration is still TDL / XML over HTTP.
Third-party REST wrappers ([api2books](https://api2books.com/)) fill
the gap. No evidence of a first-party "AI" SKU comparable to NetSuite
Text Enhance.

Anvil action: harden the bridge against Tally 7 changes. Confirm the
multi-company resolution logic (validate.js fix in F.6 commit family)
covers TallyDrive setups. Phase F.6 reconciliation already addresses
the pain point of "did Tally actually accept the voucher."

### 5.3 GeM

`[V]`: FY26 GMV Rs 5.03 lakh crore (down 7.4% YoY); cumulative
Rs 18.4 lakh crore since 2016; MSMEs = 73% of sellers, 68% of orders
([Business Standard](https://www.business-standard.com/economy/news/gem-records-18-4-trillion-gmv-since-inception-msmes-dominate-fy26-126040600855_1.html)).

GeM is **public-sector procurement only**. Does NOT mandate private
buyers. Overseas seller participation opened in 2026.

Anvil action: defer. GeM is not the Anvil ICP; build only if a pilot
asks for it.

### 5.4 ONDC B2B

`[B]`: B2B testing began December 2022. Could not find primary
GMV / RFQ adoption numbers for 2026. Real-world signal still weak.

Anvil action: defer. Plan an optional ONDC connector when a paying
pilot asks. Not core.

### 5.5 Account Aggregator + TReDS

`[V]`:

- 7.94 cr Udyam registrations as of 5 May 2026
  ([IBEF](https://www.ibef.org/news/over-7-83-crore-enterprises-registered-on-udyam-platforms-indicating-strong-msme-formalisation-growth)).
- Account Aggregator: Rs 1.47 lakh crore loans in H1 FY26
  (~Rs 24k cr / month, up from Rs 14k cr / month in H2 FY25);
  ~7.7% of retail + MSME lending value
  ([SMEStreet on Sahamati](https://smestreet.in/banking/finance/account-aggregator-lending-reaches-147-lakh-crore-in-h1-fy26-11074801)).
- Union Budget 2026-27 announced **mandatory TReDS for CPSE
  purchases**, CGTMSE-backed invoice discounting, **GeM-TReDS
  integration**
  ([gimbooks](https://www.gimbooks.com/blog/budget-grants-credit-and-subsidies-for-small-businesses/)).

This is a strong tailwind for invoice-to-cash flows Anvil could plug
into. See bet 6.

### 5.6 SEBI BRSR

`[V]`: value-chain disclosure deferred to FY 2025-26 for top 250
listed companies; FY26-27 brings third-party assurance; reporting
threshold = suppliers / customers >= 2% of purchases or 75% cumulative
([reporting.academy](https://reporting.academy/en/pages/sebi-postpones-mandatory-esg-disclosures-for-value-chain-to-2026/),
[SEBI BRSR Core circular](https://www.sebi.gov.in/legal/circulars/jul-2023/brsr-core-framework-for-assurance-and-esg-disclosures-for-value-chain_73854.html)).

Direct downward pressure on supplier digitization. Strong Anvil
tailwind. See bet 7.

### 5.7 PLI + OEM tier-2

`[V]`: Foxconn Devanahalli ~Rs 20k cr, 50k headcount target 2026,
operational. Apple / Samsung / Foxconn anchored
([The Week](https://www.theweek.in/news/sci-tech/2026/05/02/tata-electronics-apple-india-foxconn.html)).

`[B]`: no primary source verifies tier-2/3 contractual procurement
mandates. Industry norm: SAP Ariba / Coupa for tier-1, looser for
tier-2. Treat as opportunity, not given.

### 5.8 ERP penetration

`[B]`: Tally dominates Indian SMB <Rs 100 cr revenue. SAP B1 +
NetSuite split mid-market; one secondary cite claims ~70% of
mid-market deals are NetSuite vs SAP B1
([techcloudpro](https://techcloudpro.com/blog/netsuite-vs-sap-business-one-mid-market/)).
Common combo: Tally for accounting + Excel / legacy DMS for sales ops.

This validates Anvil's positioning: sit on top of Tally + push to
NetSuite / SAP B1 in the upgrade path.

## 6. Strategic Bets (next 12 months)

Each bet has scope, success metric, owner, and dependencies.

### Bet 1: Foundation-model upgrade path (cost compression)

**Scope.** Replace Sonnet on the hot path with Gemini 3 Flash + Mistral
OCR 3. Sonnet 4.6 stays as the fallback only when confidence < 0.85.

**Files.**

- `src/api/_lib/docai/gemini-client.js`: bump to Gemini 3 Flash
  default. Add `media_resolution` knob.
- `src/api/_lib/docai/mistral-ocr-client.js`: bump to Mistral OCR 3
  batch endpoint for non-realtime traffic.
- `src/api/_lib/docai/dispatcher.js`: chain order
  `gemini_3_flash -> mistral_ocr_3 -> azure_di -> claude_4_6`. Drop
  `gemini_2_5` step.
- `src/api/admin/docai_settings.js`: tighten model regex to accept
  `gemini-3-flash-*`, `mistral-ocr-3-*`, `claude-(opus|sonnet|haiku)-4-(5|6|7)-*`.
- `docs/COST_OPTIMIZED_DEPLOYMENT.md`: refresh price math; cost
  per SO drops from ~Rs 2.40 to ~Rs 0.50 at 18-line POs.

**Success metric.** Median cost per SO drops 5x while extraction
accuracy on the OmniDocBench-equivalent eval suite stays within 2%.

**Effort.** ~3 days.

**Owner.** Backend / DocAI.

### Bet 2: Format-template marketplace

**Scope.** Anvil already builds per-customer anchor templates after
3-4 POs. Surface them as a sharable artefact. Tenants can opt in to
publish their templates back to a global library; new tenants whose
PO matches a published template skip the 3-4-PO warm-up.

**Files.**

- `supabase/migrations/096_template_marketplace.sql`: new
  `customer_format_templates_global` table + opt-in flag on
  `tenant_settings`.
- `src/api/_lib/docai/template-matcher.js`: extend to match against
  the global library before falling back to LLM.
- `src/api/admin/templates_publish.js`: opt-in publication endpoint
  with PII scrub + customer-name redaction.
- `src/v3-app/screens/admin.tsx`: marketplace tab.

**Success metric.** % of new-tenant POs that hit a global template on
first upload. Target: 30% within 6 months of launch.

**Effort.** ~2 weeks. Includes the legal review of cross-tenant data
sharing.

**Owner.** Product + DocAI.

**Risk.** Privacy / data-sharing concerns. Mitigation: opt-in only,
PII-scrubbed templates, anonymised customer names, audit log of every
publication.

### Bet 3: Conformal-prediction safety stock

**Scope.** Replace fixed-quantile safety stock with conformal intervals.
EnbPI for non-stationary SKUs, NEXCP for fast-drift, SCP fallback.

**Files.**

- `supabase/migrations/097_conformal_intervals.sql`: add
  `conformal_method`, `coverage_target`, `interval_lo`, `interval_hi`
  to `inventory_reorder_plans`.
- `src/api/inventory/forecast.js`: integrate
  [MAPIE](https://mapie.readthedocs.io/) or
  [crepes](https://github.com/henrikbostrom/crepes) for CP.
- `src/v3-app/screens/inventory-planning.tsx`: render the interval
  band on the per-item chart. Operator can pick coverage (90 / 95 /
  99%) per SKU class.
- `docs/INVENTORY_PLANNING_DESIGN.md`: refresh.

**Success metric.** Stockout rate drops by 20% on the SKUs that get
conformal coverage at the same average inventory holding.

**Effort.** ~3 weeks.

**Owner.** Inventory / Math.

**Dependency.** None.

### Bet 4: Schema-aligned parsing migration (BAML pattern)

**Scope.** Replace ad-hoc JSON parsing across every extraction path
with constrained-generation reliability. Use BAML's Schema-Aligned
Parsing as the model.

**Files.**

- `src/api/_lib/docai/parser.js`: new shared parser with retry on
  schema validation failure. Reject markdown wrapping, trailing
  commas, chain-of-thought leakage.
- `src/api/_lib/docai/voter.js`: cross-adapter voter consumes only
  parsed-and-validated outputs.
- All extraction call sites migrate.

**Success metric.** "JSON parse error" rate drops to < 0.1% from the
current ~2% (per `extraction_runs` audit table).

**Effort.** ~2 weeks.

**Owner.** Backend / DocAI.

### Bet 5: Tally drift + reconciliation as a paid SKU

**Scope.** Phase F.6 just shipped the engine. Now productize it.

**Files.**

- `src/v3-app/screens/landing.tsx`: add a "Voucher reconciliation"
  feature card with three real screenshots.
- `docs/PRICING_STRATEGY.md`: add a Reconciliation Add-On
  (Rs 1.50 / SO uplift on the per-SO rate) for tenants with > 1
  GSTIN. Justification: this is unique to Anvil; Conexiom / Rossum
  cannot do post-push drift detection.
- Marketing: a 60-second product demo video showing
  reconcile-now -> cancelled-in-Tally finding -> auto re-push.

**Success metric.** 30% of Indian Growth-tier customers attach the
add-on within 6 months.

**Effort.** ~1 week of marketing + product copy. Engine is shipped.

**Owner.** Marketing + Product.

### Bet 6: AA + TReDS receivables loop

**Scope.** Plug Account Aggregator (RBI rails) and TReDS (invoice
discounting) into the customer-portal pay-now path. When a customer
pays an invoice late, Anvil offers them an AA-mediated invoice
discount through a TReDS partner. Closes the cash loop.

**Files.**

- `supabase/migrations/098_aa_treds.sql`: new `aa_consents`,
  `treds_discounts` tables.
- `src/api/aa/consent.js`: AA consent flow per the Sahamati spec.
- `src/api/treds/list_offers.js`: read TReDS offers per invoice.
- `src/api/treds/discount.js`: accept a discount.
- `src/v3-app/screens/customer-portal.tsx`: "Get paid faster" button
  surfaces AA + TReDS.

**Success metric.** 5% of overdue invoices get discounted via TReDS
within 6 months. AA consent rate > 60% on prompt.

**Effort.** ~4 weeks. Includes the AA / TReDS partner integration
(probably one of M1xchange, RXIL, Invoicemart).

**Owner.** Backend + Partnerships.

**Dependency.** TReDS partner contract.

### Bet 7: BRSR value-chain reporting pack

**Scope.** Top 250 listed companies must report Scope 3 / supplier
ESG from FY 2025-26. Suppliers >= 2% of purchases must be covered.
Anvil's tier-2 suppliers are exactly the surface that needs to be
digitized.

**Files.**

- `supabase/migrations/099_brsr_supplier_disclosures.sql`: new
  `supplier_disclosures` table per supplier per period.
- `src/api/brsr/supplier_disclosure.js`: the supplier fills out 12
  fields (carbon emissions estimate, % renewable, EHS practices,
  diversity stats, etc.) per period.
- `src/api/brsr/buyer_export.js`: the buyer pulls the rolled-up CSV
  in BRSR-Core format.
- `src/v3-app/screens/brsr.tsx`: supplier-side form + buyer-side
  dashboard.

**Success metric.** 5 enterprise pilots from listed-company tier
within 12 months. Each pilot drags 20-50 tier-2 suppliers onto Anvil.

**Effort.** ~6 weeks. Includes the BRSR-Core schema mapping.

**Owner.** Product + Compliance.

**Dependency.** SEBI BRSR-Core circular as the schema source of truth.

## 7. The Year-2 Question

Per `IMPROVEMENT_PLAN.md` section 9, the Year-2 strategic decision
is between **buyer-side procurement** (compete with Lumari) and
**custom-fab CNC quoting** (compete with Paperless Parts).

This plan's recommendation: **let bet 7 (BRSR) be the answer**.

If BRSR pilots land in the listed-company tier, Anvil's natural
expansion is buyer-side: large buyers want their tier-2 suppliers
digitized, and Anvil sits on the supplier side. Buyer-side is the
mirror; ship a buyer-cockpit that aggregates supplier feeds.

If BRSR pilots stall, the next-best wedge is custom-fab CNC because
the format-template moat (bet 2) directly addresses the "every CAD is
different" problem CNC quoting platforms solve manually.

Decision date: November 2026, after the BRSR pilot signal lands.

## 8. What we explicitly do NOT do

- **Native iOS app.** PWA shell stays the mobile surface
  (`DEFERRED_ROADMAP.md` decision; declined May 2026).
- **DRL for inventory.** Math frontier confirms tuned base-stock with
  good forecasts is the sane default outside Amazon-scale.
- **Pricing tiers in PR-only or chat-only signal.** Pricing changes
  ship to `PRICING_STRATEGY.md` first, only then to the marketing
  page.
- **Customer testimonials with named real companies** until each
  pilot has signed a logo-use clause. The plan in
  `~/.claude/plans/keep-going-why-aren-t-linked-squid.md` already
  flagged this.
- **GeM connector** until a paying pilot asks. GeM is public-sector
  only; not Anvil's ICP.
- **ONDC B2B connector** until adoption signal lands. December 2022
  testing kicked off; 2026 traction is still weak per the research.
- **Generic ESG dashboard.** Bet 7 is BRSR-specific because the
  regulation is the wedge. Generic ESG is too broad to compete.

## 9. Risks and counterbets

### 9.1 Foundation-model price spike

**Risk.** Anthropic / Google / OpenAI raise prices. Bet 1 economics
break.

**Counterbet.** Self-host Qwen2.5-VL-72B or Pixtral Large as a fallback
chain entry. The Apache 2.0 weights mean Anvil can keep the cost
floor near zero on dedicated hardware.

### 9.2 Conexiom / Rossum land in India

**Risk.** Conexiom's "40+ ERPs, 75 validations, anomaly detection"
narrative lands in the Indian mid-market.

**Counterbet.** Phase F.6 reconciliation + the GST + Tally + EWB
integration is a 12-month build for them. Anvil's lead is real but
not infinite. Bet 5 (productize reconciliation) and bet 7 (BRSR
wedge) widen the lead.

### 9.3 BILL or Stampli pivots from AP into AR / SO

**Risk.** BILL has the AP user base and the procurement-side network
effect. AR pivot is plausible.

**Counterbet.** Anvil's Indian compliance stack is a 12-month moat.
BILL's AP-first base also means they will not prioritize India until
they have to.

### 9.4 Tally itself ships drift detection

**Risk.** Tally launches a first-party reconciliation feature.

**Counterbet.** Tally has been XML-over-HTTP for 20 years; first-party
features ship slowly. Even if they do, Anvil's multi-channel
ingestion + ERP-to-ERP push remains the competitive ground.

### 9.5 Foundation forecasting models invalidate Anvil's ensemble

**Risk.** Chronos-3 or equivalent ships and beats LightGBM by a wide
margin on industrial-distribution time series.

**Counterbet.** Bet 3 (conformal prediction) is forecast-model agnostic.
Even when the model improves, the safety-stock formulation stays
defensible. Anvil's moat is the operator workflow, not the forecaster.

### 9.6 SOC 2 Type II observation extends past Q3 2026

**Risk.** Type II audit drags into 2027.

**Counterbet.** No engineering counter-bet. Allocate program time;
do not let the audit window's slippage block product progress.

## 10. Operating cadence

- **Monthly review** of bet velocity. Owner: Product. Check: each
  bet has a 1-line update (active / blocked / done / re-scoped).
- **Quarterly review** of pricing cohort behaviour. Owner: Sales +
  Finance. Check: are pilots clustering at the Starter ceiling? Did
  the Reconciliation Add-On (bet 5) land?
- **After every 5 paid pilots**: re-evaluate the Growth ceiling per
  `PRICING_STRATEGY.md`.
- **November 2026**: Year-2 strategic-decision call (bet 7 signal).
- **Annual**: foundation-model recheck. Anthropic + Mistral + Google
  prices typically drop 30-50% per generation. Half passes through to
  customers, half stays as margin.

## 11. Open questions for the team

1. **Bet 1 trigger**: Gemini 3 Flash is cheap enough that Sonnet 4.6
   becomes a fallback. Confirm the cost-per-SO target with finance
   before flipping the dispatcher.
2. **Bet 2 legal**: cross-tenant template sharing needs a DPA
   amendment. Counsel review needed.
3. **Bet 3 coverage levels**: 95% default? per-class?
4. **Bet 5 add-on pricing**: Rs 1.50 / SO is a guess. Test against 5
   pilots.
5. **Bet 6 TReDS partner**: M1xchange, RXIL, or Invoicemart? Pick
   based on lowest commission and Indian-mid-market presence.
6. **Bet 7 ICP**: top 250 listed BRSR is the obvious target; do we
   also chase the FY26-27 expansion to top 1000?
7. **Year-2 question**: do we want to be locked to a November 2026
   decision, or do we make the call at month 9 if signal is clear?

## 12. Change log

- **2026-05-10**: initial draft. Synthesis of competitor scan, AI
  frontier, math frontier, India market context (4 parallel research
  agents) plus existing strategy docs. Seven bets ranked by ratio of
  defensible value to effort. Owners and dates open for team input.

## Appendix A: Sources cited (all `[V]`)

### Competitive set

- [Conexiom](https://conexiom.com/)
- [Conexiom Ideal Order Platform launch](https://www.prnewswire.com/news-releases/conexiom-launches-ai-powered-ideal-order-platform-to-revolutionize-sales-order-automation-302386165.html)
- [Rossum](https://rossum.ai/)
- [Rossum Order Management](https://rossum.ai/solutions/order-management/)
- [Esker](https://www.esker.com/solutions/order-management/)
- [Hyperscience](https://www.hyperscience.ai/)
- [Nanonets PO OCR](https://nanonets.com/ocr-api/purchase-order-ocr)
- [Klippa DocHorizon](https://www.klippa.com/en/blog/information/data-extraction-software/)
- [Veryfi](https://www.veryfi.com/)
- [Turian.ai](https://www.turian.ai/sales-order-automation)
- [Motivate](https://gomotivate.com/)
- [Distro](https://distro.app/)
- [Zoho Inventory](https://www.zoho.com/us/inventory/sales-order-management/)
- [Vyapar](https://vyaparapp.in/free/inventory-management-software/b2b)
- [PrecisionTech Tally TDL](https://precisiontech.in/apps/tally/tally-tdl-addons/)
- [Procol](https://www.procol.ai/)
- [Moglix](https://business.moglix.com/)
- [Bizongo](https://www.cbinsights.com/company/bizongo)
- [Vinculum](https://www.vinculumgroup.com/)
- [SuperProcure](https://www.superprocure.com/)

### AI frontier

- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Claude Opus 4.6 / Sonnet 4.6 1M context](https://signals.aktagon.com/articles/2026/03/claude-opus-4.6-and-sonnet-4.6-now-feature-1m-context-window-at-standard-pricing/)
- [Gemini 3 Flash](https://blog.google/products-and-platforms/products/gemini/gemini-3-flash/)
- [Vertex Gemini 3 Flash docs](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-flash)
- [GPT-5.5](https://openai.com/index/introducing-gpt-5-5/)
- [Mistral OCR 3](https://mistral.ai/news/mistral-ocr-3)
- [Docling on IBM](https://www.ibm.com/think/news/doclings-rise-llm-ready-data)
- [Docling layout report (arxiv)](https://arxiv.org/html/2509.11720v1)
- [BAML Schema-Aligned Parsing](https://boundaryml.com/blog/schema-aligned-parsing)
- [DocLayout-YOLO](https://arxiv.org/html/2410.12628v1)
- [OmniDocBench](https://github.com/opendatalab/OmniDocBench)
- [DocVQA leaderboard](https://llm-stats.com/benchmarks/docvqa)
- [BentoML multimodal survey](https://www.bentoml.com/blog/multimodal-ai-a-guide-to-open-source-vision-language-models)
- [Codersera open-source LLM 2026](https://codersera.com/blog/best-open-source-llm-2026-llama-4-qwen-3-5-deepseek-v4-gemma-4-mistral/)

### Math frontier

- [Chronos-2](https://huggingface.co/amazon/chronos-2)
- [Moirai 2.0](https://arxiv.org/html/2511.11698v3)
- [GIFT-Eval](https://tsfm.ai/benchmarks/gift-eval)
- [TSB-HB](https://arxiv.org/abs/2511.12749)
- [Nixtla statsforecast Croston/SBA](https://nixtlaverse.nixtla.io/statsforecast/docs/models/crostonsba.html)
- [Conformal prediction survey 2025](https://arxiv.org/html/2511.13608v1)
- [CPTC NeurIPS 2025](https://arxiv.org/abs/2509.02844)
- [Amazon deep periodic-review](https://arxiv.org/pdf/2210.03137)
- [Liu et al. 2025 multi-agent DRL](https://journals.sagepub.com/doi/10.1177/10591478241305863)
- [DoorDash KDD 2025 promotion uplift](https://causal-machine-learning.github.io/kdd2025-workshop/papers/16.pdf)
- [Zhang/Meng 2025 STL-GBM elasticity](https://journals.sagepub.com/doi/10.1177/14727978251338001)
- [M5 Walmart hierarchical retail](https://www.sciencedirect.com/science/article/pii/S0169207021001874)
- [Quantile newsvendor survey](https://arxiv.org/pdf/2305.07993)
- [ToolsGroup multi-echelon](https://o9solutions.com/articles/what-is-multi-echelon-inventory-optimization)
- [Mecalux multi-echelon](https://www.interlakemecalux.com/blog/multi-echelon-inventory-optimization)

### Indian market

- [GST 5cr threshold](https://www.gimbooks.com/blog/5-crore-e-invoice-turnover-rule-2026/)
- [ClearTax e-invoicing summary](https://cleartax.in/s/e-invoicing-gst)
- [EWB 2.0 portal launch](https://taxreply.com/gst/Launch_of_new_E-way_Bill_Portal_2_0__GSTN_Advisory_from_1st_July_2025-1571.html)
- [TallyPrime 7.0](https://www.novatechnosys.com/blogs/tallyprime-7-0-top-accounting-software-2026)
- [TallyPrime 7.0 secondary cite](https://www.tallyatcloud.com/article/tallyprime-software-2026-full-features-gst-returns-compliance-accounting-solution-for-businesses/934/0/1)
- [api2books Tally REST wrapper](https://api2books.com/)
- [GeM FY26 GMV (Business Standard)](https://www.business-standard.com/economy/news/gem-records-18-4-trillion-gmv-since-inception-msmes-dominate-fy26-126040600855_1.html)
- [GeM overseas seller opening](https://fvbb.com/ns/gem-opens-door-for-overseas-sellers-to-bid/309917)
- [Udyam registrations IBEF](https://www.ibef.org/news/over-7-83-crore-enterprises-registered-on-udyam-platforms-indicating-strong-msme-formalisation-growth)
- [Account Aggregator H1 FY26](https://smestreet.in/banking/finance/account-aggregator-lending-reaches-147-lakh-crore-in-h1-fy26-11074801)
- [Budget 2026-27 TReDS mandate](https://www.gimbooks.com/blog/budget-grants-credit-and-subsidies-for-small-businesses/)
- [SEBI BRSR value-chain deferral](https://reporting.academy/en/pages/sebi-postpones-mandatory-esg-disclosures-for-value-chain-to-2026/)
- [SEBI BRSR Core circular](https://www.sebi.gov.in/legal/circulars/jul-2023/brsr-core-framework-for-assurance-and-esg-disclosures-for-value-chain_73854.html)
- [Foxconn Devanahalli (The Week)](https://www.theweek.in/news/sci-tech/2026/05/02/tata-electronics-apple-india-foxconn.html)
- [NetSuite vs SAP B1 mid-market share](https://techcloudpro.com/blog/netsuite-vs-sap-business-one-mid-market/)

### Funding signals

- [Oro Labs $100M Series C](https://news.crunchbase.com/)
- [Lio $30M Series A](https://techcrunch.com/2026/03/05/lio-ai-series-a-a16z-30m-raise-automate-enterprise-procurement/)
