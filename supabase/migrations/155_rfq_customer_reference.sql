-- 155_rfq_customer_reference.sql
--
-- Customer-referenced RFQs. Obara subsidiaries (and some vendors) quote
-- special rates on a customer-to-customer basis: the RFQ must tell the vendor
-- WHICH end customer it is for, using the reference/code that vendor knows
-- that customer by, so the right contract rate comes back.
--
-- 1) supplier_rfqs.customer_id  — the end customer the RFQ is priced for
--    (defaults from the linked quote's customer when raised from a quote).
-- 2) supplier_rfqs.customer_ref — a default reference to communicate.
-- 3) vendor_customer_refs — durable per-(vendor, customer) reference/code,
--    so each vendor's own code for a customer is remembered and reused.

alter table supplier_rfqs
  add column if not exists customer_id uuid references customers(id) on delete set null;

alter table supplier_rfqs
  add column if not exists customer_ref text;

create table if not exists vendor_customer_refs (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  vendor_id uuid not null references vendors(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  customer_ref text not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, vendor_id, customer_id)
);

create index if not exists vendor_customer_refs_idx
  on vendor_customer_refs (tenant_id, customer_id);

alter table vendor_customer_refs enable row level security;
drop policy if exists "vendor_customer_refs_all" on vendor_customer_refs;
create policy "vendor_customer_refs_all" on vendor_customer_refs
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create or replace function vendor_customer_refs_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists vendor_customer_refs_updated_at on vendor_customer_refs;
create trigger vendor_customer_refs_updated_at before update on vendor_customer_refs
  for each row execute function vendor_customer_refs_touch_updated_at();
