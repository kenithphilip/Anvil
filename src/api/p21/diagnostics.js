import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { p21DecryptCreds, p21Fetch, p21IsConfigured } from "../_lib/p21-client.js";

const PROBES = [
  { entity: "customer", path: "/api/v2/odata/data/Customers" },
  { entity: "item", path: "/api/v2/odata/data/Items" },
  { entity: "sales_order", path: "/api/v2/odata/data/OrderHeader" },
  { entity: "purchase_order", path: "/api/v2/odata/data/POHeader" },
  { entity: "branch", path: "/api/v2/odata/data/Branches" },
  { entity: "inventory", path: "/api/v2/odata/data/InventoryQuantity" },
];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const settingsRaw = await tenantSettings(svc, ctx.tenantId);
    const settings = p21DecryptCreds({ ...settingsRaw, tenant_id: ctx.tenantId });
    if (!p21IsConfigured(settings)) {
      return json(res, 200, { configured: false, probes: [], notes: ["P21 not configured"] });
    }
    const out = [];
    for (const p of PROBES) {
      const t0 = Date.now();
      try {
        const r = await p21Fetch(settings, { method: "GET", path: p.path, query: { $top: "1" } });
        out.push({
          entity: p.entity, ok: r.ok, status: r.status,
          latency_ms: Date.now() - t0,
          rows_returned: (r.body?.value || []).length,
          error: r.ok ? null : (r.body?.error || r.body?.raw),
        });
      } catch (err) {
        out.push({ entity: p.entity, ok: false, status: 0, latency_ms: Date.now() - t0, rows_returned: 0, error: err.message });
      }
    }
    const allOk = out.every((p) => p.ok);
    return json(res, 200, {
      configured: true,
      base_url: settings.p21_base_url,
      probes: out,
      summary: { all_ok: allOk, total: out.length, failed: out.filter((p) => !p.ok).length },
      ran_at: new Date().toISOString(),
    });
  } catch (err) { sendError(res, err); }
}
