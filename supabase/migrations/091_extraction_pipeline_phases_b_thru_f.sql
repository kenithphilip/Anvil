-- 091_extraction_pipeline_phases_b_thru_f.sql
--
-- Phases B, C, D, E, F of EXTRACTION_PIPELINE_PLAN.md. Adds the
-- last persistence layer the unified pipeline needs:
--
--   B (L2 OCR feed):          extraction_ocr_layer cache.
--   C (L6 voter):              field_provenance + voter_lines on extraction_runs.
--   D (L3 templates):          customer_format_templates table.
--   E (overrides):             customer_field_overrides table.
--   F.2 (supplier ack):        supplier_ack_extractions + extraction_kind on runs.
--
-- All RLS-enabled, all idempotent.

------------------------------------------------------------------
-- Phase B: OCR layer cache. Mirror of extraction_text_layer (089)
-- but keyed on document + content hash, storing the OCR-derived
-- text. Image-only PDFs hit Mistral OCR exactly once per
-- (tenant, document); subsequent extraction runs reuse the
-- cached text. Same fall-through pattern: row absent on the
-- first run, populated on first invocation, hit on second.
------------------------------------------------------------------

create table if not exists extraction_ocr_layer (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  document_id uuid references documents(id) on delete cascade,
  content_hash text,
  ocr_status text not null check (ocr_status in ('ok','partial','failed')),
  page_count int,
  char_count int not null default 0,
  body_text text,
  page_breakdown jsonb,                            -- [{page, blocks, chars}]
  bbox_count int not null default 0,
  provider text not null default 'mistral',
  provider_model text,
  latency_ms int,
  raw_meta jsonb,                                  -- compact metadata; full bboxes still go to evidence/ocr_runs
  created_at timestamptz not null default now()
);

create unique index if not exists extraction_ocr_layer_doc_uq
  on extraction_ocr_layer (tenant_id, document_id)
  where document_id is not null;
create unique index if not exists extraction_ocr_layer_hash_uq
  on extraction_ocr_layer (tenant_id, content_hash)
  where document_id is null and content_hash is not null;
create index if not exists extraction_ocr_layer_status_idx
  on extraction_ocr_layer (tenant_id, ocr_status, created_at desc);

