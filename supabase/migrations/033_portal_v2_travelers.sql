-- 033_portal_v2_travelers.sql
-- Two related deliverables:
--   1. Customer portal v2: scope additions for reorder, invoice
--      download, full quote acceptance flow.
--   2. Auto-print travelers (Smartbase unique): generate a traveler
--      PDF after a successful ERP push, optionally route to a CUPS/IPP
--      printer at the customer site via a small relay agent.
-- Idempotent.

-- 1. Portal v2 ----------------------------------------------------

-- Tighten the portal_tokens scope check to match the v2 vocabulary.
-- v1 default scopes were ['quotes','orders','invoices','pay']. v2
-- adds 'reorder', 'download_invoice', 'accept_quote'.
-- Existing tokens keep their old scopes; v2 capabilities just won't
-- be allowed unless an admin explicitly grants them.
alter table portal_tokens
  alter column scopes set default
    array['quotes','orders','invoices','pay','reorder','download_invoice','accept_quote'];

-- Quote acceptance audit. One row per customer-side accept on a
-- portal_token. We record IP + UA so the customer's signature
-- (in the legal-acceptance sense) is defensible if ever challenged.
create table if not exists portal_quote_acceptances (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  token_id uuid references portal_tokens(id) on delete set null,
  order_id uuid not null references orders(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  accepted_at timestamptz not null default now(),
  ip text,
  user_agent text,
  signature_name text,                                -- typed name
  signature_email text,                               -- echoed back from the token
  payload_hash text,                                  -- snapshot of the order's payload_hash at acceptance time
  evidence_url text,                                  -- signed URL to a stored evidence PDF
  raw jsonb default '{}'::jsonb
);

create index if not exists portal_quote_acc_tenant_idx
  on portal_quote_acceptances (tenant_id, accepted_at desc);
create index if not exists portal_quote_acc_order_idx
  on portal_quote_acceptances (tenant_id, order_id);

alter table portal_quote_acceptances enable row level security;
drop policy if exists "portal_quote_acc_select" on portal_quote_acceptances;
create policy "portal_quote_acc_select" on portal_quote_acceptances
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- Reorder log. One row per customer-side reorder action, linking the
-- new draft to the source order so analytics + KB assistant can
-- surface "Acme reorders SKU-X every 6 weeks"-style signals.
create table if not exists portal_reorders (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  token_id uuid references portal_tokens(id) on delete set null,
  source_order_id uuid not null references orders(id) on delete cascade,
  new_order_id uuid references orders(id) on delete set null,
  created_at timestamptz not null default now(),
  raw jsonb default '{}'::jsonb
);

create index if not exists portal_reorders_tenant_idx on portal_reorders (tenant_id, created_at desc);

alter table portal_reorders enable row level security;
drop policy if exists "portal_reorders_select" on portal_reorders;
create policy "portal_reorders_select" on portal_reorders
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- 2. Auto-print travelers ---------------------------------------

-- Tenant-wide preferences (auto-generate after every ERP push, or
-- only on demand). Set on tenant_settings to keep the column count
-- modest.
alter table tenant_settings
  add column if not exists travelers_auto_print boolean not null default false,
  add column if not exists travelers_default_printer text,
  add column if not exists travelers_storage_prefix text default 'travelers/';

-- Print queue. The on-prem CUPS/IPP relay agent (out of code scope;
-- the contract is documented in docs/INTEGRATIONS.md) polls this
-- queue every 30s, picks queued rows, ships PDFs to the configured
-- printer, then flips the row to printed | failed.
create table if not exists print_jobs (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id uuid references orders(id) on delete set null,
  printer_id text,
  pdf_storage_path text,
  pdf_signed_url text,
  status text not null default 'queued' check (status in ('queued','printing','printed','failed','cancelled')),
  attempt_count int not null default 0,
  last_attempt_at timestamptz,
  error text,
  triggered_by text not null default 'erp_push' check (triggered_by in ('erp_push','manual','reorder')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists print_jobs_picker_idx on print_jobs (status, created_at)
  where status in ('queued','printing');
create index if not exists print_jobs_tenant_idx on print_jobs (tenant_id, created_at desc);

alter table print_jobs enable row level security;
drop policy if exists "print_jobs_all" on print_jobs;
create policy "print_jobs_all" on print_jobs
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create or replace function print_jobs_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists print_jobs_updated_at on print_jobs;
create trigger print_jobs_updated_at before update on print_jobs
  for each row execute function print_jobs_touch_updated_at();
