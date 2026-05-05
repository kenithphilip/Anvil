// POST /api/plex/connect
//
// Stores Plex Smart Manufacturing Platform credentials on
// tenant_settings (encrypted when secrets are configured) and runs
// a probe call. Phase 5.4b cluster B.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings, updateTenantSettings } from "../_lib/stripe-client.js";
import { plexEncryptCreds, plexDecryptCreds, plexProbe } from "../_lib/plex-client.js";
import { isSecretsConfigured } from "../_lib/secrets.js";

const REQUIRED = ["base_url", "customer_id", "api_key"];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    const body = await readBody(req);
    for (const k of REQUIRED) {
      if (!body?.[k]) return json(res, 400, { error: { message: k + " required" } });
    }
    const svc = serviceClient();
    await tenantSettings(svc, ctx.tenantId);
    const enc = plexEncryptCreds({ api_key: body.api_key });
    const updated = await updateTenantSettings(svc, ctx.tenantId, {
      plex_base_url: String(body.base_url).replace(/\/+$/, ""),
      plex_customer_id: String(body.customer_id),
      plex_pcn: body.pcn || null,
      ...enc,
    });
    const decrypted = plexDecryptCreds({ ...updated, tenant_id: ctx.tenantId });

    let probe = null;
    let probeErr = null;
    try {
      probe = await plexProbe(decrypted);
    } catch (err) {
      probeErr = err.message;
      probe = { ok: false, status: 0, body: { error: err.message } };
    }
    if (probe.ok) {
      await updateTenantSettings(svc, ctx.tenantId, { plex_connected_at: new Date().toISOString() });
    }
    await recordAudit(ctx, {
      action: "plex_connect",
      objectType: "tenant_settings",
      objectId: ctx.tenantId,
      detail: probe.ok ? "probe_ok" : ("probe_failed::" + probe.status),
    });
    return json(res, 200, {
      ok: probe.ok,
      probe_status: probe.status,
      probe_error: probe.ok ? null : (probeErr || probe.body?.error || probe.body?.raw),
      storage_mode: isSecretsConfigured() ? "encrypted" : "plaintext",
    });
  } catch (err) {
    return sendError(res, err);
  }
}
