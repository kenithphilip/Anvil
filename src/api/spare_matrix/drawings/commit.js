// POST /api/spare_matrix/drawings/commit
// Body: { matrix_id, ids?: [drawingId,...] }
//
// Commit reviewed drawings: flip status staged -> committed. Only rows that
// bound to a gun (matched | matched_suffix | resolved) with a gun_no and a
// payload (document_id or link_url) are eligible. Enforces one committed
// artifact per (matrix, gun, kind) — a row whose gun+kind is already committed
// is left staged and flagged 'duplicate' rather than committed.

import { applyCors, handlePreflight, json, readBody, sendError } from "../../_lib/cors.js";
import { resolveContext, requirePermission } from "../../_lib/auth.js";
import { serviceClient } from "../../_lib/supabase.js";
import { recordAudit } from "../../_lib/audit.js";
import { normGun } from "../../_lib/gun-drawing-match.js";

const COMMITTABLE = new Set(["matched", "matched_suffix", "resolved"]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = await readBody(req);
    const matrixId = body.matrix_id;
    if (!matrixId) return json(res, 400, { error: { message: "matrix_id required" } });
    const ids = Array.isArray(body.ids) ? body.ids : null;

    const svc = serviceClient();

    // Candidate staged rows.
    let q = svc.from("gun_drawings").select("*").eq("tenant_id", ctx.tenantId).eq("matrix_id", matrixId).eq("status", "staged");
    if (ids) q = q.in("id", ids);
    const staged = await q;
    if (staged.error) throw new Error(staged.error.message);

    // Existing committed (matrix, gun, kind) keys to block duplicates.
    const committed = await svc.from("gun_drawings").select("gun_no, kind")
      .eq("tenant_id", ctx.tenantId).eq("matrix_id", matrixId).eq("status", "committed");
    if (committed.error) throw new Error(committed.error.message);
    const takenKey = (gun, kind) => normGun(gun) + "::" + kind;
    const taken = new Set((committed.data || []).map((r) => takenKey(r.gun_no, r.kind)));

    const committedIds = [];
    const skipped = [];
    for (const r of (staged.data || [])) {
      const hasPayload = !!(r.document_id || r.link_url);
      if (!COMMITTABLE.has(r.match_status) || !r.gun_no || !hasPayload) {
        skipped.push({ id: r.id, reason: !r.gun_no ? "no gun" : !hasPayload ? "no file/link" : "unresolved (" + r.match_status + ")" });
        continue;
      }
      const key = takenKey(r.gun_no, r.kind);
      if (taken.has(key)) {
        // Already committed for this gun+kind — flag and leave staged.
        await svc.from("gun_drawings").update({ match_status: "duplicate" }).eq("tenant_id", ctx.tenantId).eq("id", r.id);
        skipped.push({ id: r.id, reason: "duplicate — a " + r.kind + " is already committed for gun " + r.gun_no });
        continue;
      }
      const upd = await svc.from("gun_drawings")
        .update({ status: "committed", match_status: r.match_status === "matched" ? "matched" : "resolved" })
        .eq("tenant_id", ctx.tenantId).eq("id", r.id).select("id");
      if (upd.error) {
        // Unique-index race backstop: another concurrent commit won.
        skipped.push({ id: r.id, reason: "commit conflict" });
        continue;
      }
      taken.add(key);
      committedIds.push(r.id);
    }

    await recordAudit(ctx, {
      action: "gun_drawings_commit",
      objectType: "spare_matrix",
      objectId: matrixId,
      detail: { committed: committedIds.length, skipped: skipped.length },
    });

    return json(res, 200, { committed: committedIds, skipped });
  } catch (err) {
    sendError(res, err);
  }
}
