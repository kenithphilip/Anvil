-- 016_tally_v2.sql
-- Tally connector v2. Hardens the v1 single-bridge XML push into a
-- production integration:
--
--   1. Multi-company support. A tenant can have one Tally Company per
--      legal entity it operates; each company has its own bridge URL,
--      auth token, and credentials. tally_companies new table.
--   2. Encrypted bridge tokens. Same pattern as NetSuite v2: AES-GCM
--      ciphertext + IV, plaintext fallback when ANVIL_SECRETS_KEY is
--      missing.
--   3. Retry queue. Recoverable XML push failures land in
--      tally_retry_queue with exponential backoff.
--   4. Payment receipts. New tally_payment_receipts table mirrors
--      Tally Receipt Vouchers so AR collection in Anvil sees real
--      payments without a separate webhook.
--   5. Reverse sync. tally_voucher_state mirrors a sales-voucher's
--      state in Tally (Tally allows post-import edits / cancels) so
--      the Anvil order tab reflects ground truth.
--   6. Expanded voucher types. tally_voucher_records v1 only modeled
--      sales orders; v2 widens the check to every voucher class we
--      now support: SalesOrder, Sales, Purchase, Receipt, Payment,
--      Contra, Journal, DebitNote, CreditNote, StockJournal.
--   7. Sync run audit. tally_sync_runs mirrors netsuite_sync_runs.
--   8. Bridge health monitoring. tally_companies tracks
--      last_health_at + last_health_status so the UI can show
--      "bridge online" without re-probing every render.
-- Idempotent.

-- Multi-company. The default v1 install gets one company per tenant
-- (id = tenant_id) lazily on first use; new tenants register via
-- /api/tally/companies POST.
create table if not exists tally_companies (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  is_default boolean not null default false,
  bridge_url text,
  bridge_token text,            -- plaintext (deprecated; rotated into _enc)
  bridge_token_enc bytea,
  bridge_iv bytea,
  bridge_version text,          -- e.g. "tally_prime_3.0"
  default_voucher_series text,
  default_sales_ledger text,
  default_party_group text,
  gstin text,
  state_code text,
  last_health_at timestamptz,
  last_health_status text check (last_health_status in ('ok','degraded','down')),
  last_health_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create index if not exists tally_companies_tenant_idx on tally_companies (tenant_id, is_default desc);

alter table tally_companies enable row level security;
drop policy if exists "tally_companies_all" on tally_companies;
create policy "tally_companies_all" on tally_companies
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create or replace function tally_companies_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists tally_companies_updated_at on tally_companies;
create trigger tally_companies_updated_at before update on tally_companies
  for each row execute function tally_companies_touch_updated_at();

-- Voucher records widening: drop the old check constraint that
-- limited status values, replace with a v2 set; also add company_id
-- + voucher_type.
alter table tally_voucher_records
  add column if not exists company_id uuid references tally_companies(id) on delete set null,
  add column if not exists voucher_type text default 'SalesOrder',
  add column if not exists voucher_date date,
  add column if not exists external_voucher_no text,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists attempt_count int not null default 0;

-- Replace the constraint with one that allows every v2 voucher type.
do $$ begin
  if exists (select 1 from information_schema.table_constraints
             where table_name = 'tally_voucher_records'
               and constraint_name = 'tally_voucher_records_voucher_type_check') then
    alter table tally_voucher_records drop constraint tally_voucher_records_voucher_type_check;
  end if;
end $$;
alter table tally_voucher_records
  add constraint tally_voucher_records_voucher_type_check
  check (voucher_type in (
    'SalesOrder','Sales','Purchase','Receipt','Payment',
    'Contra','Journal','DebitNote','CreditNote','StockJournal'
  ));

-- Retry queue.
create table if not exists tally_retry_queue (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  company_id uuid references tally_companies(id) on delete set null,
  order_id uuid references orders(id) on delete cascade,
  voucher_record_id uuid references tally_voucher_records(id) on delete cascade,
  voucher_type text not null,
  payload_xml text not null,
  payload_hash text not null,
  attempt_count int not null default 0,
  max_attempts int not null default 5,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  status text not null default 'pending' check (status in ('pending','succeeded','gave_up')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tally_retry_picker_idx on tally_retry_queue (status, next_attempt_at)
  where status = 'pending';
create index if not exists tally_retry_tenant_idx on tally_retry_queue (tenant_id, created_at desc);

alter table tally_retry_queue enable row level security;
drop policy if exists "tally_retry_all" on tally_retry_queue;
create policy "tally_retry_all" on tally_retry_queue
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create or replace function tally_retry_queue_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists tally_retry_queue_updated_at on tally_retry_queue;
create trigger tally_retry_queue_updated_at before update on tally_retry_queue
  for each row execute function tally_retry_queue_touch_updated_at();

-- Payment receipts (Tally -> Anvil). We mirror Receipt Vouchers
-- because AR collection logic in agents/_handlers/ar_collect.js
-- needs to know whether a tenant's bookkeeper has marked a payment
-- received in Tally (the source of truth in India).
create table if not exists tally_payment_receipts (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  company_id uuid references tally_companies(id) on delete set null,
  external_voucher_no text not null,
  voucher_date date,
  party_ledger text,
  amount numeric(14,2),
  currency text default 'INR',
  bank_ledger text,
  reference_no text,
  matched_invoice_id uuid references invoices(id),
  matched_einvoice_id uuid references einvoices(id),
  raw jsonb default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  unique (tenant_id, company_id, external_voucher_no)
);

create index if not exists tally_payments_tenant_idx on tally_payment_receipts (tenant_id, voucher_date desc);

alter table tally_payment_receipts enable row level security;
drop policy if exists "tally_payments_all" on tally_payment_receipts;
create policy "tally_payments_all" on tally_payment_receipts
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- Reverse sync state. One row per (company, external_voucher_no)
-- caching Tally's view of a voucher (post-import edits, cancellation).
create table if not exists tally_voucher_state (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  company_id uuid references tally_companies(id) on delete cascade,
  external_voucher_no text not null,
  voucher_type text,
  status text,
  total numeric(14,2),
  altered boolean not null default false,
  cancelled boolean not null default false,
  raw jsonb default '{}'::jsonb,
  last_seen_at timestamptz not null default now(),
  unique (tenant_id, company_id, external_voucher_no)
);

create index if not exists tally_voucher_state_tenant_idx on tally_voucher_state (tenant_id, last_seen_at desc);

alter table tally_voucher_state enable row level security;
drop policy if exists "tally_voucher_state_all" on tally_voucher_state;
create policy "tally_voucher_state_all" on tally_voucher_state
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- Sync run audit. Mirrors netsuite_sync_runs shape.
create table if not exists tally_sync_runs (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  company_id uuid references tally_companies(id) on delete set null,
  entity text not null,
  run_started_at timestamptz not null default now(),
  run_finished_at timestamptz,
  status text not null default 'running' check (status in ('running','ok','error','partial')),
  rows_pulled int not null default 0,
  rows_inserted int not null default 0,
  rows_updated int not null default 0,
  rows_errored int not null default 0,
  error text,
  triggered_by text not null default 'cron' check (triggered_by in ('cron','manual','retry'))
);

create index if not exists tally_sync_runs_tenant_idx on tally_sync_runs (tenant_id, run_started_at desc);

alter table tally_sync_runs enable row level security;
drop policy if exists "tally_sync_runs_all" on tally_sync_runs;
create policy "tally_sync_runs_all" on tally_sync_runs
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
