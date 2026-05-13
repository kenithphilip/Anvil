-- 134_customer_merge_candidates.sql
--
-- Wave CM 4.2: customer dedupe sweep queue.
--
-- The sweep runs as a cron job (weekly by default). It pulls
-- every (tenant, customer) pair sharing an identity_hash block
-- (CM 1.1), scores them via Fellegi-Sunter compound probability,
-- and inserts candidates above SUGGEST_PROB (0.50) into this
-- queue. Operators review and approve / reject from the unified
-- mapping workspace (CM 5.1).
--
-- We DO NOT auto-merge. Every merge needs operator review
-- because merging customers cascades to orders + quotes +
-- invoices and survivorship decisions (CM 4.3) are workflow-
-- specific.
--
-- Idempotent.

create table if not exists customer_merge_candidates (
  id                   uuid primary key default uuid_generate_v4(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  -- The pair. Order is canonical: lower customer.id goes first
  -- in customer_a so re-runs detect the same pair.
  customer_a_id        uuid not null references customers(id) on delete cascade,
  customer_b_id        uuid not null references customers(id) on delete cascade,
  -- Compound F-S match probability (0..1) from the sweep.
  probability          numeric(5,4) not null,
  contributions        jsonb not null,     -- per-feature contributions for audit
  -- Suggested winner (the row with higher activity / freshness).
  -- Operator can override during review.
  suggested_winner_id  uuid references customers(id) on delete set null,
  -- Workflow state.
  status               text not null default 'open' check (status in (
    'open', 'in_review', 'approved', 'rejected', 'merged', 'archived'
  )),
  reviewed_by          uuid references auth.users(id) on delete set null,
  reviewed_at          timestamptz,
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint customer_merge_candidates_distinct_pair
    check (customer_a_id <> customer_b_id),
  constraint customer_merge_candidates_canonical_order
    check (customer_a_id < customer_b_id),
  constraint customer_merge_candidates_probability_range
    check (probability >= 0 and probability <= 1)
);

-- Idempotency: one open / in-review row per (tenant, pair).
-- A later sweep that finds the same pair updates the prior row
-- rather than creating a duplicate. Once status moves to
-- approved / rejected / merged the row is archived and a future
-- sweep can re-surface it (e.g. operator reopens).
create unique index if not exists customer_merge_candidates_open_uq
  on customer_merge_candidates (tenant_id, customer_a_id, customer_b_id)
  where status in ('open', 'in_review');

-- Operator queue index.
create index if not exists customer_merge_candidates_open_idx
  on customer_merge_candidates (tenant_id, status, probability desc, created_at desc)
  where status in ('open', 'in_review');

-- "Show me everything that merged into this customer" link.
create index if not exists customer_merge_candidates_by_winner
  on customer_merge_candidates (tenant_id, suggested_winner_id)
  where suggested_winner_id is not null;

alter table customer_merge_candidates enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'customer_merge_candidates'
      and policyname = 'customer_merge_candidates_tenant_rw'
  ) then
    create policy customer_merge_candidates_tenant_rw
      on customer_merge_candidates for all
      to authenticated
      using (tenant_id in (select current_tenant_ids()))
      with check (tenant_id in (select current_tenant_ids()));
  end if;
end $$;

comment on table customer_merge_candidates is
  'CM 4.2: queue of customer-pair merge candidates surfaced by the dedupe sweep. Operator review required before merge.';

-- Trigger to refresh updated_at on row update.
drop trigger if exists customer_merge_candidates_set_updated_at on customer_merge_candidates;
create trigger customer_merge_candidates_set_updated_at
  before update on customer_merge_candidates
  for each row execute function set_updated_at();
