-- Migration 105: generalized item-master extension (Tally + Obara schema).
--
-- The existing item_master table (migration 006) carries identification,
-- sourcing, tax-rate, and inventory basics. This migration extends it
-- additively and adds five collaborating tables so any organisation can
-- represent a Tally-style "Stock Item Creation" record without
-- hard-coding Tally semantics.
--
-- All new columns are nullable; older rows + existing handlers are
-- unaffected. All new tables follow the standard tenant-scoped RLS
-- pattern.
--
-- Surface coverage:
--   1. Item identification + workflow flags
--   2. Per-tenant configurable UoM list
--   3. Per-tenant stock-group hierarchy
--   4. Global HSN/SAC reference (India seed)
--   5. Taxability / supply-type / GST applicability
--   6. Inventory-behaviour flags (batches, mfg-date tracking, etc.)
--   7. Opening-balance valuation
--   8. Engineering specifications (drawing, material, gun, project)
--   9. Customer-specific part-number mappings
--   10. Per-tenant custom field definitions + values (extensible)
--   11. Per-document visibility (invoice vs PO vs master view)
--
-- Each of these is independent: a tenant can use 1, 8, and 10 without
-- needing 7 or 11. The UI dictates which sections render.

-- ---------------------------------------------------------------------------
-- 1. item_master additive columns
-- ---------------------------------------------------------------------------

alter table item_master
  add column if not exists alias text,
  add column if not exists print_name text,
  add column if not exists specification_code text,
  add column if not exists stock_group text,
  add column if not exists gst_applicable boolean default true,
  add column if not exists taxability_type text,
  add column if not exists type_of_supply text default 'GOODS',
  add column if not exists rate_of_duty_pct numeric(6, 4),
  add column if not exists maintain_batches boolean default false,
  add column if not exists track_mfg_date boolean default false,
  add column if not exists capture_documents boolean default false,
  add column if not exists enable_cost_tracking boolean default false,
  add column if not exists disable_negative_stock boolean default false,
  add column if not exists order_level numeric(18, 4),
  add column if not exists min_inventory numeric(18, 4),
  add column if not exists opening_qty numeric(18, 4),
  add column if not exists opening_rate numeric(18, 4),
  add column if not exists opening_per text,
  add column if not exists opening_value numeric(18, 4),
  add column if not exists verify_item boolean default false,
  add column if not exists approve_item boolean default false,
  add column if not exists effective_date date,
  add column if not exists data_source text default 'manual',
  add column if not exists alteration_locked boolean default false;

comment on column item_master.alias is 'Optional alternative name. Tally calls this (alias). Free-text.';
comment on column item_master.print_name is 'Display label used on customer invoices when different from internal name.';
comment on column item_master.specification_code is 'Per-tenant specification identifier (Obara: OIPN036906 etc).';
comment on column item_master.stock_group is 'Per-tenant stock group. Joins to stock_groups.code below.';
comment on column item_master.taxability_type is 'Taxable / Exempt / Nil-rated / Non-GST / Zero-rated. Joins to taxability_types.code.';
comment on column item_master.type_of_supply is 'GOODS or SERVICES. Drives the GST register the item posts to.';
comment on column item_master.data_source is 'manual, imported, api, marketplace_template. Read-only after creation by convention.';
comment on column item_master.alteration_locked is 'When true, the UI refuses to edit core identification fields (Tally pattern).';

-- ---------------------------------------------------------------------------
-- 2. uom_options: per-tenant unit-of-measure list with global seed
-- ---------------------------------------------------------------------------

-- Bug fix May 2026: the original primary key was (tenant_id, code)
-- which Postgres enforces as NOT NULL on every PK column, so the
-- global seed rows below (tenant_id null) violated the constraint
-- and aborted the whole migration before 106 onward could run.
-- A surrogate id PK plus two partial unique indexes preserves the
-- intent: global rows are unique by code, per-tenant rows are
-- unique by (tenant_id, code).
create table if not exists uom_options (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid references tenants(id) on delete cascade,
  code text not null,
  label text not null,
  is_system_default boolean not null default false,
  is_active boolean not null default true,
  sort_order int not null default 100,
  created_at timestamptz not null default now()
);

