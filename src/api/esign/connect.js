// POST /api/esign/connect Body: { account_id, base_path?, integration_key, user_id, rsa_private_key, webhook_secret? }

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings, updateTenantSettings } from "../_lib/stripe-client.js";
import { docusignEncryptCreds, docusignDecryptCreds, docusignFetch, docusignIsConfigured } from "../_lib/docusign-client.js";
import { isSecretsConfigured } from "../_lib/secrets.js";
import { safeProbeError } from "../_lib/sanitize.js";

const REQUIRED = ["account_id", "integration_key", "user_id", "rsa_private_key"];

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
    const enc = docusignEncryptCreds({ rsa_private_key: body.rsa_private_key });
    const updated = await updateTenantSettings(svc, ctx.tenantId, {
      docusign_account_id: body.account_id,
      docusign_base_path: body.base_path || "https://demo.docusign.net/restapi",
      docusign_integration_key: body.integration_key,
      docusign_user_id: body.user_id,
      docusign_webhook_secret: body.webhook_secret || null,
      ...enc,
    });
    const decrypted = docusignDecryptCreds({ ...updated, tenant_id: ctx.tenantId });
    if (!docusignIsConfigured(decrypted)) {
      // If secrets key missing the rsa key didn't get persisted; surface that.
      return json(res, 400, { error: { code: "ANVIL_SECRETS_KEY_MISSING", message: "ANVIL_SECRETS_KEY required to store DocuSign RSA key" } });
    }
    let probe = null;
    try {
      probe = await docusignFetch(decrypted, { method: "GET", path: `/v2.1/accounts/${body.account_id}` });
    } catch (err) { probe = { ok: false, status: 0, body: { error: err.message } }; }
    if (probe.ok) {
      await updateTenantSettings(svc, ctx.tenantId, { docusign_connected_at: new Date().toISOString() });
    }
    await recordAudit(ctx, {
      action: "docusign_connect",
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
