-- 037_network_sourcing.sql
-- Phase 5.6 (Avent unique): in-network back-to-back sourcing.
-- When tenant A is short on a SKU, Anvil checks tenant B's
-- explicitly-published listings and proposes a back-to-back deal.
--
-- Privacy model: tenants opt in. Shared data is intentionally
-- sparse (SKU, available qty, lead time, currency) and never
-- includes customer identity, end-buyer pricing, or revenue.
-- Idempotent.

-- 1. Per-tenant opt-in flag plus optional public name. Adding to
--    tenant_settings rather than a new table because it's tied to
--    the existing settings UX.
alter table tenant_settings
  add column if not exists network_share boolean not null default false,
  add column if not exists network_display_name text,
  add column if not exists network_min_lead_days integer,
  add column if not exists network_contact_email text;

-- 2. Stock that a tenant chooses to publish to the Anvil network.
--    Refreshed by an opt-in cron OR populated manually via the
--    Admin Center's "Network sourcing" panel. Each row is one
--    SKU/location combo.
create table if not exists network_listings (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  sku text not null,
  description text,
  uom text,
  -- Approximate stock; we round to keep this from leaking precise
  -- inventory levels. The matcher only needs "enough or not enough".
  available_qty numeric(14,3),
  -- Self-reported lead time when the listed qty isn't enough.
  -- Buyers see this so they can plan back-to-back delivery.
  lead_time_days integer,
  currency text default 'USD',
  -- Approximate transfer price the listing tenant is willing to
  -- accept on a back-to-back. Buyer's margin = end-buyer price
  -- minus this transfer price minus freight/duties.
  transfer_unit_price numeric(14,2),
  notes text,
  active boolean not null default true,
  source text default 'manual'                   -- manual | erp_sync | inventory_mirror
    check (source in ('manual', 'erp_sync', 'inventory_mirror')),
  source_ref text,
  refreshed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, sku)
);

create index if not exists network_listings_sku_idx on network_listings (sku);
create index if not exists network_listings_tenant_idx on network_listings (tenant_id, active);

alter table network_listings enable row level security;

-- A listing is visible to any tenant with `network_share = true`
-- on their own settings (i.e. you can only browse the network if
-- you also publish to it). This prevents free-riders.
drop policy if exists "network_listings_select_optin" on network_listings;
create policy "network_listings_select_optin" on network_listings
  for select using (
    -- Always visible to the listing tenant.
    tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid
    or exists (
      select 1 from tenant_settings ts
      where ts.tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid
        and ts.network_share = true
    )
  );

-- Only the listing tenant can mutate.
drop policy if exists "network_listings_mutate_owner" on network_listings;
create policy "network_listings_mutate_owner" on network_listings
  for all using (
    tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid
  ) with check (
    tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid
  );

create or replace function network_listings_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists network_listings_updated_at on network_listings;
create trigger network_listings_updated_at before update on network_listings
  for each row execute function network_listings_touch_updated_at();

-- 3. Audit log of which tenant searched for what and which listings
--    they saw. Used for billing, anti-abuse, and analytics.
create table if not exists network_sourcing_queries (
  id uuid primary key default uuid_generate_v4(),
  -- The asking tenant.
  tenant_id uuid not null references tenants(id) on delete cascade,
  -- The originating order (optional; queries can be exploratory).
  order_id uuid references orders(id) on delete set null,
  sku text not null,
  qty_needed numeric(14,3),
  needed_by date,
  -- How many distinct listings matched. We don't persist the full
  -- match list because individual listings are visible via the
  -- listings table on demand.
  match_count integer not null default 0,
  matched_tenant_ids uuid[] not null default '{}',
  resolved boolean not null default false,
  resolved_listing_id uuid references network_listings(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists network_queries_tenant_idx on network_sourcing_queries (tenant_id, created_at desc);
create index if not exists network_queries_order_idx on network_sourcing_queries (order_id);

alter table network_sourcing_queries enable row level security;
drop policy if exists "network_queries_owner" on network_sourcing_queries;
create policy "network_queries_owner" on network_sourcing_queries
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
