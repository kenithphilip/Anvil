-- 168_vendors_supplier_id.sql
--
-- BRIDGE: link an RFQ vendor (vendors) to a suppliers-master row (suppliers).
-- An RFQ winner is a vendor; procurement + composition speak "suppliers".
-- This FK lets an award resolve the winning vendor deterministically to a
-- supplier_id, which is then stamped onto both price_composition_lines
-- (cost) and quote_lines (the chosen supplier) — replacing the lossy
-- supplier_name -> supplier_code slug join used up to now. Generic across
-- tenants; no brand assumptions.
--
-- Additive + idempotent; on delete set null so removing a supplier never
-- orphans a vendor. Mirrors 161 (price_composition_lines.supplier_id) and
-- 167 (quote_lines.supplier_id). vendors RLS is tenant-wide — no policy
-- change needed. NO auto-backfill: vendor<->supplier is a curated link
-- (vendor_name and supplier_name are separate masters whose strings diverge),
-- set explicitly via the vendor editor / API.

alter table vendors
  add column if not exists supplier_id uuid references suppliers(id) on delete set null;

create index if not exists vendors_supplier_idx
  on vendors (tenant_id, supplier_id) where supplier_id is not null;

comment on column vendors.supplier_id is
  'Bridge to the suppliers master (migration 168). Set explicitly via the vendor editor; an RFQ award resolves the winning vendor to this supplier_id for composition + quote_lines write-back. NULL falls back to the supplier_name slug match.';
