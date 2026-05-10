-- 099_extraction_runs_parse_method.sql
--
-- Bet 4: schema-aligned parsing. Replace ad-hoc JSON parsing
-- across the docai pipeline with a shared SAP-style parser
-- (parseSchemaAligned) that handles trailing commas, fences,
-- chain-of-thought prefix/suffix, unquoted keys, and retries on
-- validation failure.
--
-- The migration only adds telemetry columns to extraction_runs so
-- the diagnostics tab can chart parse_method trends. The actual
-- parser logic lives in src/api/_lib/docai/parse.js.
--
-- Per docs/STRATEGIC_BET_04_schema_aligned_parsing.md.
--
-- Idempotent.

alter table extraction_runs
  add column if not exists parse_method text,
  add column if not exists parse_retries smallint not null default 0,
  add column if not exists parse_repairs text[] not null default '{}'::text[];

-- Drop / recreate the parse_method CHECK so re-runs are safe.
alter table extraction_runs
  drop constraint if exists extraction_runs_parse_method_check;
alter table extraction_runs
  add constraint extraction_runs_parse_method_check
  check (parse_method is null or parse_method in (
    'native_structured',  -- Anthropic output_config / Gemini responseSchema
    'tool_use',            -- legacy Anthropic tool_use path
    'sap_repaired',        -- raw text + SAP repair pass succeeded
    'sap_zod_retry',       -- repair failed once, validation-error retry succeeded
    'failed'
  ));

-- Partial index for the diagnostics-tab trend sparkline. Filtering
-- on `parse_method is not null` keeps the index lean for the rows
-- that actually carry the new telemetry.
create index if not exists extraction_runs_parse_method_idx
  on extraction_runs (tenant_id, parse_method, finished_at desc)
  where parse_method is not null;

comment on column extraction_runs.parse_method is
  'Bet 4: which parse path the adapter took. native_structured = vendor JSON Schema constrained generation; tool_use = Anthropic legacy tool_use; sap_repaired = SAP repair pass succeeded on first try; sap_zod_retry = SAP failed, retry-with-validation-error succeeded; failed = both attempts failed.';
comment on column extraction_runs.parse_retries is
  'Bet 4: how many round-trips to the model the parser made before success (0 = first try worked).';
comment on column extraction_runs.parse_repairs is
  'Bet 4: enumerated repairs the SAP pass applied. Examples: trailing_comma, fences, prose_prefix, prose_suffix, unquoted_keys, truncated. Empty array when native parse worked.';
