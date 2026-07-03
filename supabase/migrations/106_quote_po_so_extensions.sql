-- Migration 106: quote / PO / SO document-field extensions.
--
-- Anchored on docs/audits/AUDIT_2026_05_12_quote_po_so_field_coverage.md.
-- Fills 11 schema gaps surfaced by auditing the Obara India price
-- quotation, price composition, Meridian purchase order, and Obara
-- sales order documents against main @ acbaf99.
--
-- All new tables are tenant-scoped via RLS. Seeded reference data
-- (incoterms, dispatch modes, tax-component codes) carries tenant_id
-- null so any tenant inherits the global defaults and overrides via
-- per-tenant rows. Nothing in this migration is specific to Obara,
-- Tally, India, or MMIL; the names line up to the audit document.

-- ---------------------------------------------------------------------------
-- 1. document_templates
--    Per-tenant, per-document-type, versioned templates carrying the
--    boilerplate text that appears on quotations, sales orders,
--    invoices, purchase orders, and credit notes. Replaces the
--    free-text `quotes.terms` blob and the previously-hardcoded
--    voucher messages.
-- ---------------------------------------------------------------------------

create table if not exists document_templates (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  doc_type text not null check (doc_type in ('quotation', 'sales_order', 'purchase_order', 'tax_invoice', 'proforma_invoice', 'credit_note', 'eway_bill', 'delivery_note')),
  form_code text,
  template_name text not null,
  version int not null default 1,
  is_active boolean not null default true,
  is_default boolean not null default false,
  language text not null default 'en',
  header_block text,
  footer_block text,
  signatory_block text,
  standard_message text,
  warranty_clause text,
  penalty_clause text,
  cancellation_clause text,
  force_majeure_clause text,
  payment_terms_clause text,
  delivery_terms_clause text,
  other_conditions jsonb default '[]'::jsonb,
  body_blocks jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, doc_type, version)
);

create unique index if not exists document_templates_default
  on document_templates (tenant_id, doc_type)
  where is_default = true and is_active = true;

create index if not exists document_templates_doc_type_idx
  on document_templates (tenant_id, doc_type, is_active);

alter table document_templates enable row level security;
drop policy if exists document_templates_select on document_templates;
create policy document_templates_select on document_templates
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists document_templates_write on document_templates;
create policy document_templates_write on document_templates
  for all
  using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

-- ---------------------------------------------------------------------------
-- 2. incoterms_v2: global + per-tenant reference. The legacy column
--    customers.default_incoterms is free text; this table makes the
--    list canonical and per-customer overridable.
-- ---------------------------------------------------------------------------

-- Bug fix May 2026 (same shape as uom_options in 105): the
-- composite (tenant_id, code) PK forbids null tenant_id, so the
-- global seed rows below could never insert. Surrogate id PK +
-- partial unique indexes preserve the global / per-tenant scope.
create table if not exists incoterms_v2 (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid references tenants(id) on delete cascade,
  code text not null,
  label text not null,
  description text,
  is_active boolean not null default true,
  sort_order int not null default 100
);

-- Defensive rotate when a prior failed apply left the old shape.
-- Same shape as the uom_options block in 105: drop the implicit
-- NOT NULL on tenant_id that the old composite PK leaves behind.
do $$
declare
  pk_cols text;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'incoterms_v2' and column_name = 'id'
  ) then
    alter table public.incoterms_v2 add column id uuid default uuid_generate_v4();
    update public.incoterms_v2 set id = uuid_generate_v4() where id is null;
    alter table public.incoterms_v2 alter column id set not null;
  end if;

  select string_agg(a.attname, ',' order by array_position(i.indkey::int[], a.attnum))
    into pk_cols
  from pg_index i
  join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
  where i.indrelid = 'public.incoterms_v2'::regclass
    and i.indisprimary;

  if pk_cols is null or pk_cols <> 'id' then
    if pk_cols is not null then
      alter table public.incoterms_v2 drop constraint if exists incoterms_v2_pkey;
    end if;
    alter table public.incoterms_v2 add primary key (id);
  end if;

  alter table public.incoterms_v2 alter column tenant_id drop not null;
end $$;

create unique index if not exists incoterms_v2_tenant_code
  on incoterms_v2 (tenant_id, code) where tenant_id is not null;
create unique index if not exists incoterms_v2_global_code
  on incoterms_v2 (code) where tenant_id is null;

alter table incoterms_v2 enable row level security;
drop policy if exists incoterms_v2_select on incoterms_v2;
create policy incoterms_v2_select on incoterms_v2
  for select using (tenant_id is null or tenant_id in (select current_tenant_ids()));
