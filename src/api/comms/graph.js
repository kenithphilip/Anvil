// /api/comms/graph — configure + connect the Microsoft Graph (Outlook) provider.
//
//   GET     status: { configured, connected, sender, azure_tenant_id, client_id,
//                     redirect_uri, storage_mode, authorize_url? }. Never returns
//                     the client secret or any token.
//   PUT     { azure_tenant_id, client_id, client_secret, sender } — store the app
//                     registration (secret encrypted). Clears any existing tokens
//                     so the admin re-consents. Returns the authorize_url to open.
//   DELETE  disconnect: clears the OAuth tokens. `?full=1` also clears the app
//                     config.
//
// The actual OAuth redirect is opened by the admin UI using authorize_url; the
// browser returns to /api/comms/graph/callback. Admin-only. See §5 + graph-client.js.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings, updateTenantSettings } from "../_lib/stripe-client.js";
import {
  graphEncryptSecret, graphIsConfigured, graphIsConnected, graphSecretsReady,
  buildAuthorizeUrl, graphRedirectUri, signState,
} from "../_lib/graph-client.js";

const REQUIRED = ["azure_tenant_id", "client_id", "client_secret", "sender"];

const statusPayload = (ctx, s) => {
  const configured = graphIsConfigured(s);
  const redirectUri = graphRedirectUri();
  let authorizeUrl = null;
  if (configured && redirectUri) {
    try {
      authorizeUrl = buildAuthorizeUrl({
        azureTenant: s.graph_tenant_id, clientId: s.graph_client_id,
        redirectUri, state: signState(ctx.tenantId),
      });
    } catch (_e) { authorizeUrl = null; }
  }
  return {
    configured,
    connected: graphIsConnected(s),
    sender: s.graph_mailbox || null,
    azure_tenant_id: s.graph_tenant_id || null,
    client_id: s.graph_client_id || null,     // public in OAuth; not a secret
    connected_at: s.graph_connected_at || null,
    redirect_uri: redirectUri,                // register THIS in Azure
    storage_mode: graphSecretsReady() ? "encrypted" : "unavailable",
    authorize_url: authorizeUrl,
  };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "admin");
      const s = await tenantSettings(svc, ctx.tenantId);
      return json(res, 200, { ok: true, ...statusPayload(ctx, { ...s, tenant_id: ctx.tenantId }) });
    }

    if (req.method === "PUT") {
      requirePermission(ctx, "admin");
      // Refuse to configure OAuth we cannot encrypt at rest — a refresh token in
      // plaintext is not acceptable.
      if (!graphSecretsReady()) {
        return json(res, 400, { error: { message: "ANVIL_SECRETS_KEY must be configured before connecting Graph" } });
      }
      const body = await readBody(req);
      for (const k of REQUIRED) if (!body?.[k]) return json(res, 400, { error: { message: k + " required" } });
      if (!graphRedirectUri()) {
        return json(res, 400, { error: { message: "PUBLIC_APP_URL (or GRAPH_REDIRECT_URI) must be set for the OAuth callback" } });
      }

      await tenantSettings(svc, ctx.tenantId);
      const enc = graphEncryptSecret({ client_secret: body.client_secret });
      // These config columns are SHARED with the inbound Graph integration (they
      // are the same Azure app + mailbox). We are the first to store the secret
      // encrypted — inbound left it as a v1 TODO.
      const updated = await updateTenantSettings(svc, ctx.tenantId, {
        graph_tenant_id: String(body.azure_tenant_id).trim(),
        graph_client_id: String(body.client_id).trim(),
        graph_mailbox: String(body.sender).trim(),
        ...enc,
        // Reconfiguring invalidates any prior consent — clear tokens.
        graph_access_token_enc: null,
        graph_refresh_token_enc: null,
        graph_token_iv: null,
        graph_token_expires_at: null,
        graph_connected_at: null,
      });
      await recordAudit(ctx, {
        action: "graph_configured", objectType: "tenant_settings", objectId: ctx.tenantId,
        detail: "sender=" + String(body.sender).trim(),
      });
      return json(res, 200, { ok: true, ...statusPayload(ctx, { ...updated, tenant_id: ctx.tenantId }) });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      // Disconnect clears ONLY the OAuth tokens. It deliberately leaves the
      // app-registration config (graph_tenant_id / client_id / secret / mailbox)
      // intact because those columns are SHARED with the inbound Graph
      // integration — nuking them here would break inbound too.
      await updateTenantSettings(svc, ctx.tenantId, {
        graph_access_token_enc: null, graph_refresh_token_enc: null,
        graph_token_iv: null, graph_token_expires_at: null, graph_connected_at: null,
      });
      await recordAudit(ctx, {
        action: "graph_disconnected", objectType: "tenant_settings", objectId: ctx.tenantId, detail: "tokens",
      });
      return json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, PUT, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    return sendError(res, err);
  }
}
