// GET /api/plex/diagnostics
// Probes Plex SCM REST collections and reports per-entity status + latency.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { plexDecryptCreds, plexFetch, plexIsConfigured } from "../_lib/plex-client.js";
import { runConnectorDiagnostics } from "../_lib/connector-diagnostics.js";

const PROBES = [
  { entity: "customer", args: { method: "GET", path: "/scm/v1/customers", query: { pageSize: 1 } } },
  { entity: "sales_order", args: { method: "GET", path: "/scm/v1/sales-orders", query: { pageSize: 1 } } },
];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const settingsRaw = await tenantSettings(svc, ctx.tenantId);
    const settings = plexDecryptCreds({ ...settingsRaw, tenant_id: ctx.tenantId });
    if (!plexIsConfigured(settings)) {
      return json(res, 200, { configured: false, probes: [], notes: ["Plex not configured"] });
    }
    const { probes, summary } = await runConnectorDiagnostics(plexFetch, settings, PROBES);
    return json(res, 200, { configured: true, base_url: settings.plex_base_url, probes, summary, ran_at: new Date().toISOString() });
  } catch (err) { sendError(res, err); }
}
