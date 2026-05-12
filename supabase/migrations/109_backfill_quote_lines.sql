-- Migration 109: backfill quote_lines from legacy quotes.line_items JSONB.
--
-- After migration 108 introduced the proper quote_lines table, the
-- new drawer renders nothing for quotes that pre-date 108. This
-- migration walks every quote and inserts a quote_lines row per
-- JSONB element. Idempotent via the (tenant_id, quote_id, line_index)
-- unique constraint plus `on conflict do nothing`.
--
-- Best-effort coercion: line_items shape varies across the codebase
-- (quoted snake_case + camelCase). The select below maps both.

insert into quote_lines (
  tenant_id, quote_id, line_index,
  part_no, description, qty, uom,
  hsn_sac, customer_part_number, source_country,
  listed_unit_price, discount_pct, discounted_unit_price, line_amount,
  cgst_pct, sgst_pct, igst_pct, utgst_pct, cess_pct, remark
)
select
  q.tenant_id,
  q.id as quote_id,
  (idx - 1)::int as line_index,
  coalesce(li ->> 'part_no',        li ->> 'partNumber',       li ->> 'part') as part_no,
  coalesce(li ->> 'description',    li ->> 'desc',             li ->> 'item') as description,
  nullif(coalesce(li ->> 'qty',     li ->> 'quantity'), '')::numeric as qty,
  coalesce(li ->> 'uom',            li ->> 'unit') as uom,
  coalesce(li ->> 'hsn_sac',        li ->> 'hsn') as hsn_sac,
  coalesce(li ->> 'customer_part_number', li ->> 'custPartNo') as customer_part_number,
  coalesce(li ->> 'source_country', li ->> 'sourceCountry') as source_country,
  nullif(coalesce(li ->> 'listed_unit_price',     li ->> 'listedUnitPrice',     li ->> 'unitPrice'), '')::numeric as listed_unit_price,
  nullif(coalesce(li ->> 'discount_pct',          li ->> 'discountPct'), '')::numeric as discount_pct,
  nullif(coalesce(li ->> 'discounted_unit_price', li ->> 'discountedUnitPrice', li ->> 'rate'), '')::numeric as discounted_unit_price,
  nullif(coalesce(li ->> 'line_amount',           li ->> 'amount',              li ->> 'lineTotal'), '')::numeric as line_amount,
  nullif(coalesce(li ->> 'cgst_pct', li ->> 'cgstRate', li ->> 'cgst'), '')::numeric as cgst_pct,
  nullif(coalesce(li ->> 'sgst_pct', li ->> 'sgstRate', li ->> 'sgst'), '')::numeric as sgst_pct,
  nullif(coalesce(li ->> 'igst_pct', li ->> 'igstRate', li ->> 'igst'), '')::numeric as igst_pct,
  -- Audit fix May 2026: utgst_pct + cess_pct were missing from
  -- the original 109 backfill, so any pre-108 quote with UT-GST
  -- or cess in its JSONB lost those columns on backfill.
  nullif(coalesce(li ->> 'utgst_pct', li ->> 'utgstRate', li ->> 'utgst'), '')::numeric as utgst_pct,
  nullif(coalesce(li ->> 'cess_pct',  li ->> 'cessRate',  li ->> 'cess'),  '')::numeric as cess_pct,
  li ->> 'remark' as remark
from quotes q
cross join lateral jsonb_array_elements(coalesce(q.line_items, '[]'::jsonb)) with ordinality as t(li, idx)
where jsonb_typeof(coalesce(q.line_items, '[]'::jsonb)) = 'array'
on conflict (tenant_id, quote_id, line_index) do nothing;

-- Reporting line for the CI verify step.
do $$
declare
  inserted_count int;
begin
  select count(*) into inserted_count from quote_lines;
  raise notice 'verify: quote_lines backfilled, total rows = %', inserted_count;
end $$;
