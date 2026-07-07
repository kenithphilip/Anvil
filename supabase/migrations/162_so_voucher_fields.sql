-- 162_so_voucher_fields.sql
--
-- Fields needed to render the Tally-style "SALES ORDER" voucher
-- (src/api/orders/so_pdf.js) that reproduces the customer-facing SO
-- acknowledgment:
--   - tenant_settings.cin / .pan : seller registration lines on the SO
--     header (the einvoice_seller_* block from migration 062 lacks them).
--   - orders.so_voucher_no        : the seller's internal SO voucher no
--     (e.g. "137"). Nullable + free-text for now; a per-tenant counter
--     can populate it later.
--   - orders.so_message           : the customer-service note line shown
--     above the SO line table.
--
-- Additive + idempotent. No backfill (CIN/PAN are set per-tenant via a
-- tenant_settings update, not in this migration).

alter table tenant_settings
  add column if not exists cin text,
  add column if not exists pan text;

alter table orders
  add column if not exists so_voucher_no text,
  add column if not exists so_message text;

comment on column tenant_settings.cin is 'Company CIN, printed on the Sales Order voucher header (migration 162).';
comment on column tenant_settings.pan is 'Company PAN, printed on the Sales Order voucher header (migration 162).';
comment on column orders.so_voucher_no is 'Seller internal Sales Order voucher number shown on the SO PDF (migration 162).';
comment on column orders.so_message is 'Customer-service note line shown above the SO line table (migration 162).';
