// GET  /api/treds/eligible_buyers              read the per-tenant cache
// POST /api/treds/eligible_buyers/refresh      refresh from upstream
//
// The cache lets the operator UI cheaply gate the "Discount via
// TReDS" button on whether the invoice's buyer is even
// TReDS-onboarded. Refresh runs nightly from /api/cron/daily; the
// POST endpoint is an admin-only manual trigger.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { getEligibleBuyers, m1xchangeMode } from "../_lib/treds/m1xchange-client.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    const url = new URL(req.url, "http://_");
    const segments = url.pathname.split("/").filter(Boolean);
    const action = segments[3];

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const r = await svc.from("treds_eligible_buyers").select("*")
        .eq("tenant_id", ctx.tenantId)
        .eq("active", true)
        .order("buyer_name", { ascending: true })
        .limit(2000);
      if (r.error) throw new Error(r.error.message);
      return json(res, 200, { buyers: r.data || [] });
    }

    if (req.method === "POST" && action === "refresh") {
      requirePermission(ctx, "admin");
      const settings = await tenantSettings(svc, ctx.tenantId);
      const mode = m1xchangeMode(settings || {});
      const buyers = await getEligibleBuyers(settings || {});
      const platform = mode === "sandbox" ? "sandbox" : (settings?.treds_provider || "m1xchange");
      const now = new Date().toISOString();
      // Mark every existing row as inactive, then upsert the new
      // set as active. Stale rows stay around for audit but get
      // filtered by `active=true` in the GET handler.
      await svc.from("treds_eligible_buyers")
        .update({ active: false })
        .eq("tenant_id", ctx.tenantId)
        .eq("treds_platform", platform);
      const rows = buyers.map((b) => ({
        tenant_id: ctx.tenantId,
        treds_platform: platform,
        buyer_gstin: b.gstin,
        buyer_name: b.name || null,
        active: !!b.active,
        last_refreshed_at: now,
        raw: b,
      }));
      if (rows.length) {
        const up = await svc.from("treds_eligible_buyers")
          .upsert(rows, { onConflict: "tenant_id,treds_platform,buyer_gstin" });
        if (up.error) throw new Error(up.error.message);
      }
      return json(res, 200, { ok: true, count: rows.length, mode, platform });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