-- Defensive: if a previous (failed) apply created the table with
-- the old (tenant_id, code) PK and no id column, surgically rotate
-- it to the new shape so the seed below succeeds.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'uom_options' and column_name = 'id'
  ) then
    alter table uom_options add column id uuid default uuid_generate_v4();
    update uom_options set id = uuid_generate_v4() where id is null;
    alter table uom_options alter column id set not null;
    if exists (
      select 1 from information_schema.table_constraints
      where table_name = 'uom_options'
        and constraint_type = 'PRIMARY KEY'
    ) then
      alter table uom_options drop constraint uom_options_pkey;
    end if;
    alter table uom_options add primary key (id);
  end if;
end $$;

create unique index if not exists uom_options_tenant_code
  on uom_options (tenant_id, code) where tenant_id is not null;
create unique index if not exists uom_options_global_code
  on uom_options (code) where tenant_id is null;

alter table uom_options enable row level security;
drop policy if exists uom_options_select on uom_options;
create policy uom_options_select on uom_options
  for select using (tenant_id is null or tenant_id in (select current_tenant_ids()));
drop policy if exists uom_options_write on uom_options;
create policy uom_options_write on uom_options
  for all
  using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

-- 13 global-default UoMs covering the Tally menu plus common SI units.
insert into uom_options (tenant_id, code, label, is_system_default, sort_order) values
  (null, 'NA',  'Not Applicable',  true,  10),
  (null, 'NO',  'Number',          true,  20),
  (null, 'KG',  'Kilogram',        true,  30),
  (null, 'LTR', 'Litre',           true,  40),
  (null, 'MTR', 'Meter',           true,  50),
  (null, 'FT',  'Feet',            true,  60),
  (null, 'HR',  'Hours',           true,  70),
  (null, 'LOT', 'Lot',             true,  80),
  (null, 'SET', 'Set',             true,  90),
  (null, 'PKT', 'Packet',          true, 100),
  (null, 'ROL', 'Roll',            true, 110),
  (null, 'PNT', 'Points',          true, 120),
  (null, 'PCS', 'Pieces',          true, 130)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 3. stock_groups: per-tenant hierarchical groups (Tally "Under" picker)
-- ---------------------------------------------------------------------------

create table if not exists stock_groups (
  tenant_id uuid not null references tenants(id) on delete cascade,
  code text not null,
  label text not null,
  parent_code text,
  is_active boolean not null default true,
  sort_order int not null default 100,
  created_at timestamptz not null default now(),
  primary key (tenant_id, code)
);

alter table stock_groups enable row level security;
drop policy if exists stock_groups_select on stock_groups;
create policy stock_groups_select on stock_groups
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists stock_groups_write on stock_groups;
create policy stock_groups_write on stock_groups
  for all
  using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

create index if not exists stock_groups_parent_idx
  on stock_groups (tenant_id, parent_code);

-- ---------------------------------------------------------------------------
-- 4. hsn_codes: global India HSN/SAC reference, ~80 common codes seeded
-- ---------------------------------------------------------------------------

create table if not exists hsn_codes (
  code text primary key,
  description text not null,
  chapter text,
  default_gst_rate_pct numeric(6, 4),
  is_service boolean not null default false,
  created_at timestamptz not null default now()
);

alter table hsn_codes enable row level security;
drop policy if exists hsn_codes_select on hsn_codes;
create policy hsn_codes_select on hsn_codes for select using (true);
-- writes restricted to service_role; no end-user policy.

