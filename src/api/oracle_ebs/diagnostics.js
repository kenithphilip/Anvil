// GET /api/oracle_ebs/diagnostics[?drift=1]
// Probes the Oracle EBS Integrated SOA Gateway REST surface and reports
// status. With ?drift=1 (admin) drift is reported unavailable: sales
// orders push through OE_ORDER_PUB.Process_Order (write-only PL/SQL
// API) with no readable sales-order schema to diff the field map against.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { oracleEbsDecryptCreds, oracleEbsFetch, oracleEbsIsConfigured } from "../_lib/oracle-ebs-client.js";
import { runConnectorDiagnostics } from "../_lib/connector-diagnostics.js";

// EBS REST surfaces vary per deployment; the customer/account list
// service is the known-stable read target (matches oracleEbsProbe).
const PROBES = [
  { entity: "customer", args: { method: "GET", path: "ar_customers/get_customer_list/", query: { p_max_rows: "1" } } },
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
    const settings = oracleEbsDecryptCreds({ ...settingsRaw, tenant_id: ctx.tenantId });
    if (!oracleEbsIsConfigured(settings)) {
      return json(res, 200, { configured: false, probes: [], notes: ["Oracle EBS not configured"] });
    }
    // schemaEntity null -> runner reports drift unavailable; the SO push
    // is a write-only PL/SQL API with no readable schema.
    const opts = wantDrift ? { drift: { fieldMap: settings.oracle_ebs_field_map || {}, schemaEntity: null } } : {};
    const { probes, summary, drift } = await runConnectorDiagnostics(oracleEbsFetch, settings, PROBES, opts);
    return json(res, 200, { configured: true, base_url: settings.oracle_ebs_base_url, probes, summary, ...(wantDrift ? { drift } : {}), ran_at: new Date().toISOString() });
  } catch (err) { sendError(res, err); }
}