drop policy if exists incoterms_v2_write on incoterms_v2;
create policy incoterms_v2_write on incoterms_v2
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

insert into incoterms_v2 (tenant_id, code, label, description, sort_order) values
  (null, 'EXW', 'Ex Works',                'Buyer collects from seller premises.',         10),
  (null, 'FCA', 'Free Carrier',            'Seller delivers to carrier nominated by buyer.', 20),
  (null, 'FAS', 'Free Alongside Ship',     'Seller delivers alongside the vessel.',         30),
  (null, 'FOB', 'Free On Board',           'Seller delivers on board the vessel.',          40),
  (null, 'CFR', 'Cost and Freight',        'Seller pays freight to named port.',            50),
  (null, 'CIF', 'Cost Insurance Freight',  'Seller pays freight and insurance.',            60),
  (null, 'CPT', 'Carriage Paid To',        'Seller pays carriage to named destination.',    70),
  (null, 'CIP', 'Carriage Insurance Paid', 'Seller pays carriage and insurance.',           80),
  (null, 'DAP', 'Delivered At Place',      'Seller delivers at named place ready to unload.', 90),
  (null, 'DPU', 'Delivered Place Unloaded','Seller delivers and unloads at named place.',  100),
  (null, 'DDP', 'Delivered Duty Paid',     'Seller delivers cleared for import.',          110),
  (null, 'FH',  'Free House',              'Indian B2B convention. Seller delivers to buyer plant, all charges included.', 120),
  (null, 'FOR', 'Free On Road',            'Indian B2B convention. Seller delivers at named destination.', 130)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 3. price_composition_lines: per-quote-line internal pricing carrying
--    the multi-tier margin, supplier price, reference price columns
--    from the Excel calculation sheet.
-- ---------------------------------------------------------------------------

create table if not exists price_composition_lines (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  quote_id uuid references quotes(id) on delete cascade,
  quote_version int,
  line_index int not null,
  part_no text,
  qty numeric(18, 4),
  unit text,
  supplier_unit_price numeric(18, 4),
  supplier_currency text,
  supplier_quote_no text,
  source_country text,
  total_cost numeric(18, 4),
  mod1 numeric(8, 6),                       -- innermost margin tier (e.g., handling)
  mod2 numeric(8, 6),                       -- middle margin tier (e.g., overhead)
  mod3 numeric(8, 6),                       -- outermost margin tier (e.g., profit)
  landed_cost numeric(18, 4),
  profit_pct numeric(8, 6),
  profit_setting numeric(8, 6),             -- target margin
  reference_price numeric(18, 4),           -- VAATZ / HKMC reference for benchmarking
  reference_currency text,
  selling_unit_price numeric(18, 4),
  selling_total numeric(18, 4),
  conversion_factor numeric(10, 6),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, quote_id, line_index)
);

create index if not exists price_comp_quote_idx
  on price_composition_lines (tenant_id, quote_id, line_index);

alter table price_composition_lines enable row level security;
drop policy if exists price_composition_lines_select on price_composition_lines;
create policy price_composition_lines_select on price_composition_lines
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists price_composition_lines_write on price_composition_lines;
create policy price_composition_lines_write on price_composition_lines
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

-- ---------------------------------------------------------------------------
-- 4. quotes.fx_snapshot + conversion_factor: per-quote frozen rates.
--    The price-composition sheet pins the rates used at quote time so
--    the math is reproducible even after the global fx_rates table
--    shifts.
-- ---------------------------------------------------------------------------

alter table quotes
  add column if not exists fx_snapshot jsonb,
  add column if not exists conversion_factor numeric(10, 6),
  add column if not exists template_id uuid references document_templates(id) on delete set null,
  add column if not exists your_ref text,
  add column if not exists attention_contact text;

comment on column quotes.fx_snapshot is
  'Frozen exchange-rate snapshot at quote time, shape {INR: 1.0, USD: 96.0, CNY: 14.0, JPY: 0.65, multiplication_factor: {USD: 126.6, ...}}';

-- ---------------------------------------------------------------------------
-- 5. freight_rates: per-tenant air + ocean rate tables.
-- ---------------------------------------------------------------------------