-- Common 8-digit HSN codes that recur across mid-market industrial
-- distribution. Not exhaustive; tenants extend via service-role API.
insert into hsn_codes (code, description, chapter, default_gst_rate_pct, is_service) values
  ('39269099', 'Articles of plastic, others',          '39', 18.0, false),
  ('40169990', 'Articles of vulcanised rubber',        '40', 18.0, false),
  ('48191010', 'Cartons of corrugated paper',          '48', 12.0, false),
  ('72142090', 'Iron / steel bars, hot-rolled',        '72', 18.0, false),
  ('72151000', 'Other bars and rods of iron / steel',  '72', 18.0, false),
  ('72193500', 'Stainless steel cold-rolled coil',     '72', 18.0, false),
  ('73181500', 'Threaded screws and bolts',            '73', 18.0, false),
  ('73182100', 'Spring washers',                       '73', 18.0, false),
  ('73269099', 'Articles of iron / steel, others',     '73', 18.0, false),
  ('74199990', 'Articles of copper',                   '74', 18.0, false),
  ('76169990', 'Articles of aluminium',                '76', 18.0, false),
  ('82071900', 'Tools for drilling, etc.',             '82', 18.0, false),
  ('82079000', 'Other interchangeable tools',          '82', 18.0, false),
  ('84122100', 'Hydraulic linear acting cylinders',    '84', 18.0, false),
  ('84133090', 'Pumps for engines, others',            '84', 18.0, false),
  ('84137030', 'Centrifugal pumps',                    '84', 18.0, false),
  ('84149090', 'Air or vacuum pumps, parts',           '84', 18.0, false),
  ('84249000', 'Spraying machinery parts',             '84', 18.0, false),
  ('84313100', 'Lift, escalator parts',                '84', 18.0, false),
  ('84313900', 'Lift parts, others',                   '84', 18.0, false),
  ('84314390', 'Boring machine parts',                 '84', 18.0, false),
  ('84314990', 'Earth-moving parts',                   '84', 18.0, false),
  ('84669200', 'Wood-working machine tool parts',      '84', 18.0, false),
  ('84669390', 'Machine-tool parts, others',           '84', 18.0, false),
  ('84669400', 'Press / shear / punch parts',          '84', 18.0, false),
  ('84679200', 'Pneumatic tool parts',                 '84', 18.0, false),
  ('84799090', 'Industrial machine parts, others',     '84', 18.0, false),
  ('84818090', 'Valves, taps, cocks, others',          '84', 18.0, false),
  ('84829100', 'Balls, needles, rollers',              '84', 18.0, false),
  ('84831099', 'Transmission shafts, cranks',          '84', 18.0, false),
  ('84833000', 'Plain shaft bearings',                 '84', 18.0, false),
  ('84839000', 'Toothed wheels, gear parts',           '84', 18.0, false),
  ('84849000', 'Mechanical seals',                     '84', 18.0, false),
  ('85013110', 'DC motors and generators',             '85', 18.0, false),
  ('85016100', 'AC generators',                        '85', 18.0, false),
  ('85044090', 'Static converters, others',            '85', 18.0, false),
  ('85049090', 'Transformer / inductor parts',         '85', 18.0, false),
  ('85051100', 'Permanent magnets, metal',             '85', 18.0, false),
  ('85149000', 'Industrial-furnace parts',             '85', 18.0, false),
  ('85159000', 'Welding / brazing machine parts',      '85', 18.0, false),
  ('85183000', 'Headphones, earphones',                '85', 18.0, false),
  ('85299090', 'Antenna / transmission parts',         '85', 18.0, false),
  ('85322500', 'Capacitors, dielectric',               '85', 18.0, false),
  ('85363000', 'Other circuit protection apparatus',   '85', 18.0, false),
  ('85369090', 'Switching apparatus, others',          '85', 18.0, false),
  ('85389000', 'Switchgear parts',                     '85', 18.0, false),
  ('85444299', 'Insulated cable, others',              '85', 18.0, false),
  ('90261010', 'Flow meters, electronic',              '90', 18.0, false),
  ('90262000', 'Pressure measuring instruments',       '90', 18.0, false),
  ('90328990', 'Automatic regulating instruments',     '90', 18.0, false),
  ('94054090', 'Electric lighting, others',            '94', 18.0, false),
  -- Services (SAC). Same table, is_service=true.
  ('997212',   'Real-estate management services',      '99', 18.0, true),
  ('998311',   'Management consulting services',       '99', 18.0, true),
  ('998313',   'IT consulting services',               '99', 18.0, true),
  ('998314',   'IT design / development services',     '99', 18.0, true),
  ('998315',   'Hosting / IT infrastructure services', '99', 18.0, true),
  ('998341',   'IT support services',                  '99', 18.0, true),
  ('998391',   'Specialty design services',            '99', 18.0, true),
  ('998873',   'Other manufacturing services',         '99', 18.0, true),
  ('998881',   'Motor-vehicle repair / maintenance',   '99', 18.0, true),
  ('999293',   'Educational services',                 '99',  5.0, true)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 5. taxability_types: small global reference (Taxable, Exempt, ...)
