-- 154_supplier_quote_ref_and_quote_link.sql
--
-- Internal RFQ-to-vendor capture, tied to a customer quote.
--
-- 1) supplier_quotes.supplier_quote_ref — the vendor's own quote number /
--    reference (e.g. "OBK-Q-2026-0417"), captured alongside price/currency.
-- 2) supplier_rfqs.source_quote_id — link an RFQ to the customer quote whose
--    lines it was raised from, so the winning vendor price + quote ref can be
--    fed back into that quote's price composition.

alter table supplier_quotes
  add column if not exists supplier_quote_ref text;

alter table supplier_rfqs
  add column if not exists source_quote_id uuid references quotes(id) on delete set null;

create index if not exists supplier_rfqs_quote_idx
  on supplier_rfqs (tenant_id, source_quote_id);
