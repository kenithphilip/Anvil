-- 151_nav_visibility.sql
--
-- Per-tenant, per-role navigation visibility. Admins choose which left-nav
-- items (and the screens behind them) are activated for each role. We store
-- the DISABLED set per role so any nav item added in a future release stays
-- visible by default (opt-out, not opt-in).
--
-- Shape: { "<role>": ["<nav_id>", ...], ... }
--   e.g. { "finance": ["leads","opps"], "operator": ["forecasts"] }
-- An empty object (default) means every item is visible to every role
-- (still intersected with each role's existing RBAC permissions).
--
-- Read via tenantSettings(); written by /api/admin/nav_settings (PATCH,
-- approve-level). See src/v3-app/lib/nav-settings.ts for the client mirror.

alter table tenant_settings
  add column if not exists nav_disabled jsonb not null default '{}'::jsonb;
