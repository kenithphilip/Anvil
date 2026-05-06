-- 061_customers_relational_fields.sql
--
-- Extends the customers table with the relational fields that the
-- so-intake "new customer" dialog and the customer detail screen
-- already assumed exist (so-intake reads customer.currency,
-- customer.payment_terms, customer.margin_floor_pct in the SO Intake
-- summary card).
--
-- Plus the columns flagged by the systemic-issue audit:
--   * contact_email   - read by api/agents/_handlers/ar_collect.js
--                       and api/invoices/send.js
--   * contact_phone   - read by api/_lib/inbound-chat.js
--   * credit_limit    - read by api/anomaly/compute.js
--
-- All columns nullable + idempotent so re-running is safe on every
-- environment. Backfills payment_terms from the legacy
-- default_payment_terms column so existing customers stop rendering
-- "—" in the KV row.

alter table customers
  add column if not exists currency text,
  add column if not exists payment_terms text,
  add column if not exists margin_floor_pct numeric(5, 2),
  add column if not exists bill_to text,
  add column if not exists ship_to text,
  add column if not exists contact_email text,
  add column if not exists contact_phone text,
  add column if not exists credit_limit numeric(18, 2);

update customers
set payment_terms = default_payment_terms
where payment_terms is null and default_payment_terms is not null;

-- No new indexes; these columns are display-only and don't drive any
-- joins or filters in the existing query paths.
