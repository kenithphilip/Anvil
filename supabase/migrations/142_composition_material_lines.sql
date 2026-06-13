-- 142_composition_material_lines.sql
-- Forecasting-driven procurement P2, recipe-authoring layer.
--
-- P2 (migration 141 + the cron explosion) cascades finished-good demand
-- down bill_of_materials into raw materials. But bill_of_materials had
-- to be hand-maintained. This table is where the raw-material recipe is
-- AUTHORED, as a by-product of pricing: when the quote creator opens the
-- engineering drawing during RFQ to price a part, they record the
-- material breakup (form factor, grade, coating, dimensions → quantity)
-- per price-composition line. The endpoint then SYNCS these into
-- bill_of_materials, so the BOM the planner explodes becomes
-- self-maintaining from RFQ work instead of a separate manual chore.
--
-- Grain: per (quote, composition_line_index, seq). finished_part_no is
-- the part that composition line prices (the recipe parent);
-- raw_material_part_no is what it consumes (the recipe child).
-- consumption_per_unit is the BOM quantity: material consumed to make
-- ONE finished unit (gross_qty / yield, or entered directly).

create table if not exists composition_material_lines (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  quote_id uuid references quotes(id) on delete cascade,
  composition_line_index int not null,        -- which price_composition_lines line
  seq int not null default 0,                  -- material line within that line
  finished_part_no text,                       -- recipe parent (part being made)
  raw_material_part_no text not null,          -- recipe child (raw material SKU)
  material text,                               -- grade / spec, e.g. 'EN8'
  form text,                                   -- block | rod | sheet | tube | plate | ...
  coating text,
  dimensions jsonb not null default '{}'::jsonb, -- { diameter, length, width, thickness, circumference, unit }
  density numeric(12, 4),                      -- for weight-from-volume derivation
  gross_qty numeric(18, 6),                    -- gross material per finished unit (pre-yield)
  yield_pct numeric(6, 4),                     -- usable fraction 0..1 (consumption = gross / yield)
  consumption_per_unit numeric(18, 6),         -- BOM qty: material per ONE finished unit
  uom text not null default 'kg',
  supplier_id uuid references suppliers(id) on delete set null,
  unit_cost numeric(18, 4),
  currency text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, quote_id, composition_line_index, seq)
);

create index if not exists comp_material_lines_quote_idx
  on composition_material_lines (tenant_id, quote_id, composition_line_index, seq);
create index if not exists comp_material_lines_finished_idx
  on composition_material_lines (tenant_id, finished_part_no)
  where finished_part_no is not null;
create index if not exists comp_material_lines_raw_idx
  on composition_material_lines (tenant_id, raw_material_part_no);

alter table composition_material_lines enable row level security;
drop policy if exists composition_material_lines_select on composition_material_lines;
create policy composition_material_lines_select on composition_material_lines
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists composition_material_lines_write on composition_material_lines;
create policy composition_material_lines_write on composition_material_lines
  for all
  using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

comment on table composition_material_lines is
  'P2 recipe-authoring: drawing-derived raw-material breakup per price-composition line; synced into bill_of_materials so the planner''s BOM explosion is self-maintaining from RFQ pricing work.';
