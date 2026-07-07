-- 165_llm_provider_settings.sql
--
-- P2 of the app-wide LLM provider abstraction: per-tenant provider choice
-- for the reasoning/generation features routed through callLLM().
--
--   llm_provider           : tenant-wide default engine ('claude' | 'gemini').
--   llm_provider_overrides : { "<feature>": "claude"|"gemini" } per-feature
--                            override (e.g. keep the copilot on claude but
--                            run email_classifier on gemini).
--
-- Precedence in the router: explicit arg > per-feature override (this) >
-- LLM_PROVIDER_<FEATURE> env > tenant llm_provider (this) > LLM_PROVIDER env
-- > "claude". NULL/empty here means "fall through to env/default", so this
-- is additive and changes nothing until an admin sets it.

alter table tenant_settings
  add column if not exists llm_provider text,
  add column if not exists llm_provider_overrides jsonb not null default '{}'::jsonb;

comment on column tenant_settings.llm_provider is
  'Per-tenant default LLM engine for callLLM features (claude|gemini). NULL = use env/default.';
comment on column tenant_settings.llm_provider_overrides is
  'Per-feature LLM engine overrides: { "<feature>": "claude"|"gemini" } (migration 165).';
