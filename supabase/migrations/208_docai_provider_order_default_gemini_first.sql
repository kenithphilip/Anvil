-- 208_docai_provider_order_default_gemini_first.sql
--
-- Incident 2026-08-07: a PO extraction failed because the tenant's
-- docai_provider_order was the LEGACY pre-gemini order
-- ['reducto','azure_di','unstructured','claude']. Only `claude` has an API key,
-- so a transient Anthropic 5xx dead-ended the whole run while gemini / llamaparse
-- (which DO have keys) were never reached — they were appended as fallbacks but
-- skipped run_budget_exhausted after Claude's retries ate the deadline.
--
-- Migration 169 reset existing rows holding that EXACT legacy value to the
-- gemini-first order, but neither 098 nor 169 changed the COLUMN DEFAULT set in
-- 029. So the default is still the legacy order, and any tenant_settings row
-- created since 169 inherits the known-bad order again — which is how this
-- recurred.
--
--   1. Flip the column default to the current gemini-first order.
--   2. Re-run the 169 reset for any legacy rows that have appeared since
--      (targeted exact-match so a deliberately-customised order is never
--      clobbered; idempotent — after the update the row no longer matches).
--
-- Additive + idempotent. Applied MANUALLY like the rest (live DB lags the repo).
-- llamaparse stays OPT-IN (not added here) — enable per-tenant via
-- Admin > Document AI. This is defence-in-depth alongside the callAnthropic
-- run-budget guard (a failing provider can no longer starve the fallbacks even
-- if a bad order slips through).

alter table tenant_settings
  alter column docai_provider_order
  set default array['gemini', 'docling', 'marker', 'unstructured', 'azure_di', 'reducto', 'claude']::text[];

update tenant_settings
   set docai_provider_order = array['gemini', 'docling', 'marker', 'unstructured', 'azure_di', 'reducto', 'claude']::text[]
 where docai_provider_order = array['reducto', 'azure_di', 'unstructured', 'claude']::text[];
