-- 070_inbound_email_reply_handled.sql
--
-- Audit P6.8. The dunning agent's reply-handling loop processes
-- inbound_emails rows with classified_intent='payment_acknowledge'
-- (and other actionable reply intents added later). Each row
-- should be handled exactly once. Adding a per-row marker so a
-- replay or a re-run of the cron drain doesn't re-fire on the
-- same email.

alter table inbound_emails
  add column if not exists agent_reply_handled_at timestamptz,
  add column if not exists agent_reply_action text;

create index if not exists inbound_emails_unhandled_intent_idx
  on inbound_emails (tenant_id, classified_intent)
  where agent_reply_handled_at is null
    and classified_intent in ('payment_acknowledge', 'delivery_query', 'complaint');
