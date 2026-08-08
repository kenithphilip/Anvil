// GET /api/bom/uploads?window_days=365
//
// Tenant-wide upload / storage / item-creation provenance for the Item-Master
// area: guns/BOM assets uploaded, parts ingested, items created (imported vs
// total), storage bytes, a per-uploader rollup, and a recent-uploads feed.
// Read-only, live-computed. Uploader ids resolve to names on the client.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { computeUploadsSummary } from "../_lib/bom-uploads.js";

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
    const t = ctx.tenantId;
    const url = new URL(req.url || "/", "http://x");
    const windowDays = Math.min(1095, Math.max(7, Number(url.searchParams.get("window_days") || 365)));
    const sinceIso = new Date(Date.now() - windowDays * 86400_000).toISOString();

    // item_master can be large — count via head, never pull all rows.
    const [assets, events, docs, itemsTotal, itemsImported] = await Promise.all([
      svc.from("bom_assets").select("id, asset_code, last_uploaded_by, last_imported_at").eq("tenant_id", t),
      svc.from("bom_import_events").select("uploaded_by, file_name, line_count, source_format, created_at, asset_id")
        .eq("tenant_id", t).gte("created_at", sinceIso).order("created_at", { ascending: false }),
      svc.from("documents").select("size_bytes").eq("tenant_id", t),
      svc.from("item_master").select("id", { count: "exact", head: true }).eq("tenant_id", t),
      svc.from("item_master").select("id", { count: "exact", head: true }).eq("tenant_id", t).eq("data_source", "imported"),
    ]);
    for (const r of [assets, events, docs, itemsTotal, itemsImported]) if (r.error) throw new Error(r.error.message);

    const summary = computeUploadsSummary({
      assets: assets.data || [],
      events: events.data || [],
      docs: docs.data || [],
      itemsTotal: itemsTotal.count || 0,
      itemsImported: itemsImported.count || 0,
    });
    return json(res, 200, { window_days: windowDays, as_of: new Date().toISOString(), ...summary });
  } catch (err) { sendError(res, err); }
}
