-- 028_inbound_email.sql
-- Inbound email connector. Two adapters share this schema:
--   - Postmark Inbound webhook (webhook URL pattern: each tenant
--     sets up an inbound address like <slug>@inbound.anvil.app and
--     points it at /api/inbound/email/webhook).
--   - Microsoft Graph subscription (per-mailbox subscription that
--     callbacks at the same endpoint with provider=graph).
--
-- inbound_emails captures the raw and parsed message; threads is a
-- canonical aggregation by In-Reply-To chain. The dedup hash + the
-- customer-tier column on customers (added below) feed Phase 3.5
-- priority routing.
-- Idempotent.

create table if not exists inbound_email_threads (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  thread_key text not null,                  -- normalised In-Reply-To chain root or Message-ID
  subject text,
  first_received_at timestamptz not null default now(),
  last_received_at timestamptz not null default now(),
  message_count int not null default 0,
  status text not null default 'open' check (status in ('open','linked','closed','archived')),
  linked_order_id uuid references orders(id) on delete set null,
  unique (tenant_id, thread_key)
);

create index if not exists inbound_email_threads_tenant_idx
  on inbound_email_threads (tenant_id, last_received_at desc);

alter table inbound_email_threads enable row level security;
drop policy if exists "inbound_email_threads_all" on inbound_email_threads;
create policy "inbound_email_threads_all" on inbound_email_threads
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists inbound_emails (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  thread_id uuid references inbound_email_threads(id) on delete set null,
  provider text not null check (provider in ('postmark','graph','manual')),
  message_id text,
  in_reply_to text,
  references_chain text[],
  from_address text,
  from_name text,
  to_addresses text[],
  cc_addresses text[],
  subject text,
  body_text text,
  body_html text,
  raw_mime text,
  attachments jsonb default '[]'::jsonb,        -- [{filename, content_type, size_bytes, storage_path}]
  dup_hash text,                                 -- sha256(from_domain || subject || body_first_200)
  received_at timestamptz not null default now(),
  parsed_at timestamptz,
  linked_order_id uuid references orders(id) on delete set null,
  priority_score numeric(8,2) default 0,
  customer_id uuid references customers(id) on delete set null,
  customer_tier text,                            -- denormalised from customers at parse time
  status text not null default 'received' check (status in
    ('received','parsed','linked','duplicate','failed','archived')),
  error text,
  created_at timestamptz not null default now()
);

-- Idempotency: same (tenant, message_id) lands once.
create unique index if not exists inbound_emails_message_id_idx
  on inbound_emails (tenant_id, message_id) where message_id is not null;

create index if not exists inbound_emails_tenant_idx
  on inbound_emails (tenant_id, received_at desc);
create index if not exists inbound_emails_status_idx
  on inbound_emails (tenant_id, status, received_at desc);
create index if not exists inbound_emails_dup_idx
  on inbound_emails (tenant_id, dup_hash, received_at desc);
create index if not exists inbound_emails_priority_idx
  on inbound_emails (tenant_id, priority_score desc, received_at desc)
  where status in ('received','parsed','linked');

alter table inbound_emails enable row level security;
drop policy if exists "inbound_emails_all" on inbound_emails;
create policy "inbound_emails_all" on inbound_emails
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- Customer-tier column for Phase 3.5 priority routing.
alter table customers
  add column if not exists tier text default 'standard'
  check (tier in ('strategic','preferred','standard','watchlist'));

create index if not exists customers_tier_idx on customers (tenant_id, tier);

-- Per-tenant inbound config. Stored on tenant_settings since the
-- adapter creds are credentials.
alter table tenant_settings
  add column if not exists postmark_inbound_secret text,
  add column if not exists postmark_inbound_address text,
  add column if not exists graph_tenant_id text,
  add column if not exists graph_client_id text,
  add column if not exists graph_client_id_enc bytea,
  add column if not exists graph_client_secret_enc bytea,
  add column if not exists graph_creds_iv bytea,
  add column if not exists graph_subscription_id text,
  add column if not exists graph_mailbox text;
