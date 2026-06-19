// GET /api/plex/diagnostics[?drift=1]
// Probes Plex SCM REST collections and reports per-entity status +
// latency. With ?drift=1 (admin) it also diffs the tenant plex_field_map
// against the live /scm/v1/sales-orders schema.

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
    const wantDrift = ["1", "true"].includes(String(req.query?.drift || ""));
    if (wantDrift) requirePermission(ctx, "admin");
    const svc = serviceClient();
    const settingsRaw = await tenantSettings(svc, ctx.tenantId);
    const settings = plexDecryptCreds({ ...settingsRaw, tenant_id: ctx.tenantId });
    if (!plexIsConfigured(settings)) {
      return json(res, 200, { configured: false, probes: [], notes: ["Plex not configured"] });
    }
    const opts = wantDrift ? { drift: { fieldMap: settings.plex_field_map || {}, schemaEntity: "sales_order" } } : {};
    const { probes, summary, drift } = await runConnectorDiagnostics(plexFetch, settings, PROBES, opts);
    return json(res, 200, { configured: true, base_url: settings.plex_base_url, probes, summary, ...(wantDrift ? { drift } : {}), ran_at: new Date().toISOString() });
  } catch (err) { sendError(res, err); }
}
