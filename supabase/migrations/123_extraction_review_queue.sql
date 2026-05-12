-- 123_extraction_review_queue.sql
--
-- Wave 4.1 / Improvement #16: low-confidence review queue.
--
-- Today the docai pipeline produces three statuses: ok,
-- low_confidence, failed. Operators see the badge in the
-- workspace but there is no centralized queue of "extractions
-- that need eyes." When 12 orders sit at low_confidence across
-- 4 customers, the operator hunts for them by clicking through
-- the orders list.
--
-- extraction_review_queue is the unified pull queue. Every run
-- whose status_reason is in {low_confidence, dedupe_hit (manual
-- review optional), non_po, image_pdf_no_text, empty_lines,
-- anomalies_has_blockers} writes one row at run completion.
-- Operators triage the queue from a single screen; clicking a
-- row jumps to the workspace pre-loaded on that order.
--
-- Status lifecycle:
--   open       -> created when the run completes
--   in_review  -> operator opened the row
--   resolved   -> operator confirmed or rejected the run
--   archived   -> 30+ days past resolved
--
-- Idempotent. Unique constraint on (tenant_id, extraction_run_id)
-- so a re-trigger of the pipeline doesn't double-queue.

create table if not exists extraction_review_queue (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  customer_id          uuid references customers(id) on delete set null,
  extraction_run_id    uuid not null references extraction_runs(id) on delete cascade,
  case_id              uuid,                          -- order_id / source_po_id / quote_id
  reason               text not null,                 -- 'low_confidence' / 'anomalies' / 'parse_failed' / ...
  severity             text not null default 'medium', -- 'low' | 'medium' | 'high' | 'critical'
  triggered_by         text,                          -- 'cron' / 'manual_upload' / 'inbound_email'
  preview              jsonb,                         -- compact subset of normalized_extract for the queue card
  metrics              jsonb,                         -- { confidence, anomaly_count, ... } for sort/filter
  status               text not null default 'open',  -- 'open' | 'in_review' | 'resolved' | 'archived'
  assigned_to          uuid references auth.users(id) on delete set null,
  resolved_by          uuid references auth.users(id) on delete set null,
  resolved_at          timestamptz,
  resolution           text,                          -- 'confirmed' / 'rejected' / 'reextracted'
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint extraction_review_queue_status_chk
    check (status in ('open', 'in_review', 'resolved', 'archived')),
  constraint extraction_review_queue_severity_chk
    check (severity in ('low', 'medium', 'high', 'critical')),
  constraint extraction_review_queue_resolution_chk
    check (resolution is null or resolution in ('confirmed', 'rejected', 'reextracted'))
);

-- Idempotency on (tenant, run).
create unique index if not exists extraction_review_queue_uq
  on extraction_review_queue (tenant_id, extraction_run_id);

-- Triage indices: by status + severity for the operator queue,
-- by reason for diagnostics, by customer for per-account triage.
create index if not exists extraction_review_queue_open_by_severity
  on extraction_review_queue (tenant_id, status, severity desc, created_at desc)
  where status in ('open', 'in_review');

create index if not exists extraction_review_queue_by_reason
  on extraction_review_queue (tenant_id, reason, created_at desc);

create index if not exists extraction_review_queue_by_customer
  on extraction_review_queue (tenant_id, customer_id, status, created_at desc);

alter table extraction_review_queue enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'extraction_review_queue'
      and policyname = 'extraction_review_queue_tenant_rw'
  ) then
    create policy extraction_review_queue_tenant_rw
      on extraction_review_queue for all
      to authenticated
      using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
      with check (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
  end if;
end $$;

comment on table extraction_review_queue is
  'Wave 4.1: unified pull queue for docai extractions that need operator eyes (low confidence, anomalies, parse failures).';
