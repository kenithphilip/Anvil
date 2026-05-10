# Strategic Bet 03: Conformal-prediction safety stock

> Source: research synthesis 2026-05-10. Companion to
> `docs/STRATEGIC_PLAN_2026_05.md` Bet 3.
> Status: research complete, ready for implementation.

## TL;DR

Replace fixed-quantile safety stock (z-score / Wilson-Hilferty gamma)
with **conformal-prediction intervals** computed per-SKU. Use
**NEXCP** (non-exchangeable, exponentially-weighted residuals) as the
default, with **Split CP** for short-history SKUs and **pooled
cold-start CP** for new items. Pure JavaScript, no Python, no new
runtime.

Goal: 20% drop in stockout rate at the same average inventory
holding.

Effort: ~7 engineer-weeks (one engineer) or ~4 calendar weeks with
two engineers. Migration `097`.

---

## 1. Research summary

### 1.1 Anvil's current safety-stock pipeline

`src/api/_lib/inventory/safety-stock.js` and
`src/api/_lib/inventory/forecast.js`. Pure JavaScript, runs inside
Vercel serverless, invoked by
`src/api/cron/inventory-planning-weekly.js`.

Today's approach is parametric:
- forecasters: Croston / SBA / TSB / SMA / SES picked by
  `pickForecaster(demandClass)`,
- residual sigma over walk-forward residuals,
- normal z-score (`ssNormal`) or Wilson-Hilferty gamma quantile
  (`ssGamma`),
- stamps `quantile_50/90/95/99 = mean + z*sigma` on every
  `demand_forecasts` row.

The problem framing is correct: assuming a parametric error
distribution on lumpy / intermittent SKUs is exactly what conformal
prediction was designed to fix.

Note: there is no `src/api/inventory/forecast.js` (the brief
referenced one); the file is `src/api/_lib/inventory/forecast.js`.
The forecaster ensemble is classical (Croston / SBA / TSB / SMA /
SES), not "XGBoost / ETS / naive" - the ML model menu is deferred to
a Phase 2.5 Python micro-service. This bet wraps the existing JS
classical forecasters in a CP layer, with a clean upgrade path for
the ML side.

### 1.2 Conformal-prediction families

| Method | Description | Anvil fit |
|---|---|---|
| Split CP | Trivial; assumes exchangeability (broken for time series) | Fallback for short history |
| Block CP (Chernozhukov et al. 2018) | Permutation in blocks; serial-dependence valid | Future |
| EnbPI (Xu & Xie 2020/TPAMI) | Wraps bootstrap ensemble; no data splitting; non-exchangeable | Future, needs ML migration |
| ACI (Gibbs & Candès NeurIPS 2021) | Online single-parameter miscoverage update | Cheap diagnostic, not primary |
| **NEXCP (Barber et al. 2023)** | Exponentially-decaying weights on residuals | **Default** |
| CPTC (Sun & Yu NeurIPS 2025) | Change-point detection + online CP | Premature for MVP |
| Weighted CP (Tibshirani) | Covariate-shift weights | Niche |

