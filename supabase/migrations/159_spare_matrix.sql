-- ============================================================
-- 159_spare_matrix.sql — per-customer/project Spare Matrix
--
-- Replaces the localStorage-only Spares worksheet with a proper
-- server entity that mirrors the customer reference model
-- ("Servo Gun Spare Matrix" workbook):
--   spare_matrix          — header (tenant + customer + project)
--   spare_matrix_columns  — ordered, lockable spare-CATEGORY columns
--   spare_matrix_rows     — one row per gun/station: fixed identity
--                           columns + spare_values JSONB (cells =
--                           the part number that gun uses per category)
--   recommended_spares    — the "Recomended Qty" sheet, INSIDE the
--                           matrix: one row per (category + part_no),
--                           installed_qty = COUNT across gun rows.
--
-- Does NOT touch spare_recommendations / obsolete_parts (kept for the
-- separate order-history criticality-analytics subsystem).
--
-- created_by/updated_by are plain uuid (ctx.user.id), NO auth.users FK
-- (a hard FK breaks service-role inserts).
-- Idempotent (IF NOT EXISTS); safe to re-run.
-- ============================================================

create table if not exists spare_matrix (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  project_name text,
  name text,
  drawing_base_url text,
  notes text,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists spare_matrix_tenant_idx
  on spare_matrix (tenant_id, customer_id, project_name);

create table if not exists spare_matrix_columns (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  matrix_id uuid not null references spare_matrix(id) on delete cascade,
  col_name text not null,                 -- spare category, e.g. "SHANK (MOVING)"
  category text,                          -- Consumable | Spare | Sealing | ... (preset)
  position integer not null default 0,    -- ordering hint (dups tolerated; no unique)
  locked boolean not null default false,  -- locked cols are skipped by auto-fill
  created_at timestamptz not null default now()
);
create index if not exists spare_matrix_columns_matrix_idx
  on spare_matrix_columns (matrix_id, position);

create table if not exists spare_matrix_rows (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  matrix_id uuid not null references spare_matrix(id) on delete cascade,
  position integer not null default 0,
  -- Fixed station-identity columns (reference model).
  sr_no text,
  line text,
  station_no text,
  robot_no text,
  gun_no text,
  gun_type text,
  l_qty numeric,
  r_qty numeric,
  timer text,
  atd text,
  qty numeric,
  bom_asset_id uuid references bom_assets(id) on delete set null,
  -- Cells: { "<col_name>": "PART1\nPART2" } — part numbers this gun uses per category.
  spare_values jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists spare_matrix_rows_matrix_idx
  on spare_matrix_rows (matrix_id, position);
create index if not exists spare_matrix_rows_gun_idx
  on spare_matrix_rows (tenant_id, gun_no);

create table if not exists recommended_spares (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  matrix_id uuid not null references spare_matrix(id) on delete cascade,
  sr_no integer,
  description text,                 -- spare category
  part_no text not null,
  gun_number text,                  -- representative gun
  installed_qty integer not null default 0,   -- COUNT of this part across all gun rows
  recommended_qty numeric,          -- human/policy-set order qty
  priority text,                    -- High | Medium | Low (or numeric label)
  item_type text,                   -- Consumable | Spare | Wear Part
  customer_part_no text,
  lead_time_days text,              -- free text per reference ("6-7 weeks")
  remarks text,
  quote_ref text,
  quote_id uuid references quotes(id) on delete set null,
  po_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Human edits are preserved across recompute by keying on this composite.
  unique (tenant_id, matrix_id, part_no, description)
);
create index if not exists recommended_spares_matrix_idx
  on recommended_spares (matrix_id, sr_no);

-- Let a fed quote point back at its originating matrix (mirrors quotes.opportunity_id).
alter table quotes add column if not exists source_matrix_id uuid
  references spare_matrix(id) on delete set null;

-- ── RLS (standard tenant-scoped policies; pattern from 147) ─────────
alter table spare_matrix enable row level security;
drop policy if exists spare_matrix_select on spare_matrix;
create policy spare_matrix_select on spare_matrix
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists spare_matrix_write on spare_matrix;
create policy spare_matrix_write on spare_matrix
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

alter table spare_matrix_columns enable row level security;
drop policy if exists spare_matrix_columns_select on spare_matrix_columns;
create policy spare_matrix_columns_select on spare_matrix_columns
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists spare_matrix_columns_write on spare_matrix_columns;
create policy spare_matrix_columns_write on spare_matrix_columns
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

alter table spare_matrix_rows enable row level security;
drop policy if exists spare_matrix_rows_select on spare_matrix_rows;
create policy spare_matrix_rows_select on spare_matrix_rows
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists spare_matrix_rows_write on spare_matrix_rows;
create policy spare_matrix_rows_write on spare_matrix_rows
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

alter table recommended_spares enable row level security;
drop policy if exists recommended_spares_select on recommended_spares;
create policy recommended_spares_select on recommended_spares
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists recommended_spares_write on recommended_spares;
create policy recommended_spares_write on recommended_spares
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

comment on table spare_matrix is
  'Per-customer/project spare matrix header (rows=guns, cols=spare categories). Replaces the legacy localStorage worksheet.';
comment on table spare_matrix_rows is
  'One row per gun/station: fixed identity cols + spare_values JSONB (cell = part number that gun uses per spare category, auto-filled from its BOM).';
comment on table recommended_spares is
  'The "Recomended Qty" sheet inside a spare_matrix: one row per (category+part_no); installed_qty = COUNT across gun rows; feeds the quote.';
