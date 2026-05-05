// POST /api/sage_x3/connect
//
// Stores Sage X3 credentials on tenant_settings (encrypted when
// secrets are configured) and runs a probe call to validate them.
// Phase 5.4 batch 1.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings, updateTenantSettings } from "../_lib/stripe-client.js";
import { sagex3EncryptCreds, sagex3DecryptCreds, sagex3Probe } from "../_lib/sage-x3-client.js";
import { isSecretsConfigured } from "../_lib/secrets.js";

const REQUIRED = ["base_url", "token_url", "client_id", "client_secret"];

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
    const enc = sagex3EncryptCreds({ client_id: body.client_id, client_secret: body.client_secret });
    const updated = await updateTenantSettings(svc, ctx.tenantId, {
      sagex3_base_url: String(body.base_url).replace(/\/+$/, ""),
      sagex3_token_url: body.token_url,
      sagex3_solution: body.solution || "X3",
      sagex3_company: body.company || null,
      sagex3_locale: body.locale || "ENG",
      ...enc,
    });
    const decrypted = sagex3DecryptCreds({ ...updated, tenant_id: ctx.tenantId });

    let probe = null;
    let probeErr = null;
    try {
      probe = await sagex3Probe(decrypted);
    } catch (err) {
      probeErr = err.message;
      probe = { ok: false, status: 0, body: { error: err.message } };
    }
    if (probe.ok) {
      await updateTenantSettings(svc, ctx.tenantId, { sagex3_connected_at: new Date().toISOString() });
    }
    await recordAudit(ctx, {
      action: "sagex3_connect",
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