Sources: [arxiv 2010.09107 EnbPI](https://arxiv.org/abs/2010.09107),
[arxiv 2106.00170 ACI](https://arxiv.org/abs/2106.00170),
[NEXCP paper PDF](https://www.stat.cmu.edu/~ryantibs/papers/nexcp.pdf),
[arxiv 2509.02844 CPTC](https://arxiv.org/abs/2509.02844),
[arxiv 1802.06300 Block CP](https://arxiv.org/abs/1802.06300).

### 1.3 Vendor / academic landscape

[Lokad State of Probabilistic Forecasting (Dec 2025)](https://www.lokad.com/blog/2025/12/5/the-state-of-probabilistic-forecasting-in-supply-chain/):

- ToolsGroup: quantile demand forecasts; deterministic lead time.
- Blue Yonder, RELEX: market "probabilistic" but largely run
  deterministic safety-stock with ML-tuned z scores.
- o9, Kinaxis: evolving from deterministic foundations.
- Lokad: programmatic full-distribution forecasts, no CP.

**None of the major SCM vendors advertise CP-based safety stock as
of Q2 2026.** Academic precedent exists in healthcare and retail
([Hospital Inventory Resilience (2025)](https://gprjournals.org/journals/index.php/jpscm/article/download/493/491/1349),
[Springer JIM 2024](https://link.springer.com/article/10.1007/s10845-024-02442-y),
[arxiv 2412.13159 newsvendor + CP](https://arxiv.org/html/2412.13159v1)).

This is real differentiation against ToolsGroup / Blue Yonder /
Tally-stack vendors in the Indian market.

---

## 2. Recommended approach

### 2.1 Method selection

| Tier | Method | Trigger |
|---|---|---|
| Default | NEXCP per SKU | Tenant `inventory_conformal_enabled = true` AND `calibration_residuals_count >= 12` |
| Short-history | Split CP | Same tenant flag, residual count 12-25 |
| Cold-start | `pooledColdStartCP` over `item_type` cohort | Residual count < 12 |
| Legacy | Existing parametric (`ssNormal` / `ssGamma`) | Tenant flag off OR override |

Hard floor: `safety_stock = max(CP_band, ssGamma)` for SKUs with
`calibration_residuals_count < 26`. Project-equivalent floor
(`ssProjectFloor`, already in `safety-stock.js`) stays as outermost
lower bound.

### 2.2 Runtime decision: pure JS, no Python

Anvil's runtime is Node 20 / Vercel serverless / Vite + React. No
Python in-tree. Adding a Python worker (Modal / EC2 / Vercel Python
Beta) is non-trivial and unnecessary - NEXCP and Split CP are ~150
lines of clean JS.

Why not MAPIE / crepes (Python BSD-3 libraries, the canonical
implementations): the math is small enough that vendoring it in JS
is cleaner than introducing a Python deploy surface.

The Python migration belongs to the deferred ML model menu (NHITS /
TFT / LightGBM, see `docs/INVENTORY_PLANNING_DESIGN.md` Phase 2.5),
not to this bet.

---

## 3. Data model + migrations

**Migration `097_inventory_conformal_intervals.sql`** (idempotent;
re-number to 098/099 if Bets 1 or 2 land first).

```sql
-- Add CP-derived intervals alongside existing parametric ones.
alter table demand_forecasts
  add column if not exists conformal_method text
    check (conformal_method is null or conformal_method in
      ('split_cp','nexcp','enbpi','block_cp','pooled_cold_start','parametric_legacy')),
  add column if not exists coverage_target numeric(4,3)
    check (coverage_target is null or (coverage_target > 0.5 and coverage_target < 1)),
  add column if not exists interval_lo numeric(14,4),
  add column if not exists interval_hi numeric(14,4),
  add column if not exists calibration_residuals_count int
    check (calibration_residuals_count is null or calibration_residuals_count >= 0);

alter table procurement_plans
  add column if not exists conformal_method text,
  add column if not exists coverage_target numeric(4,3),
  add column if not exists interval_lo numeric(14,4),
  add column if not exists interval_hi numeric(14,4),
  add column if not exists calibration_residuals_count int;

alter table item_master
  add column if not exists conformal_coverage numeric(4,3)
    check (conformal_coverage is null or (conformal_coverage > 0.5 and conformal_coverage < 1)),
  add column if not exists conformal_method_override text;

alter table tenant_settings
  add column if not exists inventory_conformal_enabled boolean not null default false,
  add column if not exists inventory_conformal_default_coverage numeric(4,3) not null default 0.95;

-- Per-SKU rolling residuals.
create table if not exists conformal_calibration_residuals (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  part_no text not null,
  forecast_run_id uuid references forecast_runs(id) on delete set null,
  week_start date not null,
  forecast_value numeric(14,4) not null,
  actual_value numeric(14,4) not null,
  residual numeric(14,4) generated always as (actual_value - forecast_value) stored,
  weight numeric(8,6) not null default 1.0,
  created_at timestamptz not null default now(),
  unique (tenant_id, part_no, week_start)
);
create index if not exists ccr_part_idx
  on conformal_calibration_residuals (tenant_id, part_no, week_start desc);

alter table conformal_calibration_residuals enable row level security;
create policy "ccr_select" on conformal_calibration_residuals
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
create policy "ccr_modify" on conformal_calibration_residuals
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
```

Note: brief calls the table `inventory_reorder_plans`; codebase
calls it `procurement_plans`. Mirroring CP fields on both
`demand_forecasts` and `procurement_plans` so downstream consumers
can read either.

---

## 4. User-visible UX

### 4.1 Per-SKU coverage picker

`src/v3-app/screens/inventory-planning.tsx` "By item" tab gets a new
column: `<select>` with `90% / 95% / 99% / Tenant default` next to
each item. Persists via
`PATCH /api/inventory/items/:part_no { conformal_coverage }`.
SKU override beats item-type default. `service_level` column maps
to the same coverage target (rename label, keep column for one
release cycle).

### 4.2 Default policy by item class

Mirror the `SL_BY_TYPE` map in the existing cron: ATD / TIMER 0.99,
GUN / GUN_COMPONENT 0.95, SPARE / CONSUMABLE 0.85. Editable on a new
"Coverage" tab as a tenant config.

### 4.3 Interval band on the forecast chart

`src/v3-app/screens/inventory-item.tsx`: shaded band for
`interval_lo` to `interval_hi`; line for `quantile_50` (point
forecast); horizontal cap lines for `safety_stock` and
`reorder_point`. Tooltip exposes `conformal_method` and
`calibration_residuals_count`.

### 4.4 Stockout-vs-cost tradeoff dashboard

New card on the Overview tab: two backtested counterfactuals over
the last 13 weeks - stockout incidents and INR holding cost under
fixed-quantile vs CP policy. Pulls from `forecast_runs.wape_summary`
extended with a `cp_summary` jsonb.

### 4.5 CSV export

Add CP fields to the existing plan and forecast CSV exports.

### 4.6 Cold-start indicator

Chip on the "By item" tab: `pooled` (gray) for SKUs in pooled-prior
mode, `calibrated` (green) once they have >= 26 own residuals.

---

## 5. Technical implementation plan

### Step 1 - math module

New `src/api/_lib/inventory/conformal.js`:
- `splitCP(residuals, alpha)` -> `{ qLo, qHi }`.
- `nexCP(residuals, alpha, rho = 0.99)` with exponential-decay
  weights ([Barber et al. 2023](https://www.stat.cmu.edu/~ryantibs/papers/nexcp.pdf)
  weighted-quantile algorithm: sort, accumulate normalized weights,
  return residual where cumulative weight crosses `1 - alpha`).
- `pooledColdStartCP(residuals_by_class, partClass, alpha)` for
  SKUs with insufficient own history.
- `intervalForForecast({ pointForecast, residualLo, residualHi })`
  to add the band, clamped at zero.
- `safetyStockFromInterval({ interval_hi, leadTimeMean, demandMean })`
  -> `(interval_hi over LTD window) - E[LTD]`. Replaces `ssNormal` /
  `ssGamma` for CP-enabled SKUs.

### Step 2 - pipeline

Refactor `src/api/cron/inventory-planning-weekly.js`:
- After per-SKU `pickForecaster + residualSigma`, append actual-vs-
  forecast pairs to `conformal_calibration_residuals`.
- Pull last N residuals (default 156 = 3 years).
- If tenant `inventory_conformal_enabled = true` AND >= 12 nonzero
  residuals: call `nexCP`. Else `pooledColdStartCP` against the
  SKU's `item_type` cohort.
- Compute interval band over the lead-time window. Replace
  `ssNormal/ssGamma` output with `safetyStockFromInterval` for CP-
  enabled SKUs. Persist parametric value as `legacy_safety_stock`
  on the rationale jsonb so the dashboard can A/B.
- Stamp `conformal_method`, `coverage_target`, `interval_lo`,
  `interval_hi`, `calibration_residuals_count` on each
  `demand_forecasts` row and resulting `procurement_plans` row.

### Step 3 - calibration job

New cron `src/api/cron/conformal-calibration-weekly.js` running 12
hours before the planning cron. Backfills missing rows in
`conformal_calibration_residuals`, prunes residuals older than 156
weeks. Idempotent.

### Step 4 - APIs

- `src/api/inventory/forecasts.js`: return new columns.
- `src/api/inventory/plans.js`: same.
- New `GET /api/inventory/conformal_diagnostics?part_no=...` -
  empirical coverage over last 13 weeks (UI shows "actual coverage
  92%, target 95%").

### Step 5 - UI

- `inventory-planning.tsx` + `inventory-item.tsx` per section 4.
- New "Coverage" tab with `SL_BY_TYPE` table.
- Backtest counterfactual dashboard.

### Step 6 - testing

- Unit: `src/api/_lib/inventory/conformal.test.js` with synthetic
  residuals (i.i.d. normal, heavy-tailed Cauchy, intermittent zero-
  heavy, change-point series). Assert empirical coverage within
  +/-2% of nominal across 5,000 trials.
- Replay: pull 13 weeks of historical actuals from a seeded test
  tenant, run both fixed-quantile and CP policies forward, assert
  CP yields strictly fewer stockouts at non-greater holding cost.
  Failure tolerance: 1 of 13 weeks.
- Integration: extend `inventory-engine.test.js` end-to-end.
- Coverage drift detector: realised coverage stays within +/-5% of
  target; fires `forecast_drift` exception otherwise.

---

## 6. Risks and open questions

- **Calibration drift on intermittent SKUs**. NEXCP weights recent
  residuals heavily; a SKU shipping 2-3 times/year has very few
  nonzero residuals; weighted CP can collapse. Mitigation:
  hierarchical pooling + hard floor of `max(CP-band, ssGamma)` for
  SKUs with `calibration_residuals_count < 26`.
- **Cold-start**. New SKUs have no residuals. Use
  `pooledColdStartCP` over `item_type` cohort. Risk: brand-new gun
  model with unusual demand looks like the modal gun and is under-
  stocked. Mitigation: `ssProjectFloor` already in `safety-stock.js`
  stays as a hard lower bound on top of CP.
- **Math correctness without a domain expert**. CP is more subtle
  than parametric math. Risks: incorrect weighted quantiles, off-
  by-one in residual window, treating zero-demand weeks as
  residuals when forecaster zero-bias means they aren't informative.
  Mitigation: vendor a single-source-of-truth implementation against
  Barber et al. 2023; cross-check on three datasets where MAPIE's
  results are public; ship the legacy parametric column in the
  `rationale` jsonb so we can roll back per-SKU.
- **Multi-echelon**. Out of scope for this bet. CP composes cleanly
  across echelons (each location calibrates independently).

Open:
- Empirical-coverage SLO. Commit to "realised coverage stays within
  5% of target on 90% of SKUs over the last 13 weeks" before
  claiming the 20% stockout drop.
- `service_level` vs `conformal_coverage`. Same meaning. Keep both
  for one release cycle; deprecate `service_level` after.

---

## 7. Effort estimate

| Phase | Scope | Engineer-weeks |
|---|---|---:|
| 0 | Migration 097, schema review, security review | 0.5 |
| 1 | `conformal.js` + unit tests | 1.0 |
| 2 | Cron refactor, calibration cron, residuals table | 1.5 |
| 3 | API surface + diagnostics endpoint | 0.5 |
| 4 | UI: per-SKU picker + chart band + backtest card | 1.5 |
| 5 | Replay tests + coverage SLO + cohort A/B | 1.0 |
| 6 | Phased rollout (one tenant -> beta cohort) | 1.0 |
| **Total** | | **7.0 eng-weeks** |

Two engineers in parallel: ~4 weeks calendar to GA.

---

## 8. Sources cited

- [arxiv 2010.09107 - EnbPI](https://arxiv.org/abs/2010.09107)
- [arxiv 2106.00170 - ACI](https://arxiv.org/abs/2106.00170)
- [NEXCP - Barber, Candès, Ramdas, Tibshirani 2023](https://www.stat.cmu.edu/~ryantibs/papers/nexcp.pdf)
- [arxiv 2509.02844 - CPTC NeurIPS 2025](https://arxiv.org/abs/2509.02844)
- [arxiv 1802.06300 - Block CP](https://arxiv.org/abs/1802.06300)
- [arxiv 2412.13159 - Conformal newsvendor](https://arxiv.org/html/2412.13159v1)
- [JMLR 25 - Split CP and Non-Exchangeable Data](https://jmlr.org/papers/volume25/23-1553/23-1553.pdf)
- [MAPIE 1.3.0 docs](https://mapie.readthedocs.io/) / [GitHub (BSD-3)](https://github.com/scikit-learn-contrib/MAPIE)
- [crepes docs (BSD-3)](https://crepes.readthedocs.io/) / [GitHub](https://github.com/henrikbostrom/crepes)
- [Lokad - State of Probabilistic Forecasting (Dec 2025)](https://www.lokad.com/blog/2025/12/5/the-state-of-probabilistic-forecasting-in-supply-chain/)
- [Hospital Inventory Resilience Using CP (2025)](https://gprjournals.org/journals/index.php/jpscm/article/download/493/491/1349)
- [Springer JIM 2024 - Dynamic safety stock with intermittent series](https://link.springer.com/article/10.1007/s10845-024-02442-y)
- [Vercel Python runtime (Beta)](https://vercel.com/docs/functions/runtimes/python)
- Codebase: `src/api/_lib/inventory/forecast.js`, `src/api/_lib/inventory/safety-stock.js`, `src/api/cron/inventory-planning-weekly.js`, `src/api/inventory/forecast_runs.js`, `src/api/inventory/forecasts.js`, `src/api/inventory/replan.js`, `src/v3-app/screens/inventory-planning.tsx`, `src/v3-app/screens/inventory-item.tsx`, `supabase/migrations/085_inventory_planning.sql`, `docs/INVENTORY_PLANNING_DESIGN.md`.
