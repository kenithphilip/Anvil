-- supabase/seed.sql
-- One-shot bootstrap of the Obara India default tenant + corpus seed data.
--
-- Paste this whole file into the Supabase SQL Editor (or feed it to psql)
-- against a project where migrations 001 - 010 have already been applied.
-- Idempotent: re-running on an already-seeded project is a no-op.
--
-- This is the inlined concatenation of 007_seed_real_corpus_data.sql and
-- 010_seed_corpus_round2_data.sql for SQL Editor convenience. The originals
-- in supabase/migrations/ remain the source of truth for fresh deploys.
--
-- After it runs, the bottom SELECT prints a one-row-per-relation summary so
-- you can verify what landed.

-- ===========================================================================
-- ROUND 1 SEEDS (007_seed_real_corpus_data.sql)
-- ===========================================================================
-- 007_seed_real_corpus_data.sql
-- Seeds real customer master rows (Vega Motor, WGX, Comet Motors, ABC Motors)
-- and 35 item master rows extracted from the corpus
-- (Item Master Template-FEB-2024.xlsx).
-- All inserts are idempotent (ON CONFLICT DO NOTHING).
--
-- Tenant resolution: seeds the default tenant 00000000-0000-0000-0000-000000000001
-- if it does not already exist, then attaches all rows to it.

do $$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  mg_customer_id uuid;
  srtx_customer_id uuid;
  tata_customer_id uuid;
  abc_customer_id uuid;
begin
  -- Default tenant (idempotent). Migration 001 already creates this row,
  -- but we double-up here so 007 can run standalone in a fresh DB.
  insert into tenants (id, slug, display_name)
  values (default_tenant, 'default', 'Obara India (default)')
  on conflict (id) do nothing;

  -- ── Customers ─────────────────────────────────────────────────────────────
  insert into customers (tenant_id, customer_key, customer_name, gstin, state_code, pan, customer_type, default_payment_terms, default_incoterms, notes)
  values
    (default_tenant, 'MG_MOTOR_INDIA', 'Vega Motor India Pvt. Ltd.', '24AAKCM8110E1ZR', 'GJ', 'AAKCM8110E', 'AUTO_OEM', 'Net 30 days NEFT', 'FOR MGI Halol Plant', 'Real customer from corpus: 11 blanket POs against OIQTLC-240123-MG-CONSUMABLES'),
    (default_tenant, 'WGX', 'WGX', null, null, null, 'TIER_ONE', null, null, 'Real customer from corpus: WGX-2C15968L-IND PO + EG SHEET'),
    (default_tenant, 'TATA_MOTORS_PV_PUNE', 'Comet Motors Passenger Vehicles Limited (Pune)', null, 'MH', null, 'AUTO_OEM', 'Net 45 days', null, 'Real customer from Pending Sales Order tracker'),
    (default_tenant, 'ABC_MOTORS', 'ABC Motors', null, null, null, 'AUTO_OEM', null, null, 'Sample customer from Dummy Pricecompo workflow examples')
  on conflict (tenant_id, customer_key) do nothing;

  select id into mg_customer_id   from customers where tenant_id = default_tenant and customer_key = 'MG_MOTOR_INDIA';
  select id into srtx_customer_id from customers where tenant_id = default_tenant and customer_key = 'WGX';
  select id into tata_customer_id from customers where tenant_id = default_tenant and customer_key = 'TATA_MOTORS_PV_PUNE';
  select id into abc_customer_id  from customers where tenant_id = default_tenant and customer_key = 'ABC_MOTORS';

  -- ── Customer locations (multi-GSTIN per customer) ────────────────────────
  if mg_customer_id is not null then
    insert into customer_locations (tenant_id, customer_id, location_code, plant_name, gstin, state_code, city, is_default)
    values
      (default_tenant, mg_customer_id, 'HALOL', 'MGI Halol Plant', '24AAKCM8110E1ZR', '24', 'Halol', true),
      (default_tenant, mg_customer_id, 'HARYANA', 'MGI Haryana Plant', '06AAKCM8110E1ZP', '06', null, false)
    on conflict (tenant_id, customer_id, location_code) do nothing;
  end if;

  if tata_customer_id is not null then
    insert into customer_locations (tenant_id, customer_id, location_code, plant_name, state_code, city, is_default)
    values
      (default_tenant, tata_customer_id, 'PUNE', 'Comet Motors Pune Plant', '27', 'Pune', true)
    on conflict (tenant_id, customer_id, location_code) do nothing;
  end if;
end $$;

-- ── Item master (35 rows from Item Master Template-FEB-2024.xlsx) ──────────
-- HSN code references:
--   85159000 = electric soldering, brazing, welding machines (general spares)
--   85446020 = insulated cable assemblies
--   85446030 = power cables
--   39173100 = flexible plastic tubing
--   82081000 = cutting blade tools
--   85152110 = AC welding machines (servo guns)
--   84612019 = other planing/shaping machines (ATD with cutter)
--   998732 = engineering services (drawing updation)
--   996531 = installation services (modification charges)

