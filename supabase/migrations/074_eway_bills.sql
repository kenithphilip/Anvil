-- Audit P7.7. e-Way bill module.
--
-- An e-Way bill (EWB) is mandatory under Indian GST for goods
-- transported by road, rail, air, or ship when the consignment
-- value exceeds Rs.50,000. It is independent of the e-invoice
-- IRN (the IRN proves a sale; the EWB authorises the transport)
-- though they share most of the supplier / buyer / line-item
-- payload. Lifecycle:
--
--   DRAFT  -> PENDING_NIC -> GENERATED -> CANCELLED (within 24h)
--                                      -> EXPIRED   (validity lapse)
--                        -> REJECTED   (NIC error)
--
-- We persist the full request + response so an operator can audit
-- the round-trip if NIC's API hangs or returns a partial body.

do $$ begin
  if not exists (select 1 from pg_type where typname = 'eway_bill_status') then
    create type eway_bill_status as enum (
      'DRAFT', 'PENDING_NIC', 'GENERATED', 'CANCELLED', 'REJECTED', 'EXPIRED'
    );
  end if;
end $$;

create table if not exists eway_bills (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  invoice_id uuid references invoices(id) on delete set null,
  einvoice_id uuid references einvoices(id) on delete set null,
  shipment_id uuid references shipments(id) on delete set null,
  customer_id uuid references customers(id) on delete set null,

  -- Source document reference (NIC's docType: INV/BIL/BOE/CHL/CNT/RCP/TRC).
  doc_type text not null default 'INV',
  doc_no text not null,
  doc_date date not null,

  supply_type text not null default 'O',           -- O=outward, I=inward
  sub_supply_type text not null default '1',       -- 1=Supply
  transaction_type smallint not null default 1,    -- 1=Regular, 2=BTSP, 3=BFDF, 4=Combo

  -- Seller / consignor.
  from_gstin text,
  from_trd_name text,
  from_addr1 text,
  from_addr2 text,
  from_place text,
  from_pincode text,
  from_state_code text,

  -- Buyer / consignee.
  to_gstin text,
  to_trd_name text,
  to_addr1 text,
  to_addr2 text,
  to_place text,
  to_pincode text,
  to_state_code text,

  -- Transport block.
  trans_mode text default 'Road',                  -- Road/Rail/Air/Ship
  trans_distance numeric(10, 2),
  transporter_id text,
  transporter_name text,
  trans_doc_no text,
  trans_doc_date date,
  vehicle_no text,
  vehicle_type text default 'R',                   -- R=Regular, O=ODC

  -- Values.
  taxable_value numeric(14, 2),
  cgst_value numeric(14, 2) default 0,
  sgst_value numeric(14, 2) default 0,
  igst_value numeric(14, 2) default 0,
  cess_value numeric(14, 2) default 0,
  total_inv_value numeric(14, 2),

  -- NIC-issued artifacts.
  ewb_no text,
  ewb_date timestamptz,
  ewb_valid_from timestamptz,
  ewb_valid_upto timestamptz,

  status eway_bill_status not null default 'DRAFT',

  -- Cancellation block.
  cancel_reason_code smallint,                     -- 1=DupOfInv, 2=OrdCancel, 3=DataEntryMistake, 4=Others
  cancel_remarks text,
  cancelled_at timestamptz,

  payload jsonb not null default '{}'::jsonb,
  response jsonb not null default '{}'::jsonb,
  line_items jsonb not null default '[]'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references users(id) on delete set null,

  unique (tenant_id, ewb_no)
);

create index if not exists eway_bills_status_idx on eway_bills (tenant_id, status);
create index if not exists eway_bills_invoice_idx on eway_bills (tenant_id, invoice_id);
create index if not exists eway_bills_einvoice_idx on eway_bills (tenant_id, einvoice_id);
create index if not exists eway_bills_shipment_idx on eway_bills (tenant_id, shipment_id);
create index if not exists eway_bills_validity_idx on eway_bills (tenant_id, ewb_valid_upto)
  where status = 'GENERATED';

alter table eway_bills enable row level security;

drop policy if exists eway_bills_select on eway_bills;
create policy eway_bills_select on eway_bills
  for select using (tenant_id in (select current_tenant_ids()));

drop policy if exists eway_bills_write on eway_bills;
create policy eway_bills_write on eway_bills
  for all using (tenant_id in (select current_tenant_ids()))
         with check (tenant_id in (select current_tenant_ids()));
