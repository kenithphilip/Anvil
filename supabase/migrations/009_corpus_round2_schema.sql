-- 009_corpus_round2_schema.sql
-- Round 2 deep-read of the Obara corpus surfaced additional structures that
-- the earlier 6 corpus migrations did not cover.
--
-- New artifacts:
--   1. engineering_specs: machine spec sheets like the SRTX EG SHEET
--      (motor model, ball screw, lead, max electrode force, etc.). Linked
--      to item_master.
--   2. payment_milestones: multi-tranche payment terms attached to a
--      contract or order. The MG corpus shows "50% advance on PO + 50%
--      before delivery" rather than a flat "Net 30".
--   3. expense_rate_cards: standard man-day rates and percentage buffers
--      from the budget approval template. Currently hardcoded in the
--      cost simulator; this table makes them tenant-configurable.
--   4. inco_terms_taxonomy: explicit codes referenced across the corpus
--      (FOR, CIF, FOB, EXW). Currently we store strings in
--      orders.result.salesOrder.incoterms; this gives admins a
--      controlled vocabulary.
--   5. blanket_release_links: parent quote + child release PO + drawn-down
--      qty per part. Models the MG OIQTLC-240123 master quote with its
--      11 release POs (5100002515 through 5100002595).
--   6. ports + vessels: real Indian ports and supplier vessels seen in
--      the pending SO tracker (Nhava Sheva, HX-2628Y, etc.).
--
-- Idempotent.

-- ───────────────────────────────────────────────────────────────────────────
-- A. Engineering specs (SRTX EG SHEET style)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists engineering_specs (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  part_no text not null,                                  -- ties to item_master.part_no
  spec_type text not null default 'motor',                -- motor | gearcase | gun | actuator | other
  motor_model text,                                       -- e.g. "FANUC Alfais8/4000"
  max_electrode_force_n numeric(10,2),                    -- newtons
  max_rpm int,
  acceleration_torque_nm numeric(10,4),
  pressurizing_torque_nm numeric(10,4),
  ball_screw_diameter_mm int,
  lead_mm int,
  length_mm int,
  tip_travel_per_rotation_mm numeric(10,4),
  max_speed_mm_sec int,
  motor_axis_inertia_kgm2 numeric(20,12),
  acceleration_time_sec numeric(8,4),
  pressurizing_time_sec numeric(8,4),
  cycle_time_sec numeric(8,4),
  pressurizing_torque_to_rated_pct numeric(8,4),
  lever_ratio_a int,
  lever_ratio_b int,
  mechanical_efficiency numeric(6,4),
  drawing_no text,                                        -- linked drawing if any
  document_id uuid references documents(id) on delete set null,
  payload jsonb default '{}'::jsonb,                      -- catch-all for future fields
  issued_by text,
  issued_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, part_no)
);

create index if not exists eng_specs_part_idx on engineering_specs (tenant_id, part_no);

-- ───────────────────────────────────────────────────────────────────────────
-- B. Payment milestones
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists payment_milestones (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  contract_id uuid references contracts(id) on delete cascade,
  order_id uuid references orders(id) on delete cascade,
  sequence int not null default 1,
  label text not null,                                    -- e.g. "Advance on PO" / "Before dispatch"
  pct numeric(6,2),                                       -- percentage (10.00 = 10%)
  fixed_inr numeric(18,2),                                -- alternative: fixed amount
  trigger text,                                           -- "po_received" | "pre_dispatch" | "post_delivery" | "n_days"
  due_days int,                                           -- when trigger=n_days, days from order_date
  payment_method text default 'NEFT',                     -- NEFT / RTGS / IMPS / Cheque / Wire
  notes text,
  created_at timestamptz not null default now(),
  check ((contract_id is not null) or (order_id is not null))
);

create index if not exists payment_milestones_contract_idx on payment_milestones (tenant_id, contract_id, sequence);
create index if not exists payment_milestones_order_idx on payment_milestones (tenant_id, order_id, sequence);

