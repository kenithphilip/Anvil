-- 211_shipment_lines_flexible.sql
--
-- The logistics "In Transit Items Details" workbook is one sheet per source
-- country (Japan, China, Korea, Thailand, France) and the sheets do not agree
-- with each other. Auditing the real file against the importer found three
-- things this migration makes storable, and one it makes visible.
--
-- 1. part_no NOT NULL rejected 763 real rows. The sheets disagree about where
--    the part code lives:
--      Thailand  672 rows: Part Number blank, code inside DESCRIPTION
--                          ("SB36466 OIL SEAL", "PSD-100 SEAL")
--      Japan/Korea         P/O blank, part present
--      China               P/O column carries free text ("Replacement items")
--    Those are real goods in transit. Requiring a part number dropped them
--    entirely, so a customer asking about a Thai part got "no match" while the
--    row sat in the spreadsheet.
--
--    part_no becomes nullable. It is NOT back-filled from the description:
--    mining a code out of prose is what turned "TWS-092-90-2" into "90-2" on
--    the PO side (#424). A row with only a description is stored with only a
--    description, and the part search already matches on description.
--
-- 2. Dedupe needs a key that survives a null part_no. `line_key` is the part
--    number when there is one and the description otherwise, so the importer's
--    upsert stays idempotent for both shapes — re-uploading the same workbook
--    still updates rather than duplicates. Generated, so it cannot drift from
--    the columns it is derived from.
--
-- 3. source_country was thrown away. It exists only as the SHEET NAME, and the
--    importer read sheet names for diagnostics only. For a tenant importing on
--    KR/CN/JP corridors that is the dimension you would actually slice by.
--
-- Additive and idempotent; applied MANUALLY like the rest (live DB lags repo).

alter table shipment_lines
  add column if not exists source_country text;

comment on column shipment_lines.source_country is
  'Origin, taken from the workbook sheet name (Japan/China/Korea/Thailand/France). Null for sheets that do not name one.';

-- Nullable part_no: a description-only row is still a real shipment line.
alter table shipment_lines
  alter column part_no drop not null;

-- Identity for dedupe: part number when present, description otherwise.
alter table shipment_lines
  add column if not exists line_key text
  generated always as (
    coalesce(nullif(btrim(part_no), ''), nullif(btrim(description), ''))
  ) stored;

comment on column shipment_lines.line_key is
  'Dedupe identity: part_no when present, else description. Keeps the import upsert idempotent for rows with no part number.';

-- Swap the unique onto the key that tolerates a null part_no. The old
-- constraint would have let description-only rows duplicate on every re-upload,
-- because NULL never equals NULL in a unique index.
alter table shipment_lines
  drop constraint if exists shipment_lines_shipment_id_part_no_key;

create unique index if not exists shipment_lines_shipment_line_key
  on shipment_lines (shipment_id, line_key);

create index if not exists shipment_lines_country_idx
  on shipment_lines (tenant_id, source_country);
