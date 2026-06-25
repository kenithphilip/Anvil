// POST /api/bom/parse
// Body: { rows: <2D array>, file_name?, source_format? }
//
// Runs the BOM source-format engine (detect + column-map + normalize)
// over a parsed sheet using the tenant's effective format registry
// (built-ins + tenant overrides). The client parses the Excel/CSV to a
// 2D array (SheetJS `{header:1}`); this returns the detected format, the
// suggested asset metadata, and normalized lines ready to feed
// /api/bom/import. Non-mutating. See docs/BOM_INGESTION_DESIGN.md.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { mergeFormats, mapSheet } from "../_lib/bom-format.js";

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
    const rows = body?.rows;
    if (!Array.isArray(rows) || !rows.length || !Array.isArray(rows[0])) {
      return json(res, 400, { error: { message: "rows must be a non-empty 2D array" } });
    }
    const svc = serviceClient();
    const fmtQ = await svc.from("bom_source_formats").select("*").eq("tenant_id", ctx.tenantId);
    if (fmtQ.error) throw new Error(fmtQ.error.message);
    let formats = mergeFormats(fmtQ.data || []);

    // Force a specific format when the caller picks one in the UI.
    if (body.source_format) {
      const forced = formats.find((f) => f.key === body.source_format);
      if (!forced) return json(res, 400, { error: { code: "UNKNOWN_FORMAT", message: "Unknown source_format: " + body.source_format } });
      formats = [forced];
    }

    const result = mapSheet(rows, body.file_name || "", formats);
    return json(res, 200, result);
  } catch (err) { sendError(res, err); }
}
