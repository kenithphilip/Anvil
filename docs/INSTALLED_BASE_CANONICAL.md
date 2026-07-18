# Canonical installed-base grain (decision)

**Status:** decision record (document-only). No behavior/schema change beyond non-destructive
`COMMENT ON` annotations (migration `170_installed_base_canonical_comments.sql`).
**Context:** Step 1 of the "smallest bridge" from `docs/SPARE_INTELLIGENCE_COMPAT.md` — reconcile the
overlapping installed-base representations onto one canonical grain before any reliability / MEIO work.

---

## The finding

Three tables carry an `installed_qty`-shaped notion, but they are **three different grains**, not three
copies of one thing (an easy misread the compat analysis slightly overstated):

| Table | Grain | What it answers | Real usage |
|---|---|---|---|
| **`equipment_installed_parts`** (mig 006) | **part × equipment-instance** | "How many of part P are installed in equipment E?" | Written by `admin/equipment.js`; read by `cron/inventory-planning-weekly.js` (demand floor). **Load-bearing.** |
| `installed_base` (mig 005) | customer × **gun_model** | "How many guns of model M does customer C have?" | Read by **one** place — `spare_matrix/kit.js`. Near-dead. |
| `recommended_spares.installed_qty` (mig 159) | part × **spare_matrix** | "How many gun rows in this worksheet carry part P?" (a COUNT) | A worksheet aggregate; the spare matrix is standalone, **not linked to equipment**. |

## The decision

1. **`equipment_installed_parts` is the canonical INSTALLED_BASE** — the Part × Asset-instance hinge
   between the design/type world (`item_master` = PRODUCT) and the physical/instance world
   (`equipment_hierarchy` = ASSET). It already plays this role for inventory planning.
2. **`equipment_hierarchy` is the canonical asset-instance registry**, so `installed_base` (005) is
   **redundant**. It was **deprecated** (mig 170) and then **dropped** (mig 177, 2026-07).
   > **Correction (2026-07).** An earlier draft claimed "Customer C has N guns of model M" is a *derived
   > COUNT over `equipment_hierarchy`*. Recon disproved that: `equipment_hierarchy` has **no `gun_model`
   > column** (`gun_type` is `'servo'`/NULL and `gun_no` is an asset tag — different namespaces), the
   > correct aggregate would be `SUM(qty)` not `COUNT(*)`, and the table holds ~0 prod rows. `installed_base`
   > was **not derivable**. It was also demo-only (no app writer) and non-load-bearing (its one reader
   > `kit.js` merely *echoed* it in a response field consumed by no UI), so it was simply removed.
3. **`recommended_spares.installed_qty` is a derived worksheet aggregate, not a source of truth.** It is a
   per-matrix COUNT for the operator's sheet and must not be treated as installed-base data. When the spare
   matrix is later linked to `equipment_hierarchy`, this count should be *sourced* from
   `equipment_installed_parts` rather than maintained independently.

## What this changes now

- **Nothing at runtime.** Only `COMMENT ON` annotations record the decision in the catalog (migration 170),
  and this doc records the rationale. No `kit.js` change, no table drop, no data migration.

## Consolidation — DONE (2026-07, migration 177)

The originally-planned "derive gun-model counts from `equipment_hierarchy` → backfill → drop" sequence was
**invalidated by recon**: `installed_base` is **not derivable** from `equipment_hierarchy` (see the
correction above). The same recon showed it was safe to simply **remove**, because it was demo-only and
non-load-bearing:

1. Removed the `installed_base` read + the dead `installed` echo from `spare_matrix/kit.js` (the spare-kit
   recommendation is built entirely from `spare_recommendations`; no UI consumed the echo).
2. `drop table if exists installed_base` (migration 177) — no reader remained; the RLS policies drop with it.
3. Removed the demo seed rows (`seed/200_master_data.sql`), the teardown delete (`seed/900_teardown.sql`),
   and the verify COUNT (`seed/999_verify.sql`).

The canonical installed-base is `equipment_installed_parts` (part × instance grain), which answers a
*different* question than `installed_base` did; nothing was migrated between them.

## Why it matters (the bridge)

The larger friction (see `SPARE_INTELLIGENCE_COMPAT.md`) is that the type↔instance hinge is joined by
**string matching** — `part_no` is loose TEXT (not an FK to `item_master`) across the operational tables.
Picking one canonical INSTALLED_BASE grain (this doc) is the prerequisite for the next step: promoting
`part_no` → a real `item_id` FK, which turns the string-joined hinge relational.
