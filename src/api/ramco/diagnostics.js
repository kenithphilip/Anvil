// GET /api/ramco/diagnostics[?drift=1]
// Probes Ramco ERP REST resources and reports per-entity status +
// latency. With ?drift=1 (admin) it also diffs the tenant
// ramco_field_map against the live Sales/SalesOrder schema.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { ramcoDecryptCreds, ramcoFetch, ramcoIsConfigured } from "../_lib/ramco-client.js";
import { runConnectorDiagnostics } from "../_lib/connector-diagnostics.js";

const PROBES = [
  { entity: "sales_order", args: { method: "GET", resource: "Sales/SalesOrder", query: { pageSize: 1 } } },
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
    const settings = ramcoDecryptCreds({ ...settingsRaw, tenant_id: ctx.tenantId });
    if (!ramcoIsConfigured(settings)) {
      return json(res, 200, { configured: false, probes: [], notes: ["Ramco not configured"] });
    }
    const opts = wantDrift ? { drift: { fieldMap: settings.ramco_field_map || {}, schemaEntity: "sales_order" } } : {};
    const { probes, summary, drift } = await runConnectorDiagnostics(ramcoFetch, settings, PROBES, opts);
    return json(res, 200, { configured: true, base_url: settings.ramco_base_url, probes, summary, ...(wantDrift ? { drift } : {}), ran_at: new Date().toISOString() });
  } catch (err) { sendError(res, err); }
}
