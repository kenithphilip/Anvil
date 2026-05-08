# Inventory Planning, Design Document

Status: Draft v1, May 2026
Owner: Anvil engineering, in collaboration with Obara India operations.
Predecessor: gap-analysis report attached to PR #70 stack discussion.

Scope: a demand-driven, forecast-led inventory-planning module for
long-lead-time bundled items (Auto Tip Dresser, Timer, plus the
extensible class of "standard parts that ship with custom-designed
parents"). Replaces static minimum-stock thresholds with a rolling
12-16 week net-requirement model that reads the live sales pipeline,
walks the BOM, reconciles in-transit POs and project allocations,
and emits planned procurement orders with explainable rationale.

---

## 0. Reading order

Sections 1-3 are problem framing and the math the engine must use.
Section 4 is the AI/ML stack. Section 5 is the data model with SQL
sketches. Section 6 is the runtime (cron + API). Section 7 is the
UI built on the existing Anvil primitives. Sections 8-10 are
integration, rollout, and acceptance.

If you only have ten minutes, read sections 1, 4.7 (the model menu
table), 5.0 (the ER diagram), 7.0 (the screen list), and 9 (the
phased plan).

---

## 1. Problem statement and goals

### 1.1 The operational problem

Obara India sells custom-designed welding guns to automotive OEMs
(Tata, JBM Auto, Mahindra, Bajaj, etc.). Every gun ships with a
small set of standard, long-lead-time bundled items, the two named
in the spec are:

- ATD: Auto Tip Dresser, electrically-driven dressing head bolted
  to each gun. Lead time 8-14 weeks, single-source from specific
  Japanese / German suppliers, MOQ matters, no design dependency.
- Timer: weld-current timer board. Lead time 6-10 weeks, similar
  supplier shape.

A gun project takes 16-24 weeks from PO to commissioning. The
ATD/Timer pair must be on the shelf when the gun ships, otherwise
the project stalls. Because they are bundled with bespoke parents
(the gun design varies per project) the rate of consumption of the
bundled standard parts is, in practice, a function of the deal
pipeline rather than a steady-state demand series.

The current state is static reorder levels in Tally per item, which
is the wrong shape: it ignores expected wins, ignores in-transit
stock, ignores per-project allocations, and ignores supplier lead
time variability.

### 1.2 Goals

| # | Goal | Measure |
|---|------|---------|
| G1 | Zero stock-out on ATD + Timer for committed and high-probability pipeline | `incidents/quarter <= 0` |
| G2 | <= 5% over-stock vs. theoretical optimum | `(holding cost - optimum) / optimum <= 0.05` |
| G3 | Planned-order accuracy: >= 90% of planned POs released within +/- 1 week of the system-recommended date | weekly KPI |
| G4 | Forecast accuracy: WAPE <= 25% at 8-week horizon, <= 15% at 4-week horizon | rolling backtest |
| G5 | Operator can explain every planned PO from on-screen evidence in <= 30 seconds | UX time-to-comprehension |
| G6 | Engine handles a 5x scale jump (more SKUs, more verticals) without re-architecture | covered by tests |

### 1.3 Non-goals (this round)

- Multi-warehouse / multi-location inventory routing across plants
  (out-of-scope; we plan single-tenant single-stock-location
  initially, with a clean upgrade path to multi-echelon, see 4.6).
- Demand-shaping price decisions (no dynamic pricing in this round).
- Hard MRP-style finite-capacity scheduling (leave to ERP MRP).
- ATD/Timer manufacturing (we are a buyer, not a maker, of these).

---

## 2. Mathematical and statistical foundations

### 2.1 Notation

Let `i` index items (parts), `t` index time buckets (weekly, with a
daily refresh on positions). For an item `i` and bucket `t`:

| Symbol | Meaning |
|--------|---------|
| `D_i_t` | Realised demand in bucket t for item i |
| `F_i_t` | Forecast demand in bucket t for item i (point estimate, the mean of the predictive distribution) |
| `sigma_D_i` | Standard deviation of demand for item i (per bucket) |
| `L_i` | Mean supplier lead time for item i (in days) |
| `sigma_L_i` | Standard deviation of supplier lead time for item i |
| `OH_i` | On-hand stock for item i (today) |
| `IT_i_t` | In-transit qty arriving in bucket t (from open source POs with acknowledged ETA in t) |
| `AL_i_t` | Allocated qty already reserved for projects, releasable in bucket t |
| `SS_i` | Safety stock for item i |
| `ROP_i` | Reorder point for item i |
| `Q_i` | Replenishment order quantity (EOQ-style) |
| `MOQ_i` | Minimum order quantity (supplier constraint) |
| `RP_i` | Round-pack increment (supplier constraint) |
| `S_i` | Fixed cost per order for item i |
| `H_i` | Holding cost per unit per year for item i |
| `alpha_i` | Target service level for item i (e.g. 0.95, 0.98, 0.99) |
| `z(alpha)` | Inverse standard normal of `alpha` (1.65 for 0.95, 2.05 for 0.98, 2.33 for 0.99) |

### 2.2 Lead-time-demand (LTD)

The fundamental quantity for replenishment is "demand arriving
during the time it takes us to refill". With both demand and lead
time stochastic, LTD has a compound distribution:

```
E[LTD_i]  = L_i * E[D_i_per_day]
Var[LTD_i] = L_i * Var[D_i_per_day]      <-- demand variance in time-L window
            + (E[D_i_per_day])**2 * Var[L_i]  <-- lead-time variance amplification
sigma_LTD_i = sqrt(Var[LTD_i])
```

This is the standard Hadley-Whitin formulation [1]. Critically the
lead-time-variance term scales with `(mean demand)^2`, not linearly
with mean demand, so for fast-moving items LT variance dominates.

For ATD/Timer we expect intermittent demand (gun deliveries cluster
at quarter-end), so we will use the gamma distribution to model LTD
rather than normal (see 2.5).

### 2.3 Safety stock

Three formulas, used in different regimes. The engine picks per
item based on the demand-classification result (see 4.2).

#### 2.3.1 Standard normal (continuous fast-moving)

```
SS_i = z(alpha_i) * sigma_LTD_i
```

#### 2.3.2 Gamma quantile (skewed/intermittent)

When demand is non-normal the normal z-score over-buffers the right
tail and under-buffers the left tail. We instead solve:

```
SS_i = Gamma_inverse_cdf(alpha_i; shape, scale) - E[LTD_i]
```

Where shape and scale are fitted from `E[LTD_i]` and `sigma_LTD_i`
via method-of-moments (`shape = E^2/Var`, `scale = Var/E`). This
matches the gamma-distribution literature [11][12].

#### 2.3.3 Project-equivalent floor (Joel's spec rule)

The spec mandates a minimum buffer:

```
SS_i_min = max(avg(D_i over last 4 weeks), 1 * project_equivalent_qty_i)
```

Where `project_equivalent_qty_i` is the median ATD/Timer count per
gun-shipment-event, taken from `equipment_installed_parts.recommended_qty_180d`
or the BOM walk for the modal gun model. The engine takes:

```
SS_i_final = max(SS_i_statistical, SS_i_min)
```

This guarantees the operator always has at least one full
project's worth on hand, even when statistical noise would
recommend less.

### 2.4 Reorder point and replenishment quantity

```
ROP_i = E[LTD_i] + SS_i
```

For the order quantity `Q_i`, we run two parallel proposals and
let the operator pick:

#### 2.4.1 EOQ (Wilson)

```
Q_EOQ_i = sqrt(2 * D_annual_i * S_i / H_i)
```

Then snapped up to `MOQ_i` and rounded to the nearest `RP_i`.

This is the textbook formula [9][10]. It assumes deterministic
demand; under stochastic demand it under-orders [9.last-result],
which we mitigate via the safety-stock buffer above.

#### 2.4.2 Coverage-period

```
Q_cov_i = max(MOQ_i, ceil(coverage_weeks * F_i_per_week))
```

For ATD/Timer with `coverage_weeks = 12` (one full lead-time
cycle plus margin). Often the more useful number for planners
than EOQ when ordering costs are dominated by setup rather than
unit costs.

The UI shows both proposals side-by-side with the EOQ as a
sanity check. Default selection: `Q_cov_i` for long-lead items,
`Q_EOQ_i` for short-lead.

### 2.5 Lead-time distribution choice

We estimate `L_i` and `sigma_L_i` per supplier per item from the
recent N>=12 acknowledged-ETA-vs-actual-receipt deltas in
`source_po_events`. We fit a gamma distribution via
method-of-moments (cheap, robust) and use that for the LTD compound.

The gamma distribution is preferred over normal because (a) lead
times are non-negative; (b) lead times are typically right-skewed
(suppliers slip more than they accelerate); (c) gamma includes both
exponential and approximately-normal as special cases [12].

### 2.6 Demand split

Total forecast demand is the sum of three contributors, each with
its own confidence:

```
F_i_t = F_committed_i_t           (orders already booked; probability ~ 1.0)
       + F_pipeline_i_t            (sum over opportunities of qty * stage_probability)
       + F_baseline_i_t            (statistical/AI baseline demand from historicals)
```

Each is computed and persisted separately so the explainability
panel can show the operator "8 from confirmed orders, 6 expected
from the JBM RFQ at 60% stage probability, 2 from the baseline".

### 2.7 Probability-weighted pipeline demand

The pipeline demand for a single item:

```
F_pipeline_i_t =
    sum over opportunities o expected to close in bucket t of
       (gun_qty_o * (ATD_per_gun_o + Timer_per_gun_o-only-if-i==Timer))
       * stage_probability(o.stage)
```

Where the per-stage probabilities come from the existing
`opportunities.probability` column. Pipeline literature [4][5][6]
recommends stage-based weighting; we use the operator-set
probability with a per-stage default if the operator hasn't
overridden:

| Stage | Default probability | Rationale |
|-------|--------------------:|-----------|
| QUALIFICATION | 5% | Just an interest signal |
| NEEDS_ANALYSIS | 15% | Discussions started |
| RFQ | 30% | RFQ submitted |
| INTERNAL_PROPOSAL | 40% | Internal go/no-go pending |
| STRATEGY_CHECK | 50% | Approved internally to push |
| PROPOSAL_PRICE_QUOTE | 60% | Price submitted |
| NEGOTIATION_REVIEW | 75% | In commercial back-and-forth |
| FOLLOW_UP | 85% | Verbal acceptance |
| CLOSE_WON | 100% | Becomes a confirmed order, drops out of pipeline |
| CLOSE_LOST | 0% | Drops out |
| REGRETTED | 0% | Drops out |

The engine reads `opportunities.probability` first; if null, falls
back to the stage default; if both null, treats as 0. The
probability is calibrated continuously by computing the win-rate
per stage over the last 12 months and exposing the calibration
chart on the planning dashboard (see 7.4).

For each opportunity the gun-quantity is read from the
opportunity's expected line items (today: best-effort, see 8.2 for
the work to put structured line items on opportunities) and the
ATD/Timer-per-gun ratio is the BOM walk (see 5.4).

