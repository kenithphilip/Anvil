// POST /api/spare_matrix/drawings/stage
// Body: { matrix_id, kind, files: [{ document_id?, link_url?, filename, size? }] }
//
// Bulk-stage a batch of already-uploaded drawings (files go to storage via
// /api/documents/upload first; a 3D model may instead be an external link).
// Each file is filename-matched to a gun in the matrix and inserted as a
// STAGED gun_drawings row with a match_status the reviewer then corrects
// (/update) before /commit. Records the uploader + role (upload track).

import { applyCors, handlePreflight, json, readBody, sendError } from "../../_lib/cors.js";
import { resolveContext, requirePermission } from "../../_lib/auth.js";
import { serviceClient } from "../../_lib/supabase.js";
import { recordAudit } from "../../_lib/audit.js";
import { matchBatch, normGun } from "../../_lib/gun-drawing-match.js";

const KINDS = new Set(["eg_sheet", "drawing_2d", "drawing_3d"]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = await readBody(req);
    const matrixId = body.matrix_id;
    const kind = body.kind;
    const files = Array.isArray(body.files) ? body.files : [];
    if (!matrixId) return json(res, 400, { error: { message: "matrix_id required" } });
    if (!KINDS.has(kind)) return json(res, 400, { error: { message: "kind must be one of eg_sheet | drawing_2d | drawing_3d" } });
    if (!files.length) return json(res, 400, { error: { message: "files[] required" } });

    const svc = serviceClient();

    // Verify the matrix belongs to the caller's tenant.
    const mtx = await svc.from("spare_matrix").select("id").eq("tenant_id", ctx.tenantId).eq("id", matrixId).maybeSingle();
    if (mtx.error) throw new Error(mtx.error.message);
    if (!mtx.data) return json(res, 404, { error: { message: "matrix not found" } });

    // Gun rows to match against, and existing committed drawings for
    // duplicate detection (one committed artifact per gun+kind).
    const [gunsQ, committedQ] = await Promise.all([
      svc.from("spare_matrix_rows").select("id, gun_no").eq("tenant_id", ctx.tenantId).eq("matrix_id", matrixId),
      svc.from("gun_drawings").select("gun_no").eq("tenant_id", ctx.tenantId).eq("matrix_id", matrixId).eq("kind", kind).eq("status", "committed"),
    ]);
    if (gunsQ.error) throw new Error(gunsQ.error.message);
    const gunRows = (gunsQ.data || []).filter((r) => r.gun_no);
    const committedGuns = new Set((committedQ.data || []).map((r) => normGun(r.gun_no)));

    const matched = matchBatch(files, kind, gunRows);

    const rows = matched.map((m) => {
      const f = m.file || {};
      // A clean match that already has a committed artifact is a duplicate.
      let status = m.status;
      let detail = m.detail || {};
      if ((status === "matched" || status === "matched_suffix") && m.gun_no && committedGuns.has(normGun(m.gun_no))) {
        status = "duplicate";
        detail = { ...detail, duplicate_of: "committed" };
      }
      return {
        tenant_id: ctx.tenantId,
        matrix_id: matrixId,
        row_id: m.row_id || null,
        gun_no: m.gun_no || null,
        kind,
        // Decide file-vs-link by the PAYLOAD, not the filename: addLink sends a
        // gun+'.step' filename for an external 3D URL, which made matchFile stamp
        // format='step' on a link row. A row with a link_url and no document_id
        // is a link, full stop.
        format: (f.link_url && !f.document_id) ? "link" : (m.format || null),
        document_id: f.document_id || null,
        link_url: f.link_url || null,
        original_filename: f.filename || f.original_filename || null,
        file_size: f.size || f.file_size || null,
        match_status: status,
        match_detail: detail,
        uploaded_by: (ctx.user && ctx.user.id) || null,
        uploader_role: ctx.role || null,
        status: "staged",
      };
    });

    const ins = await svc.from("gun_drawings").insert(rows).select("*");
    if (ins.error) throw new Error(ins.error.message);

    const summary = ins.data.reduce((acc, r) => { acc[r.match_status] = (acc[r.match_status] || 0) + 1; return acc; }, {});
    await recordAudit(ctx, {
      action: "gun_drawings_stage",
      objectType: "spare_matrix",
      objectId: matrixId,
      detail: { kind, count: ins.data.length, summary },
    });

    return json(res, 200, { staged: ins.data, summary });
  } catch (err) {
    sendError(res, err);
  }
}
