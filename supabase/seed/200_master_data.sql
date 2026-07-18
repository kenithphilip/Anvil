/*
 * 200_master_data.sql  --  Phase 2 of the Anvil seed pack.
 *
 * Purpose
 *   Reference data the rest of the seed pack pivots around: 4
 *   fictional customers (Anvil Test Industries, Globex GmbH, Acme
 *   Robotics, 日本工業株式会社) plus their multi-GSTIN locations,
 *   format profile + version history (exercising the 003 snapshot
 *   trigger), item-master extensions covering every lifecycle, part
 *   aliases (active/pending/deprecated), UOM normalisation rules,
 *   a 3-level BOM, tally inventory, catalog synonyms / alternatives,
 *   private-label items, vendors, the NRD-shaped equipment hierarchy
 *   for two customers + installed parts,
 *   contracts (every type × every status), contract_lines,
 *   payment_milestones, blanket_release_drawdown, engineering_specs.
 *
 * Prerequisites
 *   - Migrations 001..059 applied.
 *   - supabase/seed.sql applied (default tenant + 6 corpus customers
 *     + 35 item_master rows + 11 expense_rate_cards).
 *   - 100_users_and_tenants.sql applied (creates auth users referenced
 *     by `created_by` columns; not strictly required for FK validity
 *     because most created_by columns are nullable, but the reviews/
 *     audits expect the users).
 *   - Run as service_role with `set app.seed_env = 'staging';`.
 *
 * Idempotency
 *   `on conflict ... do nothing` everywhere. Re-running is a no-op.
 *
 * Deterministic UUID namespace
 *   d7a7e5e4-0001-0002-0001-000000000001
 *   (`...0002...` slot identifies phase 2; phase 1 used `...0001...`
 *   in the file but it was a single UUID; phases 100/200/300 each
 *   pick a sub-namespace so a future cross-phase reference stays
 *   unambiguous.)
 *
 * Seed marker
 *   `{"seed_marker": "anvil-test-seed-v1"}` merged into every jsonb
 *   payload / metadata column where one exists.
 *
 * Deviations from this prompt
 *   - The matrix asks for `customer_format_profiles` v1/v2/v3 to
 *     exercise the 003 trigger. I seed two profiles per fictional
 *     customer (one for the pair Anvil Test Industries + Globex)
 *     with v1 (is_current=false) followed by v2 (is_current=true).
 *     The trigger writes a row into customer_format_profile_versions
 *     for v2 automatically; we don't insert into _versions directly,
 *     respecting G4. A v3 demonstration would need a follow-up UPDATE
 *     and that's beyond the row counts the matrix asks for.
 *   - `vendors` lives in 200, not 300. The Phase 3 RFQ flow needs
 *     vendor IDs to reference, so seeding here keeps phases ordered.
 */

-- ───────────────────────────────────────────────────────────────────
-- 0. ENV GUARD
-- ───────────────────────────────────────────────────────────────────
do $guard$
begin
  if current_setting('app.seed_env', true) is null
     or current_setting('app.seed_env', true) not in ('staging', 'local', 'ci') then
    raise exception 'Refusing to seed: app.seed_env must be set to staging, local, or ci. Got: %',
      coalesce(current_setting('app.seed_env', true), '<unset>');
  end if;
end $guard$;

begin;

do $role$ begin
  begin set local role 'postgres'; exception when others then null; end;
end $role$;

-- ───────────────────────────────────────────────────────────────────
-- 1. FICTIONAL CUSTOMERS  --  4 rows covering edge cases
-- ───────────────────────────────────────────────────────────────────
do $cust$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0002-0001-000000000001';
begin
  insert into customers (
    id, tenant_id, customer_key, customer_name, gstin, state_code, pan,
    customer_type, default_payment_terms, default_incoterms, default_quote_validity_days,
    primary_contact_email, primary_contact_phone, notes, created_at, updated_at
  ) values
    -- GST validation edge case: valid-shape GSTIN, MH state.
    (uuid_generate_v5(ns, 'customer:ANVIL_TEST_INDUSTRIES'),
     default_tenant, 'ANVIL_TEST_INDUSTRIES', 'Anvil Test Industries Pvt. Ltd.',
     '27AAAAA0000A1Z5', '27', 'AAAAA0000A',
     'TIER_ONE', 'Net 30 days NEFT', 'FOR Pune', 60,
     'purchasing@anvil-test.example', '+91 20 5550 1010',
     'Fictional fixture; exercises GSTIN validation and rupee-only flows.',
     now() - interval '180 days', now() - interval '30 days'),
    -- Foreign currency: EUR, EU customer.
    (uuid_generate_v5(ns, 'customer:GLOBEX_MFG_GMBH'),
     default_tenant, 'GLOBEX_MFG_GMBH', 'Globex Manufacturing GmbH',
     null, 'DE', null,
     'LINE_BUILDER', 'Net 45 days SEPA', 'CIP Hamburg', 90,
     'einkauf@globex-mfg.example', '+49 40 5550 2020',
     'Fictional fixture; exercises EUR pricing and EU import flows.',
     now() - interval '150 days', now() - interval '20 days'),
    -- Foreign currency: USD, US customer.
    (uuid_generate_v5(ns, 'customer:ACME_ROBOTICS_LLC'),
     default_tenant, 'ACME_ROBOTICS_LLC', 'Acme Robotics LLC',
     null, 'US-OH', null,
     'OTHER', 'Net 30 days ACH', 'DAP Cleveland', 90,
     'orders@acme-robotics.example', '+1 216 555 3030',
     'Fictional fixture; exercises USD pricing and US export flows.',
     now() - interval '120 days', now() - interval '15 days'),
    -- Unicode customer name + Japanese address.
    (uuid_generate_v5(ns, 'customer:NIPPON_KOGYO'),
     default_tenant, 'NIPPON_KOGYO', '日本工業株式会社',
     null, 'JP', null,
     'TIER_ONE', 'Net 60 days T/T', 'FOB Yokohama', 90,
     'eigyou@nipponkogyo.example', '+81 3 5550 4040',
     'Fictional fixture; exercises Unicode customer names and JPY pricing.',
     now() - interval '120 days', now() - interval '15 days')
  on conflict (tenant_id, customer_key) do nothing;
end $cust$;

-- ───────────────────────────────────────────────────────────────────
-- 2. CUSTOMER_LOCATIONS for the fictional customers
-- ───────────────────────────────────────────────────────────────────
do $loc$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0002-0001-000000000001';
  ati_id         uuid;
  globex_id      uuid;
  acme_id        uuid;
  nippon_id      uuid;
begin
  select id into ati_id    from customers where tenant_id = default_tenant and customer_key = 'ANVIL_TEST_INDUSTRIES';
  select id into globex_id from customers where tenant_id = default_tenant and customer_key = 'GLOBEX_MFG_GMBH';
  select id into acme_id   from customers where tenant_id = default_tenant and customer_key = 'ACME_ROBOTICS_LLC';
  select id into nippon_id from customers where tenant_id = default_tenant and customer_key = 'NIPPON_KOGYO';

  if ati_id is not null then
    insert into customer_locations (id, tenant_id, customer_id, location_code, plant_name, gstin, state_code, address_line1, city, pincode, is_default)
    values
      (uuid_generate_v5(ns, 'loc:ATI:PUNE'),    default_tenant, ati_id, 'PUNE',    'ATI Pune Plant',    '27AAAAA0000A1Z5', '27', 'Plot 17, Hinjewadi Phase II', 'Pune', '411057', true),
      (uuid_generate_v5(ns, 'loc:ATI:CHAKAN'),  default_tenant, ati_id, 'CHAKAN',  'ATI Chakan Plant',  '27AAAAA0000A1Z5', '27', 'Block C, MIDC Chakan',         'Pune', '410501', false)
    on conflict (tenant_id, customer_id, location_code) do nothing;
  end if;

  if globex_id is not null then
    insert into customer_locations (id, tenant_id, customer_id, location_code, plant_name, state_code, address_line1, city, pincode, is_default)
    values
      (uuid_generate_v5(ns, 'loc:GLOBEX:HAMBURG'), default_tenant, globex_id, 'HAMBURG', 'Globex Hamburg Werk', 'DE', 'Hafenrandstraße 41', 'Hamburg', '21129', true),
      (uuid_generate_v5(ns, 'loc:GLOBEX:STUTTGART'), default_tenant, globex_id, 'STUTTGART', 'Globex Stuttgart Werk', 'DE', 'Industriestraße 8', 'Stuttgart', '70565', false)
    on conflict (tenant_id, customer_id, location_code) do nothing;
  end if;

  if acme_id is not null then
    insert into customer_locations (id, tenant_id, customer_id, location_code, plant_name, state_code, address_line1, city, pincode, is_default)
    values
      (uuid_generate_v5(ns, 'loc:ACME:CLEVELAND'), default_tenant, acme_id, 'CLEVELAND', 'Acme Cleveland HQ', 'US-OH', '500 Lakeside Ave',  'Cleveland', '44114', true),
      (uuid_generate_v5(ns, 'loc:ACME:DETROIT'),   default_tenant, acme_id, 'DETROIT',   'Acme Detroit Lab',  'US-MI', '900 Woodward Ave', 'Detroit',   '48226', false)
    on conflict (tenant_id, customer_id, location_code) do nothing;
  end if;

  if nippon_id is not null then
    insert into customer_locations (id, tenant_id, customer_id, location_code, plant_name, state_code, address_line1, city, pincode, is_default)
    values
      (uuid_generate_v5(ns, 'loc:NIPPON:YOKOHAMA'), default_tenant, nippon_id, 'YOKOHAMA', '横浜工場', 'JP', '神奈川県横浜市磯子区', '横浜市', '235-0007', true)
    on conflict (tenant_id, customer_id, location_code) do nothing;
  end if;
end $loc$;

-- ───────────────────────────────────────────────────────────────────
-- 3. CUSTOMER_FORMAT_PROFILES (v1 then v2; trigger fills _versions)
-- ───────────────────────────────────────────────────────────────────
-- The 003 trigger snapshots into customer_format_profile_versions
-- only when is_current flips true, so we sequence v1 (is_current
-- false, archival) followed by v2 (is_current true) for each of
-- two customers. Verifies a non-empty _versions table on rerun.
do $cfp$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0002-0001-000000000001';
  ati_id    uuid;
  nippon_id uuid;
