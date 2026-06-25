-- 153_quote_line_option_lists.sql
--
-- Admin-defined option lists for quote line-item variables. Admins maintain
-- these under Admin Center > Settings; the quote Lines editor surfaces them
-- as dropdowns (datalists) for Units and Source country so operators pick
-- from a controlled vocabulary instead of free-typing.
--
-- Stored as JSON string arrays on tenant_settings. Empty array = no defined
-- list (the field stays free-text). Read/written via /api/admin/quote_settings.

alter table tenant_settings
  add column if not exists quote_line_units jsonb not null default '[]'::jsonb;

alter table tenant_settings
  add column if not exists quote_line_source_countries jsonb not null default '[]'::jsonb;
