-- Migration 107: residual Tally + Meridian PO field closures.
--
-- After the comprehensive 105 + 106 round, a fresh audit against the
-- Tally Stock Item spec and the Meridian sample PO surfaces six tiny
-- gaps. All additive, nullable, non-breaking.
--
-- Closes:
--   1. Tally section 1: `Specification Details (Yes/No)` flag.
--   2. Tally section 1: `Other Details (Yes/No)` flag.
--   3. Tally section 4: `HSN/SAC Details Source` enum.
--   4. Tally section 4: `GST Rate Details Source` enum.
--   5. Meridian PO: per-item default `inspection_required` flag.
--   6. Meridian PO: per-item default `maker` text.
--
-- The first four mirror Tally's explicit Yes/No or three-state
-- enums even when the underlying data is implicitly available
-- (item_specifications row exists, item_field_values exist) so the
-- UI can render exactly what the Tally form does. The last two
-- give each item a default for the inbound-PO-line attributes the
-- DocAI extractor will populate; per-line overrides continue to
-- live in line_items JSONB until the next refactor.

alter table item_master
  add column if not exists specification_details boolean default false,
  add column if not exists other_details boolean default false,
  add column if not exists hsn_source text check (hsn_source in ('specify', 'as_per_company', 'not_available')),
  add column if not exists gst_rate_source text check (gst_rate_source in ('specify', 'as_per_company', 'not_available')),
  add column if not exists inspection_required boolean default false,
  add column if not exists maker text;

comment on column item_master.specification_details is
  'Tally Yes/No flag. true means item_specifications carries an engineering extension. UI renders the Specifications tab visible / hidden accordingly.';
comment on column item_master.other_details is
  'Tally Yes/No flag. true means item_field_values carries custom-field overrides. UI renders the Custom fields tab visible / hidden accordingly.';
comment on column item_master.hsn_source is
  'Tally three-state fallback: specify (use hsn_sac column) / as_per_company (inherit from tenant default) / not_available (HSN not set yet).';
comment on column item_master.gst_rate_source is
  'Tally three-state fallback for GST rate: specify / as_per_company / not_available.';
comment on column item_master.inspection_required is
  'Default for the Meridian-style PO Inspection Item column. Inbound POs override per-line via line_items.inspection_required.';
comment on column item_master.maker is
  'Default for the Meridian-style PO Maker column. Inbound POs override per-line via line_items.maker.';

-- Convenience index for inspection filters on the workspace.
create index if not exists item_master_inspection_idx
  on item_master (tenant_id)
  where inspection_required = true;
