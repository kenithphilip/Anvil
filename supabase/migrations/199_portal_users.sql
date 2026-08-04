-- 199_portal_users.sql — customer portal user identity (v1).
--
-- Moves the customer portal from a shared token-in-URL link toward per-user
-- authenticated access. A portal_users row is a CUSTOMER-side identity, strictly
-- segregated from internal staff (tenant_members): it is scoped to ONE customer
-- and never carries an internal role. Authentication reuses Supabase Auth (the
-- same stack internal staff use) — resolveCustomerContext validates a Bearer JWT
-- and looks the user up here.
--
-- PROVISIONED for future SSO + MFA (NOT enforced in v1):
--   * auth_user_id is nullable so a future SSO just-in-time provision can create
--     the row before the auth user exists; a password user has it set at invite.
--   * auth_provider distinguishes password vs sso.
--   * require_mfa carries the per-user MFA policy for a future MFA gate.
-- Idempotent. Standard tenant-scoped RLS (pattern from 159).

create table if not exists portal_users (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  auth_user_id uuid,                       -- Supabase auth.users id (nullable: future SSO JIT)
  email text not null,                     -- stored lowercased
  display_name text,
  role text not null default 'portal_member' check (role in ('portal_admin', 'portal_member')),
  status text not null default 'invited' check (status in ('invited', 'active', 'suspended')),
  -- Provisions for future auth hardening (not enforced in v1):
  auth_provider text not null default 'password' check (auth_provider in ('password', 'sso')),
  require_mfa boolean not null default false,
  invited_by uuid,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, customer_id, email)
);

create index if not exists portal_users_auth_idx on portal_users (auth_user_id);
create index if not exists portal_users_customer_idx on portal_users (tenant_id, customer_id);

-- Per-user portal audit: link an access-log row to the portal user (nullable so
-- legacy shared-token hits still log with a null user).
alter table portal_access_log add column if not exists portal_user_id uuid references portal_users(id) on delete set null;

alter table portal_users enable row level security;
drop policy if exists portal_users_select on portal_users;
create policy portal_users_select on portal_users
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists portal_users_write on portal_users;
create policy portal_users_write on portal_users
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

create or replace function portal_users_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists portal_users_updated_at on portal_users;
create trigger portal_users_updated_at before update on portal_users
  for each row execute function portal_users_touch_updated_at();

comment on table portal_users is
  'Customer portal user identity (v1). Per-user, segregated from tenant_members, scoped to one customer. Auth via Supabase (Bearer JWT). auth_provider + require_mfa provision future SSO/MFA.';
