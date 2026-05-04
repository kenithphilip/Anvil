// POST /api/netsuite/connect
// Body: { account_id, consumer_key, consumer_secret, token_id, token_secret }
//
// Stores TBA credentials on tenant_settings, runs a probe call to
// confirm the account is reachable + the integration record + token
// are valid. Returns { ok, probe } so the UI can show whether the
// connection works.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings, updateTenantSettings } from "../_lib/stripe-client.js";
import { netsuiteFetch } from "../_lib/netsuite-client.js";

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
    const updated = await updateTenantSettings(svc, ctx.tenantId, {
      netsuite_account_id: body.account_id,
      netsuite_consumer_key: body.consumer_key,
      netsuite_consumer_secret: body.consumer_secret,
      netsuite_token_id: body.token_id,
      netsuite_token_secret: body.token_secret,
    });

    // Probe: cheap SuiteQL call. The empty-result-but-200 case is
    // the success signal; a 401/403 means the credentials are wrong.
    let probe = null;
    try {
      probe = await netsuiteFetch(updated, {
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
      detail: probe.ok ? "probe_ok" : ("probe_failed::" + probe.status),
    });

    return json(res, 200, {
      ok: probe.ok,
      probe_status: probe.status,
      probe_error: probe.ok ? null : (probe.body?.["o:errorDetails"] || probe.body?.error || probe.body?.raw || null),
    });
  } catch (err) {
    sendError(res, err);
  }
}
