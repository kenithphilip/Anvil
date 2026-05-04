import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { eclipseDecryptCreds, eclipseFetch, eclipseIsConfigured } from "../_lib/eclipse-client.js";

const PROBES = [
  { entity: "customer", path: "/eterm/customers" },
  { entity: "product", path: "/eterm/products" },
  { entity: "sales_order", path: "/eterm/orders" },
  { entity: "purchase_order", path: "/eterm/purchase_orders" },
  { entity: "branch", path: "/eterm/branches" },
];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const settingsRaw = await tenantSettings(svc, ctx.tenantId);
    const settings = eclipseDecryptCreds({ ...settingsRaw, tenant_id: ctx.tenantId });
    if (!eclipseIsConfigured(settings)) {
      return json(res, 200, { configured: false, probes: [], notes: ["Eclipse not configured"] });
    }
    const out = [];
    for (const p of PROBES) {
      const t0 = Date.now();
      try {
        const r = await eclipseFetch(settings, { method: "GET", path: p.path, query: { $top: "1" } });
        out.push({
          entity: p.entity, ok: r.ok, status: r.status,
          latency_ms: Date.now() - t0,
          rows_returned: (r.body?.value || r.body?.records || []).length,
          transport: r.transport,
          error: r.ok ? null : (r.body?.error || r.body?.raw),
        });
      } catch (err) {
        out.push({ entity: p.entity, ok: false, status: 0, latency_ms: Date.now() - t0, rows_returned: 0, error: err.message });
      }
    }
    const allOk = out.every((p) => p.ok);
    return json(res, 200, {
      configured: true,
      base_url: settings.eclipse_base_url,
      probes: out,
      summary: { all_ok: allOk, total: out.length, failed: out.filter((p) => !p.ok).length },
      ran_at: new Date().toISOString(),
    });
  } catch (err) { sendError(res, err); }
}
