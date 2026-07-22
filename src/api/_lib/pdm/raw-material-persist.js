// PDM raw-material determination (Slice D2): persist a determined + reviewed
// raw-material verdict as a STANDALONE recipe.
//
//   make          -> upsert composition_material_lines (quote_id null) with the
//                    grade / form / density / stock dims / gross+consumption
//                    mass, ensure the raw-material item exists, and sync the
//                    bill_of_materials edge (finished -> raw) so the demand
//                    explosion feeds raw-material procurement. Sets
//                    item_master.procurement_type = 'make'.
//   buy / raw     -> sets item_master.procurement_type only. NO recipe — a
//                    bought-out part is never given a raw-material breakup, so
//                    it is never forecast as raw material.
//
// The pure builders are exported for tests; persistDetermination does the I/O.

import { recipeToBomRows } from "../composition-recipe.js";

const sanitize = (s) => String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// Deterministic raw-material SKU from grade + form, so every part machined from
// (e.g.) CuCrZr rod aggregates demand onto ONE raw material — "RM-CUCRZR-ROD".
export const rawMaterialPartNo = (material, form) => {
  const g = sanitize(material);
  const f = sanitize(form);
  const parts = ["RM", g || "MATERIAL", f].filter(Boolean);
  return parts.join("-");
};

// Build the standalone composition_material_lines row from a make verdict's
// recipe. Pure. Returns null if the verdict isn't a make with a recipe.
export const buildRecipeRow = (tenantId, finishedPartNo, verdict, nowIso) => {
  if (!verdict || verdict.procurement_type !== "make" || !verdict.recipe) return null;
  const r = verdict.recipe;
  const rawNo = rawMaterialPartNo(r.material, r.form);
  return {
    tenant_id: tenantId,
    quote_id: null,
    composition_line_index: 0,
    seq: 0,
    finished_part_no: finishedPartNo,
    raw_material_part_no: rawNo,
    material: r.material || null,
    form: r.form || null,
    density: r.density ?? null,
    dimensions: r.stock_dims && typeof r.stock_dims === "object" ? r.stock_dims : {},
    gross_qty: r.gross_mass_kg ?? null,
    yield_pct: r.yield_pct ?? null,
    consumption_per_unit: r.consumption_per_unit_kg ?? null,
    uom: r.uom || "kg",
    updated_at: nowIso,
  };
};

// Best-effort: ensure the raw material exists as a RAW_MATERIAL item so the
// operator can planning-enable it. Never clobbers an existing row.
const ensureRawMaterial = async (svc, tenantId, partNo, label) => {
  try {
    const ex = await svc.from("item_master").select("part_no")
      .eq("tenant_id", tenantId).eq("part_no", partNo).maybeSingle();
    if (ex.data) return;
    await svc.from("item_master").insert({
      tenant_id: tenantId, part_no: partNo, item_type: "RAW_MATERIAL",
      description: label || partNo, planning_enabled: false, procurement_type: "raw_material",
    });
  } catch (_e) { /* best-effort */ }
};

// Set item_master.procurement_type on the finished part (enrichment; only when
// the item exists — we don't invent finished-good rows here).
const setProcurementType = async (svc, tenantId, partNo, type) => {
  const up = await svc.from("item_master")
    .update({ procurement_type: type })
    .eq("tenant_id", tenantId).eq("part_no", partNo);
  if (up.error) throw new Error("procurement_type: " + up.error.message);
};

// Persist a reviewed verdict. Returns { procurement_type, raw_material_part_no?,
// recipe_saved, bom_synced }.
export const persistDetermination = async (svc, tenantId, { finished_part_no, verdict }, nowIso = new Date().toISOString()) => {
  const partNo = String(finished_part_no || "").trim();
  if (!partNo) { const e = new Error("finished_part_no required"); e.status = 400; throw e; }
  const type = verdict && verdict.procurement_type;
  if (!["make", "buy", "raw_material"].includes(type)) { const e = new Error("verdict.procurement_type must be make|buy|raw_material"); e.status = 400; throw e; }

  await setProcurementType(svc, tenantId, partNo, type);

  if (type !== "make") {
    return { procurement_type: type, raw_material_part_no: null, recipe_saved: false, bom_synced: 0 };
  }

  const row = buildRecipeRow(tenantId, partNo, verdict, nowIso);
  if (!row) { const e = new Error("make verdict is missing a recipe"); e.status = 400; throw e; }

  // Upsert the standalone recipe (manual: the standalone unique index is
  // partial, which PostgREST's onConflict can't target directly).
  const existing = await svc.from("composition_material_lines")
    .select("id")
    .eq("tenant_id", tenantId).eq("finished_part_no", partNo)
    .eq("raw_material_part_no", row.raw_material_part_no).is("quote_id", null)
    .maybeSingle();
  if (existing.error) throw new Error("recipe read: " + existing.error.message);
  if (existing.data) {
    const upd = await svc.from("composition_material_lines").update(row).eq("id", existing.data.id);
    if (upd.error) throw new Error("recipe update: " + upd.error.message);
  } else {
    const ins = await svc.from("composition_material_lines").insert(row);
    if (ins.error) throw new Error("recipe insert: " + ins.error.message);
  }

  await ensureRawMaterial(svc, tenantId, row.raw_material_part_no, row.material || row.form);

  // Sync the bill_of_materials edge (finished -> raw, qty = consumption/unit).
  let bomSynced = 0;
  for (const b of recipeToBomRows([row])) {
    const up = await svc.from("bill_of_materials").upsert({
      tenant_id: tenantId, parent_part_no: b.parent_part_no, child_part_no: b.child_part_no,
      qty: b.qty, uom: b.uom, updated_at: nowIso,
    }, { onConflict: "tenant_id,parent_part_no,child_part_no" });
    if (!up.error) bomSynced += 1;
  }

  return { procurement_type: "make", raw_material_part_no: row.raw_material_part_no, recipe_saved: true, bom_synced: bomSynced };
};
