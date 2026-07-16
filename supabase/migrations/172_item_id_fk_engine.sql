-- 172_item_id_fk_engine.sql
--
-- Spare Intelligence bridge STEP 2b: extend the item_id FK hinge (added in
-- 171_item_id_fk_hinge.sql) to the two CRON-REGENERATED engine tables that 171
-- deliberately deferred -- inventory_positions (daily) and demand_forecasts
-- (weekly). Together with 171 this completes friction #1 (the string-joined
-- part_no hinge) across ALL operational spare/inventory tables.
-- See docs/SPARE_INTELLIGENCE_COMPAT.md.
--
-- Depends on 171_item_id_fk_hinge.sql, which defines the shared resolver
-- set_item_id_from_part_no() (tenant-scoped, case-insensitive item_master(part_no)
-- match, oldest-wins). Migrations apply in numeric order, so 171 runs first.
--
-- Same pattern and identical safety properties as 171:
--   * ADDITIVE + backward-compatible: part_no stays; no reader change (grep
--     confirms nothing reads .item_id off these two tables today).
--   * The shared trigger is BEFORE INSERT OR UPDATE. Both engine tables are
--     written ONLY by upsert (INSERT ... ON CONFLICT DO UPDATE) -- so the trigger
--     must fire on the DO UPDATE branch too: the daily/weekly re-run for the same
--     conflict key takes that branch, and an INSERT-only trigger would let item_id
--     go stale. inventory_positions.upsert conflicts on (tenant_id,part_no,as_of,
--     source); demand_forecasts.upsert on (tenant_id,part_no,week_start,model_name).
--     No writer uses COPY/TRUNCATE/bulk-load, so no path bypasses the row trigger.
--   * Backfill runs BEFORE the trigger is created (no double-resolve). Unlike the
--     authored tables in 171, inventory_positions ACCUMULATES historical as_of
--     snapshots that the cron never re-writes -- so the backfill is what populates
--     item_id on that history; only current/future rows are trigger-maintained.
--   * The resolver lookup is served by the composite index item_master_lookup
--     (tenant_id, lower(part_no)) (006_corpus_alignment.sql:200), so the per-row
--     lookup during regeneration is an index scan, not a seq scan.
--
-- Idempotent (add column if not exists / create index if not exists / drop
-- trigger if exists / backfill only where item_id is null).

-- == inventory_positions (part x stock-position x as_of x source) ===============
alter table inventory_positions add column if not exists item_id uuid references item_master(id) on delete set null;
create index if not exists inventory_positions_item_id_idx on inventory_positions (tenant_id, item_id);
update inventory_positions t set item_id = (
  select im.id from item_master im
   where im.tenant_id = t.tenant_id and lower(im.part_no) = lower(t.part_no)
   order by im.created_at asc limit 1)
 where t.part_no is not null and btrim(t.part_no) <> '' and t.item_id is null;
drop trigger if exists inventory_positions_set_item_id on inventory_positions;
create trigger inventory_positions_set_item_id before insert or update on inventory_positions
  for each row execute function set_item_id_from_part_no();

-- == demand_forecasts (part x forecast-week x model) ============================
alter table demand_forecasts add column if not exists item_id uuid references item_master(id) on delete set null;
create index if not exists demand_forecasts_item_id_idx on demand_forecasts (tenant_id, item_id);
update demand_forecasts t set item_id = (
  select im.id from item_master im
   where im.tenant_id = t.tenant_id and lower(im.part_no) = lower(t.part_no)
   order by im.created_at asc limit 1)
 where t.part_no is not null and btrim(t.part_no) <> '' and t.item_id is null;
drop trigger if exists demand_forecasts_set_item_id on demand_forecasts;
create trigger demand_forecasts_set_item_id before insert or update on demand_forecasts
  for each row execute function set_item_id_from_part_no();
