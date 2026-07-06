-- 161_price_composition_supplier_id.sql
--
-- Forecast P1 polish: link price_composition_lines to the suppliers
-- master. Migration 139 added a free-text supplier_name; this adds the
-- FK (mirrors composition_material_lines.supplier_id from 142 and the
-- source_pos backfill from 087). supplier_name is KEPT as the display
-- fallback for rows that don't resolve to a master supplier.
--
-- Additive + idempotent. Backfill is name-slug based, same as 087.

alter table price_composition_lines
  add column if not exists supplier_id uuid references suppliers(id) on delete set null;

-- 1. Ensure a suppliers row exists for every distinct supplier_name.
--    supplier_code = upper(slug) so re-runs are idempotent on
--    (tenant_id, supplier_code).
do $backfill_pcl_suppliers$
declare
  rec record;
  sup_code text;
begin
  for rec in
    select distinct tenant_id, supplier_name
      from price_composition_lines
     where supplier_name is not null and length(trim(supplier_name)) > 0
  loop
    sup_code := substring(upper(regexp_replace(trim(rec.supplier_name), '[^A-Za-z0-9]+', '_', 'g')) from 1 for 60);
    if length(sup_code) = 0 then continue; end if;
    insert into suppliers (tenant_id, supplier_code, supplier_name, notes, created_at, updated_at)
    values (rec.tenant_id, sup_code, rec.supplier_name, 'Backfilled by migration 161.', now(), now())
    on conflict (tenant_id, supplier_code) do nothing;
  end loop;
end $backfill_pcl_suppliers$;

-- 2. Link supplier_id from supplier_name via the same slug match.
update price_composition_lines pcl
   set supplier_id = s.id
  from suppliers s
 where pcl.supplier_id is null
   and pcl.supplier_name is not null
   and pcl.tenant_id = s.tenant_id
   and substring(upper(regexp_replace(trim(pcl.supplier_name), '[^A-Za-z0-9]+', '_', 'g')) from 1 for 60) = s.supplier_code;

create index if not exists price_composition_lines_supplier_idx
  on price_composition_lines (tenant_id, supplier_id) where supplier_id is not null;

comment on column price_composition_lines.supplier_id is
  'FK to suppliers master (migration 161). supplier_name is the display fallback when a row does not resolve to a master supplier.';
