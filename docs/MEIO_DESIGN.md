# Location dimension / MEIO (bridge step 4d)

**Status:** design. Addresses `docs/SPARE_INTELLIGENCE_COMPAT.md` friction #3 — the inventory engine is single-location: every T3 table is keyed `(tenant_id, part_no)` with no location/echelon dimension. Grounded in a code-level audit of the planning engine + inventory schema.

> The compat doc explicitly flags MEIO as "expensive; defer until multi-warehouse demand is real." This design **phases** it so the safe, additive foundation lands first and the risky optimizer rewrite is deferred.

---

## What exists today

- **No internal stocking-location master.** The only location table is `customer_locations` (mig 006 — customer *ship-to* sites, not internal stock). ERP mirror tables *do* carry warehouse/site (`d365_inventory_balances.warehouse/site`, acumatica/p21 `warehouse`), but `_lib/inventory/positions.js:readSource` **sums across warehouses per part** and `reconcile()` collapses across ERP sources into one `union` row per `(part, as_of)` — location is discarded two layers before the engine.
- **6 part-keyed T3 tables, zero location dimension:** `inventory_positions` `unique(tenant_id,part_no,as_of,source)`, `demand_forecasts` `unique(tenant_id,part_no,week_start,model_name)`, `conformal_calibration_residuals` `unique(tenant_id,part_no,week_start)`, `procurement_plans` (no unique — app-level dedup), `inventory_exceptions` (no unique — fingerprint dedup), and `item_master.{safety_stock,reorder_point,demand_class}` (single scalar per part, written by the cron on `(tenant_id,part_no)`).
- **The cron is single-location at every layer** (`inventory-planning-weekly.js`): reads one `union` position per part (`:289-300`), one per-item planning loop (`:379-706`), writes back per `(tenant,part)`.
- **`safety-stock.js` / `net-req.js` are pure scalar-per-part math** — location-agnostic and **reusable** as-is.
- **No transfer/rebalance concept** intra-tenant (`network_sourcing` mig 037 is *inter-tenant* trade, not MEIO). Exception kinds are a 9-value DB CHECK (`085:360`).

`inventory_positions.source` is an **ERP-provenance** discriminator (tally/netsuite/…/`union`), **not** a location — MEIO needs a *separate* `location_id`.

---

## The phased plan

### Phase A — location foundation (additive, gated, zero behavior change) — DO FIRST
1. A new **`locations`** stocking-location master (modeled on `customer_locations`: `location_code`, `name`, `gstin`, `state_code`, address, `is_default`; `unique(tenant_id, location_code)`) + a warehouses CRUD endpoint + a small admin screen.
2. A **nullable `location_id uuid references locations(id)`** on the 6 planning tables + `item_master` planning cols. **Unique keys are left unchanged** — the engine keeps writing `location_id = NULL` (one implicit location), so dedup and every plan output are **byte-identical**.
3. `tenant_settings.inventory_meio_enabled boolean not null default false` — the dark master switch, mirroring `inventory_conformal_enabled` / `reliability_demand_enabled` / `inventory_dense_history_enabled`.

Phase A touches **no engine code** and changes **no plan output**. It lays the full data model + lets a tenant define warehouses, deferring all optimization.

### Phase B — per-location planning (the T3 rewrite) — DEFER
Wrap `planTenant`'s per-item loop (`:379-706`) in a per-location loop; make `positionByPart` → `positionByPartLocation`; stop `positions.js` collapsing warehouse/site; thread `location_id` into the unique keys (with a NOT-NULL `DEFAULT` sentinel location so existing single-location dedup still holds) + the app-level dedup SELECTs + the `item_master` write-back (which needs a per-`(part,location)` home). Gated by `inventory_meio_enabled`. **Moderate-high risk** — it changes what every enabled tenant's engine computes; must stay strictly behind the flag.

### Phase C — echelon optimization + transfer/rebalance — DEFER (depends on A+B)
A new echelon-SS module (risk pooling / Clark-Scarf) feeding **pooled** demand+lead-time stats into the *same* `safetyStock()` leaves + a network allocator; a transfer/rebalance optimizer (lateral transfer vs PO); a **new exception kind** (`rebalance_recommended`, widening the `085:360` CHECK) + a transfer-plan artifact. **Highest risk.**

---

## Why Phase A first

- **Additive + dark:** nullable `location_id`, unchanged unique keys, flag default false → the planning engine is untouched and every number is identical. Same land-dark discipline as conformal / reliability / dense-history.
- **It's the prerequisite:** B and C are meaningless without a location master + the columns. A ships the model; B/C consume it when multi-warehouse demand is real.
- **Honest to the compat doc:** don't build the expensive echelon optimizer speculatively.

## Optional value-add within A (a scope choice)
Stop `positions.js` discarding the ERP warehouse/site it already receives, and persist **per-location `inventory_positions` rows for visibility only** (a per-location on-hand view) — *not* fed into the planning loop. This needs the `inventory_positions` unique key to absorb `location_id` (with a sentinel for the `union`/single row) + a `positions.js` change, so it's more invasive than the pure foundation, but it turns discarded ERP data into an immediate multi-location on-hand insight.

## Risks
- **Unique-key handling** is the one real subtlety: adding `location_id` to a unique key with NULLs-distinct breaks dedup. Phase A avoids it (keys unchanged, `location_id` nullable + unused by dedup); Phase B introduces a NOT-NULL `DEFAULT` sentinel.
- **Pre-existing (out of scope, flagged):** `positions.js` maps d365 as `part:'item_id', onHand:'available_physical'`, but `d365_inventory_balances` has `product_external_id`/`quantity_on_hand` — the d365 mirror read looks broken. Verify separately.
