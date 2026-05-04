// GET /api/acumatica/diagnostics

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { acuDecryptCreds, acuFetch, acuIsConfigured } from "../_lib/acumatica-client.js";

const PROBES = ["Customer", "StockItem", "SalesOrder", "PurchaseOrder", "InventorySummaryInquiry"];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const settingsRaw = await tenantSettings(svc, ctx.tenantId);
    const settings = acuDecryptCreds({ ...settingsRaw, tenant_id: ctx.tenantId });
    if (!acuIsConfigured(settings)) {
      return json(res, 200, { configured: false, probes: [], notes: ["Acumatica not configured"] });
    }
    const ep = settings.acumatica_endpoint_name || "Default";
    const ver = settings.acumatica_endpoint_version || "20.200.001";
    const out = [];
    for (const entity of PROBES) {
      const t0 = Date.now();
      try {
        const r = await acuFetch(settings, { method: "GET", path: `/entity/${ep}/${ver}/${entity}`, query: { $top: "1" } });
        out.push({
          entity, ok: r.ok, status: r.status,
          latency_ms: Date.now() - t0,
          rows_returned: Array.isArray(r.body) ? r.body.length : 0,
          error: r.ok ? null : (r.body?.message || r.body?.error || r.body?.raw),
        });
      } catch (err) {
        out.push({ entity, ok: false, status: 0, latency_ms: Date.now() - t0, rows_returned: 0, error: err.message });
      }
    }
    const allOk = out.every((p) => p.ok);
    return json(res, 200, {
      configured: true,
      base_url: settings.acumatica_base_url,
      probes: out,
      summary: { all_ok: allOk, total: out.length, failed: out.filter((p) => !p.ok).length },
      ran_at: new Date().toISOString(),
    });
  } catch (err) { sendError(res, err); }
}
