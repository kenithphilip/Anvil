-- 156_quote_currencies_list.sql
--
-- Admin-definable currency list for quote/composition/RFQ currency pickers.
-- Sibling to quote_line_units + quote_line_source_countries (migration 153);
-- empty array => the field stays free-text (the client falls back to a small
-- default set so the dropdown is never empty). Managed under Admin > Settings.

alter table tenant_settings
  add column if not exists quote_currencies jsonb not null default '[]'::jsonb;