-- Idempotence guards: a milestone is uniquely identified by either
-- (tenant_id, contract_id, sequence) or (tenant_id, order_id, sequence).
-- Using partial unique indexes lets seed scripts use ON CONFLICT cleanly.
create unique index if not exists payment_milestones_contract_seq
  on payment_milestones (tenant_id, contract_id, sequence)
  where contract_id is not null;
create unique index if not exists payment_milestones_order_seq
  on payment_milestones (tenant_id, order_id, sequence)
  where order_id is not null;

-- ───────────────────────────────────────────────────────────────────────────
-- C. Expense rate cards
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists expense_rate_cards (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  rate_code text not null,                                -- "design_manday" | "install_manday" | "travel_manday" | "warranty_buffer_pct" | "currency_fluctuation_pct" | "sales_expense_pct" | "project_admin_pct" | "finance_charge_pct"
  label text not null,
  rate_inr numeric(18,2),                                 -- per day or per unit
  pct numeric(6,4),                                       -- when this is a percentage buffer
  currency text default 'INR',
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, rate_code)
);

-- ───────────────────────────────────────────────────────────────────────────
-- D. Incoterms taxonomy
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists inco_terms_taxonomy (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid references tenants(id) on delete cascade,    -- nullable for global codes
  code text not null,                                          -- FOR / FOB / CIF / EXW / DAP / CIP
  label text not null,
  description text,
  active boolean not null default true,
  unique nulls not distinct (tenant_id, code)
);

-- ───────────────────────────────────────────────────────────────────────────
-- E. Blanket release links
-- The MG case: parent quote OIQTLC-240123-MG-CONSUMABLES & MAINTENANCE
-- SPARES-REV-1 has 11 release POs (5100002515-5100002595). We track them
-- as orders with parent_order_id and contract_id but the per-line
-- drawdown ledger needs its own table.
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists blanket_release_drawdown (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  contract_id uuid not null references contracts(id) on delete cascade,
  release_order_id uuid references orders(id) on delete set null,
  part_no text not null,
  qty_drawn numeric(18,4) not null,
  rate_used numeric(18,4),
  drawn_at timestamptz not null default now()
);

create index if not exists drawdown_contract_idx on blanket_release_drawdown (tenant_id, contract_id, part_no);
create index if not exists drawdown_order_idx on blanket_release_drawdown (tenant_id, release_order_id);

-- ───────────────────────────────────────────────────────────────────────────
-- F. Ports + vessels
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists logistics_ports (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid references tenants(id) on delete cascade,    -- nullable for global
  port_code text not null,                                     -- INNSA, INMUN, INMAA
  port_name text not null,
  country text not null default 'IN',
  port_type text default 'sea' check (port_type in ('sea','air','dryport','iccp')),
  active boolean not null default true,
  unique nulls not distinct (tenant_id, port_code)
);

create table if not exists logistics_carriers (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid references tenants(id) on delete cascade,    -- nullable for global
  carrier_code text not null,                                  -- e.g. "HX" prefix
  carrier_name text,
  mode text default 'SEA' check (mode in ('SEA','AIR','ROAD','COURIER')),
  active boolean not null default true,
  unique nulls not distinct (tenant_id, carrier_code)
);

-- ───────────────────────────────────────────────────────────────────────────
-- G. Item master extension: technical specs reference
-- ───────────────────────────────────────────────────────────────────────────

alter table item_master
  add column if not exists technical_specs jsonb default '{}'::jsonb,
  add column if not exists is_servo_motor boolean not null default false,
  add column if not exists min_stock_qty numeric(18,4),
  add column if not exists current_stock_qty numeric(18,4),
  add column if not exists is_critical boolean not null default false;

create index if not exists item_master_critical_idx on item_master (tenant_id, is_critical) where is_critical = true;

-- Idempotence guard: shipment_number is the natural unique key per tenant.
-- 006 created shipments without one, so add it here as a partial unique index
-- (only when shipment_number is not null) so the seeds can use ON CONFLICT.
create unique index if not exists shipments_number_unique
  on shipments (tenant_id, shipment_number)
  where shipment_number is not null;

