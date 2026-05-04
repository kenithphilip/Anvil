-- 022_customer_portal.sql
-- Read-only customer-facing portal. A buyer at <tenant_slug>'s
-- customer accesses /portal/<token> to see their quotes, orders,
-- invoices and pay outstanding invoices. No login required; tokens
-- are scoped per (tenant, customer_id) and revocable.
-- Idempotent.

create table if not exists portal_tokens (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid references customers(id) on delete cascade,
  token text not null,                           -- random 32-byte hex
  email text,                                    -- email this token was sent to (audit)
  scopes text[] not null default array['quotes','orders','invoices','pay'],
  revoked_at timestamptz,
  expires_at timestamptz,
  last_used_at timestamptz,
  use_count int not null default 0,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, token)
);

create index if not exists portal_tokens_token_idx on portal_tokens (token);
create index if not exists portal_tokens_customer_idx on portal_tokens (tenant_id, customer_id);

alter table portal_tokens enable row level security;
drop policy if exists "portal_tokens_admin" on portal_tokens;
create policy "portal_tokens_admin" on portal_tokens
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
-- Note: portal lookups go through the service role; the RLS above
-- only constrains in-app admin reads.

create table if not exists portal_access_log (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  token_id uuid references portal_tokens(id) on delete set null,
  ip text,
  user_agent text,
  path text,
  status int,
  created_at timestamptz not null default now()
);

create index if not exists portal_access_log_idx on portal_access_log (tenant_id, created_at desc);

alter table portal_access_log enable row level security;
drop policy if exists "portal_access_log_select" on portal_access_log;
create policy "portal_access_log_select" on portal_access_log
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
