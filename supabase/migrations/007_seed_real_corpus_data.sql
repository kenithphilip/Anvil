-- 007_seed_real_corpus_data.sql
-- Seeds real customer master rows (MG Motor, SRTX, Tata Motors, ABC Motors)
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
    (default_tenant, 'MG_MOTOR_INDIA', 'MG Motor India Pvt. Ltd.', '24AAKCM8110E1ZR', 'GJ', 'AAKCM8110E', 'AUTO_OEM', 'Net 30 days NEFT', 'FOR MGI Halol Plant', 'Real customer from corpus: 11 blanket POs against OIQTLC-240123-MG-CONSUMABLES'),
    (default_tenant, 'SRTX', 'SRTX', null, null, null, 'TIER_ONE', null, null, 'Real customer from corpus: SRTX-2C15968L-IND PO + EG SHEET'),
    (default_tenant, 'TATA_MOTORS_PV_PUNE', 'Tata Motors Passenger Vehicles Limited (Pune)', null, 'MH', null, 'AUTO_OEM', 'Net 45 days', null, 'Real customer from Pending Sales Order tracker'),
    (default_tenant, 'ABC_MOTORS', 'ABC Motors', null, null, null, 'AUTO_OEM', null, null, 'Sample customer from Dummy Pricecompo workflow examples')
  on conflict (tenant_id, customer_key) do nothing;

  select id into mg_customer_id   from customers where tenant_id = default_tenant and customer_key = 'MG_MOTOR_INDIA';
  select id into srtx_customer_id from customers where tenant_id = default_tenant and customer_key = 'SRTX';
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
      (default_tenant, tata_customer_id, 'PUNE', 'Tata Motors Pune Plant', '27', 'Pune', true)
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
    (default_tenant, 'MOD_FOR_SRTX_2C7507L',    'Modification for SRTX-2C7507L-IND',                        null,                      'Nos', 'O-INDIA', 'INR', null,    'ASSEMBLY ITEM', null,         null,         '85159000', 0.09, 0.09, 0.18, 'ACTIVE', true),
    (default_tenant, 'MODIFICATION_CHARGES',    'Modification Charges',                                     null,                      'Nos', 'O-INDIA', 'INR', 10000,   'XXX',           '2024-02-07', '2024-04-30', '996531',   0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'POWER_CABLE_15M',         'Power Cable 15Mtr',                                        null,                      'Nos', 'O-INDIA', 'INR', 25000,   'XXX',           '2024-02-07', '2024-04-30', '85446030', 0.09, 0.09, 0.18, 'ACTIVE', false),
    (default_tenant, 'POWER_CABLE_10M',         'Power Cable 10M',                                          null,                      'Nos', 'O-INDIA', 'INR', 15000,   'XXX',           '2024-02-07', '2024-04-30', '85446030', 0.09, 0.09, 0.18, 'ACTIVE', false)
  on conflict (tenant_id, part_no) do nothing;
end $$;
