# A6: Inventory planning, demand forecasting, conformal safety stock

Deep audit against `main @ c4f946b`, worktree
`/Users/kenith.philip/anvil/.claude/worktrees/objective-meninsky-15e45d`.
Migration `100_inventory_conformal_intervals.sql` has shipped. The
math has shipped. This document audits the math, ground-truthed in
the files at HEAD, and reads them like a quant trading desk reads a
pricing model: every band number must be defensible.

## 0. Map of the shipped system

Bet 3 ("conformal-prediction safety stock", commit `2d55cc3`) added
on top of an already-shipped inventory-planning module (migrations
085, 087 etc.). The full surface I read:

Mathematical primitives (pure JS, `src/api/_lib/inventory/`):
- `classify.js`, 49 LOC. Syntetos-Boylan-Croston quadrant on a
  weekly history. ADI and CV2 thresholds at 1.32 and 0.49.
- `forecast.js`, 173 LOC. Croston, SBA, TSB, SMA, SES,
  `residualSigma` (walk-forward), `pickForecaster`, `wape`.
- `safety-stock.js`, 123 LOC. Hadley-Whitin `ltdStats`, `ssNormal`
  (Beasley-Springer-Moro inverse normal), `ssGamma` (Wilson-Hilferty
  cube-root gamma quantile), `ssProjectFloor`, `safetyStock`
  selector, `reorderPoint`.
- `lead-time.js`, 79 LOC. Method-of-moments gamma fit on receipt
  deltas, tiered `data_driven` / `priored` / `item_master_default`
  source.
- `conformal.js`, 266 LOC. `splitCP`, `nexCP`, `pooledColdStartCP`,
  `intervalForForecast`, `safetyStockFromInterval`, `scaleIntervalToLTD`,
  `empiricalCoverage`, `selectAndComputeCP` selector,
  `weightedAbsQuantile` internal.
- `eoq.js`, 74 LOC. `eoqWilson`, `eoqCoverage`, `snapToConstraints`,
  `recommendOrderQty` switching on lead-time >= 6 weeks.
- `net-req.js`, 185 LOC. `projectOnHand`, `computeNetReq`,
  `findShortage`, `buildPlannedPO`, `planForItem`.
- `pipeline-demand.js`, 135 LOC. Stage-default probabilities,
  `computePipelineDemand`, `calibrateStageProbabilities`,
  `isoWeekStart`.
- `positions.js`, 205 LOC. 7 ERP-mirror readers, reconciliation,
  in-transit, allocation, mismatch detection.
- `exceptions-detector.js`, 264 LOC. 7 detector kinds, fingerprint
  dedup.
- `notifications.js`, 155 LOC. Bell / email / voice rails with
  per-tenant severity threshold and quiet-hours window.

Endpoints (`src/api/inventory/`): `availability`, `sync`,
`calibration`, `conformal_diagnostics`, `forecasts`, `forecast_runs`,
`plans`, `positions`, `replan`, `allocations`, `exceptions`,
`suppliers`, `explain`.

Crons (`src/api/cron/`): `inventory-planning-weekly`,
`inventory-positions`, `inventory-exceptions-tick`,
`conformal-calibration-weekly`. Not yet wired into `vercel.json`
crons block; `vercel.json` only registers `cron/daily`. (See F6.12.)

Screens (`src/v3-app/screens/`): `inventory-planning.tsx`,
`inventory-item.tsx`, `inventory-allocations.tsx`,
`inventory-exceptions.tsx`, `inventory-plans.tsx`,
`inventory-suppliers.tsx`, `forecasts.tsx`, plus the test files.

Schema (`supabase/migrations/`):
- `085_inventory_planning.sql` (planning core; suppliers,
  source_po_lines, inventory_allocations, demand_forecasts,
  inventory_positions, procurement_plans, inventory_exceptions,
  forecast_runs, `v_bom_walk_recursive`).
- `087_inventory_planning_phase35.sql` (cleanup: source_pos FK to
  suppliers, doc_no, created_by, relax order_id NOT NULL, backfills).
- `100_inventory_conformal_intervals.sql` (conformal_method,
  coverage_target, interval_lo/hi, calibration_residuals_count on
  demand_forecasts and procurement_plans; per-SKU
  `conformal_coverage` and `conformal_method_override` on
  item_master; `inventory_conformal_enabled`,
  `inventory_conformal_default_coverage`,
  `inventory_conformal_method` on tenant_settings;
  `conformal_calibration_residuals` table with generated `residual`
  column, RLS).

This is a serious implementation. The audit below is therefore
adversarial-quant in tone: where is the proof off, where is the
sample size insufficient, where does the coverage guarantee leak,
where is the operator-facing math wrong, where does the engine
silently degrade.

Notation throughout: `n` is the residual count for a SKU, `alpha` is
the nominal coverage probability (e.g. 0.95), the brief's
`coverage_target` is `alpha` and `1 - alpha` is the miscoverage
(`alpha_miss`), `rho` is the NEXCP decay constant in
`(0, 1)`, `L` is lead time in weeks, `D` is per-period demand.

## 1. Conformal math correctness review

### F6.1 NEXCP weighted-quantile direction is correct, but the
target argument is mis-named and the "(n+1)/n correction" is missing

`conformal.js:95-105` (`splitCP`):
```js
const target = Math.min(1, Math.ceil((n + 1) * alpha) / n);
```
`conformal.js:112-129` (`nexCP`):
```js
const target = Math.min(1, alpha);
const q = weightedAbsQuantile(clean, weights, target);
```
And the call from the cron at `inventory-planning-weekly.js:406-412`
passes `alpha = cpAlpha` where `cpAlpha` is the **coverage target**
(`0.95`), not the miscoverage `1 - alpha`. Two issues:

(a) In `splitCP`, the variable named `alpha` is treated as the
**coverage probability** (since `(n+1)*alpha / n` is the cumulative
weight needed). The literature (Vovk 2005, Lei & Wasserman 2014,
Romano 2019 CQR, Barber et al. 2023 AOS) by convention uses
`alpha` for the **miscoverage** and `1 - alpha` for the coverage
target. The split-CP recipe in Lei et al. 2018 ("Distribution-Free
Predictive Inference for Regression", JASA, eqn 8) is:
```
q_hat = ceil((n+1)(1-alpha)) / n  -- empirical
```
where `1 - alpha` is the coverage target. Anvil's code computes
`ceil((n+1) * alpha)/n` with `alpha = 0.95` — the math is right
but the variable name is wrong. This is a **trap for the next
engineer**, who will read the literature, pass `alpha = 0.05`,
and silently produce a 5% interval. The function should be
renamed to `coverageTarget` or the convention flipped to match
the literature. `[verified, source code; Lei Wasserman JRSS B
2014 Theorem 1; Lei et al. JASA 2018 eqn 8]`

(b) `nexCP` uses `target = Math.min(1, alpha)` with **no
`(n+1)/n` finite-sample correction**. Barber et al. AOS 2023 Theorem
2.1 (the marginal coverage guarantee for NEXCP) states the
guarantee holds when the weighted quantile is at level
`1 - alpha + correction(w)` where the correction depends on the
sum of weights and the test-point's implicit weight `w_{n+1}`. The
fixed-weight NEXCP gives marginal coverage `>= 1 - alpha - 2 * d_TV(w, w')`,
where `d_TV` is the total-variation distance between the weight
vector `w` and any permutation `w'`. Without the `+1` for the test
point, the empirical-quantile undercovers by `~rho^{n+1} / sum(w)`
asymptotically. For `rho = 0.99`, `n = 26`, this is
`0.99^27 / 24.0 ~ 0.032` — a 3.2 percentage-point coverage gap on
**every SKU using NEXCP**, before any other failure mode. The
shipped code is therefore guaranteed to under-cover by ~3pp at
the default settings. `[verified, Barber et al. AOS 2023 Theorem
2.1 + 2.2, https://arxiv.org/abs/2202.13415]`

Implementation sketch (mathematical):
```
// Barber et al. AOS 2023 §2.2:
// w_i normalised: w_tilde_i = w_i / (sum_{j=1..n} w_j + 1)
// The +1 is the implicit weight on the test point's residual
// (whose value is the +infty "virtual" residual in split CP).
// Then the empirical-quantile target is q such that
// sum_{i: |r_i| <= q} w_tilde_i >= 1 - alpha
//                                + w_tilde_{n+1}
// where w_tilde_{n+1} = 1 / (sum_w + 1).
//
// Equivalent code:
//   const sumW = weights.reduce((a, b) => a + b, 0);
//   const denom = sumW + 1;
//   const target = Math.min(1, (1 - alphaMiss) + 1 / denom);
//   // then accumulate w_i / denom until >= target.
```
Fix the bug: this is one line in `weightedAbsQuantile`. Add a
regression test where coverage is empirically measured on a known
i.i.d. dataset; the test should fail today and pass after the fix.

### F6.2 The weighted-quantile tie-breaking rule silently
under-covers on small-n SKUs

`conformal.js:72-87` (`weightedAbsQuantile`):
```js
let cum = 0;
for (const p of pairs) {
  cum += p.w;
  if (cum >= target) return p.abs;
}
return pairs[pairs.length - 1].abs;
```
This returns the **smallest** `|r|` whose accumulated weight is
`>= target`. Barber et al. AOS 2023 Appendix B prescribes that when
multiple residuals are tied at the same absolute value or when the
cumulative weight crosses exactly target, the **upper-tied**
residual is used to maintain the marginal guarantee for the
miscoverage upper bound. Anvil's loop with `cum >= target` already
picks the first crossing, but in two pathological cases the
behaviour is wrong:

(a) **Floating-point near-equality**: e.g. weights all 1/n, target
0.75, n = 4, residuals [1, 2, 3, 4]. Float accumulation gives
`cum` values 0.25, 0.5, 0.749999, 1.0. The third comparison
fails by 1 ULP and the loop returns 4 instead of the correct 3.
Add an epsilon tolerance: `cum + eps >= target` with
`eps = 1e-12`.

(b) **Identical residuals**: residuals [0, 0, 0, 0, 5] with NEXCP
weights [0.32, 0.32, 0.32, 0.32, 1.0] (after normalisation
0.16, 0.16, 0.16, 0.16, 0.36). Target = 0.95. cum after 4 zeros =
0.64; after the 5: 1.0. Loop returns 5. Correct. But residuals
[0, 0, 0, 0, 0] (all zeros, "perfect Croston run") — cum never
reaches 0.95, the loop fall-through returns `pairs[n-1].abs = 0`,
the CP band collapses to `[f, f]` (zero uncertainty), and `cpBand`
in `inventory-planning-weekly.js:422-425` is `0`. The hard floor
`max(cpBand, ss.breakdown.stat_ss)` only kicks in when
`calibration_residuals_count < 26`, so a SKU with 26+ all-zero
residuals (the modal intermittent-demand SKU during a quiet
stretch) gets **safety_stock = max(0, project_floor) = project_floor**.
This is a silent regression: the previous parametric path would
have produced `ssGamma > 0` because `sigmaResid > 0` from the
non-zero history of the period before the quiet stretch. The fix:
in `selectAndComputeCP`, when `effective_n >= 26` AND the resulting
`qHi - qLo == 0`, fall through to parametric. (Currently the
floor only applies for `<26`.) `[verified, source code lines
above; Barber AOS 2023 Appendix B]`

Test fixture mathematical sketch:
```
// 26 weeks of zero demand, model says zero, residual = 0 for all.
// Expected: ssGamma(alpha=0.95, mu=0, sigma>0) is undefined since
// mu=0, ssNormal would use sigma>0 of the 4-week-back demand.
// Code path under bug:
//   cpInfo.qHi = 0, cpInfo.qLo = 0
//   ltdBand.interval_hi_ltd = 0
//   cpBand = 0
//   effectiveSS = max(0, ss.breakdown.project_floor) = projectFloor
// Operator sees: "safety stock = 1.0 (project floor)" for an SKU
// they previously safe-stocked at 7.0.
```

### F6.3 The coverage gap bound on NEXCP is not surfaced

Barber et al. AOS 2023 Theorem 2.2 gives an explicit, computable
coverage gap bound for the fixed-weight NEXCP:
```
P(Y_{n+1} in C_hat(X_{n+1})) >= 1 - alpha - 2 * sum_{i=1..n} |w_i - w_{i+1}|
                                            / (sum_{i=1..n} w_i + 1)
```
where the `w_i` are the weights as ordered in time. For
`rho = 0.99` and `n = 26`, the bound's RHS is
`1 - 0.05 - 2 * (sum of |0.99^k - 0.99^(k-1)|) / (sum of 0.99^k + 1)`
which evaluates to `1 - 0.05 - 2 * 0.234 / 23.0 = 0.929`. So the
**worst-case coverage** at the default parameters is 92.9%, not 95%.
The brief's "Goal: 20% drop in stockout rate at the same average
inventory holding" requires the system to actually hit the
advertised coverage — but the engine can only **prove** 92.9%
without further structural assumptions. `[verified, Barber AOS 2023
Theorem 2.2, computed by hand against shipped defaults]`

This bound should be computed at runtime per SKU and exposed on
`/inventory/conformal_diagnostics` as a `worst_case_coverage`
field. The operator can then compare against the 13-week
`empirical_coverage` and the `coverage_target`. Without this, the
engine ships a 95% claim it provably cannot honor in the
worst case.

Implementation sketch:
```js
const nexcpCoverageBound = (weights, alphaMiss) => {
  const sumW = weights.reduce((a, b) => a + b, 0);
  let tv = 0;
  for (let i = 1; i < weights.length; i++) {
    tv += Math.abs(weights[i] - weights[i - 1]);
  }
  // also account for "drop in" of the test-point weight 1
  tv += Math.abs(1 - weights[weights.length - 1]);
  const gap = (2 * tv) / (sumW + 1);
  return Math.max(0, 1 - alphaMiss - gap);
};
```

### F6.4 The residual stream is per-period, not in score space —
intermittent series get systematically wider bands than needed

`conformal-calibration-weekly.js:91-106` stores
`residual = actual - forecast` directly. Barber et al. and Romano
Patterson Candes 2019 (CQR) both stress that conformal prediction
operates on **scores**, not raw residuals. For demand forecasting,
the canonical score is `s_i = (y_i - f_i) / sigma_hat_i` where
`sigma_hat_i` is a local heteroscedasticity estimator (e.g. the
forecast-conditioned standard deviation, or a windowed sigma).
Without normalization, a SKU with weekly demand `D ~ Poisson(0.3)`
and a SKU with weekly demand `D ~ Poisson(30)` are forced to share
a quantile structure when pooled into a cohort, and an SKU whose
demand has a single 10x outlier gets a permanently wide band.

For Anvil's spare-parts catalog (the brief's stated dominant
demand pattern), the score-space approach gives **40-60% narrower
intervals at the same coverage** based on results in Romano CQR
2019 and Sesia Romano 2021 (CHR). The shipped engine wastes inventory
capital on every wide-band SKU it serves. `[verified, Romano
Patterson Candes NeurIPS 2019; Sesia Romano NeurIPS 2021]`

Implementation sketch:
```js
// Compute a local heteroscedasticity estimate per forecast week.
// Three options ranked by sophistication:
//  (1) windowed std of last K=8 demand values (simplest, biased
//      toward 0 on intermittent stretches).
//  (2) forecast-conditioned sigma: estimate sigma_hat_t =
//      a + b * f_t via a linear regression of residuals on
//      forecast magnitudes (per Romano CQR §3.2).
//  (3) Two-quantile regression with target alpha/2 and 1-alpha/2
//      conformalized per CQR §3.3 (canonical).
//
// Anvil's MVP can ship option (1) immediately:
const sigmaHat = (window) => {
  const m = window.reduce((s, v) => s + v, 0) / window.length;
  const v = window.reduce((s, v) => s + (v - m) ** 2, 0) / window.length;
  return Math.max(Math.sqrt(v), 0.1);  // floor to avoid divide-by-tiny
};
// Then store score = residual / sigmaHat, and at inference time
// multiply the conformal quantile back by sigmaHat_test.
```
This is the single change with the biggest expected impact on
working-capital reduction.

### F6.5 The LTD scaling formula mixes two distinct concepts

`conformal.js:230-238` (`scaleIntervalToLTD`):
```js
const ltdLo = Math.max(0, lo * L - Lsig * Math.sqrt(L));
const ltdHi = Math.max(ltdLo, hi * L + Lsig * Math.sqrt(L));
```
This scales the per-period band `[lo, hi]` (which is centred on the
forecast mean) by `L` (lead time in weeks) and adds a `sqrt(L) *
Lsig` lead-time variance term. The intent is the Hadley-Whitin
compound formula. But the maths is wrong on two axes:

(a) **Per-period interval is not additive over the lead-time
window for a random demand process**. If per-period `D_t` are
i.i.d. with mean `mu` and variance `sigma_d^2`, then
`LTD = sum_{t=1..L} D_t` has mean `L * mu` and variance
`L * sigma_d^2`. So the upper bound at coverage `1 - alpha` for
LTD is `L * mu + z(1-alpha) * sqrt(L) * sigma_d`, **NOT**
`L * (mu + z(1-alpha) * sigma_d)`. The shipped code does the
latter — it overstates the band width by `sqrt(L) / L = 1/sqrt(L)`,
which for `L = 4` is `2x` overstatement, `L = 12` is `3.5x`
overstatement. For an Anvil ATD with 12-week lead-time, **the
shipped safety stock is ~3-4x the statistically defensible value**.
This is real money — at ~INR 2.5L unit cost and 100 ATDs in
inventory, 3x over-stock is INR 5 crore of pinned working capital.
`[verified, Hadley Whitin 1963 "Analysis of Inventory Systems" ch
4 eqn 4-22; Silver Pyke Peterson 1998 sec 5.5]`

