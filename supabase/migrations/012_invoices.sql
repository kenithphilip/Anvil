-- 012_invoices.sql
-- Non-India invoicing module. Sits alongside the existing einvoices
-- table (which is GSTN-specific) so India tenants can have both an
-- einvoice (with IRN, QR, ack_no) and a generic invoice; non-India
-- tenants get only `invoices`.
--
-- Schema decisions:
-- - One row per customer-facing invoice. Multiple invoices can point
--   at the same order (progress invoicing, partial fulfillment).
-- - `invoice_number` is per-tenant unique. We allocate it from
--   `invoice_number_sequences` so concurrent POSTs cannot collide.
-- - Status is a check constraint, not an enum, so adding a new
--   state (e.g. partial_refund) does not need a migration.
-- - Stripe-specific fields are nullable; Phase 2.2 fills them.
-- Idempotent.

create table if not exists invoices (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id uuid references orders(id) on delete set null,
  customer_id uuid references customers(id) on delete set null,

  invoice_number text not null,
  invoice_format text default 'INV-####',          -- per-tenant template hint

  issue_date date not null default current_date,
  due_date date not null,
  currency text not null default 'USD',

  subtotal numeric(14,2) not null default 0,
  tax_total numeric(14,2) not null default 0,
  grand_total numeric(14,2) not null default 0,
  paid_amount numeric(14,2) not null default 0,

  status text not null default 'draft' check (status in (
    'draft', 'sent', 'partial', 'paid', 'overdue', 'void'
  )),

  payment_terms text,
  notes text,
  line_items jsonb not null default '[]'::jsonb,
  pdf_storage_path text,

  -- Stripe Connect fields filled by Phase 2.2.
  stripe_payment_intent_id text,
  stripe_checkout_url text,
  stripe_checkout_expires_at timestamptz,

  sent_at timestamptz,
  paid_at timestamptz,
  voided_at timestamptz,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (tenant_id, invoice_number)
);

create index if not exists invoices_tenant_status_idx on invoices (tenant_id, status, created_at desc);
create index if not exists invoices_tenant_order_idx  on invoices (tenant_id, order_id);
create index if not exists invoices_tenant_due_idx    on invoices (tenant_id, due_date);
create index if not exists invoices_stripe_idx        on invoices (stripe_payment_intent_id) where stripe_payment_intent_id is not null;

alter table invoices enable row level security;
drop policy if exists "invoices_tenant_select" on invoices;
drop policy if exists "invoices_tenant_modify" on invoices;
create policy "invoices_tenant_select" on invoices
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
create policy "invoices_tenant_modify" on invoices
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create or replace function invoices_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists invoices_updated_at on invoices;
create trigger invoices_updated_at before update on invoices
  for each row execute function invoices_touch_updated_at();


-- Atomic per-tenant invoice number sequence. The format string is
-- stored on the row; the next-number is the bare integer. Callers
-- format the final string client-side or via the formatInvoiceNumber
-- helper in src/api/_lib/invoicing.js.
create table if not exists invoice_number_sequences (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  next_number bigint not null default 1,
  prefix text not null default 'INV',
  format text not null default '{prefix}-{number:04}',  -- {number:N} pads to N digits
  updated_at timestamptz not null default now()
);

alter table invoice_number_sequences enable row level security;
drop policy if exists "invseq_tenant_select" on invoice_number_sequences;
drop policy if exists "invseq_tenant_modify" on invoice_number_sequences;
create policy "invseq_tenant_select" on invoice_number_sequences
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
create policy "invseq_tenant_modify" on invoice_number_sequences
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- Atomically increment + return the next invoice number for a tenant.
-- Returns the bare integer; the caller formats it.
create or replace function next_invoice_number(p_tenant uuid)
returns bigint
language plpgsql
as $$
declare next_n bigint;
begin
  insert into invoice_number_sequences (tenant_id, next_number)
    values (p_tenant, 1)
    on conflict (tenant_id) do nothing;
  update invoice_number_sequences
    set next_number = next_number + 1, updated_at = now()
    where tenant_id = p_tenant
    returning next_number - 1 into next_n;
  return next_n;
end;
$$;


-- Payment records. One row per Stripe payment_intent.succeeded
-- (or refund) event the webhook processes in Phase 2.2.
create table if not exists payment_records (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  invoice_id uuid references invoices(id) on delete set null,
  amount numeric(14,2) not null,
  currency text not null default 'USD',
  method text not null default 'stripe',
  stripe_charge_id text,
  stripe_payment_intent_id text,
  paid_at timestamptz not null default now(),
  raw jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, stripe_payment_intent_id)
);

create index if not exists payment_records_invoice_idx on payment_records (tenant_id, invoice_id);
alter table payment_records enable row level security;
drop policy if exists "payments_tenant_select" on payment_records;
drop policy if exists "payments_tenant_modify" on payment_records;
create policy "payments_tenant_select" on payment_records
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
create policy "payments_tenant_modify" on payment_records
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
