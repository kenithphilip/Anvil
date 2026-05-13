-- 130_item_embeddings_hnsw.sql
--
-- Wave CM 2.5: HNSW over IVFFlat + iterative scan.
--
-- Migration 125 (Wave 5.2 docai) created `item_embeddings` with
-- an IVFFlat cosine index. Per the pgvector 0.8 release notes and
-- the 2026 production-experience write-ups (Crunchy Data,
-- Instaclustr, Calmops):
--
--   - HNSW gives better recall at the cost of slower build times
--     and higher memory usage.
--   - pgvector 0.8 added iterative_scan which is critical for
--     RLS-scoped queries: without it, the planner can return
--     fewer than `limit` results after the tenant-filter
--     narrows the candidate set.
--   - For per-tenant workloads (hundreds to low tens of
--     thousands of items per tenant), HNSW's higher build cost
--     amortises because the index is built once and queried
--     hundreds of times per day.
--
-- This migration drops the IVFFlat index and rebuilds as HNSW
-- with m=16, ef_construction=64 (pgvector defaults for balanced
-- recall vs build time). It also enables iterative scan via a
-- session-level setting in the helper RPC.
--
-- Idempotent. The DROP INDEX IF EXISTS is safe; the CREATE INDEX
-- IF NOT EXISTS prevents recreate on a fresh DB that already has
-- the HNSW form.

-- Drop the prior IVFFlat index. Safe: the HNSW index below
-- covers the same query.
drop index if exists item_embeddings_vector_idx;

-- HNSW index. The 16 / 64 parameters track pgvector's
-- recommended defaults for high-recall production workloads
-- with vectors in the 1536-dim range.
create index if not exists item_embeddings_vector_hnsw_idx
  on item_embeddings using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

comment on index item_embeddings_vector_hnsw_idx is
  'CM 2.5: HNSW over IVFFlat for high-recall vector search. m=16, ef_construction=64.';

-- Same upgrade for extraction_line_embeddings (the per-line
-- query cache from Wave 5.2). When the recon-table renders the
-- same order twice, the second render reuses cached embeddings;
-- the HNSW index speeds the cosine similarity probe.
drop index if exists extraction_line_embeddings_vector_idx;

create index if not exists extraction_line_embeddings_vector_hnsw_idx
  on extraction_line_embeddings using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

comment on index extraction_line_embeddings_vector_hnsw_idx is
  'CM 2.5: HNSW for the per-line embedding cache.';

-- RPC wrapper for the cosine nearest-neighbour search. The RPC
-- form (a) lets us SET hnsw.iterative_scan = on for the duration
-- of the call so RLS-prefiltered results don't fall short, and
-- (b) gives JS callers a stable function name (match_item_embeddings)
-- regardless of whether the underlying index is IVFFlat or HNSW.
create or replace function match_item_embeddings(
  _tenant_id   uuid,
  _query       vector(1536),
  _match_count int default 5
)
returns table (
  item_id     uuid,
  part_no     text,
  description text,
  score       float8
)
language plpgsql
security definer
set search_path = public
as $$
begin
  -- CM 2.5: iterative_scan ensures we get _match_count results
  -- AFTER the tenant filter. Without it, the HNSW search returns
  -- _match_count rows pre-filter, which can be 0 rows post-RLS.
  -- The setting only persists for the duration of this call.
  perform set_config('hnsw.iterative_scan', 'on', true);
  return query
  select
    im.id as item_id,
    im.part_no,
    im.description,
    1 - (e.embedding <=> _query) as score
  from item_embeddings e
  join item_master im on im.id = e.item_id
  where e.tenant_id = _tenant_id
    and im.tenant_id = _tenant_id
  order by e.embedding <=> _query
  limit _match_count;
end;
$$;

comment on function match_item_embeddings is
  'CM 2.5: cosine nearest-neighbour search over item_embeddings, scoped to tenant. Uses hnsw.iterative_scan=on so RLS-prefiltered results meet the requested match_count.';
