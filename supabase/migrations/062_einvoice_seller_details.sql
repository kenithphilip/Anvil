-- 062_einvoice_seller_details.sql
--
-- Audit P1.2 (May 2026). The e-invoice handler at src/api/einvoice/
-- index.js was building every IRN payload with a hardcoded
-- SellerDtls block reading "Obara India Pvt. Ltd., W-17 F2 Block
-- MIDC PIMPRI, Pune, 411018, Stcd 27", regardless of the calling
-- tenant. Any tenant other than Obara India shipped GSTN a payload
-- claiming to be Obara, which the GSTN API rejects (the GSTIN won't
-- match the registered legal name + address) or, worse, accepts
-- under the wrong legal name when the GSTIN happens to align.
--
-- Seller details for e-invoice need to come from per-tenant config.
-- All fields are nullable so the migration is non-blocking on
-- existing rows; einvoice/index.js refuses to compose a payload
-- when the required fields are missing and surfaces a clear error
-- to the caller.

alter table tenant_settings
  add column if not exists einvoice_seller_gstin text,
  add column if not exists einvoice_seller_legal_name text,
  add column if not exists einvoice_seller_trade_name text,
  add column if not exists einvoice_seller_address_line1 text,
  add column if not exists einvoice_seller_address_line2 text,
  add column if not exists einvoice_seller_locality text,
  add column if not exists einvoice_seller_pincode text,
  add column if not exists einvoice_seller_state_code text,
  add column if not exists einvoice_seller_phone text,
  add column if not exists einvoice_seller_email text;

comment on column tenant_settings.einvoice_seller_gstin is
  'GSTN-registered GSTIN for the seller. Required for e-invoice generation.';
comment on column tenant_settings.einvoice_seller_legal_name is
  'Legal name as registered with GSTN. Must match the registration tied to the GSTIN.';
comment on column tenant_settings.einvoice_seller_state_code is
  '2-digit state code (matches the first 2 digits of GSTIN).';

-- No backfill: existing rows retain NULL; the einvoice handler
-- now refuses to compose payloads when these fields are missing
-- and returns a structured error so operators know to set them.
