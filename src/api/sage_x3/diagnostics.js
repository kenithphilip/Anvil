// GET /api/sage_x3/diagnostics[?drift=1]
// Probes Sage X3 representations and reports per-entity status +
// latency. With ?drift=1 (admin) it also diffs the tenant
// sagex3_field_map against the live SOH (sales order header) schema.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { sagex3DecryptCreds, sagex3Fetch, sagex3IsConfigured } from "../_lib/sage-x3-client.js";
import { runConnectorDiagnostics } from "../_lib/connector-diagnostics.js";

// Sage X3 reads target representation entities. CUSTOMER (BPCustomer)
// and SOH (sales order header) are the standard SData surfaces.
const PROBES = [
  { entity: "customer", args: { method: "GET", entity: "CUSTOMER", query: { $top: 1 } } },
  { entity: "sales_order", args: { method: "GET", entity: "SOH", query: { $top: 1 } } },
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
    const settings = sagex3DecryptCreds({ ...settingsRaw, tenant_id: ctx.tenantId });
    if (!sagex3IsConfigured(settings)) {
      return json(res, 200, { configured: false, probes: [], notes: ["Sage X3 not configured"] });
    }
    const opts = wantDrift ? { drift: { fieldMap: settings.sagex3_field_map || {}, schemaEntity: "sales_order" } } : {};
    const { probes, summary, drift } = await runConnectorDiagnostics(sagex3Fetch, settings, PROBES, opts);
    return json(res, 200, { configured: true, base_url: settings.sagex3_base_url, probes, summary, ...(wantDrift ? { drift } : {}), ran_at: new Date().toISOString() });
  } catch (err) { sendError(res, err); }
}
