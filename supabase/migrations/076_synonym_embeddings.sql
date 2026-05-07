-- Audit P12. Voyage AI embeddings for catalog_synonyms.
--
-- Phase 8.4 (migration 075) added an embedding column to
-- item_master so the search endpoint can do semantic lookups
-- against canonical part rows. Synonyms also benefit: a tenant
-- might register "4 pole motor 1.5kw IE3" as a synonym of a
-- specific part_no, and the search endpoint should match a
-- query like "induction motor 1.5 kW IE3" via the synonym row's
-- semantic distance even when the canonical description doesn't
-- match.
--
-- Schema mirrors the item_master shape: vector(1024) column,
-- HNSW cosine-distance index, search_synonyms_by_embedding RPC.

alter table catalog_synonyms
  add column if not exists embedding vector(1024),
  add column if not exists embedding_model text,
  add column if not exists embedding_text text,
  add column if not exists embedded_at timestamptz;

create index if not exists catalog_synonyms_needs_embed_idx
  on catalog_synonyms (tenant_id, embedded_at)
  where embedding is null;

do $$ begin
  if not exists (
    select 1 from pg_indexes where indexname = 'catalog_synonyms_embedding_hnsw_idx'
  ) then
    create index catalog_synonyms_embedding_hnsw_idx
      on catalog_synonyms using hnsw (embedding vector_cosine_ops);
  end if;
end $$;

create or replace function search_synonyms_by_embedding(
  p_tenant uuid,
  p_query  vector(1024),
  p_limit  int default 10
) returns table (
  id uuid,
  item_id uuid,
  synonym text,
  confidence numeric,
  similarity float
) language sql stable as $$
  select
    s.id, s.item_id, s.synonym, s.confidence,
    1 - (s.embedding <=> p_query) as similarity
  from catalog_synonyms s
  where s.tenant_id = p_tenant
    and s.embedding is not null
  order by s.embedding <=> p_query
  limit p_limit;
$$;
