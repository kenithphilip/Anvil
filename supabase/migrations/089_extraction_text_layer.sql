-- 089_extraction_text_layer.sql
--
-- Phase A of the extraction-pipeline hardening plan
-- (docs/EXTRACTION_PIPELINE_PLAN.md). Adds a per-document
-- deterministic text-layer cache so the docai dispatcher can run
-- L1 (free, O(ms)) before falling through to an LLM adapter.
--
-- The flow:
--   1. /api/docai/extract receives bytes for a PDF/image.
--   2. Before dispatching to claude/reducto/azure_di, the dispatcher
--      runs L1 = unpdf text extraction. It populates this table
--      keyed by document_id (or by content hash when no document_id
--      is supplied, e.g. inline email-attachment runs).
--   3. If L1 returns >= 200 chars of usable text, the dispatcher
--      passes it as `hints.bodyText` so the adapter does NOT need
--      to send the binary PDF to the LLM. Cuts cost ~50% on
--      text-PDFs and eliminates the image_pdf_no_text failure mode
--      for any PDF that has any text layer at all.
--   4. The L5 validator pass writes results back into
--      extraction_runs.field_confidences so the workspace's
--      reconciliation tab can render per-field warnings.
--
-- We also add validator-output columns on extraction_runs so the
-- diagnostics tab + reconciliation banner can render structured
-- field-level issues without re-running validation in the browser.
--
-- Idempotent.

create table if not exists extraction_text_layer (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  document_id uuid references documents(id) on delete cascade,
  content_hash text,                              -- sha256 of the bytes; used when document_id is null
  text_status text not null
    check (text_status in ('has_text','image_only','mixed','extract_failed')),
  page_count int,
  char_count int not null default 0,
  body_text text,                                 -- nullable: omit on image_only / extract_failed
  page_breakdown jsonb,                           -- [{page, char_count, has_text}]
  extractor text not null default 'unpdf',
  extractor_version text,
  latency_ms int,
  created_at timestamptz not null default now()
);

-- One row per (tenant, document) is the common path. We keep
-- content_hash as a fallback key for the inline-attachment case
-- (no documents row yet). Partial unique to avoid duplicates on
-- both shapes without breaking the other.
create unique index if not exists extraction_text_layer_doc_uq
  on extraction_text_layer (tenant_id, document_id)
  where document_id is not null;
create unique index if not exists extraction_text_layer_hash_uq
  on extraction_text_layer (tenant_id, content_hash)
  where document_id is null and content_hash is not null;

create index if not exists extraction_text_layer_status_idx
  on extraction_text_layer (tenant_id, text_status, created_at desc);

alter table extraction_text_layer enable row level security;
drop policy if exists "extraction_text_layer_all" on extraction_text_layer;
create policy "extraction_text_layer_all" on extraction_text_layer
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- Validator output on extraction_runs. The L5 pass surfaces
-- per-field issues (malformed GSTIN, currency mismatch, line-math
-- error). We persist them so diagnostics renders without
-- re-running validation, and so the corrections loop can suggest
-- the right field path when the operator fixes one.
alter table extraction_runs
  add column if not exists validator_issues jsonb default '[]'::jsonb,
  add column if not exists validator_summary jsonb default '{}'::jsonb,
  add column if not exists text_layer_used boolean not null default false;

-- Convenience: count of issues by severity. The Pipeline
-- Diagnostics tab queries this directly.
comment on column extraction_runs.validator_issues is
  'Array of {field, code, severity, message, value}; populated by L5 validator pass.';
comment on column extraction_runs.validator_summary is
  'Counts: {error, warn, info}; convenience for diagnostics queries.';
comment on column extraction_runs.text_layer_used is
  'TRUE when the dispatcher fed L1-extracted text as hints.bodyText, skipping the binary PDF round-trip.';
