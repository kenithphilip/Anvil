// GET /api/proalpha/diagnostics[?drift=1]
// Probes proALPHA REST collections and reports per-entity status +
// latency. With ?drift=1 (admin) it also diffs the tenant
// proalpha_field_map against the live salesOrder schema.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { proalphaDecryptCreds, proalphaFetch, proalphaIsConfigured } from "../_lib/proalpha-client.js";
import { runConnectorDiagnostics } from "../_lib/connector-diagnostics.js";

const PROBES = [
  { entity: "customer", args: { method: "GET", path: "customer", query: { limit: 1 } } },
  { entity: "sales_order", args: { method: "GET", path: "salesOrder", query: { limit: 1 } } },
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
    const settings = proalphaDecryptCreds({ ...settingsRaw, tenant_id: ctx.tenantId });
    if (!proalphaIsConfigured(settings)) {
      return json(res, 200, { configured: false, probes: [], notes: ["proALPHA not configured"] });
    }
    const opts = wantDrift ? { drift: { fieldMap: settings.proalpha_field_map || {}, schemaEntity: "sales_order" } } : {};
    const { probes, summary, drift } = await runConnectorDiagnostics(proalphaFetch, settings, PROBES, opts);
    return json(res, 200, { configured: true, base_url: settings.proalpha_base_url, probes, summary, ...(wantDrift ? { drift } : {}), ran_at: new Date().toISOString() });
  } catch (err) { sendError(res, err); }
}
