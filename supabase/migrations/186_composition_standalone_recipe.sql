-- PDM raw-material determination (Slice D2): allow STANDALONE, drawing-derived
-- recipes in composition_material_lines.
--
-- The table was born quote-scoped: unique (tenant_id, quote_id,
-- composition_line_index, seq). A recipe determined from a PART DRAWING is not
-- tied to a quote (quote_id null) and should be keyed by the finished part it
-- makes. Two different finished parts at (null, 0, 0) would collide under the
-- old constraint, so we split uniqueness into two partial indexes:
--   • quote-scoped recipes keep the exact same key (only where quote_id NOT null)
--   • standalone recipes are unique per (finished_part_no, raw_material_part_no)
-- Nothing about existing quote-scoped rows changes.

do $$
declare cname text;
begin
  -- Find the 4-column unique constraint by its exact column set (name is
  -- Postgres-truncated + deployment-specific, so match on columns not name).
  select c.conname into cname
    from pg_constraint c
   where c.conrelid = 'composition_material_lines'::regclass
     and c.contype = 'u'
     and (
       -- attname is `name`, not `text`; without the cast this comparison is
       -- `name[] = text[]`, which has no operator (42883) and aborts the migration.
       select array_agg(a.attname::text order by a.attname::text)
         from unnest(c.conkey) k
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k
     ) = array['composition_line_index','quote_id','seq','tenant_id'];
  if cname is not null then
    execute format('alter table composition_material_lines drop constraint %I', cname);
  end if;
end $$;

-- Quote-scoped recipes: same uniqueness as before, now only where a quote is set.
create unique index if not exists comp_material_lines_quote_uk
  on composition_material_lines (tenant_id, quote_id, composition_line_index, seq)
  where quote_id is not null;

-- Standalone (drawing-derived) recipes: one row per finished part + raw material.
create unique index if not exists comp_material_lines_standalone_uk
  on composition_material_lines (tenant_id, finished_part_no, raw_material_part_no)
  where quote_id is null and finished_part_no is not null;
