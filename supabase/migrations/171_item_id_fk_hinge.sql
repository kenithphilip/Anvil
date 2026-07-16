-- 171_item_id_fk_hinge.sql
--
-- Spare Intelligence bridge STEP 2: promote the string-joined `part_no` hinge to
-- a REAL item_master FK on the authored hinge tables (equipment_installed_parts,
-- bom_lines, recommended_spares). See docs/SPARE_INTELLIGENCE_COMPAT.md.
--
-- ADDITIVE + backward-compatible: `part_no` stays; existing readers are
-- untouched; new consumers can JOIN on item_id (turning the string-joined
-- type<->instance / type<->BOM hinge relational). A shared trigger keeps item_id
-- in sync with part_no on every insert/update (no application/JS change), and
-- existing rows are backfilled. Match is exact + case-insensitive + tenant-
-- scoped; item_master's unique(tenant_id, part_no) makes it unambiguous
-- (oldest-wins tie-break for the rare raw-case duplicate). Unmatched rows keep
-- item_id NULL (a later JS pass can resolve those via the alias/fuzzy matcher).
--
-- DEFERRED to step 2b: the cron-regenerated engine tables inventory_positions
-- (daily) and demand_forecasts (weekly), which are coupled to the planning
-- engine and higher churn.
--
-- Idempotent (add column if not exists / create or replace / drop trigger if
-- exists / backfill only where item_id is null). Per table, the backfill runs
-- BEFORE the trigger is created so it does not double-resolve.

-- Shared resolver: set NEW.item_id from the tenant-scoped part_no match.
create or replace function set_item_id_from_part_no() returns trigger as $$
begin
  if new.part_no is null or btrim(new.part_no) = '' then
    new.item_id := null;
  else
    select im.id into new.item_id
      from item_master im
      where im.tenant_id = new.tenant_id
        and lower(im.part_no) = lower(new.part_no)
      order by im.created_at asc
      limit 1;
  end if;
  return new;
end;
$$ language plpgsql;

-- ── equipment_installed_parts (part <-> asset-instance hinge) ──────────────────
alter table equipment_installed_parts add column if not exists item_id uuid references item_master(id) on delete set null;
create index if not exists eip_item_id_idx on equipment_installed_parts (tenant_id, item_id);
update equipment_installed_parts t set item_id = (
  select im.id from item_master im
   where im.tenant_id = t.tenant_id and lower(im.part_no) = lower(t.part_no)
   order by im.created_at asc limit 1)
 where t.part_no is not null and btrim(t.part_no) <> '' and t.item_id is null;
drop trigger if exists eip_set_item_id on equipment_installed_parts;
create trigger eip_set_item_id before insert or update on equipment_installed_parts
  for each row execute function set_item_id_from_part_no();

-- ── bom_lines (part <-> BOM hinge) ─────────────────────────────────────────────
alter table bom_lines add column if not exists item_id uuid references item_master(id) on delete set null;
create index if not exists bom_lines_item_id_idx on bom_lines (tenant_id, item_id);
update bom_lines t set item_id = (
  select im.id from item_master im
   where im.tenant_id = t.tenant_id and lower(im.part_no) = lower(t.part_no)
   order by im.created_at asc limit 1)
 where t.part_no is not null and btrim(t.part_no) <> '' and t.item_id is null;
drop trigger if exists bom_lines_set_item_id on bom_lines;
create trigger bom_lines_set_item_id before insert or update on bom_lines
  for each row execute function set_item_id_from_part_no();

-- ── recommended_spares (part <-> spare-matrix hinge) ───────────────────────────
alter table recommended_spares add column if not exists item_id uuid references item_master(id) on delete set null;
create index if not exists recommended_spares_item_id_idx on recommended_spares (tenant_id, item_id);
update recommended_spares t set item_id = (
  select im.id from item_master im
   where im.tenant_id = t.tenant_id and lower(im.part_no) = lower(t.part_no)
   order by im.created_at asc limit 1)
 where t.part_no is not null and btrim(t.part_no) <> '' and t.item_id is null;
drop trigger if exists recommended_spares_set_item_id on recommended_spares;
create trigger recommended_spares_set_item_id before insert or update on recommended_spares
  for each row execute function set_item_id_from_part_no();

comment on function set_item_id_from_part_no() is
  'Bridge step 2: keeps <table>.item_id in sync with part_no via a tenant-scoped case-insensitive item_master match (oldest-wins). See docs/SPARE_INTELLIGENCE_COMPAT.md.';
