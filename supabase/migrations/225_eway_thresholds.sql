-- Migration 225: e-way bill thresholds as tenant settings.
--
-- The pre-send dispatch-readiness check (src/api/_lib/dispatch-readiness.js)
-- needs to know whether a consignment requires an e-way bill before the invoice
-- goes out. That turns on consignment value, and the figure is jurisdictional:
-- inter-state movement uses one threshold, while intra-state thresholds are set
-- per state and genuinely differ between them.
--
-- So it is a SETTING, not a constant in code. Hard-coding one number would be
-- wrong for most tenants and would read as a legal assertion the codebase is in
-- no position to make. The defaults below exist so the check can run at all;
-- they are a starting point for a tenant to confirm against their own
-- jurisdiction, NOT advice that they are correct.
--
-- NULL is meaningful and deliberately allowed: the module falls back to its own
-- documented default when a column is null, and REFUSES to decide (rather than
-- passing the line) when the consignment value or the place of supply cannot be
-- determined at all. A silent pass on a detainable consignment is the worst
-- outcome available, so absence must never read as "not required".
--
-- Additive + idempotent.

alter table tenant_settings
  add column if not exists eway_threshold_inr numeric(14, 2) default 50000,
  add column if not exists eway_threshold_intrastate_inr numeric(14, 2) default 50000;

comment on column tenant_settings.eway_threshold_inr is
  'Consignment value at or above which an e-way bill is required for INTER-state movement. Default 50000 is a starting point to confirm per jurisdiction, not legal advice. NULL falls back to the module default.';

comment on column tenant_settings.eway_threshold_intrastate_inr is
  'Consignment value at or above which an e-way bill is required for INTRA-state movement. Set per state: these thresholds differ between states. Default 50000 is a starting point to confirm, not legal advice. NULL falls back to the module default.';
