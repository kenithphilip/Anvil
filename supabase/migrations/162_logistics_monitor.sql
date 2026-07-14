-- 162_logistics_monitor.sql
--
-- Logistics Operations P1: the configuration-driven monitor + SLA/escalation
-- spine (design: docs/LOGISTICS_OPS_DESIGN.md). A tenant defines monitor rules
-- (rule_kind + thresholds + severity + who to escalate to); a per-tenant cron
-- runs the detector over the sources that already exist (source_pos ack /
-- ready-date / work-order delays via src/api/delays/scan.js), persists
-- idempotent, fingerprint-deduped `logistics_exceptions` (each carrying its own
-- SLA clock), marks SLA breaches, and fans alerts to the bell + email through
-- the existing notification rails. The pure detector is
-- src/api/_lib/logistics/monitor.js; defaults live in code (DEFAULT_MONITOR_RULES)
-- so an un-configured tenant still gets the playbook.
--
-- Feature-flagged OFF by default (tenant_settings.logistics_monitor_enabled) so
-- there is zero behaviour change until a tenant opts in. Additive + idempotent;
-- applied manually via the seed-apply workflow.

-- 1. Tenant monitor rules (the config that replaces hardcoded thresholds).
create table if not exists logistics_monitor_rules (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  rule_kind text not null,                          -- po_source_country, po_local_supplier, work_order_manufacturing, ready_date_missing, ready_date_orphan, ... (extensible)
  label text,
  active boolean not null default true,
  severity text not null default 'warn'
    check (severity in ('info', 'warn', 'bad', 'critical')),
  threshold_days numeric,                            -- primary SLA threshold in days (feeds delays/scan slas override)
  sla_hours numeric,                                 -- optional SLA-clock target (hours from detection) for the opened exception
  params jsonb not null default '{}'::jsonb,         -- extra per-kind knobs
  escalate_roles text[] not null default '{admin}'::text[],  -- roles notified on high-severity + SLA breach
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists logistics_monitor_rules_tenant_active_idx
  on logistics_monitor_rules (tenant_id, active);
-- One active rule per (tenant, kind); re-config updates in place.
create unique index if not exists logistics_monitor_rules_tenant_kind_uq
  on logistics_monitor_rules (tenant_id, rule_kind);

alter table logistics_monitor_rules enable row level security;
drop policy if exists "logistics_monitor_rules_all" on logistics_monitor_rules;
create policy "logistics_monitor_rules_all" on logistics_monitor_rules
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- 2. Detector output + SLA clock (one row per open issue). Mirrors the
--    inventory_exceptions shape (status lifecycle + detail.fingerprint dedup)
--    and folds the SLA clock onto the row.
create table if not exists logistics_exceptions (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  rule_kind text not null,
  severity text not null default 'warn'
    check (severity in ('info', 'warn', 'bad', 'critical')),
  object_type text,                                 -- source_po | shipment | internal_so | order
  object_id uuid,
  ref_label text,
  owner_user_id uuid references auth.users(id),      -- responsible party (nullable; seed for the future task/assignment model)
  status text not null default 'open'
    check (status in ('open', 'acknowledged', 'resolved', 'suppressed')),
  detail jsonb not null default '{}'::jsonb,         -- { fingerprint, elapsed_days, sla_days, detail_text, notified:{...} }
  first_response_at timestamptz,                     -- first ack/response captured
  sla_target_at timestamptz,                         -- when the SLA clock breaches
  breached_at timestamptz,                           -- set when the monitor observes the target passed
  resolved_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists logistics_exceptions_tenant_status_idx
  on logistics_exceptions (tenant_id, status);
create index if not exists logistics_exceptions_tenant_kind_status_idx
  on logistics_exceptions (tenant_id, rule_kind, status);

alter table logistics_exceptions enable row level security;
drop policy if exists "logistics_exceptions_all" on logistics_exceptions;
create policy "logistics_exceptions_all" on logistics_exceptions
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- 3. Per-tenant feature flag (OFF by default; the cron only walks opted-in
--    tenants, exactly like inventory_planning_enabled).
alter table tenant_settings
  add column if not exists logistics_monitor_enabled boolean not null default false;
