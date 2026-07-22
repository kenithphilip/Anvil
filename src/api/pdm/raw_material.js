// POST /api/pdm/raw-material
//
// The manufacturing raw-material determination + persist endpoint (PDM D2).
//   dry-run  { part_spec, overrides? }                 -> the raw-material verdict
//            (make -> material/form/stock/mass; buy/raw -> recipe null)
//   commit   { finished_part_no, verdict, commit:true } -> persists the reviewed
//            verdict: a make recipe into composition_material_lines (+ BOM edge +
//            item_master.procurement_type='make'); a buy/raw verdict just sets
//            procurement_type. Bought-out parts never get a recipe.
//
// Determination is deterministic (raw-material-infer). Nothing is written until
// commit, so manufacturing reviews/corrects the verdict first (human in loop).

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { rawMaterialFromPartSpec } from "../_lib/pdm/raw-material-infer.js";
import { persistDetermination } from "../_lib/pdm/raw-material-persist.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const body = await readBody(req);
    const commit = body?.commit === true;

    if (commit) {
      requirePermission(ctx, "write");
      const svc = serviceClient();
      let result;
      try {
        result = await persistDetermination(svc, ctx.tenantId, {
          finished_part_no: body?.finished_part_no,
          verdict: body?.verdict,
        });
      } catch (e) {
        return json(res, e?.status === 400 ? 400 : 500, { error: { message: e?.message || "persist failed" } });
      }
      await recordAudit(ctx, {
        action: "pdm_raw_material_saved",
        objectType: "item",
        objectId: String(body?.finished_part_no || ""),
        detail: result.procurement_type + (result.raw_material_part_no ? " -> " + result.raw_material_part_no : ""),
      });
      return json(res, 200, { committed: true, ...result });
    }

    // Dry-run determination for review.
    const overrides = body?.overrides || {};
    const partSpec = body?.part_spec || null;
    if (!partSpec && !body?.verdict) {
      return json(res, 400, { error: { message: "part_spec or verdict required" } });
    }
    const spec = partSpec
      ? { ...partSpec, ...(overrides.material ? { material: overrides.material } : {}) }
      : null;
    const verdict = body?.verdict || rawMaterialFromPartSpec(spec, {
      allowanceMm: overrides.allowanceMm,
      yieldPct: overrides.yieldPct,
    });
    const finishedPartNo = body?.finished_part_no
      || (partSpec && partSpec.title_block && (partSpec.title_block.part_no || partSpec.title_block.drawing_no))
      || null;
    return json(res, 200, { dry_run: true, finished_part_no: finishedPartNo, verdict });
  } catch (err) {
    return sendError(res, err);
  }
}
