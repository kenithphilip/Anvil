// /api/inbound/email/configure
// GET   -> returns the per-tenant inbound config (sans secrets)
// PUT   -> updates Postmark or Graph config

import { applyCors, handlePreflight, json, readBody, sendError } from "../../_lib/cors.js";
import { resolveContext, requirePermission } from "../../_lib/auth.js";
import { serviceClient } from "../../_lib/supabase.js";
import { recordAudit } from "../../_lib/audit.js";
import { tenantSettings, updateTenantSettings } from "../../_lib/stripe-client.js";
import { isSecretsConfigured } from "../../_lib/secrets.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const s = await tenantSettings(svc, ctx.tenantId);
      return json(res, 200, {
        postmark: {
          inbound_address: s?.postmark_inbound_address || null,
          secret_set: !!s?.postmark_inbound_secret,
        },
        graph: {
          tenant_id: s?.graph_tenant_id || null,
          mailbox: s?.graph_mailbox || null,
          subscription_id: s?.graph_subscription_id || null,
          client_id_set: !!(s?.graph_client_id || s?.graph_client_id_enc),
        },
        secrets_key_present: isSecretsConfigured(),
      });
    }
    if (req.method === "PUT" || req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      const patch = {};
      if (body.postmark) {
        if (body.postmark.inbound_address !== undefined) patch.postmark_inbound_address = body.postmark.inbound_address;
        if (body.postmark.inbound_secret !== undefined) patch.postmark_inbound_secret = body.postmark.inbound_secret;
      }
      if (body.graph) {
        if (body.graph.tenant_id !== undefined) patch.graph_tenant_id = body.graph.tenant_id;
        if (body.graph.mailbox !== undefined) patch.graph_mailbox = body.graph.mailbox;
        if (body.graph.subscription_id !== undefined) patch.graph_subscription_id = body.graph.subscription_id;
        if (body.graph.client_id !== undefined) patch.graph_client_id = body.graph.client_id;
        // Encrypted fields would route through secrets.js; v1 accepts plaintext for now.
      }
      await tenantSettings(svc, ctx.tenantId);
      await updateTenantSettings(svc, ctx.tenantId, patch);
      await recordAudit(ctx, {
        action: "inbound_email_configure",
        objectType: "tenant_settings",
        objectId: ctx.tenantId,
        detail: Object.keys(patch).join(","),
      });
      return json(res, 200, { ok: true });
    }
    res.setHeader("Allow", "GET, PUT");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
