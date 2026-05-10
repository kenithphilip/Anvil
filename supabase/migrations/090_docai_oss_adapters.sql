-- 090_docai_oss_adapters.sql
--
-- Phase C of EXTRACTION_PIPELINE_PLAN.md. Adds tenant-settings
-- columns for the three self-hostable open-source adapters:
--
--   - Docling (IBM, MIT). Strong on complex tables; runs as
--     `docling-serve` FastAPI on the operator's infra. Configure
--     with `docai_docling_endpoint` (the FastAPI URL); the API
--     key is optional (only when DOCLING_SERVE_API_KEY is set on
--     the server side).
--
--   - Marker (Datalab.to, Apache 2.0). Strong on OCR + layout.
--     Two modes: `self_hosted` (community FastAPI) or `datalab`
--     (hosted, paid). Mode is stamped on `docai_marker_mode`. The
--     API key is required for datalab mode and optional for
--     self-hosted (defaults to no-auth for the OSS server).
--
--   - Unstructured.io (Apache 2.0). Already wired against the
--     hosted API; this migration adds the endpoint override so
--     operators can point it at the Docker OSS server. Reuses the
--     existing `docai_unstructured_api_key_enc` column for hosted
--     auth; the OSS path uses no key.
--
-- All three adapters fall through cleanly when not configured: the
-- dispatcher's existing isConfigured() loop skips them and tries
-- the next adapter in `docai_provider_order`. Cost-wise, all three
-- are zero per-page when self-hosted (compute is on the operator).
--
-- Idempotent.

alter table tenant_settings
  add column if not exists docai_docling_endpoint text,
  add column if not exists docai_docling_api_key_enc bytea,
  add column if not exists docai_marker_endpoint text,
  add column if not exists docai_marker_api_key_enc bytea,
  add column if not exists docai_marker_mode text
    check (docai_marker_mode is null or docai_marker_mode in ('self_hosted','datalab')),
  add column if not exists docai_unstructured_endpoint text;

comment on column tenant_settings.docai_docling_endpoint is
  'HTTP base URL for docling-serve (e.g. https://docling.internal). Empty = adapter disabled.';
comment on column tenant_settings.docai_docling_api_key_enc is
  'Optional X-Api-Key for docling-serve. Encrypted with the shared docai_creds_iv.';
comment on column tenant_settings.docai_marker_endpoint is
  'HTTP base URL for marker (self-hosted FastAPI, or datalab.to). Empty = adapter disabled.';
comment on column tenant_settings.docai_marker_api_key_enc is
  'API key for marker; required when docai_marker_mode=datalab. Encrypted with docai_creds_iv.';
comment on column tenant_settings.docai_marker_mode is
  'Marker deployment mode: self_hosted (community FastAPI) or datalab (paid hosted).';
comment on column tenant_settings.docai_unstructured_endpoint is
  'Override for the unstructured.io endpoint. Set to a self-hosted Docker URL to bypass the hosted API.';
