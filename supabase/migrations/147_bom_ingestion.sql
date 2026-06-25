-- 147_bom_ingestion.sql
-- Generalized BOM ingestion (Phase 1). See docs/BOM_INGESTION_DESIGN.md.
--
-- Captures an imported finished-product BOM as a first-class document:
--   bom_assets        - the product / equipment / assembly (neutral)
--   bom_lines         - the as-imported parts list (hierarchy + attrs)
--   bom_asset_projects- M:N link of an asset to projects (customer flows
--                       from the project or the asset)
--   bom_import_events - who uploaded / modified, when, and what changed
--
-- Strictly additive: existing bill_of_materials, item_master, /api/bom,
-- and migration history are unchanged. The import endpoint derives
-- bill_of_materials edges + item_master rows from these tables so the
-- existing explosion (v_bom_walk_recursive) and planning light up
-- without any downstream change.

-- ── bom_assets ──────────────────────────────────────────────────────
create table if not exists bom_assets (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  asset_code text not null,                  -- product / drawing / model number
  name text,
  asset_type text,                           -- neutral free label: product|equipment|assembly|machine|...
  customer_id uuid references customers(id) on delete set null,
  source_format text,                        -- registry profile that ingested it
  revision text not null default '',         -- BOM / drawing revision ('' = base)
  drawing_no text,
  source_country text,
  metadata jsonb not null default '{}'::jsonb,
  uploaded_by uuid references auth.users(id) on delete set null,
  last_uploaded_by uuid references auth.users(id) on delete set null,
  last_imported_at timestamptz,
  -- Governance (approver workflow is future scope; v1 only sets 'imported').
  approval_status text not null default 'imported'
    check (approval_status in ('imported','pending_approval','approved','rejected')),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, asset_code, revision)
);
create index if not exists bom_assets_tenant_idx on bom_assets (tenant_id, asset_code);
create index if not exists bom_assets_customer_idx on bom_assets (tenant_id, customer_id);

-- ── bom_lines ───────────────────────────────────────────────────────
create table if not exists bom_lines (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  asset_id uuid not null references bom_assets(id) on delete cascade,
  seq_no int,                                -- source-file row order
  level int,                                 -- assembly depth (1=top); null = flat
  parent_line_id uuid references bom_lines(id) on delete set null,
  part_no text not null,
  part_name text,
  supplier_part_no text,                     -- external supplier/source code
  supplier_id uuid references suppliers(id) on delete set null,
  material text,
  size text,
  qty numeric(18, 6),
  uom text,
  side text,
  std_category text,
  is_spare boolean,
  remarks text,
  raw jsonb not null default '{}'::jsonb,     -- original row cells for audit/repair
  created_at timestamptz not null default now(),
  unique (tenant_id, asset_id, seq_no)
);
create index if not exists bom_lines_asset_idx on bom_lines (tenant_id, asset_id, seq_no);
create index if not exists bom_lines_part_idx on bom_lines (tenant_id, part_no);
create index if not exists bom_lines_supplier_part_idx on bom_lines (tenant_id, supplier_part_no);

-- ── bom_asset_projects (M:N asset <-> project) ──────────────────────
create table if not exists bom_asset_projects (
  tenant_id uuid not null references tenants(id) on delete cascade,
  asset_id uuid not null references bom_assets(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  qty numeric(18, 4),
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, asset_id, project_id)
);
create index if not exists bom_asset_projects_project_idx on bom_asset_projects (tenant_id, project_id);

-- ── bom_import_events (provenance / modification history) ───────────
create table if not exists bom_import_events (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  asset_id uuid not null references bom_assets(id) on delete cascade,
  uploaded_by uuid references auth.users(id) on delete set null,
  source_format text,
  file_name text,
  line_count int,
  diff jsonb not null default '{}'::jsonb,     -- { added, removed, changed, unchanged }
  created_at timestamptz not null default now()
);
create index if not exists bom_import_events_asset_idx on bom_import_events (tenant_id, asset_id, created_at desc);

-- ── RLS (standard tenant-scoped policies) ───────────────────────────
alter table bom_assets enable row level security;
drop policy if exists bom_assets_select on bom_assets;
create policy bom_assets_select on bom_assets
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists bom_assets_write on bom_assets;
create policy bom_assets_write on bom_assets
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

alter table bom_lines enable row level security;
drop policy if exists bom_lines_select on bom_lines;
create policy bom_lines_select on bom_lines
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists bom_lines_write on bom_lines;
create policy bom_lines_write on bom_lines
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

alter table bom_asset_projects enable row level security;
drop policy if exists bom_asset_projects_select on bom_asset_projects;
create policy bom_asset_projects_select on bom_asset_projects
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists bom_asset_projects_write on bom_asset_projects;
create policy bom_asset_projects_write on bom_asset_projects
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

alter table bom_import_events enable row level security;
drop policy if exists bom_import_events_select on bom_import_events;
create policy bom_import_events_select on bom_import_events
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists bom_import_events_write on bom_import_events;
create policy bom_import_events_write on bom_import_events
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

comment on table bom_assets is
  'BOM ingestion (PR/Phase 1): a finished product/equipment/assembly whose parts list was imported. Industry-neutral generalization of the per-asset BOM header.';
comment on table bom_lines is
  'BOM ingestion: the as-imported parts list for an asset (source order, assembly level, material, supplier part, qty). Source of truth for the asset structure; bill_of_materials edges + item_master rows are derived from it.';
comment on table bom_asset_projects is
  'BOM ingestion: M:N link of a BOM asset to projects; customer flows from the project or bom_assets.customer_id.';
comment on table bom_import_events is
  'BOM ingestion: one row per upload/re-import (who, when, source format, diff) for provenance and the future approver workflow.';
