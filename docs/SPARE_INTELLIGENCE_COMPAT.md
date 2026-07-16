# Spare Intelligence Platform — compatibility with Anvil

**Status:** analysis / strategy. No code change. Grounded in a code-level audit of Anvil's schema (`supabase/migrations`) and services (`src/api`, `src/v3-app`) against the proposed *Spare Intelligence Platform — Master Architecture*.

---

## Verdict

**This is a natural evolution and generalization of Anvil, not a pivot.** Roughly **60–70% of the proposed architecture already exists as running code**, not slideware. Anvil today *is* a spare-intelligence platform for **one asset class** (spot-welding servo guns) with a **best-in-class classical spare-optimization core**. The proposal is essentially: *"take what you built for the guns, make it generic, and add the reliability + echelon layers."*

The document's **two hinge entities both exist** (correcting an easy misread):
- **PRODUCT / PART** (design *type*) → **`item_master`** (`006_corpus_alignment.sql:170`, unique `(tenant_id, part_no)`, aliases + `specification_code` + pgvector embeddings). The golden record is real.
- **ASSET** (physical *instance*) → **`equipment_hierarchy`** (`006:390`) — a self-referencing plant/line/zone/station/robot/gun tree at instance grain.
- **INSTALLED_BASE** (the "Units" column) → **`equipment_installed_parts`** (`006:415`) = `part_no + equipment_id + installed_qty + is_critical + last_replaced_at + recommended_qty_{90,180,365}d`. **The Part×Asset population entity is built.**

> ⚠️ **Trap:** `bom_assets` (mig 147) looks like the asset instance but is a **BOM/drawing TYPE header** (unique `asset_code+revision`). Any adoption effort that maps `ASSET` onto `bom_assets` builds on the wrong table. The instance is `equipment_hierarchy`.

Anvil is **the same shape** as the proposal — **narrower in domain** (welding-hardcoded) and **shallower in reliability / maintenance / multi-echelon**.

---

## Tier-by-tier fit

| Tier | Fit | Notes |
|---|---|---|
| **T1 — Extraction & Knowledge** | **Strong / production-grade** | DocAI hybrid pipeline (multi-adapter + voter + validators + anomaly), per-field **confidence + provenance** (`extraction_runs.field_confidences`, `029:33`), **bbox evidence**, **HITL** (ReviewPane + `extraction_review_queue` 123), **closed learning loop** (`extraction_corrections` → `learned_corrections` → prompt overrides), `item_master` golden record + 5-tier matcher (`item-mapper.js`), BOM ingestion (`bom_lines` 147 + recursive explosion). |
| **T2 — Asset & Reliability** | **Split: hinge present, reliability absent** | ASSET + INSTALLED_BASE + LOCATION present (above). **Reliability layer entirely greenfield**: no `FAILURE_MODE`, no `FAILURE_EVENT`/breakdown log, no MTBF/priors. `criticality` is a **sourcing heuristic** (`criticality_score`, `recommend.js:70`), **not FMECA**. |
| **T3 — Spare Optimization** | **Crown jewel — meets or EXCEEDS the proposal** | Full intermittent-demand engine: `classify.js` (SBC ADI/CV²), `forecast.js` (Croston/SBA/TSB/SES/SMA), `safety-stock.js` (Hadley-Whitin, gamma-quantile), `eoq.js` (Wilson EOQ + MOQ snap), `net-req.js` (planned-PO), `exceptions-detector.js`, `lead-time.js` (gamma fit), **`conformal.js` (split-CP intervals — beyond the proposal)**. **Do not rebuild this.** |
| **T4 — Maintenance** | **Thinnest** | AMC visit slots (`amc_schedules` 008) + field `service_visits` + CAPA (`car_reports`/`closure_reports`). **No `MAINTENANCE_TASK`/`JOB_PLAN`, no asset-bound `WORK_ORDER`, no RCM/TPM.** |
| **T5 — Delivery** | **Present** | React app + Vercel per-domain APIs + `delivery/promise.js`. **20+ ERP push connectors** (SAP/IFS/Ramco/JDE/Plex…) — but all write **SalesOrder only**; no Maximo/Infor EAM/CMMS write-back. |
| **Cross-cutting** | **Mostly present** | Agent layer (`action_proposals` propose→confirm→approve, `agent_goals`), feedback (`rlhf_feedback` 025), eval governance (`eval_runs` 002), RLS + role matrix + MFA. **Absent:** export-control (ITAR/EAR/ECCN), reliability/asset standards (ISO 55000/14224, S1000D), and a confidence field on proposals (auto-apply is only the [AI Item Resolver design](AI_ITEM_RESOLVER_DESIGN.md)). |

---

## Already realized · Partial · Greenfield

