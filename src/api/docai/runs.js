// GET /api/docai/runs ?status=&customer_id=&limit=
// GET /api/docai/runs?id=...

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const url = new URL(req.url, "http://x");
    const id = url.searchParams.get("id");
    if (id) {
      const r = await svc.from("extraction_runs").select("*")
        .eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
      if (r.error) throw new Error(r.error.message);
      if (!r.data) return json(res, 404, { error: { message: "run not found" } });
      const corr = await svc.from("extraction_corrections")
        .select("*").eq("tenant_id", ctx.tenantId).eq("extraction_run_id", id)
        .order("applied_at", { ascending: true });
      return json(res, 200, { run: r.data, corrections: corr.data || [] });
    }
    const status = url.searchParams.get("status");
    const customerId = url.searchParams.get("customer_id");
    const kind = url.searchParams.get("kind");
    const limit = Math.min(200, Number(url.searchParams.get("limit") || 50));
    let q = svc.from("extraction_runs")
      .select(`id, customer_id, source_type, source_filename, adapter_used,
               confidence_overall, status, status_reason, extraction_kind,
               text_layer_used, ocr_layer_used, template_used, voter_used,
               started_at, finished_at`)
      .eq("tenant_id", ctx.tenantId)
      .order("started_at", { ascending: false })
      .limit(limit);
    if (status) q = q.eq("status", status);
    if (customerId) q = q.eq("customer_id", customerId);
    if (kind) q = q.eq("extraction_kind", kind);
    const r = await q;
    if (r.error) throw new Error(r.error.message);
    return json(res, 200, { runs: r.data || [] });
  } catch (err) { sendError(res, err); }
}
