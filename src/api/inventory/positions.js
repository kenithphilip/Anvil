// GET /api/inventory/positions
// Query: ?part_no=ATD-STD-1&as_of=2026-05-08&horizon_days=60
//
// Returns the union-source position curve for the item, plus a
// per-source breakdown so the operator can see which ERP reported
// what. If part_no is omitted, returns the latest union row per
// part for every planning-enabled item (dashboard surface).

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const url = new URL(req.url, "http://_");
    const partNo = url.searchParams.get("part_no");
    const asOf = url.searchParams.get("as_of");
    const horizonDays = Math.min(180, Number(url.searchParams.get("horizon_days") || 60));
    const svc = serviceClient();
    if (partNo) {
      // Per-item drill-in: latest position + breakdown + recent
      // history for charting.
      let q = svc.from("inventory_positions").select("*")
        .eq("tenant_id", ctx.tenantId)
        .eq("part_no", partNo)
        .order("as_of", { ascending: false })
        .limit(60);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json(res, 200, { positions: data || [] });
    }
    // Dashboard view: latest union row per planning-enabled part.
    const today = (asOf || new Date().toISOString().slice(0, 10));
    const items = await svc.from("item_master")
      .select("part_no")
      .eq("tenant_id", ctx.tenantId)
      .eq("planning_enabled", true);
    if (items.error) throw new Error(items.error.message);
    const parts = (items.data || []).map((i) => i.part_no);
    if (!parts.length) return json(res, 200, { positions: [] });
    const positions = await svc.from("inventory_positions")
      .select("*")
      .eq("tenant_id", ctx.tenantId)
      .eq("source", "union")
      .in("part_no", parts)
      .lte("as_of", today)
      .order("as_of", { ascending: false });
    if (positions.error) throw new Error(positions.error.message);
    // Latest row per part.
    const latest = new Map();
    for (const row of (positions.data || [])) {
      if (!latest.has(row.part_no)) latest.set(row.part_no, row);
    }
    return json(res, 200, { positions: Array.from(latest.values()) });
  } catch (err) { sendError(res, err); }
}
