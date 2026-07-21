// POST /api/bom/import
// Body: { asset: { asset_code, name?, asset_type?, customer_id?,
//                  source_format?, revision?, drawing_no?, source_country?,
//                  metadata? },
//         lines: [{ part_no, part_name?, supplier_part_no?, supplier_id?,
//                   material?, size?, qty?, uom?, level?, seq_no?, side?,
//                   std_category?, is_spare?, balloon_no?, find_no?,
//                   remarks?, raw? }],
//         project_id?, file_name? }
//
// Ingests an as-imported BOM (Phase 1, see docs/BOM_INGESTION_DESIGN.md):
//   1. upsert bom_assets (by tenant_id, asset_code, revision); track
//      uploader + last import.
//   2. replace bom_lines for the asset (delete-then-insert).
//   3. derive item_master rows (every part accessible to the catalog;
//      fill gaps, never clobber operator-set fields).
//   4. derive bill_of_materials parent->child edges from the level walk
//      (replace this asset's root edges; upsert sub-edges additively).
//   5. optional project link; write a bom_import_events provenance row;
//      audit.
//
// The steps 1-5 persistence lives in ../_lib/bom-import-core.js (importBom) so
// the assembly-drawing extractor (/api/bom/from-drawing) feeds the SAME chain.
// This handler owns request parsing, validation, and the audit entry.
//
// Strictly additive: the legacy /api/bom flat upsert is untouched.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { importBom } from "../_lib/bom-import-core.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = await readBody(req);
    const asset = body?.asset || {};
    const assetCode = asset.asset_code ? String(asset.asset_code).trim() : "";
    const lines = Array.isArray(body?.lines) ? body.lines : [];
    if (!assetCode) return json(res, 400, { error: { message: "asset.asset_code required" } });
    if (!lines.length) return json(res, 400, { error: { message: "lines[] required" } });

    const svc = serviceClient();
    const tenantId = ctx.tenantId;

    const result = await importBom({
      svc, ctx, tenantId, asset, lines,
      projectId: body.project_id || null,
      fileName: body.file_name || null,
    });

    const counts = result.diff.counts;
    await recordAudit(ctx, {
      action: "bom_import",
      objectType: "bom_asset",
      objectId: result.asset_id,
      detail: "asset=" + assetCode + " lines=" + result.lines
        + " +" + counts.added + "/-" + counts.removed + "/~" + counts.changed,
    });

    return json(res, 200, {
      ok: true,
      asset_id: result.asset_id,
      lines: result.lines,
      derived: result.derived,
      diff: counts,
    });
  } catch (err) {
    return sendError(res, err);
  }
}
