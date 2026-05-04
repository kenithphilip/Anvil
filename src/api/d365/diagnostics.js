// GET /api/d365/diagnostics

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { d365DecryptCreds, d365Fetch, d365IsConfigured } from "../_lib/d365-client.js";

const PROBES = [
  { entity: "customer",         path: "/data/CustomersV3" },
  { entity: "released_product", path: "/data/ReleasedProductsV2" },
  { entity: "sales_order",      path: "/data/SalesOrderHeadersV2" },
  { entity: "purchase_order",   path: "/data/PurchaseOrderHeadersV2" },
  { entity: "inventory",        path: "/data/InventOnhand" },
];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const settingsRaw = await tenantSettings(svc, ctx.tenantId);
    const settings = d365DecryptCreds({ ...settingsRaw, tenant_id: ctx.tenantId });
    if (!d365IsConfigured(settings)) {
      return json(res, 200, { configured: false, probes: [], notes: ["D365 not configured"] });
    }
    const out = [];
    for (const p of PROBES) {
      const t0 = Date.now();
      try {
        const r = await d365Fetch(settings, { method: "GET", path: p.path, query: { $top: "1" } });
        out.push({
          entity: p.entity, ok: r.ok, status: r.status,
          latency_ms: Date.now() - t0,
          rows_returned: (r.body?.value || []).length,
          error: r.ok ? null : (r.body?.error?.message || r.body?.error || r.body?.raw),
        });
      } catch (err) {
        out.push({ entity: p.entity, ok: false, status: 0, latency_ms: Date.now() - t0, rows_returned: 0, error: err.message });
      }
    }
    const allOk = out.every((p) => p.ok);
    return json(res, 200, {
      configured: true,
      resource_url: settings.d365_resource_url,
      probes: out,
      summary: { all_ok: allOk, total: out.length, failed: out.filter((p) => !p.ok).length },
      ran_at: new Date().toISOString(),
    });
  } catch (err) { sendError(res, err); }
}
