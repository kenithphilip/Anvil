// GET /api/jde/diagnostics
// Browses JDE EnterpriseOne tables read-only and reports status + latency.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { jdeDecryptCreds, jdeFetch, jdeIsConfigured } from "../_lib/jde-client.js";
import { runConnectorDiagnostics } from "../_lib/connector-diagnostics.js";

// JDE reads go through the AIS dataservice (POST) with a BROWSE on a
// target table. F0101 is the Address Book; F4201 is the Sales Order
// Header. maxPageSize=1 keeps the probe cheap and side-effect free.
const browse = (target) => ({
  method: "POST", path: "dataservice",
  body: { targetName: target, targetType: "table", maxPageSize: "1", dataServiceType: "BROWSE" },
});
const PROBES = [
  { entity: "address_book", args: browse("F0101") },
  { entity: "sales_order", args: browse("F4201") },
];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const settingsRaw = await tenantSettings(svc, ctx.tenantId);
    const settings = jdeDecryptCreds({ ...settingsRaw, tenant_id: ctx.tenantId });
    if (!jdeIsConfigured(settings)) {
      return json(res, 200, { configured: false, probes: [], notes: ["JDE not configured"] });
    }
    const { probes, summary } = await runConnectorDiagnostics(jdeFetch, settings, PROBES);
    return json(res, 200, { configured: true, base_url: settings.jde_base_url, probes, summary, ran_at: new Date().toISOString() });
  } catch (err) { sendError(res, err); }
}
