// GET /api/bom/assets                    - list BOM assets (optional ?q= filter)
// GET /api/bom/assets?id=<uuid>          - one asset with its lines, project +
//                                          customer where-used, and import history
// GET /api/bom/assets?asset_code=<code>  - same detail, resolved by asset_code
//                                          (used by the spare matrix auto-fill)
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

    // Resolve a code -> id so the detail path below can be shared.
    let assetId = req.query.id || null;
    if (!assetId && req.query.asset_code) {
      const code = String(req.query.asset_code).trim();
      const codeQ = await svc.from("bom_assets").select("id")
        .eq("tenant_id", tenantId).eq("asset_code", code).maybeSingle();
      if (codeQ.error) throw new Error(codeQ.error.message);
      if (!codeQ.data) return json(res, 404, { error: { message: "Asset not found" } });
      assetId = codeQ.data.id;
    }

    if (assetId) {
      const assetQ = await svc.from("bom_assets").select("*")
        .eq("tenant_id", tenantId).eq("id", assetId).maybeSingle();
      if (assetQ.error) throw new Error(assetQ.error.message);
      if (!assetQ.data) return json(res, 404, { error: { message: "Asset not found" } });

      const linesQ = await svc.from("bom_lines").select("*")
        .eq("tenant_id", tenantId).eq("asset_id", assetId)
        .order("seq_no", { ascending: true });
      if (linesQ.error) throw new Error(linesQ.error.message);

      const linkQ = await svc.from("bom_asset_projects").select("project_id, qty, notes, created_at")
        .eq("tenant_id", tenantId).eq("asset_id", assetId);
      if (linkQ.error) throw new Error(linkQ.error.message);
      let projects = [];
      const projIds = (linkQ.data || []).map((l) => l.project_id);
      if (projIds.length) {
        const projQ = await svc.from("projects").select("id, project_code, project_name, customer_id")
          .eq("tenant_id", tenantId).in("id", projIds);
        const byId = new Map((projQ.data || []).map((p) => [p.id, p]));
        // Resolve customer names so the BOM where-used shows WHO uses the gun.
        const custIds = [...new Set((projQ.data || []).map((p) => p.customer_id).filter(Boolean))];
        let custById = new Map();
        if (custIds.length) {
          const custQ = await svc.from("customers").select("id, customer_name").eq("tenant_id", tenantId).in("id", custIds);
          custById = new Map((custQ.data || []).map((c) => [c.id, c.customer_name]));
        }
        projects = (linkQ.data || []).map((l) => {
          const p = byId.get(l.project_id);
          return {
            project_id: l.project_id,
            qty: l.qty,
            notes: l.notes,
            project_code: p?.project_code || null,
            project_name: p?.project_name || null,
            customer_id: p?.customer_id || null,
            customer_name: (p && p.customer_id && custById.get(p.customer_id)) || null,
          };
        });
      }

      const histQ = await svc.from("bom_import_events")
        .select("uploaded_by, source_format, file_name, line_count, diff, created_at")
        .eq("tenant_id", tenantId).eq("asset_id", assetId)
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
