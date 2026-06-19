// GET /api/ifs/diagnostics[?drift=1]
// Probes IFS Cloud projection entities and reports per-entity status +
// latency. With ?drift=1 (admin) it also diffs the tenant ifs_field_map
// against the live CustomerOrders schema.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { ifsDecryptCreds, ifsFetch, ifsIsConfigured } from "../_lib/ifs-client.js";
import { runConnectorDiagnostics } from "../_lib/connector-diagnostics.js";

// IFS Cloud reads go through the configured OData v4 projection
// (ifs_projection, default CustomerOrder.svc). We probe the sales
// order and customer collections with $top=1.
const PROBES = [
  { entity: "sales_order", args: { method: "GET", entity: "CustomerOrders", query: { $top: 1 } } },
  { entity: "customer", args: { method: "GET", entity: "Customers", query: { $top: 1 } } },
];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const wantDrift = ["1", "true"].includes(String(req.query?.drift || ""));
    if (wantDrift) requirePermission(ctx, "admin");
    const svc = serviceClient();
    const settingsRaw = await tenantSettings(svc, ctx.tenantId);
    const settings = ifsDecryptCreds({ ...settingsRaw, tenant_id: ctx.tenantId });
    if (!ifsIsConfigured(settings)) {
      return json(res, 200, { configured: false, probes: [], notes: ["IFS Cloud not configured"] });
    }
    const opts = wantDrift ? { drift: { fieldMap: settings.ifs_field_map || {}, schemaEntity: "sales_order" } } : {};
    const { probes, summary, drift } = await runConnectorDiagnostics(ifsFetch, settings, PROBES, opts);
    return json(res, 200, { configured: true, base_url: settings.ifs_base_url, probes, summary, ...(wantDrift ? { drift } : {}), ran_at: new Date().toISOString() });
  } catch (err) { sendError(res, err); }
}
