-- 209_shipment_lines.sql
--
-- Inbound per-part shipment lines. `shipments` is header-grain (one row per
-- supplier invoice) with the vessel/sailing/arrival/receipt ladder on the
-- header. The logistics "In Transit Items Details" workbook also carries a
-- per-PART row (P/O, part no, qty, receipt date) which shipment_import.js has
-- so far consumed only to stamp source_po_lines.received and then discarded.
--
-- The Pending Sales Order tracker needs to attach the in-transit ladder to a
-- SPECIFIC sales-order line, and a source PO routinely splits across several
-- shipments — so a part_no→source_po→shipments join is ambiguous. Persisting
-- the per-part rows here records WHICH shipment carried each part, so a line's
-- ladder resolves exactly (via source_po_line_id / part_no) even when the PO
-- spans multiple invoices/sailings.
--
-- NOT the outbound despatch register — that is `dispatch_lines` (Anvil→customer).
-- This is the inbound leg (subsidiary→Anvil). Additive + idempotent; applied
-- MANUALLY like the rest (live DB lags the repo).

create table if not exists shipment_lines (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  shipment_id uuid not null references shipments(id) on delete cascade,
  source_po_id uuid references source_pos(id) on delete set null,
  source_po_line_id uuid references source_po_lines(id) on delete set null,
  part_no text not null,
  description text,
  qty numeric(14, 4),
  received_qty numeric(14, 4) not null default 0,
  receipt_date date,
  remark text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shipment_id, part_no)
);

create index if not exists shipment_lines_shipment_idx on shipment_lines (tenant_id, shipment_id);
create index if not exists shipment_lines_part_idx on shipment_lines (tenant_id, part_no);
create index if not exists shipment_lines_spo_line_idx on shipment_lines (source_po_line_id);

alter table shipment_lines enable row level security;
drop policy if exists "shipment_lines_select" on shipment_lines;
drop policy if exists "shipment_lines_modify" on shipment_lines;
create policy "shipment_lines_select" on shipment_lines
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
create policy "shipment_lines_modify" on shipment_lines
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create or replace function shipment_lines_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists shipment_lines_updated_at on shipment_lines;
create trigger shipment_lines_updated_at before update on shipment_lines
  for each row execute function shipment_lines_touch_updated_at();
