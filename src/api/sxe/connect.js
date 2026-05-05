// POST /api/sxe/connect

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings, updateTenantSettings } from "../_lib/stripe-client.js";
import { sxeEncryptCreds, sxeDecryptCreds, sxeFetch } from "../_lib/sxe-client.js";
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
    const enc = sxeEncryptCreds({ client_id: body.client_id, client_secret: body.client_secret });
    const updated = await updateTenantSettings(svc, ctx.tenantId, {
      sxe_base_url: String(body.base_url).replace(/\/+$/, ""),
      sxe_token_url: body.token_url,
      sxe_company: body.company || null,
      sxe_default_warehouse: body.default_warehouse || null,
      ...enc,
    });
    const decrypted = sxeDecryptCreds({ ...updated, tenant_id: ctx.tenantId });
    let probe = null;
    try {
      probe = await sxeFetch(decrypted, {
        method: "GET",
        path: "/M3/m3api-rest/v2/customer",
        query: { $top: "1" },
      });
    } catch (err) { probe = { ok: false, status: 0, body: { error: err.message } }; }
    if (probe.ok) {
      await updateTenantSettings(svc, ctx.tenantId, { sxe_connected_at: new Date().toISOString() });
    }
    await recordAudit(ctx, {
      action: "sxe_connect", objectType: "tenant_settings", objectId: ctx.tenantId,
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