alter table extraction_ocr_layer enable row level security;
drop policy if exists "extraction_ocr_layer_all" on extraction_ocr_layer;
create policy "extraction_ocr_layer_all" on extraction_ocr_layer
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check  (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

------------------------------------------------------------------
-- Phase C: voter / field provenance. We persist per-field
-- provenance on extraction_runs so the diagnostics tab can render
-- "we picked Claude for customer.gstin (0.95) over Reducto (0.40)"
-- and the operator can override with one click.
--
-- field_provenance shape:
-- [{
--   "field": "customer.gstin",
--   "value": "27AAACA1234B1Z5",
--   "source": "claude",
--   "confidence": 0.95,
--   "voters": [
--     {"adapter":"claude",  "value":"27AAACA1234B1Z5", "confidence":0.95, "ok":true},
--     {"adapter":"reducto", "value":null,              "confidence":0.40, "ok":true}
--   ]
-- }, ...]
--
-- voter_lines: array of per-line { line_idx, source, line: {...} }
-- so the operator can see which adapter contributed each line.
--
-- voter_used flag indicates the run actually ran 2+ adapters and
-- voted; single-adapter runs leave it false and field_provenance
-- empty.
------------------------------------------------------------------

alter table extraction_runs
  add column if not exists field_provenance jsonb default '[]'::jsonb,
  add column if not exists voter_lines jsonb default '[]'::jsonb,
  add column if not exists voter_used boolean not null default false,
  add column if not exists ocr_layer_used boolean not null default false,
  add column if not exists template_used uuid,
  add column if not exists overrides_applied jsonb default '[]'::jsonb,
  add column if not exists extraction_kind text not null default 'po'
    check (extraction_kind in ('po','rfq','supplier_ack','invoice','eway_bill','generic'));

comment on column extraction_runs.field_provenance is
  'Phase C. Per-field winner with the full voter list. Empty when only one adapter ran.';
comment on column extraction_runs.voter_lines is
  'Phase C. Per-line provenance: which adapter contributed each line. Empty when no voter.';
comment on column extraction_runs.voter_used is
  'Phase C. True when 2+ adapters ran and the voter picked field-by-field winners.';
comment on column extraction_runs.ocr_layer_used is
  'Phase B. True when the OCR layer fed hints.bodyText for an image-only PDF.';
comment on column extraction_runs.template_used is
  'Phase D. UUID of the customer_format_templates row that contributed fields, if any.';
comment on column extraction_runs.overrides_applied is
  'Phase E. List of field paths where customer_field_overrides applied a substitution.';
comment on column extraction_runs.extraction_kind is
  'Phase F. Which downstream consumer asked for this extraction. Drives Claude prompt + validators.';

create index if not exists extraction_runs_kind_idx
  on extraction_runs (tenant_id, extraction_kind, finished_at desc)
  where extraction_kind is not null;

------------------------------------------------------------------
-- Phase D: customer format templates. After 3+ successful
-- extractions for the same customer with similar layouts, the
-- engine snapshots the extraction shape into a template row.
-- Templates carry anchor regexes and a deterministic field map so
-- subsequent extractions for that customer skip the LLM entirely.
--
-- A template scores against a document via:
--   1. Anchor matches: each (anchor_pattern, field_path) tries to
--      apply the regex to the body text. Non-empty match -> field
--      populated.
--   2. Hit / miss accounting: every run that uses a template
--      bumps `hit_count` on success or `miss_count` on a regex
--      mismatch. Miss-heavy templates auto-archive.
--
-- shape:
--   anchors = [{ field, pattern, capture_group }]
--   sample_doc_hashes = [doc1_sha256, doc2_sha256, ...]
------------------------------------------------------------------

create table if not exists customer_format_templates (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  kind text not null default 'po'
    check (kind in ('po','quote','invoice','supplier_ack','eway_bill')),
  anchors jsonb not null default '[]'::jsonb,
  line_anchors jsonb not null default '[]'::jsonb,        -- per-line repeating anchors
  sample_doc_hashes text[] not null default array[]::text[],
  hit_count int not null default 0,
  miss_count int not null default 0,
  status text not null default 'active'
    check (status in ('active','archived','draft')),
  source_run_ids uuid[] not null default array[]::uuid[],
  created_at timestamptz not null default now(),
  last_hit_at timestamptz,
  last_miss_at timestamptz,
  archived_at timestamptz
);

create index if not exists customer_format_templates_lookup_idx
  on customer_format_templates (tenant_id, customer_id, kind, status);
create index if not exists customer_format_templates_archive_idx
  on customer_format_templates (tenant_id, status, miss_count desc)
  where status = 'active';

alter table customer_format_templates enable row level security;
drop policy if exists "customer_format_templates_all" on customer_format_templates;
create policy "customer_format_templates_all" on customer_format_templates
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check  (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

------------------------------------------------------------------
-- Phase E: customer-field overrides. The corrections loop already
-- writes to extraction_corrections (029); the existing rebuild
-- only feeds Claude few-shot. Overrides apply BEFORE adapter
-- dispatch by transforming any normalized output, so every
-- adapter benefits not just Claude.
--
-- shape:
--   match_pattern  optional regex; null = "any value"
--   replacement    string; rendered into normalized.<field>
--   applied_count  bumped each time the override fires
--   confidence_floor  the minimum confidence to assert when
--                     the override applies (defaults to 0.95
--                     because the operator confirmed it)
------------------------------------------------------------------

create table if not exists customer_field_overrides (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  field_path text not null,                              -- e.g. "customer.payment_terms"
  match_pattern text,                                    -- nullable regex; null = always
  replacement text not null,
  reason text,
  applied_count int not null default 0,
  confidence_floor numeric(4,3) not null default 0.95,
  created_at timestamptz not null default now(),
  last_applied_at timestamptz,
  source_correction_ids uuid[] not null default array[]::uuid[]
);

create index if not exists customer_field_overrides_lookup_idx
  on customer_field_overrides (tenant_id, customer_id, field_path);
create unique index if not exists customer_field_overrides_uq
  on customer_field_overrides (tenant_id, customer_id, field_path, coalesce(match_pattern, ''));

alter table customer_field_overrides enable row level security;
drop policy if exists "customer_field_overrides_all" on customer_field_overrides;
create policy "customer_field_overrides_all" on customer_field_overrides
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check  (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

------------------------------------------------------------------
-- Phase F.2: supplier-ack extractions. Source POs that come back
-- as a supplier-confirmation PDF (the supplier filled in their
-- price + ETA in the format they prefer) flow through the unified
-- extraction service with extraction_kind='supplier_ack' and the
-- result is summarised into this table. The /api/source_pos/ack
-- endpoint then accepts the summary as its payload.
------------------------------------------------------------------

create table if not exists supplier_ack_extractions (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  source_po_id uuid not null references source_pos(id) on delete cascade,
  extraction_run_id uuid references extraction_runs(id) on delete set null,
  document_id uuid references documents(id) on delete set null,
  supplier_ref text,
  confirmed_price numeric(18,4),
  confirmed_currency text,
  confirmed_eta date,
  payment_terms text,
  remarks text,
  line_acks jsonb,                                       -- [{partNumber, qty, unit_price, eta}]
  status text not null default 'extracted'
    check (status in ('extracted','accepted','rejected')),
  reviewed_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create index if not exists supplier_ack_extractions_lookup_idx
  on supplier_ack_extractions (tenant_id, source_po_id, created_at desc);

alter table supplier_ack_extractions enable row level security;
drop policy if exists "supplier_ack_extractions_all" on supplier_ack_extractions;
create policy "supplier_ack_extractions_all" on supplier_ack_extractions
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check  (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
