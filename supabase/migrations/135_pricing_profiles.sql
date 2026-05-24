-- Pricing profiles: per-tenant, configurable price-composition pipelines.
--
-- Generalises the Obara Excel "price composition" sheets into data so
-- any manufacturing tenant can define its own overhead/margin/discount
-- structure. A profile is an ordered list of typed components evaluated
-- by lib/pricing.ts (composePrice). Global rows (tenant_id null) ship
-- the two canonical profiles (compact + granular); a tenant clones and
-- customises into its own rows.
--
-- Mirrors the incoterms_v2 (migration 106) global+tenant pattern:
-- partial unique indexes, RLS that exposes global rows to everyone,
-- and where-not-exists / on-conflict-do-nothing seeds for idempotence.

create table if not exists pricing_profiles (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid references tenants(id) on delete cascade,  -- null = global default
  code text not null,
  label text not null,
  base_currency text not null default 'INR',
  margin_floor_pct numeric(8, 6) not null default 0.05,     -- realized margin must stay at/above
  fx_stale_days int default 30,
  is_active boolean not null default true,
  sort_order int not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists pricing_profiles_tenant_code
  on pricing_profiles (tenant_id, code) where tenant_id is not null;
create unique index if not exists pricing_profiles_global_code
  on pricing_profiles (code) where tenant_id is null;

alter table pricing_profiles enable row level security;
drop policy if exists pricing_profiles_select on pricing_profiles;
create policy pricing_profiles_select on pricing_profiles
  for select using (tenant_id is null or tenant_id in (select current_tenant_ids()));
drop policy if exists pricing_profiles_write on pricing_profiles;
create policy pricing_profiles_write on pricing_profiles
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

create table if not exists pricing_components (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid references tenants(id) on delete cascade,  -- mirrors the profile; null for global
  profile_id uuid not null references pricing_profiles(id) on delete cascade,
  seq int not null,
  code text not null,
  label text not null,
  kind text not null,            -- fx_convert | per_unit | per_weight | per_volume | pct_of | fixed | margin_markup | discount
  base_ref text,                 -- running | supplier_base | <component code>
  rate numeric(12, 8),           -- fraction, for pct_of / margin_markup / discount
  amount numeric(18, 4),         -- for per_unit / per_weight / per_volume / fixed
  currency text default 'base',  -- base | supplier
  use_loaded_rate boolean default false,  -- fx_convert: use the loaded multiplication factor
  enabled boolean not null default true,
  visibility text default 'internal',     -- internal | customer
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, code)
);

create index if not exists pricing_components_profile_idx
  on pricing_components (profile_id, seq);

alter table pricing_components enable row level security;
drop policy if exists pricing_components_select on pricing_components;
create policy pricing_components_select on pricing_components
  for select using (tenant_id is null or tenant_id in (select current_tenant_ids()));
drop policy if exists pricing_components_write on pricing_components;
create policy pricing_components_write on pricing_components
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

-- ---------------------------------------------------------------------------
-- Seed the two canonical global profiles (mirror lib/pricing.ts).
-- ---------------------------------------------------------------------------

insert into pricing_profiles (tenant_id, code, label, base_currency, margin_floor_pct, fx_stale_days, sort_order) values
  (null, 'granular', 'Granular (itemised import expenses + margin)', 'INR', 0.05, 30, 10),
  (null, 'compact',  'Compact (loaded FX multiplier + margin)',     'INR', 0.15, 30, 20)
on conflict do nothing;

-- Compact profile components.
insert into pricing_components (tenant_id, profile_id, seq, code, label, kind, base_ref, rate, amount, currency, use_loaded_rate, enabled, visibility)
select null, p.id, v.seq, v.code, v.label, v.kind, v.base_ref, v.rate, v.amount, v.currency, v.use_loaded_rate, true, v.visibility
from pricing_profiles p
cross join (values
  (1, 'fx',       'Landed cost (loaded FX)', 'fx_convert',    null::text,      null::numeric, null::numeric, 'base', true,  'internal'),
  (2, 'margin',   'Margin',                  'margin_markup', null,            0.3,           null,          'base', false, 'internal'),
  (3, 'discount', 'Customer discount',       'discount',      null,            0,             null,          'base', false, 'customer')
) as v(seq, code, label, kind, base_ref, rate, amount, currency, use_loaded_rate, visibility)
where p.tenant_id is null and p.code = 'compact'
  and not exists (select 1 from pricing_components c where c.profile_id = p.id and c.code = v.code);

-- Granular profile components.
insert into pricing_components (tenant_id, profile_id, seq, code, label, kind, base_ref, rate, amount, currency, use_loaded_rate, enabled, visibility)
select null, p.id, v.seq, v.code, v.label, v.kind, v.base_ref, v.rate, v.amount, v.currency, v.use_loaded_rate, true, v.visibility
from pricing_profiles p
cross join (values
  (1,  'fx',               'Supplier price in INR',  'fx_convert', null::text,     null::numeric, null::numeric, 'base',     false, 'internal'),
  (2,  'packing',          'Packing',                'per_unit',   null,           null,          0,             'supplier', false, 'internal'),
  (3,  'shipping',         'Shipping',               'per_unit',   null,           null,          0,             'base',     false, 'internal'),
  (4,  'insurance',        'Insurance',              'pct_of',     'running',      0.01125,       null,          'base',     false, 'internal'),
  (5,  'customs_duty',     'Basic customs duty',     'pct_of',     'running',      0.1,           null,          'base',     false, 'internal'),
  (6,  'social_welfare',   'Social welfare tax',     'pct_of',     'customs_duty', 0.1,           null,          'base',     false, 'internal'),
  (7,  'cha',              'CHA charges',            'pct_of',     'running',      0.003,         null,          'base',     false, 'internal'),
  (8,  'local_transport',  'Local transportation',  'pct_of',     'running',      0.01,          null,          'base',     false, 'internal'),
  (9,  'install_warranty', 'Install & warranty',     'pct_of',     'running',      0.01,          null,          'base',     false, 'internal'),
  (10, 'margin',           'Margin',                 'margin_markup', null,        0.1,           null,          'base',     false, 'internal'),
  (11, 'discount',         'Customer discount',      'discount',   null,           0,             null,          'base',     false, 'customer')
) as v(seq, code, label, kind, base_ref, rate, amount, currency, use_loaded_rate, visibility)
where p.tenant_id is null and p.code = 'granular'
  and not exists (select 1 from pricing_components c where c.profile_id = p.id and c.code = v.code);
