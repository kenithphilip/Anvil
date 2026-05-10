-- 102_aa_treds_sandbox.sql
--
-- Bet 6: AA + TReDS receivables loop. Sandbox + DB layer.
--
-- This migration lands the schema + tenant_settings columns that
-- the AA (Account Aggregator) consent + TReDS (Trade Receivables
-- Discounting System) factoring workflow needs. Production
-- activation is gated on partner onboarding:
--
--   - Setu FIU / Sahamati certification: ~6-8 weeks
--   - M1xchange channel-partner agreement: ~4-6 weeks
--   - DPDP / counsel review of consent texts: ~2 weeks
--
-- Until those land, the new endpoints run in SANDBOX mode and
-- return mocked consent_handles + auction outcomes. Tenants who
-- haven't set aa_provider / treds_provider on tenant_settings get
-- 'none' (default) and the buttons are hidden in the UI.
--
-- Per docs/STRATEGIC_BET_06_aa_treds_receivables.md.
--
-- Idempotent.

-- 1. tenant_settings: per-tenant partner config + thresholds.

alter table tenant_settings
  add column if not exists aa_provider text not null default 'none',
  add column if not exists aa_client_id_enc bytea,
  add column if not exists aa_client_secret_enc bytea,
  add column if not exists aa_creds_iv bytea,
  add column if not exists aa_fiu_partner_id text,
  add column if not exists treds_provider text not null default 'none',
  add column if not exists treds_member_id text,
  add column if not exists treds_api_key_enc bytea,
  add column if not exists treds_api_secret_enc bytea,
  add column if not exists treds_creds_iv bytea,
  add column if not exists treds_min_invoice_inr numeric(14, 2) not null default 100000,
  add column if not exists treds_auto_offer_dpd smallint not null default 15;

alter table tenant_settings
  drop constraint if exists tenant_settings_aa_provider_check;
alter table tenant_settings
  add constraint tenant_settings_aa_provider_check
  check (aa_provider in ('setu', 'finvu', 'sandbox', 'none'));

alter table tenant_settings
  drop constraint if exists tenant_settings_treds_provider_check;
alter table tenant_settings
  add constraint tenant_settings_treds_provider_check
  check (treds_provider in ('m1xchange', 'rxil', 'invoicemart', 'sandbox', 'none'));

-- 2. aa_consents: one row per AA consent grant. Mirrors Setu
-- Embed's consent-handle lifecycle (pending -> active -> revoked /
-- expired). RLS-scoped on tenant_id.

create table if not exists aa_consents (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  invoice_id uuid references invoices(id) on delete cascade,
  party_kind text not null check (party_kind in ('supplier', 'buyer')),
  consent_handle text not null,
  consent_id text,
  status text not null check (status in
    ('pending', 'active', 'revoked', 'expired', 'rejected', 'failed', 'sandbox_active')),
  fi_types text[] not null default '{}'::text[],
  purpose_code text not null,
  expires_at timestamptz,
  granted_at timestamptz,
  revoked_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  is_sandbox boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, consent_handle)
);

create index if not exists aa_consents_invoice_idx
  on aa_consents (tenant_id, invoice_id);
create index if not exists aa_consents_status_idx
  on aa_consents (tenant_id, status);

alter table aa_consents enable row level security;
drop policy if exists "aa_consents_select" on aa_consents;
drop policy if exists "aa_consents_modify" on aa_consents;
create policy "aa_consents_select" on aa_consents
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
create policy "aa_consents_modify" on aa_consents
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- 3. treds_offers: one row per invoice submitted to a TReDS
-- platform. auction_status walks submitted -> buyer_pending ->
-- live -> (won | no_bid | rejected | withdrawn | expired).

create table if not exists treds_offers (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  invoice_id uuid not null references invoices(id) on delete cascade,
  treds_platform text not null check (treds_platform in
    ('m1xchange', 'rxil', 'invoicemart', 'sandbox')),
  external_factoring_id text not null,
  buyer_gstin text not null,
  amount_inr numeric(14, 2) not null,
  due_date date,
  auction_status text not null check (auction_status in
    ('submitted', 'buyer_pending', 'live', 'won', 'no_bid', 'rejected', 'withdrawn', 'expired')),
  best_rate_bps int,
  best_financier_name text,
  net_amount_inr numeric(14, 2),
  is_sandbox boolean not null default false,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, treds_platform, external_factoring_id)
);

