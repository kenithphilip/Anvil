# Customer ICP (Ideal Customer Profile) framework — Design (PARKED backlog)

Status: **Parked design.** A tenant-configurable ICP fit score + tier on the
customer master. Scalable/cross-compatible: because "ideal" is company-specific,
the framework is a data-driven rubric over a generic attribute registry — any
company using Anvil defines its own ICP without code changes.

## Is there an ICP proxy today? No.
- **No ICP concept exists** (grep: no icp / ideal-customer / fit-score anywhere).
- **`ai_health_score` is NOT ICP.** It's a *behavioral / relationship-health*
  rollup (order volume, on-time-payment rate, AR aging, anomaly count →
  green/yellow/red; `customers/health_score.js`). That's **how a customer
  behaves**, not **whether they're a good fit**. ICP is a distinct axis and
  should sit alongside health, not replace it.
- The **raw attributes** the user named already exist but are scattered and
  unscored: `customer_type` (OEM/Tier-1/distributor), `industry_segment`,
  `country`, GSTIN, MSME status (now in the categorized
  `customer_registration_fields`), and parent company (the hierarchy panel).
  Nothing computes fit over them.

**Health vs ICP (two axes, both surfaced):**
| | ICP (fit) | Health (behavior) |
|---|---|---|
| Question | Should we want them as a customer? | Is this relationship healthy? |
| Inputs | firmographics: industry, size, parent, country, GST, type | orders, payments, AR aging, anomalies |
| When | at onboarding, before much history | ongoing, needs transaction history |
| Existing | **none (this doc)** | `ai_health_*` |

## Design — a tenant-defined rubric over a generic attribute registry

### Why generic attributes (the cross-compatibility key)
ICP criteria differ per business (a bearings maker's ICP ≠ a SaaS company's), so
the rubric must **reference attribute keys, not hardcoded columns**. Anvil
already has the perfect store: `customer_registration_fields` (categorized
`field_key → value`, from the customer-registration work) plus core `customers`
columns and the hierarchy. An ICP rule targets any `field_key` — including
custom fields a tenant adds — so the framework scales to any company with zero
schema change.

### Data model
- **`icp_profiles`** (tenant-scoped, RLS): a named ICP definition.
  `id, tenant_id, name, active, gate (jsonb), rules (jsonb), tiers (jsonb),
  weight_total`. A tenant may keep several (e.g. per business unit / segment).
  - **`gate`** — hard qualifiers (disqualify if failed), e.g. `GST status =
    Active`, `country in [target markets]`. A failed gate → tier "Out".
  - **`rules[]`** — weighted criteria: `{ attribute_key, op, value(s), weight,
    label }`. `op` ∈ `equals | in | gte | lte | exists | matches | range`.
    `attribute_key` resolves against: registration fields → customers columns →
    derived (see below).
  - **`tiers`** — score cutoffs → labels, e.g. `>=75 A/Ideal`, `>=45 B/Adjacent`,
    `else C/Poor`; plus "Out" for a failed gate.
- **On `customers`** (like `ai_health_*`): `icp_score int`, `icp_tier text`,
  `icp_profile_id uuid`, `icp_signals jsonb` (matched + missed criteria for
  explainability), `icp_scored_at timestamptz`.

### Attribute resolvers (what a rule can reference)
| Source | Examples | Where |
|---|---|---|
| Registration fields | industry_segment, customer_type, msme_status, taxpayer_type, constitution, gst_status | `customer_registration_fields` |
| Core customer | country, state_code, gstin, currency | `customers` |
| **GST check** | GSTIN valid + Active (registry) | #186 fetch / `_lib/gstin.js` — a first-class gate |
| Parent / group | belongs to a target parent/enterprise group | customer hierarchy (parent_customer_id) |
| Derived firmographic | company size / revenue band, employee count | registration fields (optional captured) |
| Behavioral (optional) | annual order value band, margin realized | rollups — opt-in so ICP can stay pure-fit |

### Scoring (deterministic, explainable, cheap)
`_lib/icp.js` (pure, testable): `scoreCustomer(attributes, profile)` →
`{ score, tier, signals }`.
1. Evaluate `gate`; any hard fail → `{ tier: "Out", score: 0, signals }`.
2. Sum the weights of matched `rules`; normalize to 0-100 over `weight_total`.
3. Map to a tier via `tiers`. Return matched + missed criteria as `signals`.
Deterministic weighted rules keep it **free, instant, and explainable** (no LLM).
An optional LLM-assist mode (Haiku, mirroring health_score) can score fuzzy
criteria ("strategic account") when a tenant wants it — off by default.

### Compute + surface
- Compute on **registration save** (the attributes changed) + a **daily cron**
  refresh (reuse the `health_score` cron/cooldown pattern) + **on-demand**.
- UI: an **ICP tier badge + score** in the customer detail (next to health), an
  **admin ICP-profile editor** (define gate/rules/weights/tiers — reuse the
  OptionListEditor / admin patterns), an **ICP filter** on the customer list,
  and an **ICP lens** in the Sales-Ops cockpit (are we winning ideal customers?).
- Also score **leads/opportunities** with the same profile (pre-customer ICP
  fit) — ties into lead scoring (`sales/score_lead.js`).

## Phasing
- **P1 — Core engine:** `icp_profiles` migration + `_lib/icp.js` scorer + a
  default seed profile + `customers.icp_*` columns + compute on registration
  save; badge in the customer detail.
- **P2 — Admin editor + list/cockpit filter:** tenant defines the rubric; filter
  customers/opps by ICP tier.
- **P3 — GST-gated + re-score (shipped):** the compute layer derives
  `gstin_valid` (local Mod-36 checksum, no external call) + `gstin_present`, both
  surfaced as rule/gate attributes so a tenant can require a registered business
  today. Re-score triggers: on customer-master upsert (firmographic fields may
  have changed) in addition to the P1 registration-save trigger, plus a
  `POST /api/customers/icp {all:true}` batch re-score (`scoreAllCustomers`,
  bounded 1000) exposed as "Re-score all" in the admin editor — used after
  editing the rubric or a wave of data landing. The live `gst_status=Active`
  gate is already scorable: when the Sandbox GSTIN fetch (#186) writes
  `gst_status` into the registration fields it flows through as an attribute and
  re-scores on save — no extra wiring needed, only the #186 fetch itself.
- **P4 — Optional LLM-assist** for fuzzy criteria; apply ICP to leads/opps.

## Reuse map
| Need | Reuse |
|---|---|
| Generic attribute store | `customer_registration_fields` (this makes it cross-compatible) |
| GST check gate | #186 GSTIN fetch + `_lib/gstin.js` |
| Parent company | customer hierarchy (parent_customer_id) |
| Compute + cron + cooldown | `customers/health_score.js` pattern |
| Admin rubric editor | admin OptionListEditor / settings patterns |
| Score badge in detail | alongside `ai_health_*` |

Related: `docs/GST_CUSTOMER_FETCH_DESIGN.md` (#186), `docs/CUSTOMER_REGISTRATION_DESIGN.md` (#187),
[[project-competitive-landscape]] (ICP feeds the forecast→BOM wedge), health_score.