### 2.8 Net requirement (the spec formula)

```
NR_i_t = (F_i_t + SS_i) - (OH_i + sum over s<=t of IT_i_s - sum over s<=t of AL_i_s)
```

Where:

- `OH_i + sum IT - sum AL` is the projected on-hand at the
  beginning of bucket `t` (positions roll forward).
- A positive `NR_i_t` is a shortage. A negative is excess.
- The trigger condition is `NR_i_t > 0 AND t <= today + L_i_days`.
  That is, "we will be short during a window where it is too late
  to order from scratch".

The engine emits a planned PO whenever:

```
PO_release_signal_i = (any t in next 12 weeks where NR_i_t > 0)
                   AND (sum of open in-transit < required_t)
                   AND no existing approved planned-PO covers it
```

### 2.9 Service level vs cost trade-off

Holding cost vs stockout penalty drives `alpha_i`. The engine
exposes per-class defaults, operator-overridable on the item:

| Item class | alpha | z(alpha) | Why |
|------------|-------|---------:|-----|
| Critical bundled (ATD, Timer for OEM autos) | 0.99 | 2.33 | Stock-out blocks a >50L INR project |
| Standard bundled (lower-criticality) | 0.95 | 1.65 | Standard service-parts level |
| Long-tail / insurance spares | 0.85 | 1.04 | Slow movers, accept some risk |

The operator can override on any item; the override is logged with
`reason_text` to `audit_events`.

### 2.10 Multi-echelon extension (Year-2)

The current scope is single-stock-location. The data model is
designed so a future move to multi-echelon (warehouse + plant
sub-stock) just adds a `location_id` dimension to position and
allocation tables. The MEIO formulation we will adopt then is the
guaranteed-service approach [7][8] which expresses safety stock as
a linear program over network position.

---

## 3. AI / ML stack

### 3.1 Why a model menu, not a single model

Inventory-grade forecasting at this size (initially ~50-200 SKUs,
growing to a few thousand) cannot be one-size-fits-all:

- Some SKUs (high-runners) have rich history and respond to
  classical ARIMA / ETS.
- Some SKUs (ATD, Timer) are intermittent (mostly zeros, occasional
  large spikes when projects ship) and the right tool is Croston's
  family or bootstrapping [3].
- Some SKUs are new (no history) and depend on cross-SKU patterns;
  here global ML models (LightGBM with engineered features, NHITS,
  TFT) shine [1][2][16].

We adopt a model-menu plus an automatic selector (see 4.7-4.9).

### 3.2 Demand classification (the gateway)

Before forecasting, classify each item:

```
adi_i       = mean inter-arrival interval of non-zero demand events  (days)
cv2_i       = (sigma of non-zero demand sizes / mean of non-zero demand sizes)^2
```

The Syntetos-Boylan-Croston quadrant [3]:

| ADI | CV^2 | Class | Recommended models |
|-----|------|-------|--------------------|
| <= 1.32 | <= 0.49 | Smooth | ARIMA, ETS, NHITS, TFT |
| <= 1.32 | > 0.49 | Erratic | ETS with regressors, gradient-boosted |
| > 1.32 | <= 0.49 | Intermittent | Croston, SBA, TSB |
| > 1.32 | > 0.49 | Lumpy | TSB, Willemain bootstrap, RL/MEIO |