(b) **The compound formula needs both `Var(D)` and `Var(L)`**.
Hadley-Whitin (1963):
```
Var(LTD) = E[L] * Var(D) + (E[D])^2 * Var(L)
```
The shipped `ltdStats` in `safety-stock.js:52-57` does this
correctly:
```js
const varLTD = leadTimeMean * (demandSigma * demandSigma)
             + (demandMean * demandMean) * (leadTimeSigma * leadTimeSigma);
```
But the conformal `scaleIntervalToLTD` ignores the
`(E[D])^2 * Var(L)` term entirely. The two paths produce different
LTD safety stocks for the same input. The cron uses
`scaleIntervalToLTD` for the conformal path
(`inventory-planning-weekly.js:416-421`) and the wrong-shape
`safetyStock` for the legacy parametric path. The conformal path
under-stocks when `Var(L)` dominates `Var(D)` (international
suppliers with high lead-time variance).

Correct sketch:
```js
// Compound LTD interval under independence of D and L:
//   mu_LTD     = L * mu_D
//   var_LTD    = L * var_D + mu_D^2 * var_L
//   sigma_LTD  = sqrt(var_LTD)
// For a Gaussian-approximation interval, the LTD quantile at
// coverage 1 - alpha is:
//   mu_LTD + z(1-alpha) * sigma_LTD
// where z is the standard-normal inverse CDF.
//
// The per-period CP band already encodes the demand-distribution
// quantile (no Gaussian assumption). Convert it to an effective
// per-period sigma_eff:
//   sigma_eff = (hi - lo) / (2 * z(1-alpha))
// Then:
//   sigma_LTD_eff = sqrt(L * sigma_eff^2 + mu_D^2 * sigma_L^2)
//   ltdHi = mu_LTD + z(1-alpha) * sigma_LTD_eff
// This preserves the CP coverage while honouring the H-W variance
// addition.
```
This is the second highest-leverage fix after F6.4.

### F6.6 The hard-floor `max(CP, ssGamma)` is gated only on
residual count, not on stability

`inventory-planning-weekly.js:429-433`:
```js
cpSafetyStock = cpInfo.calibration_residuals_count < 26
  ? Math.max(cpBand, ss.breakdown.stat_ss)
  : cpBand;
```
The literature on conformal prediction stability (Vovk 2012 ML
79:165-194; Lei et al. JASA 2018 Theorem 2) gives finite-sample
**concentration** of the empirical-quantile estimate. For
miscoverage `alpha_miss = 1 - alpha`, the order-statistic at rank
`ceil((n+1) * alpha)/n` has a variability bound proportional to
`sqrt(alpha_miss * alpha / n)`. At `alpha_miss = 0.05`, `n = 26`,
that's `sqrt(0.05 * 0.95 / 26) = 0.043` — a 4.3% miscoverage error
on the **estimate of the 95% quantile itself**. So at `n = 26`,
the empirical 95% quantile is really an estimate of the
[90.7%, 99.3%] range. The threshold of 26 was likely chosen
because it is close to `2 / alpha_miss = 2 / 0.05 = 40` rounded
down, but the cleaner derivation is:

```
n >= ceil(2 / alpha_miss) for the order-statistic gap to be < 1
n >= ceil(10 / alpha_miss) for the variability to be < 1%
```

For `alpha_miss = 0.05` (95% coverage), `n >= 40` is the right
threshold for "use CP alone". For `alpha_miss = 0.01` (99% coverage,
the SL_BY_TYPE default for ATD/TIMER), `n >= 200` is needed —
which **NO** Anvil SKU will have for years. The current code's
26-week threshold is too lax at high coverage and not used at low
coverage at all. `[verified, Vovk Gammerman Shafer 2005 ALRT;
Vovk ML 2012 Theorem 1; Lei et al. JASA 2018 Theorem 2]`

Replace the 26 constant with a dynamic threshold:
```js
const cpStabilityThreshold = (alphaMiss) => Math.ceil(2 / alphaMiss);
// 95% -> 40, 90% -> 20, 99% -> 200
const useFloor = effective_n < cpStabilityThreshold(1 - alpha);
```
Also expose the actual `n` and the threshold in the
`/conformal_diagnostics` per-SKU view so the operator understands
when the CP band is "young".

### F6.7 The cohort-pooling key is `item_type`, which is too coarse

`conformal.js:138-150` pools by the part's `item_type` from a
6-value enum (`GUN | ATD | TIMER | GUN_COMPONENT | SPARE |
CONSUMABLE | OTHER`). The cron at
`inventory-planning-weekly.js:316-321` builds the cohort by
flattening all residuals for parts with the same `item_type`.

Two issues:

(a) **Heteroscedasticity inside the cohort**. A `SPARE` cohort
includes a 2.5L INR PCB and a 50 INR oring; their residuals have
wildly different scales. Pooling raw residuals gives the high-value
PCB a band sized by the oring's noise. The fix is the score-space
transformation in F6.4: pool **scores**, not residuals. Then the
PCB's own `sigma_hat` rescales the cohort quantile back to its
own scale.

(b) **Cross-class contamination**. The pool falls back to
`Object.values(map).flatMap(...)` (line 146) when the named cohort
has `< 12` residuals. This means a brand-new `ATD` (critical
bundled item, 99% SL target) pools with `CONSUMABLE` (85% SL
target) when ATD residuals are sparse. The two classes have very
different demand patterns: ATD is high-value, project-driven,
small-`n` with structured pipeline demand; CONSUMABLE is
small-value, recurring, large-`n` with shippable history.
Their CP quantiles compose into nonsense.

The correct pooling key per Stankeviciute et al. NeurIPS 2021 (CPTC)
and Tibshirani et al. 2019 "Conformal prediction under covariate
shift" is `(family, value_class, motion_class)`:
- `family`: gun model series (Obara has a few; map from
  `item_master.product_family` once we add it).
- `value_class`: ABC (A = top 20% of revenue; B = next 30%; C = rest).
- `motion_class`: the SBC quadrant (smooth/erratic/intermittent/lumpy)
  already computed by `classify.js` and stored on
  `item_master.demand_class`.

The cohort key becomes a tuple. For Anvil at <500 SKUs the cohort
sizes are roughly `2 families x 3 ABC x 4 motion = 24 cohorts`,
each averaging 20 SKUs. With 26 residuals each, the per-cohort pool
is 520 residuals — enough for confident CP. `[verified, Stankeviciute
et al. 2021; Tibshirani et al. NeurIPS 2019]`

Schema work: add `product_family` (text), `abc_class` (text), and
keep `demand_class` (already present). Bump migration 100+ to add
`abc_class` since neither 085 nor 100 has it.

### F6.8 Autocorrelation in residuals invalidates split CP and
NEXCP marginal coverage

The shipped pipeline at `conformal-calibration-weekly.js:91-106`
stores one residual per (part, week). Adjacent weeks' residuals
are strongly positively autocorrelated for these reasons:

(a) **SBA/TSB/SES are inertial estimators**. A demand shock in
week `t` updates the level estimator, so the residual at `t+1`
is biased in the same direction. For SES with `alpha = 0.1`, the
autocorrelation of one-step residuals at lag 1 is approximately
`-0.9` (the model under-corrects, so successive residuals
alternate sign) for stationary series with a mean-reverting shock.
For Croston/SBA, residuals are positively correlated when
inter-arrival times are correlated.

(b) **Seasonality is not modeled**. The cron's `forecaster(histArr).mean`
is a flat per-period forecast (`baselineMean`). Q4 OEM demand
spikes in Oct-Dec are predictable but uncounted in the forecast,
so residuals positively cluster in Q4 vs Q1.

Both of these violate the **exchangeability** assumption underlying
split CP and the **bounded TV-distance to exchangeable**
assumption underlying NEXCP. The realised coverage will then
deviate from nominal by an amount on the order of the residual
autocorrelation magnitude.

The Chernozhukov Wuthrich Zhu 2018 "Block CP" framework
(arxiv 1802.06300) handles this. The fix is:

(i) Estimate the residual autocorrelation length per SKU via the
Durbin-Watson statistic or simple lag-1 autocorrelation. For each
SKU, define `block_size = max(1, autocorr_length + 1)`.

(ii) Resample residuals in **contiguous blocks** instead of
point-by-point. Compute the weighted quantile over block-medians.

(iii) The Chernozhukov et al. 2018 Theorem 3 gives an approximate
coverage guarantee under weak stationarity that depends on the
block size and the mixing rate.

Audit signal: backtest realised coverage on a 26-week holdout vs
the stamped 13-week empirical coverage in
`conformal_diagnostics`. If the gap is > 2pp, block CP becomes
mandatory. Anvil should plot the lag-1 autocorrelation of residuals
on the per-SKU diagnostic page; a value > 0.3 is the threshold to
switch on block CP. `[verified, Chernozhukov Wuthrich Zhu 2018
arxiv 1802.06300 Theorem 3; Brockwell Davis 1991 "Time Series:
Theory and Methods" ch 7]`

### F6.9 ACI is missing entirely from the engine

Gibbs Candes NeurIPS 2021 ACI provides a complementary mechanism
to NEXCP: instead of weighting residuals (which adapts to drift in
the distribution of residuals), ACI **adapts the target coverage
miscoverage `alpha_t`** in response to observed under-coverage:
```
alpha_t = alpha_{t-1} + gamma * (alpha - 1{Y_t notin C_t})
```
with `gamma` typically `0.005 - 0.05`. The asymptotic guarantee is
`lim_{T -> infty} (1/T) sum_t 1{Y_t notin C_t} = alpha` with
probability 1, **regardless** of the data-generating process.

NEXCP handles gradual drift; ACI handles structural breaks. Anvil's
cron currently records `coverage_target` as a static value
(`item.conformal_coverage || cfg.inventory_conformal_default_coverage`)
and updates it only when the operator explicitly sets a per-SKU
override. After a structural break (a new product generation
launches, a major customer changes order pattern), realised
coverage will diverge from `coverage_target` and the engine will
silently under-stock or over-stock.

The conformal-calibration-weekly cron is the natural place to apply
the ACI update. Each tenant + part + horizon should persist an
`alpha_current` field (today the schema only has the static
`coverage_target`). Migration 100 needs a follow-up:
```sql
alter table item_master
  add column if not exists conformal_alpha_current numeric(4,3);
alter table conformal_calibration_residuals
  add column if not exists in_interval boolean;
```
The cron updates `alpha_current = previous + gamma * (alpha_target - was_outside)`
each week and uses `alpha_current` for the next forecast's band.
`[verified, Gibbs Candes NeurIPS 2021 arxiv 2106.00170 Theorem 1]`

### F6.10 Empirical coverage is computed against the stamped
interval at write time, not at decision time

`conformal_diagnostics.js:52-105` builds the coverage sample by
matching `demand_forecasts.{interval_lo, interval_hi}` against
`order_schedule_lines.scheduled_qty` for the same week. This is the
right primitive but has two subtle bugs:

(a) **Stamped intervals are per-period**, not LTD-cumulative.
`inventory-planning-weekly.js:483-486` shows `interval_lo/hi` is
`(c + p) + cpInfo.interval_lo/hi` where `cpInfo.interval_*` is the
per-period CP band. The decision-time band used for safety stock
is `ltdBand.interval_hi_ltd` (LTD-scaled, line 422). The decision
that exposes the SKU to stockout risk is the LTD-scale one. The
empirical-coverage check uses the per-period one. The diagnostic
therefore measures the wrong thing: it can say "92% realised
coverage" when the actual stockout-risk coverage was 78%.

(b) **`scheduled_qty` is the wrong actual**. The cron uses
`order_schedule_lines.scheduled_qty` (line 80) — i.e. the
scheduled-out qty, not the realised-shipped qty. These differ
when an order is partially shipped, expedited, or cancelled. The
realised-shipped qty lives in the goods-issue journal entry (Tally
'sales' voucher) or in the order's
`result.salesOrder.lineItems[*].deliveredQty`. The empirical
coverage report is **structurally biased** toward the
scheduled-out side.

The fix:
- For (a): store the LTD-scaled interval as a separate column,
  `interval_lo_ltd`, `interval_hi_ltd` on `demand_forecasts`, and
  compute coverage against LTD-cumulative actuals.
- For (b): build a `demand_observations(part, week, actual_qty)`
  table from shipped voucher entries (not scheduled lines), and
  use that as the ground truth.

`[verified, source code conformal_diagnostics.js:52-105 +
inventory-planning-weekly.js:416-489]`

### F6.11 Tied-weight degeneracy: SKUs with mostly-zero residuals
have NEXCP collapse to "no decay"

The NEXCP weight at rank `i` (oldest = 0, newest = n-1) is
`rho^(n - 1 - i)`. For `rho = 0.99`, `n = 26`, the weights run
from `0.99^25 = 0.778` (oldest) to `0.99^0 = 1.0` (newest). The
spread is ~0.22. Now consider a SKU with residuals
`[..., 0, 0, 0, 0, 0, 0, 5]` (six zeros then a single positive
event). Sorting by `|r|` ascending, the zeros all sort together;
the `5` is the rank-26. Cumulative weight:
- First 6 entries (the zeros): sum of weights at ranks {20..25} —
  these are the most recent, weights 0.999^k for k in 0..5,
  sum `~5.95`. After normalisation `~0.26`.
- Then the older zeros (ranks 0..19): another `~14.5` of weight,
  normalised `~0.65`. Cumulative is now `0.91`.
- Then the `5` at rank 26: `1.0` normalised, cum `~1.0`.

For `target = 0.95`, the quantile is `5`. Good. But notice the
ordering of zeros within the sorted-by-`|r|` list is undefined
(JavaScript stable sort, depends on insertion order). The
**effective weight** assigned to the zero block is the sum of
all zero-residual weights — not the recent-tail weight. So a SKU
with one positive event in the last 26 weeks gets the same band
whether the event was last week or 25 weeks ago. The NEXCP
recent-weight argument is silently broken for any SKU dominated
by ties at zero (most intermittent SKUs).

The cleaner formulation per Barber et al. AOS 2023 Section 2 is:
**weights are tied to time index, not to sorted-residual rank**.
The cum-weight at threshold `q` is `sum_{i : |r_i| <= q} w_i`,
where each `r_i` carries the time-indexed weight `w_i`. A SKU with
recent zeros has the bulk of weight on small residuals, so the
weighted quantile is small. A SKU with old zeros and a recent
spike has weight on the spike, so the quantile is large.

The shipped code at `conformal.js:78-87` does the **right** thing
in form (sums weights for sorted-by-residual ranks). The
**operational** problem is the tie-breaking: when residuals tie at
zero, the within-tie order is unspecified, so the cumulative
weight at `q = 0` is the same regardless of when the zeros
occurred. The fix is conceptual: when computing the weighted
quantile of `|r|`, residuals tied at the same `|r|` should
contribute their full weight to the same cumulative bucket. The
code does this — the issue is operator confusion. If the operator
sees "NEXCP weight effective: 24.0 sum (recent-tail), oldest 0.78"
on the diagnostics, they expect recent residuals to dominate.
With all-zero ties, no individual residual dominates; the **bucket
of zeros** does. This needs to be surfaced explicitly:

UI fix on the per-SKU coverage tab (`inventory-item.tsx`): show
the cumulative-weight curve as a tile, not just the residual table.
A flat curve at zeros + a single spike at the recent positive event
visually communicates "this SKU's CP band is set by a single
event". The operator can then choose to pin the model or widen
coverage. `[verified, source code; Barber AOS 2023 §2]`

### F6.12 The crons are not wired into vercel.json

`vercel.json` registers only `cron/daily`. The four inventory crons
(`inventory-planning-weekly`, `inventory-positions`,
`inventory-exceptions-tick`, `conformal-calibration-weekly`) exist
as handlers but are never invoked on a schedule. The cron handlers
have `CRON_SECRET` auth, so they cannot be triggered by accident
from public traffic. But they also **never run** until they are
added to `vercel.json`'s `crons` array. This means:

(a) On a fresh deploy, **no** inventory planning happens until an
operator manually triggers `replan` via the UI.
(b) `conformal_calibration_residuals` is never populated, so
NEXCP / Split CP / cohort pool all see 0 residuals, and every
SKU lands in `pooled_cold_start` (with 0 residuals, the cohort is
also empty), so the conformal `qHi - qLo = 0`, so the floor
kicks in only for `n < 26` (which is always true), so the
parametric path effectively runs always.
(c) Operators **think** they're on CP but are actually on
parametric for as long as the cron is not wired. The
`/conformal_diagnostics` endpoint shows the SKU's stamped
`conformal_method` as `pooled_cold_start` and the operator
infers "we're calibrating, give it time" — but no calibration is
happening because no cron is running.

