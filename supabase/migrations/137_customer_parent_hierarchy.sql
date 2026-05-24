-- Customer hierarchy: self-referential parent for corporate groups.
--
-- Lets a customer roll up under a parent (group -> child billing
-- entities / plants), distinct from customer_locations (which models
-- ship-to plants under one legal entity). on delete set null so
-- removing a parent orphans the children rather than cascading. Purely
-- additive and idempotent.

alter table customers
  add column if not exists parent_customer_id uuid references customers(id) on delete set null;

create index if not exists customers_parent_idx
  on customers (tenant_id, parent_customer_id) where parent_customer_id is not null;

comment on column customers.parent_customer_id is
  'Optional parent customer for group/subsidiary hierarchy. Null = top-level. Distinct from customer_locations (plants under one entity).';
