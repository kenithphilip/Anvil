// GET /api/jobboss/diagnostics[?drift=1]
// Probes JobBoss REST collections and reports per-entity status +
// latency. With ?drift=1 (admin) it also diffs the tenant
// jobboss_field_map against the live quotes schema (the default SO
// push target in a job-shop workflow).

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { jobbossDecryptCreds, jobbossFetch, jobbossIsConfigured } from "../_lib/jobboss-client.js";
import { runConnectorDiagnostics } from "../_lib/connector-diagnostics.js";

const PROBES = [
  { entity: "customer", args: { method: "GET", path: "customers", query: { limit: 1 } } },
  { entity: "quote", args: { method: "GET", path: "quotes", query: { limit: 1 } } },
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
    const settings = jobbossDecryptCreds({ ...settingsRaw, tenant_id: ctx.tenantId });
    if (!jobbossIsConfigured(settings)) {
      return json(res, 200, { configured: false, probes: [], notes: ["JobBoss not configured"] });
    }
    const opts = wantDrift ? { drift: { fieldMap: settings.jobboss_field_map || {}, schemaEntity: "quote" } } : {};
    const { probes, summary, drift } = await runConnectorDiagnostics(jobbossFetch, settings, PROBES, opts);
    return json(res, 200, { configured: true, base_url: settings.jobboss_base_url, probes, summary, ...(wantDrift ? { drift } : {}), ran_at: new Date().toISOString() });
  } catch (err) { sendError(res, err); }
}
