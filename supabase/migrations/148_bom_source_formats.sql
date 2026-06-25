-- 148_bom_source_formats.sql
-- BOM ingestion Phase 2: tenant-configurable source-format registry.
-- See docs/BOM_INGESTION_DESIGN.md section 3.3.
--
-- Built-in profiles (obara india/korea/china/japan + generic_flat) ship
-- in code (_lib/bom-format.js). This table holds tenant-authored formats
-- and tenant overrides of a built-in (same key wins). Lets any industry
-- add a BOM layout (column aliases + detection signals + quirks) as data,
-- with no code change. Additive; nothing else depends on it.

create table if not exists bom_source_formats (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  key text not null,                         -- e.g. 'acme_supplier_a' or an override of 'obara_china'
  label text,
  source_country text,
  column_map jsonb not null default '{}'::jsonb,  -- { canonicalField: [header aliases] }
  detect jsonb not null default '{}'::jsonb,       -- { headers_all, any_label, script, filename, priority }
  quirks jsonb not null default '{}'::jsonb,       -- { parts_code_to, level_from_col, level_from_dotted, lr_yes_no, remarks_append, meta_labels }
  enabled boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, key)
);
create index if not exists bom_source_formats_tenant_idx on bom_source_formats (tenant_id, enabled);

alter table bom_source_formats enable row level security;
drop policy if exists bom_source_formats_select on bom_source_formats;
create policy bom_source_formats_select on bom_source_formats
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists bom_source_formats_write on bom_source_formats;
create policy bom_source_formats_write on bom_source_formats
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

comment on table bom_source_formats is
  'BOM ingestion Phase 2: tenant-authored / overridden source formats (column aliases + detection signals + quirks). Built-in profiles live in code; this table is merged over them at read time.';
