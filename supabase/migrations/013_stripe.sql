-- 013_stripe.sql
-- Stripe Connect Express integration. Each tenant has its own
-- connected Stripe account; Anvil is the platform. Customers pay the
-- tenant directly; Anvil takes an optional platform fee per invoice
-- (default 0%, configurable per tenant).
--
-- All schema additions are namespaced to `stripe_*` so they do not
-- collide with future Razorpay (India) integration.
-- Idempotent.

-- tenant_settings is the canonical place for per-tenant config. We
-- create it if missing; existing migrations may have created a
-- partial row already.
create table if not exists tenant_settings (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  invoice_format text default '{prefix}-{number:04}',
  invoice_prefix text default 'INV',
  -- Stripe Connect
  stripe_account_id text,
  stripe_charges_enabled boolean not null default false,
  stripe_payouts_enabled boolean not null default false,
  stripe_platform_fee_bps integer not null default 0,           -- basis points (100 = 1%)
  stripe_onboarded_at timestamptz,
  -- Defaults set on every created invoice.
  default_payment_terms text default 'Net 30',
  default_currency text default 'USD',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tenant_settings_stripe_idx
  on tenant_settings (stripe_account_id) where stripe_account_id is not null;

alter table tenant_settings enable row level security;
drop policy if exists "tenant_settings_select" on tenant_settings;
drop policy if exists "tenant_settings_modify" on tenant_settings;
create policy "tenant_settings_select" on tenant_settings
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
create policy "tenant_settings_modify" on tenant_settings
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create or replace function tenant_settings_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists tenant_settings_updated_at on tenant_settings;
create trigger tenant_settings_updated_at before update on tenant_settings
  for each row execute function tenant_settings_touch_updated_at();
