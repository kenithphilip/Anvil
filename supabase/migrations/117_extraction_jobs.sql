-- 117_extraction_jobs.sql
--
-- Phase C of the DocAI robustness work: background-job
-- orchestration for PDFs above the synchronous-extraction
-- ceiling (~60 pages). Large documents land here as queued
-- rows; a cron-driven worker processes them chunk-by-chunk
-- across multiple ticks so a 200-page tender finishes in
-- the background while the operator does other work.
--
-- State machine:
--   queued      job created, no work done yet
--   profiling   TOC profiler in flight
--   chunking    pdf-chunker carving up the source
--   extracting  per-chunk extraction in progress
--   merging     final merge + persist back to orders.result
--   completed   terminal: result is the merged extraction
--   failed      terminal: last_error explains why
--   cancelled   terminal: operator-initiated abort
--
-- Per-chunk state lives in chunk_status as a JSONB array. Each
-- element:
--   { index, page_start, page_end, status, attempts,
--     last_error, adapter_used, completed_at, line_count }
-- The worker reads next_chunk_index, runs that one chunk,
-- updates the array element + bumps next_chunk_index, then
-- yields to the next cron tick. partial_result accumulates the
-- per-chunk normalised outputs so a final merge step can
-- compose the answer.
--
-- Idempotency: every column add uses IF NOT EXISTS; the table
-- itself uses CREATE TABLE IF NOT EXISTS. Re-running the
-- migration on a DB that already has the table is a no-op.

create table if not exists extraction_jobs (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id uuid references orders(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,

  -- Where the source bytes live. Storage path + size let the
  -- worker reload the file on each tick without holding the
  -- bytes in memory between ticks (Vercel functions are
  -- stateless across invocations).
  document_id uuid,
  storage_path text,
  source_filename text,
  source_size_bytes integer,
  source_mime text,

  -- Status machine (see header). default queued.
  status text not null default 'queued'
    check (status in ('queued','profiling','chunking','extracting','merging','completed','failed','cancelled')),

  -- TOC profiler outcome. Populated by the worker after the
  -- profiling stage. NULL until then.
  profiler_result jsonb,
  -- Pages the profiler decided are worth extracting. The chunker
  -- materialises only these.
  keep_pages integer[],
  total_pages integer,

  -- Per-chunk progress + the partial accumulator.
  chunk_status jsonb not null default '[]'::jsonb,
  partial_result jsonb not null default '{}'::jsonb,
  next_chunk_index integer not null default 0,

  -- Final merged result. Set once status flips to completed.
  result jsonb,

  -- Retries + diagnostics.
  attempts integer not null default 0,
  last_error text,

  -- Audit.
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),

  -- The job worker holds a soft lease so two ticks don't grab
  -- the same row. lease_until > now() means "another worker is
  -- mid-flight on this row". 30s default; the worker renews on
  -- each chunk.
  lease_until timestamptz
);

-- Queue index: workers select queued + lease-expired rows in
-- created_at order so the oldest job runs first.
create index if not exists extraction_jobs_queue_idx
  on extraction_jobs (tenant_id, status, created_at)
  where status in ('queued','profiling','chunking','extracting','merging');

-- Per-order lookup: the UI polls by order_id to track a job.
create index if not exists extraction_jobs_by_order_idx
  on extraction_jobs (tenant_id, order_id, created_at desc);

-- Customer rollup: dashboard counts per customer.
create index if not exists extraction_jobs_by_customer_idx
  on extraction_jobs (tenant_id, customer_id)
  where customer_id is not null;

alter table extraction_jobs enable row level security;
drop policy if exists extraction_jobs_select on extraction_jobs;
create policy extraction_jobs_select on extraction_jobs
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists extraction_jobs_write on extraction_jobs;
create policy extraction_jobs_write on extraction_jobs
  for all
  using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

-- updated_at trigger so callers don't have to remember to bump
-- it on every write.
create or replace function extraction_jobs_touch() returns trigger
  language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists extraction_jobs_touch_trg on extraction_jobs;
create trigger extraction_jobs_touch_trg
  before update on extraction_jobs
  for each row execute function extraction_jobs_touch();

comment on table extraction_jobs is
  'Phase C: background-job queue for large-PDF extraction. Worker = src/api/cron/extraction_jobs.js. See docs/EXTRACTION_PIPELINE_PLAN.md.';
comment on column extraction_jobs.chunk_status is
  'Per-chunk JSONB array. Each element: { index, page_start, page_end, status, attempts, last_error, adapter_used, line_count, completed_at }.';
comment on column extraction_jobs.lease_until is
  'Worker lease (~30s). When > now(), another worker is mid-flight on this row and others must skip it.';
