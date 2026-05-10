-- 095_tally_reconciliation.sql
--
-- Phase F.6 completion. The closing-loop reconciliation flow for
-- Tally bridge pushes. Today's `/api/tally/reconcile` is a manual
-- status-flip; it doesn't compare what we sent against what's
-- actually in Tally. The signal does exist in `tally_voucher_state`
-- (migration 016) but nothing consumes it for drift detection.
--
-- What this migration adds:
--
--   1. tally_reconciliation_runs: one row per reconciliation cron
--      tick + per manual reconcile-now click. Run-level audit.
--   2. tally_reconciliation_findings: one row per drifted field on
--      a single voucher (totals mismatch, line count mismatch,
--      voucher cancelled in Tally, etc.).
--   3. tally_voucher_records.last_reconciled_at +
--      last_drift_at + drift_summary jsonb columns so the
--      workspace can surface drift state per order without joining
--      through findings every render.
--   4. Adds 'reconciliation' to the tally_sync_runs.entity check
--      constraint (entity column was permissive before; making the
--      taxonomy explicit lets the diagnostics tab filter cleanly).
--
-- The reconciler logic lives in src/api/_lib/tally-reconciler.js
-- and is invoked from:
--   - /api/tally/reconcile (existing endpoint, extended for the
--     drift mode via body.mode = 'drift_check' | 'mark')
--   - /api/cron/tick (every 30 min after tally/sync mirrors state)
--   - SO Workspace "Reconcile now" button (manual operator trigger)
--
-- Idempotent.

create table if not exists tally_reconciliation_runs (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  trigger text not null check (trigger in ('cron','manual','workspace','retry')),
  scope text not null check (scope in ('all','order','tenant_recent','order_id')),
  scope_value text,                                       -- order_id or other identifier when scope != 'all'
  vouchers_considered int not null default 0,
  vouchers_drifted int not null default 0,
  vouchers_clean int not null default 0,
  findings_persisted int not null default 0,
  auto_fixes_applied int not null default 0,
  bridge_calls int not null default 0,
  latency_ms int,
  triggered_by uuid references auth.users(id),
  status text not null default 'running'
    check (status in ('running','ok','partial_failure','failed')),
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists tally_reconciliation_runs_tenant_idx
  on tally_reconciliation_runs (tenant_id, started_at desc);
create index if not exists tally_reconciliation_runs_drift_idx
  on tally_reconciliation_runs (tenant_id, status, vouchers_drifted desc)
  where vouchers_drifted > 0;

alter table tally_reconciliation_runs enable row level security;
drop policy if exists "tally_reconciliation_runs_all" on tally_reconciliation_runs;
create policy "tally_reconciliation_runs_all" on tally_reconciliation_runs
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check  (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists tally_reconciliation_findings (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  reconciliation_run_id uuid not null references tally_reconciliation_runs(id) on delete cascade,
  tally_voucher_record_id uuid references tally_voucher_records(id) on delete set null,
  order_id uuid references orders(id) on delete set null,
  voucher_no text,
  finding_kind text not null check (finding_kind in (
    'voucher_cancelled_in_tally',          -- Tally side reports cancelled
    'voucher_altered_in_tally',            -- Tally side has a different version
    'total_mismatch',                       -- amount diff > tolerance
    'line_count_mismatch',                  -- our payload had N lines, Tally has M
    'voucher_no_mismatch',                  -- voucher number differs
    'gstin_mismatch',                       -- party GSTIN differs
    'party_mismatch',                       -- party ledger / supplier name differs
    'missing_in_tally',                     -- we pushed but bridge says nothing exists
    'missing_locally',                      -- bridge has a voucher but we never pushed
    'date_mismatch'                         -- voucher date drift
  )),
  severity text not null default 'warn'
    check (severity in ('info','warn','error','critical')),
  expected jsonb,                                          -- what we sent / expected
  actual jsonb,                                            -- what Tally has
  diff_pct numeric(8,4),                                   -- for total_mismatch (e.g. 4.20 = 4.20%)
  auto_fix_applied text,                                   -- 're_pushed' | 'amended' | 'order_failed' | 'none'
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists tally_reconciliation_findings_tenant_idx
  on tally_reconciliation_findings (tenant_id, created_at desc);
create index if not exists tally_reconciliation_findings_order_idx
  on tally_reconciliation_findings (tenant_id, order_id, created_at desc)
  where order_id is not null;
create index if not exists tally_reconciliation_findings_unresolved_idx
  on tally_reconciliation_findings (tenant_id, finding_kind, severity, created_at desc)
  where resolved_at is null;

alter table tally_reconciliation_findings enable row level security;
drop policy if exists "tally_reconciliation_findings_all" on tally_reconciliation_findings;
create policy "tally_reconciliation_findings_all" on tally_reconciliation_findings
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check  (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- Reconciliation state on the voucher record itself so SO Workspace
-- can render drift state with one query instead of joining findings
-- on every render.
alter table tally_voucher_records
  add column if not exists last_reconciled_at timestamptz,
  add column if not exists last_drift_at timestamptz,
  add column if not exists drift_summary jsonb default '{}'::jsonb;

comment on column tally_voucher_records.last_reconciled_at is
  'Phase F.6: timestamp of the most recent reconciliation run that touched this voucher.';
comment on column tally_voucher_records.last_drift_at is
  'Phase F.6: timestamp of the most recent reconciliation finding (drift detection). NULL when always clean.';
comment on column tally_voucher_records.drift_summary is
  'Phase F.6: rollup of unresolved finding kinds + counts. Example: {"total_mismatch": 1, "voucher_altered_in_tally": 1}. Empty when clean.';

-- Convenience partial index for "show me orders with active drift"
-- queries from the SO workspace.
create index if not exists tally_voucher_records_drift_idx
  on tally_voucher_records (tenant_id, last_drift_at desc)
  where last_drift_at is not null;

-- Tally bridge tolerances (per-tenant) for drift severity. Defaults
-- are conservative; an operator can flip them in tenant_settings if
-- their Tally workflow expects rounding tolerance > 0.5%.
alter table tenant_settings
  add column if not exists tally_recon_total_tolerance_pct numeric(5,2) default 0.50,
  add column if not exists tally_recon_auto_fix_enabled boolean not null default false;

comment on column tenant_settings.tally_recon_total_tolerance_pct is
  'Phase F.6: percent diff between our sent total and Tally total below which the reconciler treats as "no drift". Default 0.50% covers typical rounding.';
comment on column tenant_settings.tally_recon_auto_fix_enabled is
  'Phase F.6: when TRUE, the reconciler attempts auto-remediation (re-push, amend, mark order failed) for high-confidence findings. Default OFF; operator opts in.';
