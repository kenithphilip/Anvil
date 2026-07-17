# Reliability-driven demand + safety stock (bridge step 4b)

**Status:** design + implementation. Wires the `failure_events` stream (step 4a, migration 174) into the weekly inventory-planning engine. Grounded in a code-level audit of `src/api/cron/inventory-planning-weekly.js` + `src/api/_lib/inventory/*`.

**The gap (SPARE_INTELLIGENCE_COMPAT.md friction #4 & #6):** the planning engine's trained demand history comes *only* from `order_schedule_lines` (a sell-through / shipment proxy). Field consumption of installed spares — the thing a reliability-driven spare model is actually about — never reaches the forecast. And `criticality_score` is a sourcing heuristic that the planning cron does not even read; safety stock is reliability-blind.

---

## The one hard invariant: it lands dark

Everything here is gated on a **new per-tenant flag** `tenant_settings.reliability_demand_enabled` (migration 175, `default false`), read once as `reliabilityOn = !!cfg.reliability_demand_enabled` right after the settings row loads. It mirrors the existing `inventory_conformal_enabled` master switch, which was itself designed to land before any tenant opts in.

**Guarantee:** with the flag off (every existing tenant), `buildHistory` returns the exact schedule-only history and `safetyStock()` receives `reliabilityFloor = 0`, so **every forecast, safety-stock and reorder-point value is byte-identical to today.** Step 4b provably cannot move a number until a tenant flips the flag. Migrations apply manually, so even the flag column is inert until run.

---

## Two mechanisms (both gated)

### 1. Consumption → demand history (the blend)

The single seam is the per-part `Map<part_no, Map<isoWeek, qty>>` that `buildHistory` returns (`inventory-planning-weekly.js:116`). It is the *only* input to `classifyDemand`, the forecaster, `residualSigma`, `wape`, and the conformal residual capture. So folding a second source into that one map reaches every trained-history consumer with zero downstream change.

When `reliabilityOn`, `buildHistory` runs a second read over the **same 104-week window**:

```
failure_events
  .select("part_no, replaced_qty, failed_at, event_type")
  .eq("tenant_id", tenantId)
  .gte("failed_at", addWeeks(isoWeekStart(now), -HISTORY_WEEKS))
  .in("part_no", parts)
  .in("event_type", ["breakdown", "replacement"])   -- consumption events only; pm/inspection excluded
```

and folds `replaced_qty` into the same map via `isoWeekStart(failed_at)` — byte-for-byte the `order_schedule_lines` bucketing. `replaced_qty` is nullable (`Number(null)||0 = 0`), so a breakdown with no part swap contributes 0 demand (pure reliability signal, doesn't inflate the forecast).

**Semantics — additive blend.** Schedule lines (sold/shipped) and field replacements (consumed) are *distinct* demand streams on inventory; summing them corrects the schedule proxy's systematic *under-count* of true consumption, which is the whole point of friction #4. A per-part `history_source` mode (schedule | consumption | blend) is a natural later refinement; v1 is a plain additive union so there is one obvious behavior.

Downstream this shifts the demand **class** (a part that only fails, never sells, moves from `new`/`smooth` to `intermittent`/`lumpy`, correctly routing to the gamma safety-stock formula), the **baseline mean**, and the **residual sigma**.

### 2. MTBF / failure-rate → safety stock (the reliability floor)

`safetyStock()` already takes `max(statSS, projectFloor)`. We add a **third candidate**, `reliabilityFloor`, computed in a new pure module `_lib/inventory/reliability.js`:

```
lambda        = totalReplacedQty / HISTORY_WEEKS          -- avg weekly replacement rate
expDuringLT   = lambda * leadTimeWeeks                    -- expected replacements over one lead time
reliabilityFloor = z(alpha) * sqrt(expDuringLT)          -- service-scaled Poisson std of failure arrivals
```

**Why this and not a demand floor.** The consumption blend already puts `replaced_qty` into the *mean* (→ `baselineMean` → `reorder_point = ltdMean + ss`), so expected replacement demand is covered. A separate demand floor would double-count. The distinct, missing piece is *buffer for the variability of an intermittent failure process*: a critical part that rarely sells but fails unpredictably has a near-zero schedule-based statistical SS today. `z(alpha)·√(λ·LT)` is the Poisson standard deviation of failure arrivals during a lead time, scaled to the part's service level — a minimum safety buffer sized to how erratically it breaks.

**Non-double-counting is structural:** it enters through `max(statSS, projectFloor, reliabilityFloor)`, so it only raises SS when it *exceeds* the statistical + project candidates; it can never stack on top of them.

**Override-safe:** the floor is folded into the same `max()` that the conformal path re-maxes at `cpSafetyStock` (`inventory-planning-weekly.js:447`), so it applies for conformal tenants too — unlike a service-level (`alpha`) bump, which the conformal band would bypass.

---

## Change set

| File | Change |
|---|---|
| `supabase/migrations/175_reliability_demand_flag.sql` | `tenant_settings.reliability_demand_enabled boolean not null default false` + comment. Idempotent. |
| `src/api/_lib/inventory/reliability.js` (new) | pure `weeklyFailureRate()` + `reliabilityFloor()` (imports `standardNormalInverse` from safety-stock). Unit-tested. |
| `src/api/_lib/inventory/safety-stock.js` | `safetyStock()` gains `reliabilityFloor = 0` param, folded into the `max()` and reported in `breakdown`. Default 0 ⇒ existing callers unchanged. |
| `src/api/cron/inventory-planning-weekly.js` | read `reliabilityOn`; `buildHistory(svc, tenantId, parts, reliabilityOn)` does the gated blend + returns per-part `failureTotals`; per item, compute `reliabilityFloor` (gated) and pass it into `safetyStock()`. |

No new write-back columns: the reliability contribution flows through the existing `safety_stock` / `reorder_point` write-backs, and appears in the `safetyStock().breakdown` JSON for transparency.

---

## Deliberately deferred (NOT in 4b)

- **Interior zero-fill bug.** `histArr` assembly (`inventory-planning-weekly.js:347-351`) builds the array from a *sparse* week map, so interior zero-weeks between two demand weeks collapse — corrupting ADI/CV² in `classifyDemand` and Croston interval smoothing. This is a **pre-existing** defect and its fix is **not gated** (it runs for every tenant), so fixing it here would violate the land-dark invariant. It is its own reviewed change.
- Per-part `history_source` mode + blend weights.
- A reliability write-back column (`mtbf_days` / `failure_rate` / `reliability_class`) on `item_master`.
- FMECA-real criticality (step 4c) and MEIO / location dimension (step 4d).

---

## Rollout

1. Land the code + migration (dark). Apply migration 175.
2. Flip `reliability_demand_enabled = true` for **one pilot tenant** that has real `failure_events`.
3. Run the weekly cron (or a manual replan); diff `demand_forecasts` / `item_master.safety_stock` before/after for that tenant; confirm movement is explained by the logged failures.
4. Roll out per tenant as field-failure logging matures.

## Risks

- **Data quality:** garbage `replaced_qty` inflates demand. Mitigated by the `event_type` filter, the opt-in flag, and per-tenant rollout.
- **Part-number join:** the cron joins on loose-text `part_no` (same limitation as the schedule path). `item_id` (from 171) exists on `failure_events` but the whole cron is `part_no`-keyed; migrating it to `item_id` is orthogonal future work.
- **Reliability floor vs blend double-count:** structurally safe — the blend feeds the *mean*, the floor enters only via `max()`, so the floor never stacks on the statistical SS.
- **Additive-blend double-count (known v1 limitation):** if the *same physical unit* is recorded in both `order_schedule_lines` (sold) and `failure_events` (replaced) in the same week, the additive union counts it twice. Accepted for v1 because it is opt-in, and the schedule proxy's systematic *under-count* of field consumption is the larger error being corrected. Mitigations: the per-tenant pilot validation step below (diff before/after and confirm movement matches logged failures), and the deferred per-part `history_source` mode (schedule | consumption | blend) which lets a tenant that already books field replacements as sales pick `schedule` and avoid the overlap.
