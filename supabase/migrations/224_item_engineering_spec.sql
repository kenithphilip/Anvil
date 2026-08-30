-- Migration 224: give the drawing's engineering spec somewhere to live.
--
-- The part_drawing extractor already reads the hardest part of a drawing --
-- finish (coating / plating / Ra), heat treatment, the dimensional tolerance
-- table, and the GD&T feature-control frames -- and every one of those was
-- consumed by NOTHING. They existed only as JSON inside
-- extraction_runs.normalized_extract; the only downstream reader
-- (_lib/pdm/raw-material-infer.js) takes material, dimensions and bought_out
-- and ignores the rest. So Anvil paid a model to read the spec and threw the
-- answer away.
--
-- The code comment in the extractor promised "ingestion into
-- item_specifications + engineering EAV fields". item_specifications
-- (migration 105) has no such columns -- this adds them.
--
-- Shape: the two scalars that are genuinely scalar get text columns so they can
-- be filtered and grouped (finish and heat treatment drive supplier choice and
-- routing); the two lists stay jsonb because a tolerance table and a set of
-- feature-control frames are lists of small records whose shape belongs to the
-- extractor, not to the schema.
--
-- Provenance is recorded alongside, the same way ingest_source distinguishes an
-- Anvil-authored quote from an extracted one: an operator must be able to tell
-- a value a model read off a drawing from one a person typed, and a later
-- extraction must not silently overwrite a human correction.
--
-- Additive + idempotent. Every column is nullable with no default beyond the
-- empty list, so existing rows and every existing writer are unaffected.

alter table item_specifications
  add column if not exists finish text,
  add column if not exists heat_treatment text,
  add column if not exists tolerances jsonb not null default '[]'::jsonb,
  add column if not exists gdt jsonb not null default '[]'::jsonb,
  add column if not exists drawing_notes jsonb not null default '[]'::jsonb,
  -- 'drawing' = read from a part-drawing extraction; null = typed by a person
  -- in the item drawer (the only writer before this migration).
  add column if not exists spec_source text,
  add column if not exists spec_extraction_run_id uuid,
  add column if not exists spec_captured_at timestamptz;

comment on column item_specifications.finish is
  'Surface finish as printed on the drawing (coating / plating / Ra). Populated from a part_drawing extraction, or typed. See spec_source.';
comment on column item_specifications.heat_treatment is
  'Heat treatment as printed on the drawing. See spec_source.';
comment on column item_specifications.tolerances is
  'Dimensional tolerance table from the drawing: [{feature, nominal, tolerance}].';
comment on column item_specifications.gdt is
  'GD&T feature-control frames from the drawing: [{symbol, tolerance, datum}].';
comment on column item_specifications.drawing_notes is
  'Verbatim drawing notes, in order.';
comment on column item_specifications.spec_source is
  'Where the engineering spec came from: ''drawing'' (part_drawing extraction) or null (typed by a person). A later extraction must not silently overwrite a human-entered spec.';
comment on column item_specifications.spec_extraction_run_id is
  'The extraction_runs row this spec was read from, for provenance. No FK: extraction runs are prunable and a pruned run must not cascade away the spec it produced.';
