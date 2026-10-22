// /api/email/connect/callback: the OAuth redirect target for a user mailbox.
//
// PUBLIC: the provider sends the user's browser here with ?code&state and no
// Anvil session. The signed state (graph-client signState, purpose "mailbox")
// names the tenant, the user and the provider, and expires in 10 minutes. A
// state minted for another purpose, a forged one or an old one is refused.
//
// It stores the tokens (secrets v2), reads the mailbox address from the
// provider, and redirects to the app. It never renders the code, a token or a
// provider error body.

import { applyCors, handlePreflight, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { isSecretsConfigured } from "../_lib/secrets.js";
import { resolveAssignee } from "../_lib/assignee.js";
import { verifyState, publicBase } from "../_lib/graph-client.js";
import { getAdapter } from "../_lib/mail/adapters.js";
import { newRun } from "../_lib/mail/provider.js";
import { tokenColumns } from "../_lib/mail/connections.js";
import { mailboxRedirectUri } from "./connections.js";

const redirect = (res, status) => {
  res.statusCode = 302;
  res.setHeader("Location", publicBase() + "/#/admin?tab=communications&mailbox=" + encodeURIComponent(status));
  res.end();
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    if (req.method !== "GET") { res.statusCode = 405; res.end(); return; }
    const q = req.query || {};
    if (q.error) return redirect(res, "denied");

    const st = verifyState(q.state, "mailbox");
    if (!st || !st.userId) return redirect(res, "invalid_state");
    if (!q.code) return redirect(res, "no_code");
    const adapter = getAdapter(st.provider);
    if (!adapter) return redirect(res, "invalid_state");

    const svc = serviceClient();
    const s = await svc.from("tenant_settings").select("*").eq("tenant_id", st.tenantId).maybeSingle();
    const settings = s.data ? { ...s.data, tenant_id: st.tenantId } : null;
    if (!settings || !adapter.isConfigured(settings) || !isSecretsConfigured()) return redirect(res, "not_configured");
    // The state lives 10 minutes; the user may have left the tenant since.
    if (!(await resolveAssignee(svc, st.tenantId, st.userId))) return redirect(res, "not_member");

    let tokens;
    try {
      tokens = await adapter.exchange({ settings, code: q.code, redirectUri: mailboxRedirectUri() });
    } catch {
      return redirect(res, "exchange_failed");
    }
    // Without a refresh token the sync stops within the hour. Refuse a half state.
    if (!tokens.refreshToken) return redirect(res, "no_refresh_token");

    let me;
    try {
      me = await adapter.whoAmI(tokens.accessToken, newRun({ budget: 3, deadline: Date.now() + 10_000 }));
    } catch {
      return redirect(res, "identity_failed");
    }
    if (!me?.address) return redirect(res, "identity_failed");

    const existing = await svc.from("mailbox_connections")
      .select("id, owner_user_id, status")
      .eq("tenant_id", st.tenantId)
      .eq("provider", st.provider)
      .eq("address", me.address)
      .maybeSingle();
    if (existing.error) throw new Error("mailbox lookup: " + existing.error.message);
    const prior = existing.data;
    if (prior && prior.owner_user_id !== st.userId && prior.status !== "disconnected") {
      return redirect(res, "address_taken");
    }

    const now = new Date().toISOString();
    const row = {
      tenant_id: st.tenantId, provider: st.provider, kind: "user",
      owner_user_id: st.userId, address: me.address,
      display_name: me.displayName, provider_user_id: me.providerUserId,
      scopes: tokens.scopes || [], ...tokenColumns(tokens),
      status: "active", consecutive_failures: 0, last_error: null,
      paused_until: null, pause_reason: null, sync_lease_until: null,
      next_sync_at: now, connected_by: st.userId, connected_at: now, disconnected_at: null,
      updated_at: now,
    };
    let id = prior?.id;
    if (prior) {
      // A new owner starts a fresh sync; the same owner keeps the checkpoint.
      const patch = prior.owner_user_id === st.userId ? row : { ...row, checkpoint: {}, last_success_at: null };
      const up = await svc.from("mailbox_connections").update(patch).eq("tenant_id", st.tenantId).eq("id", prior.id);
      if (up.error) throw new Error("mailbox update: " + up.error.message);
    } else {
      const ins = await svc.from("mailbox_connections").insert(row).select("id");
      if (ins.error) {
        // 23505: a parallel callback for the same address won.
        if (ins.error.code === "23505") return redirect(res, "address_taken");
        throw new Error("mailbox insert: " + ins.error.message);
      }
      id = ins.data?.[0]?.id;
    }
    await recordAudit({ tenantId: st.tenantId, user: { id: st.userId }, role: null }, {
      action: "mailbox_connected", objectType: "mailbox_connection", objectId: id || null,
      detail: st.provider,
    });
    return redirect(res, "connected");
  } catch (err) {
    return sendError(res, err);
  }
}
