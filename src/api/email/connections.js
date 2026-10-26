// /api/email/connections: the caller's connected mailboxes.
// docs/EMAIL_ACCOUNTABILITY_SCOPE.md sections 5, 6.1 and 6.8.
//
//   GET                 own mailboxes (admin: every mailbox of the tenant), safe
//                       columns only, plus { enabled, providers, redirect_uri }.
//   POST  { provider }  an authorize_url to connect the caller's own mailbox.
//   PATCH { id, resume }                        owner or admin: clear a pause.
//   PATCH { id, daily_request_budget, poll_interval_minutes,
//           initial_lookback_hours }            admin: the cost limits.
//   DELETE ?id=         owner or admin: disconnect. Deletes the tokens and the
//                       checkpoint at once. The row stays for its history.
//
// No token, secret or checkpoint ever leaves this endpoint.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission, hasPermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { isSecretsConfigured } from "../_lib/secrets.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { signState, publicBase } from "../_lib/graph-client.js";
import { getAdapter, PROVIDERS } from "../_lib/mail/adapters.js";
import { SAFE_COLUMNS } from "../_lib/mail/connections.js";

export const mailboxRedirectUri = () => {
  const base = publicBase();
  return base ? base + "/api/email/connect/callback" : null;
};

// Limits an admin may set, with the ranges of the migration 267 checks.
const LIMITS = {
  daily_request_budget: [0, 100000],
  poll_interval_minutes: [5, 1440],
  initial_lookback_hours: [1, 168],
};

const bad = (res, message) => json(res, 400, { error: { message } });

export const loadOwnRow = async (svc, ctx, id) => {
  const r = await svc.from("mailbox_connections")
    .select(SAFE_COLUMNS)
    .eq("tenant_id", ctx.tenantId)
    .eq("id", id)
    .maybeSingle();
  if (r.error) throw new Error("mailbox read: " + r.error.message);
  const row = r.data;
  // Someone else's mailbox reads as missing, so its existence does not leak.
  if (!row || (row.owner_user_id !== ctx.user.id && !hasPermission(ctx, "admin"))) return null;
  return row;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let q = svc.from("mailbox_connections").select(SAFE_COLUMNS).eq("tenant_id", ctx.tenantId);
      if (!hasPermission(ctx, "admin")) q = q.eq("owner_user_id", ctx.user.id);
      const rows = await q.order("created_at", { ascending: true });
      if (rows.error) throw new Error("mailbox list: " + rows.error.message);
      const s = await tenantSettings(svc, ctx.tenantId);
      const providers = Object.fromEntries(PROVIDERS.map((p) => [p, !!getAdapter(p).isConfigured(s)]));
      return json(res, 200, {
        ok: true,
        enabled: !!s?.email_accountability_enabled,
        actions_mode: s?.email_actions_mode === "create" ? "create" : "observe",
        providers,
        redirect_uri: mailboxRedirectUri(),
        mailboxes: rows.data || [],
      });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const adapter = getAdapter(String(body?.provider || ""));
      if (!adapter) return bad(res, "provider must be one of " + PROVIDERS.join(", "));
      if (!isSecretsConfigured()) return bad(res, "ANVIL_SECRETS_KEY must be configured before a mailbox connects");
      const redirectUri = mailboxRedirectUri();
      if (!redirectUri) return bad(res, "PUBLIC_APP_URL must be set for the OAuth callback");
      const s = await tenantSettings(svc, ctx.tenantId);
      if (!adapter.isConfigured(s)) return bad(res, body.provider + " app registration is not configured for this tenant");
      const state = signState(ctx.tenantId, 600_000, { k: "mailbox", u: ctx.user.id, p: body.provider });
      return json(res, 200, { ok: true, authorize_url: adapter.authorizeUrl({ settings: s, state, redirectUri }) });
    }

    if (req.method === "PATCH") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body?.id) return bad(res, "id required");
      const row = await loadOwnRow(svc, ctx, body.id);
      if (!row) return json(res, 404, { error: { message: "mailbox not found" } });

      const patch = {};
      for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
        if (body[k] === undefined) continue;
        requirePermission(ctx, "admin");
        const n = Number(body[k]);
        if (!Number.isInteger(n) || n < lo || n > hi) return bad(res, k + " must be an integer from " + lo + " to " + hi);
        patch[k] = n;
      }
      if (body.resume) {
        if (row.status === "disconnected" || row.status === "reauth_required") {
          return json(res, 409, { error: { message: "connect the mailbox again; a resume cannot fix " + row.status } });
        }
        Object.assign(patch, {
          status: "active", paused_until: null, pause_reason: null,
          consecutive_failures: 0, next_sync_at: new Date().toISOString(),
        });
      }
      if (!Object.keys(patch).length) return bad(res, "nothing to change");
      const up = await svc.from("mailbox_connections")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("tenant_id", ctx.tenantId)
        .eq("id", row.id)
        .select(SAFE_COLUMNS);
      if (up.error) throw new Error("mailbox update: " + up.error.message);
      await recordAudit(ctx, {
        action: body.resume ? "mailbox_resumed" : "mailbox_limits_changed",
        objectType: "mailbox_connection", objectId: row.id,
        before: Object.fromEntries(Object.keys(patch).map((k) => [k, row[k] ?? null])), after: patch,
      });
      return json(res, 200, { ok: true, mailbox: up.data?.[0] || null });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "write");
      const id = req.query?.id;
      if (!id) return bad(res, "id required");
      const row = await loadOwnRow(svc, ctx, id);
      if (!row) return json(res, 404, { error: { message: "mailbox not found" } });
      const now = new Date().toISOString();
      const up = await svc.from("mailbox_connections").update({
        status: "disconnected", access_token_enc: null, refresh_token_enc: null, token_expires_at: null,
        checkpoint: {}, sync_lease_until: null, next_sync_at: null, disconnected_at: now, updated_at: now,
      }).eq("tenant_id", ctx.tenantId).eq("id", row.id);
      if (up.error) throw new Error("mailbox disconnect: " + up.error.message);
      await recordAudit(ctx, {
        action: "mailbox_disconnected", objectType: "mailbox_connection", objectId: row.id,
        detail: row.provider,
      });
      return json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return json(res, 405, { error: { message: "method not allowed" } });
  } catch (err) {
    return sendError(res, err);
  }
}
