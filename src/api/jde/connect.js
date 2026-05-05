// POST /api/jde/connect
//
// Stores JD Edwards EnterpriseOne (AIS) credentials on tenant_settings
// (encrypted when secrets are configured) and runs a probe call to
// validate them. Phase 5.4b cluster B.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings, updateTenantSettings } from "../_lib/stripe-client.js";
import { jdeEncryptCreds, jdeDecryptCreds, jdeProbe } from "../_lib/jde-client.js";
import { isSecretsConfigured } from "../_lib/secrets.js";

const REQUIRED = ["base_url", "environment", "role", "username", "password"];

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
    const enc = jdeEncryptCreds({ username: body.username, password: body.password });
    const updated = await updateTenantSettings(svc, ctx.tenantId, {
      jde_base_url: String(body.base_url).replace(/\/+$/, ""),
      jde_environment: body.environment,
      jde_role: body.role,
      jde_device: body.device || "Anvil",
      ...enc,
    });
    const decrypted = jdeDecryptCreds({ ...updated, tenant_id: ctx.tenantId });

    let probe = null;
    let probeErr = null;
    try {
      probe = await jdeProbe(decrypted);
    } catch (err) {
      probeErr = err.message;
      probe = { ok: false, status: 0, body: { error: err.message } };
    }
    if (probe.ok) {
      await updateTenantSettings(svc, ctx.tenantId, { jde_connected_at: new Date().toISOString() });
    }
    await recordAudit(ctx, {
      action: "jde_connect",
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
