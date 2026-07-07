-- 163_docai_llamacloud_provider.sql
--
-- Pluggable document-AI providers (issue #210): store per-tenant LlamaCloud
-- (LlamaParse / LlamaExtract) config so an admin can switch it on as an
-- extraction adapter. OFF by default — the adapter only runs when the
-- tenant has both a key AND has added "llamaparse" to docai_provider_order.
--
--   docai_llamacloud_api_key_enc : the LlamaCloud API key, encrypted with
--                                  the shared docai_creds_iv (same pattern
--                                  as docai_gemini_api_key_enc / reducto).
--   docai_llamaparse_tier        : fast | cost_effective | agentic | agentic_plus
--   docai_llamacloud_region      : us | eu  (LlamaCloud has no India region;
--                                  the admin UI warns on data residency).
--
-- Additive + idempotent. docai_creds_iv already exists (migration for the
-- gemini/reducto creds).

alter table tenant_settings
  add column if not exists docai_llamacloud_api_key_enc bytea,
  add column if not exists docai_llamaparse_tier text,
  add column if not exists docai_llamacloud_region text;

comment on column tenant_settings.docai_llamacloud_api_key_enc is
  'LlamaCloud (LlamaParse/LlamaExtract) API key, encrypted with the shared docai_creds_iv. Opt-in provider (issue #210).';
comment on column tenant_settings.docai_llamaparse_tier is
  'LlamaParse parse tier: fast | cost_effective | agentic | agentic_plus (default cost_effective).';
comment on column tenant_settings.docai_llamacloud_region is
  'LlamaCloud data region: us | eu. No India region — surfaced as a residency warning in Admin.';
