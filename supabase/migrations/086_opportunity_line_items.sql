-- 086_opportunity_line_items.sql
--
-- Phase 1 of the inventory-planning module. Opportunities today
-- carry only a header amount (`amount_inr`) and a `stage` enum;
-- the pipeline-demand engine (docs/INVENTORY_PLANNING_DESIGN.md
-- section 2.7) needs structured line items in the operator's
-- vocabulary: product_family, product_category, qty.
--
-- Joel's example shape (resolved Q7):
--   "x2c Gun, 1 qty; JC ATD, 1 qty; adaptive_dc Timer, 1 qty"
--
-- The table is additive: existing opportunities continue to work
-- without lines (the pipeline engine just contributes 0 demand
-- from them). Operators populate lines via the opportunity-detail
-- screen as they qualify deals.
--
-- Idempotent.

create table if not exists opportunity_line_items (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  opportunity_id uuid not null references opportunities(id) on delete cascade,
  line_index int not null,
  -- The operator's vocabulary. `product_family` is the broad
  -- bucket (Gun, ATD, Timer, Spare, Service); `product_category`
  -- is the model / variant within the family (x2c, JC,
  -- adaptive_dc, etc.).
  product_family text not null,
  product_category text,
  -- Optional resolved part_no. Populated when the operator picks
  -- an item_master row, or when the engine matches by alias.
  -- NULL means "we know the family/category but not the SKU yet";
  -- the engine falls back to the (family, category) -> part_no
  -- map maintained on item_master.
  part_no text,
  description text,
  qty numeric(14,4) not null check (qty > 0),
  uom text not null default 'pcs',
  -- Pre-negotiation pricing. Both nullable: opportunities are
  -- often opened before the supplier price is set.
  expected_unit_price numeric(18,4),
  expected_currency text default 'INR',
  -- Per-line close date overrides the opportunity header. Useful
  -- when an opp has a phased delivery (gun ships in Q3, ATD in Q4).
  expected_close_date date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (opportunity_id, line_index)
);

create index if not exists opportunity_line_items_part_idx
  on opportunity_line_items (tenant_id, part_no, expected_close_date)
  where part_no is not null;
create index if not exists opportunity_line_items_family_idx
  on opportunity_line_items (tenant_id, product_family, product_category);
create index if not exists opportunity_line_items_opp_idx
  on opportunity_line_items (opportunity_id, line_index);

alter table opportunity_line_items enable row level security;
drop policy if exists "opportunity_line_items_select" on opportunity_line_items;
drop policy if exists "opportunity_line_items_modify" on opportunity_line_items;
create policy "opportunity_line_items_select" on opportunity_line_items
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
create policy "opportunity_line_items_modify" on opportunity_line_items
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create or replace function opportunity_line_items_touch_updated_at()
  returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists opportunity_line_items_updated_at on opportunity_line_items;
create trigger opportunity_line_items_updated_at before update on opportunity_line_items
  for each row execute function opportunity_line_items_touch_updated_at();
