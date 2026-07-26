-- Microsoft Graph (Outlook) SEND provider — the OAuth authorization-code tokens.
--
-- docs/CUSTOMER_COMMS_DESIGN.md §5. A Graph send makes customer mail appear in
-- the sender's own Sent Items and returns conversationId + internetMessageId for
-- real threading — neither of which a SendGrid API send gives. It slots BEHIND
-- the provider ladder in _lib/comms-send.js (before SendGrid, gated on being
-- connected), so nothing else in the plan depends on it.
--
-- REUSE, don't duplicate: migration 028_inbound_email.sql already added the app
-- registration columns to tenant_settings for the INBOUND Graph integration —
-- graph_tenant_id, graph_client_id, graph_client_secret_enc, graph_creds_iv,
-- graph_mailbox — the SAME Azure app + mailbox that receives replies. The send
-- provider reuses those (and this migration is the first to actually store the
-- encrypted client secret, which inbound left as a v1 TODO).
--
-- This migration adds ONLY the refreshable authorization-code token bundle,
-- under a SEPARATE graph_token_iv so the ~hourly access/refresh rotation never
-- has to re-encrypt (and risk clobbering) the client secret that shares
-- graph_creds_iv. tenant_settings already has RLS.

alter table tenant_settings
  add column if not exists graph_access_token_enc  bytea,        -- ciphertext||tag, IV = graph_token_iv
  add column if not exists graph_refresh_token_enc bytea,        -- ciphertext||tag, IV = graph_token_iv
  add column if not exists graph_token_iv          bytea,        -- 12-byte IV for the (access, refresh) bundle ONLY
  add column if not exists graph_token_expires_at  timestamptz,  -- plaintext; the lazy on-send refresh checks it
  add column if not exists graph_connected_at      timestamptz;  -- plaintext; set on a successful OAuth callback

comment on column tenant_settings.graph_token_iv is
  'Separate 12-byte IV for the frequently-rotated (access_token, refresh_token) '
  'bundle. graph_creds_iv stays on the client_secret so a token refresh never '
  're-encrypts the secret. New two-IV convention, this vendor only.';