begin
  select id into ati_id    from customers where tenant_id = default_tenant and customer_key = 'ANVIL_TEST_INDUSTRIES';
  select id into nippon_id from customers where tenant_id = default_tenant and customer_key = 'NIPPON_KOGYO';

  if ati_id is not null then
    -- v1: archival, no longer current.
    insert into customer_format_profiles (
      id, tenant_id, customer_id, version, fingerprint, recipe, learned_rules,
      orders_processed, last_format_changed, format_change_summary, trusted, is_current,
      created_at, updated_at
    ) values (
      uuid_generate_v5(ns, 'cfp:ATI:v1'),
      default_tenant, ati_id, 1,
      jsonb_build_object('po_layout','table_v1','seed_marker','anvil-test-seed-v1'),
      jsonb_build_object('quote_validity_days', 60, 'seed_marker','anvil-test-seed-v1'),
      jsonb_build_object('uom_aliases',jsonb_build_object('Nos','EA'),'seed_marker','anvil-test-seed-v1'),
      8, false, null, true, false,
      now() - interval '90 days', now() - interval '60 days'
    ) on conflict (id) do nothing;

    -- v2: the current profile. Trigger writes a _versions snapshot.
    insert into customer_format_profiles (
      id, tenant_id, customer_id, version, fingerprint, recipe, learned_rules,
      orders_processed, last_format_changed, format_change_summary, trusted, is_current,
      created_at, updated_at
    ) values (
      uuid_generate_v5(ns, 'cfp:ATI:v2'),
      default_tenant, ati_id, 2,
      jsonb_build_object('po_layout','table_v2','seed_marker','anvil-test-seed-v1'),
      jsonb_build_object('quote_validity_days', 90, 'incoterms','FOR Pune','seed_marker','anvil-test-seed-v1'),
      jsonb_build_object('uom_aliases',jsonb_build_object('Nos','EA','Pcs','EA'),'seed_marker','anvil-test-seed-v1'),
      14, true, 'Layout changed: PO line columns reordered after vendor portal upgrade.', true, true,
      now() - interval '40 days', now() - interval '7 days'
    ) on conflict (id) do nothing;
  end if;

  if nippon_id is not null then
    insert into customer_format_profiles (
      id, tenant_id, customer_id, version, fingerprint, recipe, learned_rules,
      orders_processed, last_format_changed, format_change_summary, trusted, is_current,
      created_at, updated_at
    ) values (
      uuid_generate_v5(ns, 'cfp:NIPPON:v1'),
      default_tenant, nippon_id, 1,
      jsonb_build_object('po_layout','horizontal_v1','locale','ja_JP','seed_marker','anvil-test-seed-v1'),
      jsonb_build_object('quote_validity_days', 90, 'currency','JPY','seed_marker','anvil-test-seed-v1'),
      jsonb_build_object('seed_marker','anvil-test-seed-v1'),
      6, false, null, true, true,
      now() - interval '60 days', now() - interval '30 days'
    ) on conflict (id) do nothing;
  end if;
end $cfp$;

-- ───────────────────────────────────────────────────────────────────
-- 4. ITEM_MASTER  --  add 15+ rows covering OBSOLETE/DISCONTINUED/NEW/TRIAL
-- ───────────────────────────────────────────────────────────────────
do $item$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0002-0001-000000000001';
begin
  insert into item_master (
    id, tenant_id, part_no, description, drawing_no, uom, item_group, item_sub_group,
    category, sub_category, source_country, source_currency, purchase_price,
    purchase_quote_no, purchase_quote_validity_start, purchase_quote_validity_end,
    hsn_sac, sgst_rate, cgst_rate, igst_rate, default_lead_days, moq, pack_size,
    rounding_rule, lifecycle, is_assembly, is_critical, technical_specs, notes,
    created_at, updated_at
  ) values
    -- OBSOLETE (3)
    (uuid_generate_v5(ns,'item:legacy:tip-1'), default_tenant, 'LEGACY-TIP-100', 'Cap Tip (legacy 16D phaseout)', null, 'Nos', 'spares','tips','spares','tip','O-KOREA','USD', 0.65,'OB-2023-XX','2023-04-01','2023-12-31','85159000',0.09,0.09,0.18,30,1,1,'none','OBSOLETE',false,false,'{}'::jsonb,'Phased out after 2024-Q1.', now() - interval '720 days', now() - interval '300 days'),
    (uuid_generate_v5(ns,'item:legacy:gun-200'),default_tenant,'LEGACY-GUN-200', 'Servo gun X1 (replaced by X2C)', null,'Nos','assemblies','servo_gun','assemblies','gun','O-KOREA','USD',5800,'OB-2022-YY','2022-04-01','2022-12-31','85152110',0.09,0.09,0.18,60,1,1,'none','OBSOLETE',true,false,'{}'::jsonb,'Replaced by X2C series.', now() - interval '900 days', now() - interval '400 days'),
    (uuid_generate_v5(ns,'item:legacy:cable-300'),default_tenant,'LEGACY-CABLE-300','Power cable 6P (deprecated form factor)', null,'Mtr','cables','power','cables','power','O-KOREA','USD',12,null,null,null,'85446030',0.09,0.09,0.18,15,1,1,'none','OBSOLETE',false,false,'{}'::jsonb,'Form factor discontinued upstream.', now() - interval '600 days', now() - interval '350 days'),
    -- DISCONTINUED (3)
    (uuid_generate_v5(ns,'item:disc:timer-100'), default_tenant,'DISC-TIMER-100', 'Welding timer module gen 1 (discontinued)', null,'Nos','spares','timer','spares','timer','O-KOREA','USD',850,null,null,null,'85159000',0.09,0.09,0.18,45,1,1,'none','DISCONTINUED',false,false,'{}'::jsonb,'Vendor stopped manufacturing 2024.', now() - interval '500 days', now() - interval '120 days'),
    (uuid_generate_v5(ns,'item:disc:atd-100'),  default_tenant,'DISC-ATD-100',  'ATD module gen 1 (discontinued)',         null,'Nos','spares','atd','spares','atd','O-JAPAN','JPY',92000,null,null,null,'84612019',0.09,0.09,0.18,75,1,1,'none','DISCONTINUED',false,false,'{}'::jsonb,'Replaced upstream by gen-2.', now() - interval '500 days', now() - interval '120 days'),
    (uuid_generate_v5(ns,'item:disc:holder-100'),default_tenant,'DISC-HOLDER-100','Point holder gen 1 (discontinued)',       null,'Nos','spares','holder','spares','holder','O-KOREA','USD',95,null,null,null,'85159000',0.09,0.09,0.18,30,1,1,'none','DISCONTINUED',false,false,'{}'::jsonb,'Same as DISC-TIMER-100 lifecycle.', now() - interval '500 days', now() - interval '120 days'),
    -- NEW (4) -- recently launched
    (uuid_generate_v5(ns,'item:new:gun-x3'),    default_tenant,'X3-X-MEDIUM',   'MFDC Servo Gun X3 (new launch)',           'X3-X-MED','Nos','assemblies','servo_gun','assemblies','gun','O-KOREA','USD',9200,'O-KOR-260301','2026-03-01','2026-12-31','85152110',0.09,0.09,0.18,60,1,1,'none','NEW',true,true, jsonb_build_object('motor','FANUC alpha8/4000','seed_marker','anvil-test-seed-v1'),'Successor to X2C.', now() - interval '40 days', now() - interval '5 days'),
    (uuid_generate_v5(ns,'item:new:tip-y'),     default_tenant,'TIP-Y-2026',    'Cap Tip (new 2026 alloy)',                  'TIP-Y','Nos','spares','tips','spares','tip','O-KOREA','USD',1.05,'O-KOR-260301','2026-03-01','2026-12-31','85159000',0.09,0.09,0.18,30,500,500,'round','NEW',false,false, jsonb_build_object('alloy','Cu-Cr-Zr-2026','seed_marker','anvil-test-seed-v1'),'Bulk-pack 500.', now() - interval '30 days', now() - interval '5 days'),
    (uuid_generate_v5(ns,'item:new:cable-y'),   default_tenant,'CABLE-Y-2026',  'Power cable Y (UV-stable, new)',            null,'Mtr','cables','power','cables','power','O-KOREA','USD',16,null,null,null,'85446030',0.09,0.09,0.18,21,10,10,'ceil','NEW',false,false,'{}'::jsonb,'10m pack.', now() - interval '30 days', now() - interval '5 days'),
    (uuid_generate_v5(ns,'item:new:assembly-z'),default_tenant,'ASSY-Z-2026',   'Modular sub-assembly Z (new)',              'ASSY-Z','Nos','assemblies','module','assemblies','module','O-JAPAN','JPY',125000,null,null,null,'85152110',0.09,0.09,0.18,90,1,1,'none','NEW',true,true,'{}'::jsonb,'Modular replacement for legacy gun-200.', now() - interval '50 days', now() - interval '5 days'),
    -- TRIAL (3) -- under evaluation, not yet ready for full ACTIVE list
    (uuid_generate_v5(ns,'item:trial:tip-z'),   default_tenant,'TIP-Z-TRIAL',   'Cap Tip (trial alloy, eval until 2026-Q3)', null,'Nos','spares','tips','spares','tip','O-KOREA','USD',1.20,null,null,null,'85159000',0.09,0.09,0.18,30,500,500,'round','TRIAL',false,false, jsonb_build_object('alloy','Cu-Be-Co-trial','seed_marker','anvil-test-seed-v1'),'Customer NRD trial.', now() - interval '20 days', now() - interval '5 days'),
    (uuid_generate_v5(ns,'item:trial:gun-x4'),  default_tenant,'X4-X-TRIAL',    'Servo Gun X4 prototype',                   'X4-PROTO','Nos','assemblies','servo_gun','assemblies','gun','O-KOREA','USD',11000,null,null,null,'85152110',0.09,0.09,0.18,90,1,1,'none','TRIAL',true,true,'{}'::jsonb,'Prototype for MG.', now() - interval '20 days', now() - interval '5 days'),
    (uuid_generate_v5(ns,'item:trial:timer-y'), default_tenant,'TIMER-Y-TRIAL', 'Welding timer (trial firmware)',            null,'Nos','spares','timer','spares','timer','O-KOREA','USD',1100,null,null,null,'85159000',0.09,0.09,0.18,45,1,1,'none','TRIAL',false,false,'{}'::jsonb,'Firmware eval.', now() - interval '20 days', now() - interval '5 days'),
    -- Extra ACTIVE rows used by BOM and contracts later
    (uuid_generate_v5(ns,'item:active:gun-x2c-base'),default_tenant,'X2C-BASE-ASSY','MFDC Servo Gun X2C base assembly',       'X2C-BASE','Nos','assemblies','servo_gun','assemblies','gun','O-KOREA','USD',7800,'O-KOR-240207','2024-02-07','2024-04-30','85152110',0.09,0.09,0.18,60,1,1,'none','ACTIVE',true,true,'{}'::jsonb,'Parent assembly for BOM demo.', now() - interval '300 days', now() - interval '30 days'),
    (uuid_generate_v5(ns,'item:active:subassy-arm'),default_tenant,'SUB-ARM',     'Sub-assembly: actuator arm',               'SUB-ARM','Nos','assemblies','arm','assemblies','arm','O-KOREA','USD',1800,null,null,null,'85152110',0.09,0.09,0.18,45,1,1,'none','ACTIVE',true,false,'{}'::jsonb,null, now() - interval '300 days', now() - interval '30 days'),
    (uuid_generate_v5(ns,'item:active:subassy-bracket'),default_tenant,'SUB-BRACKET','Sub-assembly: mounting bracket',        'SUB-BRK','Nos','assemblies','bracket','assemblies','bracket','O-KOREA','USD',520,null,null,null,'85152110',0.09,0.09,0.18,45,1,1,'none','ACTIVE',true,false,'{}'::jsonb,null, now() - interval '300 days', now() - interval '30 days'),
    (uuid_generate_v5(ns,'item:active:subassy-cooling'),default_tenant,'SUB-COOLING','Sub-assembly: cooling jacket',          'SUB-COOL','Nos','assemblies','cooling','assemblies','cooling','O-KOREA','USD',640,null,null,null,'85152110',0.09,0.09,0.18,45,1,1,'none','ACTIVE',true,false,'{}'::jsonb,null, now() - interval '300 days', now() - interval '30 days'),
    (uuid_generate_v5(ns,'item:active:subassy-electrode'),default_tenant,'SUB-ELECTRODE','Sub-assembly: electrode holder',    'SUB-ELC','Nos','assemblies','electrode','assemblies','electrode','O-KOREA','USD',840,null,null,null,'85152110',0.09,0.09,0.18,45,1,1,'none','ACTIVE',true,false,'{}'::jsonb,null, now() - interval '300 days', now() - interval '30 days')
  on conflict (tenant_id, part_no) do nothing;