create index if not exists treds_offers_invoice_idx
  on treds_offers (tenant_id, invoice_id);
create index if not exists treds_offers_status_idx
  on treds_offers (tenant_id, auction_status);

alter table treds_offers enable row level security;
drop policy if exists "treds_offers_select" on treds_offers;
drop policy if exists "treds_offers_modify" on treds_offers;
create policy "treds_offers_select" on treds_offers
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
create policy "treds_offers_modify" on treds_offers
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create or replace function treds_offers_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists treds_offers_updated_at on treds_offers;
create trigger treds_offers_updated_at before update on treds_offers
  for each row execute function treds_offers_touch_updated_at();

-- 4. treds_discounts: one row per accepted bid. The financier
-- disburses to the supplier on T+1; the original buyer then owes
-- the financier, not the supplier, on the original due date.

create table if not exists treds_discounts (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  offer_id uuid not null references treds_offers(id) on delete cascade,
  invoice_id uuid not null references invoices(id) on delete cascade,
  financier_name text not null,
  rate_bps int not null,
  amount_inr numeric(14, 2) not null,
  net_to_supplier_inr numeric(14, 2) not null,
  platform_fee_inr numeric(14, 2),
  settlement_at timestamptz,
  status text not null check (status in ('disbursed', 'settled', 'failed', 'reversed')),
  utr text,
  is_sandbox boolean not null default false,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, offer_id)
);

create index if not exists treds_discounts_invoice_idx
  on treds_discounts (tenant_id, invoice_id);

alter table treds_discounts enable row level security;
drop policy if exists "treds_discounts_select" on treds_discounts;
drop policy if exists "treds_discounts_modify" on treds_discounts;
create policy "treds_discounts_select" on treds_discounts
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
create policy "treds_discounts_modify" on treds_discounts
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- 5. treds_eligible_buyers: nightly cache of buyer GSTINs that are
-- onboarded to TReDS. Refreshed by /api/treds/eligible_buyers. The
-- per-tenant cache lets the UI cheaply gate the "Discount via TReDS"
-- button on whether the invoice's buyer is even eligible.

create table if not exists treds_eligible_buyers (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  treds_platform text not null,
  buyer_gstin text not null,
  buyer_name text,
  active boolean not null default true,
  last_refreshed_at timestamptz not null default now(),
  raw jsonb not null default '{}'::jsonb,
  unique (tenant_id, treds_platform, buyer_gstin)
);

create index if not exists treds_eligible_buyers_gstin_idx
  on treds_eligible_buyers (tenant_id, buyer_gstin);

alter table treds_eligible_buyers enable row level security;
drop policy if exists "treds_eligible_buyers_select" on treds_eligible_buyers;
drop policy if exists "treds_eligible_buyers_modify" on treds_eligible_buyers;
create policy "treds_eligible_buyers_select" on treds_eligible_buyers
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
create policy "treds_eligible_buyers_modify" on treds_eligible_buyers
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- 6. Invoice flag: a stamped invoice that was discounted via
-- TReDS flips this column (NOT `status` to `paid`, since the
-- buyer still owes the financier the gross amount on the original
-- due date).

alter table invoices
  add column if not exists discounted_via_treds_at timestamptz;

-- 7. Comments for documentation.

comment on table aa_consents is
  'Bet 6: Account Aggregator consent grants. Sandbox rows carry is_sandbox=true so we can keep prod + dev consents in the same table without confusing real audits.';
comment on table treds_offers is
  'Bet 6: TReDS factoring submissions. One row per invoice per platform. Status walks submitted -> live -> (won | no_bid | rejected).';
comment on table treds_discounts is
  'Bet 6: accepted TReDS bids. Each row represents a financier disbursement to the supplier; the original buyer then owes the financier, not the supplier, on the original due date.';
comment on column invoices.discounted_via_treds_at is
  'Bet 6: stamped when the invoice was factored via TReDS. The invoice.status stays at its existing state (e.g. sent / overdue) because the buyer still owes the financier the gross amount on the original due date.';
