-- 164_drop_docai_llamacloud_columns.sql
--
-- LlamaParse is now plug-and-play like gemini/claude: keyed by the
-- LLAMA_CLOUD_API_KEY server env var and selected via docai_provider_order,
-- NOT a separate per-tenant config entity. Drop the columns migration 163
-- added (encrypted key + tier + region) — they're no longer used.
--
-- drop-if-exists so this is a no-op on DBs where 163 was never applied.

alter table tenant_settings
  drop column if exists docai_llamacloud_api_key_enc,
  drop column if exists docai_llamaparse_tier,
  drop column if exists docai_llamacloud_region;
