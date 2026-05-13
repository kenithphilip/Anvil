-- 131_item_master_search_index.sql
--
-- Wave CM 2.2: hybrid BM25 + vector retrieval.
--
-- Per the pgvector 2026 production guidance and HuggingFace's
-- B2B-embeddings forum: dense vectors are bad at exact-numeric
-- token matching. Part numbers like "THB-L1-70B-2-GA" are
-- alphanumeric codes; semantic embeddings collapse them.
--
-- The fix is hybrid retrieval:
--   - Lexical (BM25 / Postgres tsvector) catches exact tokens.
--   - Vector (HNSW, Wave CM 2.5) catches semantic neighbours.
--   - Fuse via reciprocal rank.
--
-- This migration adds the tsvector + GIN index on item_master
-- so the JS resolver can do the lexical half of the hybrid
-- query alongside the existing vector half.
--
-- Idempotent.

-- Generated tsvector column. Concatenates the real text columns
-- of item_master: part_no (weight A, most authoritative),
-- alias + print_name (B, common operator vocabulary),
-- description (C), category + sub_category + stock_group (D,
-- broad classifiers). The 'simple' config preserves
-- alphanumerics + dashes verbatim (no stemming) so "THB-L1"
-- tokenises as "thb-l1" not "thb" / "l1". 'english' would stem
-- "adapters" -> "adapt"; we want the operator to type the word
-- they see on the document.
alter table item_master
  add column if not exists search_tsv tsvector
  generated always as (
    setweight(to_tsvector('simple', coalesce(part_no, '')), 'A')
    || setweight(to_tsvector('simple', coalesce(alias, '')), 'B')
    || setweight(to_tsvector('simple', coalesce(print_name, '')), 'B')
    || setweight(to_tsvector('simple', coalesce(description, '')), 'C')
    || setweight(to_tsvector('simple', coalesce(category, '')), 'D')
    || setweight(to_tsvector('simple', coalesce(sub_category, '')), 'D')
    || setweight(to_tsvector('simple', coalesce(stock_group, '')), 'D')
  ) stored;

comment on column item_master.search_tsv is
  'CM 2.2: generated tsvector for the hybrid BM25 + vector retrieval. part_no=A, alias/print_name=B, description=C, category/sub_category/stock_group=D.';

-- GIN index for the lexical half of the hybrid query.
create index if not exists item_master_search_tsv_idx
  on item_master using gin (search_tsv);

-- Helper RPC: rank-fused hybrid search. Takes a query string
-- (lexical) AND an optional embedding (semantic), returns the
-- top-K candidates by reciprocal rank fusion.
--
-- Reciprocal rank fusion: score(item) = sum over all retrievers
-- of 1 / (k + rank_in_retriever). k=60 is the canonical RRF
-- constant per Cormack et al. 2009. Items ranked high by both
-- retrievers dominate; items ranked high by only one still
-- contribute. The fusion is parameter-free; tuning the weights
-- is unnecessary because RRF is rank-based not score-based.
create or replace function match_items_hybrid(
  _tenant_id     uuid,
  _query_text    text,
  _query_vector  vector(1536),
  _match_count   int default 10,
  _candidates_per_retriever int default 40
)
returns table (
  item_id      uuid,
  part_no      text,
  description  text,
  score        float8,
  bm25_rank    int,
  vector_rank  int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  rrf_k constant int := 60;
begin
  perform set_config('hnsw.iterative_scan', 'on', true);
  return query
  with bm25 as (
    select
      im.id,
      row_number() over (order by ts_rank_cd(im.search_tsv, plainto_tsquery('simple', _query_text)) desc) as rnk
    from item_master im
    where im.tenant_id = _tenant_id
      and _query_text is not null
      and _query_text <> ''
      and im.search_tsv @@ plainto_tsquery('simple', _query_text)
    order by ts_rank_cd(im.search_tsv, plainto_tsquery('simple', _query_text)) desc
    limit _candidates_per_retriever
  ),
  vec as (
    select
      e.item_id as id,
      row_number() over (order by e.embedding <=> _query_vector asc) as rnk
    from item_embeddings e
    where e.tenant_id = _tenant_id
      and _query_vector is not null
    order by e.embedding <=> _query_vector asc
    limit _candidates_per_retriever
  ),
  fused as (
    select
      coalesce(b.id, v.id) as id,
      (case when b.rnk is null then 0 else 1.0 / (rrf_k + b.rnk) end)
        + (case when v.rnk is null then 0 else 1.0 / (rrf_k + v.rnk) end) as score,
      b.rnk as b_rnk,
      v.rnk::int as v_rnk
    from bm25 b
    full outer join vec v on v.id = b.id
  )
  select
    im.id as item_id,
    im.part_no,
    im.description,
    f.score::float8 as score,
    coalesce(f.b_rnk, 0)::int as bm25_rank,
    coalesce(f.v_rnk, 0)::int as vector_rank
  from fused f
  join item_master im on im.id = f.id
  where im.tenant_id = _tenant_id
  order by f.score desc
  limit _match_count;
end;
$$;

comment on function match_items_hybrid is
  'CM 2.2: hybrid BM25 + vector retrieval with reciprocal rank fusion. Pass either or both query inputs; rows ranked by either retriever land in the candidate set, fused by RRF (k=60).';