-- ───────────────────────────────────────────────────────────────────────────
-- H. Customer location: explicit tax treatment trigger
-- A location's state_code drives whether to apply IGST (interstate from
-- 27/Maharashtra-Pune origin) or CGST+SGST split (intrastate).
-- ───────────────────────────────────────────────────────────────────────────

alter table customer_locations
  add column if not exists tax_treatment text default 'AUTO' check (tax_treatment in ('AUTO', 'IGST_ONLY', 'CGST_SGST_SPLIT')),
  add column if not exists ship_to_address_full text;

-- ───────────────────────────────────────────────────────────────────────────
-- I. RLS for new tables
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  t text;
begin
  for t in
    select unnest(array[
      'engineering_specs','payment_milestones','expense_rate_cards',
      'inco_terms_taxonomy','blanket_release_drawdown',
      'logistics_ports','logistics_carriers'
    ])
  loop
    execute format('alter table %I enable row level security;', t);
    execute format('drop policy if exists %I_select on %I;', t, t);
    execute format('create policy %I_select on %I for select using (tenant_id is null or tenant_id in (select current_tenant_ids()));', t, t);
    execute format('drop policy if exists %I_write on %I;', t, t);
    execute format('create policy %I_write on %I for all using (tenant_id is null or tenant_id in (select current_tenant_ids())) with check (tenant_id is null or tenant_id in (select current_tenant_ids()));', t, t);
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- J. Seed global incoterms + ports + carriers (tenant_id null)
-- ───────────────────────────────────────────────────────────────────────────

insert into inco_terms_taxonomy (tenant_id, code, label, description) values
  (null, 'FOR', 'Free On Rail', 'Seller delivers to railway carrier; buyer takes title at rail head'),
  (null, 'EXW', 'Ex Works', 'Buyer collects from seller premises; full risk to buyer'),
  (null, 'FOB', 'Free On Board', 'Seller clears for export and loads onto vessel; buyer takes title at port of loading'),
  (null, 'CIF', 'Cost Insurance Freight', 'Seller pays cost + insurance + freight to destination port'),
  (null, 'CIP', 'Carriage Insurance Paid To', 'Seller pays insurance + freight to destination; risk transfers at first carrier'),
  (null, 'DAP', 'Delivered at Place', 'Seller delivers to named destination; buyer handles import clearance'),
  (null, 'DDP', 'Delivered Duty Paid', 'Seller bears all costs and duties to named destination')
on conflict do nothing;

insert into logistics_ports (tenant_id, port_code, port_name, country, port_type) values
  (null, 'INNSA', 'Nhava Sheva (JNPT)', 'IN', 'sea'),
  (null, 'INMUN', 'Mumbai', 'IN', 'sea'),
  (null, 'INMAA', 'Chennai', 'IN', 'sea'),
  (null, 'INMUN-AIR', 'Mumbai Air Cargo', 'IN', 'air'),
  (null, 'INMAA-AIR', 'Chennai Air Cargo', 'IN', 'air'),
  (null, 'INDEL-AIR', 'Delhi Air Cargo (IGI)', 'IN', 'air'),
  (null, 'JPYOK', 'Yokohama', 'JP', 'sea'),
  (null, 'KRPUS', 'Busan', 'KR', 'sea'),
  (null, 'CNSHA', 'Shanghai', 'CN', 'sea')
on conflict do nothing;

insert into logistics_carriers (tenant_id, carrier_code, carrier_name, mode) values
  (null, 'HX', 'HX Container Lines', 'SEA'),
  (null, 'MAERSK', 'Maersk', 'SEA'),
  (null, 'MSC', 'Mediterranean Shipping Co', 'SEA'),
  (null, 'CMA-CGM', 'CMA CGM', 'SEA'),
  (null, 'EVERGREEN', 'Evergreen Marine', 'SEA'),
  (null, 'ONE', 'Ocean Network Express', 'SEA'),
  (null, 'AIR-INDIA-CARGO', 'Air India Cargo', 'AIR'),
  (null, 'EMIRATES-CARGO', 'Emirates SkyCargo', 'AIR'),
  (null, 'DHL', 'DHL Express', 'COURIER'),
  (null, 'FEDEX', 'FedEx Express', 'COURIER')
on conflict do nothing;
