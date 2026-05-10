-- 096_customer_intl_taxid.sql
--
-- Bug fix: the customer extraction path is hard-wired to Indian
-- conventions. For non-Indian POs (OBARA Japan, Hyundai Steel Korea,
-- Voestalpine Austria, etc.) the schema only has GSTIN + state_code;
-- the buyer's actual tax id (Korean BRN, Japanese T-number, German
-- Steuernummer, US EIN, EU VAT) ends up nowhere on the customer
-- record. The new-customer dialog opened with seven blank fields and
-- the operator was forced to retype everything.
--
-- This migration adds:
--
--   1. customers.country            -- ISO 3166-1 alpha-2 code
--   2. customers.tax_id             -- buyer tax id when country != IN
--   3. customers.tax_id_type        -- enum: pan / brn / jp_corp /
--                                     eu_vat / us_ein / de_steuernummer
--                                     / other
--   4. customer_locations.country   -- mirror so the address row knows
--                                     which jurisdiction it sits in
--   5. customer_locations.tax_id    -- mirror for the bill-to / ship-to
--                                     when the buyer's tax id varies
--                                     by location
--
-- All columns are nullable so existing rows stay valid (country
-- defaults to NULL; the docai extractor + frontend treat NULL as
-- "IN" for back-compat).
--
-- Related code change: src/api/_lib/docai/claude.js +
-- gemini.js + validators.js gain country-conditional rules so a
-- non-Indian PO does not get flagged for missing GSTIN.
--
-- Idempotent.

alter table customers
  add column if not exists country text,
  add column if not exists tax_id text,
  add column if not exists tax_id_type text;

-- Constrain tax_id_type values. ALTER ADD CONSTRAINT IF NOT EXISTS is
-- not portable across PG versions; do a defensive drop+create.
alter table customers
  drop constraint if exists customers_tax_id_type_check;
alter table customers
  add constraint customers_tax_id_type_check
  check (tax_id_type is null or tax_id_type in (
    'pan', 'brn', 'jp_corp', 'eu_vat', 'us_ein', 'de_steuernummer', 'other'
  ));

create index if not exists customers_country_idx
  on customers (tenant_id, country)
  where country is not null;

create index if not exists customers_tax_id_idx
  on customers (tenant_id, tax_id)
  where tax_id is not null;

comment on column customers.country is
  'ISO 3166-1 alpha-2 code of the customer entity. NULL is treated as IN for back-compat.';
comment on column customers.tax_id is
  'Buyer tax identifier (Korean BRN, Japanese T-number, German Steuernummer, US EIN, EU VAT, etc.). For Indian customers, gstin is the canonical id and tax_id stays NULL.';
comment on column customers.tax_id_type is
  'Type discriminator for tax_id. Constrained to a small enum; use ''other'' when the country is unrecognised.';

-- Same fields on customer_locations so the address-level resolver
-- (used by e-invoice JOIN, shipping labels, GST routing) can pick
-- the right format. Existing rows default to NULL = "IN".
alter table customer_locations
  add column if not exists country text,
  add column if not exists tax_id text;

create index if not exists customer_locations_country_idx
  on customer_locations (tenant_id, country)
  where country is not null;