**Already realized (don't rebuild):** T1 extraction+HITL+learning loop; `item_master` PRODUCT golden record; `equipment_hierarchy` ASSET; `equipment_installed_parts` INSTALLED_BASE; BOM structure; **the entire T3 optimization stack**; `inventory_positions` state; T5 apps + ERP push; the AI-agent + eval + security cross-cutting.

**Partial:** ASSET as a *generic serialized* master (it's welding-columned — `robot_no/gun_no/timer_model`, no serial/tag/meter/commission-date); `SPARE_POLICY` per **Part×Location** (only per-Part today); `CRITICALITY` (heuristic, not FMECA); `CONSUMPTION` (reconstructed from `order_schedule_lines` — a sell-through proxy); `REVISION` (on `bom_assets`, **not** on the part golden record); `COMPATIBILITY` (item↔item only, not part↔asset-model); `WORK_ORDER` (`service_visits`, not asset+task bound); `FINDING` (CAPA on free-text, not asset-linked); PM schedule (AMC visits, not RCM); ERP write-back (SalesOrder only); MATERIAL/DRAWING (attribute-level, not master entities).

**Greenfield (true net-new):** `FAILURE_MODE` (FMEA) catalog; `FAILURE_EVENT`/breakdown **event stream**; cold-start reliability **priors / MTBF / Weibull**; **MEIO / multi-echelon**; **PM-vs-breakdown demand-cause** classing; `MAINTENANCE_TASK`/`JOB_PLAN` library; **RCM/TPM** engine; `SUPERSESSION` lifecycle chain; export-control; reliability standards; a normalized per-fact `EXTRACTION` table with lineage.

---

## The real friction points (structural)

1. **String-joined hinge — the single biggest issue.** `item_master.id` is FK-joined in the *catalog* subsystem, but `part_no` is **loose TEXT** (never an FK to `item_master`) in `equipment_installed_parts`, `bom_lines`, `recommended_spares`, `inventory_positions`, and `demand_forecasts`. **The golden PRODUCT record and the operational spare/inventory/installed-base data are not relationally joined** — dedup and rollup are string-matching.
2. **Three overlapping installed-base representations, unreconciled:** `installed_base` (005, gun_model×customer, nearly unused), `equipment_installed_parts` (006, part×instance grain), `recommended_spares.installed_qty` (159, a matrix count). A spare-intelligence platform must pick **one canonical grain**.
3. **The inventory engine is single-location.** Every T3 table is keyed `(tenant_id, part_no)` with no location/echelon dimension. MEIO is **not a config change** — it needs a location column on ~6 tables + a new optimizer + a transfer/rebalance exception kind.
4. **Demand signal is a sales/shipment proxy,** not field consumption of installed parts. A reliability-driven spare model needs a `CONSUMPTION`/replacement event stream — changing the demand *source*, not just adding a table.
5. **The asset model is spot-welding-hardcoded** (`robot/gun/timer/ATD` columns). Generalizing ripples into the spare-matrix ingestion (159) and the guns viewer.
6. **`criticality_score` is a sourcing heuristic wearing an FMECA name** (no severity/occurrence/detection/RPN). Surfacing it to reliability engineers would mislead.

---

## Smallest bridge to adopt the architecture (dependency order)

Steps 1–3 are **refactors of existing shape (weeks)**; only the reliability + MEIO layers are true net-new builds, and they phase.

1. **Reconcile the three installed-base reps onto ONE canonical grain** — `equipment_installed_parts` is the best candidate (instance grain, has `installed_qty`); deprecate `installed_base` (005). **Unblocks everything.**
2. **Promote `part_no` → a real `item_id` FK to `item_master`** across the operational tables (`equipment_installed_parts`, `bom_lines`, `recommended_spares`, `inventory_positions`, `demand_forecasts`). Turns the string-joined hinge relational — mechanical, high-value, and doable behind the existing resolver (`item-mapper.js`).
3. **Generalize `equipment_hierarchy`** — collapse `robot/gun/timer` columns into `class + attributes(jsonb)` so non-welding assets fit.
4. **Then** add the greenfield layers, cheapest-signal first: a **`FAILURE_EVENT` log** (cheap, high signal) → **MTBF/priors** feeding safety stock → the **location dimension + MEIO** (expensive; defer until multi-warehouse demand is real).

**Do not rebuild Tier 3** — it already exceeds the proposed model.

---

## One-line thesis (mapped to reality)

The proposal's thesis — *one canonical part truth, made trustworthy by confidence + human verification, as the foundation for cold-start spare optimization* — is **already Anvil's architecture**, proven on one asset class. The work is **generalization + a reliability/echelon layer on top of a T3 core that's ahead of the incumbents**, gated by fixing the string-joined hinge (friction #1) first.