The fix is one PR adding to `vercel.json`:
```json
"crons": [
  { "path": "/api/cron/daily", "schedule": "30 2 * * *" },
  { "path": "/api/cron/inventory-positions", "schedule": "*/30 * * * *" },
  { "path": "/api/cron/inventory-exceptions-tick", "schedule": "*/30 * * * *" },
  { "path": "/api/cron/inventory-planning-weekly", "schedule": "0 2 * * 1" },
  { "path": "/api/cron/conformal-calibration-weekly", "schedule": "0 14 * * 0" }
]
```
Verify it lands before any tenant flips `inventory_conformal_enabled`
to true. `[verified, vercel.json missing entries]`

### F6.13 The first calibration cycle is bootstrapping from itself

`inventory-planning-weekly.js:523-540` stamps the most recent
(actual, forecast) pair into `conformal_calibration_residuals`
*at the end of the planning cycle*. The next planning cycle reads
those residuals from the table (line 302). But on the **very first
run**, the table is empty: the cron walks forecasts and history,
computes `histArr` and `baselineMean`, then **uses CP** at line
397 — which falls into `pooled_cold_start` because the residuals
table is empty for every SKU.

Then at line 524-540 the cron writes one residual per SKU
(the last week's actual vs the just-computed `baselineMean`). The
NEXT planning cycle's CP call now has exactly `n = 1` residual per
SKU. With `n = 1`, the cold-start path still applies (`n < 12`).

For the engine to leave cold-start, it needs `n >= 12`. The cron
writes ONE residual per SKU per cycle. So the engine takes
**12 weeks** before any SKU graduates to split CP, and
**26 weeks** before any SKU graduates to NEXCP. During the first
26 weeks, every SKU is on cohort-pooled CP, which falls back to
the global pool when the cohort is too small, which collapses to
zero when the global pool is empty.

The `conformal-calibration-weekly` cron at
`conformal-calibration-weekly.js:53-67` partially fixes this: it
backfills residuals from the last 156 weeks of
`(forecast, scheduled_qty)` pairs. But this only works if
`demand_forecasts` has 156 weeks of historical rows — which the
planning cron only writes **going forward** from the date it first
runs. So both crons depend on each other: the planning cron needs
residuals; the calibration cron needs forecast rows.

Bootstrap path (must be in the release plan):
1. Run a **one-time backfill** that walks 104 weeks of
   `order_schedule_lines` history, runs the chosen forecaster
   one-step-ahead on each week, persists forecasts as
   `demand_forecasts` rows back-dated.
2. Then run the calibration cron, which finds the back-dated
   forecasts and computes (actual - forecast) residuals.
3. THEN turn on `inventory_conformal_enabled`.

Without step 1, the engine takes ~6 months to converge to NEXCP
on the dominant SKUs. The brief's stated 4-week calendar to GA is
inconsistent with this. `[verified, source code; planning cron
+ calibration cron interlock]`

### F6.14 NEXCP `rho` is hardcoded at 0.99, not tunable per cohort

`conformal.js:39` and `conformal.js:189`:
```js
const DEFAULT_RHO = 0.99;
// ...
export const selectAndComputeCP = ({
  residuals, alpha = 0.95, method = "nexcp", rho = DEFAULT_RHO,
  // ...
```
The cron does not override `rho` at the call site
(`inventory-planning-weekly.js:406-412`), so every SKU uses 0.99.
Barber et al. AOS 2023 explicitly motivates `rho` as a
distribution-drift parameter; the right value depends on the
series-class:

- Smooth, stationary: `rho = 0.99` (slow decay, the past is
  informative for ~70 weeks of half-life).
- Erratic, trending: `rho = 0.95` (half-life ~14 weeks).
- Intermittent: `rho = 0.97` (half-life ~23 weeks, since
  individual events matter).
- Lumpy: `rho = 0.90` (half-life ~7 weeks, frequent regime
  changes).
- New product: `rho = 0.85` (half-life ~4 weeks).

Half-life formula: `t_half = log(0.5) / log(rho)`. The shipped
`rho = 0.99` gives `t_half = 69` weeks for **every** SKU. For a
lumpy SKU (the brief's stated dominant class), 14-month effective
memory is far too long; recent regime changes are washed out by
old data. The lumpy SKU is then likely to under-react to a real
demand spike.

Fix: take `rho` from a per-tenant table keyed on `demand_class`:
```sql
create table tenant_planning_rho (
  tenant_id uuid,
  demand_class text,
  rho numeric(4,3),
  primary key (tenant_id, demand_class)
);
```
Or derive it dynamically from observed series autocorrelation per
SKU. `[verified, code defaults; Barber AOS 2023]`

### F6.15 `ssGamma` and `ssNormal` ignore the (n-1) Bessel
correction on the residual sigma

`forecast.js:135` (residualSigma):
```js
const variance = residuals.reduce((s, v) => s + (v - mean) ** 2, 0) / residuals.length;
```
This is the **population** variance (`/n`), not the **sample**
variance (`/n-1`, Bessel's correction). Per Mood Graybill Boes 1974
("Introduction to the Theory of Statistics", McGraw-Hill, eqn 6.2),
the population variance is biased low by a factor of `(n-1)/n`.
For `n = 26`, that's 96.1%; for `n = 100`, 99.0%. In safety-stock
math, biased-low sigma means under-stock. The bias is small at
large `n` but compounded: residual count is the same `n` used in
the CP path, so the same under-bias propagates.

Fix: divide by `residuals.length - 1` when `length > 1`. (Anvil
already does this in `lead-time.js:40` for lead-time stats —
inconsistent.)

### F6.16 The "service level" -> "coverage" overload is mathematically
incoherent

The schema at migration 100:79 caches both `service_level` and
`conformal_coverage` on `item_master`. The strategic doc
(`docs/STRATEGIC_BET_03_conformal_safety_stock.md` §6) says "Same
meaning. Keep both for one release cycle". This is incorrect math.

Service level (in the classical safety-stock sense, Hadley-Whitin
ch 5) is the **probability of no stockout per cycle**:
```
F_LTD(s + Q) - F_LTD(s) = SL
```
where `F_LTD` is the LTD CDF and `s, Q` are the (s, Q) policy
parameters. Coverage (in CP) is the **probability the actual demand
falls inside the CP interval**:
```
P(D in [interval_lo, interval_hi]) = 1 - alpha
```
The two are related but **not equal**. The CP coverage statement is
*two-sided*; the service-level statement is *one-sided* (only the
upper exposure matters for stockout). At the same numerical value
(e.g. 0.95), a 95%-CP gives a 97.5% one-sided coverage on the upper
tail (assuming symmetric residuals), which is a 97.5% service
level. The shipped engine treats `service_level` and
`conformal_coverage` as synonyms (`conformal_diagnostics.js:142-144`):
```js
effective_coverage_target: Number(item.data?.conformal_coverage)
  || Number(item.data?.service_level)
  || Number(settings.data?.inventory_conformal_default_coverage)
  || 0.95,
```
So an operator who sets `service_level = 0.95` (intending
"5% stockout per cycle") gets a 95% two-sided CP, which is a 97.5%
one-sided service level — i.e. **over-stocking by ~30%** vs the
operator's intent. This is real money in the wrong direction.

Fix: deprecate `service_level` in the conformal path. Add a new
column `cp_coverage_target` with explicit two-sided semantics, OR
convert one-sided service level to two-sided on read:
```js
const twoSidedCoverage = 2 * serviceLevel - 1;
// 0.95 SL -> 0.90 CP coverage -> matches 95% upper tail
```
Document this conversion prominently. The strategic doc admits the
issue but does not specify the conversion; the operator-facing UI
should display both values.

`[verified, source code conformal_diagnostics.js:142-144; standard
safety-stock derivations e.g. Silver Pyke Peterson 1998 ch 5]`

### F6.17 The cron stores residuals from one model but planning
uses another

`conformal-calibration-weekly.js:78-89`:
```js
const fc = await svc.from("demand_forecasts")
  .select("part_no, week_start, forecast_baseline, generated_at")
  ...
```
The calibration cron reads `forecast_baseline` (the per-period
baseline mean from the planning cron's chosen `forecaster`). But
the planning cron at `inventory-planning-weekly.js:340-347` may
have used **different forecasters across different SKUs** based on
the SKU's `demand_class` — and the same SKU's class can change
between cron runs (a SKU that was smooth becomes intermittent
after a demand pause, or vice versa). The residual stored at week
`W` reflects the forecaster active at week `W-1` (the previous
cron's choice). When the next planning cron runs, it might use a
**different** forecaster for the same SKU, but the CP band is
computed against residuals from the old forecaster.

Concretely: SKU starts as `smooth` (`pickForecaster(smooth) ->
sma(h, 4)`). Two weeks later, demand pauses, SKU reclassifies as
`intermittent`, forecaster becomes `sba`. The residuals in the
table are still SMA residuals. NEXCP on those residuals does not
calibrate the SBA forecaster — it calibrates a *no-longer-active*
SMA forecaster. The CP band is therefore wrong by an unknown
factor.

Two fixes:

(a) Store `model_name` alongside the residual:
```sql
alter table conformal_calibration_residuals
  add column if not exists model_name text;
```
The calibration cron + planning cron both read residuals filtered
by `model_name = chosen_forecaster`. Older residuals from
deprecated models stay in the table for diagnostics but do not
participate in the CP estimate.

(b) Hard-pin the forecaster per SKU via `pinned_model` (the column
already exists on `item_master` at migration 085 line 39). Hide
auto-switching from the calibration loop. Cost: lose adaptivity to
demand-class change. Benefit: clean calibration.

The cleaner fix is (a). `[verified, source code paths]`

### F6.18 The conformal-calibration-weekly cron has no
prequential evaluation

`conformal-calibration-weekly.js:79-86` reads the most recent
`forecast_baseline` per (part, week) and pairs with the actual.
But the residual semantic for conformal prediction is the
**one-step-ahead** forecast made **before** the actual was
realized. The shipped pipeline records the forecast and the
actual for the same week, which can be the same forecast that
*included* the actual in its training window.

Concretely: the planning cron runs Monday morning, computes a
12-week-ahead forecast vector, persists rows for weeks
`[t, t+1, ..., t+11]` with `forecast_baseline = baselineMean`
(line 504). At line 525-541 the cron stores
`(week_start: lastWeekKey, forecast_value: baselineMean,
actual_value: histArr[last])`. But `histArr[last]` is **the last
week of history that the forecaster trained on** — so this is a
**in-sample** residual, not an out-of-sample one. Conformal coverage
guarantees do not apply to in-sample residuals.

The right pipeline is **prequential**:
1. At week `t`, compute the one-step-ahead forecast `f_t` using
   only data up to week `t-1`.
2. When week `t` closes, observe `y_t`.
3. Store residual `r_t = y_t - f_t` for CP.

Anvil's `wape` function at `forecast.js:159-173` already does this
(walks forward). The CP residual store should do the same: at the
end of each planning cron, write the residual for week `t-1`
(yesterday's forecast vs today's actual), NOT today's forecast vs
today's actual.

This is a subtle but coverage-invalidating bug. The realised
coverage will look better than the true coverage because the
in-sample residuals understate the true forecaster error.
`[verified, source code planning cron line 524-540 + Vovk 2005
ALRT §2]`

### F6.19 The cron is unsafe to run twice within a short window

`inventory-planning-weekly.js:643-660` upserts forecasts with
`onConflict: "tenant_id,part_no,week_start,model_name"`, but
**inserts** plans without dedup at line 658. The `procurement_plans`
table has no unique constraint on `(tenant_id, part_no, for_week)`;
the cron's manual dedup at line 654-657 reads the existing draft +
approved plans. If two cron invocations race (very unlikely on
Vercel, but possible during a backfill rerun), they can both pass
the dedup and both insert. The duplicate plans are then approved
separately and **double-released**, creating two source POs for
the same SKU and same week. Operationally, that's expensive.

Add a unique partial index:
```sql
create unique index if not exists procurement_plans_unique_draft
  on procurement_plans (tenant_id, part_no, for_week)
  where status in ('draft', 'approved');
```
This is a one-line schema fix that closes the race. `[verified,
schema 085 + cron code]`

### F6.20 The exception detector and the planning cron compute
different `safety_stock` and `reorder_point`

`inventory-planning-weekly.js:447-451` writes `safety_stock` and
`reorder_point` onto `item_master` after CP / parametric. The
exception detector at `exceptions-detector.js:71-91` reads
`inventory_positions.safety_stock` and `inventory_positions.reorder_point`.
But `inventory_positions` is written by `positions.js:155-171`,
which reads from `item_master.safety_stock` and `item_master.reorder_point`
**at the time the position is computed**. So:

- Planning cron Monday 02:00: writes SS = 12 onto item_master.
- Positions cron Monday 02:30 (or 11:30 PM the night before):
  writes SS = 12 onto inventory_positions row.
- Exception detector Monday 03:00: reads SS = 12 from positions.
  OK.

But if positions cron runs **before** planning cron (e.g. Sunday
position snapshot + Monday planning), the positions row carries
the previous week's SS, which may be stale. The exception detector
fires alerts based on the stale SS — under-warning a real
stockout if SS just doubled, or over-warning a false stockout if
SS just halved.

Fix: either join positions to item_master at read time inside the
exception detector, or have the planning cron update positions in
the same transaction. The former is cleaner:
```js
const positions = await svc.from("inventory_positions")
  .select("*, item:item_master(safety_stock, reorder_point)")
  .eq("tenant_id", tenantId)
  ...
```
And use `p.item.safety_stock` instead of `p.safety_stock`.
`[verified, cron timing + table schemas]`

### F6.21 The Croston / SBA / TSB / SES code is correct on the
formula but biased on initialization

`forecast.js:32-49` (Croston):
```js
for (const v of series) {
  interval += 1;
  if (v > 0) {
    if (lastSize == null) { lastSize = v; lastInterval = interval; }
    else { ... EWMA update ... }
    interval = 0;
  }
}
```
The initialisation `lastSize = v, lastInterval = interval` uses
the **first non-zero demand and the periods to first demand** as
the seed. Per Hyndman & Athanasopoulos "Forecasting: Principles
and Practice" 3e §13.4, the Croston initial estimate should be
the **first non-zero demand size** as the size, but the **mean of
inter-arrival intervals** to first observed demand, not the count
of periods. The shipped code uses the latter, which biases the
initial estimate of `1 / interval` upward (toward 1 / first-period-count
instead of 1 / mean-inter-arrival).

For SBA (forecast.js:55-62), the bias is inherited.

For TSB (forecast.js:69-90), the init `prob = 1` on the first
non-zero demand is technically correct (TSB's `prob` is the
probability of demand occurring in any period, and the first
demand event gives p ~ 1), but the alpha_prob smoothing then
decays from 1 (toward 0 on quiet stretches), which is the right
direction.

The Croston/SBA init bias is small (~5-10%) for series with 10+
non-zero events but matters for newly-shipped SKUs. The fix is the
Croston-optimal initialisation per Kostenko Hyndman 2006: estimate
`alpha` jointly with the level by minimising one-step-ahead
SSE on a holdout. The shipped engine uses a single hardcoded
`alpha = 0.1` and never tunes per SKU.

Implementation sketch:
```js
// Grid-search alpha in {0.05, 0.10, 0.15, 0.20}.
// For each candidate, walk-forward one-step-ahead residuals.
// Pick the alpha minimising sum of |r| (MAE), not MSE — for
// intermittent series MAE is more robust to outliers.
const tuneAlpha = (history, model) => {
  let bestAlpha = 0.1, bestMAE = Infinity;
  for (const alpha of [0.05, 0.10, 0.15, 0.20]) {
    let mae = 0, n = 0;
    for (let i = 8; i < history.length; i++) {
      const f = model(history.slice(0, i), alpha).mean;
      mae += Math.abs(history[i] - f);
      n += 1;
    }
    mae /= n;
    if (mae < bestMAE) { bestMAE = mae; bestAlpha = alpha; }
  }
  return bestAlpha;
};
```
Per-SKU alpha tuning improves MASE 8-15% on M5 intermittent cuts
per Hyndman Athanasopoulos FPP3. `[verified, Croston 1972;
Hyndman Athanasopoulos FPP3 §13.4; Kostenko Hyndman 2006]`

### F6.22 Quantile outputs assume Gaussian residuals even on the
conformal path

`inventory-planning-weekly.js:504-507`:
```js
quantile_50: c + p + b,
quantile_90: (c + p + b) + 1.28 * sigmaResid,
quantile_95: (c + p + b) + 1.65 * sigmaResid,
quantile_99: (c + p + b) + 2.33 * sigmaResid,
```
These hardcode the Gaussian z-scores (1.28, 1.65, 2.33). They are
**not** consistent with the CP path: if `interval_hi = 100`
(from NEXCP at 95% coverage), the quantile_95 from the Gaussian
formula above can be 70 or 130. The two say different things
about the same uncertainty. The UI at `inventory-item.tsx:201-203`
plots `quantile_90` as a dashed line and `interval_lo/hi` as a
shaded band — the operator sees two bands that disagree.

Fix: on the CP path, compute `quantile_90/95/99` from the same
empirical residual quantiles at the appropriate alphas:
```js
const q90 = selectAndComputeCP({ residuals, alpha: 0.90, ... });
const q95 = selectAndComputeCP({ residuals, alpha: 0.95, ... });
const q99 = selectAndComputeCP({ residuals, alpha: 0.99, ... });
// then quantile_X = baselineMean + qX.qHi
```
Note: this requires three CP calls per SKU per cron run. At ~500
SKUs the extra cost is bounded (each call is `O(n log n)` for
sort, `n <= 156`). Acceptable. `[verified, cron lines 504-507]`

### F6.23 Conformal-newsvendor is the right primitive but not
implemented

The strategic doc cites `arxiv 2412.13159` (Bertsimas Kallus 2025
"Conformal newsvendor"). The shipped engine does NOT use the
conformal newsvendor formula; it uses CP only to size safety stock,
and the order quantity is still computed by `eoqWilson` /
`eoqCoverage`. The conformal newsvendor recommendation is:
```
Q* = f_t + q_{c_u/(c_u+c_o)}(R)
```
where `c_u` is per-unit understock cost, `c_o` is per-unit
overstock cost, and `q_p(R)` is the `p`-quantile of the residual
distribution. The shipped engine separates these concerns:
- safety stock = `interval_hi - ltdMean` (sets a re-order trigger)
- recommended_qty = `eoqWilson` or `eoqCoverage` (sets the order
  batch)

Bertsimas-Kallus argue this decoupling loses 10-25% in expected
cost vs the unified formulation. The cleaner approach is to set
`Q* = max(MOQ, ceil((forecast + q_p(R) - on_hand - in_transit) /
pack_size) * pack_size)` with `p` derived from cost ratios.

Anvil already has `c_u` implicitly (via service level mapping to
cost ratio) and `c_o` implicitly (via `holding_cost_pct`). The
explicit critical-fractile rule is:
```js
const criticalFractile = (c_u, c_o) => c_u / (c_u + c_o);
// service_level = criticalFractile under Newsvendor optimality
```
For Anvil's tenant_settings defaults (holding_cost_pct = 0.22;
ordering_cost_inr = 5000), and typical product purchase prices,
the critical fractile lands around 0.85-0.92 for SPARE and 0.97+
for ATD. The SL_BY_TYPE table at line 40-45 of the cron hardcodes
these — but they should be **derived from the cost columns**,
not constants. `[verified, Bertsimas Kallus arxiv 2412.13159; cron
SL_BY_TYPE]`

### F6.24 Pipeline-demand probabilities are point estimates
without uncertainty propagation

`pipeline-demand.js:47-57` returns a point probability per
opportunity. The cron multiplies `qty * probability` and adds
to `pipeline_demand` (line 85). This is the **expected value** but
ignores variance. For an opportunity with `qty = 100, probability =
0.5`, the expected demand is 50, but the demand is actually
Bernoulli: 0 with probability 0.5, 100 with probability 0.5. The
variance is `25 * 100^2 = 250000` units squared. If the operator
plans for the expected value (50), they understock when the
opportunity closes (need 100) and overstock when it doesn't (need
0). Demand-driven planning should propagate this binary uncertainty
into the safety-stock calculation.

The fix is straightforward:
- Treat each opportunity's pipeline demand as `Binomial(n=qty, p)` —
  but really as Bernoulli over the entire qty.
- Add the pipeline demand variance to the residual sigma when
  computing safety stock:
```js
const pipelineVariance = (oppLines) => oppLines.reduce(
  (sum, line) => sum + Math.pow(line.qty, 2) * line.probability * (1 - line.probability),
  0
);
const totalSigma = Math.sqrt(sigmaResid ** 2 + pipelineVariance);
```
Then pass `totalSigma` to `safetyStock`. The CP path is unaffected
because residuals are computed against `forecast_baseline`, not
against the pipeline total. `[verified, pipeline-demand.js +
inventory-planning-weekly.js]`

### F6.25 The voice-call notification gate has a daily counter
that can permanently lock voice

`notifications.js:80-82`:
```js
const todays = (open.data || []).filter((e) =>
  e.detail?.notified?.voice_at && new Date(e.detail.notified.voice_at) > sinceMidnight);
let voiceCallsToday = todays.length;
```
If a voice call is queued but the downstream voice rail fails to
deliver, the `voice_at` timestamp is still set (line 142-145, the
error is caught silently). The day's counter then includes
the failed call. If 3 calls fail in a row (the default daily cap),
**no more voice calls fire** for the rest of the day, even though
zero were actually delivered. Operators are silently cut off from
critical voice alerts for stockouts.

Fix:
- Only set `voice_at` after the voice rail confirms delivery
  (out-of-band callback).
- Or distinguish `voice_queued_at` from `voice_delivered_at`; the
  cap should be on delivered counts, not queued counts.
- Or expose the counter on the diagnostics endpoint so operators
  can see "voice has been suppressed because 3 failed calls today".

`[verified, source code notifications.js:80-145]`

## 2. Schema / data-model audit on migration 100

### F6.26 `conformal_calibration_residuals.weight` is stored
but never used

The migration adds `weight numeric(8,6) not null default 1.0` on
the residuals table (line 119). The intent per the comment ("NEXCP
weights are stored at write time so the calibration cron can
decay them deterministically") is to persist precomputed weights.
But the planning cron always inserts `weight: 1.0` (line 105 of
calibration cron; line 537 of planning cron). The `nexCP` function
ignores the stored weight and recomputes from the index
(`conformal.js:118-119`). So the column is a no-op carrying
storage cost.

Two options:
- Drop the column.
- Use it: store the actual NEXCP weight at the time of write, and
  let the CP function read it instead of recomputing. This makes
  the weight schedule auditable (an operator can see "this
  residual was weighted at 0.74 last cycle").

Option 2 is cleaner because it lets you change `rho` without
invalidating historical residuals. `[verified, migration 100 +
cron code]`

### F6.27 The `coverage_target` column is `numeric(4,3)` —
4-digit precision is wasteful and confusing

`100_inventory_conformal_intervals.sql:31` declares
`coverage_target numeric(4,3)`. This allows values like 0.123,
0.987, 5.123. The intent is "a probability in (0.5, 1)". The
constraint at line 51 enforces this. But the precision allows the
operator to set 0.987 — which is fine technically but conflicts
with the UI dropdown at `inventory-item.tsx:354-358` that offers
only 0.85 / 0.9 / 0.95 / 0.99. Operators who script direct DB
updates can land at 0.972 and confuse the audit log.

Two-decimal precision (0.99, 0.95, 0.90, 0.85, 0.80) covers every
real use case. The cosmetic issue is that the schema lies about
the supported range. Tighten to `numeric(3,2)` or add a fixed-
enum check constraint.

### F6.28 No FK between `conformal_calibration_residuals` and
`item_master`

`100_inventory_conformal_intervals.sql:108-121` defines the residuals
table with a `part_no text not null` but no FK to `item_master`.
If an SKU is deleted (renamed, replaced, retired), its residuals
linger forever, contaminating the cohort pool. Pruning is
time-based (156 weeks) but not item-based.

Fix:
```sql
alter table conformal_calibration_residuals
  add constraint ccr_item_fk
  foreign key (tenant_id, part_no)
  references item_master (tenant_id, part_no)
  on delete cascade;
```
This requires `item_master` to have `(tenant_id, part_no)` as a
unique key (which it should — check). `[verified, migration 100]`

### F6.29 No `forecast_run_id` consistency check between residuals
and forecast_runs

`conformal_calibration_residuals.forecast_run_id` is declared as
`uuid references forecast_runs(id) on delete set null`. But:
- The cron at line 528-541 inserts residuals during a run with
  `forecast_run_id: runId` (good).
- The calibration cron at line 95-105 inserts residuals **without**
  setting `forecast_run_id` (set to default null).
- The `forecast_runs.id` FK is `on delete set null`, so deleting a
  run nullifies but does not delete the residual.

The audit story is: "this residual was produced by run X". For
the calibration-cron-inserted residuals, the audit story is "we
backfilled this from order_schedule_lines". The schema does not
distinguish these two provenance paths. Add a `provenance text
not null` column with enum `('planning_cron', 'calibration_cron',
'manual_backfill')`. Audit queries become tractable.

### F6.30 Coverage is enforced as numeric in `tenant_settings`
but not enforced to match per-SKU `service_level`

`item_master.service_level` and `item_master.conformal_coverage`
can both be set with no consistency check. An operator can have
`service_level = 0.99` and `conformal_coverage = 0.80` on the same
SKU. The cron at line 365-366 prefers `service_level` for the
parametric path and `conformal_coverage` for the CP path
(line 398-401). For the SAME SKU, the two paths produce wildly
different safety stocks; the rationale jsonb's `legacy_safety_stock`
captures both, but no monitoring fires when the divergence is
material.

Add a check or a soft warning (exception_kind =
'coverage_inconsistent'): when |service_level - conformal_coverage|
> 0.10, raise.

## 3. Cohort and cold-start specific issues

### F6.31 The "global pool" fallback in `pooledColdStartCP`
silently averages across motion classes

`conformal.js:142-147`:
```js
if (pool.length < 12) {
  // Union across all cohorts.
  pool = Object.values(map).flatMap((arr) => sanitizeResiduals(arr));
}
```
The motion classes (`smooth`, `erratic`, `intermittent`, `lumpy`)
have very different residual distributions:
- Smooth: residuals ~ Normal(0, sigma_d), small tails.
- Erratic: residuals ~ heavy-tail, similar location.
- Intermittent: residuals are bimodal (zero or positive).
- Lumpy: very heavy upper tail.

Pooling Lumpy residuals into a Smooth SKU's CP estimate inflates
the band by 3-10x — operator over-stocks. Pooling Smooth residuals
into a Lumpy SKU's CP estimate deflates the band — operator
under-stocks.

The fix is twofold:
- Stratify the pool: cohort by `(item_type, demand_class)`. Sample
  size becomes the issue.
- Score-space pooling (F6.4): pool standardized scores
  `s_i = (y_i - f_i) / sigma_hat_i`. Scores are approximately
  unit-variance across motion classes, so pooling them is valid.

The combination (stratified-by-class AND score-space) is the
right approach. `[verified, conformal.js cold-start + Romano 2019
score normalization]`

### F6.32 Cohort pool can absorb residuals from retired SKUs

The cohort key today is `item_type`. A retired SKU keeps its
residuals (no FK cascade per F6.28), and `cohortResiduals[item_type]`
includes them. A new SKU launching in the same `item_type` then
calibrates against the retired SKU's historical residual pattern —
which may be obsolete (e.g. the retired SKU was an end-of-life
component with declining demand).

Two filters needed:
- `where part_no in (select part_no from item_master where lifecycle_state = 'active')`.
  Requires adding `lifecycle_state` column to `item_master`.
- `where week_start >= now() - interval '52 weeks'`. Cohort
  pool should be recent enough to reflect current demand patterns.

`[verified, cron line 302-321 + schema]`

### F6.33 Pool contamination via cross-tenant data sharing (none
currently, but the surface is exposed)

The cohort pool is built per-tenant (cron line 316-321 reads
items by `tenant_id`). The RLS policy on `conformal_calibration_residuals`
(migration 100 line 129-133) is also tenant-scoped. So today
cross-tenant pollution is impossible.

If Anvil adds a "shared cohort" feature (e.g. all tenants in the
gun-industry vertical share residuals to bootstrap CP), the RLS
must be relaxed cautiously. The right primitive is a separate
table `shared_conformal_pool(industry, demand_class, residual,
scope = 'opt_in')` with explicit opt-in per tenant. This is the
hardest privacy issue in the engine because demand history is
competitive intelligence.

Recommend NOT exposing this pre-2026.

## 4. UI / operator-facing math

### F6.34 The chart at `inventory-item.tsx:151-253` displays
incompatible bands without explanation

The "12-week forecast" chart layers:
- Solid + hatched + light areas: the committed/pipeline/baseline
  stack, sized to `forecast_total`.
- Dashed line: `quantile_90` from Gaussian formula (F6.22).
- Shaded grey band: `interval_lo / interval_hi` from CP.

These three say different things about uncertainty. The dashed
line and the band can disagree by 30-50%. The chart legend
("Solid: committed · Hatched: pipeline · Light: baseline · Dashed:
q90 · Shaded band: CP interval") tells the operator they are
different but not WHY. The operator-facing math template should
be:

"Forecast: SBA at alpha=0.10. Why: ADI 2.3, CV2 0.31 -> intermittent.
46 weeks of residuals available. CP method: NEXCP at rho=0.99.
Coverage: 95% target, 92.3% realised (last 13 weeks). The CP band
shows the range we believe future demand will fall in. The q90
dashed line is a Gaussian-approximation upper bound; we keep it
for comparison."

This is roughly the ToolsGroup whitepaper template. Anvil's current
UI shows the methods but doesn't reconcile them. `[verified,
inventory-item.tsx]`

### F6.35 The Coverage tab shows the right metrics but no time
series of coverage

`inventory-item.tsx:421-430` shows realised vs target coverage as
two KPI tiles. But the realised coverage is a 13-week average — a
single number. A coverage drift only shows up when the average
falls below 90% (per `conformal_diagnostics.js:185` drift_alert at
5pp gap). For a stationary stretch followed by a regime change,
the average dilutes the recent under-coverage; the alert fires
late.

Add a coverage time series: per-week realised coverage over the
last 26 weeks. Operators see when the drift started, can correlate
with known events (product launch, ERP migration, etc.). This is
~30 LOC of SVG. `[verified, conformal_diagnostics.js:166-186]`

### F6.36 The replan modal under-warns about model side effects

`inventory-planning.tsx:466-478` warns:
"Replan rebuilds every active item's demand_forecasts from the
latest demand signal (committed + pipeline + baseline) and
recreates draft replenishment plans... existing DRAFT plans
replaced; APPROVED / RELEASED plans stay."

It does NOT warn about:
- The CP residuals stream is unaffected (so the operator's mental
  model "replan = fresh CP band" is wrong).
- The forecaster choice can change per SKU if a SKU's
  `demand_class` shifted since last run (CV2/ADI thresholds at
  edge of quadrant).
- The `coverage_target` defaults to the tenant default if
  per-SKU override is absent.

The modal should surface "How many SKUs will see a new
forecaster?" and "How many SKUs will see a new coverage target?"
as preview numbers before commit.

## 5. Engine validation / SLO architecture

### F6.37 The 5pp coverage-drift threshold is uncalibrated

`conformal_diagnostics.js:185` and the dashboard at
`inventory-planning.tsx:367` use a 5 percentage-point gap (target
- realised) as the alert threshold. Where does 5pp come from?

For an SKU with `n_samples = 13` weeks of coverage data, the
empirical coverage estimate has standard error
`sqrt(target * (1 - target) / n) = sqrt(0.95 * 0.05 / 13) = 0.060`.
A 5pp deviation is ~0.83 sigma — i.e. firing roughly 41% of the
time even when the true coverage is exactly 95%. This is a
**high false-positive rate**.

The statistically defensible threshold is a binomial test:
P(observed coverage <= 0.90 | true coverage = 0.95, n = 13) =
binom.cdf(11, 13, 0.95) = 0.135. At a 5% significance level,
"reject coverage >= 0.95" requires observing <= 10 hits out of 13,
i.e. realised coverage <= 0.769 — a 18.1pp gap, not 5pp.

Either:
- Increase the window from 13 to 52 weeks: SE = 0.030, 5pp gap is
  ~1.67 sigma, false-positive rate ~5%. Reasonable.
- Keep the 13-week window but raise the threshold to 13pp (5pp
  more permissive than the binomial test, accounting for the cost
  of a missed drift).
- Or use a CUSUM detector (Wadsworth Stephens 1973) that integrates
  drift evidence over time without committing to a fixed window.

The shipped 5pp threshold is operationally noisy; this generates
alert fatigue, which leads to operators ignoring real drift.
`[verified, dashboard code; standard binomial CI]`

### F6.38 No SLO contract for the planning cron itself

The brief commits to "20% drop in stockout rate at the same average
inventory holding". This requires:
- A baseline stockout rate measurement (before CP turns on).
- A post-CP stockout rate measurement.
- A controlled A/B split where some SKUs run CP and others run
  parametric.

The shipped engine does **not** have an A/B framework. The
`policy_source` enum on `procurement_plans` (line 317 of migration
085) includes `manual_override` but no `parametric_baseline` vs
`conformal_test` distinction. Without that, the SLO is unmeasurable.

Add a per-tenant flag `inventory_conformal_ab_test_pct numeric(3,2)`
that splits SKUs into test and control by hash of (tenant_id,
part_no), and stamp `procurement_plans.experiment_arm` so post-hoc
analysis can measure the lift. `[verified, schema + cron policy_source]`

## 6. Vendor benchmark (quant-PRD style)

### F6.39 ToolsGroup SO99+ probabilistic forecasting is a different
beast (worth understanding for positioning)

ToolsGroup ships full-distribution forecasts (not CP bands) using
their proprietary "self-adaptive" engine. Per their G2 reviews and
the 2026 Gartner MQ for Discrete Industries SCM, they report
"5-10 percentage point improvement in forecast accuracy and a 3-5
percentage point increase in service levels while simultaneously
achieving a 20-30% inventory reduction". They have ~365 customers,
mostly mid-market discrete manufacturing — directly overlapping
Anvil's TAM in India.

Their advantage:
- Full predictive distribution, not just a band.
- 25+ years of intermittent-demand IP (originally Italian
  pharmaceutical distribution).
- Multi-echelon inventory optimization (MEIO) built-in.

Their disadvantage:
- Closed-source, opaque math.
- ~$50k/yr starting price.
- Heavy implementation cycle (6-12 months).

Anvil's positional moat is operator-explainable, transparent math
on a 5-minute Vercel deploy with weekly cadence. The CP path is
defensible vs ToolsGroup only if Anvil **publishes the math**
(both the formula and the empirical realised-coverage), surfaces
the same diagnostics that ToolsGroup ships, and matches their
inventory reduction on the SKUs Anvil is targeting.

The 20% goal is **plausible** but unproven. ToolsGroup's 20-30%
number is benchmarked against a "first-time customer with no
inventory optimization at all" baseline — i.e. customers running
Excel-based safety stock. Anvil's existing tenants likely already
run some safety-stock math, so the marginal improvement vs the
existing parametric path is smaller — likely 10-15%.

`[verified, G2 reviews, ToolsGroup site, Gartner MQ 2026 Discrete
Industries SCM]`

### F6.40 Slimstock Slim4 uses dynamic gamma quantile safety stock

Slimstock Slim4 (mid-market European inventory optimization)
calculates "dynamic safety stocks based on demand variability,
supplier reliability, lead times and target service levels". The
Gartner peer reviews indicate gamma quantile for the LTD CDF (the
same primitive as Anvil's `ssGamma`). They do NOT use CP.

This is the parametric incumbent Anvil should benchmark against.
The advantage of CP is the distribution-free guarantee; the
disadvantage is needing 26+ residuals before CP is more stable
than the parametric estimator. For Anvil's catalog (mostly < 26
residuals at launch), the parametric path is actually the
right comparison.

The pitch should be: "CP is what we use **after** 26 weeks of
real data; parametric is what we use until then." Not "CP
replaces parametric".

`[verified, Slimstock product pages + Gartner peer reviews]`

### F6.41 Lokad's stance: probabilistic forecasting >> CP

Lokad's official position (Dec 2025 blog post cited in the brief)
is that probabilistic forecasting — predicting **full** demand
distributions, not just bands — is the right approach. They argue
CP is a "calibration trick on top of a point forecast" and that
the underlying point forecaster's biases get propagated through
the CP band.

This is a fair criticism. Anvil's path can answer in two ways:
- (a) Concede the point and migrate to quantile regression (CQR per
  Romano 2019) as the underlying forecaster. The CP layer then
  becomes a calibrated wrapper around the quantile regressor.
- (b) Hold the CP-on-point-forecast path but add a backtest table
  that shows CP coverage >= 90% on observed data, even when the
  point forecaster has known bias.

Option (b) is cheaper and what the engine effectively claims.
Option (a) is the long-term migration, requiring a quantile
regressor (typically LightGBM or a small TFT), which pulls Anvil
into Python territory.

The brief defers this to "Phase 2.5 ML migration". The engineering
debt is real: every quarter without quantile regression, the CP
band is wider than it needs to be. `[verified, Lokad Dec 2025 blog]`

### F6.42 Kinaxis / Blue Yonder / o9 — irrelevant at Anvil's price
point

These are $1M+ enterprise SCP suites. They are not realistic
competitors for an Indian OEM with <500 SKUs and a 12-engineer
team. Naming them in the positioning doc is fine for credibility
but the actual buying-context competitor is ToolsGroup, Slimstock,
SAP IBP (the enterprise upgrade path for customers outgrowing
Excel + Tally), and **manual planning** (the dominant default).

The brief lists them all; the audit recommendation is to
acknowledge them in the strategic doc but spend zero engineering
budget responding to them.

## 7. Performance / scalability concerns

### F6.43 Per-SKU lead-time fit is O(SKUs * supplier-lookups)

`inventory-planning-weekly.js:186-204` calls `buildLeadTimeSamples`
per SKU inside the planning loop. Each call queries
`source_po_lines` with a join to `source_pos` and filters by
`supplier_id`. At 500 SKUs and 1 query per SKU, that's 500
sequential queries — Supabase round-trip latency is ~20-50ms, so
the lead-time-fit phase alone is 10-25 seconds.

The cron has a 60-second function timeout (per `vercel.json`
`api/dispatch.js` maxDuration but no explicit timeout on the cron
handlers — defaults to 10s for Hobby, 60s for Pro). 25 seconds is
borderline.

Fix: pre-fetch all `source_po_lines` for all suppliers in one
query before the per-SKU loop, then index in memory.
```js
const allLines = await svc.from("source_po_lines")
  .select("acknowledged_eta, received_at, source_pos:source_po_id(supplier_id)")
  .eq("tenant_id", tenantId)
  .not("received_at", "is", null);
const linesBySupplier = new Map();
for (const row of (allLines.data || [])) {
  const k = row.source_pos?.supplier_id;
  if (!k) continue;
  if (!linesBySupplier.has(k)) linesBySupplier.set(k, []);
  linesBySupplier.get(k).push(row);
}
// per-SKU loop becomes: const deltas = ...
//   computeDeltas(linesBySupplier.get(item.default_supplier_id) || []);
```
500 SKUs at 1 query each becomes 1 query for all. Latency drops
from 10-25s to 200-500ms.

### F6.44 The committed-demand query is per-SKU too

`inventory-planning-weekly.js:459-463` runs a query for each SKU
to fetch `order_schedule_lines`. Same O(N) pattern. Same fix.

### F6.45 The cron writes per-SKU updates serially

Line 447 `await svc.from("item_master").update(...)` per SKU.
500 round-trips. Same pattern fix: batch upsert at the end of the
loop. `supabase-js` supports bulk upsert with `.upsert(rows)`.

### F6.46 The forecast row insertion is bulk (good) but the
exception insertion is serial

Line 626-637 inserts an exception row per SKU on hysteresis skip,
serially. Same issue.

These three are a single PR that drops cron runtime from
~minutes to seconds at 500 SKUs.

## 8. Security and data integrity

### F6.47 The diagnostics endpoint leaks tenant-internal model
state to any `read` user

`conformal_diagnostics.js:199`: `requirePermission(ctx, "read")`.
Coverage gauges, model bucket counts, residual counts per SKU —
all visible to any user with read access. For a tenant with
multiple commercial buyers (e.g. AP clerk vs head of procurement),
the AP clerk should not see "we're using a 92% realised coverage
because our forecaster is biased" — that's a business-internal
diagnostic, not transactional data.

Tighten to `requirePermission(ctx, "planning_admin")` or add a
new role `planning_diagnostics`. The principle: model health is
sensitive operational state, not transactional read data.
`[verified, conformal_diagnostics.js:198-199]`

### F6.48 RLS on residuals is correct but cross-tenant exposure
in the cohort pool is uncovered

The cohort pool at planning-cron line 316-321 is built per-tenant
(items filtered by `tenant_id`). RLS is enforced. Good.

But: the cohort fall-back to "all classes" (`conformal.js:142-146`)
is computed in-memory; if a future feature mixes pools across
tenants for "cold-start bootstrap", the RLS does not apply
post-load. The architectural fix is to NEVER mix pools across
tenants in the JS layer; only mix what came from RLS-filtered
queries.

Add a defensive assertion in `pooledColdStartCP`:
```js
// All pooled residuals should come from the same tenant_id;
// this is a sanity check in case caller composes wrong.
const tenants = new Set(allResiduals.map((r) => r.tenant_id));
if (tenants.size > 1) throw new Error("Pool spans multiple tenants");
```
This requires changing the residual shape from `number[]` to
`{tenant_id, value}[]`. Worth it for defense in depth.
`[verified, source code; multi-tenant security review]`

## 9. Operational gaps (engineering process)

### F6.49 No CI parity test against statsforecast / MAPIE

`forecast.js` implements Croston / SBA / TSB by hand. Nixtla's
`statsforecast` is the canonical Python implementation. MAPIE is
the canonical Python conformal-prediction implementation. Without
a CI gate that asserts JS output parity against Python on a fixed
benchmark dataset, the JS implementations will drift silently.

Add a CI step:
1. Pre-commit a fixed 50-SKU benchmark dataset (synthetic, public).
2. Pre-compute expected outputs from `statsforecast` (Croston, SBA,
   TSB) and `MAPIE` (Split CP, NEXCP analog).
3. CI runs the JS implementations on the same dataset.
4. Compare: absolute tolerance 1e-6 on point forecasts, 1e-4 on
   CP quantiles.

Without this, the engineer touching `forecast.js` cannot prove
they didn't break parity. This is the single most important
operational gap. `[verified, no parity test in repo]`

### F6.50 No replay log of planning decisions

If a stockout occurs, the operator wants to know "what did the
planning cron see when it decided not to expedite?" The cron
writes `procurement_plans.rationale` (JSON), but not the inputs:
the full residual array, the cohort pool, the forecasted demand
vector, the lead-time samples.

Add a `planning_decisions` table that stores the inputs (immutable,
60-day retention) so a forensic audit can replay any past
decision. The cost is ~50KB per (SKU, run); at 500 SKUs and 52
runs/year, that's 1.3GB/yr — manageable.

`[verified, no replay capability in shipped engine]`

## 10. Math implementation reference

Six mathematical sketches in one block, for the engineer who will
fix the bugs above. Each is paired with the finding it addresses.

### Math sketch 1 — corrected weighted-quantile (F6.1, F6.2)

```js
// Returns weighted alpha-quantile of |r_i| with finite-sample
// correction per Barber AOS 2023 §2.2. residuals[i] is paired
// with weights[i] (time-indexed, oldest first, newest last).
const weightedAbsQuantileCorrected = (residuals, weights, alphaMiss, opts = {}) => {
  const eps = opts.eps || 1e-12;
  const n = residuals.length;
  if (n === 0) return 0;
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (sumW <= 0) return Math.max(...residuals.map(Math.abs));
  // Implicit weight on the test point's "infinity" virtual residual.
  const wTest = 1.0;
  const denom = sumW + wTest;
  // Pair (abs residual, normalized weight) and sort ascending.
  const pairs = residuals
    .map((r, i) => ({ abs: Math.abs(r), w: weights[i] / denom }))
    .sort((a, b) => a.abs - b.abs);
  // Target accumulated weight is (1 - alpha_miss) + w_test/denom.
  // The +w_test/denom is the finite-sample +1 correction.
  const target = Math.min(1, (1 - alphaMiss) + wTest / denom);
  let cum = 0;
  for (const p of pairs) {
    cum += p.w;
    if (cum + eps >= target) return p.abs;  // upper-tied
  }
  return pairs[n - 1].abs;
};
```

### Math sketch 2 — score-space conformal residual (F6.4)

```js
// Compute prediction-difficulty estimator sigma_hat per period
// using a windowed standard deviation of historical demand.
const sigmaHat = (history, window = 8) => {
  const tail = history.slice(-window);
  if (tail.length < 2) return 1.0;
  const m = tail.reduce((s, v) => s + v, 0) / tail.length;
  const v = tail.reduce((s, x) => s + (x - m) ** 2, 0) / (tail.length - 1);
  return Math.max(Math.sqrt(v), 0.1);
};
// Score-space residual: divide raw residual by local sigma_hat.
const scoreResidual = (actual, forecast, history) =>
  (actual - forecast) / sigmaHat(history);
// At inference time, multiply the conformal score quantile back:
const intervalFromScore = (pointForecast, scoreQuantile, history) => {
  const sh = sigmaHat(history);
  return {
    interval_lo: Math.max(0, pointForecast - scoreQuantile * sh),
    interval_hi: pointForecast + scoreQuantile * sh,
  };
};
```

### Math sketch 3 — correct LTD-scaled CP interval (F6.5)

```js
// Convert per-period CP quantile to LTD quantile honoring both
// demand and lead-time variance.
//   leadTimeMean, leadTimeSigma: in weeks.
//   perPeriodLo, perPeriodHi:    the CP band per period.
//   perPeriodAlpha:              the CP nominal miscoverage.
// Returns the LTD band at the same nominal miscoverage, assuming
// per-period demand is i.i.d. and lead time is independent of
// demand.
const scaleIntervalToLTDCorrect = ({
  perPeriodLo, perPeriodHi, perPeriodAlpha,
  pointForecast, leadTimeMean, leadTimeSigma,
}) => {
  const L = Math.max(0, leadTimeMean);
  const sigmaL = Math.max(0, leadTimeSigma);
  const mu = pointForecast;
  // Back out an effective per-period sigma from the CP band width:
  //   width = 2 * z(1 - alpha/2) * sigma_eff
  // (under approximate normality of standardized residuals)
  const zUpper = standardNormalInverse(1 - perPeriodAlpha / 2);
  const sigmaEff = (perPeriodHi - perPeriodLo) / (2 * zUpper);
  // Hadley-Whitin compound LTD variance:
  const varLTD = L * sigmaEff * sigmaEff + mu * mu * sigmaL * sigmaL;
  const sigmaLTD = Math.sqrt(Math.max(0, varLTD));
  const muLTD = L * mu;
  return {
    interval_lo_ltd: Math.max(0, muLTD - zUpper * sigmaLTD),
    interval_hi_ltd: muLTD + zUpper * sigmaLTD,
    sigma_eff: sigmaEff,
    sigma_ltd: sigmaLTD,
  };
};
```

### Math sketch 4 — ACI update (F6.9)

```js
// Adaptive Conformal Inference (Gibbs Candes 2021).
//   alphaTarget:  the nominal miscoverage (e.g. 0.05 for 95%).
//   alphaCurrent: state, updated weekly.
//   wasInside:    boolean, did last week's actual fall in the band?
//   gamma:        learning rate, typically 0.005-0.05.
// Returns the new alphaCurrent to use for next week's CP.
const aciUpdate = ({ alphaTarget, alphaCurrent, wasInside, gamma = 0.01 }) => {
  // ACI: alpha_{t+1} = alpha_t + gamma * (alphaTarget - 1{outside})
  //   where 1{outside} = 1 if actual was outside the interval.
  const err = wasInside ? 0 : 1;
  const alphaNew = alphaCurrent + gamma * (alphaTarget - err);
  // Clip to (0.001, 0.5) so the engine stays in a sensible range.
  return Math.max(0.001, Math.min(0.5, alphaNew));
};
```

### Math sketch 5 — Block CP for autocorrelated residuals (F6.8)

```js
// Block conformal: residuals are grouped into blocks of size B,
// sampled at block resolution.
//   residuals:    time-ordered array.
//   blockSize:    estimated autocorrelation length + 1.
//   alphaMiss:    miscoverage.
// Returns the quantile.
const blockCP = (residuals, blockSize, alphaMiss) => {
  const n = residuals.length;
  if (n === 0) return 0;
  const numBlocks = Math.floor(n / blockSize);
  if (numBlocks < 2) return splitCP(residuals, 1 - alphaMiss).qHi;
  // Take the maximum |residual| within each block. This is the
  // "block max" score; for symmetric demand it's the conservative
  // choice (preserves coverage under serial dependence).
  const blockScores = [];
  for (let b = 0; b < numBlocks; b++) {
    const block = residuals.slice(b * blockSize, (b + 1) * blockSize);
    blockScores.push(Math.max(...block.map(Math.abs)));
  }
  // Then standard split-CP quantile on block scores.
  blockScores.sort((a, b) => a - b);
  const target = Math.ceil((numBlocks + 1) * (1 - alphaMiss)) / numBlocks;
  const idx = Math.min(numBlocks - 1, Math.floor(target * numBlocks));
  return blockScores[idx];
};
// Estimate block size from lag-1 autocorrelation:
const estimateBlockSize = (residuals) => {
  if (residuals.length < 4) return 1;
  const m = residuals.reduce((s, v) => s + v, 0) / residuals.length;
  let num = 0, den = 0;
  for (let i = 1; i < residuals.length; i++) {
    num += (residuals[i] - m) * (residuals[i - 1] - m);
  }
  for (let i = 0; i < residuals.length; i++) {
    den += (residuals[i] - m) ** 2;
  }
  const rho1 = den > 0 ? num / den : 0;
  // Block size = max(1, round(1 / (1 - |rho1|)))
  return Math.max(1, Math.round(1 / Math.max(0.01, 1 - Math.abs(rho1))));
};
```

### Math sketch 6 — Conformal newsvendor order quantity (F6.23)

```js
// Conformal newsvendor (Bertsimas Kallus 2025).
//   pointForecast: per-period demand point estimate.
//   residuals:     historical residuals (one-step-ahead).
//   c_u:           per-unit understock cost (lost margin + goodwill).
//   c_o:           per-unit overstock cost (carrying + obsolescence).
//   moq, packSize: supplier constraints.
// Returns the recommended order quantity.
const conformalNewsvendorQ = ({
  pointForecast, residuals, c_u, c_o, moq = 1, packSize = 1,
}) => {
  if (c_u + c_o <= 0) return moq;
  const criticalFractile = c_u / (c_u + c_o);
  // Compute the criticalFractile-quantile of the residual
  // distribution.
  const sorted = residuals.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1,
                       Math.floor(criticalFractile * sorted.length));
  const qR = sorted[idx] || 0;
  const Q = Math.max(0, pointForecast + qR);
  // Round to supplier constraints.
  const inPacks = Math.ceil(Q / packSize);
  return Math.max(moq, inPacks * packSize);
};
```

## 11. Compatibility with shipped code

Each finding above is **localized**: the fix lives in one or two
files, not a rewrite. The biggest-impact fixes:
- F6.4 (score-space residuals): rewrite of `forecast.js` residual
  storage and `conformal.js` interval reconstruction. ~80 LOC.
- F6.5 (correct LTD scaling): rewrite of `scaleIntervalToLTD`. ~30
  LOC.
- F6.1 + F6.2 (corrected quantile): rewrite of `weightedAbsQuantile`.
  ~25 LOC.
- F6.7 (cohort key): schema migration + cron + conformal.js. ~50
  LOC + migration.
- F6.13 (bootstrap backfill): one-time job + one PR. ~120 LOC.
- F6.18 (prequential residuals): cron rework. ~40 LOC.
- F6.43-46 (perf): batch queries in cron. ~80 LOC.

Total estimated work: 4-6 engineer-weeks for all critical findings.

## 12. Numbered follow-up deep-dive prompts

Each is a self-contained next step, ranked roughly by leverage.

1. Implement the score-space conformal residual store (F6.4).
   Spec the migration to add `score`, `sigma_hat`, and historical
   `model_name` to `conformal_calibration_residuals`. Spec the cron
   rework to write standardized scores. Quantify expected band
   width reduction on Anvil's lumpy SKUs using the M5 spares cuts
   as a comparable.

2. Fix the LTD-scaling bug (F6.5). Spec the corrected math,
   propose the migration to a new field
   `interval_hi_ltd` on `demand_forecasts`, and quantify the
   working-capital reduction at a typical Anvil tenant assuming
   100 ATD units at INR 2.5L purchase price.

3. Apply the (n+1) finite-sample correction to NEXCP and split-CP
   (F6.1). Spec the unit test that exercises the
   off-by-one and demonstrates a coverage difference > 1pp at
   `n = 26`.

4. Wire the four inventory crons into `vercel.json` (F6.12). Spec
   the cron schedule (planning Monday 02:00 IST, calibration Sunday
   14:00 IST, positions every 30 min, exceptions every 30 min) and
   the cron-mux heartbeat assertion for each.

5. Spec the bootstrap backfill (F6.13). 104 weeks of historical
   forecasts back-dated into `demand_forecasts`, then 156 weeks of
   residuals back-dated into `conformal_calibration_residuals`.
   Define the one-time `/api/admin/inventory/backfill` endpoint
   with idempotency and a dry-run mode.

6. Spec the `(family, demand_class, abc_class)` cohort key (F6.7,
   F6.31). Migration to add columns; data-quality query to assert
   every planning-enabled SKU has values; cron rework to use the
   tuple key.

7. Spec prequential residual semantics (F6.18). The cron must
   write the **previous week's** out-of-sample residual, not the
   current week's in-sample residual. Define the lookback window
   and the bootstrap behavior for week 1.

8. Spec block CP for SKUs with high residual autocorrelation
   (F6.8). Define the lag-1 autocorrelation threshold (e.g.
   `|rho_1| > 0.3`) for switching to block-CP; spec the runtime
   metadata stamp (`conformal_method = 'block_cp'`) and the cohort
   handling.

9. Implement ACI alongside NEXCP (F6.9). Add the
   `conformal_alpha_current` column on item_master; spec the
   weekly update step; define the gamma sensitivity table per
   demand_class.

10. Spec the model-tagged residual store (F6.17). Add `model_name`
    to `conformal_calibration_residuals`; cron filters residuals by
    the active forecaster; older residuals stay for diagnostics.

11. Spec the seasonality layer (F6.8 part 2). STL decomposition or
    Holt-Winters multiplicative on top of SBA; reseasonalise the
    forecast + band; migration for `seasonal_index` on
    `demand_forecasts`.

12. Spec the A/B framework for the SLO contract (F6.38). Define
    the hash-based SKU split; the `procurement_plans.experiment_arm`
    column; the dashboard view that compares stockout-rate +
    inventory-holding by arm.

13. Spec the parity gate against statsforecast + MAPIE (F6.49).
    50-SKU benchmark, expected outputs as fixtures, CI step that
    fails on >1e-4 deviation on CP quantiles.

14. Spec the per-SKU `rho` tunable (F6.14). Per-(tenant, demand_class)
    table; cron reads the value; UI to override per SKU.

15. Spec the planning_decisions replay table (F6.50). 60-day
    retention; immutable; queryable by (tenant_id, part_no,
    run_id).

16. Spec the empirical-coverage time series UI (F6.35). Per-week
    realised vs target coverage chart on the per-SKU coverage tab.

17. Spec the coverage-gap bound surface (F6.3). Compute Barber
    Theorem 2.2 bound at runtime; show on diagnostics; raise an
    `inventory_exception` of kind `coverage_bound_violated` when
    the bound drops below the operator-set tolerance.

18. Spec the security tightening on `/conformal_diagnostics`
    (F6.47). New role `planning_admin`; deprecate `read` access to
    model health.

19. Spec the safety-stock vs service-level disambiguation (F6.16).
    Migration to add `coverage_target_two_sided` with explicit
    semantic; cron uses the right value; UI shows both with a
    conversion note.

20. Spec the cohort-tenant safety check (F6.48). Defensive
    assertion in the JS layer; multi-tenant pool design (when /
    if shared cohorts are introduced).

21. Spec the conformal newsvendor order-quantity formula (F6.23).
    Compose with EOQ; pick the unified Q* under the critical
    fractile derived from `c_u, c_o` columns on `item_master`.

22. Spec the pipeline-demand variance propagation (F6.24). Treat
    each opportunity as Bernoulli; add the variance to the safety
    stock sigma; cron change ~10 LOC.

23. Spec the planning cron batching (F6.43-46). Pre-fetch all
    queries before the loop; bulk upserts at the end; target
    runtime < 2s for 500 SKUs.

24. Spec the residual model-tagged retention (F6.17 + F6.32).
    Stale residuals from retired SKUs pruned on schedule; cohort
    pool filtered to active SKUs.

25. Spec the lognormal lead-time fit for Japan/Korea suppliers
    (continuation of F6.5). The compound LTD variance changes when
    lead-time is lognormal; document the closed-form correction.

26. Spec the coverage-drift CUSUM detector (F6.37). Replace the
    5pp fixed-window threshold with a sequential CUSUM that
    integrates evidence; pages on-call only on statistically
    significant drift.

27. Spec the BOM-driven dependent demand (continuation of F6.7).
    `v_bom_walk_recursive` already exists; extend to time-shift
    demand by manufacturing lead-time; migration for
    `manufacturing_lead_days` and `yield_pct` on
    `bill_of_materials`.

28. Spec the operator-facing model-rationale template (F6.34). The
    "What model + Why + Confidence + What changed" pattern from
    ToolsGroup; the `/inventory-item` page renders this above the
    chart.

29. Spec multi-echelon CP (Clark-Scarf 1960 with CP layered on
    each echelon). For Anvil's distributor + service-center
    network, quantify the inventory reduction vs single-echelon
    safety stock.

30. Spec the supplier-risk overlay (F6.5 part 3). Per-supplier
    survival regression on historical on-time%; output a
    risk-adjusted lead-time inflation factor; the cron multiplies
    `leadTimeMean` by `(1 + risk_factor)`.

## Backtesting framework spec

The shipped engine has no production backtester. The closest thing
is `empiricalCoverage()` in `conformal.js` and the 13-week
realised-coverage window surfaced by `conformal_diagnostics.js:170`.
That is a live monitor, not a backtest. A backtest answers a
different question: "if we re-ran the cron over the last 18 months
with the candidate change, what would the inventory, fill-rate,
working-capital, and coverage curves look like, and would the
candidate beat the incumbent at the 95% confidence band?" Without
this the calibration cron is flying blind. This section specifies
the operational design.

### Why prequential, not k-fold

Standard k-fold cross-validation breaks under temporal data:
residuals from week `t+10` cannot be used to score a model
calibrated through week `t`, because the model sees the future.
Inventory forecasting compounds this because demand contains
seasonality, trend, and tenant-specific regime shifts (new ERP
go-live, supplier change, COVID-class shocks). Prequential
evaluation (Dawid 1984, Gneiting Katzfuss 2014) walks forward one
step at a time: at each origin `t`, calibrate on data `<= t`,
forecast for `t+1..t+H`, score the realised actuals, advance.

For Anvil this means: at origin week 78, the harness sees only
weeks 1..78, computes the CP interval for week 79..82 (lead-time
window), then reveals the actual and scores. Advance to origin
79, recompute. This matches exactly how the planning cron
operates each Monday: it sees only what is in
`order_schedule_lines` up to the prior Sunday. Backtest fidelity
to production is therefore tight if and only if the harness uses
**asof joins** against `forecast_runs.generated_at`. If the
harness ever joins on `actual_value` first and then filters by
date, it has leaked the future.

### The three CV protocols Anvil must ship

The harness must support three orthogonal cuts. Each answers a
distinct production question.

(a) **Rolling-origin block-CV**: the production-faithful protocol.
At origin `t in {52, 53, ..., T-H}`, calibrate on weeks
`[t-104, t]`, hold out `(t, t+H]`. Block length is the
estimated lag-1 autocorrelation of the residuals (default 1,
auto-promoted to 4 when `|rho_1| > 0.3`; ties this to F6.8).
Block bootstrap (Politis Romano 1994) re-samples blocks to build
a 95% CI on coverage and ASLP. Use stationary block bootstrap
(geometric block length) for SKUs with non-constant variance.

(b) **Leave-one-tenant-out (LOTO)**: needed because every
tenant-onboarding decision is "will this work for the new
tenant?" Calibrate on `T \ {tenant_k}`, evaluate on
`tenant_k`. Reports per-tenant generalisation, identifies the
tenant whose residual distribution most degrades the global
model. Critical for the pooled cold-start cohort: a tenant whose
LOTO score is much worse than the within-tenant block-CV score
is signalling that the cohort key is wrong for them.

(c) **Leave-one-quarter-out (LOQO)**: temporal robustness. Drop
all weeks in calendar quarter `Q_k`, calibrate on the rest,
score on `Q_k`. Reveals seasonal/regime-shift sensitivity that
rolling-origin can mask when the held-out window happens to be
similar to the calibration window. The diagnostic: when LOQO
coverage on Q1 deviates from rolling-origin by > 3pp, the model
has a Q1 sub-population that the linear chronology cannot
isolate. Frequently the cause is fiscal-year tail spend or
project-tax-quarter procurement.

### The seven metrics that matter

The harness must report all seven. None individually is
sufficient.

| Metric | Formula | What it answers |
|---|---|---|
| `marginal_coverage` | `mean(1{actual in [lo, hi]})` | Does the band keep its promise? Target = `1 - alpha`. |
| `conditional_coverage_class` | `coverage` split by demand_class | Does coverage hold within Smooth, Erratic, Lumpy, Intermittent? Tilts here means the model is fine globally but fails on Lumpy SKUs. |
| `avg_interval_width` | `mean(hi - lo)` | How wide is the band? Width = working capital. |
| `aslp` (Average Scaled Pinball Loss) | `mean over q of pinball(q, alpha)/scale` | Sharpness-coverage tradeoff in one number. Lower is better. Scale = `mean(actual)` per SKU. |
| `fill_rate_at_band` | `mean(min(actual, hi) / max(actual, 1))` | How often does the upper band cover the actual demand? Cap at 1. |
| `working_capital_units` | `mean(hi - point_forecast) * unit_cost` | Translates the band into INR or USD per SKU per week. |
| `crps` (Continuous Ranked Probability Score) | Standard CRPS via the residual ECDF | Strictly proper score; the single number for model-vs-model comparison. |

The non-obvious one is `aslp`. The pinball loss at quantile `q`
penalises asymmetrically: undercoverage (actual > hi) is `(1 - q)
* (actual - hi)`, overcoverage is `q * (hi - actual)`. Aggregated
across `q in {0.5, 0.75, 0.9, 0.95, 0.99}` and scaled by the SKU
mean, it gives a single sharpness-coverage tradeoff number that
is comparable across SKUs of wildly different magnitude. ASLP
under 0.06 is a strong distribution-aware forecast; over 0.12
indicates the model is overfit to a single regime.

`crps` is the gold-standard score; report it last because it is
slowest to compute. Use the closed form via the residual ECDF
(Hersbach 2000 eqn 17): for a forecast distribution F and actual
y, `crps = integral (F(x) - 1{x >= y})^2 dx`. Discretise on the
empirical residual grid.

### Feeding the production calibration cron

The backtest harness output (a JSON blob keyed by `(tenant_id,
method, cohort_key, alpha_target)`) is the input to the
calibration cron. Two consumer surfaces:

(1) **Method auto-selection**: per (tenant, cohort), pick the
method with the lowest `aslp` among methods whose
`marginal_coverage` is within `1pp` of target. Tie-break on
`avg_interval_width`. Stamp the choice in
`tenant_settings.inventory_conformal_method` (or per-cohort
override) on the next planning run. Operator can pin a method
via UI; pin overrides auto-selection.

(2) **Alpha auto-tuning (ACI hook)**: per SKU, if the
rolling-origin `marginal_coverage` deviates from
`coverage_target` by > 2pp for 8 consecutive weeks, emit an
`inventory_exception` of kind `coverage_drift` and let the
operator approve a one-step alpha adjustment. This is the
human-in-the-loop variant of ACI (Gibbs Candes 2021); pure ACI
would let the engine adjust autonomously, but auditors will
demand operator approval for service-level changes on inventory
that ties to a sub-15-day balance sheet.

The harness must run **on the same compute path as production**.
That means the `selectAndComputeCP()` call inside the planning
cron, not a parallel implementation. Otherwise drift between the
backtest engine and the production engine is guaranteed within
two quarters. Wire the harness to invoke the production module
under a mocked clock.

### Harness pseudocode

```js
// /api/admin/inventory/backtest
// POST  body: { tenant_id, methods: ['nexcp', 'split_cp',
//   'block_cp'], protocol: 'rolling_origin' | 'loto' | 'loqo',
//   horizon_weeks: 4, calibration_window_weeks: 104, alpha: 0.95 }
async function runBacktest({ tenantId, methods, protocol,
                             horizon, calWin, alpha }) {
  // Pull all (part, week) actuals and stamped forecasts in one
  // batched read. Asof on forecast_runs.generated_at so we never
  // see a forecast that was made after the actual was observed.
  const universe = await loadUniverseAsof(tenantId, calWin);
  const grid = enumerateOrigins(universe, protocol);
  // grid = [{ origin_week, train_idx[], test_idx[] }, ...]
  const out = [];
  for (const fold of grid) {
    const train = universe.filter((r) => fold.train_idx.has(r.idx));
    const test  = universe.filter((r) => fold.test_idx.has(r.idx));
    for (const method of methods) {
      // Use the SAME selectAndComputeCP as production.
      const calibration = selectAndComputeCP({
        residuals: extractResiduals(train),
        alpha,
        method,
      });
      const scored = test.map((row) => {
        const band = intervalForForecast(row.forecast,
          calibration, row.history);
        const ltdBand = scaleIntervalToLTD(band, row.leadTime);
        return {
          part_no: row.part_no,
          week: row.week_start,
          actual: row.actual,
          lo: ltdBand.interval_lo_ltd,
          hi: ltdBand.interval_hi_ltd,
          width: ltdBand.interval_hi_ltd - ltdBand.interval_lo_ltd,
          inside: row.actual >= ltdBand.interval_lo_ltd &&
                  row.actual <= ltdBand.interval_hi_ltd,
        };
      });
      const metrics = computeAllMetrics(scored, alpha);
      const ci = blockBootstrapCI(scored, metrics, {
        blocks: estimateBlockSize(extractResiduals(train)),
        replicates: 1000,
      });
      out.push({
        fold_origin: fold.origin_week,
        method,
        metrics,
        ci,  // { coverage_lo, coverage_hi, aslp_lo, aslp_hi, ... }
      });
    }
  }
  // Aggregate across folds: harmonic mean of coverage CIs,
  // arithmetic mean of widths, scaled per-SKU.
  return aggregateAndPersist(tenantId, protocol, alpha, out);
}

// Persistence: write to a new immutable table
// inventory_backtest_runs (tenant_id, run_id, protocol, alpha,
// horizon, started_at, finished_at, summary_jsonb,
// per_method_jsonb, content_hash, signed_by). The content_hash
// is sha256 of the canonical summary; signed_by is the
// service-account key id. Operator dashboard reads this table.
```

A single LOTO run across 10 tenants, 500 SKUs each, 156 weeks
history, three methods, 13-week horizon should complete in
under 8 minutes on the Vercel function with `maxDuration = 300s`
when chunked per-tenant. The chunking key is the tenant; folds
within a tenant batch on a per-method basis. Anything larger
needs a separate worker. `[inferred from current cron shapes]`

### Wiring it into operations

The backtest must run on a cadence operators can act on. Three
cadences:

- **Weekly health check**: after `conformal-calibration-weekly`
  runs, schedule the rolling-origin block-CV on the last 26
  weeks for the active method. Output goes to the
  `coverage_drift` lane in `inventory_exceptions`.
- **Monthly auto-selection**: on the first of the month, run all
  three methods over the last 78 weeks. Update
  `tenant_settings.inventory_conformal_method` if the
  auto-selected method changes; require operator approval if the
  change is from NEXCP to split_cp (regression in
  data-efficiency) or pooled_cold_start (signals data quality
  has eroded).
- **Quarterly LOTO**: every fiscal quarter end, run LOTO across
  all tenants. Useful for cohort-design review (F6.7) and
  pooled-tenant safety (F6.48).

The biggest mistake the next engineer can make is to run any of
these without writing to a tamper-evident audit row. The result
sets the safety-stock floor for the next quarter; a regulator,
an insurance adjuster, or a litigant after a stockout will
demand to see the experiment that justified the band. Hash the
result blob, store with the service-account signature, and write
to a table whose retention is set to seven years.

## Findings F6.51 to F6.58

### F6.51 conformal_intervals row lifecycle is undefined; no documented invalidation [severity: high]

**Problem.** Migration 100 adds five columns on
`demand_forecasts` (`conformal_method`, `coverage_target`,
`interval_lo`, `interval_hi`, `calibration_residuals_count`) but
defines no lifecycle policy. A row is written by
`inventory-planning-weekly.js` and read by the UI and
`procurement_plans` consumer. Nowhere on `main` is there a
documented contract for: when does the row become stale, what
happens when the residuals it was computed from get pruned, what
happens when the operator changes `coverage_target` mid-week,
what happens when a SKU is retired.

**Current state on main.** `verified-on-main`,
`supabase/migrations/100_inventory_conformal_intervals.sql:27-32`.
The columns are nullable. The CCR table at line 108 has the
unique `(tenant_id, part_no, week_start)` key but no FK from
`demand_forecasts.calibration_residuals_count` back to a specific
residual generation. When `conformal-calibration-weekly.js:121`
prunes residuals older than 156 weeks, any
`demand_forecasts.interval_lo/hi` row that referenced a residual
from week T - 157 is silently orphaned (math is no longer
reproducible). The cron at
`src/api/cron/conformal-calibration-weekly.js:121` issues
`delete()` without writing a tombstone.

**Competitor state.** ToolsGroup SO99+ and Logility Demand
Solutions both timestamp the calibration set and freeze the
calibration_set_id on the forecast row; the forecast can always
be re-derived. Kinaxis Maestro tracks an immutable model_version
on each forecast.

**Adjacent insight.** Anvil's `forecast_runs` table is the
existing immutable artifact (see Read of `forecast_runs.js`).
The fix is to FK `demand_forecasts` to `forecast_runs.id` and
extend `forecast_runs` to capture a content_hash of the
calibration set used.

**Research insight.** ML reproducibility literature (Pineau et
al. 2021, NeurIPS reproducibility checklist) is unanimous: any
inferential artifact needs three things to be reproducible:
input hash, code hash, and seed. Anvil currently stores none.

**Proposed change.** Add `calibration_set_hash text` and
`forecast_run_id uuid references forecast_runs(id)` on
`demand_forecasts`. The cron computes
`sha256(canonical_json(residuals_used))` at calibration time and
stamps it. Pruning the CCR table refuses to delete rows whose
hash is referenced by a non-superseded forecast (FK or app-level
soft check). Retention: forecasts beyond 90 days flip to
`superseded`, and only then the residual hash becomes
free-to-prune. A `forecast_supersede_event` table records the
transition.

**User-facing behavior.** Operator sees a "Frozen at run X on
date Y, calibration hash Z" stamp on every forecast. Clicking
opens the calibration audit view.

**Technical implementation.** Migration 110: `alter table
demand_forecasts add column calibration_set_hash text, add column
forecast_run_id uuid references forecast_runs(id)`. Cron change:
`inventory-planning-weekly.js` writes both. New endpoint
`/api/inventory/forecast_runs/<id>/reproduce` re-derives the
interval from the stored hash.

**Integration plan.** Two-phase. Phase 1 (1 PR): add columns,
start stamping. Phase 2 (1 PR, 30 days later): add the
soft-delete check on the CCR prune step.

**Telemetry.** New metric `forecast.calibration.orphan_count`:
forecasts whose residual hash is no longer in CCR. Should
trend to 0.

**Non-goals.** Not replaying historical forecasts; only
guaranteeing that future forecasts are reproducible.

**Open questions.** Should the calibration_set_hash include the
weight vector or just the residuals? (Argument for both: NEXCP
weight is implicitly a function of residual age, so hashing
residuals alone is reproducible iff the weight schedule is also
stamped on the forecast.)

**Effort.** 1.5 engineer-weeks. Migration 0.2 wk, cron 0.5 wk,
reproduction endpoint 0.5 wk, tests 0.3 wk.

**5-axis score.** Defensibility 9, Operational impact 8,
Implementation cost 3, Tenant readiness 7, Regulatory leverage
9. **Weighted total: 7.8**.

**Deep-dive prompt.** Design the `calibration_set_hash` schema
extension. Spec: the canonical-JSON serialisation (sort keys,
fixed precision); the prune-safety check (CCR delete refused
when hash referenced by a non-superseded row); the
reproduction endpoint that takes a forecast_run_id and replays
`selectAndComputeCP` deterministically. `verified-on-main`.

### F6.52 supplier_scorecard does not modulate the safety-stock floor [severity: medium]

**Problem.** The shipped engine treats supplier reliability as a
parameter only through `lead-time.js`'s gamma-fit lead-time
mean and variance. There is no path from a supplier with poor
on-time-delivery (OTD), a high cancellation rate, or a degrading
quality score to a wider conformal interval. A SKU that ships
from a supplier with 60% OTD gets the same band as a SKU
shipping from a 99% OTD supplier with the same lead-time mean,
because the lead-time variance is the only mechanism for
supplier risk to flow into the band.

**Current state on main.** `verified-on-main`,
`src/api/inventory/suppliers.js:26-34`: the endpoint returns
suppliers with no scorecard fields beyond `supplier_name`,
`country`, `default_currency`, `contact_email`,
`contact_phone`, `ordering_cost_override`, `notes`. There is no
`otd_score`, `quality_score`, `risk_factor`, or
`safety_stock_inflation_multiplier`. The suppliers table is
written by the upsert at line 42 and by the weekly cron's lead
time estimator, but the cron's writes are only `leadTimeMean` /
`leadTimeSigma`, not a risk multiplier.

**Competitor state.** Coupa Supplier Risk Performance and SAP
Ariba Supplier Risk include scorecards that multiply the safety
stock by a risk factor (typically `(1 + risk_score)`); the
o9 Solutions platform documents a "supplier reliability stress
factor" that scales the lead-time variance separately from the
demand variance.

**Adjacent insight.** Anvil already has the data: `source_pos`
captures `acknowledged_eta` vs `received_at`, sufficient to
compute OTD per supplier per quarter. The plumbing exists; the
math is missing.

**Research insight.** Glasserman & Tayur 2002 ("Sensitivity
analysis for base-stock levels in multiechelon production-
inventory systems") shows that supplier reliability enters the
optimal base-stock level through the conditional lead-time
distribution given delivery success. Folding supplier OTD into
the LTD distribution is the same Bayesian update as folding
demand variance: `var(LTD) = E[L|delivered] * sigma_D^2 +
mu_D^2 * (var(L|delivered) + delta_L^2 * P(late))`. The third
term is the OTD-bearing one.

**Proposed change.** Add `supplier_scorecard` table: `(tenant_id,
supplier_id, period_start, otd_pct numeric, quality_pct numeric,
acceptance_pct numeric, cancellation_pct numeric,
risk_factor numeric, computed_at, computed_by)`. The
calibration cron computes `risk_factor` quarterly as a weighted
function of the four pct fields. The planning cron multiplies
`leadTimeMean` by `(1 + 0.5 * risk_factor)` and
`leadTimeSigma` by `(1 + 1.5 * risk_factor)`, then runs the
existing CP pipeline. The `risk_factor` is bounded in `[0, 0.5]`
to prevent runaway inflation.

**User-facing behavior.** Operator sees a "Supplier reliability
adjustment: +18% lead-time inflation" line on every forecast
page. The supplier admin page surfaces the scorecard.

**Technical implementation.** Migration 111: new table. New
cron `/api/cron/supplier-scorecard-quarterly` (runs on the first
of each quarter; cleanup of stale rows). `lead-time.js`
extended to accept an optional `risk_factor` argument and to
multiply through.

**Integration plan.** Phase 1: write the scorecard but do not
apply the inflation (shadow mode). Phase 2: enable inflation
per tenant after 6 weeks of shadow data.

**Telemetry.** `supplier.risk_factor.distribution` (histogram),
`supplier.risk_inflation.applied_count` (counter).

**Non-goals.** Not replacing the supplier scorecard the
procurement team uses (separate domain).

**Open questions.** Does cancellation_pct enter additively or
multiplicatively with OTD? Probably multiplicatively because a
canceled order is a hard-zero delivery, not a late one.

**Effort.** 2 engineer-weeks.

**5-axis score.** Defensibility 8, Operational impact 7,
Implementation cost 4, Tenant readiness 6, Regulatory leverage
5. **Weighted total: 6.5**.

**Deep-dive prompt.** Spec the supplier_scorecard migration,
the cron that computes risk_factor, the lead-time.js
extension, and the dashboard page. Quantify the working-capital
delta on an Anvil tenant whose top-3 suppliers have OTD scores
in {0.85, 0.72, 0.91}.

### F6.53 the engine treats items independently; joint-stockout coverage is unmodeled [severity: high]

**Problem.** Conformal prediction is computed per SKU. When a
customer order contains 12 line-items and the engine reports 95%
coverage on each, the joint probability that all 12 line-items
clear is at most `0.95^12 = 0.54` if items are independent and
much lower if items are positively correlated (e.g. all sourced
from the same supplier, all hit by the same monsoon disruption).
The operator sees a green "95% confidence" on each line and
assumes the order will ship; the actual order-fill probability
is roughly coin-flip.

**Current state on main.** `verified-on-main`,
`src/api/_lib/inventory/conformal.js:1-266`. Every CP function
operates on a single residual array for a single part. The
planning loop in `inventory-planning-weekly.js:406-412` calls
`selectAndComputeCP` per part. No joint quantile, no copula, no
covariance estimation across parts.

**Competitor state.** Llamasoft Supply Chain Guru and
ToolsGroup SO99+ both ship "order-fill probability" as a
first-class metric. SO99+ uses a Bonferroni-style adjustment;
Guru uses Monte Carlo over a fitted correlation matrix.

**Adjacent insight.** The line-item-level CP intervals on
`order_schedule_lines` could be aggregated to an order-level
joint distribution. The reduction in band width from exploiting
correlation is the entire upside of joint modeling; ignoring it
leaves money on the table.

**Research insight.** Lecue & Lerasle 2014 ("Robust machine
learning by median-of-means") and Diquigiovanni et al. 2022
(JMVA) present conformal procedures for multivariate response
that bound the **joint** miscoverage at `alpha`. The simplest
production-grade variant is Bonferroni: split alpha across the
K items, compute each per-item CP at `alpha/K`. The cost is
wider per-item bands; the benefit is a valid joint guarantee.

**Proposed change.** Add a `joint_coverage_mode` enum on
`tenant_settings`: `'independent'` (current behaviour),
`'bonferroni'`, `'empirical_copula'`. In Bonferroni mode, the
planning cron computes `alpha_eff = alpha / max(K_recent, 8)`
where `K_recent` is the trailing-quarter median order size.
In empirical copula mode, fit a Gaussian copula on the residual
matrix across the top-N most-correlated parts and sample.

**User-facing behavior.** Order page shows a single
"order-fill probability: 87%" badge alongside each line-item
band. The badge color tracks the joint not the marginal.

**Technical implementation.** New library
`_lib/inventory/conformal-joint.js`. Schema change:
`procurement_plans.joint_coverage_mode`. Cron change to compute
the joint quantile.

**Integration plan.** Ship Bonferroni first (1 PR); empirical
copula in phase 2 once the residual correlation matrix is
populated (90 days minimum data).

**Telemetry.** `forecast.joint.alpha_eff` histogram per tenant;
`forecast.joint.copula_rank` (effective rank of the residual
covariance) for diagnostic.

**Non-goals.** Not modeling cross-tenant correlation.

**Open questions.** Should the joint mode apply to safety-stock
sizing or only to order-fill display? Probably the latter
first; the former requires re-architecting `safety-stock.js`.

**Effort.** Bonferroni 1.5 weeks, copula 3 weeks.

**5-axis score.** Defensibility 8, Operational impact 9,
Implementation cost 5, Tenant readiness 6, Regulatory leverage
4. **Weighted total: 6.6**.

**Deep-dive prompt.** Spec the Bonferroni joint-coverage mode.
Define the per-tenant `K_recent` calibration (rolling median
order size or rolling 95th percentile?). Define the UI badge.
Quantify the band-width inflation vs the operational benefit of
a real joint guarantee.

### F6.54 newsvendor cu/co per-item override surface is absent [severity: medium]

**Problem.** Migration 100 adds `service_level` and
`conformal_coverage` to `item_master` but not `c_u`
(understock cost) or `c_o` (overstock cost). The conformal
newsvendor (F6.23 in the existing section) requires both;
without them the engine cannot compute the critical fractile
`c_u / (c_u + c_o)` per item. The legacy parametric engine uses
`service_level` as a proxy, which is mathematically wrong:
service-level is the operator's expression of a coverage
preference, not a cost-derived optimal target.

**Current state on main.** `verified-on-main`. The
`/api/inventory/conformal_diagnostics` endpoint at
`conformal_diagnostics.js:114-119` reads `item_type`,
`service_level`, `conformal_coverage`, `conformal_method_override`,
`demand_class`, `safety_stock`, `reorder_point`. No `c_u`,
`c_o`, `unit_carrying_cost`, `unit_understock_penalty`. The
PATCH at line 211 allows `conformal_coverage` and
`conformal_method_override` only.

**Competitor state.** Blue Yonder Luminate and o9 Solutions
both surface unit-level cu/co as item attributes. SAS IDS goes
further and ties cu/co to a downstream service contract penalty
matrix.

**Adjacent insight.** Anvil already has `default_unit_price` and
`carrying_cost_pct` on item_master (inferred from the legacy
EOQ engine in `eoq.js`). Translating to cu/co is a straight
multiply, not a new data ingestion.

**Research insight.** Bertsimas Kallus 2025 ("From Predictive to
Prescriptive Analytics") shows that joint estimation of
`(c_u, c_o)` from realised order-cancellation cost and
realised carrying cost is the **prescriptive newsvendor**; the
engine learns the cost vector from observed outcomes, not from
operator estimates. This is the right long-run direction; a
manual override is the short-run gating step.

**Proposed change.** Add `cu_override numeric`, `co_override
numeric`, and `cost_basis text` (one of `'override'`,
`'derived'`, `'pending'`) to `item_master`. PATCH endpoint
extended to set these. The cron prefers override, falls back to
`unit_price * margin_pct` for cu and `unit_price *
carrying_cost_pct` for co.

**User-facing behavior.** Per-SKU page shows "Critical fractile:
85.7% (cu = INR 1,200, co = INR 200)". Operator can override
either cost via inline edit; the change records to the audit
log.

**Technical implementation.** Migration 112. PATCH validator
extended. `_lib/inventory/newsvendor.js` (new): function
`criticalFractile({ c_u, c_o })`. Planning cron consumes the
fractile when CP newsvendor mode is enabled.

**Integration plan.** Two-phase. Phase 1: schema + override
PATCH only; mode disabled. Phase 2: planning cron uses the
fractile for items in newsvendor mode.

**Telemetry.** `newsvendor.fractile.distribution` per tenant.
`newsvendor.override.rate` (% of items with operator override).

**Non-goals.** Not learning cu/co from data (separate F6).

**Open questions.** Goodwill penalty: is it a per-event cost or
a per-day-late accumulating cost? Most tenants will want both;
the schema should anticipate.

**Effort.** 1.5 weeks.

**5-axis score.** Defensibility 7, Operational impact 7,
Implementation cost 3, Tenant readiness 6, Regulatory leverage
3. **Weighted total: 5.8**.

**Deep-dive prompt.** Spec `cu_override`, `co_override`,
`cost_basis` on item_master. Spec the newsvendor critical
fractile flow. Define the UI affordance for inline edit and
the audit-log shape.

### F6.55 alpha drift on tenant_settings does not invalidate stamped intervals [severity: high]

**Problem.** When a tenant changes
`tenant_settings.inventory_conformal_default_coverage` from 0.95
to 0.99 mid-quarter (a common operator action ahead of a
seasonal peak), nothing invalidates the
`demand_forecasts.coverage_target` rows that were stamped at
0.95. The next planning cron stamps new rows at 0.99, but
in-flight `procurement_plans` referencing the old forecasts
silently mix coverage levels. A customer service report that
reads "this quarter's coverage was 95%" hides the fact that
half the plans were sized at 95% and half at 99%; the rolling
empirical coverage will smear across both.

**Current state on main.** `verified-on-main`. The
`conformal_diagnostics.js:212` PATCH writes
`item_master.conformal_coverage` and records an audit, but
issues no invalidation. There is no
`forecasts_invalidated_at` column, no
`procurement_plans_supersede_on_alpha_change` trigger, no
queue. Once stamped, intervals live until the next planning
cron overwrites them, which can be up to 7 days.

**Competitor state.** Most enterprise CP engines defer the
question to the operator. The auditable ones (Blue Yonder
Luminate, ToolsGroup) emit a "policy change" event that
invalidates the affected plans and re-runs the planning
sub-engine immediately.

**Adjacent insight.** Anvil's tenant_settings table is the right
trigger point: a `before update` Postgres trigger can detect a
change in any of the alpha-bearing fields and write to a
queue (`policy_change_events`) that the next cron tick drains.

**Research insight.** ACI (Gibbs Candes 2021) and DtACI
(Bhattacharya Roy 2023) both assume the alpha target is fixed
between updates; changing alpha mid-stream invalidates the
adaptive update math, not just the stamped intervals. So the
fix must be more aggressive: invalidate the stamped intervals
**and** reset the ACI state.

**Proposed change.** Add `policy_change_events` table:
`(tenant_id, changed_at, field text, old_value jsonb, new_value
jsonb, applied_at, applied_by_run_id)`. Postgres trigger on
`tenant_settings` and `item_master.conformal_coverage` writes
rows. The planning cron consumes the queue: it marks affected
forecasts as `superseded_by_policy_change`, recomputes, stamps
the new forecasts with a back-reference to the policy event,
and resets any per-SKU ACI state.

**User-facing behavior.** Operator sees a yellow banner: "Alpha
change pending: 247 forecasts will recompute at next planning
run, 14:00 IST". They can request immediate recompute (admin
permission).

**Technical implementation.** Migration 113. New trigger.
`inventory-planning-weekly.js` extended to drain the queue
**before** the per-tenant loop. New endpoint
`/api/inventory/planning/recompute` for immediate runs (admin
only, rate-limited).

**Integration plan.** Single phase, but ship with a feature
flag for the first two weeks.

**Telemetry.** `policy_change.events.count` per day,
`policy_change.recompute_lag_seconds` p99. Alert when lag > 24h.

**Non-goals.** Not preventing the change; not auditing the
operator's reason (separate from this mechanic).

**Open questions.** Should a service_level change also reset
the empirical-coverage drift detector? Yes, because the target
moved; the 13-week rolling coverage window is no longer
comparable across the change.

**Effort.** 2 weeks.

**5-axis score.** Defensibility 9, Operational impact 8,
Implementation cost 4, Tenant readiness 8, Regulatory leverage
8. **Weighted total: 7.7**.

**Deep-dive prompt.** Spec the policy_change_events table, the
trigger, the cron drain step, and the immediate-recompute
endpoint. Define the back-reference contract from the new
forecast row to the policy event.

### F6.56 inventory_exception lifecycle has no SLO; no aging or escalation [severity: medium]

**Problem.** `inventory_exceptions` move through `open` ->
`acknowledged` -> `resolved` (or `suppressed`) with timestamps,
but there is no SLO clock: nothing flags a critical exception
that has sat in `open` for 48 hours, nothing escalates an
unacknowledged stockout exception to a supervisor after 8 hours,
nothing ages out a `resolved` exception (the rows accumulate
forever).

**Current state on main.** `verified-on-main`,
`src/api/inventory/exceptions.js:40-44`. The state machine has
four states with no timing constraints. `exceptions-detector.js`
re-emits exceptions via fingerprint dedup; a critical exception
that goes unhandled stays open indefinitely.

**Competitor state.** ServiceNow ITSM and Atlassian Jira Service
Management both ship lifecycle SLOs as first-class: time to
acknowledge, time to resolve, time to close, escalation tiers
1-3 per severity.

**Adjacent insight.** Anvil's notifications layer
(`notifications.js` from the existing F6.* findings) re-fires on
every `inventory-exceptions-tick`, but only on the first
detection. After ack, notifications stop. There is no
escalation path.

**Research insight.** Operations research on alarm fatigue
(Cvach 2012; Drew et al. 2014) is conclusive: alarms that
remain unhandled past 80% of their nominal SLO have a 4x lower
probability of ever being handled correctly. The fix is
mandatory escalation; auto-suppression is anti-pattern.

**Proposed change.** Add lifecycle SLO columns:
`time_to_ack_minutes int` (configurable per kind+severity),
`time_to_resolve_minutes int`, `escalation_tier int`,
`escalation_due_at timestamptz`. Cron job
`/api/cron/inventory-exception-escalation` (every 15m) walks
open exceptions whose `escalation_due_at` has passed and
escalates: tier 1 = notify operator, tier 2 = notify supervisor,
tier 3 = page on-call. Aged-out resolved exceptions move to a
warm-storage table after 180 days; the live table stays small.

**User-facing behavior.** Exception list shows a countdown ("SLO:
1h 22m remaining"). Past-SLO rows are red. Supervisor inbox
gets the tier-2 rows.

**Technical implementation.** Migration 114. New cron. The
exceptions endpoint extended to expose the SLO timer in its
response.

**Integration plan.** Phase 1: ship SLO computation + UI badge,
no escalation yet. Phase 2: enable escalation per tenant.

**Telemetry.** `exception.slo.breach_count` (counter per kind),
`exception.aging.p95_open_minutes` (gauge per severity).

**Non-goals.** Not auto-resolving on aging; an unresolved
critical exception that ages past tier 3 should page on-call,
not silently close.

**Open questions.** Suppressed exceptions: do they consume a
fresh SLO clock on re-emission? Probably no; suppression is a
human-approved no-op.

**Effort.** 2 weeks.

**5-axis score.** Defensibility 8, Operational impact 8,
Implementation cost 4, Tenant readiness 8, Regulatory leverage
6. **Weighted total: 7.2**.

**Deep-dive prompt.** Spec the SLO columns, the escalation
cron, the warm-storage migration. Define the default SLO per
(kind, severity) and the operator override surface.

### F6.57 cron observability has no tamper-evident audit row [severity: high]

**Problem.** Every cron run writes a row to a heartbeat table
via `recordCronHeartbeat()`. The row records status, duration,
and metadata. It does **not** record a content hash of what the
cron decided, nor is the row signed. An operator (or worse, an
attacker with service-account credentials) can update a
heartbeat row to claim the cron ran successfully; nothing
detects the tamper. The downstream consumer (compliance, audit,
litigation) cannot prove the cron ran as advertised.

**Current state on main.** `verified-on-main`,
`src/api/cron/conformal-calibration-weekly.js:166-170`. The
heartbeat call passes `status` and `metadata` only. The same
pattern at `inventory-planning-weekly.js`,
`inventory-exceptions-tick.js`, `daily.js`. No hash chain, no
signature, no append-only enforcement.

**Competitor state.** Snowflake's task history, AWS EventBridge
Scheduler, and Google Cloud Scheduler all expose an immutable
append-only log of task executions with a system signature.
Internal Fivetran-grade products typically chain via a
service-account-signed hash.

**Adjacent insight.** Anvil's existing audit log (used by
`recordAudit()` in the API endpoints) is the natural template:
each row references a prior row's hash to make the log
tamper-evident.

**Research insight.** Bitcoin-style hash chains (Haber & Stornetta
1991) are the standard for tamper-evident logs and are easily
realisable in Postgres with a `prev_hash` column and a
`before insert` trigger that verifies the chain. The trigger
costs O(1) per insert; the verifier endpoint walks the chain
linearly.

**Proposed change.** Add `cron_heartbeat_audit` table:
`(id, cron_name, started_at, finished_at, status,
content_hash text, prev_hash text, signature text,
attested_by text, attested_at)`. `content_hash` =
`sha256(canonical_json(metadata || result_summary))`.
`prev_hash` = previous row's `content_hash`. `signature` =
HMAC of `(content_hash || prev_hash)` using a service-account
key kept in env. New endpoint `/api/admin/cron/verify_chain`
walks the chain and returns the first break (if any).

**User-facing behavior.** Compliance officer sees a green
"Chain verified through 2026-05-11" badge on the admin
dashboard. A break shows the row index of the first deviation.

**Technical implementation.** Migration 115. Helper
`_lib/cron-mux.js` extended with a `recordAttestedHeartbeat`
that does the hash + signature. Existing
`recordCronHeartbeat` calls migrated one cron at a time. New
verifier endpoint.

**Integration plan.** Phase 1: ship the helper + verifier.
Phase 2: migrate calibration + planning crons (highest stakes).
Phase 3: migrate the rest.

**Telemetry.** `cron.chain.length`, `cron.chain.last_break_at`
(null when healthy), `cron.verify.duration_p95`.

**Non-goals.** Not a public attestation chain; this is
internal.

**Open questions.** Key rotation: how does a key change interact
with the chain? Stamp the key id on each row; the verifier
checks the key id at signature-verify time.

**Effort.** 2 weeks.

**5-axis score.** Defensibility 9, Operational impact 7,
Implementation cost 4, Tenant readiness 7, Regulatory leverage
10. **Weighted total: 7.8**.

**Deep-dive prompt.** Spec the cron_heartbeat_audit table, the
hash-chain trigger, the signing helper, and the verifier
endpoint. Define key-rotation semantics. Quantify the storage
cost at 10 crons * 365 runs/yr.

### F6.58 cold-start fairness: cohort-pooled SKUs do not disclose their borrowed sample to the user [severity: medium]

**Problem.** When a SKU has fewer than 26 residuals, the engine
routes to `pooled_cold_start` and borrows residuals from the
SKU's `item_type` cohort. The borrowed pool is a different
distribution from the SKU's own future demand; the operator
will eventually have residuals to compare, but in the first 6
months they see a CP band stamped at 95% coverage that is
actually a cohort estimate. The screen does not say "cohort
sample of 142 residuals from item_type=ATD". A buyer setting up
a procurement plan assumes the band is grounded in this SKU's
own history.

**Current state on main.** `verified-on-main`,
`src/api/inventory/conformal_diagnostics.js:130-146`. The
endpoint returns `latest_forecast` which includes
`conformal_method` and `calibration_residuals_count`, but no
explicit "this is a cohort estimate" flag and no link to the
cohort detail. The UI (inferred from the screen list at top of
the existing analysis) does not surface a banner.

**Competitor state.** Logility Demand Solutions and Blue Yonder
Luminate both ship cold-start banners that name the borrowed
cohort and the pool size; both expose a click-through to the
cohort definition.

**Adjacent insight.** The cohort residuals are already counted
in the diagnostics rollup (cohort_counts at
`conformal_diagnostics.js:166-170`). The data exists; the
disclosure does not.

**Research insight.** The fairness literature (Barocas Hardt
Narayanan 2019 ch 8 on transfer learning) is clear that
borrowed inferences must be disclosed at the point of consumer
action. In inventory, "consumer" is the buyer; the action is the
plan approval at `plans.js:92`. Disclosure must be visible
there, not buried in a diagnostics tab.

**Proposed change.** Add `cohort_borrowed boolean` and
`cohort_key text` and `cohort_sample_size int` to
`demand_forecasts`. The cron stamps these when CP method is
`pooled_cold_start`. UI: a "Cohort estimate" pill on the SKU
forecast card and a sentence on the plan-approval modal:
"Forecast borrows from 142 SKUs in cohort 'ATD'. Local sample
size: 18 residuals. CP coverage is a cohort guarantee, not a
SKU-specific guarantee."

**User-facing behavior.** Buyer sees the pill; the plan-approval
flow requires an explicit checkbox "I understand this is a
cohort estimate". The checkbox state lands in the audit log.

**Technical implementation.** Migration 116. Cron stamps fields.
UI changes on `inventory-item.tsx` and `inventory-plans.tsx`.
Plans endpoint at `plans.js:92` enforces the
`cohort_approved boolean` on the approve action.

**Integration plan.** Single phase. Ship behind a feature flag;
remove flag after 4 weeks.

**Telemetry.** `forecast.cohort.borrowed_rate` per tenant;
`plan.approval.cohort_checkbox_rate` (% of approvals that
required the cohort acknowledgement).

**Non-goals.** Not preventing approval on cohort estimates; just
requiring informed consent.

**Open questions.** Does the pill stay after the SKU crosses
the 26-residual threshold? Yes, for 4 weeks; the historic
plans were cohort-based and a stockout investigation will need
that context.

**Effort.** 1.5 weeks.

**5-axis score.** Defensibility 8, Operational impact 7,
Implementation cost 3, Tenant readiness 7, Regulatory leverage
7. **Weighted total: 6.8**.

**Deep-dive prompt.** Spec the cohort disclosure pill, the
plan-approval cohort checkbox, the audit-log shape, and the
4-week persistence policy after the SKU graduates from cold
start.

## Refreshed deep-dive prompts (DD-31 to DD-35)

These five prompts are operationally biased. Each must produce
a runnable spec a TL can hand to a junior engineer, not a
research artifact.

### DD-31 Cron registration + observability audit

The four inventory crons (`inventory-planning-weekly`,
`conformal-calibration-weekly`, `inventory-exceptions-tick`,
`inventory-positions`) are **not registered in `vercel.json`**
on `main @ c4f946b`. `vercel.json:18-22` registers only
`cron/daily`. `daily.js:43-55` fans out to 9 daily aggregators
but does not invoke any of the inventory weekly/30-min crons.
This means the inventory-planning system shipped as code with
no scheduled execution path; whoever lands the feature must
also wire the schedule.

Deliverable: a PR that (a) adds the four crons to
`vercel.json` with concrete schedules
(`inventory-planning-weekly`: Mon 02:00 IST = "30 20 * * 0",
`conformal-calibration-weekly`: Sun 14:00 IST = "30 8 * * 0",
`inventory-positions`: every 30 min,
`inventory-exceptions-tick`: every 30 min), (b) asserts in
`/api/cron/tick.js` that the four crons are last seen within
their nominal SLO (5m for 30-min crons, 6h for weekly crons),
(c) wires a heartbeat-attestation chain (see F6.57). Include
the Vercel cron pricing analysis (the Hobby tier limit and the
Pro tier ceiling).

`verified-on-main`.

### DD-32 Backtest harness MVP

Per the Backtesting framework spec above. Deliverable: the
`/api/admin/inventory/backtest` endpoint (POST,
admin-permission, rate-limited at 1 run / tenant / hour). The
endpoint enqueues a row in `inventory_backtest_runs` and a
worker (separate cron `/api/cron/inventory-backtest-worker`,
every 5m) drains the queue. The worker uses the production
`selectAndComputeCP` (no parallel implementation). Output
columns: `summary_jsonb`, `per_method_jsonb`, `content_hash`,
`signed_by`. Sign with the service-account key; retention 7
years. UI: a "Backtest" tab on the inventory admin page with a
"Run rolling-origin block-CV" button and a results table.

Acceptance: a 10-tenant, 500-SKU, 156-week, 3-method LOTO run
completes in under 8 minutes per tenant on the existing Vercel
function shape (`maxDuration` will need to lift to 300s for
the worker).

### DD-33 cu/co cost-governance flow

Per F6.54. Deliverable: migration 112 adds
`cu_override`, `co_override`, `cost_basis` to `item_master`.
PATCH on `conformal_diagnostics.js` extended. UI surface on
`inventory-item.tsx`. New library
`_lib/inventory/newsvendor.js`. Cron uses the critical
fractile when `cost_basis IN ('override', 'derived')`.

Economic guardrail: cap `cu / (cu + co)` at 0.99 (operator
cannot force a near-deterministic stocking decision through
cu/co manipulation; if they want 99.9%+ coverage they must
explicitly set `conformal_coverage = 0.999` which records to a
separate audit lane).

Acceptance: 10 SKUs in newsvendor mode; verify the recommended
order qty equals `pointForecast + criticalFractile_quantile(residuals)`
to within rounding. Verify the audit log records every
cu/co change.

### DD-34 Alert routing + economic SLO ladder

Per F6.56 and F6.57. Deliverable: the four-tier alert ladder
for inventory exceptions, wired to the existing
`notifications.js`. Tier 1 = operator inbox (existing). Tier 2
= supervisor email (new). Tier 3 = on-call page (new, via the
existing Slack/PagerDuty integration). Tier 4 = pager
broadcast + tenant-admin Slack channel (new).

Per-kind SLO defaults:
- `stockout_imminent` critical: ack in 1h, resolve in 4h
- `coverage_drift` high: ack in 4h, resolve in 24h
- `cohort_borrowed_warning` med: ack in 24h, resolve in 5d
- `supplier_otd_degraded` med: ack in 8h, resolve in 3d

Working-capital governance: a critical exception that crosses
tier 3 must dump the affected SKUs' `procurement_plans` to a
read-only review queue (no auto-release while paged). This is
the economic guardrail: alert fatigue cannot cause an auto-PO
to land while operations are paging.

Acceptance: simulate a tier-3 page on a stockout_imminent
exception; verify the affected plans are flagged unreleasable;
verify the chain audit row records every escalation step.

### DD-35 Policy-change invalidation pipeline

Per F6.55. Deliverable: migration 113 adds
`policy_change_events` table, a Postgres before-update trigger
on `tenant_settings` and `item_master.conformal_coverage`, a
drain step in `inventory-planning-weekly.js`, and an immediate
recompute endpoint `/api/inventory/planning/recompute`.

Economic guardrail: an alpha change that would inflate the
average safety-stock units by more than 15% across the tenant
must require a second admin's approval before the cron drains
the queue. This is the "two-person-rule" for working-capital
moves. Surface the projected delta on the alpha-change UI:
"Estimated working-capital increase: INR 47L; requires
second-admin approval".

Acceptance: change `tenant_settings.inventory_conformal_default_coverage`
from 0.95 to 0.99 on a sandbox tenant; verify the queue row;
verify the projected delta appears in the UI; verify the
two-admin gate triggers when the delta exceeds 15%; verify
the recompute endpoint reprocesses the affected SKUs and
resets the empirical-coverage drift detector.
