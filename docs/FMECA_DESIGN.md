# FMECA criticality (bridge step 4c)

**Status:** design. Addresses `docs/SPARE_INTELLIGENCE_COMPAT.md` friction #6 — today's `criticality_score` is a *sourcing heuristic wearing an FMECA name*, and surfacing it to reliability engineers would mislead. This step ships a **real** FMECA: severity × occurrence × detection → RPN.

---

## What exists today (recon)

- **`criticality_score`** (`spare_matrix/recommend.js`) is a 0–100 **sales/BOM/lead** heuristic (`usageScore 0–40 + bomScore 0–20 + recencyScore 0–20 + leadScore 0–20`), stored in `spare_recommendations`. It has **no** severity/occurrence/detection/RPN.
- It drives **almost nothing**: display + sort order in the sales-outreach sub-tabs (Recommendations / Kit / Opportunities). The one hook into the (s,S) `computeMinMax` (`critMult`) is **dead in production** (its sole caller doesn't pass the score → `critMult = 1.0`). The planning cron is criticality-blind.
- **`is_critical` / `is_emergency_only`** (`equipment_installed_parts`) + `item_master.is_critical` are **decorative** — stored/editable, read by no stock math.
- **No failure-mode catalog** exists — `failure_events.failure_mode` (mig 174) is freeform text with no enum/FK; the only controlled vocabulary is `event_type` (breakdown|pm|inspection|replacement).

So a real FMECA is **net-new**, not a replacement of anything load-bearing.

---

## Data model — two new tables

### 1. `failure_mode_catalog` (the missing taxonomy)
Modeled on `lost_reason_taxonomy` (006:640): `id uuid`, **`tenant_id uuid` NULLABLE** (NULL = global seed rows visible to all tenants), `code text`, `label text`, `category text`, `active bool`, `unique (tenant_id, code)`, NULL-passthrough RLS (`tenant_id is null or tenant_id in (select current_tenant_ids())`). Seeded with a starter set of welding-gun modes (electrode/tip wear, shank fracture, cable fatigue, transformer fault, seizure, ...) + generic modes; tenants add their own.

### 2. `fmeca_criticality` (the FMECA records)
Grain **`(tenant_id, part_no, failure_mode_id)`** — a part fails several ways, each with its own S/O/D. Dedup keys on `part_no` (not the trigger-derived `item_id`, which is NULL for unmastered parts); `item_id` is a resolved join column. Copies `failure_events` (174) conventions verbatim:
- `id uuid pk default uuid_generate_v4()`, `tenant_id uuid not null references tenants(id) on delete cascade`
- `item_id uuid references item_master(id) on delete set null` + denormalized `part_no text` (reuse the shared `set_item_id_from_part_no` trigger)
- `failure_mode_id uuid not null references failure_mode_catalog(id)`
- `asset_class text` **nullable** — lets the same part carry different criticality in different asset classes (optional; the primary record ignores it = NULL)
- `severity smallint` (1–10), `occurrence smallint` (1–10), `detection smallint` (1–10), each `check between 1 and 10`
- `rpn` — stored `severity*occurrence*detection` (kept in sync by a small trigger, or computed on read; see below)
- `suggested_occurrence smallint` + `occurrence_basis jsonb` (the auto-suggest evidence: event count, window, so the engineer sees *why*)
- `notes text`, `created_by uuid` (bare — `ctx.user.id`), `created_at` / `updated_at timestamptz`
- `unique (tenant_id, part_no, failure_mode_id)` (dedup on `part_no` — the key the engineer authors against, always present; a `(tenant, item_id, mode)` unique would let parts not yet in `item_master`, whose trigger-derived `item_id` is NULL, insert duplicates under NULLS-DISTINCT), indexes on `(tenant_id, item_id)`, `(tenant_id, rpn)`
- RLS = the 159 tenant pattern. Idempotent, applied manually.

### Why `item_id`, not `part_no`
`item_master` is the golden record; `failure_events` already carries `item_id` (auto-resolved by the 171 trigger), so the occurrence rollup `GROUP BY item_id` joins with zero string juggling. `part_no` stays denormalized for display/fallback. (Unmatched parts — `item_id` NULL — simply don't roll up; that surfaces a data-quality gap, consistent with `buildHistory`/`reliabilityFloor`.)

---

## Occurrence auto-suggest (the failure_events tie-in)

Occurrence (1–10) is a rated failure **frequency**, and it's the *only* FMECA dimension with a data source today. Suggested from `failure_events` over the **same window + filter the planning cron uses** (so demand and criticality agree on what a failure is):

```sql
select item_id, failure_mode, count(*) as n_events, coalesce(sum(replaced_qty),0) as qty
from failure_events
where tenant_id = $1
  and failed_at >= now() - interval '104 weeks'       -- HISTORY_WEEKS (cron:111)
  and event_type in ('breakdown','replacement')        -- cron:147
  and item_id is not null
group by item_id, failure_mode;
```

Annualize the count and step it through a standard FMECA log-frequency ladder (0 → 1; ≤0.5/yr → 2–3; ~1/yr → 4; ~1/qtr → 6; ~1/mo → 8; ≥weekly → 9–10). Emit as `suggested_occurrence` + `occurrence_basis` — the engineer **accepts or overrides**; it is never silently authoritative.

- **Severity + Detection have no data source** — they are **human-authored** (optionally seeded with per-`asset_class` template defaults later).
- `downtime_hours` is *downtime, not runtime* → **not** a valid rate denominator. A true rate needs a population/runtime exposure (installed count) — hence occurrence is a suggestion, not authority.
- Freeform `failure_mode` strings on existing `failure_events` are matched to catalog `code`/`label` best-effort for the rollup; a catalog-backed datalist on the failure_events UI (a one-line change) starts collecting clean modes going forward.

---

## RPN consumption — v1 is a pure artifact

Safest-first (recon's ranking):

- **(v1, this step) Pure reliability artifact** — own tables + RLS + endpoint + screen; reliability engineers rate S/O/D, RPN sorts the worklist. **Zero blast radius** on quotes / min-max / forecast / safety-stock. Mirrors exactly how `failure_events` (4a) landed additive + isolated.
- **(later, gated) Augment `criticality_score`** — add an `rpn`-derived multiplier into `computeMinMax` **alongside** `critMult`, behind a per-tenant flag (like `reliability_demand_enabled`, mig 175). Do **not** overwrite the sales heuristic — keep the two signals separate. Medium risk (feeds quotes); its own reviewed step.
- **(avoid) Feed safety stock like 4b's `reliabilityFloor`** — a category error: occurrence would **double-count** the same `failure_events` signal the reliability floor already uses, and severity/detection aren't demand-variability inputs. At most, severity could justify a higher service-level `alpha` — a separate explicit business decision, not a floor.

---

## Change set (v1)

| Area | Change |
|---|---|
| Migration | `failure_mode_catalog` + `fmeca_criticality` tables + RLS + indexes + the shared item_id trigger; seed a starter global mode catalog. |
| API | `/api/fmeca` — list/upsert catalog modes; list/upsert FMECA rows (RPN computed); an occurrence-suggest read that rolls up `failure_events`. `resolveContext` + `requirePermission` + `recordAudit`. |
| Client + UI | bridge `fmeca` group; an FMECA screen (or a tab) to pick part + mode, see the `suggested_occurrence` evidence, enter S/O/D, and view the RPN-sorted worklist. Add a catalog datalist to the `failure_events` failure_mode input. |

No change to `recommend.js`, `computeMinMax`, the planning cron, or `criticality_score`. Additive + isolated.

## Deferred
Per-`asset_class` S/D template seeding; the gated `criticality_score` augmentation; a true installed-population MTBF denominator for occurrence.
