-- 008_einvoice_forecast_amc.sql
-- Closes the remaining JTBD-driven features:
--   1. e-Invoice tracking (Indian GST IRN/QR persistence + status)
--   2. Forecasting snapshots segmented by territory + customer_type
--   3. AMC schedule + auto-generation of preventive visits
--   4. Missing indexes on hot lookup paths flagged by audit
--   5. RLS fix on redaction_rules so tenant nulls can be inserted by admins
--
-- Idempotent (create-if-not-exists / on conflict do nothing).

-- ───────────────────────────────────────────────────────────────────────────
-- A. e-Invoice (GSTN integration)
-- One row per generated IRN. Decoupled from orders so a single order can
-- have multiple invoices if it ships in tranches.
-- ───────────────────────────────────────────────────────────────────────────

do $$ begin
  if not exists (select 1 from pg_type where typname = 'einvoice_status') then
    create type einvoice_status as enum (
      'DRAFT',           -- composed locally, not yet sent to GSTN
      'PENDING_GSTN',    -- request sent, waiting on response
      'GENERATED',       -- IRN + QR returned by GSTN
      'CANCELLED',       -- cancelled within 24h window per GSTN policy
      'REJECTED'         -- GSTN rejected (validation error)
    );
  end if;
end $$;

create table if not exists einvoices (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id uuid references orders(id) on delete set null,
  shipment_id uuid references shipments(id) on delete set null,
  invoice_number text not null,
  invoice_date date not null,
  customer_id uuid references customers(id) on delete set null,
  customer_gstin text,
  seller_gstin text,
  taxable_value numeric(18, 2),
  total_value numeric(18, 2),
  currency text default 'INR',
  status einvoice_status not null default 'DRAFT',
  irn text,                          -- 64-char IRN returned by GSTN
  ack_no text,                       -- acknowledgement number
  ack_date timestamptz,
  qr_code_b64 text,                  -- signed QR payload, base64
  signed_invoice_b64 text,           -- full signed invoice payload
  ewb_no text,                       -- e-way bill number when applicable
  ewb_valid_upto timestamptz,
  cancel_reason text,
  cancel_remarks text,
  cancelled_at timestamptz,
  payload jsonb default '{}'::jsonb, -- the full request body sent to GSTN
  response jsonb default '{}'::jsonb,-- the raw GSTN response
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, invoice_number)
);

create index if not exists einvoices_status_idx on einvoices (tenant_id, status);
create index if not exists einvoices_order_idx on einvoices (tenant_id, order_id);
create index if not exists einvoices_irn_idx on einvoices (irn);

-- ───────────────────────────────────────────────────────────────────────────
-- B. Forecasting snapshots
-- Source: JTBD "Forecasting and Segmentation by territory, customer type
-- (Auto OEM, Line Builder, Tier 1), and value/effort". Snapshots are
-- recomputed daily by /api/cron/forecast and store the rollup so the
-- dashboard does not have to reaggregate.
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists forecast_snapshots (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  as_of date not null,
  segment_dimension text not null,    -- 'territory' | 'customer_type' | 'order_mode' | 'overall'
  segment_value text not null,        -- e.g. 'IN-MH' for territory, 'AUTO_OEM' for type
  open_count int default 0,
  open_amount_inr numeric(18, 2) default 0,
  weighted_amount_inr numeric(18, 2) default 0,
  won_count int default 0,
  won_amount_inr numeric(18, 2) default 0,
  lost_count int default 0,
  lost_amount_inr numeric(18, 2) default 0,
  next_30_days_amount_inr numeric(18, 2) default 0,
  next_90_days_amount_inr numeric(18, 2) default 0,
  generated_at timestamptz not null default now(),
  unique (tenant_id, as_of, segment_dimension, segment_value)
);

create index if not exists forecast_dim_idx on forecast_snapshots (tenant_id, segment_dimension, as_of);

