-- 267_mailbox_connections.sql
--
-- Email accountability, EA-1: one row per connected mailbox, with its sync
-- checkpoint, health and cost limits. docs/EMAIL_ACCOUNTABILITY_SCOPE.md
-- sections 5, 6.1 and 7.
--
--   mailbox_connections  one row per (tenant, provider, address). A user
--                        mailbox has owner_user_id. kind 'shared' is in the
--                        check for a later shared mailbox; v1 writes 'user'.
--                        Tokens are secrets v2 values (one self-contained
--                        value per column, no IV column).
--   tenant_settings      email_accountability_enabled (default false): the
--                        sync does nothing for a tenant until an admin turns
--                        it on. google_oauth_client_id and _secret_enc: the
--                        tenant's own Internal Google app (EA-2, ED-3). The
--                        Microsoft app registration reuses the graph_* columns
--                        of migration 028.
--
-- RLS is on with NO policy for tenant users. The rows carry encrypted tokens,
-- so only the service role reads them. The API returns the safe columns.
--
-- Additive and idempotent. APPLY BY HAND, then reload the PostgREST cache:
--
--   notify pgrst, 'reload schema';
--
-- VERIFY. Expect 1 and 3.
--
--   select count(*) from information_schema.tables
--    where table_name = 'mailbox_connections';
--   select count(*) from information_schema.columns
--    where table_name = 'tenant_settings'
--      and column_name in ('email_accountability_enabled',
--                          'google_oauth_client_id',
--                          'google_oauth_client_secret_enc');

create table if not exists mailbox_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  provider text not null check (provider in ('outlook', 'gmail')),
  kind text not null default 'user' check (kind in ('user', 'shared')),
  owner_user_id uuid references auth.users(id) on delete set null,
  address text not null,
  display_name text,
  provider_user_id text,
  scopes text[] not null default '{}',

  access_token_enc bytea,
  refresh_token_enc bytea,
  token_expires_at timestamptz,

  status text not null default 'active'
    check (status in ('active', 'reauth_required', 'paused', 'disconnected')),
  -- Per folder: { "inbox": <Graph delta or next link>, "sent": ... } for
  -- Outlook; { "all": { "historyId": ... } } for Gmail. The adapter owns it.
  checkpoint jsonb not null default '{}'::jsonb,
  last_sync_at timestamptz,
  last_success_at timestamptz,
  next_sync_at timestamptz,
  sync_lease_until timestamptz,
  last_sync_stats jsonb not null default '{}'::jsonb,

  consecutive_failures int not null default 0,
  last_error text,
  last_error_at timestamptz,
  quota_errors int not null default 0,
  checkpoint_resets int not null default 0,
  paused_until timestamptz,
  pause_reason text
    check (pause_reason in ('throttled', 'quota', 'budget', 'failures', 'admin')),

  -- Cost limits. Every provider request counts, retries too.
  requests_today int not null default 0,
  requests_date date,
  daily_request_budget int not null default 1500
    check (daily_request_budget between 0 and 100000),
  poll_interval_minutes int not null default 5
    check (poll_interval_minutes between 5 and 1440),
  initial_lookback_hours int not null default 72
    check (initial_lookback_hours between 1 and 168),

  connected_by uuid references auth.users(id) on delete set null,
  connected_at timestamptz,
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists mailbox_connections_address_uq
  on mailbox_connections (tenant_id, provider, lower(address));
create index if not exists mailbox_connections_due_idx
  on mailbox_connections (status, next_sync_at);
create index if not exists mailbox_connections_owner_idx
  on mailbox_connections (tenant_id, owner_user_id);

comment on table mailbox_connections is
  'Email accountability: one connected mailbox, its sync checkpoint, health and cost limits. Tokens are secrets v2 values. RLS on with no tenant-user policy: service role only.';

alter table mailbox_connections enable row level security;
revoke all on mailbox_connections from anon, authenticated;

alter table tenant_settings
  add column if not exists email_accountability_enabled boolean not null default false,
  add column if not exists google_oauth_client_id text,
  add column if not exists google_oauth_client_secret_enc bytea;
