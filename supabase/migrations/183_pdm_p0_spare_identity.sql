-- Migration 183: PDM P0 — spare-identity foundation.
--
-- Two additive changes that make "assembly X -> spare Y -> child part Z"
-- reliable and auditable on the BOMs Anvil ALREADY imports, WITHOUT any drawing
-- extraction yet (that is P1+). See the Drawing Extraction & PDM plan.
--
--   1. balloon_no / find_no on bom_lines. The ASSEMBLY drawing (the only drawing
--      shared with the customer) tags each component with a balloon number that
--      indexes its parts-list row — that balloon is how a customer names the
--      spare they want, but it was dropped on import. Additive text columns + a
--      lookup index so "balloon 12 on asset A" resolves to a part_no.
--
--   2. v_bom_where_used_recursive. The reverse of v_bom_walk_recursive (085):
--      given a child/spare part, every assembly that (transitively) contains it,
--      with per-assembly qty + min depth. This is what lets a spare child part
--      resolve back to its containing assemblies. Unlike the forward explode
--      view, this one CARRIES tenant_id so callers scope by tenant (the explode
--      view cannot — see 085 + the planning-cron workaround).
--
-- Forward-only + idempotent. No down script. Applies MANUALLY (seed-apply).

alter table bom_lines add column if not exists balloon_no text;
alter table bom_lines add column if not exists find_no text;

comment on column bom_lines.balloon_no is
  'PDM P0: the balloon / item number the assembly drawing tags this component with (the customer-facing spare identity). Free text; captured at drawing/BOM ingest.';
comment on column bom_lines.find_no is
  'PDM P0: find number / callout on the drawing when distinct from the balloon number.';

-- Lookup: "which line is balloon N on asset A".
create index if not exists bom_lines_balloon_idx
  on bom_lines (tenant_id, asset_id, balloon_no)
  where balloon_no is not null;

-- Recursive where-used: for a child part, all ancestor assemblies. Mirrors
-- v_bom_walk_recursive (085) in shape — numeric cast so the recursive column
-- type matches, depth cap 8 as a cycle guard — but walks UP the edges and
-- carries tenant_id (joining on it) for scoping.
create or replace view v_bom_where_used_recursive as
with recursive up as (
  select
    b.tenant_id,
    b.child_part_no  as part_no,          -- the component we resolve parents for
    b.parent_part_no as assembly_part_no, -- an assembly that uses it
    b.qty::numeric   as multiplier,
    1 as depth
  from bill_of_materials b
  union all
  select
    u.tenant_id,
    u.part_no,
    b.parent_part_no,
    (u.multiplier * b.qty)::numeric,
    u.depth + 1
  from up u
  join bill_of_materials b
    on b.tenant_id = u.tenant_id
   and b.child_part_no = u.assembly_part_no
  where u.depth < 8
)
select
  tenant_id,
  part_no,
  assembly_part_no,
  min(depth)      as depth,
  sum(multiplier) as total_qty
from up
group by tenant_id, part_no, assembly_part_no;

comment on view v_bom_where_used_recursive is
  'PDM P0: reverse BOM walk. For a child/spare part_no, every assembly_part_no that (transitively) contains it, with min depth + summed qty per assembly. Tenant-scoped. Reverse of v_bom_walk_recursive.';
