// GET /api/bom/where-used?part_no=<pn>[&roots_only=1]
//
// PDM P0: reverse BOM resolution — given a child/spare part, which assemblies
// (transitively) contain it, with per-assembly qty + depth. This is the
// primitive behind "order a spare child part instead of the whole assembly":
// a customer names a part (or a balloon on the shared assembly drawing) and
// this resolves it to the containing asset(s).
//
// Backed by v_bom_where_used_recursive (migration 183), enriched with
// bom_assets (which ancestors are registered assets/guns) + item_master
// (is_assembly, description). roots_only=1 filters to registered assets.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

// Pure: shape the where-used view rows into enriched assemblies. Exported for
// tests. `assetByCode` / `itemByPart` are lookup maps keyed by part number.
export const buildAssemblies = (rows, assetByCode = {}, itemByPart = {}, rootsOnly = false) => {
  let out = (Array.isArray(rows) ? rows : []).map((r) => {
    const asset = assetByCode[r.assembly_part_no] || null;
    const item = itemByPart[r.assembly_part_no] || null;
    return {
      assembly_part_no: r.assembly_part_no,
      depth: r.depth,
      qty_per_assembly: r.total_qty != null ? Number(r.total_qty) : null,
      is_asset: !!asset,
      asset_id: asset ? asset.id : null,
      asset_name: asset ? asset.name : null,
      revision: asset ? asset.revision : null,
      drawing_no: asset ? asset.drawing_no : null,
      customer_id: asset ? asset.customer_id : null,
      is_assembly: item ? !!item.is_assembly : null,
      item_type: item ? item.item_type : null,
      description: item ? item.description : null,
    };
  });
  if (rootsOnly) out = out.filter((a) => a.is_asset);
  return out;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const partNo = String(req.query.part_no || "").trim();
    if (!partNo) return json(res, 400, { error: { message: "part_no required" } });
    const rootsOnly = req.query.roots_only === "1" || req.query.roots_only === "true";
    const svc = serviceClient();

    const wu = await svc.from("v_bom_where_used_recursive")
      .select("assembly_part_no, depth, total_qty")
      .eq("tenant_id", ctx.tenantId)
      .eq("part_no", partNo)
      .order("depth", { ascending: true })
      .limit(2000);
    if (wu.error) {
      // Migration 183 not applied yet → degrade to an empty result rather than 500.
      if (wu.error.code === "42P01" || /does not exist|schema cache/i.test(wu.error.message || "")) {
        return json(res, 200, { part_no: partNo, assemblies: [], available: false, reason: "v_bom_where_used_recursive not applied (migration 183)" });
      }
      throw new Error(wu.error.message);
    }
    const rows = Array.isArray(wu.data) ? wu.data : [];
    if (!rows.length) return json(res, 200, { part_no: partNo, assemblies: [] });

    const codes = [...new Set(rows.map((r) => r.assembly_part_no).filter(Boolean))];

    // Which ancestors are registered assets/guns (bom_assets.asset_code)?
    let assetByCode = {};
    let itemByPart = {};
    if (codes.length) {
      const [assetsQ, itemsQ] = await Promise.all([
        svc.from("bom_assets").select("id, asset_code, name, revision, customer_id, drawing_no")
          .eq("tenant_id", ctx.tenantId).in("asset_code", codes),
        svc.from("item_master").select("part_no, is_assembly, description, item_type")
          .eq("tenant_id", ctx.tenantId).in("part_no", codes),
      ]);
      for (const a of (assetsQ.data || [])) { if (!assetByCode[a.asset_code]) assetByCode[a.asset_code] = a; }
      for (const it of (itemsQ.data || [])) { itemByPart[it.part_no] = it; }
    }

    const assemblies = buildAssemblies(rows, assetByCode, itemByPart, rootsOnly);
    return json(res, 200, { part_no: partNo, count: assemblies.length, assemblies });
  } catch (err) {
    sendError(res, err);
  }
}
