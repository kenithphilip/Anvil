-- 169_fix_legacy_docai_provider_order.sql
--
-- Close the migration-098 gap. 098 set the gemini-first default order ONLY
-- `where docai_provider_order is null`, so tenants that already had a
-- PRE-GEMINI explicit order were never migrated forward. Those tenants are
-- stranded: the only adapter in their order with a key is claude, so every
-- extraction dead-ends on it (and any Anthropic hiccup fails the whole run),
-- while gemini / llamaparse — which DO have keys — never run because they're
-- not in the order.
--
-- Reset that specific known-bad legacy value to the current gemini-first
-- default. Targeted exact-match so we never clobber a deliberately-customised
-- order; llamaparse stays OPT-IN (not added here) — enable it per-tenant via
-- Admin > Document AI. Idempotent: after the update the row no longer matches,
-- so re-running is a no-op.

update tenant_settings
  set docai_provider_order = array['gemini','docling','marker','unstructured','azure_di','reducto','claude']::text[]
  where docai_provider_order = array['reducto','azure_di','unstructured','claude']::text[];
