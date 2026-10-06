-- Make the workbook import finishable.
--
-- The apply loop wrote one row at a time — an INSERT (or UPDATE) plus its own
-- recordAudit INSERT, two sequential PostgREST round-trips per shipment. At the
-- ~0.5s/row that costs in practice, a 1,145-row workbook needs about ten
-- minutes against Vercel's 60s function ceiling, so it had never once finished:
-- observed live, the request died at HTTP 504 having committed 111 of 1,145
-- rows (shipments went 19 -> 130). The 19 rows already on file dated from
-- 2026-08-10, a batch small enough to complete.
--
-- Batching the writes needs a conflict target, which is what this index is.
-- `shipper_invoice_no` is already the import's natural key: shipment_import
-- matches existing rows on it, and shipment_lines hangs off the shipment it
-- resolves to.
--
-- PARTIAL on `is not null`, because rows created by hand through the shipments
-- screen have no invoice number and several already share NULL. NULLs are
-- distinct to a unique index anyway; being explicit documents that a
-- manually-created shipment is deliberately outside this constraint.
--
-- If this fails with 23505, the table already holds duplicate invoice numbers —
-- find them before forcing it:
--   select tenant_id, shipper_invoice_no, count(*)
--     from shipments where shipper_invoice_no is not null
--     group by 1, 2 having count(*) > 1;
create unique index if not exists shipments_tenant_invoice_uq
  on shipments (tenant_id, shipper_invoice_no)
  where shipper_invoice_no is not null;
