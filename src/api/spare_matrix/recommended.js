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

const EDITABLE = ["recommended_qty", "priority", "item_type", "customer_part_no", "lead_time_days", "remarks", "po_ref"];
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
    const rowId = body.row_id || body.id;
    if (!id || !rowId) return json(res, 400, { error: { message: "matrix id and row_id required" } });
    const svc = serviceClient();

    const patch = { updated_at: new Date().toISOString() };
    for (const f of EDITABLE) {
      if (f in body) patch[f] = f === "recommended_qty" ? numOrNull(body[f]) : (body[f] === "" ? null : body[f]);
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
