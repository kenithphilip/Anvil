// /api/email/google_app: the tenant's own Google OAuth client, for Gmail
// mailbox connections. docs/EMAIL_ACCOUNTABILITY_SCOPE.md 5.2 and ED-3.
//
// The client is an Internal app in the customer's Google Workspace, so Google
// needs no app verification and no CASA assessment. Admin only.
//
//   GET     { configured, client_id, redirect_uri }. Never the secret.
//   PUT     { client_id, client_secret }: store it (the secret encrypted).
//   DELETE  clear it. Connected Gmail mailboxes then fail their next token
//           refresh and show reauth_required.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { encryptField, isSecretsConfigured } from "../_lib/secrets.js";
import { tenantSettings, updateTenantSettings } from "../_lib/stripe-client.js";
import { mailboxRedirectUri } from "./connections.js";

const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,200}\.apps\.googleusercontent\.com$/;

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    const svc = serviceClient();

    if (req.method === "GET") {
      const s = await tenantSettings(svc, ctx.tenantId);
      return json(res, 200, {
        ok: true,
        configured: !!(s?.google_oauth_client_id && s?.google_oauth_client_secret_enc),
        client_id: s?.google_oauth_client_id || null,
        redirect_uri: mailboxRedirectUri(),
      });
    }

    if (req.method === "PUT") {
      if (!isSecretsConfigured()) return json(res, 400, { error: { message: "ANVIL_SECRETS_KEY must be configured first" } });
      const body = await readBody(req);
      const clientId = String(body?.client_id || "").trim();
      const secret = String(body?.client_secret || "");
      if (!CLIENT_ID_RE.test(clientId)) return json(res, 400, { error: { message: "client_id must be a Google OAuth client id (*.apps.googleusercontent.com)" } });
      if (!secret || secret.length > 200) return json(res, 400, { error: { message: "client_secret required" } });
      await tenantSettings(svc, ctx.tenantId);
      await updateTenantSettings(svc, ctx.tenantId, {
        google_oauth_client_id: clientId,
        google_oauth_client_secret_enc: encryptField(secret),
      });
      await recordAudit(ctx, { action: "google_app_configured", objectType: "tenant_settings", objectId: ctx.tenantId, detail: clientId });
      return json(res, 200, { ok: true, configured: true, client_id: clientId, redirect_uri: mailboxRedirectUri() });
    }

    if (req.method === "DELETE") {
      await updateTenantSettings(svc, ctx.tenantId, { google_oauth_client_id: null, google_oauth_client_secret_enc: null });
      await recordAudit(ctx, { action: "google_app_cleared", objectType: "tenant_settings", objectId: ctx.tenantId });
      return json(res, 200, { ok: true, configured: false });
    }

    res.setHeader("Allow", "GET, PUT, DELETE");
    return json(res, 405, { error: { message: "method not allowed" } });
  } catch (err) {
    return sendError(res, err);
  }
}
