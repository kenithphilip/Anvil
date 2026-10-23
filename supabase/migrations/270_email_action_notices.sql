-- 270_email_action_notices.sql
--
-- Email accountability, EA-6: reminders and escalation.
-- docs/EMAIL_ACCOUNTABILITY_SCOPE.md 6.7.
--
--   email_action_notices  the ledger of every reminder and escalation. A
--                         notice is sent only after its row is inserted, and
--                         (email_action_id, notice_key) is unique, so a second
--                         sweep, an overlapping tick or a retry never sends it
--                         twice. The key holds the kind, the level, the owner,
--                         the due time and the reopen count: a new owner, a new
--                         due time or a reopen gives a new key. status 'failed'
--                         is retried up to 3 attempts.
--   tenant_settings       email_policy: the tenant's overlay on the default
--                         policy (_lib/email-accountability/policy.js). Empty
--                         means the defaults.
--
-- RLS on with no tenant-user policy. Additive and idempotent. APPLY BY HAND
-- after 269 (and 253, which notify() needs for a notice per person), then:
--
--   notify pgrst, 'reload schema';
--
-- VERIFY. Expect 1 and 1.
--
--   select count(*) from information_schema.tables where table_name = 'email_action_notices';
--   select count(*) from information_schema.columns
--    where table_name = 'tenant_settings' and column_name = 'email_policy';

create table if not exists email_action_notices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  email_action_id uuid not null references email_actions(id) on delete cascade,
  notice_key text not null,
  kind text not null check (kind in ('created', 'ack', 'due_soon', 'overdue', 'escalation')),
  level int not null default 0,
  -- { users: [uuid], roles: [text] }
  recipients jsonb not null default '{}'::jsonb,
  status text not null default 'claimed' check (status in ('claimed', 'sent', 'failed')),
  attempts int not null default 0,
  delivered int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create unique index if not exists email_action_notices_key_uq
  on email_action_notices (email_action_id, notice_key);
create index if not exists email_action_notices_tenant_idx
  on email_action_notices (tenant_id, created_at desc);
create index if not exists email_action_notices_failed_idx
  on email_action_notices (tenant_id, status) where status = 'failed';

comment on table email_action_notices is
  'Email accountability: the ledger of reminders and escalations. Unique per action and notice key, so no notice is sent twice. RLS on, no tenant-user policy.';

alter table email_action_notices enable row level security;
revoke all on email_action_notices from anon, authenticated;

alter table tenant_settings
  add column if not exists email_policy jsonb not null default '{}'::jsonb;
