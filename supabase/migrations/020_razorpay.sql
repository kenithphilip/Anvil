-- 020_razorpay.sql
-- Razorpay sibling for Stripe Connect: same shape, different SDK
-- semantics, scoped to India tenants. Razorpay's Route product is
-- the parallel to Connect Express; each tenant gets a "linked
-- account" (formerly "Marketplace account") and Anvil takes an
-- optional platform fee.
-- Idempotent.

alter table tenant_settings
  add column if not exists razorpay_key_id text,
  add column if not exists razorpay_key_id_enc bytea,
  add column if not exists razorpay_key_secret_enc bytea,
  add column if not exists razorpay_creds_iv bytea,
  add column if not exists razorpay_account_id text,            -- linked account / merchant id
  add column if not exists razorpay_webhook_secret text,
  add column if not exists razorpay_platform_fee_bps int default 0,
  add column if not exists razorpay_charges_enabled boolean not null default false,
  add column if not exists razorpay_payouts_enabled boolean not null default false,
  add column if not exists razorpay_connected_at timestamptz;

create table if not exists razorpay_payments (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  invoice_id uuid references invoices(id) on delete cascade,
  razorpay_order_id text not null,
  razorpay_payment_id text,
  razorpay_signature text,
  amount numeric(14,2) not null,
  currency text not null default 'INR',
  status text not null default 'created' check (status in ('created','authorized','captured','failed','refunded')),
  method text,
  email text,
  contact text,
  raw jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, razorpay_order_id)
);

create index if not exists razorpay_payments_invoice_idx on razorpay_payments (tenant_id, invoice_id);
create index if not exists razorpay_payments_status_idx on razorpay_payments (tenant_id, status);

alter table razorpay_payments enable row level security;
drop policy if exists "razorpay_payments_all" on razorpay_payments;
create policy "razorpay_payments_all" on razorpay_payments
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create or replace function razorpay_payments_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists razorpay_payments_updated_at on razorpay_payments;
create trigger razorpay_payments_updated_at before update on razorpay_payments
  for each row execute function razorpay_payments_touch_updated_at();
