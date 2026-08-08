// GET /api/spare_matrix/drawings/list?matrix_id=...&status=staged|committed|discarded&kind=...
//   or ?gun_no=...  — a gun's drawings across ALL matrices (the BOM / gun-view
//                     shortcut; uses gun_drawings_gun_idx). Pass status=committed.
//
// Lists gun_drawings for a matrix — the review queue (status=staged), the
// committed set (per-gun EG/2D/3D), or the full upload track — OR by gun_no.
// Read-only.

import { applyCors, handlePreflight, json, sendError } from "../../_lib/cors.js";
import { resolveContext, requirePermission } from "../../_lib/auth.js";
import { serviceClient } from "../../_lib/supabase.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const matrixId = req.query.matrix_id;
    const gunNo = req.query.gun_no;
    if (!matrixId && !gunNo) return json(res, 400, { error: { message: "matrix_id or gun_no required" } });

    const svc = serviceClient();
    // Either matrix-scoped (the review/track feed) or by gun_no across every
    // matrix (the BOM / gun-view drawings shortcut — gun_drawings_gun_idx).
    let q = svc.from("gun_drawings").select("*").eq("tenant_id", ctx.tenantId);
    if (matrixId) q = q.eq("matrix_id", matrixId);
    if (gunNo) q = q.eq("gun_no", gunNo);
    if (req.query.status) q = q.eq("status", req.query.status);
    if (req.query.kind) q = q.eq("kind", req.query.kind);
    q = q.order("created_at", { ascending: false });
    const { data, error } = await q;
    if (error) throw new Error(error.message);

    return json(res, 200, { drawings: data || [] });
  } catch (err) {
    sendError(res, err);
  }
}
