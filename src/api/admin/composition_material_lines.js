// /api/admin/composition_material_lines
//   GET    ?quote_id=...                lines for a quote
//          ?finished_part_no=...        the saved recipe for a part
//   POST   { quote_id, lines: [...] }   upsert + sync to bill_of_materials
//   DELETE ?id=...
//
// P2 recipe-authoring layer. The drawing-derived raw-material breakup
// an operator records per price-composition line is persisted here and
// SYNCED into bill_of_materials (parent = finished part, child = raw
// material, qty = consumption per unit), so the demand planner's BOM
// explosion is fed automatically from RFQ work. Raw materials referenced
// here are ensured as RAW_MATERIAL item_master rows (planning opt-in).

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { recipeToBomRows } from "../_lib/composition-recipe.js";

const numericKeys = ["density", "gross_qty", "yield_pct", "consumption_per_unit", "unit_cost"];

const buildRow = (tenantId, quoteId, raw) => {
  const row = {
    tenant_id: tenantId,
    quote_id: quoteId,
    composition_line_index: Number(raw.composition_line_index),
    seq: raw.seq != null ? Number(raw.seq) : 0,
    finished_part_no: raw.finished_part_no || null,
    raw_material_part_no: raw.raw_material_part_no,
    material: raw.material || null,
    form: raw.form || null,
    coating: raw.coating || null,
    dimensions: raw.dimensions && typeof raw.dimensions === "object" ? raw.dimensions : {},
    uom: raw.uom || "kg",
    supplier_id: raw.supplier_id || null,
    currency: raw.currency || null,
    notes: raw.notes || null,
    updated_at: new Date().toISOString(),
  };
  for (const k of numericKeys) {
    if (k in raw) row[k] = raw[k] == null || raw[k] === "" ? null : Number(raw[k]);
  }
  return row;
};

// Ensure a raw material referenced by a recipe exists as a RAW_MATERIAL
// item_master row so the operator can planning-enable it. Never clobbers
// an existing row; best-effort (a failure here must not fail the POST).
const ensureRawMaterial = async (svc, tenantId, partNo, label) => {
  try {
    const ex = await svc.from("item_master").select("part_no")
      .eq("tenant_id", tenantId).eq("part_no", partNo).maybeSingle();
    if (ex.data) return;
    await svc.from("item_master").insert({
      tenant_id: tenantId, part_no: partNo, item_type: "RAW_MATERIAL",
      description: label || partNo, planning_enabled: false,
    });
  } catch (_e) { /* best-effort */ }
};

// Recompute bill_of_materials for one finished part from ALL its
// composition material lines (across composition lines), then ensure
// each raw material exists. Returns the number of BOM rows upserted.
const syncFinishedPart = async (svc, tenantId, finishedPartNo) => {
  const all = await svc.from("composition_material_lines")
    .select("finished_part_no, raw_material_part_no, consumption_per_unit, gross_qty, yield_pct, uom, material, form")
    .eq("tenant_id", tenantId).eq("finished_part_no", finishedPartNo);
  if (all.error) throw new Error("recipe read: " + all.error.message);
  const bomRows = recipeToBomRows(all.data || []);
  let written = 0;
  for (const b of bomRows) {
    const up = await svc.from("bill_of_materials").upsert({
      tenant_id: tenantId,
      parent_part_no: b.parent_part_no,
      child_part_no: b.child_part_no,
      qty: b.qty,
      uom: b.uom,
      updated_at: new Date().toISOString(),
    }, { onConflict: "tenant_id,parent_part_no,child_part_no" });
    if (!up.error) written += 1;
    const label = (all.data || []).find((l) => l.raw_material_part_no === b.child_part_no);
    await ensureRawMaterial(svc, tenantId, b.child_part_no, label && (label.material || label.form));
  }
  return written;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let q = svc.from("composition_material_lines").select("*").eq("tenant_id", ctx.tenantId);
      if (req.query.quote_id) q = q.eq("quote_id", req.query.quote_id);
      else if (req.query.finished_part_no) q = q.eq("finished_part_no", req.query.finished_part_no);
      else return json(res, 400, { error: { message: "quote_id or finished_part_no required" } });
      const { data, error } = await q.order("composition_line_index", { ascending: true }).order("seq", { ascending: true });
      if (error) throw new Error(error.message);
      return json(res, 200, { lines: data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body.quote_id) return json(res, 400, { error: { message: "quote_id required" } });
      const inputs = Array.isArray(body.lines) ? body.lines : (body.composition_line_index != null ? [body] : []);
      if (!inputs.length) return json(res, 400, { error: { message: "no lines supplied" } });

      const out = [];
      for (const ln of inputs) {
        if (ln.composition_line_index == null) continue;
        if (!ln.raw_material_part_no) {
          return json(res, 400, { error: { message: "raw_material_part_no required on every line" } });
        }
        const row = buildRow(ctx.tenantId, body.quote_id, ln);
        const upsert = await svc.from("composition_material_lines")
          .upsert(row, { onConflict: "tenant_id,quote_id,composition_line_index,seq" })
          .select("*").single();
        if (upsert.error) throw new Error(upsert.error.message);
        out.push(upsert.data);
      }

      // Sync each affected finished part's recipe into bill_of_materials.
      const finishedParts = [...new Set(out.map((r) => r.finished_part_no).filter(Boolean))];
      let bomWritten = 0;
      for (const fp of finishedParts) bomWritten += await syncFinishedPart(svc, ctx.tenantId, fp);

      await recordAudit(ctx, {
        action: "composition_material_lines_upsert",
        objectType: "quote", objectId: body.quote_id,
        after: { lines: out.length, finished_parts: finishedParts.length, bom_rows: bomWritten },
      });
      return json(res, 200, { lines: out, bom_synced: bomWritten, finished_parts: finishedParts });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "write");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("composition_material_lines")
        .delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