ATD and Timer in Obara's regime are typically Lumpy: project ships
cluster, and when they do they are not all the same size.

### 3.3 Classical statistical models

For Smooth and Erratic items:

| Model | Library | Use |
|-------|---------|-----|
| AutoARIMA | Nixtla statsforecast [15] | Default for short-history Smooth items |
| AutoETS | Nixtla statsforecast | Multiplicative seasonality, robust to outliers |
| AutoCES | Nixtla statsforecast | Complex exponential smoothing, the M5-winning baseline |
| AutoTheta | Nixtla statsforecast | Lightweight; useful when retraining cost matters |
| Holt-Winters | statsmodels | Triple-exponential smoothing for trend + seasonal items |

### 3.4 Intermittent-demand models

For Intermittent and Lumpy items:

| Method | Description | Formula sketch |
|--------|-------------|----------------|
| Croston [3] | Decompose into demand-size and inter-arrival, smooth each separately | `F = a / p` where `a` is smoothed size, `p` is smoothed interval |
| Syntetos-Boylan (SBA) | Croston with the bias correction `* (1 - alpha/2)` | The most-cited unbiased intermittent estimator |
| Teunter-Syntetos-Babai (TSB) | Updates demand probability every period (handles obsolescence) | Robust when demand drops to zero forever |
| Willemain bootstrap | Non-parametric: bootstrap the LTD distribution from past sequences | Provides a full predictive distribution, not just a point |

The engine fits all four for every Intermittent / Lumpy item and
selects via cross-validation (see 4.7).

### 3.5 Deep-learning / global models

For mid-history items and cross-SKU patterns, we use Nixtla's
neuralforecast [15] menu:

| Model | Why | Cost class |
|-------|-----|------------|
| NHITS | M4-winning, fast, hierarchical interpolation | Light |
| NBEATSx | Adds exogenous variables (price, calendar) | Medium |
| TFT | Temporal Fusion Transformer; explainable attention | Medium |
| PatchTST | Patches the input; SOTA on long-horizon | Medium |
| iTransformer | Inverted transformer; 2024 SOTA on retail | Medium-heavy |
| TimeLLM | LLM-as-time-series-model; experimental, sparse data shines | Heavy |

We train these globally (one model across many items) so a brand-new
SKU benefits from cross-item learning. NHITS is our default for
multi-step horizons because of the speed/accuracy ratio.

### 3.6 Gradient-boosted ML with engineered features

Parallel track: LightGBM / XGBoost on tabular features
(`week_of_year`, `month`, `holiday_flag`, `recent_avg_4w`,
`recent_avg_12w`, `pipeline_value`, `category_code`, etc.) via
Nixtla's mlforecast [15]. This gets us:

