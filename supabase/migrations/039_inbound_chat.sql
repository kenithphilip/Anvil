-- 039_inbound_chat.sql
-- Phase 5.2: multi-channel inbound. WhatsApp / Slack / Teams /
-- WeChat. Email already lives in inbound_emails (028); the chat
-- channels share enough shape that we put them in a sibling table
-- with a `channel` discriminator. Email could fold in later, but
-- migrating that now would risk regressing the existing inbound
-- pipeline.
-- Idempotent.

create table if not exists inbound_messages (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  channel text not null check (channel in ('whatsapp', 'slack', 'teams', 'wechat')),
  -- Provider-side identifier (Twilio MessageSid, Slack ts, Teams
  -- activity id). Used for idempotency on webhook replays.
  external_id text not null,
  -- Conversation thread; the adapters compute this so reply
  -- targeting works.
  thread_external_id text,
  -- Sender info. We don't try to normalise across channels;
  -- store the raw handle / phone / Slack user ID.
  sender_handle text,
  sender_name text,
  -- Body, both raw and a stripped plain-text view.
  text_body text,
  raw_payload jsonb default '{}'::jsonb,
  -- Inbound media: image, audio, document. Stored as URLs that we
  -- separately download and pin to Supabase storage. The download
  -- path is provider-specific.
  attachments jsonb not null default '[]'::jsonb,
  -- Lifecycle: arrived -> linked -> intake-extracted -> resolved.
  status text not null default 'arrived' check (status in
    ('arrived', 'linked', 'intake-extracted', 'resolved', 'failed')),
  linked_order_id uuid references orders(id) on delete set null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text,
  unique (tenant_id, channel, external_id)
);

create index if not exists inbound_messages_tenant_idx on inbound_messages (tenant_id, received_at desc);
create index if not exists inbound_messages_status_idx on inbound_messages (tenant_id, status);
create index if not exists inbound_messages_thread_idx on inbound_messages (tenant_id, channel, thread_external_id);

alter table inbound_messages enable row level security;
drop policy if exists "inbound_messages_owner" on inbound_messages;
create policy "inbound_messages_owner" on inbound_messages
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- Per-tenant adapter config. Encrypted creds. One row per
-- (tenant_id, channel) so a tenant can have, say, two WhatsApp
-- numbers via different Twilio subaccounts; we'd extend the unique
-- key in that case.
create table if not exists inbound_chat_configs (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  channel text not null check (channel in ('whatsapp', 'slack', 'teams', 'wechat')),
  display_name text,
  -- Generic encrypted creds bag. Concrete fields per channel:
  --   whatsapp (Twilio): account_sid, auth_token, from_number
  --   slack: bot_token, signing_secret, app_id
  --   teams: app_id, client_secret, tenant_id (Azure AD)
  --   wechat: app_id, app_secret
  creds_enc text,
  creds_plain jsonb default '{}'::jsonb,        -- only used when secrets not configured
  creds_iv text,
  active boolean not null default true,
  last_seen_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, channel)
);

create index if not exists inbound_chat_configs_tenant_idx on inbound_chat_configs (tenant_id, active);

alter table inbound_chat_configs enable row level security;
drop policy if exists "inbound_chat_configs_owner" on inbound_chat_configs;
create policy "inbound_chat_configs_owner" on inbound_chat_configs
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create or replace function inbound_chat_configs_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists inbound_chat_configs_updated_at on inbound_chat_configs;
create trigger inbound_chat_configs_updated_at before update on inbound_chat_configs
  for each row execute function inbound_chat_configs_touch_updated_at();
