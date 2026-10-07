-- Migration 248: a fallback Gemini model for when the selected one is overloaded.
--
-- Adds tenant_settings.docai_gemini_fallback_model (nullable text).
--
-- WHY. On 2026-10-06 and 2026-10-07 one 6-page PO was extracted five times.
-- Each time the Gemini model it routes to answered 503 "This model is currently
-- experiencing high demand", and each time the run fell through to a document
-- parser that missed the header and split every item into four lines. Overload
-- is per MODEL, so callGemini now tries a second Gemini model once, at once,
-- instead of backing off against the same one (src/api/_lib/gemini.js, with the
-- model picked by selectGeminiFallbackModel in src/api/_lib/docai/model_selector.js).
--
-- Values:
--   NULL            the default: the deployment's generation-tier model, then
--                   its preflight-tier model (GEMINI_MODEL_DEFAULT /
--                   GEMINI_MODEL_PREFLIGHT), whichever is not the primary. A
--                   tenant that pinned docai_gemini_model gets none.
--   'gemini-...'    that model.
--   'none' / 'off'  no fallback model; one short retry of the same model.
--
-- Additive and idempotent. NULL for every tenant, and the code reads a missing
-- column as NULL, so applying this late changes nothing until a value is set.
-- Number: 228-231 are reserved by the accounts/assets plan, 232-242 by the
-- Tally design (#553), and 243 is left for the planned security-views fix.

alter table tenant_settings
  add column if not exists docai_gemini_fallback_model text;

comment on column tenant_settings.docai_gemini_fallback_model is
  'Gemini model to try once when the selected model answers 503 overloaded / high demand. NULL = the deployment generation-tier model (then preflight) when distinct from the primary; none/off = no fallback model. See selectGeminiFallbackModel in src/api/_lib/docai/model_selector.js.';
