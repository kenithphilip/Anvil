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
2. **`equipment_hierarchy` is the canonical asset-instance registry.** "Customer C has N guns of model M"
   is a **derived COUNT** over `equipment_hierarchy` gun instances — so `installed_base` (005) is
   **redundant** and is hereby **deprecated**. It is not dropped yet (its one reader, `kit.js`, still uses
   it, and some tenants may hold `installed_base` rows without matching `equipment_hierarchy` instances).
3. **`recommended_spares.installed_qty` is a derived worksheet aggregate, not a source of truth.** It is a
   per-matrix COUNT for the operator's sheet and must not be treated as installed-base data. When the spare
   matrix is later linked to `equipment_hierarchy`, this count should be *sourced* from
   `equipment_installed_parts` rather than maintained independently.

## What this changes now

- **Nothing at runtime.** Only `COMMENT ON` annotations record the decision in the catalog (migration 170),
  and this doc records the rationale. No `kit.js` change, no table drop, no data migration.

## Deferred consolidation (a later step, not this one)

To actually collapse to one source of truth (chosen scope was *document-only*):
1. Repoint `kit.js` to derive gun-model counts from `equipment_hierarchy`, keeping an `installed_base`
   fallback so no tenant loses kit prediction.
2. Backfill `equipment_hierarchy` gun instances from any `installed_base` rows that lack them.
3. Drop `installed_base` (005) once no reader remains.

This is deliberately **not** done here because it is a destructive, data-shape-risky migration; it should be
its own reviewed change once multi-asset (non-welding) usage makes `equipment_hierarchy` the universal
registry.

## Why it matters (the bridge)

The larger friction (see `SPARE_INTELLIGENCE_COMPAT.md`) is that the type↔instance hinge is joined by
**string matching** — `part_no` is loose TEXT (not an FK to `item_master`) across the operational tables.
Picking one canonical INSTALLED_BASE grain (this doc) is the prerequisite for the next step: promoting
`part_no` → a real `item_id` FK, which turns the string-joined hinge relational.
