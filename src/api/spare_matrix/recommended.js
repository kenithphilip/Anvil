// PATCH /api/spare_matrix/<id>/recommended
// Body: { row_id, recommended_qty?, priority?, item_type?,
//         customer_part_no?, lead_time_days?, remarks?, po_ref? }
//
// Edits one recommended-spares row's human fields. (row_id travels in
// the body — the dynamic router allows only one trailing path segment,
// so /spare_matrix/<id>/recommended/<row_id> is not routable.)

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const EDITABLE = ["recommended_qty", "recommended_min", "recommended_max", "priority", "item_type", "customer_part_no", "lead_time_days", "remarks", "po_ref"];
const NUMERIC = new Set(["recommended_qty", "recommended_min", "recommended_max"]);
const numOrNull = (v) => (v === "" || v == null ? null : Number(v));

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "PATCH" && req.method !== "PUT") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const id = req.query.id;
    const body = await readBody(req);
    const svc = serviceClient();

    // Bulk auto-fill: set recommended_qty across ALL rows of the matrix from
    // a source column in one request, so the operator doesn't type each one.
    //   body.bulk = { source: "max"|"min"|"installed", only_blank?: bool }
    if (body.bulk && typeof body.bulk === "object") {
      if (!id) return json(res, 400, { error: { message: "matrix id required" } });
      const source = String(body.bulk.source || "max").toLowerCase();
      const col = source === "min" ? "recommended_min" : source === "installed" ? "installed_qty" : "recommended_max";
      const onlyBlank = body.bulk.only_blank === true;
      const rowsQ = await svc.from("recommended_spares")
        .select("id, installed_qty, recommended_min, recommended_max, recommended_qty")
        .eq("tenant_id", ctx.tenantId).eq("matrix_id", id);
      if (rowsQ.error) throw new Error(rowsQ.error.message);
      const targets = (rowsQ.data || []).filter((r) => {
        if (onlyBlank && r.recommended_qty != null) return false;
        const v = r[col];
        return v != null && Number(v) !== Number(r.recommended_qty);
      });
      // Per-row updates (each row's qty = its own source value); run in
      // parallel chunks so a big matrix stays fast.
      let updated = 0;
      for (let i = 0; i < targets.length; i += 20) {
        const chunk = targets.slice(i, i + 20);
        await Promise.all(chunk.map(async (r) => {
          const up = await svc.from("recommended_spares")
            .update({ recommended_qty: Number(r[col]), updated_at: new Date().toISOString() })
            .eq("tenant_id", ctx.tenantId).eq("id", r.id);
          if (up.error) throw new Error(up.error.message);
          updated += 1;
        }));
      }
      const fresh = await svc.from("recommended_spares").select("*")
        .eq("tenant_id", ctx.tenantId).eq("matrix_id", id)
        .order("sr_no", { ascending: true, nullsFirst: false });
      if (fresh.error) throw new Error(fresh.error.message);
      await recordAudit(ctx, { action: "spare_matrix_recommended_bulk_fill", objectType: "spare_matrix", objectId: id, detail: { source, only_blank: onlyBlank, updated } });
      return json(res, 200, { updated, source, recommended: fresh.data || [] });
    }

    const rowId = body.row_id || body.id;
    if (!id || !rowId) return json(res, 400, { error: { message: "matrix id and row_id required" } });

    const patch = { updated_at: new Date().toISOString() };
    for (const f of EDITABLE) {
      if (f in body) patch[f] = NUMERIC.has(f) ? numOrNull(body[f]) : (body[f] === "" ? null : body[f]);
    }

    const up = await svc.from("recommended_spares")
      .update(patch)
      .eq("tenant_id", ctx.tenantId).eq("matrix_id", id).eq("id", rowId)
      .select("*").maybeSingle();
    if (up.error) throw new Error(up.error.message);
    if (!up.data) return json(res, 404, { error: { message: "Recommended row not found" } });
    await recordAudit(ctx, { action: "spare_matrix_recommended_edit", objectType: "spare_matrix", objectId: id, detail: { row_id: rowId } });
    return json(res, 200, { row: up.data });
  } catch (err) {
    sendError(res, err);
  }
}
