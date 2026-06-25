// GET /api/bom/assets            - list BOM assets (optional ?q= filter)
// GET /api/bom/assets?id=<uuid>  - one asset with its lines, project +
//                                  customer where-used, and import history
//
// Read-only. See docs/BOM_INGESTION_DESIGN.md section 5.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const tenantId = ctx.tenantId;

    if (req.query.id) {
      const assetQ = await svc.from("bom_assets").select("*")
        .eq("tenant_id", tenantId).eq("id", req.query.id).maybeSingle();
      if (assetQ.error) throw new Error(assetQ.error.message);
      if (!assetQ.data) return json(res, 404, { error: { message: "Asset not found" } });

      const linesQ = await svc.from("bom_lines").select("*")
        .eq("tenant_id", tenantId).eq("asset_id", req.query.id)
        .order("seq_no", { ascending: true });
      if (linesQ.error) throw new Error(linesQ.error.message);

      const linkQ = await svc.from("bom_asset_projects").select("project_id, qty, notes, created_at")
        .eq("tenant_id", tenantId).eq("asset_id", req.query.id);
      if (linkQ.error) throw new Error(linkQ.error.message);
      let projects = [];
      const projIds = (linkQ.data || []).map((l) => l.project_id);
      if (projIds.length) {
        const projQ = await svc.from("projects").select("id, project_code, project_name, customer_id")
          .eq("tenant_id", tenantId).in("id", projIds);
        const byId = new Map((projQ.data || []).map((p) => [p.id, p]));
        projects = (linkQ.data || []).map((l) => ({
          project_id: l.project_id,
          qty: l.qty,
          notes: l.notes,
          project_code: byId.get(l.project_id)?.project_code || null,
          project_name: byId.get(l.project_id)?.project_name || null,
          customer_id: byId.get(l.project_id)?.customer_id || null,
        }));
      }

      const histQ = await svc.from("bom_import_events")
        .select("uploaded_by, source_format, file_name, line_count, diff, created_at")
        .eq("tenant_id", tenantId).eq("asset_id", req.query.id)
        .order("created_at", { ascending: false }).limit(20);
      if (histQ.error) throw new Error(histQ.error.message);

      return json(res, 200, {
        asset: assetQ.data,
        lines: linesQ.data || [],
        projects,
        history: histQ.data || [],
      });
    }

    let q = svc.from("bom_assets").select("*")
      .eq("tenant_id", tenantId).order("updated_at", { ascending: false }).limit(500);
    if (req.query.q) {
      const term = String(req.query.q).replace(/[%,]/g, " ").trim();
      if (term) q = q.or("asset_code.ilike.%" + term + "%,name.ilike.%" + term + "%");
    }
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return json(res, 200, { assets: data || [] });
  } catch (err) { sendError(res, err); }
}
