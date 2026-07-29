-- Graph inbound webhook authenticity — the subscription clientState secret.
--
-- The inbound Graph webhook (inbound/email/webhook.js) is public. Once it began
-- FETCHING the notified message with the tenant's OAuth token (the reply-loop
-- join), a forged notification became a way to make the server pull an
-- attacker-named message out of that tenant's mailbox. Microsoft's defence is
-- `clientState`: a secret set when the subscription is created and echoed back
-- in every notification. We store the expected value here and verify it before
-- any fetch — no match (or not configured) → fall back to the benign stub, never
-- a privileged fetch.
--
-- Set this to the SAME random string used as `clientState` when the Graph
-- subscription is created (the subscription is created out-of-band today; the
-- admin enters both via /api/inbound/email/configure). Applied MANUALLY.

alter table tenant_settings
  add column if not exists graph_client_state text;

comment on column tenant_settings.graph_client_state is
  'Secret echoed by Microsoft Graph in each inbound notification (subscription '
  'clientState). The webhook verifies it before fetching the message; absent = '
  'no privileged fetch (benign stub only).';