-- ───────────────────────────────────────────────────────────────────────────
-- C. AMC schedule + visit generation
-- Source: Services Object Model "Annual Maintenance Contract", JTBD
-- "Preventive Maintenance (PMC/AMC)". An AMC schedule is one row per
-- recurring visit slot derived from a contract of type AMC.
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists amc_schedules (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  contract_id uuid not null references contracts(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  customer_location_id uuid references customer_locations(id) on delete set null,
  visit_label text,                    -- 'Q1 PM', 'Annual checkup', 'Tip dresser audit'
  scheduled_date date not null,
  duration_days int default 1,
  visit_type text default 'PREVENTIVE' check (visit_type in ('PREVENTIVE','EMERGENCY','TRAINING','AUDIT')),
  status text not null default 'SCHEDULED' check (status in ('SCHEDULED','VISIT_CREATED','COMPLETED','SKIPPED','CANCELLED')),
  generated_visit_id uuid references service_visits(id) on delete set null,
  generated_at timestamptz,
  remarks text,
  created_at timestamptz not null default now()
);

create index if not exists amc_sched_contract_idx on amc_schedules (tenant_id, contract_id);
create index if not exists amc_sched_date_idx on amc_schedules (tenant_id, scheduled_date);
create index if not exists amc_sched_status_idx on amc_schedules (tenant_id, status);

-- ───────────────────────────────────────────────────────────────────────────
-- D. Missing indexes from audit findings
-- ───────────────────────────────────────────────────────────────────────────

create index if not exists contracts_customer_status_idx on contracts (tenant_id, customer_id, status);
create index if not exists contracts_type_idx on contracts (tenant_id, contract_type, status);
create index if not exists shipments_source_po_idx on shipments (tenant_id, source_po_id);
create index if not exists order_schedule_part_idx on order_schedule_lines (tenant_id, part_no);
create index if not exists einvoices_customer_idx on einvoices (tenant_id, customer_id);

-- ───────────────────────────────────────────────────────────────────────────
-- E. RLS for new tables
-- ───────────────────────────────────────────────────────────────────────────

-- Explicit per-table form so Supabase's static analyzer can
-- verify RLS is on for every table created above. Semantics:
-- tenant-scoped reads AND writes (no global pass-through).

alter table einvoices enable row level security;
drop policy if exists einvoices_select on einvoices;
create policy einvoices_select on einvoices
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists einvoices_write on einvoices;
create policy einvoices_write on einvoices
  for all using (tenant_id in (select current_tenant_ids()))
         with check (tenant_id in (select current_tenant_ids()));

alter table forecast_snapshots enable row level security;
drop policy if exists forecast_snapshots_select on forecast_snapshots;
create policy forecast_snapshots_select on forecast_snapshots
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists forecast_snapshots_write on forecast_snapshots;
create policy forecast_snapshots_write on forecast_snapshots
  for all using (tenant_id in (select current_tenant_ids()))
         with check (tenant_id in (select current_tenant_ids()));

alter table amc_schedules enable row level security;
drop policy if exists amc_schedules_select on amc_schedules;
create policy amc_schedules_select on amc_schedules
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists amc_schedules_write on amc_schedules;
create policy amc_schedules_write on amc_schedules
  for all using (tenant_id in (select current_tenant_ids()))
         with check (tenant_id in (select current_tenant_ids()));


-- ───────────────────────────────────────────────────────────────────────────
-- F. RLS fix: redaction_rules write policy was over-restrictive.
-- Allow admin role to manage global rules (tenant_id null) plus tenant rules.
-- ───────────────────────────────────────────────────────────────────────────

do $$
begin
  if to_regclass('public.redaction_rules') is not null then
    execute 'drop policy if exists redaction_rules_write on redaction_rules';
    execute 'create policy redaction_rules_write on redaction_rules for all using (tenant_id is null or tenant_id in (select current_tenant_ids())) with check (tenant_id is null or tenant_id in (select current_tenant_ids()))';
  end if;
end $$;
