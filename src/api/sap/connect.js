// POST /api/sap/connect
// Body: { base_url, token_url, client_id, client_secret,
//         company_code?, sales_org?, distribution_channel?, division?, default_plant? }
//
// Stores credentials encrypted, runs an OAuth2 token probe, and a
// minimal OData GET against /API_BUSINESS_PARTNER_SRV/A_BusinessPartner?$top=1
// to confirm the service catalog and scope are reachable.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings, updateTenantSettings } from "../_lib/stripe-client.js";
import { sapEncryptCreds, sapDecryptCreds, sapFetch } from "../_lib/sap-client.js";
import { isSecretsConfigured } from "../_lib/secrets.js";
import { safeProbeError } from "../_lib/sanitize.js";

const REQUIRED = ["base_url", "token_url", "client_id", "client_secret"];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    const body = await readBody(req);
    for (const k of REQUIRED) if (!body?.[k]) return json(res, 400, { error: { message: k + " required" } });
    const svc = serviceClient();
    await tenantSettings(svc, ctx.tenantId);
    const enc = sapEncryptCreds({ client_id: body.client_id, client_secret: body.client_secret });
    const patch = {
      sap_base_url: String(body.base_url).replace(/\/+$/, ""),
      sap_token_url: body.token_url,
      sap_company_code: body.company_code || null,
      sap_sales_org: body.sales_org || null,
      sap_distribution_channel: body.distribution_channel || null,
      sap_division: body.division || null,
      sap_default_plant: body.default_plant || null,
      ...enc,
    };
    const updated = await updateTenantSettings(svc, ctx.tenantId, patch);
    const decrypted = sapDecryptCreds({ ...updated, tenant_id: ctx.tenantId });

    let probe = null;
    try {
      probe = await sapFetch(decrypted, {
        method: "GET",
        path: "/sap/opu/odata4/sap/api_business_partner/srvd_a2x/sap/businesspartner/0001/A_BusinessPartner",
        query: { $top: "1" },
      });
    } catch (err) { probe = { ok: false, status: 0, body: { error: err.message } }; }
    if (probe.ok) {
      await updateTenantSettings(svc, ctx.tenantId, { sap_connected_at: new Date().toISOString() });
    }
    await recordAudit(ctx, {
      action: "sap_connect",
      objectType: "tenant_settings",
      objectId: ctx.tenantId,
      detail: probe.ok ? "probe_ok" : ("probe_failed::" + probe.status),
    });
    return json(res, 200, {
      ok: probe.ok,
      probe_status: probe.status,
      probe_error: safeProbeError(probe, "connection_failed"),
      storage_mode: isSecretsConfigured() ? "encrypted" : "plaintext",
    });
  } catch (err) { sendError(res, err); }
}
