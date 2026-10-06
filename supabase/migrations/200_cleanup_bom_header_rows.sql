-- 200_cleanup_bom_header_rows.sql
--
-- One-off cleanup for reprinted page-header rows that earlier BOM imports
-- ingested as parts. On a multi-page BOM the column header (Part No. / Part
-- Name / Material / … / Remarks) is reprinted at the top of every page; the
-- parser only skipped the FIRST header, so each subsequent page-header row was
-- stored as a bogus part (seen in gun SRTC-2K0374). The forward fix lives in
-- _lib/bom-format.js (isHeaderRow, skipped inside mapSheet); this migration
-- removes the rows already stored before that fix.
--
-- A header row is identified exactly as the parser identifies it (isHeaderRow):
-- part_no is a PART-NO label AND part_name is a PART-NAME label. BOTH are
-- required, so a genuine part — which never carries a header label in both
-- columns — is never deleted. Normalisation mirrors the JS `norm`: lowercase,
-- collapse internal whitespace, trim.
--
-- Idempotent: re-running finds nothing. Service-role migration, so it spans all
-- tenants. item_master candidate rows for these labels are intentionally left
-- alone (harmless, and possibly referenced) — the visible artifacts are the
-- bom_lines and the derived bill_of_materials edges.

do $$
declare
  n_lines int;
  n_edges int;
  pn_labels  text[] := array['part no','part no.','part number','partno','part_no','item no','item no.','parts code'];
  nm_labels  text[] := array['part name','part_name','name','description','item name','parts name'];
begin
  -- 1) bom_lines: the header row stored as a part (part_no + part_name both labels).
  delete from bom_lines
  where btrim(regexp_replace(lower(coalesce(part_no,   '')), '\s+', ' ', 'g')) = any(pn_labels)
    and btrim(regexp_replace(lower(coalesce(part_name, '')), '\s+', ' ', 'g')) = any(nm_labels);
  get diagnostics n_lines = row_count;

  -- 2) bill_of_materials: edges whose parent/child part-no is a header label
  --    (the header row treated as a node in the parent→child graph).
  delete from bill_of_materials
  where btrim(regexp_replace(lower(coalesce(child_part_no,  '')), '\s+', ' ', 'g')) = any(pn_labels)
     or btrim(regexp_replace(lower(coalesce(parent_part_no, '')), '\s+', ' ', 'g')) = any(pn_labels);
  get diagnostics n_edges = row_count;

  raise notice 'BOM header-row cleanup: removed % bom_lines row(s), % bill_of_materials edge(s)', n_lines, n_edges;
end $$;