- Strong on Erratic items.
- Easy to read with SHAP (the operator can ask "why does the model
  expect demand to spike in week 38?").
- Cheap to retrain.

### 3.7 Pipeline (Bayesian-flavoured) demand

For pipeline demand, we use a Bayesian approach to calibrate stage
probabilities rather than trust the operator-set values blindly:

```
P(close | stage_s, days_in_stage_d, customer_tier_t) =
    softmax of features through a small logistic model trained on
    last 12 months of opportunities.
```

This calibrates the stage default probabilities from actual
historical conversions per stage per customer-tier. The engine
reads `opportunities.probability` if the operator overrode
explicitly; otherwise it uses the calibrated stage probability.

Output of the calibration is a per-stage curve like:

```
QUALIFICATION : raw 5%, calibrated 11% (Tier-1 OEMs convert higher)
RFQ           : raw 30%, calibrated 22% (RFQ-stage drop-out higher than expected)
PROPOSAL      : raw 60%, calibrated 64%
```

The chart goes on the planning dashboard (7.4) so operators see
where their hunches are off.

### 3.8 LLM-assisted explanation

Every planned PO surfaces an "explain this" link that calls the
existing `/api/anomaly/explain` shape (Haiku-tier, via the existing
`tenantSettings.llm_key_provider` plumbing). The Haiku prompt
receives:

- The numeric breakdown (committed, pipeline, baseline, on-hand,
  in-transit, allocated, NR per week).
- The top three contributing opportunities with stage and
  probability.
- The ROP, SS, and the operator's service-level setting.

Output: a one-paragraph plain-English rationale that lands on the
planned-PO card. Same model class we already use for anomaly
explanation; no new infra.

### 3.9 Reinforcement learning (Year-2 enhancement, not v1)

Once we have 12 months of forecast / actuals data and stable cost
parameters (holding cost, stockout penalty, ordering cost), we can
move from rule-based replenishment to a learned policy [13][14]:

- State: positions, in-transit, forecast quantiles, recent demand
  shocks, cost parameters.
- Action: order quantity per item (continuous).
- Reward: negative of (holding + stockout + ordering) cost.
- Policy: PPO (preferred over DQN per [14] for continuous
  action spaces and multi-echelon settings).

This is explicitly out-of-scope for v1 but the data model carries
the signals (states, actions, costs) so we can plug it in cleanly.
The planned-PO table has a `policy_source` enum so when the policy
flips from `rule_based_eoq` to `rl_ppo_v1` we get clean A/B logs.

### 3.10 Online learning + drift detection

Models retrain weekly. The engine logs:

- WAPE per item per horizon (4, 8, 12 weeks).
- Bias (mean of `forecast - actual` over last 8 weeks).
- Tracking signal (`cumulative bias / MAD`); if `|TS| > 4` for any
  item, raise a `forecast_drift` exception that surfaces in the
  exceptions screen.

The retraining pipeline is a weekly cron. Models are versioned and
rollback-able.

---

### 3.11 Model menu summary (cheat sheet)

| Item shape | Primary model | Fallback | Update cadence | Notes |
|------------|---------------|----------|----------------|-------|
| Smooth, long history | AutoETS | NHITS | weekly | M5 winner shape |
| Smooth, short history | NHITS (global) | AutoARIMA | weekly | benefits from cross-SKU |
| Erratic | LightGBM (engineered features) | TFT | weekly | regressors matter |
| Intermittent | SBA | TSB | weekly | bias-corrected |
| Lumpy (ATD, Timer) | TSB + Willemain bootstrap | SBA | weekly | full predictive distribution |
| Slow-moving / new | TimeLLM (global) | LightGBM | bi-weekly | cold-start |

The engine writes the chosen model, the WAPE, and the alternative
candidates to `forecast_runs` for traceability.

---

## 4. Engine algorithm (pseudocode)

### 4.1 High-level cron flow (weekly)

```
FOR each tenant t with inventory_planning_enabled:
  positions   = refresh_positions(t)            # daily, see 4.2
  classify    = classify_demand_shapes(t)       # see 3.2
  forecasts   = run_forecast_models(t, classify)# see 3.3-3.6
  pipeline    = compute_pipeline_demand(t)      # see 2.7, 3.7
  committed   = read_committed_demand(t)        # orders + schedule_lines
  baseline    = read_baseline_demand(t, forecasts)
  total_dmd   = combine(committed, pipeline, baseline)   # 2.6
  ss          = compute_safety_stock(t, classify, leadtimes)  # 2.3
  rop         = compute_reorder_points(t, ss, leadtimes)
  net_req     = compute_net_requirements(t, total_dmd, ss, positions)  # 2.8
  plans       = emit_planned_pos(t, net_req, leadtimes, moq, rounding)
  alerts      = compute_exceptions(t, net_req, positions, drift_signals)
  persist_all_outputs()
  write_audit_event(t, "inventory_planning.weekly_run", run_summary)
```

The daily cron runs only `refresh_positions` and `compute_exceptions`
(net-req against the existing weekly forecast).

### 4.2 Position refresh (daily, fast)

```
FOR each tenant:
  on_hand   = read_unified_inventory_view(t)     # union over tally / netsuite / sap mirrors
  in_transit= read_open_source_pos(t)            # by acknowledged_eta bucket
  allocated = read_inventory_allocations(t)      # by required_by_date
  upsert into inventory_positions(...)
```

### 4.3 Forecast run (weekly, heavy)

```
FOR each item i in tenant:
  hist = read_last_N_weeks_of_demand(i, N=104)    # 2 years
  cls  = classify(hist)                           # ADI, CV^2

  models_to_try = pick_menu(cls)
  fits = fit_each(models_to_try, hist)
  pick = select_by_cv_wape(fits, hist)            # 4-fold time-series CV

  fcst_dist = predict_distribution(pick, h=12, q=[0.5, 0.9, 0.95, 0.99])
  fcst_mean = fcst_dist.median

  upsert into demand_forecasts(item_id, week, mean, q90, q95, q99, model_used, wape)
```

### 4.4 Net-req + planned PO

```
FOR each item i:
  proj_oh_curve = position_oh + cumulative(in_transit) - cumulative(allocated)
  net_req_curve = (forecast_curve + ss) - proj_oh_curve

  IF max(net_req_curve over next 12w) > 0:
    shortage_week = first w where net_req_curve[w] > 0
    needed_qty    = sum(net_req_curve over the shortage window)
    plan_qty      = round_up(needed_qty, moq, rp)
    order_date    = shortage_week - lead_time_weeks - safety_buffer
    upsert into procurement_plans(item, week, qty, order_date, eta, rationale_jsonb)
```

The `rationale_jsonb` carries the inputs that produced the
recommendation, so the UI can render the explanation panel without
re-running anything.

### 4.5 Exception detection (real-time)

Triggered by:

1. New `source_po_events` row marking a delay.
2. New `orders` row (committed demand jumps).
3. Daily position refresh (on-hand drops below ROP).
4. Forecast-drift signal from the previous run's tracking signal.

Each writes a `processing_event` keyed by tenant + item + reason
class. The exceptions screen subscribes to this stream.

---

## 5. Data model

### 5.0 ER overview

```
+-----------------+        +------------------+
|  item_master    |--+   +-|  suppliers (NEW) |
+-----------------+  |   | +------------------+
| + lead_time      | (FK)|         |
| + moq            |  |  |   1..N supplier_lead_time_history (NEW)
| + safety_stock   |<-+--+
| + reorder_point  |              |
| + item_type      |              |  (used for sigma_L)
| + def_supplier_id|              |
+-----------------+              |
       ^                          |
       | 1..N                     |
+-----------------+        +-----------------+        +-------------------+
| bill_of_materials|------|opportunities/quotes/orders|---|inventory_allocations(NEW)|
+-----------------+        +-----------------+        +-------------------+
                                                                 |
+----------------------+   +------------------+   +-------------+
| inventory_positions  |   | demand_forecasts |   | procurement_plans|
| (NEW, per item/day)  |   | (NEW, per item/wk)|  | (NEW, per item/wk)|
+----------------------+   +------------------+   +-------------+
       ^                          ^                       ^
       | reads                    | reads                 | writes
+----------------------------------------------------+
| /api/cron/inventory-planning (NEW)                  |
+----------------------------------------------------+
```

### 5.1 Extensions to `item_master`

Migration `085_inventory_planning.sql`:

```sql
alter table item_master
  add column if not exists item_type text
    check (item_type is null or item_type in
      ('GUN','ATD','TIMER','GUN_COMPONENT','SPARE','CONSUMABLE','OTHER')),
  add column if not exists safety_stock numeric(14,2),
  add column if not exists reorder_point numeric(14,2),
  add column if not exists default_supplier_id uuid,
  add column if not exists service_level numeric(4,3) default 0.95
    check (service_level > 0 and service_level < 1),
  add column if not exists planning_cadence text default 'weekly'
    check (planning_cadence in ('daily','weekly','biweekly','monthly')),
  add column if not exists demand_class text
    check (demand_class is null or demand_class in
      ('smooth','erratic','intermittent','lumpy','new'));
```

The new fields are nullable so existing rows are unaffected; the
engine populates them on first run.

### 5.2 New `suppliers` table

```sql
create table suppliers (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  supplier_code text not null,
  supplier_name text not null,
  country text,
  default_currency text default 'INR',
  -- Lead-time stats (refreshed by the engine).
  lead_time_days numeric(8,2),
  lead_time_stddev_days numeric(8,2),
  -- Performance stats.
  on_time_delivery_rate_90d numeric(5,4),
  partial_shipment_rate_90d numeric(5,4),
  notes text,
  contact_email text,
  contact_phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, supplier_code)
);
```

Backfill from `source_pos.supplier` (text) by deduping on a slug.
Add the FK to `item_master.default_supplier_id`.

### 5.3 New `source_po_lines` (relational)

Extracts the JSONB lines today living in `source_pos.payload.lineItems`
into a relational table so joins and aggregations are clean:

```sql
create table source_po_lines (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  source_po_id uuid not null references source_pos(id) on delete cascade,
  line_index int not null,
  part_no text not null,
  description text,
  qty numeric(14,4) not null,
  rate numeric(18,4),
  uom text,
  acknowledged_eta date,
  received_qty numeric(14,4) default 0,
  received_at timestamptz,
  created_at timestamptz not null default now(),
  unique (source_po_id, line_index)
);

create index source_po_lines_part_idx on source_po_lines (tenant_id, part_no, acknowledged_eta);
```

Backfill: a one-shot job reads `source_pos.payload.lineItems` and
populates this table. The post-migration write path goes through
both for one release, then the JSONB read path is retired.

### 5.4 Recursive BOM walk view

```sql
create or replace view v_bom_walk_recursive as
with recursive walk as (
  select
    parent_part_no as root_part_no,
    parent_part_no as ancestor_part_no,
    child_part_no,
    qty as multiplier,
    1 as depth
  from bill_of_materials
  union all
  select
    w.root_part_no,
    b.parent_part_no,
    b.child_part_no,
    w.multiplier * b.qty,
    w.depth + 1
  from walk w
  join bill_of_materials b on b.parent_part_no = w.child_part_no
  where w.depth < 8   -- safety: prevent infinite recursion
)
select
  root_part_no,
  child_part_no,
  sum(multiplier) as total_qty
from walk
group by root_part_no, child_part_no;
```

This lets us answer "how many ATD does this gun consume?" with a
single query: `select total_qty from v_bom_walk_recursive where
root_part_no = 'GUN-XYZ' and child_part_no = 'ATD-STD-1'`.

### 5.5 Inventory allocations

```sql
create table inventory_allocations (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  order_id uuid references orders(id) on delete cascade,
  opportunity_id uuid references opportunities(id) on delete set null,
  part_no text not null,
  qty numeric(14,4) not null,
  required_by date not null,
  status text not null default 'reserved'
    check (status in ('reserved','consumed','released','expired')),
  reserved_at timestamptz not null default now(),
  consumed_at timestamptz,
  released_at timestamptz,
  reason_text text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index inv_alloc_part_idx on inventory_allocations
  (tenant_id, part_no, required_by, status)
  where status = 'reserved';
create index inv_alloc_project_idx on inventory_allocations
  (tenant_id, project_id);
```

Allocations are written when an order moves to APPROVED + has a
schedule line, when an opportunity at >=PROPOSAL has structured
line items, or manually by the operator from the planning UI.

### 5.6 Demand forecasts

```sql
create table demand_forecasts (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  part_no text not null,
  week_start date not null,
  -- Decomposed (see 2.6).
  forecast_committed numeric(14,4) not null default 0,
  forecast_pipeline numeric(14,4) not null default 0,
  forecast_baseline numeric(14,4) not null default 0,
  forecast_total numeric(14,4) generated always as
    (forecast_committed + forecast_pipeline + forecast_baseline) stored,
  -- Predictive distribution quantiles.
  quantile_50 numeric(14,4),
  quantile_90 numeric(14,4),
  quantile_95 numeric(14,4),
  quantile_99 numeric(14,4),
  -- Provenance.
  model_name text,
  model_version text,
  wape_4w numeric(6,4),
  wape_8w numeric(6,4),
  wape_12w numeric(6,4),
  generated_at timestamptz not null default now(),
  unique (tenant_id, part_no, week_start, model_name)
);

create index demand_forecasts_part_week_idx on demand_forecasts
  (tenant_id, part_no, week_start desc);
```

### 5.7 Inventory positions (snapshot, daily)

```sql
create table inventory_positions (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  part_no text not null,
  as_of date not null,
  on_hand_qty numeric(14,4) not null default 0,
  in_transit_qty numeric(14,4) not null default 0,
  allocated_qty numeric(14,4) not null default 0,
  net_available_qty numeric(14,4) generated always as
    (on_hand_qty + in_transit_qty - allocated_qty) stored,
  reorder_point numeric(14,4),
  safety_stock numeric(14,4),
  source text not null
    check (source in ('tally','netsuite','sap','d365','acumatica','manual','union')),
  raw_payload jsonb,
  generated_at timestamptz not null default now(),
  unique (tenant_id, part_no, as_of, source)
);
```

The `union` row is the engine's reconciled view across ERP sources;
we keep the per-source rows for audit. The unified view used by the
planning engine reads the `union` row.

### 5.8 Procurement plans

```sql
create table procurement_plans (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  part_no text not null,
  for_week date not null,
  recommended_order_date date not null,
  expected_arrival_date date not null,
  recommended_qty numeric(14,4) not null,
  policy_source text not null default 'rule_based_eoq'
    check (policy_source in
      ('rule_based_eoq','rule_based_coverage','rl_ppo_v1','manual_override')),
  net_requirement numeric(14,4) not null,
  rationale jsonb not null default '{}'::jsonb,
  status text not null default 'draft'
    check (status in
      ('draft','approved','released','received','cancelled','superseded')),
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  released_source_po_id uuid references source_pos(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index procurement_plans_status_idx on procurement_plans
  (tenant_id, status, for_week);
```

When the operator clicks "release" on a planned PO, the engine
creates a `source_pos` row from the plan and links the two via
`released_source_po_id`. The plan status flips to `released`.

### 5.9 Inventory exceptions

```sql
create table inventory_exceptions (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  part_no text,
  exception_kind text not null check (exception_kind in
    ('stockout_imminent','below_reorder_point','supplier_delay',
     'demand_spike','forecast_drift','allocation_overrun',
     'no_default_supplier','negative_position')),
  severity text not null check (severity in ('info','warn','bad','critical')),
  detail jsonb not null default '{}'::jsonb,
  status text not null default 'open'
    check (status in ('open','acknowledged','resolved','suppressed')),
  acknowledged_by uuid references auth.users(id),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
```

### 5.10 Forecast runs (provenance)

```sql
create table forecast_runs (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running'
    check (status in ('running','ok','partial_failure','failed')),
  items_count int default 0,
  models_evaluated jsonb default '{}'::jsonb,
  wape_summary jsonb default '{}'::jsonb,
  notes text
);
```

### 5.11 RLS policies

All eight new tables are tenant-scoped. RLS policies follow the
existing pattern in the codebase: write requires
`tenant_id = jwt.tenant_id`, read same. Service role bypasses.

---

## 6. API surface

### 6.1 New endpoints

| Method | Path | Purpose | Permission |
|--------|------|---------|------------|
| GET | `/api/inventory/positions?part_no=&as_of=` | Read positions | `inventory.read` |
| GET | `/api/inventory/forecasts?part_no=&horizon=` | Read forecast curve | `inventory.read` |
| GET | `/api/inventory/plans?status=&part_no=` | Read planned POs | `inventory.read` |
| POST | `/api/inventory/plans/{id}/approve` | Approve a plan | `inventory.approve` |
| POST | `/api/inventory/plans/{id}/release` | Release plan to source PO | `inventory.release` |
| POST | `/api/inventory/plans/{id}/cancel` | Cancel a plan | `inventory.approve` |
| POST | `/api/inventory/allocations` | Create reservation | `inventory.write` |
| PATCH | `/api/inventory/allocations/{id}` | Modify reservation | `inventory.write` |
| GET | `/api/inventory/exceptions?status=open` | Read exceptions | `inventory.read` |
| POST | `/api/inventory/exceptions/{id}/ack` | Acknowledge | `inventory.write` |
| POST | `/api/inventory/explain/{plan_id}` | LLM explanation | `inventory.read` |
| POST | `/api/inventory/replan` | Force a replan run | `inventory.admin` |
| GET | `/api/inventory/calibration` | Stage-probability calibration data | `inventory.read` |

### 6.2 Cron entrypoints

| Cron | Cadence | What it does |
|------|---------|--------------|
| `/api/cron/inventory-positions` | every 4h | Position refresh (5.7) |
| `/api/cron/inventory-planning-weekly` | Mon 02:00 IST | Full forecast + plan run (4.1) |
| `/api/cron/inventory-exceptions-tick` | every 30 min | Real-time exception checks (4.5) |

All three follow the existing pattern in `src/api/cron/*.js`.

### 6.3 RBAC additions

Add four permissions to `src/v3-app/lib/rbac.ts`:

```
inventory.read     -> sales_engineer:r, sales_manager:r, procurement:rw, finance:r, admin:rw, operator:r, viewer:r
inventory.write    -> procurement:rw, admin:rw, operator:r (allocation only)
inventory.approve  -> procurement:rw, admin:rw, finance:r
inventory.release  -> procurement:rw, admin:rw   (creates source POs)
inventory.admin    -> admin:rw                    (force replan, edit policy)
```

---

## 7. UI specification (Anvil design system)

### 7.0 Screens added

| ID | Route | Purpose |
|----|-------|---------|
| S1 | `/#/inventory-planning` | Dashboard: 12-week shortage view + KPIs |
| S2 | `/#/inventory-plans` | Planned-PO release queue |
| S3 | `/#/inventory-exceptions` | Exception alerts feed |
| S4 | `/#/inventory-item?part_no=` | Per-item drilldown |
| S5 | `/#/inventory-allocations` | Allocations workbench |
| S6 | `/#/inventory-suppliers` | Suppliers + lead-time analytics |

All screens follow the existing primitives in
`src/v3-app/lib/primitives.tsx` (`WSTitle`, `WSTabs`, `KPI`,
`KPIRow`, `Card`, `Banner`, `Btn`, `Steps`, `Stream`, `KV`,
`RailPanel`, `Chip`, `Dot`, `Sev`, `Prov`).

### 7.1 S1 Inventory-Planning Dashboard

```
+--------------------------------------------------------------------------+
| Sales-Ops · Inventory Planning                                rfsh ·  ⚙   |
+--------------------------------------------------------------------------+
| [KPIRow]                                                                  |
|   Items at risk (8w)   Plans pending     Open exceptions   Forecast WAPE  |
|        12  ↑3 / wk          7                3 (1 critical)      18.4% (-2.1)|
+--------------------------------------------------------------------------+
| [WSTabs]  Overview · By item · By supplier · Calibration · Backtest       |
+--------------------------------------------------------------------------+
| 12-week shortage timeline (Card)                                          |
|                                                                           |
|   ATD-STD-1  [bar chart with green/yellow/red weeks]   plan 14 wk-22      |
|   TIMER-A1   [bar chart]                                no shortage       |
|   GUN-X4     [bar chart]                                ROP breach wk-18  |
|                                                                           |
|   Click any bar -> per-week explanation drawer (right side, ThreadDrawer  |
|   style) showing committed / pipeline / baseline / on-hand / in-transit / |
|   allocated breakdown.                                                    |
+--------------------------------------------------------------------------+
| Top exceptions (Card)                          [Stream component]         |
|   ●● [bad ]   ATD-STD-1 stockout in 3 wk · 4 short                ack    |
|   ●● [warn]   Supplier ABC delayed 4 days on PO-9412               ack    |
|   ●● [info]   JBM Auto opp moved to PROPOSAL · +6 ATD demand              |
+--------------------------------------------------------------------------+
| Action bar (Btn primary): "Run replan now"   "Export plan"   "Settings"   |
+--------------------------------------------------------------------------+
```

Primitives used: `WSTitle`, `KPIRow` (4 KPIs), `WSTabs` (5 tabs),
`Card` (3 cards), `Stream` (exceptions), `Btn`, `Banner`.

Empty state: `Banner kind=info` "No items configured for planning.
Add an item to start." with a `Btn` to S4.

Loading state: `Banner kind=loading` + skeleton bars.

Error state: `Banner kind=bad` with the standard retry pattern.

`prefers-reduced-motion: reduce` collapses the bar-chart entry
animation to a fade.

### 7.2 S2 Planned-PO Release Queue

```
+--------------------------------------------------------------------------+
| Procurement · Planned POs                                                  |
+--------------------------------------------------------------------------+
| [KPIRow] Pending: 7  · Approved: 12 · Released MTD: ₹84.2L · Avg cycle: 3d|
+--------------------------------------------------------------------------+
| [WSTabs] Pending · Approved · Released · Cancelled · All                   |
+--------------------------------------------------------------------------+
| Table:                                                                    |
|  # | item   | supplier | qty   | order date | eta date  | rationale | act |
| ---|--------|----------|-------|------------|-----------|-----------|-----|
|  1 | ATD-1  | Tokyo Co | 14    | 2026-05-15 | 2026-08-12| [Why? ▸]  | ✓ ✗ |
|  2 | TIMER-A| Berlin G | 6     | 2026-05-22 | 2026-07-08| [Why? ▸]  | ✓ ✗ |
|                                                                           |
|  Click "Why? ▸" -> drawer (RailPanel) with the rationale jsonb rendered   |
|  as KV pairs: net_req, ss, rop, contributing_opps[], confidence band,    |
|  WAPE.                                                                    |
|  Plus a "ask AI to explain" button that hits /api/inventory/explain      |
|  and renders the Haiku response in a Card.                                |
+--------------------------------------------------------------------------+
| Bulk action bar (footer, sticky):                                         |
|   [☐] Select all   [Btn primary] Approve N   [Btn] Release N   [Btn] x   |
+--------------------------------------------------------------------------+
```

Primitives: `WSTitle`, `KPIRow`, `WSTabs`, `Card`, table styles,
`RailPanel` (drawer), `Btn`, `Banner`. Bulk selection follows the
existing pattern in `orders.tsx`.

### 7.3 S3 Exceptions feed

A single-pane stream of `inventory_exceptions` rows, severity-coded
with `Dot` and `Sev`, ack-able with a `Btn ghost`. Exception kinds
get colour-coded chips:

```
[bad ]  stockout_imminent       [warn] below_reorder_point
[warn] supplier_delay          [info] demand_spike
[bad ]  forecast_drift          [warn] allocation_overrun
[warn] no_default_supplier     [bad ]  negative_position
```

`Stream` primitive renders the timeline; `Banner` shows aggregate
counts at the top.

### 7.4 S1.4 Calibration tab (dashboard sub-tab)

A two-column chart area:

- Left: bar chart of "raw stage probability" vs "calibrated from
  last-12-month wins". The deltas are highlighted with a `Sev` chip.
- Right: confusion-matrix-like grid of stage transitions, showing
  how often opps actually moved between stages.

Primitives: `Card`, `KV`, `Chip`, simple SVG bars (no new chart lib).

### 7.5 S4 Per-item drilldown

```
+--------------------------------------------------------------------------+
| ATD-STD-1 · Auto Tip Dresser std                                          |
+--------------------------------------------------------------------------+
| [KPIRow] On-hand 18 · In-transit 8 · Allocated 12 · Net avail 14 ·        |
|          ROP 22 · SS 9                                                     |
+--------------------------------------------------------------------------+
| [WSTabs] Position · Forecast · Plans · Allocations · Suppliers · History  |
+--------------------------------------------------------------------------+
| Forecast tab:                                                              |
|   Stacked-area chart: committed (solid) | pipeline (hatched) | baseline   |
|   (light)  with q90/q95 bands.  Hover -> exact values.                    |
|                                                                            |
|   "Demand class: Lumpy  · Model: TSB+Bootstrap  · WAPE 8w: 21.4%"          |
+--------------------------------------------------------------------------+
| Plans tab:                                                                 |
|   List of procurement_plans rows for this item. Each row has the          |
|   rationale drawer (same as 7.2).                                         |
+--------------------------------------------------------------------------+
| Action bar:  "Override service level" · "Override ROP" · "Pin model"      |
+--------------------------------------------------------------------------+
```

Primitives: same set, plus a small ASCII-style stacked area chart
implemented in pure SVG. No charting library dependency.

### 7.6 S5 Allocations workbench

Table view of `inventory_allocations`. Filter by status / project /
item. Inline edit `qty` and `required_by`. Bulk release on
project-completed.

### 7.7 S6 Suppliers + lead-time analytics

`suppliers` table list, drill-in to see:

- Lead-time histogram (last 12 months of `acknowledged_eta vs actual_receipt`).
- On-time-delivery percentage with sparkline.
- Open POs and their current ETA risk band.

### 7.8 Mobile

Two of the screens are valuable on mobile (S2 approve-on-the-go and
S3 exceptions). They land in `MobileShell.tsx` as one tab labelled
"Planning" with a sub-segmented control between "Plans" and
"Alerts". The full dashboard (S1) is desktop-only, behind a banner
explaining so.

### 7.9 Notifications

Critical exceptions push to:

- `notification_bell` (existing `Bell` component in the shell).
- Email via the existing `comms/email` rail (template:
  `inventory_alert`).
- Voice call (Vapi/Retell) if `severity = critical` and the
  operator opted into voice escalations in `tenant_settings`.
  Recording-disclosure already covered by the May 2026 voice
  build.

### 7.10 Audit trail

Every mutation calls `recordAudit` with action verbs:

```
inventory.plan.approved         inventory.plan.released
inventory.plan.cancelled        inventory.allocation.created
inventory.allocation.released   inventory.exception.acknowledged
inventory.replan.forced         inventory.policy.overridden
```

These appear in `audit/processing` and `audit/events`.

---

## 8. Integrations

### 8.1 ERP mirrors (existing)

- Tally: `tally_inventory` -> `inventory_positions(source='tally')`
- NetSuite: `netsuite_inventory_balances` -> `inventory_positions(source='netsuite')`
- SAP: `sap_inventory_balances` -> `inventory_positions(source='sap')`
- D365 / Acumatica / Plex / etc.: same pattern, one row per ERP per
  item per day.
- The reconciler picks the highest-fidelity source for the `union`
  row, with a deterministic tie-break: `sap > netsuite > d365 >
  acumatica > tally`.

### 8.2 Sales pipeline

- `opportunities`: needs structured line items. Today the line
  items are in a JSONB blob on opportunities. Add a relational
  `opportunity_line_items` table in the same migration so the
  pipeline-demand engine can sum without parsing JSONB. Migration
  also backfills from the existing JSONB.
- `quotes`, `orders`: read `line_items` JSONB (continue) and
  `order_schedule_lines` (already relational) for confirmed
  demand.
- BOM walk via the recursive view (5.4) to translate gun-level
  forecasts to component-level.

### 8.3 Source POs

- Continue to write `source_pos` for the operator-facing PO record.
- Also write a row to `source_po_lines` per line. Backfill job is
  one-shot.
- The position refresher reads `source_po_lines` for clean
  per-item in-transit aggregation by `acknowledged_eta`.

### 8.4 Audit / processing

- Every cron run writes a `processing_event` keyed by the run's
  `forecast_run_id`.
- Every plan transition writes an `audit_event`.

### 8.5 Calendar-aware lead time

`holiday_calendar` already exists and is used by the order-cycle
calculator. The lead-time computation skips holidays when computing
expected receipt dates, the same way the existing scheduler does.

### 8.6 LLM key

The explanation feature uses the tenant's `tenant_settings.llm_key_provider`.
No new key infra; if BYO is unset, fall back to the platform key
behind the existing redaction rail.

---

## 9. Phased rollout

### Phase 1: data + ingest (1.5 weeks)

- Migration `085_inventory_planning.sql` (5.1-5.10).
- Backfill scripts: `source_pos.payload to source_po_lines`,
  `source_pos.supplier text to suppliers FK`, item_master defaults
  for `service_level`, `safety_stock`, `reorder_point`.
- New seed `360_inventory_planning.sql` to populate fixtures for
  the staging DB.
- Verify queries in `999_verify.sql` extended.
- Acceptance: schema applied clean, 12 fixture items planning-ready
  on staging.

### Phase 2: forecast + plan engine (2.5 weeks)

- Demand classifier (3.2).
- Statistical model fits via Nixtla statsforecast.
- Neural / global model fits via neuralforecast (NHITS first; TFT
  as second-pass option).
- Intermittent models (Croston, SBA, TSB, Willemain bootstrap).
- Pipeline calibration model (3.7).
- Net-req computation + planned-PO emit (4.4).
- Daily position refresh cron + weekly full-run cron.
- Acceptance: weekly run on staging produces non-zero plans; WAPE
  measured on backtest is within target ranges (G4); audit events
  written.

### Phase 3: UI + alerts (2.5 weeks)

- S1 Dashboard.
- S2 Plans queue.
- S3 Exceptions.
- S4 per-item drilldown.
- S5/S6 (allocations, suppliers).
- LLM-explain endpoint and UI hook.
- Email + voice notification glue.
- MobileShell tab.
- Acceptance: every screen renders on staging with seeded data;
  approval / release flow round-trips end-to-end; CmdK includes
  the new actions ("Approve plans", "Show exceptions").

### Phase 4 (Year-2): RL replenishment + multi-echelon

- Once 12 months of forecast/actuals data exist, train a PPO policy
  (3.9) and A/B against the rule-based policy.
- Add `location_id` to positions / allocations / plans for
  multi-warehouse support.
- Implement the guaranteed-service MEIO LP [7] for
  cross-echelon safety-stock placement.

### Effort summary

| Phase | Sequential | Parallel-2 | Notes |
|-------|-----------:|-----------:|-------|
| 1 | 1.5 w | 1.0 w | schema + backfills |
| 2 | 2.5 w | 1.5 w | forecast engine |
| 3 | 2.5 w | 1.5 w | UI + alerts |
| Total v1 | 6.5 w | 4.0 w | (one engineer / two engineers) |
| Phase 4 | +4 w | n/a | Year-2 |

---

## 10. Acceptance criteria

| # | Criterion | Verification |
|---|-----------|--------------|
| A1 | Migration applies idempotently against the staging DB | seed-apply CI green |
| A2 | Position refresh cron runs every 4h with < 30s p95 latency | cloud-run logs |
| A3 | Weekly forecast run completes for 200+ items in < 10 min | cron telemetry |
| A4 | WAPE 4w / 8w / 12w persisted on every forecast row | spot-check `demand_forecasts` |
| A5 | Every planned PO has a non-empty `rationale` jsonb | DB constraint test |
| A6 | Every plan-state transition writes an `audit_event` row | integration test |
| A7 | Operator can approve, release, and cancel a plan from the UI in < 30s | manual UAT |
| A8 | Critical exceptions push to bell + email + voice (when opted-in) | manual UAT |
| A9 | RBAC: operator role cannot release a PO; finance can read but not approve | RBAC matrix test |
| A10 | Demand-classifier per-item label is stable across runs (no flapping) | regression test |
| A11 | Removing the `inventory_planning_enabled` tenant flag disables all crons | feature-flag test |
| A12 | Teardown phase cleans `inventory_*` tables when seed_env=staging | seed-apply teardown CI |

---

## 11. Risks and open questions

### 11.1 Risks

- R1: Lead-time variance estimation requires >= 12 prior receipts
  per (supplier, item). New suppliers will fall back to a
  conservative pessimistic prior. Mitigation: a `lead_time_prior`
  column on `suppliers` for operator-set initial values; the
  engine widens to data-driven once N>=12.
- R2: Pipeline-stage probability calibration needs >= 12 months
  of historical opportunity data. Mitigation: until then, use the
  table in 2.7 directly with no calibration.
- R3: Cross-ERP reconciliation can produce conflicting on-hand
  numbers. Mitigation: deterministic tie-break (8.1) + an exception
  surface (`inventory_exceptions.exception_kind = 'erp_mismatch'`).
- R4: Forecast drift on lumpy items can cause planned-PO whiplash.
  Mitigation: hysteresis on the planned-PO trigger (require
  `NR > 0` for two consecutive runs), tracked in `procurement_plans.status`.
- R5: LLM explanation latency. Mitigation: cache the explanation
  per `procurement_plan.id + version`; only re-call when the plan
  changes.

### 11.2 Open questions for Joel / operations

| # | Question | Need by |
|---|----------|---------|
| Q1 | Confirm the exact ATD/Timer SKUs that should be planning-enabled in v1 (initial set) | Phase 1 |
| Q2 | Confirm service-level targets per class (default 0.99 critical, 0.95 standard, 0.85 long-tail) | Phase 1 |
| Q3 | Confirm holding-cost rate (used in EOQ). Industry default 20-25% per year. | Phase 2 |
| Q4 | Confirm ordering-cost-per-PO (used in EOQ). Default 5,000 INR. | Phase 2 |
| Q5 | Confirm the ERP-source priority (default tally-on-prem > netsuite > sap) | Phase 2 |
| Q6 | Confirm voice-escalation opt-in policy (only critical? cap per day?) | Phase 3 |
| Q7 | Confirm whether opportunities need structured line items now or whether we infer from gun-model on the opportunity header | Phase 1 |

---

## Sources (research)

- [1] [ARIMA vs Prophet vs LSTM for Time Series Prediction](https://neptune.ai/blog/arima-vs-prophet-vs-lstm), Neptune.ai
- [2] [Mastering Time Series Forecasting: From ARIMA to LSTM](https://machinelearningmastery.com/mastering-time-series-forecasting-from-arima-to-lstm/), Machine Learning Mastery
- [3] [A Review of Croston's method for intermittent demand forecasting](https://www.researchgate.net/publication/254044245_A_Review_of_Croston's_method_for_intermittent_demand_forecasting), ResearchGate
- [4] [A new approach to forecasting intermittent demand for service parts inventories (Willemain bootstrap)](https://smartcorp.com/wp-content/uploads/2015/07/IJF_Bootstrap_paper_Smart_Software.pdf), Smart Software
- [5] [Weighted Pipeline: Probability-Based Opportunity Valuation and Forecasting, 2026 Guide](https://resources.rework.com/libraries/pipeline-management/weighted-pipeline)
- [6] [How to use pipeline-weighted techniques for better sales forecasting](https://www.drivetrain.ai/post/pipeline-weighted-sales-forecasting), Drivetrain
- [7] [MILP reformulation and extension of multi-echelon inventory optimization model based on the guaranteed service approach](https://www.sciencedirect.com/science/article/abs/pii/S0098135425003072), Computers and Chemical Engineering 2025
- [8] [Multi-Echelon Inventory Optimization: Definition and Process](https://intuendi.com/resource-center/multi-echelon-inventory-optimization/), Intuendi
- [9] [Economic Order Quantity, Wikipedia](https://en.wikipedia.org/wiki/Economic_order_quantity)
- [10] [Simple Economic Order Quantity heuristics for stochastic inventory control](https://doi.org/10.1093/imaman/dpaf035), IMA Journal of Management Mathematics 2025
- [11] [The Effect of Lead Time Uncertainty on Safety Stocks](https://www.kellogg.northwestern.edu/faculty/chopra/htm/research/effect%20of%20lead%20time%20uncertainty.pdf), Chopra and Reinhardt, Kellogg
- [12] [The Gamma Distribution and Inventory Control: Disruptive Lead Times Under Conventional and Nonclassical Conditions](https://www.mdpi.com/2305-6290/9/2/67), MDPI 2024
- [13] [Multi-Agent Deep Reinforcement Learning for Integrated Demand Forecasting and Inventory Optimization](https://pmc.ncbi.nlm.nih.gov/articles/PMC12031219/), PMC
- [14] [Dynamic Optimization of Multi-Echelon Supply Chain Inventory Policies Under Disruptive Scenarios: A Deep Reinforcement Learning Approach (PPO)](https://www.mdpi.com/2073-8994/17/12/2078), MDPI Symmetry 2025
- [15] [Nixtla suite, statsforecast / neuralforecast / mlforecast](https://nixtlaverse.nixtla.io/statsforecast/index.html)
- [16] [How to Choose the Best Model for Time Series Forecasting](https://www.ikigailabs.io/blog/how-to-choose-the-best-model-for-time-series-forecasting-arima-prophet-or-mssa), Ikigai Labs

---

## Appendix A: design-system primitives used

Verified against `src/v3-app/lib/primitives.tsx` and the existing
screens that already use them:

| Primitive | Used on |
|-----------|---------|
| `WSTitle` | every screen |
| `WSTabs` | S1, S2, S4, S6 |
| `KPI`, `KPIRow` | S1, S2, S4, S6 |
| `Card` (and `Card flush`) | S1 (timeline + exceptions), S2 (table wrapper), S4 (every tab) |
| `Banner` (kind = info / good / warn / bad / loading) | empty / loading / error states |
| `Btn` (kind = primary / ghost) | every action |
| `Steps` | not used (no linear stepper here) |
| `Stream` | S1 exceptions feed, S3 |
| `KV` | rationale drawers, item drilldown |
| `RailPanel` | rationale drawers |
| `Chip`, `Dot`, `Sev` | severity tagging across all screens |
| `Prov` | citing the data source on each KPI (tally / netsuite / engine) |

No new primitives are required. No new chart library is required.

---

## Appendix B: glossary

- ADI: Average Demand Interval (mean number of periods between
  non-zero demand events).
- CV: Coefficient of Variation (sigma / mean).
- EOQ: Economic Order Quantity (Wilson formula).
- LTD: Lead-Time Demand.
- MEIO: Multi-Echelon Inventory Optimization.
- MOQ: Minimum Order Quantity.
- ROP: Reorder Point.
- SBA: Syntetos-Boylan Approximation (intermittent forecasting).
- TSB: Teunter-Syntetos-Babai (intermittent forecasting with
  obsolescence handling).
- WAPE: Weighted Absolute Percentage Error.

---

End of design v1. The next document iteration will resolve the
seven open questions in 11.2 and pin the v1 SKU list.
