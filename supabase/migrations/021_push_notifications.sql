-- 021_push_notifications.sql
-- Web Push (W3C) + FCM device tokens for mobile push notifications.
-- Anvil's PWA mobile shell registers a service worker subscription;
-- the push_subscriptions table stores it. Sending happens via the
-- web-push protocol against the endpoint URL.
-- Idempotent.

create table if not exists push_subscriptions (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null default 'web' check (channel in ('web','fcm','apns')),
  endpoint text,                                -- web push: PushSubscription.endpoint
  p256dh text,                                  -- web push: keys.p256dh
  auth text,                                    -- web push: keys.auth
  device_token text,                            -- fcm/apns: device token
  user_agent text,
  is_active boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Postgres rejects expression-valued constraints (`unique (..., coalesce(...))`)
-- inside CREATE TABLE; the same uniqueness lives as a unique index instead.
-- Identity column is endpoint when web-push, device_token when fcm/apns.
create unique index if not exists push_subs_uniq_dedup
  on push_subscriptions (tenant_id, user_id, coalesce(endpoint, device_token));

create index if not exists push_subs_user_idx on push_subscriptions (tenant_id, user_id, is_active);

alter table push_subscriptions enable row level security;
drop policy if exists "push_subs_self" on push_subscriptions;
create policy "push_subs_self" on push_subscriptions
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists push_notifications (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  subscription_id uuid references push_subscriptions(id) on delete set null,
  title text not null,
  body text,
  url text,
  data jsonb default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued','sent','failed','expired')),
  attempt_count int not null default 0,
  sent_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists push_notifs_picker_idx on push_notifications (status, created_at)
  where status = 'queued';
create index if not exists push_notifs_tenant_idx on push_notifications (tenant_id, created_at desc);

alter table push_notifications enable row level security;
drop policy if exists "push_notifs_select" on push_notifications;
create policy "push_notifs_select" on push_notifications
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
