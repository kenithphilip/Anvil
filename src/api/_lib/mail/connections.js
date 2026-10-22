// Mailbox connection rows: the columns the API may return, the token store,
// and a valid access token (with refresh). Tokens are secrets v2 values and
// never leave the server.

import { encryptField, decryptField } from "../secrets.js";
import { MailError } from "./provider.js";

// Everything except the token columns and the checkpoint (a provider URL that
// carries a sync token).
export const SAFE_COLUMNS = [
  "id", "tenant_id", "provider", "kind", "owner_user_id", "address", "display_name", "scopes",
  "status", "last_sync_at", "last_success_at", "next_sync_at", "last_sync_stats",
  "consecutive_failures", "last_error", "last_error_at", "quota_errors", "checkpoint_resets",
  "paused_until", "pause_reason", "requests_today", "requests_date", "daily_request_budget",
  "poll_interval_minutes", "initial_lookback_hours", "connected_at", "disconnected_at",
].join(", ");

export const tokenColumns = ({ accessToken, refreshToken, expiresAt }) => ({
  access_token_enc: accessToken ? encryptField(accessToken) : null,
  refresh_token_enc: refreshToken ? encryptField(refreshToken) : null,
  token_expires_at: expiresAt || null,
});

const open = (v) => {
  if (!v) return null;
  try { return decryptField(v); } catch { return null; }
};

// A valid access token for the connection. Refreshes and stores the new token
// when the stored one expires within 60 s. A refused refresh is MailError
// "auth", which the runner turns into reauth_required.
export const accessTokenFor = async (svc, conn, settings, adapter) => {
  const exp = conn.token_expires_at ? Date.parse(conn.token_expires_at) : 0;
  const access = open(conn.access_token_enc);
  if (access && exp > Date.now() + 60_000) return access;
  const refreshToken = open(conn.refresh_token_enc);
  if (!refreshToken) throw new MailError("auth", "no refresh token");

  const t = await adapter.refresh({ settings, refreshToken });
  // A provider that does not rotate the refresh token keeps the old one valid.
  const patch = tokenColumns({ accessToken: t.accessToken, refreshToken: t.refreshToken || refreshToken, expiresAt: t.expiresAt });
  const { error } = await svc.from("mailbox_connections")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("tenant_id", conn.tenant_id)
    .eq("id", conn.id);
  if (error) throw new MailError("transient", "token save failed");
  return t.accessToken;
};
