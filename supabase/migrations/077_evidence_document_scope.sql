-- 077_evidence_document_scope.sql
--
-- The OCR evidence table (`evidence`, defined in 001_init.sql) was
-- originally designed as order-scoped: every row required an
-- `order_id`. The Mistral OCR endpoint (/api/documents/ocr) tried to
-- support document-only runs by passing `order_id: orderId || null`,
-- but the NOT NULL constraint silently rejected those inserts.
--
-- This migration relaxes the constraint so OCR can run on a
-- document before an order exists, which is what the documents-
-- detail "Run OCR" + bbox overlay flow needs. The order-scoped
-- queries in /api/orders/[id] still work; they simply skip the new
-- document-only rows (order_id IS NULL).
--
-- Idempotent.

alter table evidence
  alter column order_id drop not null;

-- Document-scoped index. Used by the new
-- GET /api/documents/[id]/evidence endpoint to fetch every OCR
-- bbox for a document in page + creation order, which is how the
-- frontend overlay walks them.
create index if not exists evidence_document_idx
  on evidence (tenant_id, document_id, page_number, created_at)
  where document_id is not null;
