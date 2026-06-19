// GET /api/oracle_fusion/diagnostics[?drift=1]
// Probes Oracle Fusion SCM REST resources and reports status + latency.
// With ?drift=1 (admin) it also diffs the tenant oracle_fusion_field_map
// against the live salesOrdersForOrderHub schema.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { oracleFusionDecryptCreds, oracleFusionFetch, oracleFusionIsConfigured } from "../_lib/oracle-fusion-client.js";
import { runConnectorDiagnostics } from "../_lib/connector-diagnostics.js";

const PROBES = [
  { entity: "sales_order", args: { method: "GET", resource: "salesOrdersForOrderHub", query: { limit: 1 } } },
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
    const settings = oracleFusionDecryptCreds({ ...settingsRaw, tenant_id: ctx.tenantId });
    if (!oracleFusionIsConfigured(settings)) {
      return json(res, 200, { configured: false, probes: [], notes: ["Oracle Fusion not configured"] });
    }
    const opts = wantDrift ? { drift: { fieldMap: settings.oracle_fusion_field_map || {}, schemaEntity: "sales_order" } } : {};
    const { probes, summary, drift } = await runConnectorDiagnostics(oracleFusionFetch, settings, PROBES, opts);
    return json(res, 200, { configured: true, base_url: settings.oracle_fusion_base_url, probes, summary, ...(wantDrift ? { drift } : {}), ran_at: new Date().toISOString() });
  } catch (err) { sendError(res, err); }
}
