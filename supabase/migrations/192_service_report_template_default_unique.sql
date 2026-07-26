-- Fix the service_report_templates uniqueness. 191 shipped
-- `unique (tenant_id, customer_id)`, but Postgres treats NULL as DISTINCT in a
-- unique constraint — so the tenant-default row (customer_id NULL), the ONE row
-- that must be singular, was never actually deduped. Repeated saves of the
-- default would accumulate duplicate rows and resolveTemplate would then pick an
-- arbitrary one.
--
-- This is a forward-fix because 191 was already applied to the live DB; editing
-- 191 in place would make its history diverge from what was applied. Idempotent
-- on both paths:
--   * live DB   — the null-blind constraint exists -> dropped; partial indexes
--                 created.
--   * fresh env — 191 created the constraint too, so identical.
-- The service_report_templates table is brand new (the template endpoint had
-- not been called), so no duplicate rows exist to reconcile.

-- 1. Drop the null-blind table-level unique, found by its column set (the name
--    is auto-generated + deployment-specific).
do $$
declare cname text;
begin
  select c.conname into cname
    from pg_constraint c
   where c.conrelid = 'service_report_templates'::regclass
     and c.contype = 'u'
     and (
       select array_agg(a.attname::text order by a.attname::text)
         from unnest(c.conkey) k
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k
     ) = array['customer_id','tenant_id']
   limit 1;
  if cname is not null then
    execute format('alter table service_report_templates drop constraint %I', cname);
  end if;
end $$;

-- 2. Correct uniqueness as two partial indexes: one template per (tenant,
--    customer), AND exactly one tenant-default (customer_id NULL) per tenant.
create unique index if not exists service_report_templates_customer_uk
  on service_report_templates (tenant_id, customer_id)
  where customer_id is not null;
create unique index if not exists service_report_templates_default_uk
  on service_report_templates (tenant_id)
  where customer_id is null;
