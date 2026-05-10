-- 097_tally_drift_addon.sql
--
-- Bet 5: Productize Phase F.6 (Tally drift reconciliation, shipped
-- in migration 095) as a paid SKU.
--
-- Adds:
--   - tenant_settings flags to gate the add-on per tenant
--   - tally_drift_billing_meter table to record per-run usage that
--     gets drained to Stripe meters / Razorpay add-ons by a cron
--
-- Pricing model (per docs/STRATEGIC_BET_05_tally_drift_paid_sku.md):
--   - Starter:   Rs 2,000 / mo flat + Rs 1.50 / SO over 200/mo
--   - Growth:    Free through 2026-12-31, then Rs 3,500 / mo flat +
--                Rs 1.50 / SO over 1000/mo
--   - Enterprise: Bundled (no add-on row needed)
--
-- The reconciler engine itself (Phase F.6) is unchanged. This
-- migration adds the gating + billing scaffolding.
--
-- Idempotent.

alter table tenant_settings
  add column if not exists tally_drift_addon_enabled boolean not null default false,
  add column if not exists tally_drift_addon_started_at timestamptz,
  add column if not exists tally_drift_addon_billing_plan text,
  add column if not exists tally_drift_addon_stripe_subscription_id text,
  add column if not exists tally_drift_addon_razorpay_subscription_id text;

-- Drop / recreate the plan-name CHECK so the migration is fully
-- idempotent against re-runs that change the enum.
alter table tenant_settings
  drop constraint if exists tenant_settings_tally_drift_addon_billing_plan_check;
alter table tenant_settings
  add constraint tenant_settings_tally_drift_addon_billing_plan_check
  check (tally_drift_addon_billing_plan is null or tally_drift_addon_billing_plan in (
    'starter', 'growth', 'enterprise', 'trial'
  ));

comment on column tenant_settings.tally_drift_addon_enabled is
  'Bet 5: when TRUE, the Tally drift reconciliation cron drainer + manual drift_check button are enabled for this tenant. Gated billing line on Stripe / Razorpay.';
comment on column tenant_settings.tally_drift_addon_started_at is
  'Bet 5: timestamp the operator first flipped the add-on on. Used for the trial-window calc and the monthly drift report header.';
comment on column tenant_settings.tally_drift_addon_billing_plan is
  'Bet 5: which billing plan the operator picked. ''starter''/''growth''/''enterprise''/''trial''. ''trial'' = free during the Growth-tier land-grab (through 2026-12-31).';

-- Per-run usage meter. One row inserted by tally-reconciler.js after
-- every successful driftCheck run. A cron at /api/cron/drift-meter
-- drains unreported rows to Stripe meter_events + Razorpay usage
-- billing.
create table if not exists tally_drift_billing_meter (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  reconciliation_run_id uuid references tally_reconciliation_runs(id) on delete set null,
  vouchers_reconciled int not null default 0,
  drift_caught_value_inr numeric(14, 2) not null default 0,
  reported_to_stripe_at timestamptz,
  reported_to_razorpay_at timestamptz,
  stripe_meter_event_id text,
  razorpay_addon_id text,
  created_at timestamptz not null default now()
);

create index if not exists tally_drift_billing_meter_tenant_idx
  on tally_drift_billing_meter (tenant_id, created_at desc);

-- Partial index for the cron drainer: only rows that haven't been
-- reported to either provider yet.
create index if not exists tally_drift_billing_meter_unreported_idx
  on tally_drift_billing_meter (tenant_id, created_at desc)
  where reported_to_stripe_at is null and reported_to_razorpay_at is null;

alter table tally_drift_billing_meter enable row level security;
drop policy if exists "tally_drift_billing_meter_all" on tally_drift_billing_meter;
create policy "tally_drift_billing_meter_all" on tally_drift_billing_meter
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check  (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

comment on column tally_drift_billing_meter.vouchers_reconciled is
  'Bet 5: number of vouchers walked in this reconciliation run. The billing primitive (one meter event per voucher reconciled).';
comment on column tally_drift_billing_meter.drift_caught_value_inr is
  'Bet 5: marketing/sales-loaded total INR value across all findings in this run. For total_mismatch use abs(diff); for voucher_cancelled_in_tally use the full voucher total. Feeds the monthly drift report headline.';
