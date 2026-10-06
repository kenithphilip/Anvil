// POST /api/spare_matrix/drawings/update
// Body: { id, gun_no?, row_id?, kind?, link_url?, status?, approval_status? }
//
// Correct a STAGED drawing after upload: reassign it to the right gun
// (gun_no, resolving row_id from the matrix), change the kind, attach/replace
// a 3D link, discard it (status='discarded'), or set an approval decision
// (provision; no gate enforced yet). A manual gun reassignment marks
// match_status='resolved'. Records the reviewer.

import { applyCors, handlePreflight, json, readBody, sendError } from "../../_lib/cors.js";
import { resolveContext, requirePermission } from "../../_lib/auth.js";
import { serviceClient } from "../../_lib/supabase.js";
import { normGun, formatOf, KIND_FORMATS } from "../../_lib/gun-drawing-match.js";

const KINDS = new Set(["eg_sheet", "drawing_2d", "drawing_3d"]);
const STATUSES = new Set(["staged", "committed", "discarded"]);
const APPROVALS = new Set(["pending", "approved", "rejected"]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = await readBody(req);
    if (!body.id) return json(res, 400, { error: { message: "id required" } });

    const svc = serviceClient();
    const cur = await svc.from("gun_drawings").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.id).maybeSingle();
    if (cur.error) throw new Error(cur.error.message);
    if (!cur.data) return json(res, 404, { error: { message: "drawing not found" } });
    const row = cur.data;

    const patch = { reviewed_by: (ctx.user && ctx.user.id) || null, reviewed_at: new Date().toISOString() };

    // Kind change -> re-validate the format against the new kind.
    let kind = row.kind;
    if (body.kind !== undefined) {
      if (!KINDS.has(body.kind)) return json(res, 400, { error: { message: "invalid kind" } });
      kind = body.kind;
      patch.kind = kind;
    }
    if (body.link_url !== undefined) { patch.link_url = body.link_url || null; if (body.link_url) patch.format = "link"; }
    if (body.status !== undefined) {
      if (!STATUSES.has(body.status)) return json(res, 400, { error: { message: "invalid status" } });
      patch.status = body.status;
    }
    if (body.approval_status !== undefined) {
      if (!APPROVALS.has(body.approval_status)) return json(res, 400, { error: { message: "invalid approval_status" } });
      patch.approval_status = body.approval_status;
    }

    // Manual gun (re)assignment: resolve the row_id within this matrix and
    // mark the match resolved (unless the file format is wrong for the kind).
    if (body.gun_no !== undefined || body.row_id !== undefined) {
      let rowId = body.row_id || null;
      let gunNo = body.gun_no || null;
      if (gunNo && !rowId) {
        const guns = await svc.from("spare_matrix_rows").select("id, gun_no")
          .eq("tenant_id", ctx.tenantId).eq("matrix_id", row.matrix_id);
        if (guns.error) throw new Error(guns.error.message);
        const hit = (guns.data || []).find((g) => normGun(g.gun_no) === normGun(gunNo));
        if (hit) rowId = hit.id;
      }
      patch.gun_no = gunNo;
      patch.row_id = rowId;
      const fmt = patch.format || row.format;
      const allowed = KIND_FORMATS[kind];
      patch.match_status = (allowed && fmt && fmt !== "link" && !allowed.has(fmt)) ? "wrong_type" : "resolved";
    }

    const upd = await svc.from("gun_drawings").update(patch).eq("tenant_id", ctx.tenantId).eq("id", body.id).select("*").single();
    if (upd.error) throw new Error(upd.error.message);
    return json(res, 200, { drawing: upd.data });
  } catch (err) {
    sendError(res, err);
  }
}
