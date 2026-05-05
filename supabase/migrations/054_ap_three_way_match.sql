-- 054_ap_three_way_match.sql
-- Phase 6 (C.5): AP 3-way match + short-pay deductions.
--
-- Three sides of the match:
--   1. Vendor invoice    (ap_invoices)
--   2. Source PO         (already in source_pos)
--   3. Goods receipt     (ap_goods_receipts; mirrored from receiving)
-- The reconciler joins by (po_id, line_no) and flags discrepancies
-- above tolerance. Within tolerance: auto-approve.
--
-- Short-pay / deduction tracking flags customer payments that come
-- in below the invoice grand_total. Each deduction routes to a
-- finance review queue.
-- Idempotent.

create table if not exists ap_invoices (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  vendor_id uuid,
  vendor_invoice_number text not null,
  invoice_date date,
  due_date date,
  currency text default 'USD',
  subtotal numeric(14,2) not null default 0,
  tax_total numeric(14,2) not null default 0,
  grand_total numeric(14,2) not null default 0,
  amount_paid numeric(14,2) not null default 0,
  source_po_id uuid references source_pos(id) on delete set null,
  match_status text not null default 'pending'
    check (match_status in ('pending','matched','mismatched','approved','disputed','paid')),
  match_score numeric(5,2),
  match_details jsonb default '{}'::jsonb,
  raw jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, vendor_invoice_number)
);

create index if not exists ap_invoices_tenant_idx on ap_invoices (tenant_id, match_status, invoice_date desc);

alter table ap_invoices enable row level security;
drop policy if exists "ap_invoices_owner" on ap_invoices;
create policy "ap_invoices_owner" on ap_invoices
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists ap_invoice_lines (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  ap_invoice_id uuid not null references ap_invoices(id) on delete cascade,
  line_no int not null,
  description text,
  quantity numeric(14,4) default 1,
  unit_price numeric(14,4) default 0,
  extended numeric(14,2) default 0,
  po_line_ref text,
  unique (ap_invoice_id, line_no)
);

create index if not exists ap_invoice_lines_idx on ap_invoice_lines (tenant_id, ap_invoice_id);

alter table ap_invoice_lines enable row level security;
drop policy if exists "ap_invoice_lines_owner" on ap_invoice_lines;
create policy "ap_invoice_lines_owner" on ap_invoice_lines
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists ap_goods_receipts (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  source_po_id uuid references source_pos(id) on delete set null,
  receipt_number text,
  received_at timestamptz not null default now(),
  -- Per-line received qty as JSONB so we don't need a 4th table.
  lines jsonb not null default '[]'::jsonb,
  raw jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ap_goods_receipts_idx on ap_goods_receipts (tenant_id, source_po_id, received_at desc);

alter table ap_goods_receipts enable row level security;
drop policy if exists "ap_goods_receipts_owner" on ap_goods_receipts;
create policy "ap_goods_receipts_owner" on ap_goods_receipts
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- Short-pay / deduction queue: every customer payment that comes in
-- below invoice grand_total lands here for finance review.
create table if not exists deduction_queue (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  invoice_id uuid references invoices(id) on delete cascade,
  customer_id uuid,
  expected_amount numeric(14,2) not null,
  paid_amount numeric(14,2) not null,
  short_amount numeric(14,2) not null,
  reason_guess text,
  status text not null default 'open'
    check (status in ('open','researching','disputed','written_off','recovered')),
  notes text,
  flagged_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id)
);

create index if not exists deduction_queue_tenant_idx on deduction_queue (tenant_id, status, flagged_at desc);

alter table deduction_queue enable row level security;
drop policy if exists "deduction_queue_owner" on deduction_queue;
create policy "deduction_queue_owner" on deduction_queue
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- Tolerance settings live on tenant_settings.
alter table tenant_settings
  add column if not exists ap_tolerance_pct numeric(5,2) default 2.0,
  add column if not exists ap_auto_approve_within_tolerance boolean default true,
  add column if not exists ap_max_qty_variance numeric(14,4) default 0;
