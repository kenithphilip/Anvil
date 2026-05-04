-- 023_esignature.sql
-- E-signature workflow. Primary provider: DocuSign (JWT auth +
-- envelope API). Schema is provider-neutral so we can plug in
-- Adobe Sign / SignNow later by switching the dispatcher.
-- Idempotent.

alter table tenant_settings
  add column if not exists docusign_account_id text,
  add column if not exists docusign_base_path text default 'https://demo.docusign.net/restapi',
  add column if not exists docusign_integration_key text,
  add column if not exists docusign_user_id text,
  add column if not exists docusign_rsa_private_key_enc bytea,
  add column if not exists docusign_creds_iv bytea,
  add column if not exists docusign_webhook_secret text,
  add column if not exists docusign_connected_at timestamptz;

create table if not exists esignature_envelopes (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id uuid references orders(id) on delete set null,
  provider text not null default 'docusign' check (provider in ('docusign','adobe_sign','signnow')),
  external_id text,                                        -- envelope id
  status text not null default 'created' check (status in
    ('created','sent','delivered','signed','completed','declined','voided','failed')),
  subject text,
  message text,
  signers jsonb not null default '[]'::jsonb,              -- [{name, email, status}]
  sent_at timestamptz,
  completed_at timestamptz,
  pdf_storage_path text,                                   -- signed PDF path in Supabase storage
  raw jsonb default '{}'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists esig_envelopes_tenant_idx on esignature_envelopes (tenant_id, created_at desc);
create index if not exists esig_envelopes_order_idx on esignature_envelopes (tenant_id, order_id);
create unique index if not exists esig_envelopes_provider_external_idx
  on esignature_envelopes (tenant_id, provider, external_id) where external_id is not null;

alter table esignature_envelopes enable row level security;
drop policy if exists "esig_envelopes_all" on esignature_envelopes;
create policy "esig_envelopes_all" on esignature_envelopes
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create or replace function esig_envelopes_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists esig_envelopes_updated_at on esignature_envelopes;
create trigger esig_envelopes_updated_at before update on esignature_envelopes
  for each row execute function esig_envelopes_touch_updated_at();

create table if not exists esignature_events (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  envelope_id uuid references esignature_envelopes(id) on delete cascade,
  event text not null,                                     -- envelope-sent, recipient-signed, etc.
  raw jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now()
);

create index if not exists esig_events_envelope_idx on esignature_events (envelope_id, received_at desc);

alter table esignature_events enable row level security;
drop policy if exists "esig_events_select" on esignature_events;
create policy "esig_events_select" on esignature_events
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
