-- 036_catalog_intelligence.sql
-- Mercura/Comena parity: synonym + typo-tolerant catalog search,
-- alternative-part suggestion, high-margin private-label upsell.
-- Plus KB-assistant infrastructure (chat sessions/messages reuse
-- the existing erp_chat_sessions schema; we just add a couple of
-- tools to the registry).
--
-- pg_trgm enables similarity matching on item_master.description
-- and synonyms.
-- Idempotent.

create extension if not exists pg_trgm;

create table if not exists catalog_synonyms (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  item_id uuid not null references item_master(id) on delete cascade,
  synonym text not null,
  source text not null default 'manual' check (source in ('manual','learned','imported')),
  confidence numeric(4,3) default 1.0,
  created_at timestamptz not null default now(),
  unique (tenant_id, item_id, synonym)
);

create index if not exists catalog_synonyms_lookup_idx
  on catalog_synonyms using gin (lower(synonym) gin_trgm_ops);
create index if not exists catalog_synonyms_tenant_idx
  on catalog_synonyms (tenant_id, item_id);

alter table catalog_synonyms enable row level security;
drop policy if exists "catalog_synonyms_all" on catalog_synonyms;
create policy "catalog_synonyms_all" on catalog_synonyms
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists catalog_alternatives (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  item_id uuid not null references item_master(id) on delete cascade,
  alternative_item_id uuid not null references item_master(id) on delete cascade,
  relation text not null check (relation in ('equivalent','upgrade','downsell','crosssell')),
  margin_delta_bps int,                              -- estimated bps margin lift vs. original
  spec_match_score numeric(4,3),                     -- 0..1 score from spec compatibility
  notes text,
  created_at timestamptz not null default now(),
  unique (tenant_id, item_id, alternative_item_id, relation)
);

create index if not exists catalog_alternatives_item_idx
  on catalog_alternatives (tenant_id, item_id);

alter table catalog_alternatives enable row level security;
drop policy if exists "catalog_alternatives_all" on catalog_alternatives;
create policy "catalog_alternatives_all" on catalog_alternatives
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists private_label_items (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  item_id uuid not null references item_master(id) on delete cascade,
  label_brand text not null,                          -- the tenant's house brand
  margin_bps int not null default 0,                  -- bps lift over OEM equivalents
  active boolean not null default true,
  notes text,
  unique (tenant_id, item_id)
);

create index if not exists private_label_tenant_idx
  on private_label_items (tenant_id, active);

alter table private_label_items enable row level security;
drop policy if exists "private_label_all" on private_label_items;
create policy "private_label_all" on private_label_items
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- Trigram index on item_master.description for fast typo-tolerant
-- search. The base table already exists from 001_init.sql so this
-- is a pure index add.
create index if not exists item_master_description_trgm_idx
  on item_master using gin (lower(description) gin_trgm_ops);
create index if not exists item_master_part_no_trgm_idx
  on item_master using gin (lower(part_no) gin_trgm_ops);