create table if not exists freight_rates (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  mode text not null check (mode in ('air', 'ocean', 'road', 'courier')),
  origin text,                              -- ISO 3166-1 alpha-2 country code or "ANY"
  destination text,
  unit text not null,                       -- 'kg', 'cbm', 'container_20ft', 'container_40ft'
  rate_per_unit numeric(18, 4) not null,
  packing_fee numeric(18, 4),
  fuel_surcharge_pct numeric(8, 6),
  currency text not null default 'INR',
  effective_from date,
  effective_to date,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists freight_rates_lookup
  on freight_rates (tenant_id, mode, origin, destination, is_active);

alter table freight_rates enable row level security;
drop policy if exists freight_rates_select on freight_rates;
create policy freight_rates_select on freight_rates
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists freight_rates_write on freight_rates;
create policy freight_rates_write on freight_rates
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

-- ---------------------------------------------------------------------------
-- 6. customer_vendor_codes: how each customer refers to the tenant.
--    MMIL calls Obara "TH1M". GM India calls them something else.
--    Stored per (tenant, customer) so we can match incoming POs by
--    their vendor code field.
-- ---------------------------------------------------------------------------

create table if not exists customer_vendor_codes (
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  vendor_code text not null,
  is_primary boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  primary key (tenant_id, customer_id, vendor_code)
);

create index if not exists customer_vendor_codes_lookup
  on customer_vendor_codes (tenant_id, vendor_code);

alter table customer_vendor_codes enable row level security;
drop policy if exists customer_vendor_codes_select on customer_vendor_codes;
create policy customer_vendor_codes_select on customer_vendor_codes
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists customer_vendor_codes_write on customer_vendor_codes;
create policy customer_vendor_codes_write on customer_vendor_codes
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

-- ---------------------------------------------------------------------------
-- 7. order_line_tax_components: per-line tax + charge decomposition.
--    The Meridian PO carries SGST + CGST + IGST + UTGST + Excise Duty +
--    Ed. Cess + S-VAT + C-VAT + Tooling Cost + P&F + Others. Today
--    Anvil only models SGST / CGST / IGST as item_master columns.
-- ---------------------------------------------------------------------------

create table if not exists order_line_tax_components (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  line_index int not null,
  component_code text not null,             -- sgst, cgst, igst, utgst, excise, ed_cess, svat, cvat, tooling, pnf, others, ...
  component_label text,
  amount numeric(18, 4) not null default 0,
  rate_pct numeric(8, 6),
  is_inclusive boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  unique (tenant_id, order_id, line_index, component_code)
);

create index if not exists order_line_tax_lookup
  on order_line_tax_components (tenant_id, order_id);

alter table order_line_tax_components enable row level security;
drop policy if exists order_line_tax_components_select on order_line_tax_components;
create policy order_line_tax_components_select on order_line_tax_components
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists order_line_tax_components_write on order_line_tax_components;
create policy order_line_tax_components_write on order_line_tax_components
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

-- Component-code reference (global seed for the UI).
create table if not exists order_line_tax_component_codes (
  code text primary key,
  label text not null,
  category text not null check (category in ('gst', 'legacy_tax', 'charge', 'other')),
  is_active boolean not null default true,
  sort_order int not null default 100
);

alter table order_line_tax_component_codes enable row level security;
drop policy if exists order_line_tax_component_codes_select on order_line_tax_component_codes;
create policy order_line_tax_component_codes_select on order_line_tax_component_codes for select using (true);

insert into order_line_tax_component_codes (code, label, category, sort_order) values
  ('sgst',        'SGST',                 'gst',         10),
  ('cgst',        'CGST',                 'gst',         20),
  ('igst',        'IGST',                 'gst',         30),
  ('utgst',       'UTGST',                'gst',         40),
  ('cess',        'GST Compensation Cess','gst',         50),
  ('excise',      'Excise Duty',          'legacy_tax',  60),
  ('ed_cess',     'Education Cess',       'legacy_tax',  70),
  ('svat',        'State VAT',            'legacy_tax',  80),
  ('cvat',        'Central VAT',          'legacy_tax',  90),
  ('tooling',     'Tooling Cost',         'charge',     100),
  ('pnf',         'Packing and Forwarding','charge',    110),
  ('freight',     'Freight',              'charge',     120),
  ('insurance',   'Insurance',            'charge',     130),
  ('handling',    'Handling',             'charge',     140),
  ('others',      'Others',               'other',      200)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 8. Order-level shipping + commercial metadata.
--    Carries the Sales Order header rows that have no home today
--    (Dispatch mode "By Ocean", Registration Serial No, delivery
--    point contact, terms of delivery).
-- ---------------------------------------------------------------------------

alter table orders
  add column if not exists dispatch_mode text,
  add column if not exists registration_serial_no text,
  add column if not exists delivery_point_contact_id uuid references customer_contacts(id) on delete set null,
  add column if not exists delivery_terms text,
  add column if not exists incoterm_code text,
  add column if not exists vendor_code text,
  add column if not exists template_id uuid references document_templates(id) on delete set null;

comment on column orders.vendor_code is
  'The vendor code the customer uses for the tenant (MMIL calls Obara TH1M).';
comment on column orders.dispatch_mode is
  'Free text but commonly air / ocean / road / courier. Renders on the sales order PDF.';

-- Source-po extension: capture the customer requisition number that
-- appears on the inbound PO body (MMIL: 1000372863).
alter table source_pos
  add column if not exists requisition_no text;

create index if not exists source_pos_requisition_idx
  on source_pos (tenant_id, requisition_no)
  where requisition_no is not null;

-- ---------------------------------------------------------------------------
-- 9. tenant_pricing_settings: per-tenant defaults for the price
--    composition cockpit. Multiplication factors per currency, target
--    margin, conversion factor. These were inline constants in the
--    Excel sheet (USD 126.6, target margin 35%, conversion 1.63).
-- ---------------------------------------------------------------------------

create table if not exists tenant_pricing_settings (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  target_margin_pct numeric(8, 6) default 0.35,
  default_conversion_factor numeric(10, 6) default 1.0,
  multiplication_factors jsonb default '{}'::jsonb,
  default_freight_mode text default 'ocean',
  enable_landed_cost boolean default true,
  rounding_rule text default 'NEAREST_1',     -- NEAREST_1 | NEAREST_10 | NEAREST_100 | NONE
  show_supplier_price_in_quote boolean default false,
  show_reference_price_in_quote boolean default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table tenant_pricing_settings enable row level security;
drop policy if exists tenant_pricing_settings_select on tenant_pricing_settings;
create policy tenant_pricing_settings_select on tenant_pricing_settings
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists tenant_pricing_settings_write on tenant_pricing_settings;
create policy tenant_pricing_settings_write on tenant_pricing_settings
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

-- ---------------------------------------------------------------------------
-- 10. customer_terms_packs: per-customer reusable boilerplate libraries.
--     MMIL's 15-clause T&C set lives here once and applies to every
--     order they place. The 15 paragraphs become rows so individual
--     clauses can be acknowledged or overridden.
-- ---------------------------------------------------------------------------

create table if not exists customer_terms_packs (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  pack_name text not null,
  version int not null default 1,
  is_active boolean not null default true,
  effective_from date,
  effective_to date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, customer_id, pack_name, version)
);

create table if not exists customer_terms_clauses (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  pack_id uuid not null references customer_terms_packs(id) on delete cascade,
  clause_index int not null,
  heading text,
  body text not null,
  is_blocking boolean not null default false,
  acknowledged_at timestamptz,
  acknowledged_by text,
  created_at timestamptz not null default now()
);

create index if not exists customer_terms_clauses_pack_idx
  on customer_terms_clauses (tenant_id, pack_id, clause_index);

alter table customer_terms_packs enable row level security;
alter table customer_terms_clauses enable row level security;

drop policy if exists customer_terms_packs_select on customer_terms_packs;
create policy customer_terms_packs_select on customer_terms_packs
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists customer_terms_packs_write on customer_terms_packs;
create policy customer_terms_packs_write on customer_terms_packs
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

drop policy if exists customer_terms_clauses_select on customer_terms_clauses;
create policy customer_terms_clauses_select on customer_terms_clauses
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists customer_terms_clauses_write on customer_terms_clauses;
create policy customer_terms_clauses_write on customer_terms_clauses
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

-- ---------------------------------------------------------------------------
-- 11. Updated-at triggers
-- ---------------------------------------------------------------------------

drop trigger if exists document_templates_updated_at on document_templates;
create trigger document_templates_updated_at
  before update on document_templates
  for each row execute function bump_updated_at();

drop trigger if exists price_composition_lines_updated_at on price_composition_lines;
create trigger price_composition_lines_updated_at
  before update on price_composition_lines
  for each row execute function bump_updated_at();

drop trigger if exists freight_rates_updated_at on freight_rates;
create trigger freight_rates_updated_at
  before update on freight_rates
  for each row execute function bump_updated_at();

drop trigger if exists tenant_pricing_settings_updated_at on tenant_pricing_settings;
create trigger tenant_pricing_settings_updated_at
  before update on tenant_pricing_settings
  for each row execute function bump_updated_at();

drop trigger if exists customer_terms_packs_updated_at on customer_terms_packs;
create trigger customer_terms_packs_updated_at
  before update on customer_terms_packs
  for each row execute function bump_updated_at();