do $$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
begin
  insert into item_master (tenant_id, part_no, description, drawing_no, uom, source_country, source_currency, purchase_price, purchase_quote_no, purchase_quote_validity_start, purchase_quote_validity_end, hsn_sac, sgst_rate, cgst_rate, igst_rate, lifecycle, is_assembly)
  values
    -- O-KOREA (USD)
    (default_tenant, '4-TP3082',                'CAP TIP',                                                  '4-TP3082',                'Nos', 'O-KOREA', 'USD', 0.85,    'XXX',           '2024-01-22', '2024-04-30', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'IN0-0133',                'TERMINAL BOX ASSY',                                        'IN0-0133',                'Nos', 'O-KOREA', 'USD', 600,     'XXX',           '2024-01-22', '2024-04-30', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', true),
    (default_tenant, 'SW-Y1000-6P-MM-H/S',      'CONNECTOR CABLE',                                          'SW-Y1000-6P-MM-H/S',      'Nos', 'O-KOREA', 'USD', 65,      'XXX',           '2024-01-22', '2024-04-30', '85446020', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, '403A7K878-169',           'Point Holder',                                             '403A7K878-169',           'Nos', 'O-KOREA', 'USD', 150,     'XXX',           '2024-01-22', '2024-04-30', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, '4-HD32208-2',             'Holder',                                                   '4-HD32208-2',             'Nos', 'O-KOREA', 'USD', 200,     'XXX',           '2024-01-22', '2024-04-30', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'CT-16-D-1-FS',            'Cap Tip',                                                  'CT-16-D-1-FS',            'Nos', 'O-KOREA', 'USD', 0.80,    'XXX',           '2024-02-07', '2024-04-30', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'X2C-X-MEDIUM',            'MFDC Servo Gun Without Servo Motor-X2C X-MEDIUM',          null,                      'Nos', 'O-KOREA', 'USD', 8000,    'O-KOR-240207',  '2024-02-07', '2024-04-30', '85152110', 0.09, 0.09, 0.18, 'ACTIVE', true),
    (default_tenant, 'X2C-X-LARGE',             'MFDC Servo Gun Without Servo Motor-X2C X-LARGE',           null,                      'Nos', 'O-KOREA', 'USD', 8500,    'O-KOR-240207',  '2024-02-07', '2024-04-30', '85152110', 0.09, 0.09, 0.18, 'ACTIVE', true),
    (default_tenant, 'X2C-X-EXTRA-LARGE',       'MFDC Servo Gun Without Servo Motor-X2C X-EXTRA LARGE',     null,                      'Nos', 'O-KOREA', 'USD', 9000,    'O-KOR-240207',  '2024-02-07', '2024-04-30', '85152110', 0.09, 0.09, 0.18, 'ACTIVE', true),
    (default_tenant, 'SBA-X-MEDIUM',            'AC Servo Gun Without Servo Motor-SBA X-Medium',            null,                      'Nos', 'O-KOREA', 'USD', 4490,    'XXX',           '2024-02-07', '2024-04-30', '85152110', 0.09, 0.09, 0.18, 'ACTIVE', true),
    (default_tenant, 'DRAWING_UPDATION_FEE',    'Drawing Updation Fee',                                     null,                      'Nos', 'O-KOREA', 'USD', 200,     'XXX',           '2024-02-07', '2024-04-30', '998732',   0.09, 0.09, 0.18, 'ACTIVE', false),
    -- O-JAPAN (JPY)
    (default_tenant, 'RB300687S',               'SHUNT',                                                    'RB300687S',               'Nos', 'O-JAPAN', 'JPY', 30000,   'XXX',           '2024-02-08', '2024-04-30', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'PSD-90',                  'SEAL',                                                     'PSD-90',                  'Nos', 'O-JAPAN', 'JPY', 750,     'XXX',           '2024-02-08', '2024-04-30', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'W-UNT-KHX-1(MA)',         'GEAR CASE ASSY',                                           'J5E0362',                 'Nos', 'O-JAPAN', 'JPY', 300000,  'XXX',           '2024-01-20', '2024-04-30', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', true),
    (default_tenant, 'SCB-20',                  'SCRAPER',                                                  'SCB-20',                  'Nos', 'O-JAPAN', 'JPY', 450,     'XXX',           '2024-01-20', '2024-04-30', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'MA460656S-1',             'SHUNT',                                                    'MA460656S-1',             'Nos', 'O-JAPAN', 'JPY', 27000,   'XXX',           '2024-01-20', '2024-04-30', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    -- O-CHINA (CNY)
    (default_tenant, '4-250383',                'COOLING TUBE',                                             '4-250383',                'Mtr', 'O-CHINA', 'CNY', 25,      'XXX',           '2024-02-07', '2024-04-30', '39173100', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'SB28386',                 'OIL SEAL',                                                 'SB28386',                 'Nos', 'O-CHINA', 'CNY', 35,      'XXX',           '2024-02-07', '2024-04-30', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'DJZJ-010234',             'Cutter Holder Assy',                                       'DJZJ-010234',             'Nos', 'O-CHINA', 'CNY', 835,     'XXX',           '2024-02-07', '2024-04-30', '82081000', 0.09, 0.09, 0.18, 'ACTIVE', true),
    (default_tenant, 'C-3-321226',              'SHUNT',                                                    'C-3-321226',              'Nos', 'O-CHINA', 'CNY', 500,     'XXX',           '2024-02-07', '2024-04-30', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'SIV32_ADAPTIVE_TIMER',    'MFDC ADAPTIVE TIMER WITH DEVICENET COMMUNICATION',         null,                      'Nos', 'O-CHINA', 'CNY', 35000,   'WU-240207',     '2024-02-07', '2024-04-30', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'JC_ATD_CUTTER_ASSY',      'JC-ATD with Cutter assy',                                  null,                      'Nos', 'O-CHINA', 'CNY', 8000,    'WU-240207',     '2024-02-07', '2024-04-30', '84612019', 0.09, 0.09, 0.18, 'ACTIVE', true),
    (default_tenant, 'TP-C',                    'Teaching Pendant TP-C',                                    null,                      'Nos', 'O-CHINA', 'CNY', 2500,    'WU-240207',     '2024-02-07', '2024-04-30', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'PENDANT_CABLE_5M',        'Pendant cable-5Mtr',                                       null,                      'Nos', 'O-CHINA', 'CNY', 500,     'WU-240207',     '2024-02-07', '2024-04-30', '85446030', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'STN-21_TIMER_DEVICENET',  'AC TIMER WITH DEVICENET STN-21',                           null,                      'Nos', 'O-CHINA', 'CNY', 6980,    'XXX',           '2024-02-07', '2024-04-30', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'JC_ATD_CUTTER_ASSY_V2',   'JC-ATD With Cutter Assy v2',                               null,                      'Nos', 'O-CHINA', 'CNY', 6900,    'XXX',           '2024-02-07', '2024-04-30', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', true),
    (default_tenant, 'TPN-NET',                 'TEACHING PENDANT TPN-NET',                                 null,                      'Nos', 'O-CHINA', 'CNY', 1500,    'XXX',           '2024-02-07', '2024-04-30', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'PN/C-10M-A',              'PENDENT CABLE PN/C-10M-A',                                 null,                      'Nos', 'O-CHINA', 'CNY', 300,     'XXX',           '2024-02-07', '2024-04-30', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    -- O-INDIA (INR)
    (default_tenant, 'OIDA1116',                'Color Sensor Assembly',                                    'OIDA1116',                'Nos', 'O-INDIA', 'INR', 40000,   'XXX',           '2024-02-08', '2024-04-30', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', true),
    (default_tenant, 'THB-K1-80B',              'Bend Adapter THB-K1-80B',                                  '3-380191',                'Nos', 'O-INDIA', 'INR', 4500,    'XXX',           '2024-02-07', '2024-04-30', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, '4-TB2079-1',              'TIP BASE',                                                 '4-TB2079-1',              'Nos', 'O-INDIA', 'INR', 18000,   'XXX',           '2024-02-07', '2024-04-30', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'TNA-13-04-110-2',         'ADAPTER',                                                  'TNA-13-04-110-2',         'Nos', 'O-INDIA', 'INR', 1500,    'XXX',           '2024-02-07', '2024-04-30', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'W-AD-A-10',               'ADAPTER W-AD-A-10',                                        '4-022238-00310',          'Nos', 'O-INDIA', 'INR', 3500,    'XXX',           '2024-02-07', '2024-04-30', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'C007011',                 'NIPPLE',                                                   'C007011',                 'Nos', 'O-INDIA', 'INR', 150,     'XXX',           '2024-02-08', '2024-04-30', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, '180X0.6-CXF-M',           'Aid Cable 180X0.6-CXF-M',                                  '180X0.6-CXF-M',           'Nos', 'O-INDIA', 'INR', 2000,    'XXX',           '2024-02-08', '2024-04-30', '85446030', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, '180X0.8-CXF-M',           'Aid Cable 180X0.8-CXF-M',                                  '180X0.8-CXF-M',           'Nos', 'O-INDIA', 'INR', 4000,    'XXX',           '2024-02-08', '2024-04-30', '85446030', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'X-HD0026-1',              'Bend Holder X-HD0026-1',                                   'X-HD0026-1',              'Nos', 'O-INDIA', 'INR', 3475,    'XXX',           '2024-02-08', '2024-04-30', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'C036760',                 'Tip Base C036760',                                         'C036760',                 'Nos', 'O-INDIA', 'INR', 23000,   'XXX',           '2024-02-08', '2024-04-30', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'C035467',                 'Low Adapter C035467',                                      'C035467',                 'Nos', 'O-INDIA', 'INR', 30000,   'XXX',           '2024-02-08', '2024-04-30', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'BADI001558-3',            'Bend Adapter BADI001558-3',                                'BADI001558-3',            'Nos', 'O-INDIA', 'INR', 20000,   'XXX',           '2024-02-07', '2024-04-30', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'COOL4X6',                 'Teflon Hose COOL4X6',                                      'COOL4X6',                 'Mtr', 'O-INDIA', 'INR', 200,     'XXX',           '2024-02-07', '2024-04-30', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'NAME_PLATE_4_RIVET',      'NAME PLATE WITH 4NOS RIVET',                               null,                      'Nos', 'O-INDIA', 'INR', 100,     'XXX',           '2024-02-07', '2024-04-30', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'MOD_FOR_WGX_2C7507L',    'Modification for WGX-2C7507L-IND',                        null,                      'Nos', 'O-INDIA', 'INR', null,    'ASSEMBLY ITEM', null,         null,         '85159000', 0.09, 0.09, 0.18, 'ACTIVE', true),
    (default_tenant, 'MODIFICATION_CHARGES',    'Modification Charges',                                     null,                      'Nos', 'O-INDIA', 'INR', 10000,   'XXX',           '2024-02-07', '2024-04-30', '996531',   0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'POWER_CABLE_15M',         'Power Cable 15Mtr',                                        null,                      'Nos', 'O-INDIA', 'INR', 25000,   'XXX',           '2024-02-07', '2024-04-30', '85446030', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'POWER_CABLE_10M',         'Power Cable 10M',                                          null,                      'Nos', 'O-INDIA', 'INR', 15000,   'XXX',           '2024-02-07', '2024-04-30', '85446030', 0.09, 0.09, 0.18, 'ACTIVE', false)
  on conflict (tenant_id, part_no) do nothing;
end $$;


-- ===========================================================================
-- ROUND 2 SEEDS (010_seed_corpus_round2_data.sql)
-- ===========================================================================
-- 010_seed_corpus_round2_data.sql
-- Concrete seeds extracted from the round-2 deep-read of the Obara corpus.
--
-- New customers: NRD Auto (Plant 1 spare matrix, 2024-05-29 snapshot),
-- Alliance Auto (ALAP), MG Halol & Haryana variants confirmed.
--
-- New rows:
--   * customers + customer_locations for NRD, ALAP
--   * MG master contract (OIQTLC-240123) + 11 release POs
--   * payment_milestones for MG (50/50), ABC FOR mode, ABC HSS mode
--   * customer_format_profiles for MG, WGX, ABC variants
--   * engineering_specs for WGX (BOM payload + FANUC motor reference)
--   * 60 additional item_master rows (extra HSN codes, NRD matrix parts)
--   * approval_thresholds (Sales Manager / Finance / Director ladder)
--   * expense_rate_cards (design/install/travel manday + buffer pcts)
--   * sample shipments with real vessels (HX-2628Y, HX-2786Y, HX-2780Y)
--   * sample equipment_hierarchy + equipment_installed_parts for NRD
--
-- Idempotent: ON CONFLICT DO NOTHING / unique guards everywhere.
-- Tenant: 00000000-0000-0000-0000-000000000001

-- ───────────────────────────────────────────────────────────────────────────
-- A. New customers + locations
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  jbm_id uuid;
  rnaipl_id uuid;
  mg_id uuid;
  abc_id uuid;
  tata_id uuid;
begin
  -- NRD Auto (Plant 1 spare matrix is the source for items + equipment)
  insert into customers (tenant_id, customer_key, customer_name, customer_type, default_payment_terms, default_incoterms, notes)
  values
    (default_tenant, 'NRD_AUTO_PLANT_1', 'NRD Auto Limited (Plant 1)', 'TIER_ONE', 'Net 45 days NEFT', 'FOR Plant 1', 'From NRD Plant 1 Spare Matrix 29-05-2024'),
    (default_tenant, 'ALAP', 'Alliance Auto Automotive India Pvt. Ltd.', 'AUTO_OEM', 'Net 30 days NEFT', 'FOR Oragadam', 'From Pending Sales Order tracker')
  on conflict (tenant_id, customer_key) do nothing;

  select id into jbm_id    from customers where tenant_id = default_tenant and customer_key = 'NRD_AUTO_PLANT_1';
  select id into rnaipl_id from customers where tenant_id = default_tenant and customer_key = 'ALAP';
  select id into mg_id     from customers where tenant_id = default_tenant and customer_key = 'MG_MOTOR_INDIA';
  select id into abc_id    from customers where tenant_id = default_tenant and customer_key = 'ABC_MOTORS';
  select id into tata_id   from customers where tenant_id = default_tenant and customer_key = 'TATA_MOTORS_PV_PUNE';

  if jbm_id is not null then
    insert into customer_locations (tenant_id, customer_id, location_code, plant_name, state_code, city, is_default, tax_treatment)
    values
      (default_tenant, jbm_id, 'PLANT-1', 'NRD Plant 1', '06', 'Faridabad', true, 'AUTO')
    on conflict (tenant_id, customer_id, location_code) do nothing;
  end if;

  if rnaipl_id is not null then
    insert into customer_locations (tenant_id, customer_id, location_code, plant_name, state_code, city, is_default, tax_treatment)
    values
      (default_tenant, rnaipl_id, 'ORAGADAM', 'ALAP Oragadam', '33', 'Chennai', true, 'IGST_ONLY')
    on conflict (tenant_id, customer_id, location_code) do nothing;
  end if;

  -- Update existing locations with explicit tax_treatment now that the column exists
  update customer_locations
     set tax_treatment = 'CGST_SGST_SPLIT'
   where tenant_id = default_tenant
     and state_code = '24'
     and tax_treatment = 'AUTO';

  update customer_locations
     set tax_treatment = 'IGST_ONLY'
   where tenant_id = default_tenant
     and state_code in ('06','27','33')
     and tax_treatment = 'AUTO';
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- B. Approval thresholds (3-level ladder per BRD)
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
begin
  -- Sales Manager: 0 - 2,000,000 INR
  insert into quote_approval_thresholds (tenant_id, approver_role, min_amount_inr, max_amount_inr, active)
  select default_tenant, 'sales_manager'::obara_role, 0, 2000000, true
  where not exists (
    select 1 from quote_approval_thresholds
    where tenant_id = default_tenant and approver_role = 'sales_manager'::obara_role and min_amount_inr = 0 and max_amount_inr = 2000000
  );

  -- Finance: 2,000,000 - 5,000,000 INR
  insert into quote_approval_thresholds (tenant_id, approver_role, min_amount_inr, max_amount_inr, active)
  select default_tenant, 'finance'::obara_role, 2000000, 5000000, true
  where not exists (
    select 1 from quote_approval_thresholds
    where tenant_id = default_tenant and approver_role = 'finance'::obara_role and min_amount_inr = 2000000 and max_amount_inr = 5000000
  );

  -- Admin (acts as Director): >5,000,000 INR
  insert into quote_approval_thresholds (tenant_id, approver_role, min_amount_inr, max_amount_inr, active)
  select default_tenant, 'admin'::obara_role, 5000000, null, true
  where not exists (
    select 1 from quote_approval_thresholds
    where tenant_id = default_tenant and approver_role = 'admin'::obara_role and min_amount_inr = 5000000 and max_amount_inr is null
  );

  -- Margin-below trigger: any quote with margin < 10% needs Finance regardless of value
  insert into quote_approval_thresholds (tenant_id, approver_role, min_amount_inr, max_amount_inr, margin_below_pct, active)
  select default_tenant, 'finance'::obara_role, 0, null, 0.10, true
  where not exists (
    select 1 from quote_approval_thresholds
    where tenant_id = default_tenant and approver_role = 'finance'::obara_role and margin_below_pct = 0.10
  );
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- C. Expense rate cards (cost simulator base values)
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
begin
  insert into expense_rate_cards (tenant_id, rate_code, label, rate_inr, pct, currency, active, notes) values
    (default_tenant, 'design_manday',          'Design man-day rate',                   750,    null,   'INR', true, 'Per BRD cost simulator'),
    (default_tenant, 'install_manday',         'Installation man-day rate',             1000,   null,   'INR', true, 'Per BRD cost simulator'),
    (default_tenant, 'travel_manday',          'Travel man-day allowance',              1500,   null,   'INR', true, 'Per BRD cost simulator'),
    (default_tenant, 'warranty_buffer_pct',    'Warranty cost buffer',                  null,   0.0100, 'INR', true, '1% of purchase value'),
    (default_tenant, 'currency_fluctuation_pct','Forward FX buffer',                    null,   0.0150, 'INR', true, '1.5% on USD/JPY/CNY orders'),
    (default_tenant, 'sales_expense_pct',      'Sales expense allocation',              null,   0.0100, 'INR', true, '1% on landed cost'),
    (default_tenant, 'project_admin_pct',      'Project admin overhead',                null,   0.0100, 'INR', true, '1% on landed cost'),
    (default_tenant, 'finance_charge_pct',     'Finance / interest charge',             null,   0.0100, 'INR', true, '1% on landed cost'),
    (default_tenant, 'transport_inland_pct',   'Inland transport buffer',               null,   0.0050, 'INR', true, '0.5% on landed cost'),
    (default_tenant, 'cha_clearance_inr',      'CHA / clearance per shipment',          15000,  null,   'INR', true, 'Customs House Agent fee'),
    (default_tenant, 'insurance_pct',          'Marine insurance',                      null,   0.0025, 'INR', true, '0.25% on CIF value')
  on conflict (tenant_id, rate_code) do nothing;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- D. WGX engineering specs row (BOM-style with assembly references)
-- The WGX-2C16934L-IND sheet is a BOM, not a spec sheet, but it contains the
-- FANUC motor model (A06B-0235-B605) and a full assembly tree we want to
-- preserve. Numeric spec fields are null because the source has none.
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
begin
  insert into engineering_specs (
    tenant_id, part_no, spec_type, motor_model,
    drawing_no, issued_by, issued_on, payload
  ) values (
    default_tenant,
    'WGX-2C16934L-IND',
    'gun',
    'A06B-0235-B605 (FANUC)',
    null,
    'ABHISHEK H.',
    '2024-07-18'::date,
    jsonb_build_object(
      'item_no',           '307229053',
      'product_code',      'WGX-2C16934L-IND',
      'left_or_right',     'L',
      'main_body_assy',    'MBAC-WGX-2C16934L',
      'arm_assy',          'XSGZX-206050 (D45, 2-phi8H7--&gt;M5)',
      'movable_yoke_assy', 'XSYZX-206135 (D45, 2-phi8H7--&gt;M5)',
      'x2c_body_assy',     'X2C-XS-DB6-ST110-HH-01',
      'bracket_assy',      'C037251-A6 (S, PCD125, 6-phi14, 6-phi10H7, L=410, H=35)',
      'motor_part_no',     'MOTOR-441 / A06B-0235-B605(FANUC)',
      'gear_case_assy',    'J5E0379 (FANUC 160ST standard, no oil supply)',
      'ball_screw_assy',   'J443953-PMI (BA707520035-0)',
      'transformer',       'DB6-100R1-V2 (ABB-0120)',
      'terminal_box_assy', 'C105237CL',
      'cooling_circuit',   'C009119C (X2C-X, 2-3-2, G-R, KQ2H12-03S)',
      'electrode_cap',     'T-16-D',
      'low_adapter',       'LADC021842-3 (IND-D45-194-50)',
      'bend_adapter',      'GBC025559-3 (IND-D45-194-135-15deg)',
      'shunt',             'U3-013249A (750SQMM, L=300)',
      'insulation_assy',   '3-432781 (PCD125, D=75, T=20, 6-M10)'
    )
  )
  on conflict (tenant_id, part_no) do nothing;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- E. ABC Motors payment milestones (FOR mode + HSS mode)
-- The ABC sample workflows show two distinct payment ladders.
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  abc_id uuid;
  abc_for_contract uuid;
  abc_hss_contract uuid;
begin
  select id into abc_id from customers where tenant_id = default_tenant and customer_key = 'ABC_MOTORS';
  if abc_id is null then return; end if;

  -- ABC FOR mode template contract (used as a milestone container, not a real PO)
  insert into contracts (tenant_id, customer_id, contract_type, contract_number, start_date, status, currency, notes)
  values (default_tenant, abc_id, 'ONE_OFF', 'ABC-PAYMENT-TEMPLATE-FOR', '2024-01-01'::date, 'ACTIVE', 'INR',
          'Template milestones for ABC FOR-mode projects')
  on conflict (tenant_id, contract_number) do nothing;
  select id into abc_for_contract from contracts where tenant_id = default_tenant and contract_number = 'ABC-PAYMENT-TEMPLATE-FOR';

  insert into contracts (tenant_id, customer_id, contract_type, contract_number, start_date, status, currency, notes)
  values (default_tenant, abc_id, 'ONE_OFF', 'ABC-PAYMENT-TEMPLATE-HSS', '2024-01-01'::date, 'ACTIVE', 'USD',
          'Template milestones for ABC HSS-mode projects')
  on conflict (tenant_id, contract_number) do nothing;
  select id into abc_hss_contract from contracts where tenant_id = default_tenant and contract_number = 'ABC-PAYMENT-TEMPLATE-HSS';

  if abc_for_contract is not null then
    insert into payment_milestones (tenant_id, contract_id, sequence, label, pct, trigger, due_days, payment_method, notes) values
      (default_tenant, abc_for_contract, 1, 'Advance on PO',          30, 'po_received',  0,  'NEFT', 'FOR mode template'),
      (default_tenant, abc_for_contract, 2, 'Pre-dispatch balance',   60, 'pre_dispatch', 0,  'NEFT', 'FOR mode template'),
      (default_tenant, abc_for_contract, 3, 'Post-installation hold', 10, 'post_install', 30, 'NEFT', 'FOR mode template')
    on conflict (tenant_id, contract_id, sequence) where contract_id is not null do nothing;
  end if;

  if abc_hss_contract is not null then
    insert into payment_milestones (tenant_id, contract_id, sequence, label, pct, trigger, due_days, payment_method, notes) values
      (default_tenant, abc_hss_contract, 1, 'L/C at sight',           80, 'shipping_doc', 0,  'Wire',  'HSS mode template'),
      (default_tenant, abc_hss_contract, 2, 'BOL receipt',            15, 'bol_received', 0,  'Wire',  'HSS mode template'),
      (default_tenant, abc_hss_contract, 3, 'Post-arrival',           5,  'post_arrival', 14, 'Wire',  'HSS mode template')
    on conflict (tenant_id, contract_id, sequence) where contract_id is not null do nothing;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- F. Additional item_master rows (HSN expansion: 71829200, 40169320, 85439000)
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
begin
  insert into item_master (
    tenant_id, part_no, description, drawing_no, uom, source_country, source_currency,
    purchase_price, purchase_quote_no, purchase_quote_validity_start, purchase_quote_validity_end,
    hsn_sac, sgst_rate, cgst_rate, igst_rate, lifecycle, is_assembly,
    moq, pack_size, is_critical
  ) values
    -- HSN 71829200 (insulating washers)
    (default_tenant, 'INSUL-WASHER-M10', 'Insulating washer M10',  null, 'Nos', 'O-CHINA', 'CNY', 12,   'XXX', '2024-02-01', '2024-12-31', '71829200', 0.09, 0.09, 0.18, 'ACTIVE', false, 100, 100, false),
    (default_tenant, 'INSUL-WASHER-M12', 'Insulating washer M12',  null, 'Nos', 'O-CHINA', 'CNY', 14,   'XXX', '2024-02-01', '2024-12-31', '71829200', 0.09, 0.09, 0.18, 'ACTIVE', false, 100, 100, false),
    (default_tenant, 'INSUL-WASHER-M16', 'Insulating washer M16',  null, 'Nos', 'O-CHINA', 'CNY', 16,   'XXX', '2024-02-01', '2024-12-31', '71829200', 0.09, 0.09, 0.18, 'ACTIVE', false, 100, 100, false),
    -- HSN 40169320 (rubber O-rings)
    (default_tenant, 'ORING-G50-NBR',    'O-ring G50 NBR',         null, 'Nos', 'O-JAPAN', 'JPY', 80,   'XXX', '2024-02-01', '2024-12-31', '40169320', 0.09, 0.09, 0.18, 'ACTIVE', false, 50,  50,  false),
    (default_tenant, 'ORING-G75-NBR',    'O-ring G75 NBR',         null, 'Nos', 'O-JAPAN', 'JPY', 95,   'XXX', '2024-02-01', '2024-12-31', '40169320', 0.09, 0.09, 0.18, 'ACTIVE', false, 50,  50,  false),
    (default_tenant, 'ORING-G110-NBR',   'O-ring G110 NBR',        null, 'Nos', 'O-JAPAN', 'JPY', 130,  'XXX', '2024-02-01', '2024-12-31', '40169320', 0.09, 0.09, 0.18, 'ACTIVE', false, 50,  50,  false),
    -- HSN 85439000 (parts of electric machines, 9% IGST cables)
    (default_tenant, 'CABLE-X2C-PWR-3M', 'Power cable X2C 3 metre',null, 'Nos', 'O-KOREA', 'USD', 110,  'XXX', '2024-02-01', '2024-12-31', '85439000', 0.045,0.045,0.09, 'ACTIVE', false, 10,  10,  false),
    (default_tenant, 'CABLE-X2C-PWR-5M', 'Power cable X2C 5 metre',null, 'Nos', 'O-KOREA', 'USD', 145,  'XXX', '2024-02-01', '2024-12-31', '85439000', 0.045,0.045,0.09, 'ACTIVE', false, 10,  10,  false),
    (default_tenant, 'CABLE-X2C-PWR-7M', 'Power cable X2C 7 metre',null, 'Nos', 'O-KOREA', 'USD', 195,  'XXX', '2024-02-01', '2024-12-31', '85439000', 0.045,0.045,0.09, 'ACTIVE', false, 10,  10,  false),
    -- HSN 85389000 (sub-assemblies for boards)
    (default_tenant, 'PCB-TIMER-DN',     'Timer PCB DeviceNet',    null, 'Nos', 'O-CHINA', 'CNY', 4500, 'XXX', '2024-02-01', '2024-12-31', '85389000', 0.09, 0.09, 0.18, 'ACTIVE', false, 1,   1,   true)
  on conflict (tenant_id, part_no) do nothing;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- G. Real shipments with vessel records (HX-2628Y, HX-2786Y, HX-2780Y)
-- Pulled from the Pending Sales Order tracker.
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
begin
  insert into shipments (tenant_id, shipment_number, mode, carrier, vessel_or_flight, port_of_loading, port_of_discharge, status, remarks, ready_date)
  values
    (default_tenant, 'HX-2628Y-CONS', 'SEA', 'HX', 'HX-2628Y', 'KRPUS', 'INNSA', 'IN_TRANSIT', 'O-KOREA spares consolidation', '2024-06-15'::date),
    (default_tenant, 'HX-2786Y-CONS', 'SEA', 'HX', 'HX-2786Y', 'JPYOK', 'INNSA', 'IN_TRANSIT', 'O-JAPAN gear case + shunt', '2024-07-02'::date),
    (default_tenant, 'HX-2780Y-CONS', 'SEA', 'HX', 'HX-2780Y', 'CNSHA', 'INNSA', 'AT_PORT',    'O-CHINA timer + ATD',       '2024-07-10'::date)
  on conflict (tenant_id, shipment_number) where shipment_number is not null do nothing;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- H. MG master contract + 11 release POs + payment milestones + 25 sample lines
-- Master quote: OIQTLC-240123-MG-CONSUMABLES & MAINTENANCE SPARES-REV-1
-- 11 release POs in MG SAP series 5100002515 - 5100002595
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  mg_id uuid;
  mg_halol_loc uuid;
  master_order_id uuid;
  mg_contract_id uuid;
  release_po text;
  release_pos text[] := array[
    '5100002515','5100002527','5100002528','5100002541','5100002547',
    '5100002549','5100002551','5100002555','5100002559','5100002576','5100002595'
  ];
begin
  select id into mg_id from customers where tenant_id = default_tenant and customer_key = 'MG_MOTOR_INDIA';
  select id into mg_halol_loc from customer_locations where tenant_id = default_tenant and customer_id = mg_id and location_code = 'HALOL';
  if mg_id is null then return; end if;

  -- Master quote (no PO number, only quote_number)
  insert into orders (
    tenant_id, customer_id, customer_location_id, status, quote_number, quote_date,
    order_mode, result, blocker_summary
  )
  select
    default_tenant, mg_id, mg_halol_loc, 'APPROVED'::order_status,
    'OIQTLC-240123-MG-CONSUMABLES & MAINTENANCE SPARES-REV-1', '2024-01-23'::date,
    'SPARES'::order_mode,
    jsonb_build_object(
      'salesOrder', jsonb_build_object(
        'currency', 'INR',
        'incoterms', 'FOR MGI Halol Plant',
        'validity_start', '2024-01-23',
        'validity_end', '2024-04-30',
        'is_master_quote', true
      )
    ),
    null
  where not exists (
    select 1 from orders
    where tenant_id = default_tenant
      and quote_number = 'OIQTLC-240123-MG-CONSUMABLES & MAINTENANCE SPARES-REV-1'
  );

  select id into master_order_id from orders
    where tenant_id = default_tenant
      and quote_number = 'OIQTLC-240123-MG-CONSUMABLES & MAINTENANCE SPARES-REV-1';

  -- Contract row (BLANKET_PO type, ties release POs to the master quote)
  insert into contracts (
    tenant_id, customer_id, contract_type, contract_number,
    parent_quote_id, start_date, end_date, currency, status, notes
  )
  select
    default_tenant, mg_id, 'BLANKET_PO'::contract_type,
    'MG-BLANKET-OIQTLC-240123', master_order_id,
    '2024-01-23'::date, '2025-04-30'::date, 'INR', 'ACTIVE',
    'Vega Motor Halol blanket against OIQTLC-240123 master quote'
  where master_order_id is not null and not exists (
    select 1 from contracts
    where tenant_id = default_tenant and contract_number = 'MG-BLANKET-OIQTLC-240123'
  );

  select id into mg_contract_id from contracts
    where tenant_id = default_tenant and contract_number = 'MG-BLANKET-OIQTLC-240123';

  -- MG payment milestones: 50% advance + 50% pre-dispatch (corpus-confirmed)
  if mg_contract_id is not null then
    insert into payment_milestones (
      tenant_id, contract_id, sequence, label, pct, trigger, due_days, payment_method, notes
    )
    select default_tenant, mg_contract_id, 1, 'Advance on PO', 50, 'po_received', 0, 'NEFT', 'MG 50/50 split'
    where not exists (
      select 1 from payment_milestones
      where tenant_id = default_tenant and contract_id = mg_contract_id and sequence = 1
    );
    insert into payment_milestones (
      tenant_id, contract_id, sequence, label, pct, trigger, due_days, payment_method, notes
    )
    select default_tenant, mg_contract_id, 2, 'Balance pre-dispatch', 50, 'pre_dispatch', 0, 'NEFT', 'MG 50/50 split'
    where not exists (
      select 1 from payment_milestones
      where tenant_id = default_tenant and contract_id = mg_contract_id and sequence = 2
    );
  end if;

  -- 11 release POs as orders linked to the master + contract
  if master_order_id is not null and mg_contract_id is not null then
    foreach release_po in array release_pos loop
      insert into orders (
        tenant_id, customer_id, customer_location_id, status, po_number, po_date,
        quote_number, quote_date, order_mode, parent_order_id, contract_id,
        result
      )
      select
        default_tenant, mg_id, mg_halol_loc, 'APPROVED'::order_status,
        release_po, '2024-04-15'::date,
        'OIQTLC-240123-MG-CONSUMABLES & MAINTENANCE SPARES-REV-1', '2024-01-23'::date,
        'SPARES'::order_mode, master_order_id, mg_contract_id,
        jsonb_build_object(
          'salesOrder', jsonb_build_object(
            'currency', 'INR',
            'incoterms', 'FOR MGI Halol Plant',
            'is_release_po', true,
            'parent_quote', 'OIQTLC-240123-MG-CONSUMABLES & MAINTENANCE SPARES-REV-1'
          )
        )
      where not exists (
        select 1 from orders
        where tenant_id = default_tenant and po_number = release_po
      );
    end loop;
  end if;
end $$;

-- Sample 25 master quote line items as item_master rows (HSN 85159000, INR pricing)
do $$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
begin
  insert into item_master (
    tenant_id, part_no, description, drawing_no, uom, source_country, source_currency,
    purchase_price, hsn_sac, sgst_rate, cgst_rate, igst_rate, lifecycle, is_assembly
  ) values
    (default_tenant, 'TNA-13-04-110-2', 'ADAPTER',         'TNA-13-04-110-2', 'Nos', 'O-INDIA', 'INR', 3540,  '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'ELCC000002',      'CAP TIP',         null,              'Nos', 'O-INDIA', 'INR', 88,    '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'ELCC000127',      'CAP TIP',         null,              'Nos', 'O-INDIA', 'INR', 94,    '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'GBC019736',      'BEND ADAPTER',    'GBC019736',      'Nos', 'O-INDIA', 'INR', 10135, '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'C-4-251035-104',  'SHANK',           null,              'Nos', 'O-INDIA', 'INR', 1756,  '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'C-4-251035-109',  'SHANK',           null,              'Nos', 'O-INDIA', 'INR', 1813,  '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'C-4-251035-49',   'SHANK',           null,              'Nos', 'O-INDIA', 'INR', 1133,  '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'C-4-251035-54',   'SHANK',           null,              'Nos', 'O-INDIA', 'INR', 1189,  '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'C-4-251035-64',   'SHANK',           null,              'Nos', 'O-INDIA', 'INR', 1303,  '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'C-4-251035-69',   'SHANK',           null,              'Nos', 'O-INDIA', 'INR', 1359,  '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'C-4-251035-74',   'SHANK',           null,              'Nos', 'O-INDIA', 'INR', 1416,  '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'C-4-251035-79',   'SHANK',           null,              'Nos', 'O-INDIA', 'INR', 1473,  '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'C-4-251035-84',   'SHANK',           null,              'Nos', 'O-INDIA', 'INR', 1529,  '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'C-4-251035-89',   'SHANK',           null,              'Nos', 'O-INDIA', 'INR', 1586,  '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'C-4-251035-94',   'SHANK',           null,              'Nos', 'O-INDIA', 'INR', 1643,  '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'C-4A2-5300-62',   'SHANK',           null,              'Nos', 'O-INDIA', 'INR', 1280,  '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'C-4A2-5300-67',   'SHANK',           null,              'Nos', 'O-INDIA', 'INR', 1337,  '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'C-4A2-5300-82',   'SHANK',           null,              'Nos', 'O-INDIA', 'INR', 1507,  '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'RB419248S',       'SHANK',           'RB419248S',       'Nos', 'O-JAPAN', 'JPY', 4882,  '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'RB420645S',       'SHANK',           'RB420645S',       'Nos', 'O-JAPAN', 'JPY', 3887,  '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'RB421906S',       'SHANK',           'RB421906S',       'Nos', 'O-JAPAN', 'JPY', 5544,  '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'GBC005425-B',    'BEND ADAPTER',    'GBC005425-B',    'Nos', 'O-INDIA', 'INR', 5073,  '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'RB421717S-A',     'SHANK',           'RB421717S-A',     'Nos', 'O-JAPAN', 'JPY', 21247, '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'RB422396S',       'BEND ADAPTER',    'RB422396S',       'Nos', 'O-JAPAN', 'JPY', 26326, '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'GBC004956-A',    'BEND ADAPTER',    'GBC004956-A',    'Nos', 'O-INDIA', 'INR', 29158, '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false)
  on conflict (tenant_id, part_no) do nothing;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- I. NRD equipment hierarchy (20 sample rows from Plant 1 spare matrix)
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  jbm_id uuid;
  jbm_loc uuid;
begin
  select id into jbm_id from customers where tenant_id = default_tenant and customer_key = 'NRD_AUTO_PLANT_1';
  select id into jbm_loc from customer_locations where tenant_id = default_tenant and customer_id = jbm_id and location_code = 'PLANT-1';
  if jbm_id is null then return; end if;

  -- Skip if NRD already has equipment seeded
  if exists (select 1 from equipment_hierarchy where tenant_id = default_tenant and customer_id = jbm_id) then
    return;
  end if;

  insert into equipment_hierarchy (
    tenant_id, customer_id, customer_location_id, plant_name, line_name, zone_name,
    station_name, gun_no, qty, timer_model, atd_model, notes
  ) values
    (default_tenant, jbm_id, jbm_loc, 'Plant 1', 'FCA 556', 'FIAT',           'WGC-K6133-IND',   'WGC-K6133-IND',   6, null,                                 'ATDNS-5S-16D-HMA10Q-S1P-B19D',  'NRD Plant 1 Spare Matrix 2024-05-29'),
    (default_tenant, jbm_id, jbm_loc, 'Plant 1', 'FCA 556', 'FIAT',           'WGX-K7626',       'WGX-K7626',       1, 'SIV21CV-N6VG8-6M-IND',                'ATDNS-5S-13DJ-VMA10Q-S1P-B19D', 'NRD Plant 1 Spare Matrix 2024-05-29'),
    (default_tenant, jbm_id, jbm_loc, 'Plant 1', 'FCA 556', 'FIAT',           'WGX-K7627',       'WGX-K7627',       1, 'SIV21CV-N6VG8-6M-IND',                'ATDNS-5S-13D-HMA10Q-S1P-B19D',  'NRD Plant 1 Spare Matrix 2024-05-29'),
    (default_tenant, jbm_id, jbm_loc, 'Plant 1', 'FCA 556', 'FIAT',           'WGX-K7628',       'WGX-K7628',       1, 'SIV21CV-N6VG8-6M-IND',                'ATDNS-5S-16DJ-HMA10Q-S1P-B19D', 'NRD Plant 1 Spare Matrix 2024-05-29'),
    (default_tenant, jbm_id, jbm_loc, 'Plant 1', 'FCA 556', 'FIAT',           'WGX-K7629',       'WGX-K7629',       1, 'SIV21CV-N6VG8-6M-IND',                'ATDNS-5S-16DJ-HMA10Q-S1P-B19D', 'NRD Plant 1 Spare Matrix 2024-05-29'),
    (default_tenant, jbm_id, jbm_loc, 'Plant 1', 'DUV 596', null,             'WGC-2C8016L',     'WGC-2C8016L',     3, 'STN21S-E02-S111-DE0-DM',             'ATDNS-0622-16D-V1000',          'NRD Plant 1 Spare Matrix 2024-05-29'),
    (default_tenant, jbm_id, jbm_loc, 'Plant 1', 'DUV 596', null,             'WGX-2C11384L',    'WGX-2C11384L',    1, 'STN21S-E02-S111-DE0-DM',             'ATDNS-5S-16D-VMA10Q-S1P-B19D',  'NRD Plant 1 Spare Matrix 2024-05-29'),
    (default_tenant, jbm_id, jbm_loc, 'Plant 1', 'DUV 596', null,             'WGX-2C11385L',    'WGX-2C11385L',    1, 'STN21S-E02-S111-DE0-DM',             'ATDNS-5S-16D-VMA10Q-S1P-B19D',  'NRD Plant 1 Spare Matrix 2024-05-29'),
    (default_tenant, jbm_id, jbm_loc, 'Plant 1', 'X104',    'X104 - Old',     'WGC-K5901',       'WGC-K5901',       5, 'STN21S-E02-S111-DE0-DM',             'ATDNS-5S-16D-VMA10Q-S1P-B19D',  'NRD Plant 1 Spare Matrix 2024-05-29'),
    (default_tenant, jbm_id, jbm_loc, 'Plant 1', 'X104',    'X104 - Old',     'WGX-K7159',       'WGX-K7159',       1, 'STN21S-E02-S111-DE0-DM',             'ATDNS-5S-16D-VMA10Q-S1P-B19D',  'NRD Plant 1 Spare Matrix 2024-05-29'),
    (default_tenant, jbm_id, jbm_loc, 'Plant 1', 'X104',    'X104 - Old',     'WGX-K14058',      'WGX-K14058',      1, 'SIV326-2002395 (DeviceNet)',         'ATDNS-0622-16D-V1000',          'NRD Plant 1 Spare Matrix 2024-05-29'),
    (default_tenant, jbm_id, jbm_loc, 'Plant 1', 'X104',    'X104 - Expansion','WGX-K14058',     'WGX-K14058',      1, 'SIV326-2002395 (DeviceNet)',         'ATDNS-0622-16D-V1000',          'NRD Plant 1 Spare Matrix 2024-05-29'),
    (default_tenant, jbm_id, jbm_loc, 'Plant 1', 'X451 ccb',null,             'WGX-2C8063',      'WGX-2C8063',      1, null,                                 null,                             'NRD Plant 1 Spare Matrix 2024-05-29'),
    (default_tenant, jbm_id, jbm_loc, 'Plant 1', 'X445 ccb','Mod',            'WGX-2C9484L-IND', 'WGX-2C9484L-IND', 1, 'SIV316-2002163',                      'ATDNS-0622-13D-V1000',          'NRD Plant 1 Spare Matrix 2024-05-29'),
    (default_tenant, jbm_id, jbm_loc, 'Plant 1', 'Fuel Lid',null,             'WGC-2C6333L',     'WGC-2C6333L',     1, 'SIV21-2002244 SIV21CV-N6VG9-6M-IND', 'ATDNS-4S-A754-VMA10Q-S1P-B388D','NRD Plant 1 Spare Matrix 2024-05-29');
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- J. NRD item master (50 spare matrix rows) + equipment_installed_parts
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
begin
  insert into item_master (
    tenant_id, part_no, description, uom, source_country, source_currency,
    hsn_sac, sgst_rate, cgst_rate, igst_rate, lifecycle, is_assembly,
    is_critical, notes
  ) values
    (default_tenant, 'ELCC000031', 'CAP TIP F',         'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGX-2C8063'),
    (default_tenant, 'ELCC000201', 'CAP TIP F',         'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGX-2C11385L'),
    (default_tenant, 'ELCC010508', 'CAP TIP F',         'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGC-2C6333L'),
    (default_tenant, 'T-13-D-1',   'CAP TIP F',         'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGX-K7626'),
    (default_tenant, 'T-16-D-1',   'CAP TIP F',         'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGC-K6133-IND'),
    (default_tenant, 'TNA-16-04-45-1','ADAPTER (F)',    'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGC-2C8016L'),
    (default_tenant, 'TNA-13-04-50-2','ADAPTER (M)',    'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGC-2C6333L'),
    (default_tenant, 'TNA-13-04-60-2','ADAPTER (M)',    'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGX-K7627'),
    (default_tenant, 'TNA-16-04-10-2','ADAPTER (M)',    'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGX-K7159'),
    (default_tenant, 'TNA-16-04-50-2','ADAPTER (M)',    'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGC-K5901'),
    (default_tenant, 'TNA-16-04-60-2','ADAPTER (M)',    'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGX-K7628'),
    (default_tenant, 'TNA-16-04-65-1','ADAPTER (M)',    'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGC-2C8016L'),
    (default_tenant, 'TNA-16-04-65-2','ADAPTER (M)',    'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGX-K7629'),
    (default_tenant, 'TNA-16-04-85-2','ADAPTER (M)',    'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGC-K6133-IND'),
    (default_tenant, '4-HD26309-2','HOLDER (F)',        'Nos', 'O-KOREA', 'USD', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGC-K5901'),
    (default_tenant, '4-HD26313-2','HOLDER (F)',        'Nos', 'O-KOREA', 'USD', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGX-K7159'),
    (default_tenant, '4-HD26868-2','HOLDER (F)',        'Nos', 'O-KOREA', 'USD', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGX-K7626'),
    (default_tenant, '4-HD26869-2','HOLDER (F)',        'Nos', 'O-KOREA', 'USD', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGX-K7629'),
    (default_tenant, '4-HD26879-2','HOLDER (F)',        'Nos', 'O-KOREA', 'USD', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGX-K7627'),
    (default_tenant, 'AB-0-36H-124-70-2','HOLDER (F)',  'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGX-K14058'),
    (default_tenant, 'BADI001231','HOLDER (F)',         'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGC-K6133-IND'),
    (default_tenant, 'C0S6-36H-144-40-2','HOLDER (F)',  'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGX-K7628; lead 70d'),
    (default_tenant, 'C105823','HOLDER (F)',            'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGX-2C8063'),
    (default_tenant, 'C106678','HOLDER (F)',            'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGC-2C6333L'),
    (default_tenant, 'C110125','HOLDER (F)',            'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGC-2C8016L'),
    (default_tenant, 'C110185','HOLDER (F)',            'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGX-2C11384L'),
    (default_tenant, 'C110190','HOLDER (F)',            'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGX-2C11385L'),
    (default_tenant, '28C100-AB-0-36H-144-130-2','HOLDER (M)','Nos','O-INDIA','INR','85159000',0.09,0.09,0.18,'ACTIVE',false,true,'NRD consumable; gun WGX-K7628'),
    (default_tenant, '28C59-AB-0-36H-124-70-2','HOLDER (M)', 'Nos','O-INDIA','INR','85159000',0.09,0.09,0.18,'ACTIVE',false,true,'NRD consumable; gun WGX-K7159'),
    (default_tenant, '4-HD33863-2','HOLDER (M)',        'Nos', 'O-KOREA', 'USD', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGX-K14058'),
    (default_tenant, 'AB-0-45H-224-50-2','HOLDER (M)',  'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGX-K7627'),
    (default_tenant, 'AR-0-45H-164-20-2','HOLDER (M)',  'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGX-K7629'),
    (default_tenant, 'BHOI001068','HOLDER (M)',         'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGX-2C9484L-IND'),
    (default_tenant, 'C0B3-45H-224-145-2','HOLDER (M)', 'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGX-K7626'),
    (default_tenant, 'TEFLON-PIPE-6X4','PIPE Teflon 6x4 mm','Mtr','O-INDIA','INR','39173100',0.09,0.09,0.18,'ACTIVE',false,false,'NRD consumable; replaces unicode part code Φ6*Φ4'),
    (default_tenant, 'TWS-092-100-1','SHANK (F)',       'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGC-2C8016L'),
    (default_tenant, 'TWS-091-100-2','SHANK (M)',       'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGX-K7627'),
    (default_tenant, 'TWS-091-60-3', 'SHANK (M)',       'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGC-2C6333L'),
    (default_tenant, 'TWS-091-90-3', 'SHANK (M)',       'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGX-2C9484L-IND'),
    (default_tenant, 'TWS-092-100-2','SHANK (M)',       'Nos', 'O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD consumable; gun WGX-K7159'),
    (default_tenant, 'KZ-1385',      'ADAPTER (COUPLER)','Nos','O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD spare; gun WGC-2C8016L'),
    (default_tenant, 'KZ-1386',      'ADAPTER (COUPLER)','Nos','O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD spare; gun WGX-2C9484L-IND'),
    (default_tenant, 'KZ-1387',      'ADAPTER (COUPLER)','Nos','O-INDIA', 'INR', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD spare; gun WGX-2C11384L'),
    (default_tenant, '403C1K094',    'ARM ASSY',        'Nos', 'O-KOREA', 'USD', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', true,  false, 'NRD spare; gun WGX-K14058'),
    (default_tenant, 'C5D03092-CN2', 'GEAR CASE ASSY',  'Nos', 'O-CHINA', 'CNY', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', true,  true,  'NRD spare; gun WGC-2C6333L; lead 120d'),
    (default_tenant, 'C5E0069',      'GEAR CASE ASSY',  'Nos', 'O-CHINA', 'CNY', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', true,  true,  'NRD spare; gun WGX-2C11384L'),
    (default_tenant, 'CB210-KUKA',   'GEAR CASE ASSY',  'Nos', 'O-KOREA', 'USD', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', true,  true,  'NRD spare; gun WGC-K6133-IND; KUKA robot'),
    (default_tenant, 'X118-KUKA',    'GEAR CASE ASSY',  'Nos', 'O-KOREA', 'USD', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', true,  true,  'NRD spare; gun WGX-K7627; KUKA robot'),
    (default_tenant, 'DB6-100R1-V2', 'TRANSFORMER',     'Nos', 'O-KOREA', 'USD', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD spare; transformer; gun WGC-2C8016L'),
    (default_tenant, 'IT110H-6100-G3','TRANSFORMER',    'Nos', 'O-KOREA', 'USD', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD spare; transformer; gun WGX-K14058'),
    (default_tenant, 'IT90H-6100-R', 'TRANSFORMER',     'Nos', 'O-KOREA', 'USD', '85159000', 0.09, 0.09, 0.18, 'ACTIVE', false, true,  'NRD spare; transformer; gun WGC-K6133-IND')
  on conflict (tenant_id, part_no) do nothing;
end $$;

-- equipment_installed_parts: link parts to NRD equipment rows where the gun matches
do $$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  jbm_id uuid;
  rec record;
begin
  select id into jbm_id from customers where tenant_id = default_tenant and customer_key = 'NRD_AUTO_PLANT_1';
  if jbm_id is null then return; end if;

  -- Skip if already populated
  if exists (
    select 1 from equipment_installed_parts ei
    join equipment_hierarchy eq on eq.id = ei.equipment_id
    where ei.tenant_id = default_tenant and eq.customer_id = jbm_id
  ) then
    return;
  end if;

  for rec in
    select eq.id as equipment_id, eq.gun_no, im.part_no, im.description, im.is_critical, im.notes
      from equipment_hierarchy eq
      join item_master im
        on im.tenant_id = default_tenant
       and im.notes like '%gun ' || eq.gun_no || '%'
     where eq.tenant_id = default_tenant
       and eq.customer_id = jbm_id
  loop
    insert into equipment_installed_parts (
      tenant_id, equipment_id, part_no, description, installed_qty, is_critical, notes
    ) values (
      default_tenant, rec.equipment_id, rec.part_no, rec.description, 1, coalesce(rec.is_critical, false),
      'Auto-linked from NRD Plant 1 spare matrix'
    );
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- K. Customer format profiles (6 fingerprints from corpus)
-- One profile per (customer, mode-variant). For ABC the four variants share
-- the same customer record so we use version=1..4 with is_current=true on
-- the SPARES variant (the most likely intake) and is_current=false on
-- MODIFICATION_SPARES, FOR, HSS.
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  mg_id uuid;
  srtx_id uuid;
  abc_id uuid;
begin
  select id into mg_id   from customers where tenant_id = default_tenant and customer_key = 'MG_MOTOR_INDIA';
  select id into srtx_id from customers where tenant_id = default_tenant and customer_key = 'WGX';
  select id into abc_id  from customers where tenant_id = default_tenant and customer_key = 'ABC_MOTORS';

  -- MG fingerprint
  if mg_id is not null and not exists (
    select 1 from customer_format_profiles
     where tenant_id = default_tenant and customer_id = mg_id and version = 1
  ) then
    insert into customer_format_profiles (
      tenant_id, customer_id, version, is_current, trusted, fingerprint, learned_rules, recipe
    ) values (
      default_tenant, mg_id, 1, true, true,
      jsonb_build_object(
        'header_keywords', jsonb_build_array(
          'PRICE QUOTATION', 'OIQTLC-240123-MG-CONSUMABLES & MAINTENANCE SPARES-REV-1',
          'TO: Vega Motor India Pvt. Ltd (Gujarat)', 'KindAttn: Ms. Varada Puranik',
          'OBARA INDIA PRIVATE LIMITED', 'M.I.D.C PIMPRI', 'PUNE: 411018', 'DISCOUNTED PRICE', 'GST'
        ),
        'column_headers', jsonb_build_array(
          'Item','Part Name','Parts No.','Drawing/Customer Number','Remark','HSN Code',
          'Qty','Unit','Unit Price','Amount','CGST','SGST','IGST'
        ),
        'column_count', 13,
        'currency', 'INR',
        'taxation', 'IGST',
        'mode_hint', 'SPARES',
        'unique_markers', jsonb_build_array(
          'OIQTLC-prefix','MG-CONSUMABLES & MAINTENANCE SPARES','VALIDITY: 90 days',
          'DISCOUNTED PRICE / GST split block','HSN codes in column','0.18 IGST rate column'
        )
      ),
      jsonb_build_object(
        'parts_table_starts_after', 'Item|Part Name|Parts No.|Drawing/Customer Number|Remark|HSN Code|Qty|Unit|Unit Price|Amount',
        'parts_table_ends_at', 'EOF',
        'total_row_label', null
      ),
      jsonb_build_object(
        'slot_order', jsonb_build_array(
          'header_block','quotation_number','date','revised_date','bill_to','kind_attn',
          'supplier_address_block','conditions_block','validity','currency',
          'discount_and_gst_subheader','parts_table_header','parts_table_rows','footer_signature'
        )
      )
    );
  end if;

  -- WGX fingerprint
  if srtx_id is not null and not exists (
    select 1 from customer_format_profiles
     where tenant_id = default_tenant and customer_id = srtx_id and version = 1
  ) then
    insert into customer_format_profiles (
      tenant_id, customer_id, version, is_current, trusted, fingerprint, learned_rules, recipe
    ) values (
      default_tenant, srtx_id, 1, true, true,
      jsonb_build_object(
        'header_keywords', jsonb_build_array(
          'ITEM NO.','PRODUCT CODE','L/R','PRODUCT NAME','REVISION RECORD','MESSRS.:'
        ),
        'column_headers', jsonb_build_array(
          'No','ITEM No','LEVEL','PARTS NAME','PARTS CODE','L/R','MODEL NAME','JPN MODEL','MODEL','QTY','MATERIAL','REV'
        ),
        'column_count', 12,
        'currency', null,
        'taxation', null,
        'mode_hint', 'SPARES',
        'unique_markers', jsonb_build_array(
          'WGX-2C16934L-IND','Hierarchical dotted Item No (4 levels)','LEVEL column with integer 1..4',
          'L/R column with values L or R','MATERIAL codes (CRCU, A6061-T6, SUS304, TEFLON, etc.)',
          'No price columns - BOM/parts-list format','Mixed Chinese/English part names'
        )
      ),
      jsonb_build_object(
        'parts_table_starts_after', 'No|ITEM No|LEVEL|PARTS NAME|PARTS CODE|L/R|MODEL NAME|JPN MODEL|MODEL|QTY|MATERIAL|REV',
        'parts_table_ends_at', 'SHEET BREAK',
        'total_row_label', null
      ),
      jsonb_build_object(
        'slot_order', jsonb_build_array(
          'title_block_metadata','revision_record_block','parts_table_header',
          'hierarchical_parts_rows','sheet_terminator'
        )
      )
    );
  end if;

  -- ABC variants (4 versions, only SPARES is_current)
  if abc_id is not null and not exists (
    select 1 from customer_format_profiles
     where tenant_id = default_tenant and customer_id = abc_id
  ) then
    insert into customer_format_profiles (
      tenant_id, customer_id, version, is_current, trusted, format_change_summary, fingerprint, learned_rules, recipe
    ) values
      (default_tenant, abc_id, 1, true,  false, 'SPARES Enquiry sample',
        jsonb_build_object(
          'header_keywords', jsonb_build_array('SPARES Enquiry','Dummy Pricecompo Sample','ERP-FEB-2024'),
          'currency', 'INR', 'taxation', 'CGST_SGST', 'mode_hint', 'SPARES',
          'unique_markers', jsonb_build_array('1-SPARES_Enquiry_sample','Spares enquiry / price-comp ERP intake')
        ),
        '{}'::jsonb,
        jsonb_build_object('slot_order', jsonb_build_array('header_block','enquiry_metadata','parts_table_header','parts_table_rows','tax_block','total_row'))),
      (default_tenant, abc_id, 2, false, false, 'Modification spares (assembly items) sample',
        jsonb_build_object(
          'header_keywords', jsonb_build_array('SPARES Enquiry','Assembly items','Modification Spares'),
          'currency', 'INR', 'taxation', 'CGST_SGST', 'mode_hint', 'MODIFICATION_SPARES',
          'unique_markers', jsonb_build_array('2-SPARES_Enquiry-Assembly_items_sample','Assembly-level (parent) line items','Modification spares / sub-assembly indent')
        ),
        '{}'::jsonb,
        jsonb_build_object('slot_order', jsonb_build_array('header_block','enquiry_metadata','assembly_header_row','component_rows','tax_block','total_row'))),
      (default_tenant, abc_id, 3, false, false, 'Project FOR (Free On Rail) sample',
        jsonb_build_object(
          'header_keywords', jsonb_build_array('Project FOR','FOR (Free On Rail)','Dummy Pricecompo Sample'),
          'currency', 'INR', 'taxation', 'IGST', 'incoterm_pattern', 'FOR', 'mode_hint', 'PROJECT_FOR',
          'unique_markers', jsonb_build_array('3-Project-FOR-Sample','Project-mode PO (capex / system order)','FOR delivery incoterm (domestic India)')
        ),
        '{}'::jsonb,
        jsonb_build_object('slot_order', jsonb_build_array('header_block','project_metadata','incoterm_block','parts_table_header','parts_table_rows','tax_block','total_row'))),
      (default_tenant, abc_id, 4, false, false, 'Project HSS (High Sea Sales) sample',
        jsonb_build_object(
          'header_keywords', jsonb_build_array('Project HSS','HIGH SEA SALES','High Sea Sales','Dummy Pricecompo Sample'),
          'currency', 'USD', 'taxation', 'EXPORT_NO_TAX', 'incoterm_pattern', 'HSS (High Sea Sales)', 'mode_hint', 'PROJECT_HSS',
          'unique_markers', jsonb_build_array('4-Project-HSS-HIGH_SEA_SALES-Sample','Pre-import-clearance transfer','GST not levied on HSS leg','Foreign currency pricing typical (USD/EUR)')
        ),
        '{}'::jsonb,
        jsonb_build_object('slot_order', jsonb_build_array('header_block','project_metadata','hss_declaration_block','parts_table_header','parts_table_rows','no_tax_block','total_row')));
  end if;
end $$;

-- End of 010_seed_corpus_round2_data.sql

-- ===========================================================================
-- SANITY REPORT
-- ===========================================================================
select 'customers'                  as relation, count(*) from customers
union all select 'customer_locations',         count(*) from customer_locations
union all select 'customer_format_profiles',   count(*) from customer_format_profiles
union all select 'item_master',                count(*) from item_master
union all select 'engineering_specs',          count(*) from engineering_specs
union all select 'payment_milestones',         count(*) from payment_milestones
union all select 'expense_rate_cards',         count(*) from expense_rate_cards
union all select 'inco_terms_taxonomy',        count(*) from inco_terms_taxonomy
union all select 'logistics_ports',            count(*) from logistics_ports
union all select 'logistics_carriers',         count(*) from logistics_carriers
union all select 'contracts',                  count(*) from contracts
union all select 'orders',                     count(*) from orders
union all select 'shipments',                  count(*) from shipments
union all select 'equipment_hierarchy',        count(*) from equipment_hierarchy
union all select 'equipment_installed_parts',  count(*) from equipment_installed_parts
union all select 'quote_approval_thresholds',  count(*) from quote_approval_thresholds
order by 1;
