-- 029_docai_v2.sql
-- Document AI v2: layout-aware extraction with per-customer
-- correction loop. Replaces the single-LLM-call path documented as
-- the gap analysis #1 technical risk.
--
-- Lifecycle:
--   1. /api/docai/extract creates an `extraction_runs` row with
--      status=running, picks an adapter (Reducto, Azure DI,
--      Unstructured, Excel parser, Claude fallback), runs the
--      extraction, populates raw_extract + normalized_extract +
--      per-field confidence, flips to ok | low_confidence | failed.
--   2. Operators correcting fields write `extraction_corrections`
--      rows (one per field-level edit). When 50+ rows accumulate
--      for a (tenant, customer, field), the prompt-overrides
--      bundle on tenant_settings is rebuilt automatically and
--      future extractions for that customer prepend the bundle as
--      few-shot examples.
-- Idempotent.

create table if not exists extraction_runs (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  source_type text not null check (source_type in ('pdf','xlsx','scan','email_attachment','image','gaeb','manual')),
  source_id text,                                  -- doc id or attachment id
  source_url text,                                 -- pre-signed URL or storage path
  source_filename text,
  source_size_bytes int,
  adapter_used text,                               -- 'reducto' | 'azure_di' | 'unstructured' | 'excel' | 'claude'
  adapter_attempts jsonb default '[]'::jsonb,      -- [{adapter, status, ms, error}]
  raw_extract jsonb,                               -- adapter-specific raw output
  normalized_extract jsonb,                        -- canonical line-item shape
  field_confidences jsonb default '{}'::jsonb,     -- { field_path: 0.0..1.0 }
  confidence_overall numeric(4,3),
  status text not null default 'running' check (status in ('running','ok','low_confidence','failed')),
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  triggered_by uuid references auth.users(id),
  inbound_email_id uuid references inbound_emails(id) on delete set null
);

create index if not exists extraction_runs_tenant_idx on extraction_runs (tenant_id, started_at desc);
create index if not exists extraction_runs_customer_idx on extraction_runs (tenant_id, customer_id, started_at desc);
create index if not exists extraction_runs_status_idx on extraction_runs (tenant_id, status, started_at desc);

alter table extraction_runs enable row level security;
drop policy if exists "extraction_runs_all" on extraction_runs;
create policy "extraction_runs_all" on extraction_runs
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists extraction_corrections (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  extraction_run_id uuid not null references extraction_runs(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  field_path text not null,                       -- e.g. "lines[0].partNumber"
  original_value jsonb,
  corrected_value jsonb,
  reason text,
  user_id uuid references auth.users(id),
  applied_at timestamptz not null default now()
);

create index if not exists extraction_corrections_tenant_idx
  on extraction_corrections (tenant_id, applied_at desc);
create index if not exists extraction_corrections_customer_field_idx
  on extraction_corrections (tenant_id, customer_id, field_path, applied_at desc);

alter table extraction_corrections enable row level security;
drop policy if exists "extraction_corrections_all" on extraction_corrections;
create policy "extraction_corrections_all" on extraction_corrections
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- Provider configuration on tenant_settings.
alter table tenant_settings
  add column if not exists docai_reducto_api_key_enc bytea,
  add column if not exists docai_azure_di_endpoint text,
  add column if not exists docai_azure_di_key_enc bytea,
  add column if not exists docai_unstructured_api_key_enc bytea,
  add column if not exists docai_creds_iv bytea,
  add column if not exists docai_provider_order text[] default array['reducto','azure_di','unstructured','claude'],
  add column if not exists docai_prompt_overrides jsonb default '{}'::jsonb;
  -- shape: { "<customer_id>": { "<field_path>": [{from,to,examples:[...]}] } }
