-- Dispatch register — per-line despatched quantity, mirrored from the ERP.
--
-- §4 of docs/CUSTOMER_COMMS_DESIGN.md was the one real data gap: Anvil had
-- `shipments` (header grain — one row per consignment) and
-- `order_schedule_lines` (per line, but the PROMISED qty), and NOTHING recording
-- what was actually DESPATCHED against each PO line. A dispatch register "40 of
-- 100 despatched on 12 Mar under LR 4471, per PO line 3" could not be produced.
--
-- Joel confirmed SCM's ERP (Tally) delivery-note / despatch entry carries the
-- per-line quantity. So this is option (a): MIRROR that voucher rather than add
-- a capture screen (which would be double entry SCM would resent). One row per
-- despatched line, keyed to the order and — when the ERP gives us a stable
-- line ref — to the schedule line it fulfils. All additive + nullable.
--
-- Populated by any importer (a future Tally "delivery_note" sync entity, a CSV
-- import, or a manual entry) via _lib/dispatch-lines.js. The customer-facing
-- register is assembled by _lib/dispatch-register.js.

create table if not exists dispatch_lines (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id uuid references orders(id) on delete cascade,
  -- The header consignment this line shipped on, when known.
  shipment_id uuid references shipments(id) on delete set null,
  -- Which PO line this despatch fulfils. line_index is the 0-based ordinal into
  -- the order's PO line items (orders.result.salesOrder.lineItems[]) — the same
  -- per-line key order_schedule_lines and order_line_tax_components use. The
  -- register matches on it, then falls back to part_no, then lists the despatch
  -- on its own. Both nullable: the ERP voucher may carry neither.
  -- schedule_line_id optionally ties a despatch to a delivery-schedule row.
  schedule_line_id uuid references order_schedule_lines(id) on delete set null,
  line_index int,
  part_no text,
  description text,
  dispatched_qty numeric(18, 4) not null default 0,
  uom text,
  dispatch_date date,
  lr_number text,                 -- transporter LR / consignment note
  carrier text,
  invoice_number text,            -- the ERP invoice this despatch was billed on
  invoice_date date,
  -- Idempotency key for re-sync. The IMPORTER composes this as the ERP voucher
  -- identity PLUS the line ref (e.g. 'DN-4471#3'), so it is unique PER LINE.
  -- Deliberately one column, not (voucher, line_index): line_index is nullable
  -- and NULL is distinct in a unique index, so a (voucher, line_index) key would
  -- fail to dedupe exactly the rows that lack a line ref.
  source_ref text,
  source_document_id uuid references documents(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Re-syncing the same delivery note updates rather than duplicates. Partial so
-- manually-entered rows (no source_ref) are never collapsed into one another.
create unique index if not exists dispatch_lines_source_uk
  on dispatch_lines (tenant_id, source_ref)
  where source_ref is not null;

create index if not exists dispatch_lines_order_idx
  on dispatch_lines (tenant_id, order_id, dispatch_date);
create index if not exists dispatch_lines_shipment_idx
  on dispatch_lines (tenant_id, shipment_id) where shipment_id is not null;

alter table dispatch_lines enable row level security;
drop policy if exists dispatch_lines_select on dispatch_lines;
create policy dispatch_lines_select on dispatch_lines
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists dispatch_lines_write on dispatch_lines;
create policy dispatch_lines_write on dispatch_lines
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

comment on table dispatch_lines is
  'Per-line despatched quantity mirrored from the ERP delivery-note / despatch '
  'voucher (docs/CUSTOMER_COMMS_DESIGN.md item 5). Header consignment lives in '
  'shipments; the promised qty in order_schedule_lines; this is what actually '
  'shipped per PO line. source_ref = ERP voucher id + line ref, for idempotent '
  're-sync.';
