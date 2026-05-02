-- 006_corpus_alignment.sql
-- Schema additions derived from deep analysis of Obara India's actual corpus
-- (Salesforce O-I/* with 99 source files: customer POs, quotes, pricecompo,
-- sales orders, RFQs, item master, BRD, HLD, JTBD, Sales/Services Object Models,
-- Flow Diagrams, JBM Spare Matrix). See plan file
-- /Users/kenith.philip/.claude/plans/keep-going-why-aren-t-linked-squid.md.
-- Every new table and column maps back to a real document field; this is not speculative.

-- ───────────────────────────────────────────────────────────────────────────
-- A. Order modes and customer types
-- Sources: Pricecompo prefixes OIQTLC vs OIQTHS, Sales-Order docs,
-- "Type of Customer" picklist in Sales Object Model (Account.Type).
-- ───────────────────────────────────────────────────────────────────────────

create type order_mode as enum (
  'SPARES',           -- straight spares quote, OIQTLC prefix
  'SPARES_ASSEMBLY',  -- gun modification / assembly spares, OIQTLC prefix
  'PROJECT_FOR',      -- project Free On Rail, INR, road logistics
  'PROJECT_HSS',      -- project High Sea Sales, OIQTHS prefix, USD with forward FX
  'INTERNAL'          -- internal SO (FOC, warranty, trials)
);

create type customer_type as enum (
  'AUTO_OEM',     -- Tata, MG Motor, Hyundai, etc.
  'TIER_ONE',     -- Tier-1 line builders downstream of OEMs
  'LINE_BUILDER', -- system integrators
  'OTHER'
);

create type internal_so_type as enum (
  'FOC_SUPPLY',          -- free of charge replacement
  'WARRANTY_REPLACEMENT',
  'PRODUCT_TRIAL',
  'EXPECTED_PO',         -- supply against an expected but not yet received PO
  'INTERNAL_TRANSFER'    -- inter-store (Chennai/Pune/Halol) transfer
);

create type contract_type as enum (
  'ARC',          -- Annual Rate Contract: prices locked for a year
  'BLANKET_PO',   -- customer issues a blanket release; multiple ship-against
  'AMC',          -- Annual Maintenance Contract (services)
  'ONE_OFF'
);

create type opportunity_stage as enum (
  'QUALIFICATION', 'STRATEGY_CHECK', 'NEEDS_ANALYSIS', 'FOLLOW_UP',
  'RFQ', 'INTERNAL_PROPOSAL', 'PROPOSAL_PRICE_QUOTE', 'NEGOTIATION_REVIEW',
  'CLOSE_WON', 'CLOSE_LOST', 'REGRETTED'
);

create type lead_status as enum (
  'NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'REJECTED', 'REGRETTED'
);

create type project_phase as enum (
  'INITIAL_INFO', 'STRATEGY', 'PROMOTIONAL', 'RFQ_PREP', 'BUDGETARY_QUOTATION',
  'PRICE_NEGOTIATION', 'LB_FINALIZATION', 'KICKOFF', 'DESIGN', 'APPROVAL_PROCESSING',
  'MANUFACTURING', 'SHIPPING', 'INSTALLATION_COMMISSIONING', 'PAYMENT_FOLLOWUP', 'CLOSED'
);

create type shipment_mode as enum ('SEA', 'AIR', 'ROAD', 'COURIER');

-- Add fields to orders
alter table orders
  add column if not exists order_mode order_mode,
  add column if not exists parent_order_id uuid references orders(id) on delete set null,
  add column if not exists contract_id uuid,
  add column if not exists lost_reason text,
  add column if not exists competitor_name text,
  add column if not exists forward_fx_rate numeric(14,6),
  add column if not exists forward_contract_ref text,
  add column if not exists customer_location_id uuid,
  add column if not exists internal_so_type internal_so_type,
  add column if not exists project_phase project_phase;

create index if not exists orders_mode_idx on orders (tenant_id, order_mode);
create index if not exists orders_parent_idx on orders (parent_order_id);

alter table customers
  add column if not exists customer_type customer_type,
  add column if not exists pan text,
  add column if not exists primary_contact_email text,
  add column if not exists primary_contact_phone text;

-- ───────────────────────────────────────────────────────────────────────────
-- B. Customer locations: multi-GSTIN, multi-plant.
-- Source: real MG Motor POs reference 24AAKCM8110E1ZR (Gujarat / Halol)
-- and 06AAKCM8110E1ZP (Haryana). Tata Motors PO references "Pune" and Halol.
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists customer_locations (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  location_code text not null,
  plant_name text,
  gstin text,
  state_code text,
  address_line1 text,
  address_line2 text,
  city text,
  pincode text,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, customer_id, location_code)
);

create index if not exists customer_locations_idx on customer_locations (tenant_id, customer_id);

alter table orders
  add constraint orders_customer_location_fk foreign key (customer_location_id)
    references customer_locations(id) on delete set null;

-- ───────────────────────────────────────────────────────────────────────────
-- C. Item master (first-class)
-- Source: Item Master Template-FEB-2024.xlsx columns:
-- Description, Part No, Drawing No, Customer Part No, UoM, Item Group, Item Sub Group,
-- Category, Sub category, Source Country (O-KOREA/O-JAPAN/O-CHINA/O-INDIA), Currency
-- (USD/JPY/CNY/INR), Purchase Price, Purchase Quote No, validity dates, HSN/SAC,
-- SGST 0.09, CGST 0.09, IGST 0.18.
-- ───────────────────────────────────────────────────────────────────────────

create type item_lifecycle as enum ('ACTIVE', 'OBSOLETE', 'DISCONTINUED', 'NEW', 'TRIAL');

create table if not exists item_master (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  part_no text not null,
  description text,
  drawing_no text,
  uom text,
  item_group text,
  item_sub_group text,
  category text,
  sub_category text,
  source_country text,                    -- O-KOREA, O-JAPAN, O-CHINA, O-INDIA
  source_currency text,                   -- USD, JPY, CNY, INR
  purchase_price numeric(18, 4),
  purchase_quote_no text,
  purchase_quote_validity_start date,
  purchase_quote_validity_end date,
  hsn_sac text,
  sgst_rate numeric(6, 4),
  cgst_rate numeric(6, 4),
  igst_rate numeric(6, 4),
  default_lead_days int,
  moq numeric(18, 4) default 1,
  pack_size numeric(18, 4) default 1,
  rounding_rule text,
  lifecycle item_lifecycle not null default 'ACTIVE',
  is_assembly boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, part_no)
);

create index if not exists item_master_lookup on item_master (tenant_id, lower(part_no));
create index if not exists item_master_drawing on item_master (tenant_id, drawing_no);
create index if not exists item_master_group on item_master (tenant_id, item_group, item_sub_group);

-- ───────────────────────────────────────────────────────────────────────────
-- D. Contracts (ARC, Blanket PO, AMC)
-- Source: MG Blanket PO folder (11 release POs against one quote
-- OIQTLC-240123-MG-CONSUMABLES & MAINTENANCE SPARES-REV-1).
-- JTBD: "ARC Purchase Order Tracking - prices fixed for a year".
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists contracts (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  contract_type contract_type not null,
  contract_number text not null,
  parent_quote_id uuid references orders(id) on delete set null,
  start_date date not null,
  end_date date,
  total_value_inr numeric(18, 2),
  currency text not null default 'INR',
  status text not null default 'ACTIVE' check (status in ('ACTIVE','EXPIRED','TERMINATED','PENDING_RENEWAL')),
  notes text,
  created_at timestamptz not null default now(),
  unique (tenant_id, contract_number)
);

create table if not exists contract_lines (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  contract_id uuid not null references contracts(id) on delete cascade,
  part_no text not null,
  description text,
  qty_committed numeric(18, 4),
  qty_consumed numeric(18, 4) not null default 0,
  unit_price numeric(18, 4),
  uom text,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists contract_lines_idx on contract_lines (tenant_id, contract_id);

alter table orders
  add constraint orders_contract_fk foreign key (contract_id)
    references contracts(id) on delete set null;

-- ───────────────────────────────────────────────────────────────────────────
-- E. Pre-sales: Leads and Opportunities
-- Source: Pre-Lead and Lead sheets in Sales Object Model WIP V1.0.xlsx.
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists leads (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  status lead_status not null default 'NEW',
  company_name text not null,
  category text,                     -- Untapped / New / Existing
  lead_source text,
  reliability_score text,            -- Low / Medium / High
  approval_status text default 'PENDING',
  account_id uuid references customers(id) on delete set null,
  contact_name text,
  contact_email text,
  contact_phone text,
  designation text,
  product_interest text,
  lead_type text,                    -- Project / Spare
  customer_segment customer_type,
  region text,
  budget_estimate numeric(18, 2),
  timeline text,
  decision_maker boolean default false,
  lost_reason text,
  notes text,
  allocated_to uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  converted_at timestamptz,
  converted_opportunity_id uuid
);

create index if not exists leads_status_idx on leads (tenant_id, status);
create index if not exists leads_account_idx on leads (tenant_id, account_id);

create table if not exists opportunities (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  customer_location_id uuid references customer_locations(id) on delete set null,
  opportunity_name text not null,
  stage opportunity_stage not null default 'QUALIFICATION',
  order_mode order_mode,
  amount_inr numeric(18, 2),
  amount_currency text default 'INR',
  amount_native numeric(18, 2),
  fx_rate_used numeric(14, 6),
  close_date date,
  probability numeric(5, 2) default 50,
  product_summary text,
  lost_reason text,
  competitor_name text,
  related_lead_id uuid references leads(id) on delete set null,
  related_quote_id uuid references orders(id) on delete set null,
  related_contract_id uuid references contracts(id) on delete set null,
  owner_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists opp_stage_idx on opportunities (tenant_id, stage);
create index if not exists opp_close_idx on opportunities (tenant_id, close_date);

alter table leads
  add constraint leads_converted_opp_fk foreign key (converted_opportunity_id)
    references opportunities(id) on delete set null;

-- ───────────────────────────────────────────────────────────────────────────
-- F. Internal Sales Orders (FOC, Warranty, Trial, Expected PO, Internal Transfer)
-- Source: INternal Sales order/ folder with 3 distinct templates.
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists internal_sales_orders (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  iso_type internal_so_type not null,
  iso_number text not null,
  purpose text,
  requested_person text,
  requested_date date,
  customer_id uuid references customers(id) on delete set null,
  customer_location_id uuid references customer_locations(id) on delete set null,
  vendor_name text,
  vendor_address text,
  material_requirement text,
  required_date date,
  approximate_cost_inr numeric(18, 2),
  billing_instruction text,
  estimated_life text,
  purchase_location text,
  budget text,
  warranty_reference text,                -- original SO number when iso_type=WARRANTY_REPLACEMENT
  expected_po_reference text,             -- expected customer PO when iso_type=EXPECTED_PO
  trial_outcome text,                     -- when iso_type=PRODUCT_TRIAL
  from_store text,                        -- internal transfer "from"
  to_store text,                          -- internal transfer "to"
  status text not null default 'DRAFT' check (status in ('DRAFT','PENDING_APPROVAL','APPROVED','DISPATCHED','CLOSED','CANCELLED')),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  payload jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, iso_number)
);

create index if not exists iso_type_idx on internal_sales_orders (tenant_id, iso_type);
create index if not exists iso_status_idx on internal_sales_orders (tenant_id, status);

create table if not exists internal_so_lines (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  internal_so_id uuid not null references internal_sales_orders(id) on delete cascade,
  part_no text,
  description text,
  qty numeric(18, 4) not null,
  uom text,
  estimated_cost numeric(18, 2),
  notes text
);

create index if not exists iso_lines_idx on internal_so_lines (tenant_id, internal_so_id);

-- ───────────────────────────────────────────────────────────────────────────
-- G. Equipment hierarchy for spare matrix
-- Source: JBM Plant 1 Spare Matrix 29-05-2024.xlsx and JBM-Joel.xlsx
-- columns: SI NO, Line, ZONE, Station Name, Robot Make, Robot No, GUN NO, GUN TYPE,
-- Timer, ATD, plus 150+ part columns and "Installed Qty" sheet.
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists equipment_hierarchy (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  customer_location_id uuid references customer_locations(id) on delete set null,
  plant_name text,
  line_name text,
  zone_name text,
  station_name text,
  robot_make text,
  robot_no text,
  gun_no text,
  gun_type text,
  qty int default 1,
  timer_model text,
  atd_model text,
  parent_id uuid references equipment_hierarchy(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists eq_hier_customer_idx on equipment_hierarchy (tenant_id, customer_id);
create index if not exists eq_hier_gun_idx on equipment_hierarchy (tenant_id, gun_no);

create table if not exists equipment_installed_parts (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  equipment_id uuid not null references equipment_hierarchy(id) on delete cascade,
  part_no text not null,
  description text,
  installed_qty numeric(18, 4) not null default 1,
  is_critical boolean not null default false,
  is_emergency_only boolean not null default false,
  recommended_qty_90d numeric(18, 4),
  recommended_qty_180d numeric(18, 4),
  recommended_qty_365d numeric(18, 4),
  last_replaced_at date,
  notes text
);

create index if not exists installed_parts_idx on equipment_installed_parts (tenant_id, equipment_id);
create index if not exists installed_parts_part_idx on equipment_installed_parts (tenant_id, part_no);

-- ───────────────────────────────────────────────────────────────────────────
-- H. Shipments + POD
-- Source: Pending Sales Order tracker columns: Source PO No, Mode (SEA/AIR),
-- Ready Date, Shipper Inv No, Vessel/flight, Arrival at Indian Port,
-- Receipt date at our warehouse, POD, Remark.
-- JTBD: "Invoice and POD Coordination", "Advanced Shipping Notices".
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists shipments (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id uuid references orders(id) on delete set null,
  source_po_id uuid references source_pos(id) on delete set null,
  internal_so_id uuid references internal_sales_orders(id) on delete set null,
  shipment_number text,
  mode shipment_mode,
  carrier text,
  vessel_or_flight text,
  shipper_invoice_no text,
  ready_date date,
  port_of_loading text,
  port_of_discharge text,
  vessel_sailing_date date,
  port_arrival_date date,
  warehouse_receipt_date date,
  customer_delivery_date date,
  pod_received boolean not null default false,
  pod_document_id uuid references documents(id) on delete set null,
  asn_sent_at timestamptz,
  status text not null default 'PLANNED' check (status in ('PLANNED','READY','IN_TRANSIT','AT_PORT','CLEARED','DELIVERED','POD_RECEIVED','EXCEPTION')),
  remarks text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists shipments_order_idx on shipments (tenant_id, order_id);
create index if not exists shipments_status_idx on shipments (tenant_id, status);

-- ───────────────────────────────────────────────────────────────────────────
-- I. Project tracking (phases, mandays, milestones)
-- Source: 2. Project- Info and activity Rev1.xlsx (Project Initial Info,
-- Project Strategy, Promotional Activity, RFQ Prep, Budgetary Quotation,
-- Negotiation, LB Finalization, Kickoff, Design, Approval, Shipping,
-- Install/Commission, Payment Followup) + Quote Approval budget breakdown.
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists projects (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  project_code text not null,
  project_name text not null,
  customer_id uuid references customers(id) on delete set null,
  customer_location_id uuid references customer_locations(id) on delete set null,
  customer_segment customer_type,
  end_user text,
  related_opportunity_id uuid references opportunities(id) on delete set null,
  total_value_inr numeric(18, 2),
  currency text default 'INR',
  current_phase project_phase not null default 'INITIAL_INFO',
  budgeted_design_mandays int,
  budgeted_install_mandays int,
  budgeted_travel_mandays int,
  budgeted_warranty_pct numeric(6, 4),
  shipping_mode shipment_mode,
  expected_po_release_date date,
  expected_design_final_date date,
  expected_ready_date date,
  expected_shipping_etd date,
  expected_delivery_date date,
  expected_sop_date date,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','ON_HOLD','COMPLETED','CANCELLED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, project_code)
);

create table if not exists project_phase_log (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  phase project_phase not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  responsible_user uuid references auth.users(id) on delete set null,
  progress_pct numeric(5, 2) default 0,
  remarks text
);

create index if not exists project_phase_idx on project_phase_log (tenant_id, project_id, phase);

-- ───────────────────────────────────────────────────────────────────────────
-- J. Service module: Visit reports, CAR, Closure reports
-- Source: Services Object Model + JTBD service section.
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists service_visits (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  customer_location_id uuid references customer_locations(id) on delete set null,
  visit_date date not null,
  line_or_station text,
  purpose text,
  observation text,
  possible_cause text,
  action_taken text,
  followup_action text,
  check_in_at timestamptz,
  check_out_at timestamptz,
  field_engineer uuid references auth.users(id) on delete set null,
  status text not null default 'PLANNED' check (status in ('PLANNED','CHECKED_IN','CHECKED_OUT','REPORT_SUBMITTED','CLOSED')),
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists car_reports (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  original_po_no text,
  original_so_no text,
  part_no text,
  qty_rejected numeric(18, 4),
  root_cause text,
  five_why_analysis jsonb,
  temporary_countermeasure text,
  permanent_countermeasure text,
  analysis_date date,
  prepared_by uuid references auth.users(id) on delete set null,
  status text not null default 'OPEN' check (status in ('OPEN','UNDER_REVIEW','CLOSED','REOPENED')),
  created_at timestamptz not null default now()
);

create table if not exists closure_reports (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  car_report_id uuid references car_reports(id) on delete set null,
  customer_id uuid references customers(id) on delete set null,
  issue_date date,
  equipment_part_no text,
  investigation text,
  root_cause text,
  temporary_countermeasure text,
  permanent_countermeasure text,
  closed_at timestamptz,
  signed_off_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ───────────────────────────────────────────────────────────────────────────
-- K. Schedule lines (the "*As per Schedule Lines, to be sent separately"
-- footnote in MG POs - real customers send delivery schedules as a separate doc)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists order_schedule_lines (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  line_index int,
  part_no text,
  scheduled_qty numeric(18, 4) not null,
  scheduled_date date not null,
  delivery_location text,
  remark text,
  source_document_id uuid references documents(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists order_schedule_idx on order_schedule_lines (tenant_id, order_id, scheduled_date);

-- ───────────────────────────────────────────────────────────────────────────
-- L. Quote approval thresholds
-- Source: Proj.Budget Approval-240207-ABC-MOTORS-PROJECT-FOR.xlsx with 5
-- approver roles (Sales Manager, Finance, Production, Customer Support, Director)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists quote_approval_thresholds (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  approver_role obara_role not null,
  min_amount_inr numeric(18, 2) not null default 0,
  max_amount_inr numeric(18, 2),
  required_for_modes order_mode[],
  margin_below_pct numeric(6, 4),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists quote_approvals (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  approver_role obara_role not null,
  approver_user uuid references auth.users(id) on delete set null,
  status text not null default 'PENDING' check (status in ('PENDING','APPROVED','REJECTED','SKIPPED')),
  comments text,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists quote_approvals_order_idx on quote_approvals (tenant_id, order_id);

-- ───────────────────────────────────────────────────────────────────────────
-- M. Lost reasons taxonomy (so the loss tracker has a controlled vocabulary)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists lost_reason_taxonomy (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid references tenants(id) on delete cascade,
  code text not null,
  label text not null,
  category text,                         -- price / lead_time / quality / relationship / scope / other
  active boolean not null default true,
  unique nulls not distinct (tenant_id, code)
);

-- ───────────────────────────────────────────────────────────────────────────
-- N. RLS for every new table
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  t text;
begin
  for t in
    select unnest(array[
      'customer_locations','item_master','contracts','contract_lines','leads','opportunities',
      'internal_sales_orders','internal_so_lines','equipment_hierarchy','equipment_installed_parts',
      'shipments','projects','project_phase_log','service_visits','car_reports','closure_reports',
      'order_schedule_lines','quote_approval_thresholds','quote_approvals','lost_reason_taxonomy'
    ])
  loop
    execute format('alter table %I enable row level security;', t);
    execute format('drop policy if exists %I_select on %I;', t, t);
    execute format('create policy %I_select on %I for select using (tenant_id is null or tenant_id in (select current_tenant_ids()));', t, t);
    execute format('drop policy if exists %I_write on %I;', t, t);
    execute format('create policy %I_write on %I for all using (tenant_id in (select current_tenant_ids())) with check (tenant_id in (select current_tenant_ids()));', t, t);
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- O. Seed default lost-reason codes (global; tenant_id null)
-- ───────────────────────────────────────────────────────────────────────────

insert into lost_reason_taxonomy (tenant_id, code, label, category) values
  (null, 'PRICE_HIGH', 'Quoted price too high', 'price'),
  (null, 'LEAD_TIME', 'Lead time too long', 'lead_time'),
  (null, 'COMPETITOR_RELATIONSHIP', 'Customer favored competitor relationship', 'relationship'),
  (null, 'SCOPE_MISMATCH', 'Scope mismatch with customer requirement', 'scope'),
  (null, 'QUALITY_CONCERN', 'Customer raised quality concern', 'quality'),
  (null, 'BUDGET_CUT', 'Customer budget cut or postponed', 'budget'),
  (null, 'NO_RESPONSE', 'Customer did not respond', 'other'),
  (null, 'TECHNICAL_GAP', 'Technical specs gap', 'scope'),
  (null, 'PAYMENT_TERMS', 'Payment terms not acceptable', 'commercial')
on conflict do nothing;
