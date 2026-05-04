-- 035_supplier_rfq_reconciliation.sql
-- Two related deliverables:
--   1. Outbound supplier RFQ orchestration (Lumari module): BOM in,
--      multi-vendor emails out, normalised comparison matrix,
--      PO tracking with acknowledgement and ship-date monitoring.
--   2. Order-confirmation reconciliation (Comena unique): compare a
--      vendor confirmation document against the issued PO and
--      surface line-item discrepancies (price, qty, lead time, terms).
-- Idempotent.

-- 1. Supplier RFQ ----------------------------------------------

create table if not exists vendors (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  vendor_name text not null,
  vendor_key text,                                  -- ERP external ref
  contact_email text,
  contact_phone text,
  payment_terms text,
  default_lead_time_days int,
  active boolean not null default true,
  notes text,
  external_ref jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, vendor_name)
);

create index if not exists vendors_tenant_idx on vendors (tenant_id, vendor_name);

alter table vendors enable row level security;
drop policy if exists "vendors_all" on vendors;
create policy "vendors_all" on vendors
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create or replace function vendors_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists vendors_updated_at on vendors;
create trigger vendors_updated_at before update on vendors
  for each row execute function vendors_touch_updated_at();

create table if not exists supplier_rfqs (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  source_order_id uuid references orders(id) on delete set null,
  rfq_number text,
  status text not null default 'draft' check (status in ('draft','sent','quoting','awarded','closed','cancelled')),
  due_at timestamptz,
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists supplier_rfqs_tenant_idx on supplier_rfqs (tenant_id, created_at desc);
create index if not exists supplier_rfqs_status_idx on supplier_rfqs (tenant_id, status);

alter table supplier_rfqs enable row level security;
drop policy if exists "supplier_rfqs_all" on supplier_rfqs;
create policy "supplier_rfqs_all" on supplier_rfqs
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create or replace function supplier_rfqs_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists supplier_rfqs_updated_at on supplier_rfqs;
create trigger supplier_rfqs_updated_at before update on supplier_rfqs
  for each row execute function supplier_rfqs_touch_updated_at();

create table if not exists supplier_rfq_lines (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  rfq_id uuid not null references supplier_rfqs(id) on delete cascade,
  line_no int not null,
  item_id uuid references item_master(id) on delete set null,
  part_number text,
  description text,
  quantity numeric(14,3),
  uom text,
  spec text,
  target_price numeric(14,2),
  awarded_invitation_id uuid,
  unique (tenant_id, rfq_id, line_no)
);

create index if not exists supplier_rfq_lines_rfq_idx on supplier_rfq_lines (rfq_id, line_no);

alter table supplier_rfq_lines enable row level security;
drop policy if exists "supplier_rfq_lines_all" on supplier_rfq_lines;
create policy "supplier_rfq_lines_all" on supplier_rfq_lines
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists supplier_rfq_invitations (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  rfq_id uuid not null references supplier_rfqs(id) on delete cascade,
  vendor_id uuid not null references vendors(id) on delete cascade,
  email_to text,
  sent_at timestamptz,
  reminder_count int not null default 0,
  last_reminded_at timestamptz,
  response_received_at timestamptz,
  response_status text not null default 'pending' check (response_status in ('pending','quoted','declined','expired','no_response')),
  notes text,
  created_at timestamptz not null default now(),
  unique (tenant_id, rfq_id, vendor_id)
);

create index if not exists supplier_rfq_invitations_rfq_idx on supplier_rfq_invitations (rfq_id, response_status);

alter table supplier_rfq_invitations enable row level security;
drop policy if exists "supplier_rfq_invitations_all" on supplier_rfq_invitations;
create policy "supplier_rfq_invitations_all" on supplier_rfq_invitations
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists supplier_quotes (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  invitation_id uuid not null references supplier_rfq_invitations(id) on delete cascade,
  rfq_id uuid not null references supplier_rfqs(id) on delete cascade,
  vendor_id uuid not null references vendors(id) on delete cascade,
  line_no int not null,
  unit_price numeric(14,2),
  lead_time_days int,
  currency text default 'USD',
  validity_days int default 30,
  notes text,
  raw jsonb default '{}'::jsonb,
  received_at timestamptz not null default now(),
  unique (tenant_id, invitation_id, line_no)
);

create index if not exists supplier_quotes_rfq_idx on supplier_quotes (rfq_id, line_no, unit_price);

alter table supplier_quotes enable row level security;
drop policy if exists "supplier_quotes_all" on supplier_quotes;
create policy "supplier_quotes_all" on supplier_quotes
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- 2. Order-confirmation reconciliation -------------------------

create table if not exists order_reconciliations (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  source_type text not null check (source_type in ('email','pdf','xml','manual')),
  source_id text,                                  -- inbound_email_id or document_id
  source_url text,
  vendor_id uuid references vendors(id) on delete set null,
  match_status text not null default 'pending' check (match_status in ('pending','match','mismatch','partial','rejected')),
  total_lines int not null default 0,
  matching_lines int not null default 0,
  mismatched_lines int not null default 0,
  discrepancies jsonb default '[]'::jsonb,         -- [{ line_no, field, expected, received, severity }]
  decided_by uuid references auth.users(id),
  decided_at timestamptz,
  decision text check (decision in ('accept','reject','clarify')),
  raw jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists order_reconciliations_tenant_idx on order_reconciliations (tenant_id, created_at desc);
create index if not exists order_reconciliations_order_idx on order_reconciliations (tenant_id, order_id);
create index if not exists order_reconciliations_status_idx on order_reconciliations (tenant_id, match_status);

alter table order_reconciliations enable row level security;
drop policy if exists "order_reconciliations_all" on order_reconciliations;
create policy "order_reconciliations_all" on order_reconciliations
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
