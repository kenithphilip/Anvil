-- 087_inventory_planning_phase35.sql
--
-- Phase 3.5 of the inventory-planning module
-- (docs/INVENTORY_PLANNING_DESIGN.md). Closes the structural gaps
-- the audit found in PR #79 + #80:
--
--   1. source_pos has no FK to suppliers, no doc_no column, no
--      created_by column. The plan-release path in /api/inventory/
--      plans.js inserts these, so the path failed in production.
--   2. source_pos.order_id was NOT NULL; releasing a plan that's
--      not tied to a specific customer order (i.e. a stocking PO)
--      could not produce a source_pos row at all.
--   3. The lead-time-fit query in /api/cron/inventory-planning-
--      weekly.js joined on source_pos.supplier_id which never
--      existed; without an FK, supplier-grouped lead-time stats
--      always returned empty.
--   4. Backfill of source_po_lines from source_pos.payload.lineItems
--      was specified by the design doc but never written. Without
--      it, the in-transit aggregator missed every existing PO.
--   5. Backfill of suppliers from the existing source_pos.supplier
--      text was specified by the doc but never written.
--
-- Idempotent. Re-running is a no-op once the columns + FK + the
-- backfill rows exist.

-- ===========================================================
-- 1. source_pos schema extensions
-- ===========================================================

alter table source_pos
  add column if not exists supplier_id uuid references suppliers(id) on delete set null,
  add column if not exists doc_no text,
  add column if not exists created_by uuid references auth.users(id);

-- order_id: relax NOT NULL so the plan-release path can create an
-- order-less stocking PO. Existing rows are unaffected (they
-- already have order_id set).
do $relax_order_fk$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'source_pos' and column_name = 'order_id' and is_nullable = 'NO'
  ) then
    alter table source_pos alter column order_id drop not null;
  end if;
end $relax_order_fk$;

-- ===========================================================
-- 2. Backfill suppliers from existing source_pos.supplier text
-- ===========================================================
-- Distinct supplier names land as supplier_code = upper(slugified)
-- and supplier_name = the original text. Idempotent: ON CONFLICT
-- DO NOTHING on (tenant_id, supplier_code).

do $backfill_suppliers$
declare
  rec record;
  sup_code text;
begin
  for rec in
    select distinct tenant_id, supplier
      from source_pos
     where supplier is not null and length(trim(supplier)) > 0
  loop
    sup_code := upper(regexp_replace(trim(rec.supplier), '[^A-Za-z0-9]+', '_', 'g'));
    sup_code := substring(sup_code from 1 for 60);
    if length(sup_code) = 0 then continue; end if;
    insert into suppliers (tenant_id, supplier_code, supplier_name, notes, created_at, updated_at)
    values (rec.tenant_id, sup_code, rec.supplier, 'Backfilled by migration 087.', now(), now())
    on conflict (tenant_id, supplier_code) do nothing;
  end loop;
end $backfill_suppliers$;

-- ===========================================================
-- 3. Backfill source_pos.supplier_id from supplier text
-- ===========================================================
update source_pos sp
   set supplier_id = s.id
  from suppliers s
 where sp.supplier_id is null
   and sp.tenant_id = s.tenant_id
   and upper(regexp_replace(trim(sp.supplier), '[^A-Za-z0-9]+', '_', 'g')) = s.supplier_code;

-- ===========================================================
-- 4. Backfill source_po_lines from source_pos.payload.lineItems
-- ===========================================================
-- The JSONB shape per /api/inventory/availability.js:42-49:
--   payload.lineItems[*].{partNumber|partNo|tallyItemName|itemName,
--                         qty, rate?, uom?, acknowledged_eta?}
-- We tolerate either of the four part-name keys and fall back to
-- the most likely one.

do $backfill_lines$
declare
  rec record;
  ln  jsonb;
  idx int;
  part text;
begin
  for rec in
    select id, tenant_id, payload, acknowledged_eta
      from source_pos
     where jsonb_typeof(payload->'lineItems') = 'array'
       and not exists (
         select 1 from source_po_lines spl where spl.source_po_id = source_pos.id
       )
  loop
    idx := 0;
    for ln in select * from jsonb_array_elements(rec.payload->'lineItems') loop
      idx := idx + 1;
      part := coalesce(
        ln->>'partNumber',
        ln->>'partNo',
        ln->>'tallyItemName',
        ln->>'itemName'
      );
      if part is null or length(trim(part)) = 0 then continue; end if;
      insert into source_po_lines (
        tenant_id, source_po_id, line_index, part_no, description,
        qty, rate, uom, acknowledged_eta, received_qty
      ) values (
        rec.tenant_id, rec.id, idx, part,
        ln->>'description',
        coalesce((ln->>'qty')::numeric, 0),
        nullif(ln->>'rate', '')::numeric,
        coalesce(ln->>'uom', 'Nos'),
        coalesce(nullif(ln->>'acknowledged_eta', '')::date, rec.acknowledged_eta),
        coalesce((ln->>'received_qty')::numeric, 0)
      )
      on conflict (source_po_id, line_index) do nothing;
    end loop;
  end loop;
end $backfill_lines$;

-- ===========================================================
-- 5. inventory_authoritative_source per-item override
-- ===========================================================
-- Already added by 085 on item_master. No change here.

-- ===========================================================
-- 6. Index for the supplier-grouped lead-time query
-- ===========================================================
create index if not exists source_pos_supplier_idx
  on source_pos (tenant_id, supplier_id) where supplier_id is not null;

-- ===========================================================
-- 7. Index for source_po_lines.received_at lookup (lead-time fit)
-- ===========================================================
create index if not exists source_po_lines_received_idx
  on source_po_lines (tenant_id, source_po_id, received_at)
  where received_at is not null;

-- ===========================================================
-- 8. Notes
-- ===========================================================
-- The teardown extension (drop / truncate inventory_* tables on
-- staging|local|ci tear-down) lives in supabase/seed/900_teardown.sql,
-- not here, because it is data-only and runs as a separate phase.
