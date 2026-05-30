-- Supplier identity on a quote-line price composition.
--
-- The composition row already carries supplier_unit_price /
-- supplier_currency / supplier_quote_no, but not WHICH supplier the
-- price came from -- operators had no way to tell two lines apart
-- when the same item is sourced from different vendors. This adds a
-- free-text supplier_name column (kept loose for v1; a future PR can
-- link it to a suppliers master).
--
-- Additive + idempotent. Existing rows get NULL by default.

alter table price_composition_lines
  add column if not exists supplier_name text;

comment on column price_composition_lines.supplier_name is
  'Free-text supplier identifier (e.g. "Obara Korea", "Anil Steel"). A future migration may link this to a suppliers master.';
