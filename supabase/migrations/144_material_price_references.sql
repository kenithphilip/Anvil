-- 144_material_price_references.sql
-- Forecasting-driven procurement P3 (raw-material price reference).
--
-- Composition material lines (migration 142) carry a unit_cost the
-- operator types per RFQ. That goes stale and varies by who entered it.
-- This table is the central, market-tracking reference for raw-material
-- prices (steel, castings, coatings, …) keyed by a material key that
-- matches either a raw_material_part_no or a grade/spec. When a recipe
-- material line has no explicit unit_cost, the composition endpoint
-- fills it from the latest reference here, so material cost in pricing
-- moves with the market instead of with whoever last typed a number.
--
-- History is kept (one row per as_of); the resolver picks the latest
-- as_of per (material_key, uom).

create table if not exists material_price_references (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  material_key text not null,                -- raw_material_part_no OR grade/spec
  uom text not null default 'kg',
  unit_price numeric(18, 4) not null,
  currency text not null default 'INR',
  source text,                               -- 'manual' | 'index:<name>' | supplier ref
  as_of date not null default current_date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, material_key, uom, as_of)
);

create index if not exists material_price_refs_latest_idx
  on material_price_references (tenant_id, material_key, uom, as_of desc);

alter table material_price_references enable row level security;
drop policy if exists material_price_references_select on material_price_references;
create policy material_price_references_select on material_price_references
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists material_price_references_write on material_price_references;
create policy material_price_references_write on material_price_references
  for all
  using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

comment on table material_price_references is
  'P3: central market price reference for raw materials (by part_no or grade); fills composition material-line unit_cost so pricing tracks the market.';