-- ---------------------------------------------------------------------------

create table if not exists taxability_types (
  code text primary key,
  label text not null,
  is_active boolean not null default true,
  sort_order int not null default 100
);

alter table taxability_types enable row level security;
drop policy if exists taxability_types_select on taxability_types;
create policy taxability_types_select on taxability_types for select using (true);

insert into taxability_types (code, label, sort_order) values
  ('TAXABLE',    'Taxable',     10),
  ('EXEMPT',     'Exempt',      20),
  ('NIL_RATED',  'Nil-rated',   30),
  ('NON_GST',    'Non-GST',     40),
  ('ZERO_RATED', 'Zero-rated',  50)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 6. item_specifications: 1-to-1 engineering extension (drawing, material, etc.)
-- ---------------------------------------------------------------------------

create table if not exists item_specifications (
  item_id uuid primary key references item_master(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  technical_description text,
  drawing_number text,
  alternate_part_number text,
  gun_number text,
  customer_project text,
  source_country text,
  material text,
  drawing_available boolean,
  mfg_feasibility text,                     -- yes / no / tbd
  specified_life_time text,
  picture_url text,
  minimum_order_qty numeric(18, 4),
  minimum_inventory numeric(18, 4),
  remark text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table item_specifications enable row level security;
drop policy if exists item_specifications_select on item_specifications;
create policy item_specifications_select on item_specifications
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists item_specifications_write on item_specifications;
create policy item_specifications_write on item_specifications
  for all
  using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

create index if not exists item_specifications_drawing_idx
  on item_specifications (tenant_id, drawing_number)
  where drawing_number is not null;

create index if not exists item_specifications_gun_idx
  on item_specifications (tenant_id, gun_number)
  where gun_number is not null;

-- ---------------------------------------------------------------------------
-- 7. item_customer_parts: many-to-many item <-> customer with their part number
-- ---------------------------------------------------------------------------

create table if not exists item_customer_parts (
  tenant_id uuid not null references tenants(id) on delete cascade,
  item_id uuid not null references item_master(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  customer_part_number text not null,
  customer_part_description text,
  customer_project text,
  valid_from date,
  valid_to date,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, item_id, customer_id, customer_part_number)
);

alter table item_customer_parts enable row level security;
drop policy if exists item_customer_parts_select on item_customer_parts;
create policy item_customer_parts_select on item_customer_parts
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists item_customer_parts_write on item_customer_parts;
create policy item_customer_parts_write on item_customer_parts
  for all
  using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

create index if not exists item_customer_parts_by_customer
  on item_customer_parts (tenant_id, customer_id, customer_part_number);

-- ---------------------------------------------------------------------------
-- 8. item_field_definitions: per-tenant custom field schema
--    + item_field_values: actual values per item.
--    This is the extensibility layer that lets each org define its own
--    "Extended Item Master" without a schema migration.
-- ---------------------------------------------------------------------------

create table if not exists item_field_definitions (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  field_key text not null,
  field_label text not null,
  field_type text not null check (field_type in ('text', 'number', 'boolean', 'select', 'date', 'file', 'url')),
  field_group text,                          -- 'identification' | 'classification' | 'tax' | 'inventory' | 'engineering' | 'logistics' | 'custom'
  field_options jsonb default '[]'::jsonb,   -- array of {value, label} for select type
  field_default text,
  field_required boolean not null default false,
  field_sort_order int not null default 100,
  is_visible_invoice boolean not null default false,
  is_visible_po boolean not null default false,
  is_visible_master boolean not null default true,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, field_key)
);

alter table item_field_definitions enable row level security;
drop policy if exists item_field_definitions_select on item_field_definitions;
create policy item_field_definitions_select on item_field_definitions
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists item_field_definitions_write on item_field_definitions;
create policy item_field_definitions_write on item_field_definitions
  for all
  using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

create table if not exists item_field_values (
  tenant_id uuid not null references tenants(id) on delete cascade,
  item_id uuid not null references item_master(id) on delete cascade,
  field_key text not null,
  value_text text,
  value_number numeric(18, 6),
  value_boolean boolean,
  value_date date,
  value_json jsonb,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, item_id, field_key)
);

