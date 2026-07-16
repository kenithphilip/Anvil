-- 174_failure_events.sql
--
-- Spare Intelligence STEP 4a: a FAILURE / REPLACEMENT event stream -- the first
-- greenfield reliability-layer table (T2 in docs/SPARE_INTELLIGENCE_COMPAT.md).
-- Recon confirmed nothing existing records events at the (part x asset-instance x
-- event-date) grain: equipment_installed_parts is a current-state snapshot (single
-- last_replaced_at scalar, delete+reinsert on save), service_visits is customer/
-- location free-text, car_reports/closure_reports are order-quality CAPA. So this
-- is genuinely new, not a duplicate.
--
-- ADDITIVE + isolated: a brand-new table with its own RLS. Nothing reads or writes
-- it yet outside the new /api/failure_events endpoint + the equipment screen, and
-- it deliberately does NOT touch the planning engine -- feeding this stream into
-- demand history (cron/inventory-planning-weekly.js buildHistory) + MTBF is a
-- separate, reviewed step (4b), because that is the one path that could affect the
-- existing forecast/safety-stock output.
--
-- Keying (post-171/173): equipment_id -> equipment_hierarchy (the asset instance,
-- any asset_class now that 173 generalized it); item_id -> item_master, auto-
-- resolved from part_no by REUSING the shared trigger function
-- set_item_id_from_part_no() defined in 171 (tenant-scoped, case-insensitive,
-- oldest-wins); part_no text kept as the denormalized display/fallback. item_id is
-- nullable (unmatched parts stay NULL), matching 171/172/173.
--
-- created_by is a bare uuid with NO auth.users FK on purpose (a hard FK breaks
-- service-role inserts -- see 159_spare_matrix.sql).
--
-- Idempotent (create table if not exists / create index if not exists / drop
-- trigger if exists / drop policy if exists). Applied manually -- merged != applied.

create table if not exists failure_events (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  equipment_id uuid not null references equipment_hierarchy(id) on delete cascade,
  item_id uuid references item_master(id) on delete set null,
  part_no text,
  failed_at timestamptz not null default now(),
  event_type text not null default 'breakdown',   -- breakdown | pm | inspection | replacement
  failure_mode text,                               -- freeform for now (FMECA taxonomy is a later step)
  replaced_qty integer,                            -- consumption signal for the future demand hook (4b)
  downtime_hours numeric,                          -- reliability signal for future MTBF (4b)
  notes text,
  created_by uuid,                                 -- bare uuid (no auth.users FK); store ctx.user.id
  created_at timestamptz not null default now()
);

create index if not exists failure_events_equipment_idx on failure_events (tenant_id, equipment_id);
create index if not exists failure_events_item_idx      on failure_events (tenant_id, item_id);
create index if not exists failure_events_part_idx      on failure_events (tenant_id, part_no);
create index if not exists failure_events_failed_at_idx on failure_events (tenant_id, failed_at);

-- Auto-resolve item_id from part_no using the SHARED resolver from 171 (generic
-- over any table exposing tenant_id/part_no/item_id -- no new function needed).
drop trigger if exists failure_events_set_item_id on failure_events;
create trigger failure_events_set_item_id before insert or update on failure_events
  for each row execute function set_item_id_from_part_no();

-- RLS: modern tenant-scoped pattern (copy of 159_spare_matrix.sql:112-119).
alter table failure_events enable row level security;
drop policy if exists failure_events_select on failure_events;
create policy failure_events_select on failure_events
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists failure_events_write on failure_events;
create policy failure_events_write on failure_events
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

comment on table failure_events is
  'Reliability step 4a: in-field failure / replacement event stream at (part x asset-instance x event-date) grain. equipment_id -> equipment_hierarchy instance; item_id auto-resolved from part_no via set_item_id_from_part_no() (171). Not yet wired into demand/MTBF (step 4b). See docs/SPARE_INTELLIGENCE_COMPAT.md.';