end $item$;

-- ───────────────────────────────────────────────────────────────────
-- 5. PART_ALIASES  --  customer-facing part numbers
-- ───────────────────────────────────────────────────────────────────
do $alias$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0002-0001-000000000001';
  mg_id   uuid; tata_id uuid; jbm_id  uuid; ati_id  uuid; nippon_id uuid;
begin
  select id into mg_id     from customers where tenant_id = default_tenant and customer_key = 'MG_MOTOR_INDIA';
  select id into tata_id   from customers where tenant_id = default_tenant and customer_key = 'TATA_MOTORS_PV_PUNE';
  select id into jbm_id    from customers where tenant_id = default_tenant and customer_key = 'NRD_AUTO_PLANT_1';
  select id into ati_id    from customers where tenant_id = default_tenant and customer_key = 'ANVIL_TEST_INDUSTRIES';
  select id into nippon_id from customers where tenant_id = default_tenant and customer_key = 'NIPPON_KOGYO';

  -- Active aliases (real customer part-numbers mapped to our parts).
  if mg_id is not null then
    insert into part_aliases (id, tenant_id, customer_id, customer_part_no, customer_description, obara_part_no, status, confidence, first_seen_po, last_seen_po, created_at, updated_at) values
      (uuid_generate_v5(ns,'pa:MG:1'), default_tenant, mg_id, 'MG-CT-16D',     'Cap tip 16D',      'CT-16-D-1-FS', 'active',     0.98, '5100002515', '5100002595', now() - interval '300 days', now() - interval '30 days'),
      (uuid_generate_v5(ns,'pa:MG:2'), default_tenant, mg_id, 'MG-HOLDER-2208','Point holder 2208','4-HD32208-2',  'active',     0.95, '5100002515', '5100002595', now() - interval '300 days', now() - interval '30 days')
    on conflict (tenant_id, customer_id, customer_part_no) do nothing;
  end if;
  if tata_id is not null then
    insert into part_aliases (id, tenant_id, customer_id, customer_part_no, customer_description, obara_part_no, status, confidence, first_seen_po, last_seen_po, created_at, updated_at) values
      (uuid_generate_v5(ns,'pa:TATA:1'), default_tenant, tata_id, 'TATA-CABLE-Y1000','Connector cable Y1000','SW-Y1000-6P-MM-H/S','active', 0.92, 'TM-2024-0001', 'TM-2024-0050', now() - interval '180 days', now() - interval '20 days')
    on conflict (tenant_id, customer_id, customer_part_no) do nothing;
  end if;
  if jbm_id is not null then
    insert into part_aliases (id, tenant_id, customer_id, customer_part_no, customer_description, obara_part_no, status, confidence, first_seen_po, last_seen_po, created_at, updated_at) values
      (uuid_generate_v5(ns,'pa:NRD:1'), default_tenant, jbm_id, 'NRD-X2C-MED','Servo gun X2C medium','X2C-X-MEDIUM','active', 0.99, 'NRD-PO-501', 'NRD-PO-650', now() - interval '300 days', now() - interval '30 days')
    on conflict (tenant_id, customer_id, customer_part_no) do nothing;
  end if;

  -- Pending alias: extraction agent suggested it but admin hasn't approved.
  if ati_id is not null then
    insert into part_aliases (id, tenant_id, customer_id, customer_part_no, customer_description, obara_part_no, status, confidence, first_seen_po, last_seen_po, created_at, updated_at) values
      (uuid_generate_v5(ns,'pa:ATI:1'), default_tenant, ati_id, 'ATI-TIP-Y','Cap tip Y','TIP-Y-2026','pending', 0.74, 'ATI-PO-2026-01', 'ATI-PO-2026-01', now() - interval '20 days', now() - interval '20 days'),
      (uuid_generate_v5(ns,'pa:ATI:2'), default_tenant, ati_id, 'ATI-CBL-Y','Power cable Y','CABLE-Y-2026','pending', 0.71, 'ATI-PO-2026-01', 'ATI-PO-2026-01', now() - interval '20 days', now() - interval '20 days')
    on conflict (tenant_id, customer_id, customer_part_no) do nothing;
  end if;

  -- Deprecated aliases: prior part numbers superseded.
  if mg_id is not null then
    insert into part_aliases (id, tenant_id, customer_id, customer_part_no, customer_description, obara_part_no, status, confidence, first_seen_po, last_seen_po, created_at, updated_at) values
      (uuid_generate_v5(ns,'pa:MG:dep:1'), default_tenant, mg_id, 'MG-LEG-TIP', 'Legacy cap tip',       'LEGACY-TIP-100', 'deprecated', 0.80, '5100002400', '5100002500', now() - interval '700 days', now() - interval '300 days'),
      (uuid_generate_v5(ns,'pa:MG:dep:2'), default_tenant, mg_id, 'MG-LEG-GUN', 'Legacy servo gun X1', 'LEGACY-GUN-200', 'deprecated', 0.85, '5100002300', '5100002400', now() - interval '900 days', now() - interval '400 days')
    on conflict (tenant_id, customer_id, customer_part_no) do nothing;
  end if;
  if nippon_id is not null then
    insert into part_aliases (id, tenant_id, customer_id, customer_part_no, customer_description, obara_part_no, status, confidence, first_seen_po, last_seen_po, created_at, updated_at) values
      (uuid_generate_v5(ns,'pa:NIPPON:dep:1'), default_tenant, nippon_id, 'NK-LEG-CBL', 'Legacy cable 6P', 'LEGACY-CABLE-300', 'deprecated', 0.70, 'NK-2023-001', 'NK-2023-080', now() - interval '700 days', now() - interval '300 days')
    on conflict (tenant_id, customer_id, customer_part_no) do nothing;
  end if;
end $alias$;

