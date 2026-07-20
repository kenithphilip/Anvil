-- Migration 181: customer_receipts — the seller-side GRN / SRN capture that
-- gates cash (Delivery-to-Cash P0). See docs/DELIVERY_TO_CASH_DESIGN.md.
--
-- When we ship to a customer, THEIR stores post a Goods Receipt Note (GRN, for
-- goods) or a Service Receipt / Service Entry Sheet (SRN/SES, for services) in
-- THEIR ERP, dated. That receipt number + date is what unlocks their payment
-- (terms usually clock off the GRN date, not the invoice date). Anvil already
-- has the BUYER-side 3-way match (ap_goods_receipts, migration 054); this is the
-- SELLER-side mirror: one row per customer receipt against one of our invoices,
-- captured from an emailed GRN (via the DocAI pipeline), a portal entry, EDI, or
-- manually. Additive; no change to invoices / dunning.

create table if not exists customer_receipts (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  -- One of invoice_id / einvoice_id is set once matched (two invoice tables:
  -- invoices = RoW, einvoices = India). Kept nullable so a receipt can be
  -- captured before it is matched to an invoice.
  invoice_id uuid references invoices(id) on delete set null,
  einvoice_id uuid,                                 -- ref einvoices(id); no FK (India table)
  order_id uuid references orders(id) on delete set null,
  shipment_id uuid references shipments(id) on delete set null,
  customer_id uuid references customers(id) on delete set null,

  receipt_type text not null default 'GRN' check (receipt_type in ('GRN','SRN')),
  receipt_number text,
  receipt_date date,                                -- the date the customer posted it (the payment clock)
  -- Matching keys extracted from the receipt document.
  po_number text,
  invoice_number text,

  posted_qty numeric(14,3),
  short_qty numeric(14,3),
  rejected_qty numeric(14,3),

  status text not null default 'captured' check (status in ('expected','captured','matched','disputed')),
  source text not null default 'manual' check (source in ('email','portal','edi','manual')),
  evidence_doc_id uuid references documents(id) on delete set null,
  extraction_run_id uuid,                           -- the docai run, when extracted
  raw jsonb default '{}'::jsonb,                     -- full extracted payload / line items
  notes text,

  captured_at timestamptz not null default now(),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists customer_receipts_invoice_idx on customer_receipts (tenant_id, invoice_id);
create index if not exists customer_receipts_order_idx on customer_receipts (tenant_id, order_id);
create index if not exists customer_receipts_match_idx on customer_receipts (tenant_id, invoice_number);
create index if not exists customer_receipts_status_idx on customer_receipts (tenant_id, status, receipt_date desc);

alter table customer_receipts enable row level security;
drop policy if exists customer_receipts_select on customer_receipts;
create policy customer_receipts_select on customer_receipts
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists customer_receipts_write on customer_receipts;
create policy customer_receipts_write on customer_receipts
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

comment on table customer_receipts is
  'Seller-side customer GRN/SRN captured against our invoices — the delivery-to-cash payment gate. receipt_date is the payment clock. Filled from emailed GRNs (DocAI), portal, EDI, or manual. See docs/DELIVERY_TO_CASH_DESIGN.md.';
