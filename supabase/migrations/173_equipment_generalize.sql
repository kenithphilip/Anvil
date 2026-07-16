-- 173_equipment_generalize.sql
--
-- Spare Intelligence bridge STEP 3: generalize equipment_hierarchy beyond the
-- spot-welding hard-coding (robot_no/gun_no/timer_model/atd_model...) so any
-- asset class (pump, motor, CNC spindle, conveyor, ...) fits the same instance
-- registry. See docs/SPARE_INTELLIGENCE_COMPAT.md (friction #5).
--
-- PURELY ADDITIVE + backward-compatible. Recon established two facts that make
-- this safe without touching a single existing reader/writer of the typed
-- columns:
--   1. Every welding column is NULLABLE and there is NO node_type/CHECK to
--      relax -- the table is welding-specific only by column NAMING. So a
--      non-welding row is already insertable with the welding columns left NULL.
--   2. The whole read/write surface is ONE endpoint (src/api/admin/equipment.js,
--      select('*') + an explicit column list) plus one screen. select('*') and
--      the explicit list both survive added columns; the seed inserts reference
--      welding columns by name, so we KEEP the columns.
--
-- The change:
--   * asset_class text not null default 'welding_gun' -- the class discriminator.
--     Existing rows default to 'welding_gun'; the typed welding columns become a
--     typed facade for that one class.
--   * attributes jsonb not null default '{}' -- the generic per-class attribute
--     bag. For non-welding classes this is the source of truth; for welding_gun
--     it is a DERIVED mirror of the typed columns (kept in sync by the trigger
--     below), so a generic reader can read attributes uniformly across classes.
--   * A BEFORE INSERT OR UPDATE trigger mirrors the typed welding columns INTO
--     attributes for welding_gun rows only (typed columns win; any extra
--     caller-supplied keys are preserved via the || merge). Non-welding rows
--     keep the attributes the writer sends, untouched.
--   * Backfill runs BEFORE the trigger is created (no double-fire). All existing
--     rows are asset_class='welding_gun' (the column default), so the backfill
--     mirrors their typed columns into attributes.
--   * Indexes: (tenant_id, asset_class) for class filtering; a GIN on attributes
--     for @>/key-exists attribute queries by a future generic reader.
--
-- Idempotent (add column if not exists / create index if not exists / create or
-- replace function / drop trigger if exists / backfill only where empty).

alter table equipment_hierarchy add column if not exists asset_class text not null default 'welding_gun';
alter table equipment_hierarchy add column if not exists attributes jsonb not null default '{}'::jsonb;

create index if not exists eq_hier_class_idx on equipment_hierarchy (tenant_id, asset_class);
create index if not exists eq_hier_attributes_gin on equipment_hierarchy using gin (attributes);

-- Mirror the typed welding columns into attributes for welding_gun rows. The
-- typed columns are the source of truth for that class, so they OVERRIDE any
-- same-named key the caller passed; jsonb_strip_nulls keeps absent columns out
-- of the bag; the || merge preserves any other (non-welding) keys.
create or replace function sync_equipment_attributes() returns trigger as $$
begin
  if new.asset_class = 'welding_gun' then
    new.attributes := coalesce(new.attributes, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
      'plant_name',   new.plant_name,
      'line_name',    new.line_name,
      'zone_name',    new.zone_name,
      'station_name', new.station_name,
      'robot_make',   new.robot_make,
      'robot_no',     new.robot_no,
      'gun_no',       new.gun_no,
      'gun_type',     new.gun_type,
      'timer_model',  new.timer_model,
      'atd_model',    new.atd_model,
      'qty',          new.qty
    ));
  end if;
  return new;
end;
$$ language plpgsql;

-- Backfill existing (all welding_gun) rows before the trigger exists.
update equipment_hierarchy set attributes = coalesce(attributes, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
  'plant_name',   plant_name,
  'line_name',    line_name,
  'zone_name',    zone_name,
  'station_name', station_name,
  'robot_make',   robot_make,
  'robot_no',     robot_no,
  'gun_no',       gun_no,
  'gun_type',     gun_type,
  'timer_model',  timer_model,
  'atd_model',    atd_model,
  'qty',          qty
)) where asset_class = 'welding_gun';

drop trigger if exists equipment_sync_attributes on equipment_hierarchy;
create trigger equipment_sync_attributes before insert or update on equipment_hierarchy
  for each row execute function sync_equipment_attributes();

comment on column equipment_hierarchy.asset_class is
  'Asset class discriminator (default welding_gun). Generalizes the instance registry beyond spot-welding. See docs/SPARE_INTELLIGENCE_COMPAT.md.';
comment on column equipment_hierarchy.attributes is
  'Generic per-class attribute bag. Source of truth for non-welding classes; a DERIVED mirror of the typed welding columns for welding_gun rows (kept in sync by trigger equipment_sync_attributes).';
