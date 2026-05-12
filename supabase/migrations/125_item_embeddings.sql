-- 125_item_embeddings.sql
--
-- Wave 5.2 / Improvement #23: per-customer embedding index for
-- item-master fuzzy matching.
--
-- The item-mapper resolver's tier 5 (description_fuzzy) uses a
-- significant-word overlap score. That works on exact-token
-- matches but misses synonyms ("clamp" vs "fastener", "screw"
-- vs "bolt", "GD544" vs "guide assembly"). An embedding-based
-- index turns the description into a vector and resolves via
-- cosine similarity, catching synonyms the token-overlap path
-- misses.
--
-- This migration adds:
--   - item_embeddings: per-(tenant, item) vector + provenance.
--   - extraction_line_embeddings: per-extraction-line vector for
--     the same-customer cache (so re-extractions don't re-embed).
--
-- We use vector(1536) to match OpenAI text-embedding-3-small +
-- Anthropic voyager-large dims. The encoder choice is a tenant
-- setting; both produce 1536-dim outputs and store identically.
--
-- pgvector extension required (already enabled by 050_*.sql or
-- similar; idempotent here).

create extension if not exists vector;

create table if not exists item_embeddings (
  tenant_id    uuid not null references tenants(id) on delete cascade,
  item_id      uuid not null references item_master(id) on delete cascade,
  embedding    vector(1536),
  encoder      text not null default 'text-embedding-3-small',
  source_text  text not null,                    -- the string that was embedded (description, partNumber, alias concat)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, item_id)
);

create index if not exists item_embeddings_vector_idx
  on item_embeddings using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create index if not exists item_embeddings_by_tenant
  on item_embeddings (tenant_id, updated_at desc);

alter table item_embeddings enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'item_embeddings'
      and policyname = 'item_embeddings_tenant_rw'
  ) then
    create policy item_embeddings_tenant_rw
      on item_embeddings for all
      to authenticated
      using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
      with check (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
  end if;
end $$;

comment on table item_embeddings is
  'Wave 5.2: per-tenant per-item embedding for fuzzy item-master matching.';

-- Per-extraction-line embedding cache. When the resolver embeds
-- a PO line, it stamps the vector here so re-runs and the recon
-- table render the same suggestions without re-embedding.
create table if not exists extraction_line_embeddings (
  tenant_id           uuid not null references tenants(id) on delete cascade,
  extraction_run_id   uuid not null references extraction_runs(id) on delete cascade,
  line_index          integer not null,
  embedding           vector(1536),
  source_text         text not null,
  encoder             text not null default 'text-embedding-3-small',
  created_at          timestamptz not null default now(),
  primary key (tenant_id, extraction_run_id, line_index)
);

create index if not exists extraction_line_embeddings_vector_idx
  on extraction_line_embeddings using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

alter table extraction_line_embeddings enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'extraction_line_embeddings'
      and policyname = 'extraction_line_embeddings_tenant_rw'
  ) then
    create policy extraction_line_embeddings_tenant_rw
      on extraction_line_embeddings for all
      to authenticated
      using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
      with check (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
  end if;
end $$;

comment on table extraction_line_embeddings is
  'Wave 5.2: per-extraction-line embedding for the recon-table suggestion cache.';
