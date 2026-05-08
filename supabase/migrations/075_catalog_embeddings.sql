-- Audit P8.4. Embedding-based catalog search.
--
-- pgvector extension + a 1024-dim embedding column on item_master
-- so the semantic search endpoint can find parts whose description
-- is conceptually close to a customer's free-text query
-- ("4-pole motor 1.5 kW IE3" matches "Three-phase induction motor
-- 1.5 kW, IE3 efficiency, 4-pole").
--
-- Voyage AI's voyage-3 model emits 1024-dim float vectors. We
-- store them as `vector(1024)` and index with HNSW so cosine-
-- distance lookups are O(log n) at query time.

create extension if not exists vector;

alter table item_master
  add column if not exists embedding vector(1024),
  add column if not exists embedding_model text,
  add column if not exists embedding_text text,
  add column if not exists embedded_at timestamptz;

-- Mark rows whose description has changed since the last embed
-- so the cron knows what to re-embed without scanning everything.
create index if not exists item_master_needs_embed_idx
  on item_master (tenant_id, embedded_at)
  where embedding is null;

-- HNSW (Hierarchical Navigable Small World) index for cosine
-- distance lookups. Cosine is the standard for sentence-style
-- embeddings; the operator is `<=>`.
do $$ begin
  if not exists (
    select 1 from pg_indexes where indexname = 'item_master_embedding_hnsw_idx'
  ) then
    create index item_master_embedding_hnsw_idx
      on item_master using hnsw (embedding vector_cosine_ops);
  end if;
end $$;

-- Tenant-scoped semantic-search RPC. Takes a query embedding and
-- returns the top-k nearest items for the calling tenant. The RPC
-- is callable from the service role; the API layer enforces the
-- tenant predicate so the function does not need RLS.
-- Bug fix May 2026: previous version referenced i.list_price which
-- does not exist on item_master (the column is purchase_price per
-- migration 006). The column is renamed in the result set so
-- callers that already speak the function's contract continue to
-- work, but the underlying lookup uses the real column.
create or replace function search_catalog_by_embedding(
  p_tenant uuid,
  p_query  vector(1024),
  p_limit  int default 10
) returns table (
  id uuid,
  part_no text,
  description text,
  list_price numeric,
  similarity float
) language sql stable as $$
  select
    i.id, i.part_no, i.description, i.purchase_price as list_price,
    1 - (i.embedding <=> p_query) as similarity
  from item_master i
  where i.tenant_id = p_tenant
    and i.embedding is not null
  order by i.embedding <=> p_query
  limit p_limit;
$$;
