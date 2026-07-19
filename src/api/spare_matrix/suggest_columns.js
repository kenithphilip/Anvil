// GET /api/spare_matrix/<id>/suggest_columns
//
// Scans every gun's BOM (bom_lines) in the matrix and proposes NEW spare-column
// headers to add, grouped by std_category (fallback: part_name prefix), so an
// operator doesn't have to eyeball each gun's BOM to decide which columns to
// configure. Read-only, non-mutating -- the client PATCHes chosen headers through
// the existing /spare_matrix/<id> columns reconcile.
//
// Gun -> BOM key: spare_matrix_rows.gun_no === bom_assets.asset_code (the live
// identity path, same as spares.tsx smFetchLinesForGun), plus any populated
// spare_matrix_rows.bom_asset_id.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { suggestColumnsFromLines } from "../_lib/spare-suggest.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const id = req.query.id;
    if (!id) return json(res, 400, { error: { message: "matrix id required" } });
    const svc = serviceClient();

    const head = await svc.from("spare_matrix").select("id").eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
    if (head.error) throw new Error(head.error.message);
    if (!head.data) return json(res, 404, { error: { message: "Matrix not found" } });

    const [rowsQ, colsQ] = await Promise.all([
      svc.from("spare_matrix_rows").select("gun_no, bom_asset_id").eq("tenant_id", ctx.tenantId).eq("matrix_id", id),
      svc.from("spare_matrix_columns").select("col_name").eq("tenant_id", ctx.tenantId).eq("matrix_id", id),
    ]);
    if (rowsQ.error) throw new Error(rowsQ.error.message);
    if (colsQ.error) throw new Error(colsQ.error.message);

    // Resolve the matrix's guns to bom_assets: by asset_code (== gun_no) + any
    // stored bom_asset_id.
    const gunNos = [...new Set((rowsQ.data || []).map((r) => String(r.gun_no || "").trim()).filter(Boolean))];
    const assetIds = new Set((rowsQ.data || []).map((r) => r.bom_asset_id).filter(Boolean));
    if (gunNos.length) {
      const aq = await svc.from("bom_assets").select("id, asset_code").eq("tenant_id", ctx.tenantId).in("asset_code", gunNos);
      if (aq.error) throw new Error(aq.error.message);
      (aq.data || []).forEach((a) => assetIds.add(a.id));
    }
    const assetIdList = [...assetIds];
    if (!assetIdList.length) {
      return json(res, 200, { suggestions: [], scanned_guns: 0, note: "No BOMs found for the guns in this matrix. Import BOMs (BOM Import) first." });
    }

    const linesQ = await svc.from("bom_lines")
      .select("asset_id, part_no, part_name, std_category, is_spare")
      .eq("tenant_id", ctx.tenantId).in("asset_id", assetIdList).limit(20000);
    if (linesQ.error) throw new Error(linesQ.error.message);

    const suggestions = suggestColumnsFromLines(linesQ.data || [], (colsQ.data || []).map((c) => c.col_name));
    return json(res, 200, { suggestions, scanned_guns: assetIdList.length });
  } catch (err) {
    sendError(res, err);
  }
}
