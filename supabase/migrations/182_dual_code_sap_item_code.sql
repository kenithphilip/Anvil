-- Migration 182: dual-code flywheel — give the buyer's SAP item code a
-- first-class, distinct home so extraction can learn it.
--
-- Mahindra (and most SAP-driven buyers) print TWO codes per PO line: their own
-- SAP-generated item/material code (e.g. A12060OBAR010003) AND a descriptive
-- part label that often embeds OUR part number behind a prefix (e.g.
-- "OBARA STD SHANK TWS-092-90-2"). PR #272 taught the extractor to capture the
-- SAP code separately as line.customerItemCode, distinct from partNumber (ours).
-- Until now that SAP code had nowhere to land: item_customer_parts stored only a
-- single buyer code in customer_part_number, and quote_lines had no slot for it,
-- so the recon write-back silently dropped it.
--
-- This migration gives the SAP code a distinct column so the extraction->mapping
-- flywheel can (a) auto-resolve a future PO line by its SAP code with ZERO LLM
-- calls (tier-0 in item-mapper.js), and (b) persist the (customer, SAP-code) ->
-- our-item pair every time an operator confirms a mapping. The buyer's SAP code
-- and our own part number stay in SEPARATE columns, never conflated.
--
-- Additive + idempotent. Forward-only. Applied MANUALLY (migrations run via the
-- seed-apply.yml workflow, not on deploy):
--   gh workflow run seed-apply.yml -f phase=migrations -f only=182_dual_code_sap_item_code.sql

-- 1) item_customer_parts: the learning table gains a distinct SAP-code column.
alter table item_customer_parts add column if not exists customer_item_code text;

comment on column item_customer_parts.customer_item_code is
  'The buyer''s own SAP-generated item/material code (distinct from customer_part_number, the buyer''s descriptive part label). Populated by the recon-confirm write-back and read by item-mapper tier-0 for zero-LLM auto-mapping of future POs.';

-- One ACTIVE (valid_to IS NULL) row per (tenant, customer, SAP-code), mirroring
-- the mig-129 invariant on customer_part_number: many SAP codes may map to one
-- canonical item, but a given (customer, SAP-code) can be active under at most
-- one item_id at a time. Superseded rows carry a non-null valid_to. The
-- `customer_item_code is not null` predicate keeps legacy PO-only rows (no SAP
-- code) from colliding on NULL. Predicate is pure-immutable so Postgres accepts it.
create unique index if not exists item_customer_parts_one_canonical_per_sap
  on item_customer_parts (tenant_id, customer_id, customer_item_code)
  where valid_to is null and customer_item_code is not null;

comment on index item_customer_parts_one_canonical_per_sap is
  'CM P2b: one active item per (tenant, customer, customer_item_code). Mirrors mig-129 on customer_part_number for the SAP code. Supersession: UPDATE prior row valid_to=current_date, then write the new active row.';

-- Lookup index for the tier-0 resolution read (.in(customer_item_code, [...])).
create index if not exists item_customer_parts_by_sap
  on item_customer_parts (tenant_id, customer_id, customer_item_code)
  where customer_item_code is not null;

-- Surface (do NOT auto-fix) existing rows that would violate the new invariant.
do $$
declare
  conflict_count int;
begin
  select count(*) into conflict_count from (
    select tenant_id, customer_id, customer_item_code
      from item_customer_parts
      where valid_to is null and customer_item_code is not null
      group by tenant_id, customer_id, customer_item_code
      having count(distinct item_id) > 1
  ) conflicts;
  if conflict_count > 0 then
    raise notice 'CM P2b: % active (customer, SAP-code) groups map to multiple item_id; the new unique index will reject future duplicates. Existing rows preserved; reconcile via the mapping workspace.', conflict_count;
  else
    raise notice 'CM P2b: no active SAP-code invariant violations found.';
  end if;
end $$;

-- Rebuild the active view so its `select *` re-expands to include the new
-- column (a view's column list is fixed at creation; adding a base-table column
-- does not retroactively appear until the view is replaced).
create or replace view item_customer_parts_active as
select *
  from item_customer_parts
 where valid_to is null;

comment on view item_customer_parts_active is
  'CM 2.1: rolling view of currently-active customer-part mappings (valid_to IS NULL). Now also carries customer_item_code (CM P2b).';

-- 2) quote_lines: carry the SAP code + the verbatim raw description forward so a
-- quote authored from an extracted PO keeps both. Additive; buildQuoteLineRow
-- only sets these when supplied, so existing quote/spare-matrix writers produce
-- byte-identical rows and are unaffected.
alter table quote_lines add column if not exists customer_item_code text;
alter table quote_lines add column if not exists raw_description text;

comment on column quote_lines.customer_item_code is
  'Buyer SAP item code carried from an extracted PO line (line.customerItemCode), distinct from customer_part_number.';
comment on column quote_lines.raw_description is
  'Verbatim extracted line description (line.raw_description) preserved for audit / re-mapping.';
