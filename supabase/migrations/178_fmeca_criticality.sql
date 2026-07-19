-- 178_fmeca_criticality.sql
--
-- Spare Intelligence STEP 4c: a REAL FMECA (Failure Mode Effects & Criticality
-- Analysis) -- severity x occurrence x detection -> RPN -- addressing friction #6
-- (today's criticality_score is a sales/BOM/lead heuristic wearing an FMECA name).
-- See docs/FMECA_DESIGN.md.
--
-- Two additive tables + one dark flag. Does NOT touch the planning cron, quotes,
-- or forecast. Idempotent. Applied manually -- merged != applied.

-- 1. failure_mode_catalog -- the missing failure-mode taxonomy (failure_events
--    .failure_mode was freeform text until now). Modeled on lost_reason_taxonomy
--    (006): tenant_id NULLABLE (NULL = global default rows visible to all tenants).
create table if not exists failure_mode_catalog (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid references tenants(id) on delete cascade,   -- NULL = global default
  code text not null,
  label text not null,
  category text,                    -- wear | fracture | electrical | thermal | contamination | seizure | other
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique nulls not distinct (tenant_id, code)
);
create index if not exists failure_mode_catalog_tenant_idx on failure_mode_catalog (tenant_id);

alter table failure_mode_catalog enable row level security;
drop policy if exists failure_mode_catalog_select on failure_mode_catalog;
create policy failure_mode_catalog_select on failure_mode_catalog
  for select using (tenant_id is null or tenant_id in (select current_tenant_ids()));
drop policy if exists failure_mode_catalog_write on failure_mode_catalog;
create policy failure_mode_catalog_write on failure_mode_catalog
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

-- Starter GLOBAL mode catalog (tenant_id NULL). Tenants add their own.
insert into failure_mode_catalog (tenant_id, code, label, category) values
  (null, 'ELECTRODE_TIP_WEAR', 'Electrode / tip wear',       'wear'),
  (null, 'SHANK_FRACTURE',     'Shank fracture / crack',     'fracture'),
  (null, 'ARM_DEFORMATION',    'Gun arm deformation',        'wear'),
  (null, 'CABLE_FATIGUE',      'Cable / shunt fatigue',      'electrical'),
  (null, 'TRANSFORMER_FAULT',  'Weld transformer fault',     'electrical'),
  (null, 'TIMER_FAULT',        'Timer / controller fault',   'electrical'),
  (null, 'AIR_LEAK',           'Pneumatic / air leak',       'wear'),
  (null, 'BEARING_SEIZURE',    'Bearing seizure',            'seizure'),
  (null, 'OVERHEAT',           'Overheating / thermal',      'thermal'),
  (null, 'CONTAMINATION',      'Contamination / debris',     'contamination'),
  (null, 'CORROSION',          'Corrosion',                  'contamination'),
  (null, 'GENERIC_WEAR',       'General wear-out',           'wear'),
  (null, 'GENERIC_BREAKDOWN',  'Unclassified breakdown',     'other')
on conflict do nothing;

-- 2. fmeca_criticality -- FMECA records at (tenant_id, item_id, failure_mode_id).
--    Copies failure_events (174) conventions: uuid pk, tenant cascade, item_id FK
--    + denorm part_no (shared set_item_id_from_part_no trigger), created_by bare
--    uuid, RLS 159. rpn is a GENERATED column (S*O*D). Occurrence is auto-suggested
--    from failure_events; severity/detection are human-authored.
create table if not exists fmeca_criticality (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  item_id uuid references item_master(id) on delete set null,
  part_no text,
  failure_mode_id uuid not null references failure_mode_catalog(id) on delete cascade,
  asset_class text,                 -- optional: same part can carry a different criticality per class
  severity smallint check (severity between 1 and 10),
  occurrence smallint check (occurrence between 1 and 10),
  detection smallint check (detection between 1 and 10),
  rpn integer generated always as (severity * occurrence * detection) stored,
  suggested_occurrence smallint,    -- auto-derived from failure_events (accept/override)
  occurrence_basis jsonb not null default '{}'::jsonb,
  notes text,
  created_by uuid,                  -- bare uuid; store ctx.user.id
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Dedup on part_no (the key the engineer authors against, always present), NOT
  -- the trigger-derived item_id: item_id is NULL for parts not yet in item_master,
  -- and a (tenant, item_id, mode) unique would let those insert duplicates under
  -- NULLS-DISTINCT semantics. item_id stays as a join column to item_master.
  unique (tenant_id, part_no, failure_mode_id)
);
create index if not exists fmeca_item_idx on fmeca_criticality (tenant_id, item_id);
create index if not exists fmeca_rpn_idx  on fmeca_criticality (tenant_id, rpn);
create index if not exists fmeca_part_idx on fmeca_criticality (tenant_id, part_no);

-- item_id auto-resolves from part_no via the shared 171 resolver (harmless if the
-- caller also supplies item_id -- keeps part_no -> item_id consistent).
drop trigger if exists fmeca_set_item_id on fmeca_criticality;
create trigger fmeca_set_item_id before insert or update on fmeca_criticality
  for each row execute function set_item_id_from_part_no();

alter table fmeca_criticality enable row level security;
drop policy if exists fmeca_criticality_select on fmeca_criticality;
create policy fmeca_criticality_select on fmeca_criticality
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists fmeca_criticality_write on fmeca_criticality;
create policy fmeca_criticality_write on fmeca_criticality
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

-- 3. Dark flag for the OPTIONAL spare-matrix (s,S) min/max augmentation.
alter table tenant_settings
  add column if not exists fmeca_minmax_enabled boolean not null default false;

comment on table fmeca_criticality is
  'Reliability step 4c: real FMECA (severity x occurrence x detection -> rpn) per (item x failure_mode). Occurrence auto-suggested from failure_events; severity/detection human-authored. See docs/FMECA_DESIGN.md.';
comment on column tenant_settings.fmeca_minmax_enabled is
  'When true, a normalized FMECA RPN augments the spare-matrix (s,S) min/max (spare-minmax computeMinMax, recompute_recommended). Default false = unchanged. See docs/FMECA_DESIGN.md.';
