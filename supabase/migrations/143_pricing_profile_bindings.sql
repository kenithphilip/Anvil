-- 143_pricing_profile_bindings.sql
-- Forecasting-driven procurement P3 (account/supplier-aware pricing).
--
-- pricing_profiles (migration 135) are global or per-tenant only — the
-- same profile + margin floor applied to every customer. A sales-ops
-- head wants strategic accounts on one profile/floor and long-tail
-- accounts on another, and to hold a tighter floor for a given supplier.
-- This table binds a pricing profile (and an optional margin-floor
-- override) to a specific customer or supplier; the composition engine
-- resolves it automatically when no profile is explicitly chosen, and
-- always applies the account/supplier-specific floor.
--
-- Resolution precedence (see _lib/pricing-bindings.js): customer binding
-- wins over supplier binding; neither falls back to the tenant/global
-- default profile as before.

create table if not exists pricing_profile_bindings (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  scope_type text not null check (scope_type in ('customer', 'supplier')),
  scope_id uuid not null,                    -- customers.id or suppliers.id
  profile_code text,                         -- pricing_profiles.code to default to
  margin_floor_pct numeric(8, 6),            -- optional account/supplier floor override (fraction)
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, scope_type, scope_id)
);

create index if not exists pricing_profile_bindings_idx
  on pricing_profile_bindings (tenant_id, scope_type, scope_id)
  where is_active;

alter table pricing_profile_bindings enable row level security;
drop policy if exists pricing_profile_bindings_select on pricing_profile_bindings;
create policy pricing_profile_bindings_select on pricing_profile_bindings
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists pricing_profile_bindings_write on pricing_profile_bindings;
create policy pricing_profile_bindings_write on pricing_profile_bindings
  for all
  using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

comment on table pricing_profile_bindings is
  'P3: binds a pricing profile + optional margin-floor override to a customer or supplier; resolved by the composition engine (customer wins over supplier).';
