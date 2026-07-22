-- Issue #210: admin-switchable per-tenant document-AI providers — the key
-- write-path. Most provider key columns already exist (docai_gemini /
-- reducto / unstructured / docling / marker / llamacloud _api_key_enc, sharing
-- docai_creds_iv). Two were read by their adapters but never had a column:
--   - docai_mistral_api_key_enc  — Mistral OCR (was env-only)
--   - gst_provider_api_key_enc   — the GST registry provider (issue #186)
-- Both are encrypted with the shared docai_creds_iv envelope, so the admin
-- DocAI-Providers panel can now store every provider's key the same way.

alter table tenant_settings
  add column if not exists docai_mistral_api_key_enc bytea,
  add column if not exists gst_provider_api_key_enc bytea;

comment on column tenant_settings.docai_mistral_api_key_enc is
  'Per-tenant Mistral (OCR) API key. Encrypted with the shared docai_creds_iv; '
  'falls back to the MISTRAL_API_KEY env var when unset.';
comment on column tenant_settings.gst_provider_api_key_enc is
  'Per-tenant GST registry provider API key (issue #186). Encrypted with the '
  'shared docai_creds_iv; default-deny (no registry lookup) when unset.';