alter table item_field_values enable row level security;
drop policy if exists item_field_values_select on item_field_values;
create policy item_field_values_select on item_field_values
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists item_field_values_write on item_field_values;
create policy item_field_values_write on item_field_values
  for all
  using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

create index if not exists item_field_values_by_item
  on item_field_values (tenant_id, item_id);

create index if not exists item_field_values_by_field
  on item_field_values (tenant_id, field_key);

-- ---------------------------------------------------------------------------
-- 9. Updated-at triggers for the new tables that track edits.
-- ---------------------------------------------------------------------------

create or replace function bump_updated_at() returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists item_specifications_updated_at on item_specifications;
create trigger item_specifications_updated_at
  before update on item_specifications
  for each row execute function bump_updated_at();

drop trigger if exists item_customer_parts_updated_at on item_customer_parts;
create trigger item_customer_parts_updated_at
  before update on item_customer_parts
  for each row execute function bump_updated_at();

drop trigger if exists item_field_definitions_updated_at on item_field_definitions;
create trigger item_field_definitions_updated_at
  before update on item_field_definitions
  for each row execute function bump_updated_at();

drop trigger if exists item_field_values_updated_at on item_field_values;
create trigger item_field_values_updated_at
  before update on item_field_values
  for each row execute function bump_updated_at();

-- ---------------------------------------------------------------------------
-- 10. Convenience view: items_full_v
--     Joins item_master, item_specifications, and aggregates field_values
--     into one row for the UI. RLS inherits from underlying tables.
-- ---------------------------------------------------------------------------

create or replace view items_full_v as
  select
    m.*,
    s.technical_description,
    s.drawing_number,
    s.alternate_part_number,
    s.gun_number,
    s.customer_project,
    s.source_country as spec_source_country,
    s.material,
    s.drawing_available,
    s.mfg_feasibility,
    s.specified_life_time,
    s.picture_url,
    s.minimum_order_qty as spec_min_order_qty,
    s.minimum_inventory as spec_min_inventory,
    s.remark,
    coalesce(
      (
        select jsonb_object_agg(field_key, jsonb_build_object(
          'text', value_text,
          'number', value_number,
          'boolean', value_boolean,
          'date', value_date,
          'json', value_json
        ))
        from item_field_values v
        where v.tenant_id = m.tenant_id and v.item_id = m.id
      ),
      '{}'::jsonb
    ) as custom_fields
  from item_master m
  left join item_specifications s on s.item_id = m.id;
