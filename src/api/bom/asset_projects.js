// POST   /api/bom/asset_projects                          - link asset to project
//   Body: { asset_id, project_id, qty?, notes? }
// DELETE /api/bom/asset_projects?asset_id=&project_id=     - unlink
//
// Tracks which projects a BOM asset is used in (customer flows from the
// project). See docs/BOM_INGESTION_DESIGN.md sections 3.4 + 5.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    const tenantId = ctx.tenantId;

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body?.asset_id || !body?.project_id) {
        return json(res, 400, { error: { message: "asset_id and project_id required" } });
      }
      const row = {
        tenant_id: tenantId,
        asset_id: body.asset_id,
        project_id: body.project_id,
        qty: body.qty != null && Number.isFinite(Number(body.qty)) ? Number(body.qty) : null,
        notes: body.notes || null,
        created_by: ctx.userId || null,
      };
      const up = await svc.from("bom_asset_projects")
        .upsert(row, { onConflict: "tenant_id,asset_id,project_id" });
      if (up.error) throw new Error(up.error.message);
      await recordAudit(ctx, { action: "bom_asset_project_linked", objectType: "bom_asset", objectId: body.asset_id, detail: "project=" + body.project_id });
      return json(res, 200, { ok: true });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "write");
      const assetId = req.query.asset_id;
      const projectId = req.query.project_id;
      if (!assetId || !projectId) {
        return json(res, 400, { error: { message: "asset_id and project_id required" } });
      }
      const del = await svc.from("bom_asset_projects").delete()
        .eq("tenant_id", tenantId).eq("asset_id", assetId).eq("project_id", projectId);
      if (del.error) throw new Error(del.error.message);
      await recordAudit(ctx, { action: "bom_asset_project_unlinked", objectType: "bom_asset", objectId: assetId, detail: "project=" + projectId });
      return json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "POST, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
