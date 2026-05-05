// POST /api/d365/connect

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings, updateTenantSettings } from "../_lib/stripe-client.js";
import { d365EncryptCreds, d365DecryptCreds, d365Fetch } from "../_lib/d365-client.js";
import { isSecretsConfigured } from "../_lib/secrets.js";
import { safeProbeError } from "../_lib/sanitize.js";

const REQUIRED = ["resource_url", "token_url", "tenant_id", "client_id", "client_secret"];

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
    const enc = d365EncryptCreds({ client_id: body.client_id, client_secret: body.client_secret });
    const updated = await updateTenantSettings(svc, ctx.tenantId, {
      d365_resource_url: String(body.resource_url).replace(/\/+$/, ""),
      d365_token_url: body.token_url,
      d365_tenant_id: body.tenant_id,
      d365_company: body.company || null,
      d365_default_warehouse: body.default_warehouse || null,
      d365_default_site: body.default_site || null,
      ...enc,
    });
    const decrypted = d365DecryptCreds({ ...updated, tenant_id: ctx.tenantId });
    let probe = null;
    try {
      probe = await d365Fetch(decrypted, { method: "GET", path: "/data/CustomersV3", query: { $top: "1" } });
    } catch (err) { probe = { ok: false, status: 0, body: { error: err.message } }; }
    if (probe.ok) {
      await updateTenantSettings(svc, ctx.tenantId, { d365_connected_at: new Date().toISOString() });
    }
    await recordAudit(ctx, {
      action: "d365_connect",
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