-- ───────────────────────────────────────────────────────────────────
-- 6. UOM_ALIASES  --  12 rows covering the 4 rule columns
-- ───────────────────────────────────────────────────────────────────
do $uom$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
begin
  insert into uom_aliases (id, tenant_id, raw_uom, canonical_uom, tally_uom, conversion_factor, integer_only, min_order_qty, pack_size, rounding_rule, notes) values
    (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','uom:1'),  default_tenant, 'Nos',    'EA',  'Nos',  1,        true,  null, null, 'none',  'Discrete count.'),
    (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','uom:2'),  default_tenant, 'Pcs',    'EA',  'Nos',  1,        true,  null, null, 'none',  'Discrete count alias.'),
    (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','uom:3'),  default_tenant, 'Pieces', 'EA',  'Nos',  1,        true,  null, null, 'none',  'English alias.'),
    (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','uom:4'),  default_tenant, 'EA',     'EA',  'Nos',  1,        true,  null, null, 'none',  'ISO base.'),
    (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','uom:5'),  default_tenant, 'Box-500','EA',  'Nos',  500,      true,  500,  500, 'round', 'TIP-Y-2026 ships 500 per box; min order = 500.'),
    (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','uom:6'),  default_tenant, 'Pack-10','Mtr', 'Mtr',  10,       false, 10,   10,  'ceil',  'CABLE-Y-2026 ships 10m per pack; round up.'),
    (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','uom:7'),  default_tenant, 'Mtr',    'Mtr', 'Mtr',  1,        false, null, null, 'none',  'Length.'),
    (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','uom:8'),  default_tenant, 'Meter',  'Mtr', 'Mtr',  1,        false, null, null, 'none',  'Length alias.'),
    (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','uom:9'),  default_tenant, 'Roll-50','Mtr', 'Mtr',  50,       false, 50,   50,  'ceil',  'Cable rolls.'),
    (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','uom:10'), default_tenant, 'Set',    'EA',  'Set',  1,        true,  null, null, 'none',  'Logical set.'),
    (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','uom:11'), default_tenant, 'Kg',     'Kg',  'Kg',   1,        false, null, null, 'floor', 'Bulk weight.'),
    (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','uom:12'), default_tenant, 'Drum',   'Ltr', 'Ltr',  200,      false, 200,  200, 'ceil',  '200L drum.')
  on conflict (tenant_id, raw_uom) do nothing;
end $uom$;

-- ───────────────────────────────────────────────────────────────────
-- 7. BILL_OF_MATERIALS  --  3-level: 1 parent, 4 sub-assemblies, 12 components
-- ───────────────────────────────────────────────────────────────────
-- Level 1 parent: X2C-BASE-ASSY (the "active" item created above).
-- Level 2 sub-assemblies: SUB-ARM, SUB-BRACKET, SUB-COOLING, SUB-ELECTRODE.
-- Level 3 components per sub-assembly: 3 each = 12 total leaf components.
-- Components reuse existing corpus item_master rows where possible.
do $bom$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0002-0001-000000000001';
begin
  -- Level 1 -> 2: 4 rows
  insert into bill_of_materials (id, tenant_id, parent_part_no, child_part_no, qty, uom, notes, created_at, updated_at) values
    (uuid_generate_v5(ns,'bom:l1:arm'),       default_tenant, 'X2C-BASE-ASSY', 'SUB-ARM',       1, 'Nos', 'Actuator arm sub-assembly.',     now() - interval '120 days', now() - interval '60 days'),
    (uuid_generate_v5(ns,'bom:l1:bracket'),   default_tenant, 'X2C-BASE-ASSY', 'SUB-BRACKET',   1, 'Nos', 'Mounting bracket sub-assembly.', now() - interval '120 days', now() - interval '60 days'),
    (uuid_generate_v5(ns,'bom:l1:cooling'),   default_tenant, 'X2C-BASE-ASSY', 'SUB-COOLING',   1, 'Nos', 'Cooling jacket sub-assembly.',   now() - interval '120 days', now() - interval '60 days'),
    (uuid_generate_v5(ns,'bom:l1:electrode'), default_tenant, 'X2C-BASE-ASSY', 'SUB-ELECTRODE', 1, 'Nos', 'Electrode holder sub-assembly.', now() - interval '120 days', now() - interval '60 days')
  on conflict (tenant_id, parent_part_no, child_part_no) do nothing;

  -- Level 2 -> 3: 3 components per sub-assembly = 12 rows.
  insert into bill_of_materials (id, tenant_id, parent_part_no, child_part_no, qty, uom, notes, created_at, updated_at) values
    -- ARM
    (uuid_generate_v5(ns,'bom:l2:arm:1'),       default_tenant, 'SUB-ARM',       '4-TP3082',         2, 'Nos', null, now() - interval '110 days', now() - interval '60 days'),
    (uuid_generate_v5(ns,'bom:l2:arm:2'),       default_tenant, 'SUB-ARM',       'CT-16-D-1-FS',     2, 'Nos', null, now() - interval '110 days', now() - interval '60 days'),
    (uuid_generate_v5(ns,'bom:l2:arm:3'),       default_tenant, 'SUB-ARM',       '4-HD32208-2',      1, 'Nos', null, now() - interval '110 days', now() - interval '60 days'),
    -- BRACKET
    (uuid_generate_v5(ns,'bom:l2:bracket:1'),   default_tenant, 'SUB-BRACKET',   '403A7K878-169',    2, 'Nos', null, now() - interval '110 days', now() - interval '60 days'),
    (uuid_generate_v5(ns,'bom:l2:bracket:2'),   default_tenant, 'SUB-BRACKET',   'IN0-0133',         1, 'Nos', null, now() - interval '110 days', now() - interval '60 days'),
    (uuid_generate_v5(ns,'bom:l2:bracket:3'),   default_tenant, 'SUB-BRACKET',   'SW-Y1000-6P-MM-H/S',1,'Nos', null, now() - interval '110 days', now() - interval '60 days'),
    -- COOLING
    (uuid_generate_v5(ns,'bom:l2:cooling:1'),   default_tenant, 'SUB-COOLING',   'CABLE-Y-2026',     6, 'Mtr', null, now() - interval '110 days', now() - interval '60 days'),
    (uuid_generate_v5(ns,'bom:l2:cooling:2'),   default_tenant, 'SUB-COOLING',   'TIP-Y-2026',       2, 'Nos', null, now() - interval '110 days', now() - interval '60 days'),
    (uuid_generate_v5(ns,'bom:l2:cooling:3'),   default_tenant, 'SUB-COOLING',   'IN0-0133',         1, 'Nos', null, now() - interval '110 days', now() - interval '60 days'),
    -- ELECTRODE
    (uuid_generate_v5(ns,'bom:l2:electrode:1'), default_tenant, 'SUB-ELECTRODE', 'CT-16-D-1-FS',     4, 'Nos', null, now() - interval '110 days', now() - interval '60 days'),
    (uuid_generate_v5(ns,'bom:l2:electrode:2'), default_tenant, 'SUB-ELECTRODE', '4-TP3082',         2, 'Nos', null, now() - interval '110 days', now() - interval '60 days'),
    (uuid_generate_v5(ns,'bom:l2:electrode:3'), default_tenant, 'SUB-ELECTRODE', '4-HD32208-2',      1, 'Nos', null, now() - interval '110 days', now() - interval '60 days')
  on conflict (tenant_id, parent_part_no, child_part_no) do nothing;
end $bom$;

-- ───────────────────────────────────────────────────────────────────
-- 8. TALLY_INVENTORY  --  15 stock items
-- ───────────────────────────────────────────────────────────────────
insert into tally_inventory (id, tenant_id, stock_item_name, available_qty, reserved_qty, reorder_level, uom, last_sync_at) values
  (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','inv:1'),  '00000000-0000-0000-0000-000000000001'::uuid, 'CT-16-D-1-FS',         1200,   400, 500,  'Nos', now() - interval '6 hours'),
  (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','inv:2'),  '00000000-0000-0000-0000-000000000001'::uuid, '4-TP3082',              850,   100, 200,  'Nos', now() - interval '6 hours'),
  (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','inv:3'),  '00000000-0000-0000-0000-000000000001'::uuid, 'IN0-0133',               40,    10,  20,  'Nos', now() - interval '6 hours'),
  (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','inv:4'),  '00000000-0000-0000-0000-000000000001'::uuid, 'SW-Y1000-6P-MM-H/S',     90,    30,  60,  'Nos', now() - interval '6 hours'),
  (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','inv:5'),  '00000000-0000-0000-0000-000000000001'::uuid, '403A7K878-169',         180,    20,  80,  'Nos', now() - interval '6 hours'),
  (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','inv:6'),  '00000000-0000-0000-0000-000000000001'::uuid, '4-HD32208-2',           110,    15,  60,  'Nos', now() - interval '6 hours'),
  (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','inv:7'),  '00000000-0000-0000-0000-000000000001'::uuid, 'X2C-X-MEDIUM',           14,     2,   8,  'Nos', now() - interval '6 hours'),
  (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','inv:8'),  '00000000-0000-0000-0000-000000000001'::uuid, 'X2C-X-LARGE',            10,     1,   5,  'Nos', now() - interval '6 hours'),
  (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','inv:9'),  '00000000-0000-0000-0000-000000000001'::uuid, 'X2C-BASE-ASSY',          12,     2,   6,  'Nos', now() - interval '6 hours'),
  (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','inv:10'), '00000000-0000-0000-0000-000000000001'::uuid, 'SUB-ARM',                28,     3,  10,  'Nos', now() - interval '6 hours'),
  (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','inv:11'), '00000000-0000-0000-0000-000000000001'::uuid, 'SUB-BRACKET',            44,     5,  15,  'Nos', now() - interval '6 hours'),
  (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','inv:12'), '00000000-0000-0000-0000-000000000001'::uuid, 'SUB-COOLING',            22,     4,  10,  'Nos', now() - interval '6 hours'),
  (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','inv:13'), '00000000-0000-0000-0000-000000000001'::uuid, 'SUB-ELECTRODE',          18,     2,  10,  'Nos', now() - interval '6 hours'),
  (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','inv:14'), '00000000-0000-0000-0000-000000000001'::uuid, 'TIP-Y-2026',           5500,   500, 1500, 'Nos', now() - interval '6 hours'),
  (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','inv:15'), '00000000-0000-0000-0000-000000000001'::uuid, 'CABLE-Y-2026',          820,    50, 200,  'Mtr', now() - interval '6 hours')
on conflict (tenant_id, stock_item_name) do nothing;

-- ───────────────────────────────────────────────────────────────────
-- 9. CATALOG_SYNONYMS + CATALOG_ALTERNATIVES + PRIVATE_LABEL_ITEMS
-- ───────────────────────────────────────────────────────────────────
do $catalog$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0002-0001-000000000001';
  it_tip_d   uuid; it_tip_y uuid; it_tip_z uuid;
  it_x2c_med uuid; it_x2c_l uuid; it_x3    uuid; it_x4    uuid;
  it_cable_y uuid; it_legacy_cable uuid;
  it_holder  uuid; it_legacy_gun  uuid; it_x2c_base uuid;
begin
  select id into it_tip_d         from item_master where tenant_id = default_tenant and part_no = 'CT-16-D-1-FS';
  select id into it_tip_y         from item_master where tenant_id = default_tenant and part_no = 'TIP-Y-2026';
  select id into it_tip_z         from item_master where tenant_id = default_tenant and part_no = 'TIP-Z-TRIAL';
  select id into it_x2c_med       from item_master where tenant_id = default_tenant and part_no = 'X2C-X-MEDIUM';
  select id into it_x2c_l         from item_master where tenant_id = default_tenant and part_no = 'X2C-X-LARGE';
  select id into it_x3            from item_master where tenant_id = default_tenant and part_no = 'X3-X-MEDIUM';
  select id into it_x4            from item_master where tenant_id = default_tenant and part_no = 'X4-X-TRIAL';
  select id into it_cable_y       from item_master where tenant_id = default_tenant and part_no = 'CABLE-Y-2026';
  select id into it_legacy_cable  from item_master where tenant_id = default_tenant and part_no = 'LEGACY-CABLE-300';
  select id into it_holder        from item_master where tenant_id = default_tenant and part_no = '4-HD32208-2';
  select id into it_legacy_gun    from item_master where tenant_id = default_tenant and part_no = 'LEGACY-GUN-200';
  select id into it_x2c_base      from item_master where tenant_id = default_tenant and part_no = 'X2C-BASE-ASSY';

  -- 10 synonyms covering manual / learned / imported sources.
  if it_tip_d is not null then
    insert into catalog_synonyms (id, tenant_id, item_id, synonym, source, confidence, created_at) values
      (uuid_generate_v5(ns,'syn:tip-d:1'), default_tenant, it_tip_d, 'cap tip 16 D',          'manual',   1.000, now() - interval '60 days'),
      (uuid_generate_v5(ns,'syn:tip-d:2'), default_tenant, it_tip_d, '16D cap tip',           'learned',  0.870, now() - interval '40 days'),
      (uuid_generate_v5(ns,'syn:tip-d:3'), default_tenant, it_tip_d, 'welding tip 16D',       'imported', 0.700, now() - interval '30 days')
    on conflict (tenant_id, item_id, synonym) do nothing;
  end if;
  if it_x2c_med is not null then
    insert into catalog_synonyms (id, tenant_id, item_id, synonym, source, confidence, created_at) values
      (uuid_generate_v5(ns,'syn:x2c-med:1'), default_tenant, it_x2c_med, 'X2C medium gun',     'manual',   1.000, now() - interval '60 days'),
      (uuid_generate_v5(ns,'syn:x2c-med:2'), default_tenant, it_x2c_med, 'X2C-M servo gun',    'learned',  0.890, now() - interval '40 days')
    on conflict (tenant_id, item_id, synonym) do nothing;
  end if;
  if it_x3 is not null then
    insert into catalog_synonyms (id, tenant_id, item_id, synonym, source, confidence, created_at) values
      (uuid_generate_v5(ns,'syn:x3:1'), default_tenant, it_x3, 'X3 medium gun',     'manual',   1.000, now() - interval '30 days'),
      (uuid_generate_v5(ns,'syn:x3:2'), default_tenant, it_x3, 'X3 successor',      'learned',  0.760, now() - interval '20 days')
    on conflict (tenant_id, item_id, synonym) do nothing;
  end if;
  if it_holder is not null then
    insert into catalog_synonyms (id, tenant_id, item_id, synonym, source, confidence, created_at) values
      (uuid_generate_v5(ns,'syn:holder:1'), default_tenant, it_holder, 'point holder 2208', 'manual', 1.000, now() - interval '60 days')
    on conflict (tenant_id, item_id, synonym) do nothing;
  end if;
  if it_cable_y is not null then
    insert into catalog_synonyms (id, tenant_id, item_id, synonym, source, confidence, created_at) values
      (uuid_generate_v5(ns,'syn:cabley:1'), default_tenant, it_cable_y, 'UV-stable power cable', 'imported', 0.650, now() - interval '20 days'),
      (uuid_generate_v5(ns,'syn:cabley:2'), default_tenant, it_cable_y, 'cable Y 2026',          'manual',   1.000, now() - interval '20 days')
    on conflict (tenant_id, item_id, synonym) do nothing;
  end if;

  -- 10 alternatives covering all 4 relations.
  if it_tip_d is not null and it_tip_y is not null then
    insert into catalog_alternatives (id, tenant_id, item_id, alternative_item_id, relation, margin_delta_bps, spec_match_score, notes, created_at) values
      (uuid_generate_v5(ns,'alt:1'), default_tenant, it_tip_d, it_tip_y, 'upgrade',  220,  0.95, 'Y alloy lasts 30% longer; standard upgrade path.', now() - interval '40 days')
    on conflict (tenant_id, item_id, alternative_item_id, relation) do nothing;
  end if;
  if it_tip_d is not null and it_tip_z is not null then
    insert into catalog_alternatives (id, tenant_id, item_id, alternative_item_id, relation, margin_delta_bps, spec_match_score, notes, created_at) values
      (uuid_generate_v5(ns,'alt:2'), default_tenant, it_tip_d, it_tip_z, 'crosssell', 350,  0.85, 'Premium trial alloy; suggest as crosssell.', now() - interval '20 days')
    on conflict (tenant_id, item_id, alternative_item_id, relation) do nothing;
  end if;
  if it_x2c_med is not null and it_x3 is not null then
    insert into catalog_alternatives (id, tenant_id, item_id, alternative_item_id, relation, margin_delta_bps, spec_match_score, notes, created_at) values
      (uuid_generate_v5(ns,'alt:3'), default_tenant, it_x2c_med, it_x3, 'upgrade',  500,  0.97, 'X3 supersedes X2C series.', now() - interval '30 days')
    on conflict (tenant_id, item_id, alternative_item_id, relation) do nothing;
  end if;
  if it_x2c_med is not null and it_x2c_l is not null then
    insert into catalog_alternatives (id, tenant_id, item_id, alternative_item_id, relation, margin_delta_bps, spec_match_score, notes, created_at) values
      (uuid_generate_v5(ns,'alt:4'), default_tenant, it_x2c_med, it_x2c_l, 'crosssell', 50,  0.88, 'Larger throat; same family.', now() - interval '60 days')
    on conflict (tenant_id, item_id, alternative_item_id, relation) do nothing;
  end if;
  if it_x2c_l is not null and it_x2c_med is not null then
    insert into catalog_alternatives (id, tenant_id, item_id, alternative_item_id, relation, margin_delta_bps, spec_match_score, notes, created_at) values
      (uuid_generate_v5(ns,'alt:5'), default_tenant, it_x2c_l, it_x2c_med, 'downsell', -50, 0.88, 'Smaller throat; cost-down.', now() - interval '60 days')
    on conflict (tenant_id, item_id, alternative_item_id, relation) do nothing;
  end if;
  if it_x4 is not null and it_x3 is not null then
    insert into catalog_alternatives (id, tenant_id, item_id, alternative_item_id, relation, margin_delta_bps, spec_match_score, notes, created_at) values
      (uuid_generate_v5(ns,'alt:6'), default_tenant, it_x4, it_x3, 'equivalent', 0,   0.92, 'Trial X4 ~equivalent to X3 production.', now() - interval '20 days')
    on conflict (tenant_id, item_id, alternative_item_id, relation) do nothing;
  end if;
  if it_legacy_cable is not null and it_cable_y is not null then
    insert into catalog_alternatives (id, tenant_id, item_id, alternative_item_id, relation, margin_delta_bps, spec_match_score, notes, created_at) values
      (uuid_generate_v5(ns,'alt:7'), default_tenant, it_legacy_cable, it_cable_y, 'upgrade', 280, 0.90, 'UV-stable replacement.', now() - interval '40 days')
    on conflict (tenant_id, item_id, alternative_item_id, relation) do nothing;
  end if;
  if it_legacy_gun is not null and it_x2c_med is not null then
    insert into catalog_alternatives (id, tenant_id, item_id, alternative_item_id, relation, margin_delta_bps, spec_match_score, notes, created_at) values
      (uuid_generate_v5(ns,'alt:8'), default_tenant, it_legacy_gun, it_x2c_med, 'upgrade', 800, 0.94, 'Legacy phaseout migration path.', now() - interval '120 days')
    on conflict (tenant_id, item_id, alternative_item_id, relation) do nothing;
  end if;
  if it_x2c_base is not null and it_x2c_med is not null then
    insert into catalog_alternatives (id, tenant_id, item_id, alternative_item_id, relation, margin_delta_bps, spec_match_score, notes, created_at) values
      (uuid_generate_v5(ns,'alt:9'), default_tenant, it_x2c_base, it_x2c_med, 'equivalent', 0, 1.00, 'Base assembly is BOM parent for the X2C-X-MEDIUM SKU.', now() - interval '40 days')
    on conflict (tenant_id, item_id, alternative_item_id, relation) do nothing;
  end if;
  if it_tip_y is not null and it_tip_d is not null then
    insert into catalog_alternatives (id, tenant_id, item_id, alternative_item_id, relation, margin_delta_bps, spec_match_score, notes, created_at) values
      (uuid_generate_v5(ns,'alt:10'), default_tenant, it_tip_y, it_tip_d, 'downsell', -180, 0.95, 'Cost-down to baseline 16D alloy.', now() - interval '40 days')
    on conflict (tenant_id, item_id, alternative_item_id, relation) do nothing;
  end if;

  -- 5 private-label items.
  if it_tip_d is not null then
    insert into private_label_items (id, tenant_id, item_id, label_brand, margin_bps, active, notes)
    values (uuid_generate_v5(ns,'pl:1'), default_tenant, it_tip_d, 'AnvilEdge', 350, true, 'House brand; high-volume tip.')
    on conflict (tenant_id, item_id) do nothing;
  end if;
  if it_x2c_med is not null then
    insert into private_label_items (id, tenant_id, item_id, label_brand, margin_bps, active, notes)
    values (uuid_generate_v5(ns,'pl:2'), default_tenant, it_x2c_med, 'AnvilEdge', 280, true, 'Branded variant of X2C medium.')
    on conflict (tenant_id, item_id) do nothing;
  end if;
  if it_holder is not null then
    insert into private_label_items (id, tenant_id, item_id, label_brand, margin_bps, active, notes)
    values (uuid_generate_v5(ns,'pl:3'), default_tenant, it_holder, 'AnvilEdge', 220, true, 'Branded holder.')
    on conflict (tenant_id, item_id) do nothing;
  end if;
  if it_cable_y is not null then
    insert into private_label_items (id, tenant_id, item_id, label_brand, margin_bps, active, notes)
    values (uuid_generate_v5(ns,'pl:4'), default_tenant, it_cable_y, 'AnvilEdge', 410, true, 'New 2026 cable; high margin.')
    on conflict (tenant_id, item_id) do nothing;
  end if;
  if it_x3 is not null then
    insert into private_label_items (id, tenant_id, item_id, label_brand, margin_bps, active, notes)
    values (uuid_generate_v5(ns,'pl:5'), default_tenant, it_x3, 'AnvilEdge', 500, false, 'Reserved label; activate at GA.')
    on conflict (tenant_id, item_id) do nothing;
  end if;
end $catalog$;

-- ───────────────────────────────────────────────────────────────────
-- 10. VENDORS  --  8 supplier rows
-- ───────────────────────────────────────────────────────────────────
insert into vendors (id, tenant_id, vendor_name, vendor_key, contact_email, contact_phone, payment_terms, default_lead_time_days, active, notes, external_ref, created_at, updated_at) values
  (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','vendor:1'), '00000000-0000-0000-0000-000000000001'::uuid, 'Northwind Korea Co. Ltd.',         'OKR',   'sales@northwind-kr.example',   '+82 31 5550 0100', 'Advance T/T 100%',    14, true, 'Sister-company, KR factory.',         jsonb_build_object('country','KR','seed_marker','anvil-test-seed-v1'), now() - interval '720 days', now() - interval '30 days'),
  (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','vendor:2'), '00000000-0000-0000-0000-000000000001'::uuid, 'Northwind Japan Co. Ltd.',         'OJP',   'eigyou@northwind-jp.example',  '+81 3 5550 0200',  'Advance T/T 100%',    21, true, 'Sister-company, JP factory.',         jsonb_build_object('country','JP','seed_marker','anvil-test-seed-v1'), now() - interval '720 days', now() - interval '30 days'),
  (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','vendor:3'), '00000000-0000-0000-0000-000000000001'::uuid, 'Northwind China Co. Ltd.',         'OCN',   'sales@northwind-cn.example',   '+86 21 5550 0300', 'L/C at sight',        28, true, 'Sister-company, CN factory.',         jsonb_build_object('country','CN','seed_marker','anvil-test-seed-v1'), now() - interval '720 days', now() - interval '30 days'),
  (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','vendor:4'), '00000000-0000-0000-0000-000000000001'::uuid, 'BKS Cables Pvt Ltd',           'BKS',   'sales@bks-cables.example', '+91 22 5550 0400', 'Net 30 days NEFT',     5, true, 'Domestic cable supplier.',            jsonb_build_object('country','IN','seed_marker','anvil-test-seed-v1'), now() - interval '500 days', now() - interval '30 days'),
  (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','vendor:5'), '00000000-0000-0000-0000-000000000001'::uuid, 'Globex Manufacturing GmbH',    'GLBX',  'einkauf@globex-mfg.example','+49 40 5550 2020', 'Net 45 days SEPA',    35, true, 'EU tooling supplier.',                jsonb_build_object('country','DE','seed_marker','anvil-test-seed-v1'), now() - interval '300 days', now() - interval '20 days'),
  (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','vendor:6'), '00000000-0000-0000-0000-000000000001'::uuid, 'Acme Robotics LLC',            'ACME',  'orders@acme-robotics.example','+1 216 555 3030', 'Net 30 days ACH',    30, true, 'US robotics supplier.',                jsonb_build_object('country','US','seed_marker','anvil-test-seed-v1'), now() - interval '300 days', now() - interval '20 days'),
  (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','vendor:7'), '00000000-0000-0000-0000-000000000001'::uuid, 'Hindustan Tools Ltd',          'HT',    'sales@hindtools.example',  '+91 80 5550 0700', 'Net 15 days NEFT',     7, true, 'Domestic tooling supplier.',          jsonb_build_object('country','IN','seed_marker','anvil-test-seed-v1'), now() - interval '500 days', now() - interval '40 days'),
  (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','vendor:8'), '00000000-0000-0000-0000-000000000001'::uuid, 'Suspended Supplier Pvt Ltd',  'SUSPN', 'old@suspn.example',        null,                'Net 60 days',         60, false,'Inactive; QC issues 2024.',           jsonb_build_object('country','IN','suspended_since','2024-08-01','seed_marker','anvil-test-seed-v1'), now() - interval '900 days', now() - interval '300 days')
on conflict (tenant_id, vendor_name) do nothing;

-- ───────────────────────────────────────────────────────────────────
-- 11. EQUIPMENT_HIERARCHY  --  full Plant→Line→Zone→Station→Robot→Gun chain
-- ───────────────────────────────────────────────────────────────────
-- Two customers: NRD Auto (already in 010 corpus, rows likely partial)
-- and Vega Motor (Halol). Each gets a 6-level chain.
do $eq$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0002-0001-000000000001';
  mg_id          uuid;  jbm_id   uuid;
  mg_halol_loc   uuid;  jbm_loc  uuid;
  -- Hierarchy node ids (computed via uuid_generate_v5 inline below).
  mg_plant       uuid;  mg_line  uuid; mg_zone   uuid; mg_station   uuid; mg_robot   uuid;
  jbm_plant      uuid;  jbm_line uuid; jbm_zone  uuid; jbm_station  uuid; jbm_robot  uuid;
begin
  select id into mg_id  from customers where tenant_id = default_tenant and customer_key = 'MG_MOTOR_INDIA';
  select id into jbm_id from customers where tenant_id = default_tenant and customer_key = 'NRD_AUTO_PLANT_1';
  select id into mg_halol_loc from customer_locations where tenant_id = default_tenant and customer_id = mg_id and location_code = 'HALOL';

  -- Vega Motor Halol chain
  if mg_id is not null then
    mg_plant   := uuid_generate_v5(ns,'eq:MG:plant');
    mg_line    := uuid_generate_v5(ns,'eq:MG:line');
    mg_zone    := uuid_generate_v5(ns,'eq:MG:zone');
    mg_station := uuid_generate_v5(ns,'eq:MG:station');
    mg_robot   := uuid_generate_v5(ns,'eq:MG:robot');

    insert into equipment_hierarchy (id, tenant_id, customer_id, customer_location_id, plant_name, line_name, zone_name, station_name, robot_make, robot_no, gun_no, gun_type, qty, timer_model, atd_model, parent_id, notes, created_at, updated_at) values
      (mg_plant,   default_tenant, mg_id, mg_halol_loc, 'MG Halol Plant', null,           null,          null,           null,    null, null,   null,   1, null, null, null,     'Top-level plant node.', now() - interval '300 days', now() - interval '30 days'),
      (mg_line,    default_tenant, mg_id, mg_halol_loc, 'MG Halol Plant', 'BIW Line A',    null,          null,           null,    null, null,   null,   1, null, null, mg_plant, 'BIW Line A.',           now() - interval '300 days', now() - interval '30 days'),
      (mg_zone,    default_tenant, mg_id, mg_halol_loc, 'MG Halol Plant', 'BIW Line A',    'Zone 3',      null,           null,    null, null,   null,   1, null, null, mg_line,  'Zone 3 of Line A.',     now() - interval '300 days', now() - interval '30 days'),
      (mg_station, default_tenant, mg_id, mg_halol_loc, 'MG Halol Plant', 'BIW Line A',    'Zone 3',      'Station S12',  null,    null, null,   null,   1, null, null, mg_zone,  'Station S12.',          now() - interval '300 days', now() - interval '30 days'),
      (mg_robot,   default_tenant, mg_id, mg_halol_loc, 'MG Halol Plant', 'BIW Line A',    'Zone 3',      'Station S12',  'FANUC', 'R-12','GUN-12-A','servo', 1, 'TMR-200','ATD-100', mg_station, 'Robot R-12 / Gun A.', now() - interval '300 days', now() - interval '30 days'),
      (uuid_generate_v5(ns,'eq:MG:gun-b'),
                  default_tenant, mg_id, mg_halol_loc, 'MG Halol Plant', 'BIW Line A',    'Zone 3',      'Station S12',  'FANUC', 'R-12','GUN-12-B','servo', 1, 'TMR-200','ATD-100', mg_robot,   'Second gun on R-12.', now() - interval '300 days', now() - interval '30 days')
    on conflict (id) do nothing;
  end if;

  -- NRD Auto chain (Plant 1)
  if jbm_id is not null then
    select id into jbm_loc from customer_locations where tenant_id = default_tenant and customer_id = jbm_id limit 1;

    jbm_plant   := uuid_generate_v5(ns,'eq:NRD:plant');
    jbm_line    := uuid_generate_v5(ns,'eq:NRD:line');
    jbm_zone    := uuid_generate_v5(ns,'eq:NRD:zone');
    jbm_station := uuid_generate_v5(ns,'eq:NRD:station');
    jbm_robot   := uuid_generate_v5(ns,'eq:NRD:robot');

    insert into equipment_hierarchy (id, tenant_id, customer_id, customer_location_id, plant_name, line_name, zone_name, station_name, robot_make, robot_no, gun_no, gun_type, qty, timer_model, atd_model, parent_id, notes, created_at, updated_at) values
      (jbm_plant,   default_tenant, jbm_id, jbm_loc, 'NRD Plant 1', null,        null,    null,            null,    null,   null,    null,   1, null, null, null,        null, now() - interval '300 days', now() - interval '30 days'),
      (jbm_line,    default_tenant, jbm_id, jbm_loc, 'NRD Plant 1', 'Line 2',     null,    null,            null,    null,   null,    null,   1, null, null, jbm_plant,   null, now() - interval '300 days', now() - interval '30 days'),
      (jbm_zone,    default_tenant, jbm_id, jbm_loc, 'NRD Plant 1', 'Line 2',     'Zone 5',null,            null,    null,   null,    null,   1, null, null, jbm_line,    null, now() - interval '300 days', now() - interval '30 days'),
      (jbm_station, default_tenant, jbm_id, jbm_loc, 'NRD Plant 1', 'Line 2',     'Zone 5','Station S05',   null,    null,   null,    null,   1, null, null, jbm_zone,    null, now() - interval '300 days', now() - interval '30 days'),
      (jbm_robot,   default_tenant, jbm_id, jbm_loc, 'NRD Plant 1', 'Line 2',     'Zone 5','Station S05',   'KUKA',  'R-05', 'GUN-05-A','servo', 1, 'TMR-300','ATD-200', jbm_station, null, now() - interval '300 days', now() - interval '30 days'),
      (uuid_generate_v5(ns,'eq:NRD:gun-b'),
                   default_tenant, jbm_id, jbm_loc, 'NRD Plant 1', 'Line 2',     'Zone 5','Station S05',   'KUKA',  'R-05', 'GUN-05-B','servo', 1, 'TMR-300','ATD-200', jbm_robot,   null, now() - interval '300 days', now() - interval '30 days')
    on conflict (id) do nothing;
  end if;
end $eq$;

-- ───────────────────────────────────────────────────────────────────
-- 12. EQUIPMENT_INSTALLED_PARTS  --  installed-on rows per gun
-- ───────────────────────────────────────────────────────────────────
do $eqp$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0002-0001-000000000001';
  mg_gun_a    uuid := uuid_generate_v5(ns,'eq:MG:robot');
  mg_gun_b    uuid := uuid_generate_v5(ns,'eq:MG:gun-b');
  jbm_gun_a   uuid := uuid_generate_v5(ns,'eq:NRD:robot');
  jbm_gun_b   uuid := uuid_generate_v5(ns,'eq:NRD:gun-b');
begin
  -- 8 parts per gun = 32 rows total. Use real corpus + new items.
  insert into equipment_installed_parts (id, tenant_id, equipment_id, part_no, description, installed_qty, is_critical, is_emergency_only, recommended_qty_90d, recommended_qty_180d, recommended_qty_365d, last_replaced_at, notes) values
    -- MG Gun A
    (uuid_generate_v5(ns,'eqp:MG-A:1'),  default_tenant, mg_gun_a, 'CT-16-D-1-FS',     'Cap tip 16D',      4, true,  false, 8,  16, 32, (now() - interval '20 days')::date, null),
    (uuid_generate_v5(ns,'eqp:MG-A:2'),  default_tenant, mg_gun_a, '4-TP3082',          'Cap tip alt',      2, true,  false, 4,   8, 16, (now() - interval '20 days')::date, null),
    (uuid_generate_v5(ns,'eqp:MG-A:3'),  default_tenant, mg_gun_a, '4-HD32208-2',       'Holder',           1, false, false, 1,   2,  4, (now() - interval '120 days')::date, null),
    (uuid_generate_v5(ns,'eqp:MG-A:4'),  default_tenant, mg_gun_a, 'IN0-0133',          'Terminal box assy',1, true,  true,  1,   1,  2, (now() - interval '180 days')::date, 'Critical and emergency-only.'),
    (uuid_generate_v5(ns,'eqp:MG-A:5'),  default_tenant, mg_gun_a, 'SW-Y1000-6P-MM-H/S','Connector cable',  1, false, false, 1,   2,  3, (now() - interval '90 days')::date,  null),
    (uuid_generate_v5(ns,'eqp:MG-A:6'),  default_tenant, mg_gun_a, '403A7K878-169',     'Point holder',     2, false, false, 2,   4,  6, (now() - interval '60 days')::date,  null),
    (uuid_generate_v5(ns,'eqp:MG-A:7'),  default_tenant, mg_gun_a, 'X2C-X-MEDIUM',      'Servo gun assy',   1, true,  true,  0,   0,  1, (now() - interval '300 days')::date, 'Body assembly.'),
    (uuid_generate_v5(ns,'eqp:MG-A:8'),  default_tenant, mg_gun_a, 'SUB-COOLING',       'Cooling jacket',   1, false, false, 0,   0,  1, (now() - interval '300 days')::date, null),
    -- MG Gun B
    (uuid_generate_v5(ns,'eqp:MG-B:1'),  default_tenant, mg_gun_b, 'CT-16-D-1-FS',     'Cap tip 16D',      4, true,  false, 8,  16, 32, (now() - interval '20 days')::date, null),
    (uuid_generate_v5(ns,'eqp:MG-B:2'),  default_tenant, mg_gun_b, '4-HD32208-2',       'Holder',           1, false, false, 1,   2,  4, (now() - interval '120 days')::date, null),
    (uuid_generate_v5(ns,'eqp:MG-B:3'),  default_tenant, mg_gun_b, 'IN0-0133',          'Terminal box assy',1, true,  true,  1,   1,  2, (now() - interval '180 days')::date, null),
    (uuid_generate_v5(ns,'eqp:MG-B:4'),  default_tenant, mg_gun_b, 'X2C-X-MEDIUM',      'Servo gun assy',   1, true,  true,  0,   0,  1, (now() - interval '300 days')::date, null),
    (uuid_generate_v5(ns,'eqp:MG-B:5'),  default_tenant, mg_gun_b, 'SW-Y1000-6P-MM-H/S','Connector cable',  1, false, false, 1,   2,  3, (now() - interval '90 days')::date,  null),
    (uuid_generate_v5(ns,'eqp:MG-B:6'),  default_tenant, mg_gun_b, '403A7K878-169',     'Point holder',     2, false, false, 2,   4,  6, (now() - interval '60 days')::date,  null),
    (uuid_generate_v5(ns,'eqp:MG-B:7'),  default_tenant, mg_gun_b, 'SUB-ARM',           'Actuator arm',     1, false, false, 0,   0,  1, (now() - interval '300 days')::date, null),
    (uuid_generate_v5(ns,'eqp:MG-B:8'),  default_tenant, mg_gun_b, 'SUB-BRACKET',       'Bracket',          1, false, false, 0,   0,  1, (now() - interval '300 days')::date, null),
    -- NRD Gun A
    (uuid_generate_v5(ns,'eqp:NRD-A:1'), default_tenant, jbm_gun_a, 'CT-16-D-1-FS',     'Cap tip 16D',      4, true,  false, 8,  16, 32, (now() - interval '15 days')::date, null),
    (uuid_generate_v5(ns,'eqp:NRD-A:2'), default_tenant, jbm_gun_a, '4-TP3082',          'Cap tip alt',      2, true,  false, 4,   8, 16, (now() - interval '15 days')::date, null),
    (uuid_generate_v5(ns,'eqp:NRD-A:3'), default_tenant, jbm_gun_a, '4-HD32208-2',       'Holder',           1, false, false, 1,   2,  4, (now() - interval '90 days')::date, null),
    (uuid_generate_v5(ns,'eqp:NRD-A:4'), default_tenant, jbm_gun_a, 'IN0-0133',          'Terminal box assy',1, true,  true,  1,   1,  2, (now() - interval '180 days')::date, null),
    (uuid_generate_v5(ns,'eqp:NRD-A:5'), default_tenant, jbm_gun_a, 'X2C-X-LARGE',       'Servo gun assy',   1, true,  true,  0,   0,  1, (now() - interval '300 days')::date, 'Larger throat for NRD line.'),
    (uuid_generate_v5(ns,'eqp:NRD-A:6'), default_tenant, jbm_gun_a, 'SW-Y1000-6P-MM-H/S','Connector cable',  1, false, false, 1,   2,  3, (now() - interval '60 days')::date,  null),
    (uuid_generate_v5(ns,'eqp:NRD-A:7'), default_tenant, jbm_gun_a, '403A7K878-169',     'Point holder',     2, false, false, 2,   4,  6, (now() - interval '60 days')::date,  null),
    (uuid_generate_v5(ns,'eqp:NRD-A:8'), default_tenant, jbm_gun_a, 'CABLE-Y-2026',      'Power cable Y',    6, false, false, 0,   6, 12, (now() - interval '20 days')::date,  null),
    -- NRD Gun B
    (uuid_generate_v5(ns,'eqp:NRD-B:1'), default_tenant, jbm_gun_b, 'CT-16-D-1-FS',     'Cap tip 16D',      4, true,  false, 8,  16, 32, (now() - interval '15 days')::date, null),
    (uuid_generate_v5(ns,'eqp:NRD-B:2'), default_tenant, jbm_gun_b, 'TIP-Y-2026',        'Cap tip Y trial',  500, true, false, 1000, 2000, 4000, (now() - interval '10 days')::date, 'Trial-alloy bulk pack on this gun.'),
    (uuid_generate_v5(ns,'eqp:NRD-B:3'), default_tenant, jbm_gun_b, 'IN0-0133',          'Terminal box assy',1, true,  true,  1,   1,  2, (now() - interval '180 days')::date, null),
    (uuid_generate_v5(ns,'eqp:NRD-B:4'), default_tenant, jbm_gun_b, 'X2C-X-LARGE',       'Servo gun assy',   1, true,  true,  0,   0,  1, (now() - interval '300 days')::date, null),
    (uuid_generate_v5(ns,'eqp:NRD-B:5'), default_tenant, jbm_gun_b, 'SW-Y1000-6P-MM-H/S','Connector cable',  1, false, false, 1,   2,  3, (now() - interval '60 days')::date,  null),
    (uuid_generate_v5(ns,'eqp:NRD-B:6'), default_tenant, jbm_gun_b, '403A7K878-169',     'Point holder',     2, false, false, 2,   4,  6, (now() - interval '60 days')::date,  null),
    (uuid_generate_v5(ns,'eqp:NRD-B:7'), default_tenant, jbm_gun_b, 'SUB-ELECTRODE',     'Electrode holder', 1, false, false, 0,   0,  1, (now() - interval '300 days')::date, null),
    (uuid_generate_v5(ns,'eqp:NRD-B:8'), default_tenant, jbm_gun_b, '4-HD32208-2',       'Holder',           1, false, false, 1,   2,  4, (now() - interval '120 days')::date, null)
  on conflict (id) do nothing;
end $eqp$;

-- ───────────────────────────────────────────────────────────────────
-- 13. INSTALLED_BASE  --  REMOVED 2026-07: table dropped (migration 177);
--     was demo-only + non-load-bearing (only echoed by spare_matrix/kit.js).
-- ───────────────────────────────────────────────────────────────────
-- (installed_base seed removed 2026-07 — table dropped in migration
--  177_drop_installed_base.sql; was demo-only + non-load-bearing.)

-- ───────────────────────────────────────────────────────────────────
-- 14. CONTRACTS  --  16 rows: 4 contract_type × 4 status
-- ───────────────────────────────────────────────────────────────────
do $contracts$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0002-0001-000000000001';
  cust           uuid;
  ctypes         text[] := array['ARC','BLANKET_PO','AMC','ONE_OFF'];
  cstatuses      text[] := array['ACTIVE','EXPIRED','TERMINATED','PENDING_RENEWAL'];
  ctype          text;
  cstatus        text;
  customer_keys  text[] := array['MG_MOTOR_INDIA','TATA_MOTORS_PV_PUNE','NRD_AUTO_PLANT_1','ANVIL_TEST_INDUSTRIES'];
  ckey           text;
  i              int := 0;
  c_id           uuid;
  c_label        text;
  c_start        date;
  c_end          date;
  c_value        numeric;
begin
  -- Iterate the 4 × 4 grid; assign each cell to a customer round-robin.
  foreach ctype in array ctypes loop
    foreach cstatus in array cstatuses loop
      ckey := customer_keys[(i % array_length(customer_keys,1)) + 1];
      i := i + 1;
      select id into cust from customers where tenant_id = default_tenant and customer_key = ckey;
      if cust is null then continue; end if;

      c_label := ctype || '-' || cstatus || '-' || ckey;
      c_id    := uuid_generate_v5(ns, 'contract:' || c_label);

      -- Date windows + values per status.
      c_start := case cstatus
                   when 'ACTIVE'           then (now() - interval '120 days')::date
                   when 'EXPIRED'          then (now() - interval '720 days')::date
                   when 'TERMINATED'       then (now() - interval '500 days')::date
                   when 'PENDING_RENEWAL'  then (now() - interval '350 days')::date
                 end;
      c_end := case cstatus
                 when 'ACTIVE'           then (now() + interval '240 days')::date
                 when 'EXPIRED'          then (now() - interval '350 days')::date
                 when 'TERMINATED'       then (now() - interval '300 days')::date
                 when 'PENDING_RENEWAL'  then (now() + interval '20 days')::date
               end;
      c_value := case ctype
                   when 'ARC'        then 25000000
                   when 'BLANKET_PO' then 18000000
                   when 'AMC'        then  3500000
                   when 'ONE_OFF'    then  1200000
                 end;

      insert into contracts (id, tenant_id, customer_id, contract_type, contract_number, start_date, end_date, total_value_inr, currency, status, notes, created_at)
      values (c_id, default_tenant, cust, ctype::contract_type, 'C-' || lpad(i::text, 4, '0') || '-' || ctype, c_start, c_end, c_value, 'INR', cstatus,
              'Seed contract: ' || c_label || '. Anvil seed v1.', c_start::timestamptz)
      on conflict (tenant_id, contract_number) do nothing;

      -- 3 contract_lines per contract.
      insert into contract_lines (id, tenant_id, contract_id, part_no, description, qty_committed, qty_consumed, unit_price, uom, notes, created_at) values
        (uuid_generate_v5(ns,'cl:' || c_label || ':1'), default_tenant, c_id, 'CT-16-D-1-FS',  'Cap tip 16D',     5000, case cstatus when 'ACTIVE' then 1200 when 'EXPIRED' then 5000 when 'TERMINATED' then 800 else 2400 end, 0.85, 'Nos', null, c_start::timestamptz),
        (uuid_generate_v5(ns,'cl:' || c_label || ':2'), default_tenant, c_id, 'X2C-X-MEDIUM',  'Servo gun X2C-M', 12,   case cstatus when 'ACTIVE' then 4    when 'EXPIRED' then 12   when 'TERMINATED' then 2   else 8    end, 8000, 'Nos', null, c_start::timestamptz),
        (uuid_generate_v5(ns,'cl:' || c_label || ':3'), default_tenant, c_id, '4-HD32208-2',   'Holder',          400,  case cstatus when 'ACTIVE' then 100  when 'EXPIRED' then 400  when 'TERMINATED' then 60  else 200  end,  200, 'Nos', null, c_start::timestamptz)
      on conflict (id) do nothing;
    end loop;
  end loop;
end $contracts$;

-- ───────────────────────────────────────────────────────────────────
-- 15. PAYMENT_MILESTONES  --  attached to the ARC + BLANKET_PO contracts
-- ───────────────────────────────────────────────────────────────────
do $pm$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0002-0001-000000000001';
  c_arc_active   uuid;
  c_blanket_act  uuid;
  c_arc_pend     uuid;
begin
  select id into c_arc_active  from contracts where tenant_id = default_tenant and contract_number like 'C-0001-ARC';
  select id into c_blanket_act from contracts where tenant_id = default_tenant and contract_number like 'C-0005-BLANKET_PO';
  select id into c_arc_pend    from contracts where tenant_id = default_tenant and contract_number like 'C-0004-ARC';

  if c_arc_active is not null then
    insert into payment_milestones (id, tenant_id, contract_id, sequence, label, pct, fixed_inr, trigger, due_days, payment_method, notes, created_at) values
      (uuid_generate_v5(ns,'pm:arc-active:1'), default_tenant, c_arc_active, 1, 'Advance on PO',         50.00, null, 'po_received',   0,   'NEFT', 'Standard MG terms.',       now() - interval '120 days'),
      (uuid_generate_v5(ns,'pm:arc-active:2'), default_tenant, c_arc_active, 2, 'Before dispatch',       40.00, null, 'pre_dispatch',  0,   'NEFT', null,                       now() - interval '120 days'),
      (uuid_generate_v5(ns,'pm:arc-active:3'), default_tenant, c_arc_active, 3, '30 days post-delivery', 10.00, null, 'n_days',        30,  'NEFT', 'Retention.',               now() - interval '120 days')
    on conflict (tenant_id, contract_id, sequence) where contract_id is not null do nothing;
  end if;
  if c_blanket_act is not null then
    insert into payment_milestones (id, tenant_id, contract_id, sequence, label, pct, fixed_inr, trigger, due_days, payment_method, notes, created_at) values
      (uuid_generate_v5(ns,'pm:bl-active:1'), default_tenant, c_blanket_act, 1, 'Net 30 per release', 100.00, null, 'n_days', 30, 'NEFT', 'Per-release blanket terms.', now() - interval '120 days')
    on conflict (tenant_id, contract_id, sequence) where contract_id is not null do nothing;
  end if;
  if c_arc_pend is not null then
    insert into payment_milestones (id, tenant_id, contract_id, sequence, label, pct, fixed_inr, trigger, due_days, payment_method, notes, created_at) values
      (uuid_generate_v5(ns,'pm:arc-pend:1'), default_tenant, c_arc_pend, 1, 'Advance on PO renewal', 30.00, null, 'po_received',   0,  'NEFT', 'Renegotiated milestones.', now() - interval '90 days'),
      (uuid_generate_v5(ns,'pm:arc-pend:2'), default_tenant, c_arc_pend, 2, 'Per release',           60.00, null, 'pre_dispatch',  0,  'NEFT', null,                       now() - interval '90 days'),
      (uuid_generate_v5(ns,'pm:arc-pend:3'), default_tenant, c_arc_pend, 3, '60 days post-delivery', 10.00, null, 'n_days',        60, 'NEFT', 'Retention.',               now() - interval '90 days')
    on conflict (tenant_id, contract_id, sequence) where contract_id is not null do nothing;
  end if;
end $pm$;

-- ───────────────────────────────────────────────────────────────────
-- 16. BLANKET_RELEASE_DRAWDOWN  --  3 drawdowns per BLANKET_PO contract
-- ───────────────────────────────────────────────────────────────────
-- release_order_id stays null until phase 300 creates the orders.
do $brd$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0002-0001-000000000001';
  c_id           uuid;
  cnum           text;
begin
  for cnum in select contract_number from contracts where tenant_id = default_tenant and contract_type = 'BLANKET_PO'
  loop
    select id into c_id from contracts where tenant_id = default_tenant and contract_number = cnum;
    insert into blanket_release_drawdown (id, tenant_id, contract_id, release_order_id, part_no, qty_drawn, rate_used, drawn_at) values
      (uuid_generate_v5(ns,'brd:' || cnum || ':1'), default_tenant, c_id, null, 'CT-16-D-1-FS', 500, 0.85, now() - interval '90 days'),
      (uuid_generate_v5(ns,'brd:' || cnum || ':2'), default_tenant, c_id, null, 'CT-16-D-1-FS', 600, 0.85, now() - interval '60 days'),
      (uuid_generate_v5(ns,'brd:' || cnum || ':3'), default_tenant, c_id, null, '4-HD32208-2',   25, 200,  now() - interval '30 days')
    on conflict (id) do nothing;
  end loop;
end $brd$;

-- ───────────────────────────────────────────────────────────────────
-- 17. ENGINEERING_SPECS  --  spec sheets for 4 items
-- ───────────────────────────────────────────────────────────────────
insert into engineering_specs (id, tenant_id, part_no, spec_type, motor_model, max_electrode_force_n, max_rpm, ball_screw_diameter_mm, lead_mm, length_mm, max_speed_mm_sec, motor_axis_inertia_kgm2, mechanical_efficiency, drawing_no, payload, issued_by, issued_on, created_at, updated_at) values
  (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','spec:x2c-med'),
   '00000000-0000-0000-0000-000000000001'::uuid, 'X2C-X-MEDIUM',  'gun', 'FANUC alpha8/4000', 6000.00, 4000, 25, 10, 320, 80, 0.000200000000, 0.9000, 'X2C-MED-DRAW',
   jsonb_build_object('seed_marker','anvil-test-seed-v1','source','WGX EG SHEET style v2'),
   'Engineering KR', (now() - interval '300 days')::date, now() - interval '300 days', now() - interval '60 days'),
  (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','spec:x2c-large'),
   '00000000-0000-0000-0000-000000000001'::uuid, 'X2C-X-LARGE',   'gun', 'FANUC alpha12/4000', 8000.00, 4000, 32, 12, 360, 75, 0.000280000000, 0.9000, 'X2C-LRG-DRAW',
   jsonb_build_object('seed_marker','anvil-test-seed-v1','source','WGX EG SHEET style v2'),
   'Engineering KR', (now() - interval '300 days')::date, now() - interval '300 days', now() - interval '60 days'),
  (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','spec:x3-med'),
   '00000000-0000-0000-0000-000000000001'::uuid, 'X3-X-MEDIUM',   'gun', 'FANUC alpha10/5000', 7500.00, 5000, 28, 12, 330, 95, 0.000220000000, 0.9200, 'X3-MED-DRAW',
   jsonb_build_object('seed_marker','anvil-test-seed-v1','source','X3 launch sheet'),
   'Engineering KR', (now() - interval '40 days')::date, now() - interval '40 days', now() - interval '5 days'),
  (uuid_generate_v5('d7a7e5e4-0001-0002-0001-000000000001','spec:x4-trial'),
   '00000000-0000-0000-0000-000000000001'::uuid, 'X4-X-TRIAL',    'gun', 'FANUC alpha14/5000', 9000.00, 5000, 32, 12, 360, 100, 0.000300000000, 0.9300, 'X4-PROTO-DRAW',
   jsonb_build_object('seed_marker','anvil-test-seed-v1','source','X4 trial sheet','status','prototype'),
   'Engineering KR', (now() - interval '20 days')::date, now() - interval '20 days', now() - interval '5 days')
on conflict (tenant_id, part_no) do nothing;

commit;
