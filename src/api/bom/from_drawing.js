// POST /api/bom/from-drawing
//
// PDM P1b: ingest a gun/asset ASSEMBLY-drawing extraction into the BOM.
//
// This is the second half of drawing extraction. First the operator runs the
// drawing through DocAI with kind='assembly_bom' (POST /api/docai/extract),
// which persists an extraction_runs row with the title block + parts-list in
// normalized_extract. Then this endpoint takes that run_id, maps the parts
// list to the /api/bom/import { asset, lines } contract, and feeds the SAME
// derivation chain (bom_assets + bom_lines + item_master + bill_of_materials
// edges) via the shared importBom core — so a drawing produces a stored,
// spare-orderable BOM exactly like an XLSX import does.
//
// The two-step shape mirrors supplier_ack (ack_extract -> ack_accept): the
// extraction is reviewed BEFORE it mutates the BOM. commit defaults to false,
// so the default response is a dry-run PREVIEW of the mapped { asset, lines }
// + warnings (wrong parts list corrupts spare ordering — never auto-commit).
//
// Body: {
//   run_id: uuid (required)   — a completed extraction_runs row, kind=assembly_bom
//   commit?: boolean          — default false = preview; true = persist the BOM
//   asset_code?, revision?, asset_name?, drawing_no?, customer_id?
//                             — operator corrections applied over the title block
//   project_id?, file_name?
// }
//
// Response (preview): { ok, dry_run:true, run_id, confidence_overall, asset, lines, warnings, meta }
// Response (commit):  { ok, committed:true, run_id, asset_id, lines, derived, diff, warnings, meta }

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { importBom } from "../_lib/bom-import-core.js";
import { mapAssemblyBomToImport } from "../_lib/assembly-bom-to-import.js";

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
    const runId = body?.run_id ? String(body.run_id).trim() : "";
    if (!runId) return json(res, 400, { error: { message: "run_id required" } });

    const svc = serviceClient();
    const tenantId = ctx.tenantId;

    // Load the frozen extraction. normalized_extract holds the assembly_bom
    // title block + parts list persisted by the pipeline.
    const runQ = await svc.from("extraction_runs")
      .select("id, extraction_kind, normalized_extract, status, status_reason, confidence_overall")
      .eq("tenant_id", tenantId).eq("id", runId).maybeSingle();
    if (runQ.error) throw new Error("extraction_runs read: " + runQ.error.message);
    if (!runQ.data) return json(res, 404, { error: { message: "extraction run not found" } });

    const run = runQ.data;
    if (run.extraction_kind !== "assembly_bom") {
      return json(res, 422, {
        error: { message: "run " + runId + " is kind '" + run.extraction_kind + "', expected 'assembly_bom'" },
      });
    }
    // Only an ok run carries a usable parts list. A failed run (non_drawing,
    // empty_lines, image_pdf_no_text) or a low-confidence one is surfaced, not
    // ingested — mirror the invoice endpoint's "persist only when status ok".
    if (run.status !== "ok") {
      return json(res, 200, {
        ok: false,
        run_id: runId,
        status: run.status,
        status_reason: run.status_reason,
        message: "extraction status is '" + run.status + "'; nothing to ingest",
      });
    }
    if (!run.normalized_extract) {
      return json(res, 200, { ok: false, run_id: runId, message: "run has no normalized extract" });
    }

    const mapped = mapAssemblyBomToImport(run.normalized_extract, {
      asset_code: body.asset_code,
      revision: body.revision,
      asset_name: body.asset_name,
      drawing_no: body.drawing_no,
      customer_id: body.customer_id,
    });
    const importableLines = mapped.lines.filter((l) => l.part_no);
    const commit = body.commit === true;

    // ── dry-run PREVIEW (default): no BOM mutation ─────────────────────
    if (!commit) {
      return json(res, 200, {
        ok: true,
        dry_run: true,
        run_id: runId,
        confidence_overall: run.confidence_overall,
        asset: mapped.asset,
        lines: mapped.lines,
        warnings: mapped.warnings,
        meta: mapped.meta,
      });
    }

    // ── commit: persist the BOM ────────────────────────────────────────
    // Guard the two states that would make import.js 400 (or silently store an
    // empty asset): no root identity, or no importable part numbers.
    if (!mapped.asset.asset_code) {
      return json(res, 200, {
        ok: false, run_id: runId, needs: "asset_code",
        message: "no asset_code or drawing_no in the title block; pass asset_code to root the BOM",
        asset: mapped.asset, warnings: mapped.warnings, meta: mapped.meta,
      });
    }
    if (!importableLines.length) {
      return json(res, 200, {
        ok: false, run_id: runId, warning: "no_importable_lines",
        message: "no parts-list row has a part number; nothing to import",
        warnings: mapped.warnings, meta: mapped.meta,
      });
    }

    // Soft-fail the persistence: on a DB error, return the run_id + the mapped
    // payload so the operator can retry instead of losing the extraction to a
    // bare 500 (importBom throws on any DB error).
    let result;
    try {
      result = await importBom({
        svc, ctx, tenantId,
        asset: mapped.asset,
        lines: importableLines,
        projectId: body.project_id || null,
        fileName: body.file_name || null,
      });
    } catch (impErr) {
      return json(res, 200, {
        ok: false,
        run_id: runId,
        bom_import_error: impErr?.message || String(impErr),
        asset: mapped.asset,
        importable_line_count: importableLines.length,
        warnings: mapped.warnings,
        meta: mapped.meta,
      });
    }

    await recordAudit(ctx, {
      action: "bom_from_drawing",
      objectType: "bom_asset",
      objectId: result.asset_id,
      detail: "run=" + runId + " asset=" + mapped.asset.asset_code + " lines=" + result.lines,
    });

    return json(res, 200, {
      ok: true,
      committed: true,
      run_id: runId,
      asset_id: result.asset_id,
      lines: result.lines,
      derived: result.derived,
      diff: result.diff.counts,
      warnings: mapped.warnings,
      meta: mapped.meta,
    });
  } catch (err) {
    return sendError(res, err);
  }
}
