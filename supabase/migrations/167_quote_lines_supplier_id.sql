-- 167_quote_lines_supplier_id.sql
--
-- Let a quote LINE carry a chosen supplier (from the suppliers master),
-- generically — Anvil serves orgs beyond the original tenant, so this is a
-- real supplier FK, NOT an origin-country model. source_country stays as
-- the free-text origin marker; supplier_id is added ALONGSIDE it (never
-- derived from country). Mirrors price_composition_lines.supplier_id (161)
-- and composition_material_lines.supplier_id (142).
--
-- Additive + idempotent; on delete set null so removing a supplier never
-- orphans a quote line. RLS on quote_lines is tenant-wide (108) — no
-- policy change needed.

alter table quote_lines
  add column if not exists supplier_id uuid references suppliers(id) on delete set null;

create index if not exists quote_lines_supplier_idx
  on quote_lines (tenant_id, supplier_id) where supplier_id is not null;

comment on column quote_lines.supplier_id is
  'Chosen supplier for this quote line (FK to suppliers master, migration 167). Independent of source_country (the free-text origin marker).';
