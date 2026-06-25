-- 152_quote_default_validity.sql
--
-- Tenant-level default for new-quote validity. Admins set it under Admin
-- Center > Settings. Used as the fallback when a quote is created without an
-- explicit validity AND the customer has no default_quote_validity_days of
-- its own. Null = fall back to the hard-coded 30 days.
--
-- Precedence: explicit value > customers.default_quote_validity_days >
--   tenant_settings.quote_default_validity_days > 30.
--
-- Read/written via /api/admin/quote_settings (GET read / PATCH approve).

alter table tenant_settings
  add column if not exists quote_default_validity_days int;
