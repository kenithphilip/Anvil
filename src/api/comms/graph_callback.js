// /api/comms/graph/callback — the Microsoft OAuth redirect target.
//
// PUBLIC: Microsoft redirects the admin's browser here with ?code&state and no
// Anvil session, so this handler does NOT run the session resolver. Instead it
// trusts the signed `state` — an HMAC over (tenant_id, nonce, expiry) that only our own
// /comms/graph GET could have minted — which makes the exchange CSRF-safe and
// tenant-bound without a session. A forged or expired state is rejected.
//
// On success it stores the encrypted access + refresh tokens and 302-redirects
// back to the app. It never renders the code, tokens, or a raw provider error.

import { applyCors, handlePreflight, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { updateTenantSettings } from "../_lib/stripe-client.js";
import {
  verifyState, exchangeCode, graphEncryptTokens, graphDecryptSecret,
  graphIsConfigured, graphSecretsReady, graphRedirectUri, graphUiReturnUrl,
} from "../_lib/graph-client.js";

const redirect = (res, status) => {
  res.statusCode = 302;
  res.setHeader("Location", graphUiReturnUrl(status));
  res.end();
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    if (req.method !== "GET") { res.statusCode = 405; res.end(); return; }
    const q = req.query || {};

    // The user declined consent, or Azure returned an error. Do NOT surface the
    // provider's error detail (it can echo request info); a generic status is enough.
    if (q.error) return redirect(res, "denied");

    const st = verifyState(q.state);
    if (!st) return redirect(res, "invalid_state");
    if (!q.code) return redirect(res, "no_code");

    const svc = serviceClient();
    const row = await svc.from("tenant_settings").select("*").eq("tenant_id", st.tenantId).maybeSingle();
    const s = row.data ? { ...row.data, tenant_id: st.tenantId } : null;
    if (!s || !graphIsConfigured(s) || !graphSecretsReady()) return redirect(res, "not_configured");

    let tokens;
    try {
      tokens = await exchangeCode({
        azureTenant: s.graph_tenant_id,
        clientId: s.graph_client_id,
        clientSecret: graphDecryptSecret(s),
        code: q.code,
        redirectUri: graphRedirectUri(),
      });
    } catch (_e) {
      // _e may carry a provider body on .parsed — never render it.
      return redirect(res, "exchange_failed");
    }

    const encTok = graphEncryptTokens({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });
    if (!encTok.graph_refresh_token_enc) {
      // No refresh token means offline_access was not granted; without it we
      // cannot keep sending. Treat as a failed connect rather than a half-state.
      return redirect(res, "no_refresh_token");
    }
    await updateTenantSettings(svc, st.tenantId, {
      ...encTok,
      graph_token_expires_at: new Date(Date.now() + (Number(tokens.expires_in) || 3600) * 1000).toISOString(),
      graph_connected_at: new Date().toISOString(),
    });
    await recordAudit({ tenantId: st.tenantId, user: null, role: "admin" }, {
      action: "graph_connected", objectType: "tenant_settings", objectId: st.tenantId,
      detail: "sender=" + (s.graph_mailbox || ""),
    });
    return redirect(res, "connected");
  } catch (err) {
    return sendError(res, err);
  }
}
