-- 034_winloss_analytics.sql
-- Win/loss analytics (Soff parity).
--
-- We store a daily rollup so dashboard reads are O(window-size)
-- regardless of order volume. The cron at /api/analytics/refresh
-- materialises this nightly; the live endpoint can also recompute
-- on demand for the current day.
--
-- Aggregation grain: per (tenant, day, rep_id, customer_tier).
-- That gives us enough granularity to slice by rep, by tier, and
-- to compute median response time without re-scanning the audit
-- table on every request.
-- Idempotent.

create table if not exists analytics_winloss_daily (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  day date not null,
  rep_id uuid,                                  -- order created_by, may be null
  customer_tier text,                           -- strategic/preferred/standard/watchlist
  quotes_created int not null default 0,
  quotes_won int not null default 0,
  quotes_lost int not null default 0,
  quotes_expired int not null default 0,
  total_won_value numeric(14,2) not null default 0,
  total_lost_value numeric(14,2) not null default 0,
  median_response_minutes int,                  -- create -> first_decision
  lost_reasons jsonb default '{}'::jsonb,       -- { reason_id: count }
  unique (tenant_id, day, rep_id, customer_tier)
);

create index if not exists analytics_winloss_tenant_idx
  on analytics_winloss_daily (tenant_id, day desc);
create index if not exists analytics_winloss_rep_idx
  on analytics_winloss_daily (tenant_id, rep_id, day desc);

alter table analytics_winloss_daily enable row level security;
drop policy if exists "analytics_winloss_select" on analytics_winloss_daily;
create policy "analytics_winloss_select" on analytics_winloss_daily
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- Top-customer rollup. One row per (tenant, customer, month).
create table if not exists analytics_customer_monthly (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid references customers(id) on delete cascade,
  month date not null,
  orders_count int not null default 0,
  won_count int not null default 0,
  won_value numeric(14,2) not null default 0,
  win_rate numeric(5,2),                        -- 0.00..100.00
  avg_response_minutes int,
  unique (tenant_id, customer_id, month)
);

create index if not exists analytics_customer_monthly_tenant_idx
  on analytics_customer_monthly (tenant_id, month desc, won_value desc);

alter table analytics_customer_monthly enable row level security;
drop policy if exists "analytics_customer_monthly_select" on analytics_customer_monthly;
create policy "analytics_customer_monthly_select" on analytics_customer_monthly
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
