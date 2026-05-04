// POST /api/netsuite/connect
// Body: { account_id, consumer_key, consumer_secret, token_id, token_secret,
//         subsidiary_id?, default_location_id? }
//
// Stores TBA credentials encrypted at rest on tenant_settings, runs a
// probe call to confirm the account is reachable + the integration
// record + token are valid. Returns { ok, probe } so the UI can show
// whether the connection works.
//
// v2: credentials live in netsuite_*_enc columns under AES-256-GCM
// with a per-tenant IV. The plaintext columns remain on the schema
// for the rotation window but are written as null so a stolen DB
// dump doesn't expose live tokens. If ANVIL_SECRETS_KEY is missing
// we fall back to plaintext (with a deprecation warning) so dev
// environments without the key still work.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings, updateTenantSettings } from "../_lib/stripe-client.js";
import { netsuiteFetch } from "../_lib/netsuite-client.js";
import { encryptNetsuiteCreds, decryptNetsuiteCreds, isSecretsConfigured } from "../_lib/secrets.js";

const REQUIRED = ["account_id", "consumer_key", "consumer_secret", "token_id", "token_secret"];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    const body = await readBody(req);
    for (const key of REQUIRED) {
      if (!body?.[key]) return json(res, 400, { error: { message: key + " required" } });
    }
    const svc = serviceClient();
    await tenantSettings(svc, ctx.tenantId);

    const patch = {
      netsuite_account_id: body.account_id,
      netsuite_subsidiary_id: body.subsidiary_id || null,
      netsuite_default_location_id: body.default_location_id || null,
    };

    let storageMode = "plaintext";
    if (isSecretsConfigured()) {
      const enc = encryptNetsuiteCreds({
        consumer_key: body.consumer_key,
        consumer_secret: body.consumer_secret,
        token_id: body.token_id,
        token_secret: body.token_secret,
      });
      Object.assign(patch, enc);
      // Null out plaintext columns so dumps don't carry them.
      patch.netsuite_consumer_key = null;
      patch.netsuite_consumer_secret = null;
      patch.netsuite_token_id = null;
      patch.netsuite_token_secret = null;
      storageMode = "encrypted";
    } else {
      patch.netsuite_consumer_key = body.consumer_key;
      patch.netsuite_consumer_secret = body.consumer_secret;
      patch.netsuite_token_id = body.token_id;
      patch.netsuite_token_secret = body.token_secret;
    }

    const updated = await updateTenantSettings(svc, ctx.tenantId, patch);
    const decrypted = decryptNetsuiteCreds(updated);

    // Probe: cheap SuiteQL call. The empty-result-but-200 case is
    // the success signal; a 401/403 means the credentials are wrong.
    let probe = null;
    try {
      probe = await netsuiteFetch(decrypted, {
        method: "POST",
        path: "/services/rest/query/v1/suiteql",
        body: { q: "SELECT id FROM customer FETCH FIRST 1 ROWS ONLY" },
      });
    } catch (err) {
      probe = { ok: false, status: 0, body: { error: err.message } };
    }
    if (probe.ok) {
      await updateTenantSettings(svc, ctx.tenantId, {
        netsuite_connected_at: new Date().toISOString(),
      });
    }
    await recordAudit(ctx, {
      action: "netsuite_connect",
      objectType: "tenant_settings",
      objectId: ctx.tenantId,
      detail: (probe.ok ? "probe_ok" : ("probe_failed::" + probe.status)) + "::" + storageMode,
    });

    return json(res, 200, {
      ok: probe.ok,
      probe_status: probe.status,
      probe_error: probe.ok ? null : (probe.body?.["o:errorDetails"] || probe.body?.error || probe.body?.raw || null),
      storage_mode: storageMode,
    });
  } catch (err) {
    sendError(res, err);
  }
}
