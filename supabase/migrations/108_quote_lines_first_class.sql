-- Migration 108: first-class quote_lines table.
--
-- Closes the 5 remaining UI-only partials from fresh-audit round 3
-- by giving each quote line proper columns instead of relying on
-- the `quotes.line_items` JSONB blob. Existing JSONB is left in
-- place for backward compat; new code writes to both until the
-- next-cycle migration drops the JSONB path.
--
-- Closes:
--   1. listed vs discounted unit price per line
--   2. discount percent per line (Tally + Meridian PO + Obara SO column)
--   3. CGST / SGST / IGST percent per line (queryable)
--   4. customer_part_number per line (denormalised lookup)
--   5. source_country per line (for the O/K suffix render)
--
-- Plus the quote-header partials (your_ref, attention_contact,
-- template_id) all have columns from migration 106. This migration
-- only adds the index that makes the picker fast on large quote
-- tables.

-- ---------------------------------------------------------------------------
-- 1. quote_lines: first-class per-line schema.
-- ---------------------------------------------------------------------------

create table if not exists quote_lines (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  quote_id uuid not null references quotes(id) on delete cascade,
  line_index int not null,
  part_no text,
  description text,
  qty numeric(18, 4),
  uom text,
  hsn_sac text,
  customer_part_number text,
  source_country text,
  listed_unit_price numeric(18, 4),
  discount_pct numeric(8, 6),                       -- 0.0 to 1.0, e.g., 0.02 = 2% off
  discounted_unit_price numeric(18, 4),             -- snapshot, computed by app if discount_pct given
  line_amount numeric(18, 4),                       -- qty * discounted_unit_price
  cgst_pct numeric(8, 6),
  sgst_pct numeric(8, 6),
  igst_pct numeric(8, 6),
  utgst_pct numeric(8, 6),
  cess_pct numeric(8, 6),
  remark text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, quote_id, line_index)
);

create index if not exists quote_lines_quote_idx
  on quote_lines (tenant_id, quote_id, line_index);

create index if not exists quote_lines_part_idx
  on quote_lines (tenant_id, part_no)
  where part_no is not null;

alter table quote_lines enable row level security;
drop policy if exists quote_lines_select on quote_lines;
create policy quote_lines_select on quote_lines
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists quote_lines_write on quote_lines;
create policy quote_lines_write on quote_lines
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

drop trigger if exists quote_lines_updated_at on quote_lines;
create trigger quote_lines_updated_at
  before update on quote_lines
  for each row execute function bump_updated_at();

-- ---------------------------------------------------------------------------
-- 2. quote-header picker index. Template lookup runs per quote-edit
--    open so the index makes the form load faster on large libraries.
-- ---------------------------------------------------------------------------

create index if not exists quotes_template_idx
  on quotes (tenant_id, template_id)
  where template_id is not null;

create index if not exists quotes_your_ref_idx
  on quotes (tenant_id, your_ref)
  where your_ref is not null;

-- ---------------------------------------------------------------------------
-- 3. orders.discount_pct + orders.discount_amount header fields. Some
--    customers attach a blanket discount at the order level instead
--    of per-line. Captures the Obara SO `Disc. %` column header.
-- ---------------------------------------------------------------------------

alter table orders
  add column if not exists discount_pct numeric(8, 6),
  add column if not exists discount_amount numeric(18, 4);

comment on column orders.discount_pct is
  'Blanket order-level discount fraction (0.0 to 1.0). Per-line discount lives in line_items JSONB or quote_lines.discount_pct.';
comment on column orders.discount_amount is
  'Absolute discount amount applied after line totals sum.';

-- ---------------------------------------------------------------------------
-- 4. Convenience view: quote_lines_with_totals
--    Surfaces the canonical "selling price after discount" so the
--    SO PDF + quote PDF can pull a consistent number without
--    duplicating the calc in the renderer.
-- ---------------------------------------------------------------------------

-- DROP before CREATE OR REPLACE so future migrations that add
-- columns to quote_lines do not trip Postgres's "cannot change
-- name of view column" rule (same trap that 105's items_full_v
-- hit when 107 added item_master.specification_details).
drop view if exists quote_lines_with_totals;

create or replace view quote_lines_with_totals as
  select
    ql.*,
    case
      when ql.discounted_unit_price is not null then ql.discounted_unit_price
      when ql.listed_unit_price is not null and ql.discount_pct is not null
        then ql.listed_unit_price * (1.0 - coalesce(ql.discount_pct, 0))
      else ql.listed_unit_price
    end as effective_unit_price,
    coalesce(ql.qty, 0) * coalesce(
      ql.discounted_unit_price,
      case
        when ql.listed_unit_price is not null and ql.discount_pct is not null
          then ql.listed_unit_price * (1.0 - coalesce(ql.discount_pct, 0))
        else ql.listed_unit_price
      end,
      0
    ) as computed_line_amount,
    coalesce(ql.cgst_pct, 0) + coalesce(ql.sgst_pct, 0) + coalesce(ql.igst_pct, 0) + coalesce(ql.utgst_pct, 0) + coalesce(ql.cess_pct, 0) as total_tax_pct
  from quote_lines ql;
