/*
 * 300_workflow_data.sql  --  Phase 3 of the Anvil seed pack.
 *
 * Purpose
 *   The workflow surface. Sales pipeline (leads, opportunities,
 *   projects), internal SOs, the 50-order corpus + every dependent
 *   (documents, evidence, findings, amendments, reconciliations,
 *   schedule lines, communications), source POs (with full event
 *   chains), supplier RFQs, shipments, quote approvals, service
 *   visits + AMC + CAR/closure, spare recommendations + obsolete
 *   parts, einvoices, invoices + payments, AP three-way match,
 *   deductions, Razorpay payments, e-signature envelopes, customer
 *   portal tokens + access log + acceptances + reorders. Per
 *   prompt G10 each seeded order also emits 1-3 processing_events
 *   and 1-4 audit_events so timelines are coherent (phase 400 then
 *   bulks audit_events to >=250).
 *
 * Prerequisites
 *   - Migrations 001..059 applied.
 *   - supabase/seed.sql applied (default tenant + 6 corpus
 *     customers + 35 item_master rows + 11 expense_rate_cards +
 *     3 quote_approval_thresholds via 010).
 *   - 100_users_and_tenants.sql + 200_master_data.sql applied
 *     (auth users for FKs; vendors + contracts for FKs; bom +
 *     equipment + 4 fictional customers).
 *   - Run as service_role with `set app.seed_env = 'staging';`.
 *
 * Idempotency
 *   `on conflict ... do nothing` everywhere. Re-running is a no-op.
 *
 * Deterministic UUID namespace
 *   d7a7e5e4-0001-0003-0001-000000000001
 *
 * Seed marker
 *   `{"seed_marker": "anvil-test-seed-v1"}` merged into every jsonb
 *   payload / metadata / raw column where one exists.
 *
 * Deviations from this prompt
 *   - The matrix asks for orders=50; we generate exactly 50 rows
 *     covering all 10 `order_status` values and all 5 `order_mode`
 *     values (deterministic round-robin), plus a 1-parent + 5-
 *     children blanket-release chain anchored on MG_MOTOR_INDIA's
 *     `OIQTLC-240123` master quote per the cross-link requirement.
 *   - source_pos count is 22 per matrix (10 statuses * ~2 + a few
 *     extras for the supplier-scorecard fan-out).
 *   - audit_events here are just the per-workflow tracers (1-3
 *     per order). Phase 400 bulks the total to >=250.
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
-- 1. LEADS  --  18 rows: 6 lead_status x 3 sources
-- ───────────────────────────────────────────────────────────────────
do $leads$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0003-0001-000000000001';
  alpha          uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:eng.alpha@anvil.test');
  beta           uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:eng.beta@anvil.test');
  charlie        uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:eng.charlie@anvil.test');
  statuses       text[] := array['NEW','CONTACTED','QUALIFIED','CONVERTED','REJECTED','REGRETTED'];
  sources        text[] := array['inbound_web','referral','outbound_outreach'];
  s              text;
  src            text;
  i              int := 0;
  status_i       int := 0;
  src_i          int := 0;
  cust_id        uuid;
  cust_keys      text[] := array['MG_MOTOR_INDIA','TATA_MOTORS_PV_PUNE','JBM_AUTO','RENAULT_NISSAN','ANVIL_TEST_INDUSTRIES','GLOBEX_MFG_GMBH'];
begin
  foreach s in array statuses loop
    status_i := status_i + 1;
    src_i := 0;
    foreach src in array sources loop
      src_i := src_i + 1;
      i := i + 1;
      select id into cust_id from customers where tenant_id = default_tenant and customer_key = cust_keys[((i - 1) % array_length(cust_keys,1)) + 1];

      insert into leads (id, tenant_id, status, company_name, category, lead_source, reliability_score,
                         approval_status, account_id, contact_name, contact_email, contact_phone, designation,
                         product_interest, lead_type, customer_segment, region, budget_estimate, timeline,
                         decision_maker, lost_reason, notes, allocated_to, created_at, converted_at, converted_opportunity_id)
      values (
        uuid_generate_v5(ns, 'lead:' || s || ':' || src),
        default_tenant, s::lead_status,
        case s
          when 'NEW'        then 'Acme New Prospect ' || src_i
          when 'CONTACTED'  then 'Beacon Forge Industries'
          when 'QUALIFIED'  then 'CrestRing Auto Tier-1'
          when 'CONVERTED'  then 'Delta Manufacturing Co'
          when 'REJECTED'   then 'Echo Components Pvt Ltd'
          when 'REGRETTED'  then 'Foxtrot Welding Solutions'
        end || ' ' || src,
        case (i % 3) when 0 then 'Untapped' when 1 then 'New' else 'Existing' end,
        src,
        case (i % 3) when 0 then 'Low' when 1 then 'Medium' else 'High' end,
        case s when 'CONVERTED' then 'APPROVED' when 'REJECTED' then 'REJECTED' else 'PENDING' end,
        cust_id,
        'Contact ' || i,
        'lead.' || lower(s) || '.' || src_i || '@anvil-seed.example',
        '+91 98 0000 ' || lpad(i::text, 4, '0'),
        case (i % 4) when 0 then 'Director' when 1 then 'Procurement Lead' when 2 then 'Plant Manager' else 'Engineer' end,
        case (i % 3) when 0 then 'X2C servo guns' when 1 then 'Cap tip bulk supply' else 'Annual maintenance services' end,
        case (i % 2) when 0 then 'Project' else 'Spare' end,
        case (i % 4) when 0 then 'AUTO_OEM'::customer_type when 1 then 'TIER_ONE'::customer_type when 2 then 'LINE_BUILDER'::customer_type else 'OTHER'::customer_type end,
        case (i % 4) when 0 then 'IN-MH' when 1 then 'IN-GJ' when 2 then 'IN-KA' else 'IN-TN' end,
        case s when 'CONVERTED' then 4500000 when 'QUALIFIED' then 2800000 else 1500000 + i * 50000 end,
        case (i % 3) when 0 then '<3 months' when 1 then '3-6 months' else '6-12 months' end,
        (i % 2) = 0,
        case s when 'REJECTED' then 'PRICE_UNDERCUT' when 'REGRETTED' then 'NO_RESPONSE' else null end,
        'Seed lead row #' || i,
        case (i % 3) when 0 then alpha when 1 then beta else charlie end,
        now() - (i || ' days')::interval,
        case s when 'CONVERTED' then now() - ((i / 2) || ' days')::interval else null end,
        null
      ) on conflict (id) do nothing;
    end loop;
  end loop;
end $leads$;

-- ───────────────────────────────────────────────────────────────────
-- 2. OPPORTUNITIES  --  22 rows: 11 stages x 2
-- ───────────────────────────────────────────────────────────────────
do $opps$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0003-0001-000000000001';
  alpha          uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:eng.alpha@anvil.test');
  beta           uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:eng.beta@anvil.test');
  stages         text[] := array['QUALIFICATION','STRATEGY_CHECK','NEEDS_ANALYSIS','FOLLOW_UP','RFQ',
                                 'INTERNAL_PROPOSAL','PROPOSAL_PRICE_QUOTE','NEGOTIATION_REVIEW',
                                 'CLOSE_WON','CLOSE_LOST','REGRETTED'];
  s              text;
  k              int := 0;
  cust_id        uuid;
  cust_keys      text[] := array['MG_MOTOR_INDIA','TATA_MOTORS_PV_PUNE','JBM_AUTO','RENAULT_NISSAN','ANVIL_TEST_INDUSTRIES','GLOBEX_MFG_GMBH','ACME_ROBOTICS_LLC'];
begin
  foreach s in array stages loop
    -- two opportunities per stage (different customers).
    for variant in 1..2 loop
      k := k + 1;
      select id into cust_id from customers where tenant_id = default_tenant and customer_key = cust_keys[((k - 1) % array_length(cust_keys,1)) + 1];
      if cust_id is null then continue; end if;

      insert into opportunities (id, tenant_id, customer_id, opportunity_name, stage, order_mode, amount_inr,
                                 amount_currency, amount_native, fx_rate_used, close_date, probability,
                                 product_summary, lost_reason, competitor_name, owner_id, created_at, updated_at)
      values (
        uuid_generate_v5(ns, 'opp:' || s || ':' || variant::text),
        default_tenant, cust_id,
        s || ' opportunity #' || variant::text,
        s::opportunity_stage,
        case (k % 5) when 0 then 'SPARES'::order_mode when 1 then 'SPARES_ASSEMBLY'::order_mode when 2 then 'PROJECT_FOR'::order_mode when 3 then 'PROJECT_HSS'::order_mode else 'INTERNAL'::order_mode end,
        case s
          when 'CLOSE_WON' then 6500000
          when 'CLOSE_LOST' then 0
          when 'REGRETTED' then 0
          when 'NEGOTIATION_REVIEW' then 5800000
          when 'PROPOSAL_PRICE_QUOTE' then 5200000
          else 1200000 + k * 150000
        end,
        case (k % 3) when 0 then 'INR' when 1 then 'USD' else 'EUR' end,
        case (k % 3) when 1 then 70000 when 2 then 60000 else null end,
        case (k % 3) when 1 then 83.20 when 2 then 90.10 else null end,
        case s when 'CLOSE_WON' then (now() - interval '20 days')::date when 'CLOSE_LOST' then (now() - interval '40 days')::date when 'REGRETTED' then (now() - interval '60 days')::date else (now() + interval '45 days')::date end,
        case s when 'QUALIFICATION' then 10 when 'STRATEGY_CHECK' then 20 when 'NEEDS_ANALYSIS' then 30 when 'FOLLOW_UP' then 35 when 'RFQ' then 50 when 'INTERNAL_PROPOSAL' then 55 when 'PROPOSAL_PRICE_QUOTE' then 65 when 'NEGOTIATION_REVIEW' then 80 when 'CLOSE_WON' then 100 else 0 end,
        'X2C servo gun + spares bundle (seed opp #' || k::text || ')',
        case s when 'CLOSE_LOST' then 'PRICE_UNDERCUT' when 'REGRETTED' then 'NO_RESPONSE' else null end,
        case s when 'CLOSE_LOST' then 'Competitor X' else null end,
        case (k % 2) when 0 then alpha else beta end,
        now() - ((30 + k) || ' days')::interval,
        now() - ((k) || ' days')::interval
      ) on conflict (id) do nothing;
    end loop;
  end loop;
end $opps$;

-- Link CONVERTED leads back to opportunities (3 minimum per matrix
-- cross-module link requirements).
do $linkleads$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0003-0001-000000000001';
  i              int;
  l_id           uuid;
  o_id           uuid;
  src_idx        int;
  src_keys       text[] := array['inbound_web','referral','outbound_outreach'];
begin
  for i in 1..3 loop
    src_idx := ((i - 1) % 3) + 1;
    select id into l_id from leads where id = uuid_generate_v5(ns, 'lead:CONVERTED:' || src_keys[src_idx]);
    select id into o_id from opportunities where id = uuid_generate_v5(ns, 'opp:CLOSE_WON:1');
    if l_id is not null and o_id is not null then
      update leads set converted_opportunity_id = o_id where id = l_id;
    end if;
  end loop;
end $linkleads$;

-- ───────────────────────────────────────────────────────────────────
-- 3. PROJECTS + project_phase_log  --  15 projects (one per phase)
-- ───────────────────────────────────────────────────────────────────
do $projects$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0003-0001-000000000001';
  phases         text[] := array['INITIAL_INFO','STRATEGY','PROMOTIONAL','RFQ_PREP','BUDGETARY_QUOTATION',
                                 'PRICE_NEGOTIATION','LB_FINALIZATION','KICKOFF','DESIGN','APPROVAL_PROCESSING',
                                 'MANUFACTURING','SHIPPING','INSTALLATION_COMMISSIONING','PAYMENT_FOLLOWUP','CLOSED'];
  p              text;
  k              int := 0;
  cust_id        uuid;
  cust_keys      text[] := array['MG_MOTOR_INDIA','TATA_MOTORS_PV_PUNE','JBM_AUTO','RENAULT_NISSAN','ANVIL_TEST_INDUSTRIES'];
  proj_id        uuid;
  alpha          uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:eng.alpha@anvil.test');
begin
  foreach p in array phases loop
    k := k + 1;
    select id into cust_id from customers where tenant_id = default_tenant and customer_key = cust_keys[((k - 1) % array_length(cust_keys,1)) + 1];
    if cust_id is null then continue; end if;

    proj_id := uuid_generate_v5(ns, 'proj:' || p);
    insert into projects (id, tenant_id, project_code, project_name, customer_id, customer_segment,
                          end_user, total_value_inr, currency, current_phase, budgeted_design_mandays,
                          budgeted_install_mandays, budgeted_travel_mandays, budgeted_warranty_pct,
                          shipping_mode, status, created_at, updated_at)
    values (
      proj_id, default_tenant, 'PRJ-' || lpad(k::text, 4, '0'),
      'Project ' || k::text || ': ' || p,
      cust_id,
      case (k % 4) when 0 then 'AUTO_OEM'::customer_type when 1 then 'TIER_ONE'::customer_type when 2 then 'LINE_BUILDER'::customer_type else 'OTHER'::customer_type end,
      'End-user line for project ' || k::text,
      8000000 + k * 200000, 'INR', p::project_phase,
      30, 20, 12, 0.025,
      case (k % 4) when 0 then 'SEA'::shipment_mode when 1 then 'AIR'::shipment_mode when 2 then 'ROAD'::shipment_mode else 'COURIER'::shipment_mode end,
      case p when 'CLOSED' then 'COMPLETED' when 'PAYMENT_FOLLOWUP' then 'ON_HOLD' else 'ACTIVE' end,
      now() - ((30 + k * 10) || ' days')::interval, now() - (k || ' days')::interval
    ) on conflict (tenant_id, project_code) do nothing;

    -- 3 historical phase log rows + 1 current.
    insert into project_phase_log (id, tenant_id, project_id, phase, started_at, completed_at, responsible_user, progress_pct, remarks)
    values
      (uuid_generate_v5(ns,'pphl:' || p || ':1'), default_tenant, proj_id, 'INITIAL_INFO',     now() - ((40 + k * 10) || ' days')::interval, now() - ((30 + k * 10) || ' days')::interval, alpha, 100, 'Kickoff complete.'),
      (uuid_generate_v5(ns,'pphl:' || p || ':2'), default_tenant, proj_id, 'STRATEGY',          now() - ((30 + k * 10) || ' days')::interval, now() - ((20 + k * 10) || ' days')::interval, alpha, 100, 'Strategy locked.'),
      (uuid_generate_v5(ns,'pphl:' || p || ':3'), default_tenant, proj_id, 'RFQ_PREP',          now() - ((20 + k * 10) || ' days')::interval, now() - ((10 + k * 10) || ' days')::interval, alpha, 100, 'RFQ sent.'),
      (uuid_generate_v5(ns,'pphl:' || p || ':4'), default_tenant, proj_id, p::project_phase,    now() - (k * 10 || ' days')::interval,        case p when 'CLOSED' then now() else null end, alpha,
       case p when 'CLOSED' then 100 else 60 end, 'Current phase: ' || p)
    on conflict (id) do nothing;
  end loop;
end $projects$;

-- ───────────────────────────────────────────────────────────────────
-- 4. INTERNAL_SALES_ORDERS  --  every iso_type x every status (selected combos)
-- ───────────────────────────────────────────────────────────────────
do $iso$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0003-0001-000000000001';
  ops_alpha      uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:ops.alpha@anvil.test');
  primary_admin  uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:admin.primary@anvil.test');
  types          text[] := array['FOC_SUPPLY','WARRANTY_REPLACEMENT','PRODUCT_TRIAL','EXPECTED_PO','INTERNAL_TRANSFER'];
  statuses       text[] := array['DRAFT','PENDING_APPROVAL','APPROVED','DISPATCHED','CLOSED','CANCELLED'];
  t              text;
  s              text;
  k              int := 0;
  cust_id        uuid;
  cust_keys      text[] := array['MG_MOTOR_INDIA','TATA_MOTORS_PV_PUNE','JBM_AUTO','RENAULT_NISSAN'];
  iso_id         uuid;
begin
  foreach t in array types loop
    foreach s in array statuses loop
      k := k + 1;
      select id into cust_id from customers where tenant_id = default_tenant and customer_key = cust_keys[((k - 1) % array_length(cust_keys,1)) + 1];

      iso_id := uuid_generate_v5(ns, 'iso:' || t || ':' || s);
      insert into internal_sales_orders (id, tenant_id, iso_type, iso_number, purpose, requested_person,
                                          requested_date, customer_id, vendor_name, material_requirement,
                                          required_date, approximate_cost_inr, billing_instruction, estimated_life,
                                          warranty_reference, expected_po_reference, trial_outcome, from_store, to_store,
                                          status, approved_by, approved_at, payload, created_at)
      values (
        iso_id, default_tenant, t::internal_so_type, 'ISO-' || lpad(k::text, 4, '0'),
        case t when 'FOC_SUPPLY' then 'Free-of-charge replacement under warranty.'
               when 'WARRANTY_REPLACEMENT' then 'Warranty replacement.'
               when 'PRODUCT_TRIAL' then 'Trial deployment of new alloy tip.'
               when 'EXPECTED_PO' then 'Supply against expected customer PO.'
               when 'INTERNAL_TRANSFER' then 'Inter-store transfer.' end,
        'Operations Lead', (now() - (k || ' days')::interval)::date,
        cust_id, null,
        case t when 'INTERNAL_TRANSFER' then 'Stock transfer (5x cap tips, 1x holder)' else 'Spare set per service ticket' end,
        (now() + interval '14 days')::date,
        case t when 'FOC_SUPPLY' then 0 when 'WARRANTY_REPLACEMENT' then 80000 when 'PRODUCT_TRIAL' then 120000 when 'EXPECTED_PO' then 200000 else 50000 end,
        case t when 'FOC_SUPPLY' then 'No charge to customer.' else 'Bill at internal cost.' end,
        case t when 'PRODUCT_TRIAL' then '6 months' else null end,
        case t when 'WARRANTY_REPLACEMENT' then 'OB-SO-1234' else null end,
        case t when 'EXPECTED_PO' then 'Awaiting MG PO 5100002700' else null end,
        case t when 'PRODUCT_TRIAL' then 'In progress' else null end,
        case t when 'INTERNAL_TRANSFER' then 'Halol Store' else null end,
        case t when 'INTERNAL_TRANSFER' then 'Pune Store' else null end,
        s,
        case s when 'APPROVED' then primary_admin when 'DISPATCHED' then primary_admin when 'CLOSED' then primary_admin else null end,
        case s when 'APPROVED' then now() - interval '5 days' when 'DISPATCHED' then now() - interval '4 days' when 'CLOSED' then now() - interval '3 days' else null end,
        jsonb_build_object('seed_marker','anvil-test-seed-v1'),
        now() - (k || ' days')::interval
      ) on conflict (tenant_id, iso_number) do nothing;

      -- 2 lines per ISO.
      insert into internal_so_lines (id, tenant_id, internal_so_id, part_no, description, qty, uom, estimated_cost, notes) values
        (uuid_generate_v5(ns,'isol:' || t || ':' || s || ':1'), default_tenant, iso_id, 'CT-16-D-1-FS', 'Cap tip 16D', 100, 'Nos', 85, null),
        (uuid_generate_v5(ns,'isol:' || t || ':' || s || ':2'), default_tenant, iso_id, '4-HD32208-2',   'Holder',       2, 'Nos', 200, null)
      on conflict (id) do nothing;
    end loop;
  end loop;
end $iso$;

-- ───────────────────────────────────────────────────────────────────
-- 5. ORDERS  --  50 rows: full status x mode coverage
-- ───────────────────────────────────────────────────────────────────
-- We construct 50 deterministic order rows. The first batch covers
-- every (status, mode) cell for the 10 statuses x 5 modes = 50
-- baseline. Then we override 5 of those slots with a 1-parent +
-- 5-children blanket-release chain anchored on MG_MOTOR_INDIA's
-- master quote `OIQTLC-240123` (the contract row for that already
-- exists in 200 as a BLANKET_PO contract).
do $orders$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0003-0001-000000000001';
  alpha          uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:eng.alpha@anvil.test');
  primary_admin  uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:admin.primary@anvil.test');
  statuses       text[] := array['DRAFT','PENDING_REVIEW','APPROVED','BLOCKED','DUPLICATE','REUSED','EXPORTED_TO_TALLY','FAILED_TALLY_IMPORT','RECONCILED','CANCELLED'];
  modes          text[] := array['SPARES','SPARES_ASSEMBLY','PROJECT_FOR','PROJECT_HSS','INTERNAL'];
  s              text;
  m              text;
  status_idx     int := 0;
  mode_idx       int;
  cust_id        uuid;
  loc_id         uuid;
  cust_keys      text[] := array['MG_MOTOR_INDIA','TATA_MOTORS_PV_PUNE','JBM_AUTO','RENAULT_NISSAN','ABC_MOTORS','SRTX','ANVIL_TEST_INDUSTRIES','GLOBEX_MFG_GMBH','ACME_ROBOTICS_LLC','NIPPON_KOGYO'];
  ckey           text;
  k              int := 0;
  o_id           uuid;
  contract_id    uuid;
  blanket_parent uuid;
  c_blanket_act  uuid;
begin
  -- Resolve the BLANKET_PO ACTIVE contract from 200 to attach
  -- 6 of the 50 orders to it (1 parent + 5 children).
  select id into c_blanket_act from contracts where tenant_id = default_tenant and contract_number = 'C-0005-BLANKET_PO';

  -- Generate 50 orders.
  foreach s in array statuses loop
    status_idx := status_idx + 1;
    mode_idx := 0;
    foreach m in array modes loop
      mode_idx := mode_idx + 1;
      k := k + 1;

      -- Pick a customer + location round-robin.
      ckey := cust_keys[((k - 1) % array_length(cust_keys, 1)) + 1];
      select id into cust_id from customers where tenant_id = default_tenant and customer_key = ckey;
      select id into loc_id from customer_locations where tenant_id = default_tenant and customer_id = cust_id and is_default = true limit 1;

      -- Slot 1 (DRAFT/SPARES) is the blanket-release parent.
      -- Slots 2..6 (PENDING_REVIEW/SPARES through APPROVED/SPARES_ASSEMBLY)
      -- are the 5 children with parent_order_id pointing at the parent.
      o_id := uuid_generate_v5(ns, 'order:' || s || ':' || m);

      contract_id := case
                       when k between 1 and 6 then c_blanket_act
                       when k % 8 = 0 then (select id from contracts where tenant_id = default_tenant and contract_number = 'C-0001-ARC')
                       when k % 8 = 4 then (select id from contracts where tenant_id = default_tenant and contract_number = 'C-0009-AMC')
                       else null
                     end;

      blanket_parent := case when k between 2 and 6 then uuid_generate_v5(ns, 'order:DRAFT:SPARES') else null end;

      -- Cast contract_id assignment back through the orders.contract_id FK
      -- defined by 006 (ALTER TABLE orders ADD CONSTRAINT orders_contract_fk).
      -- The orders table also gained columns parent_order_id, contract_id,
      -- order_mode, customer_location_id from migrations 005+006.
      insert into orders (
        id, tenant_id, customer_id, status, po_number, po_date, quote_number, quote_date,
        doc_fingerprint, result, preflight_payload, api_usage, cost_policy_snapshot,
        token_estimate, rule_findings, anomaly_flags, evidence_by_field, line_edits,
        approval, payload_hash, approved_at, approved_by, blocker_summary,
        format_change_summary, cost_avoided_reason, created_at, updated_at,
        order_mode, parent_order_id, customer_location_id, contract_id,
        tally_status, approval_expires_at, approval_actions
      ) values (
        o_id, default_tenant, cust_id, s::order_status,
        case
          when k = 1 then 'OIQTLC-240123-MG-CONSUMABLES'
          when k between 2 and 6 then '5100002' || lpad((500 + k)::text, 3, '0')
          else 'PO-' || lpad(k::text, 6, '0')
        end,
        (now() - ((50 - k) || ' days')::interval)::date,
        case when k = 1 then 'OIQTLC-240123' else 'QT-' || lpad(k::text, 6, '0') end,
        (now() - ((50 - k + 5) || ' days')::interval)::date,
        encode(digest('order:' || s || ':' || m, 'sha256'), 'hex'),
        jsonb_build_object('salesOrder', jsonb_build_object('total_inr', 250000 + k * 5000, 'incoterms', 'FOR'), 'seed_marker','anvil-test-seed-v1'),
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        '[]'::jsonb, '[]'::jsonb, jsonb_build_object('seed_marker','anvil-test-seed-v1'), '[]'::jsonb,
        case s when 'APPROVED' then jsonb_build_object('decision','APPROVED','seed_marker','anvil-test-seed-v1') when 'BLOCKED' then jsonb_build_object('decision','BLOCKED','reasons',jsonb_build_array('margin_below_floor','missing_evidence')) else null end,
        encode(digest('payload-hash:' || k::text, 'sha256'), 'hex'),
        case when s in ('APPROVED','EXPORTED_TO_TALLY','RECONCILED') then now() - interval '4 days' else null end,
        case when s in ('APPROVED','EXPORTED_TO_TALLY','RECONCILED') then primary_admin else null end,
        case s when 'BLOCKED' then 'Margin below floor; missing supplier ack evidence.' else null end,
        case when k % 7 = 0 then 'PO layout flipped; re-extracted with fallback profile.' else null end,
        case s when 'CANCELLED' then 'Customer withdrew before approval.' else null end,
        now() - ((50 - k) || ' days')::interval, now() - (k || ' hours')::interval,
        m::order_mode, blanket_parent, loc_id, contract_id,
        case s when 'EXPORTED_TO_TALLY' then 'exported' when 'FAILED_TALLY_IMPORT' then 'failed' when 'RECONCILED' then 'reconciled' when 'PENDING_REVIEW' then 'pending' else 'idle' end,
        case s when 'PENDING_REVIEW' then now() + interval '4 hours' else null end,
        array['notify_sales','dispatch_to_supplier']
      ) on conflict (id) do nothing;
    end loop;
  end loop;
end $orders$;

-- ───────────────────────────────────────────────────────────────────
-- 6. ORDER FAN-OUT  --  documents, evidence, findings, amendments,
--    reconciliations, schedule_lines, communications, processing,
--    audit (1-3 events per order so timelines are coherent)
-- ───────────────────────────────────────────────────────────────────
do $fanout$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0003-0001-000000000001';
  primary_admin  uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:admin.primary@anvil.test');
  rec            record;
  doc_po         uuid;
  doc_quote      uuid;
  doc_attach     uuid;
begin
  for rec in select id, status::text as status, po_number, customer_id, created_at from orders
             where id in (select uuid_generate_v5(ns, 'order:' || s || ':' || m)
                          from unnest(array['DRAFT','PENDING_REVIEW','APPROVED','BLOCKED','DUPLICATE','REUSED','EXPORTED_TO_TALLY','FAILED_TALLY_IMPORT','RECONCILED','CANCELLED']) s
                          cross join unnest(array['SPARES','SPARES_ASSEMBLY','PROJECT_FOR','PROJECT_HSS','INTERNAL']) m)
  loop
    -- 1 PO + 1 Quote document + 1 attachment per non-DRAFT order.
    doc_po    := uuid_generate_v5(ns, 'doc:po:' || rec.id::text);
    doc_quote := uuid_generate_v5(ns, 'doc:quote:' || rec.id::text);
    doc_attach:= uuid_generate_v5(ns, 'doc:attach:' || rec.id::text);

    if rec.status <> 'DRAFT' then
      insert into documents (id, tenant_id, storage_bucket, storage_path, filename, mime_type, size_bytes, sha256, classification, metadata, created_at, scan_status)
      values
        (doc_po,    default_tenant, 'obara-documents', 'documents/seed/po/'    || rec.po_number || '.pdf',    rec.po_number || '.pdf',    'application/pdf', 320000, encode(digest(rec.po_number,'sha256'),'hex'),    'purchase_order',     jsonb_build_object('seed_marker','anvil-test-seed-v1'), rec.created_at, 'clean'),
        (doc_quote, default_tenant, 'obara-documents', 'documents/seed/quote/' || rec.po_number || '.pdf',    'QT-' || rec.po_number || '.pdf', 'application/pdf', 280000, encode(digest('quote:'||rec.po_number,'sha256'),'hex'), 'quote',              jsonb_build_object('seed_marker','anvil-test-seed-v1'), rec.created_at, 'clean'),
        (doc_attach,default_tenant, 'obara-documents', 'documents/seed/attach/'|| rec.po_number || '.pdf',    'ATT-' || rec.po_number || '.pdf',  'application/pdf', 95000,  encode(digest('att:'||rec.po_number,'sha256'),'hex'),  'attachment',         jsonb_build_object('seed_marker','anvil-test-seed-v1'), rec.created_at, 'clean')
      on conflict (id) do nothing;

      insert into order_documents (order_id, document_id, role) values
        (rec.id, doc_po,     'purchase_order'),
        (rec.id, doc_quote,  'quote'),
        (rec.id, doc_attach, 'attachment')
      on conflict (order_id, document_id) do nothing;

      -- 3 evidence rows per non-DRAFT order (lines[0].partNumber, lines[0].qty, salesOrder.incoterms).
      insert into evidence (id, tenant_id, order_id, field_path, value, document_id, page_number, bbox, snippet, extraction_method, confidence, validator_status, created_at) values
        (uuid_generate_v5(ns,'ev:' || rec.id::text || ':1'), default_tenant, rec.id, 'lines[0].partNumber', 'CT-16-D-1-FS',     doc_po, 1, jsonb_build_object('x',120,'y',180,'w',60,'h',16), 'CT-16-D-1-FS', 'pdf_text', 0.980, 'ok', rec.created_at),
        (uuid_generate_v5(ns,'ev:' || rec.id::text || ':2'), default_tenant, rec.id, 'lines[0].qty',        '500',              doc_po, 1, jsonb_build_object('x',300,'y',180,'w',40,'h',16), '500',          'pdf_text', 0.960, 'ok', rec.created_at),
        (uuid_generate_v5(ns,'ev:' || rec.id::text || ':3'), default_tenant, rec.id, 'salesOrder.incoterms','FOR Pune',         doc_po, 1, jsonb_build_object('x',120,'y',420,'w',80,'h',14), 'FOR Pune',     'rules',    0.900, 'ok', rec.created_at)
      on conflict (id) do nothing;
    end if;

    -- BLOCKED orders: 3 unresolved findings + extra evidence.
    if rec.status = 'BLOCKED' then
      insert into validation_findings (id, tenant_id, order_id, rule_id, code, severity, owner, blocks, line_index, detail, suggested_fix, resolved, created_at) values
        (uuid_generate_v5(ns,'vf:' || rec.id::text || ':1'), default_tenant, rec.id, 'rule.margin.floor',   'MARGIN_BELOW_FLOOR', 'high', 'sales_manager', true, null, 'Quote margin 4.2% below 10% floor.',     'Re-quote at floor, route through finance.', false, rec.created_at),
        (uuid_generate_v5(ns,'vf:' || rec.id::text || ':2'), default_tenant, rec.id, 'rule.evidence.miss',  'MISSING_EVIDENCE',   'med',  'sales_engineer', true, 0,    'No supplier ack evidence on line 0.',     'Attach supplier ack PDF.',                 false, rec.created_at),
        (uuid_generate_v5(ns,'vf:' || rec.id::text || ':3'), default_tenant, rec.id, 'rule.lead.gap',       'LEAD_TIME_GAP',      'med',  'procurement',    true, 0,    'Customer required date earlier than supplier ETA.', 'Negotiate ETA or alternate supplier.', false, rec.created_at)
      on conflict (id) do nothing;
    elsif rec.status in ('APPROVED','RECONCILED','EXPORTED_TO_TALLY') then
      insert into validation_findings (id, tenant_id, order_id, rule_id, code, severity, owner, blocks, line_index, detail, suggested_fix, resolved, resolved_at, resolved_by, created_at) values
        (uuid_generate_v5(ns,'vf:' || rec.id::text || ':r1'), default_tenant, rec.id, 'rule.margin.floor', 'MARGIN_OK', 'info', 'sales_manager', false, null, 'Margin within tolerance.', 'No action.', true, rec.created_at + interval '1 hour', primary_admin, rec.created_at)
      on conflict (id) do nothing;
    end if;

    -- 1 amendment per RECONCILED order (3 amendments total when including BLOCKED's mixed type).
    if rec.status = 'RECONCILED' then
      insert into order_amendments (id, tenant_id, parent_order_id, revised_order_id, diff, amendment_type, status, notes, created_at) values
        (uuid_generate_v5(ns,'oa:' || rec.id::text || ':1'), default_tenant, rec.id, null, jsonb_build_object('lines[0].qty',jsonb_build_object('from',500,'to',520),'seed_marker','anvil-test-seed-v1'), 'qty',   'applied',  'Customer increased qty 500 -> 520.', rec.created_at + interval '1 day')
      on conflict (id) do nothing;
    end if;
    if rec.status = 'BLOCKED' then
      insert into order_amendments (id, tenant_id, parent_order_id, revised_order_id, diff, amendment_type, status, notes, created_at) values
        (uuid_generate_v5(ns,'oa:' || rec.id::text || ':d'), default_tenant, rec.id, null, jsonb_build_object('lines[0].price',jsonb_build_object('from',0.85,'to',0.92),'seed_marker','anvil-test-seed-v1'), 'price', 'detected', 'Price drift detected vs prior PO.', rec.created_at + interval '1 day'),
        (uuid_generate_v5(ns,'oa:' || rec.id::text || ':a'), default_tenant, rec.id, null, jsonb_build_object('lines[0].date',jsonb_build_object('from','2026-04-01','to','2026-05-01'),'seed_marker','anvil-test-seed-v1'), 'date',  'approved', 'Date amendment approved.', rec.created_at + interval '2 day'),
        (uuid_generate_v5(ns,'oa:' || rec.id::text || ':r'), default_tenant, rec.id, null, jsonb_build_object('lines[1]',jsonb_build_object('removed',true),'seed_marker','anvil-test-seed-v1'),               'line_removed', 'rejected', 'Line removal rejected; customer reinstated.', rec.created_at + interval '3 day')
      on conflict (id) do nothing;
    end if;

    -- 1 reconciliation per RECONCILED order.
    if rec.status = 'RECONCILED' then
      insert into order_reconciliations (id, tenant_id, order_id, source_type, source_id, vendor_id, match_status, total_lines, matching_lines, mismatched_lines, discrepancies, decided_by, decided_at, decision, raw, created_at)
      values
        (uuid_generate_v5(ns,'recon:' || rec.id::text), default_tenant, rec.id, 'pdf', doc_po::text, null,
         'match', 3, 3, 0, '[]'::jsonb, primary_admin, rec.created_at + interval '4 hours', 'accept',
         jsonb_build_object('seed_marker','anvil-test-seed-v1'), rec.created_at + interval '4 hours')
      on conflict (id) do nothing;
    end if;

    -- 3 schedule lines for orders with SPARES_ASSEMBLY mode (mode_hint='blanket' surrogate).
    if rec.po_number like '5100002%' then
      insert into order_schedule_lines (id, tenant_id, order_id, line_index, part_no, scheduled_qty, scheduled_date, delivery_location, remark, source_document_id, created_at) values
        (uuid_generate_v5(ns,'osl:' || rec.id::text || ':1'), default_tenant, rec.id, 0, 'CT-16-D-1-FS', 200, (now() + interval '7 days')::date,  'MG Halol', null, doc_po, rec.created_at),
        (uuid_generate_v5(ns,'osl:' || rec.id::text || ':2'), default_tenant, rec.id, 1, 'CT-16-D-1-FS', 200, (now() + interval '14 days')::date, 'MG Halol', null, doc_po, rec.created_at),
        (uuid_generate_v5(ns,'osl:' || rec.id::text || ':3'), default_tenant, rec.id, 2, 'CT-16-D-1-FS', 100, (now() + interval '21 days')::date, 'MG Halol', null, doc_po, rec.created_at)
      on conflict (id) do nothing;
    end if;

    -- 1 communication per APPROVED order.
    if rec.status = 'APPROVED' then
      insert into communications (id, tenant_id, order_id, source_po_id, direction, channel, thread_id, from_addr, to_addr, subject, body, status, template_code, attachments, metadata, sent_at, created_at) values
        (uuid_generate_v5(ns,'comm:' || rec.id::text), default_tenant, rec.id, null, 'outbound', 'email', 'thread:' || rec.id::text, 'sales@anvil-seed.test', 'buyer@customer.example', 'Order ' || rec.po_number || ' approved', 'Your purchase order has been approved.', 'sent', 'order_approved', '[]'::jsonb, jsonb_build_object('seed_marker','anvil-test-seed-v1'), rec.created_at + interval '2 hours', rec.created_at + interval '2 hours')
      on conflict (id) do nothing;
    end if;

    -- 1 OCR run + 1 zip scan + 1 extraction run per non-DRAFT order.
    if rec.status <> 'DRAFT' then
      insert into ocr_runs (id, tenant_id, document_id, provider, status, page_count, evidence_count, started_at, completed_at, raw) values
        (uuid_generate_v5(ns,'ocr:' || rec.id::text), default_tenant, doc_po, 'mistral', case rec.status when 'BLOCKED' then 'failed' else 'completed' end, 2, 3, rec.created_at, rec.created_at + interval '20 seconds', jsonb_build_object('seed_marker','anvil-test-seed-v1'))
      on conflict (id) do nothing;

      insert into zip_scans (id, tenant_id, document_id, status, file_count, total_size_bytes, threats, inner_files, completed_at) values
        (uuid_generate_v5(ns,'zs:' || rec.id::text), default_tenant, doc_attach, 'clean', 1, 95000, '[]'::jsonb, jsonb_build_array(jsonb_build_object('name','attachment.pdf','size',95000)), rec.created_at)
      on conflict (id) do nothing;

      insert into extraction_runs (id, tenant_id, customer_id, source_type, source_id, source_url, source_filename, source_size_bytes, adapter_used, adapter_attempts, raw_extract, normalized_extract, field_confidences, confidence_overall, status, error, started_at, finished_at, triggered_by, inbound_email_id) values
        (uuid_generate_v5(ns,'er:' || rec.id::text), default_tenant, rec.customer_id, 'pdf', doc_po::text, 'documents/seed/po/' || rec.po_number || '.pdf', rec.po_number || '.pdf', 320000, 'reducto', '[]'::jsonb, jsonb_build_object('seed_marker','anvil-test-seed-v1'), jsonb_build_object('seed_marker','anvil-test-seed-v1'), jsonb_build_object('lines[0].partNumber',0.98,'lines[0].qty',0.96), 0.950, case rec.status when 'BLOCKED' then 'low_confidence' else 'ok' end, null, rec.created_at, rec.created_at + interval '15 seconds', primary_admin, null)
      on conflict (id) do nothing;
    end if;

    -- 2 processing_events per order (ingest + extract).
    insert into processing_events (tenant_id, case_id, event_type, object_type, object_id, detail, duration_ms, created_at) values
      (default_tenant, 'case:' || rec.id::text, 'ingest', 'order', rec.id::text, jsonb_build_object('seed_marker','anvil-test-seed-v1'), 320, rec.created_at),
      (default_tenant, 'case:' || rec.id::text, 'extract','order', rec.id::text, jsonb_build_object('seed_marker','anvil-test-seed-v1'), 1450, rec.created_at + interval '1 second');

    -- 1-2 audit_events per order.
    insert into audit_events (tenant_id, actor, actor_role, action, object_type, object_id, after_payload, payload_hash, reason, detail, created_at) values
      (default_tenant, primary_admin, 'admin', 'order.created', 'order', rec.id::text, jsonb_build_object('status', rec.status, 'seed_marker','anvil-test-seed-v1'), encode(digest(rec.id::text,'sha256'),'hex'), 'seed', 'phase300:order.created', rec.created_at);
    if rec.status in ('APPROVED','EXPORTED_TO_TALLY','RECONCILED') then
      insert into audit_events (tenant_id, actor, actor_role, action, object_type, object_id, after_payload, payload_hash, reason, detail, created_at) values
        (default_tenant, primary_admin, 'admin', 'order.approved', 'order', rec.id::text, jsonb_build_object('seed_marker','anvil-test-seed-v1'), encode(digest('approved:'||rec.id::text,'sha256'),'hex'), 'seed', 'phase300:order.approved', rec.created_at + interval '4 hours');
    end if;
  end loop;
end $fanout$;

-- ───────────────────────────────────────────────────────────────────
-- 7. SOURCE_POS  --  22 rows: 10 source_po_status x 2 + 2 extras
-- ───────────────────────────────────────────────────────────────────
do $spos$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0003-0001-000000000001';
  primary_admin  uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:admin.primary@anvil.test');
  prc_alpha      uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:prc.alpha@anvil.test');
  statuses       text[] := array['DRAFT','PENDING_INTERNAL_APPROVAL','SENT_TO_SUPPLIER','SUPPLIER_ACK','PRICE_CHANGED','ETA_CONFIRMED','DELAYED','RECEIVED','CLOSED','CANCELLED'];
  s              text;
  k              int := 0;
  spo_id         uuid;
  ord_id         uuid;
  suppliers      text[] := array['Obara Korea','Obara Japan','Obara China','BKS Cables Pvt Ltd'];
  countries      text[] := array['KR','JP','CN','IN'];
  currencies     text[] := array['USD','JPY','CNY','INR'];
begin
  foreach s in array statuses loop
    for variant in 1..2 loop
      k := k + 1;
      -- Attach to a non-DRAFT, non-INTERNAL order. Pick deterministically.
      select uuid_generate_v5(ns, 'order:' || statuses[((k - 1) % array_length(statuses,1)) + 1] || ':SPARES') into ord_id;

      spo_id := uuid_generate_v5(ns, 'spo:' || s || ':' || variant::text);
      insert into source_pos (id, tenant_id, order_id, reference, supplier, country, currency,
                              exchange_rate, total_foreign, total_inr, total_landed_inr, status,
                              acknowledged_price, acknowledged_eta, payload, created_at, updated_at,
                              ack_received_at, ack_payload, price_variance_pct, eta_variance_days)
      values (
        spo_id, default_tenant, ord_id, 'SPO-' || lpad(k::text, 5, '0'),
        suppliers[((k - 1) % array_length(suppliers,1)) + 1],
        countries[((k - 1) % array_length(countries,1)) + 1],
        currencies[((k - 1) % array_length(currencies,1)) + 1],
        case when (k % 4) = 0 then 1.0 when (k % 4) = 1 then 83.20 when (k % 4) = 2 then 0.555 else 11.50 end,
        100000, 8000000, 8500000, s::source_po_status,
        case s when 'PRICE_CHANGED' then 0.92 else 0.85 end,
        case s when 'DELAYED' then (now() + interval '21 days')::date else (now() + interval '14 days')::date end,
        jsonb_build_object('seed_marker','anvil-test-seed-v1','reference','SPO-' || lpad(k::text,5,'0')),
        now() - ((40 - k) || ' days')::interval, now() - (k || ' hours')::interval,
        case s when 'SUPPLIER_ACK' then now() - interval '4 days' when 'PRICE_CHANGED' then now() - interval '3 days' when 'ETA_CONFIRMED' then now() - interval '2 days' when 'DELAYED' then now() - interval '1 day' else null end,
        case s when 'SUPPLIER_ACK' then jsonb_build_object('ack_payload',true,'seed_marker','anvil-test-seed-v1') else null end,
        case s when 'PRICE_CHANGED' then 8.20 else 0 end,
        case s when 'DELAYED' then 21 else 0 end
      ) on conflict (id) do nothing;

      -- Full event chain: DRAFT -> PENDING -> SENT -> ACK at minimum.
      insert into source_po_events (id, tenant_id, source_po_id, from_status, to_status, detail, actor, created_at) values
        (uuid_generate_v5(ns,'spoe:' || s || ':' || variant::text || ':1'), default_tenant, spo_id, null,                             'DRAFT'::source_po_status,                      'Created.',         prc_alpha, now() - ((40 - k) || ' days')::interval),
        (uuid_generate_v5(ns,'spoe:' || s || ':' || variant::text || ':2'), default_tenant, spo_id, 'DRAFT'::source_po_status,        'PENDING_INTERNAL_APPROVAL'::source_po_status,  'Submitted.',       prc_alpha, now() - ((38 - k) || ' days')::interval),
        (uuid_generate_v5(ns,'spoe:' || s || ':' || variant::text || ':3'), default_tenant, spo_id, 'PENDING_INTERNAL_APPROVAL'::source_po_status, 'SENT_TO_SUPPLIER'::source_po_status,  'Approved + sent.', primary_admin, now() - ((36 - k) || ' days')::interval),
        (uuid_generate_v5(ns,'spoe:' || s || ':' || variant::text || ':4'), default_tenant, spo_id, 'SENT_TO_SUPPLIER'::source_po_status, 'SUPPLIER_ACK'::source_po_status,             'Supplier ack.',    null,        now() - ((34 - k) || ' days')::interval)
      on conflict (id) do nothing;
    end loop;
  end loop;
end $spos$;

-- ───────────────────────────────────────────────────────────────────
-- 8. SUPPLIER_SCORECARDS, RFQs, INVITATIONS, QUOTES
-- ───────────────────────────────────────────────────────────────────
do $rfqs$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0003-0001-000000000001';
  prc_alpha      uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:prc.alpha@anvil.test');
  v_rec          record;
  rfq_statuses   text[] := array['draft','sent','quoting','awarded','closed'];
  rfq_status     text;
  i              int := 0;
  rfq_id         uuid;
  inv_id         uuid;
  ord_id         uuid;
begin
  -- Supplier scorecards (one per active vendor, 6 rows).
  for v_rec in select id, vendor_name from vendors where tenant_id = default_tenant and active = true loop
    insert into supplier_scorecards (id, tenant_id, supplier, country, on_time_pct, price_accuracy_pct, response_time_hours, total_acks, variance_count, last_updated)
    values (uuid_generate_v5(ns,'ss:' || v_rec.vendor_name), default_tenant, v_rec.vendor_name, 'IN', 92.50, 96.40, 6.5, 42, 3, now() - interval '2 days')
    on conflict (tenant_id, supplier) do nothing;
  end loop;

  -- 5 RFQs covering different statuses.
  foreach rfq_status in array rfq_statuses loop
    i := i + 1;
    select uuid_generate_v5(ns, 'order:APPROVED:SPARES') into ord_id;
    rfq_id := uuid_generate_v5(ns, 'rfq:' || rfq_status);

    insert into supplier_rfqs (id, tenant_id, source_order_id, rfq_number, status, due_at, notes, created_by, created_at, updated_at)
    values (rfq_id, default_tenant, ord_id, 'RFQ-' || lpad(i::text,4,'0'), rfq_status, now() + interval '14 days', 'Seed RFQ ' || i::text, prc_alpha, now() - ((10 + i) || ' days')::interval, now() - (i || ' days')::interval)
    on conflict (id) do nothing;

    -- 3 RFQ lines per RFQ.
    insert into supplier_rfq_lines (id, tenant_id, rfq_id, line_no, item_id, part_number, description, quantity, uom, spec, target_price, awarded_invitation_id) values
      (uuid_generate_v5(ns,'rfql:' || rfq_status || ':1'), default_tenant, rfq_id, 1, null, 'CT-16-D-1-FS', 'Cap tip 16D',     500,  'Nos', null,  0.85, null),
      (uuid_generate_v5(ns,'rfql:' || rfq_status || ':2'), default_tenant, rfq_id, 2, null, '4-HD32208-2',   'Holder',           20,  'Nos', null,  200,  null),
      (uuid_generate_v5(ns,'rfql:' || rfq_status || ':3'), default_tenant, rfq_id, 3, null, 'X2C-X-MEDIUM',  'Servo gun',        2,   'Nos', null,  8000, null)
    on conflict (id) do nothing;

    -- 3 invitations per RFQ + 2 quotes per invitation.
    for v_rec in (select id, vendor_name from vendors where tenant_id = default_tenant and active = true limit 3) loop
      inv_id := uuid_generate_v5(ns, 'rfqi:' || rfq_status || ':' || v_rec.vendor_name);
      insert into supplier_rfq_invitations (id, tenant_id, rfq_id, vendor_id, email_to, sent_at, reminder_count, response_status, created_at)
      values (inv_id, default_tenant, rfq_id, v_rec.id, lower(replace(v_rec.vendor_name,' ','.'))||'@vendor.example', now() - ((9 + i) || ' days')::interval, 1,
              case rfq_status when 'draft' then 'pending' when 'sent' then 'pending' when 'quoting' then 'pending' when 'awarded' then 'quoted' else 'quoted' end,
              now() - ((9 + i) || ' days')::interval)
      on conflict (id) do nothing;

      if rfq_status in ('quoting','awarded','closed') then
        insert into supplier_quotes (id, tenant_id, invitation_id, rfq_id, vendor_id, line_no, unit_price, lead_time_days, currency, validity_days, notes, raw, received_at) values
          (uuid_generate_v5(ns,'sq:' || rfq_status || ':' || v_rec.vendor_name || ':1'), default_tenant, inv_id, rfq_id, v_rec.id, 1, 0.83, 21, 'USD', 30, 'Seed quote line 1', jsonb_build_object('seed_marker','anvil-test-seed-v1'), now() - ((6 + i) || ' days')::interval),
          (uuid_generate_v5(ns,'sq:' || rfq_status || ':' || v_rec.vendor_name || ':2'), default_tenant, inv_id, rfq_id, v_rec.id, 2, 195,  21, 'USD', 30, 'Seed quote line 2', jsonb_build_object('seed_marker','anvil-test-seed-v1'), now() - ((6 + i) || ' days')::interval)
        on conflict (id) do nothing;
      end if;
    end loop;
  end loop;
end $rfqs$;

-- ───────────────────────────────────────────────────────────────────
-- 9. SHIPMENTS  --  18 rows: 8 statuses x ~2 + cross-link variants
-- ───────────────────────────────────────────────────────────────────
do $ship$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0003-0001-000000000001';
  statuses       text[] := array['PLANNED','READY','IN_TRANSIT','AT_PORT','CLEARED','DELIVERED','POD_RECEIVED','EXCEPTION'];
  modes          text[] := array['SEA','AIR','ROAD','COURIER'];
  s              text;
  k              int := 0;
  ord_id         uuid;
  spo_id         uuid;
  iso_id         uuid;
begin
  foreach s in array statuses loop
    for variant in 1..2 loop
      k := k + 1;
      ord_id := uuid_generate_v5(ns, 'order:' || statuses[((k - 1) % 8) + 1] || ':' || modes[((k - 1) % 4) + 1]);
      spo_id := case (k % 3) when 0 then uuid_generate_v5(ns, 'spo:SUPPLIER_ACK:1') else null end;
      iso_id := case (k % 5) when 0 then uuid_generate_v5(ns, 'iso:WARRANTY_REPLACEMENT:DISPATCHED') else null end;

      insert into shipments (id, tenant_id, order_id, source_po_id, internal_so_id, shipment_number,
                             mode, carrier, vessel_or_flight, shipper_invoice_no, ready_date,
                             port_of_loading, port_of_discharge, vessel_sailing_date, port_arrival_date,
                             warehouse_receipt_date, customer_delivery_date, pod_received,
                             status, remarks, created_at, updated_at)
      values (
        uuid_generate_v5(ns, 'ship:' || s || ':' || variant::text),
        default_tenant, ord_id, spo_id, iso_id,
        'SH-' || lpad(k::text,5,'0'),
        modes[((k - 1) % 4) + 1]::shipment_mode,
        case (k % 4) when 0 then 'Maersk' when 1 then 'Hapag-Lloyd' when 2 then 'IndiGo Cargo' else 'DHL Express' end,
        case (k % 4) when 0 then 'MAEU-1234' when 1 then 'HX-2628Y' when 2 then '6E-401' else 'DHL-AIRWAY-9988' end,
        'INV-SUP-' || lpad(k::text,5,'0'),
        (now() - ((10 + k) || ' days')::interval)::date,
        case (k % 4) when 0 then 'KRPUS' when 1 then 'JPYOK' when 2 then 'CNSHA' else 'INNSA' end,
        'INNSA',
        (now() - ((8 + k) || ' days')::interval)::date,
        case s when 'AT_PORT' then (now() - interval '2 days')::date when 'CLEARED' then (now() - interval '1 day')::date when 'DELIVERED' then (now() - interval '4 days')::date when 'POD_RECEIVED' then (now() - interval '5 days')::date else null end,
        case s when 'DELIVERED' then now()::date when 'POD_RECEIVED' then (now() - interval '1 day')::date else null end,
        case s when 'DELIVERED' then now()::date when 'POD_RECEIVED' then (now() - interval '1 day')::date else null end,
        s = 'POD_RECEIVED',
        s,
        case s when 'EXCEPTION' then 'Customs hold; awaiting clearance.' else null end,
        now() - ((10 + k) || ' days')::interval, now() - (k || ' hours')::interval
      ) on conflict (id) do nothing;
    end loop;
  end loop;
end $ship$;

-- ───────────────────────────────────────────────────────────────────
-- 10. QUOTE_APPROVALS  --  every status x 2; PENDING -> orders in PENDING_REVIEW
-- ───────────────────────────────────────────────────────────────────
do $qa$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0003-0001-000000000001';
  primary_admin  uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:admin.primary@anvil.test');
  mgr            uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:mgr.alpha@anvil.test');
  fin            uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:fin.alpha@anvil.test');
  statuses       text[] := array['PENDING','APPROVED','REJECTED','SKIPPED'];
  s              text;
  k              int := 0;
  ord_id         uuid;
  pending_modes  text[] := array['SPARES','SPARES_ASSEMBLY'];
  approved_modes text[] := array['PROJECT_FOR','PROJECT_HSS'];
  m              text;
begin
  foreach s in array statuses loop
    -- Two approvals per status, each on a real order.
    for variant in 1..2 loop
      k := k + 1;
      m := case s
             when 'PENDING' then pending_modes[variant]
             when 'APPROVED' then approved_modes[variant]
             else (case variant when 1 then 'INTERNAL' else 'SPARES' end)
           end;
      ord_id := uuid_generate_v5(ns, 'order:' || (case s when 'PENDING' then 'PENDING_REVIEW' when 'APPROVED' then 'APPROVED' when 'REJECTED' then 'BLOCKED' else 'CANCELLED' end) || ':' || m);

      insert into quote_approvals (id, tenant_id, order_id, approver_role, approver_user, status, comments, decided_at, created_at)
      values (
        uuid_generate_v5(ns, 'qa:' || s || ':' || variant::text),
        default_tenant, ord_id,
        case (k % 3) when 0 then 'sales_manager'::obara_role when 1 then 'finance'::obara_role else 'admin'::obara_role end,
        case (k % 3) when 0 then mgr when 1 then fin else primary_admin end,
        s,
        case s when 'PENDING' then null when 'APPROVED' then 'Approved.' when 'REJECTED' then 'Margin below floor.' else 'Skipped: under threshold.' end,
        case s when 'PENDING' then null else now() - interval '4 hours' end,
        now() - ((5 + k) || ' days')::interval
      ) on conflict (id) do nothing;
    end loop;
  end loop;
end $qa$;

-- ───────────────────────────────────────────────────────────────────
-- 11. SERVICE_VISITS, AMC_SCHEDULES, CAR_REPORTS, CLOSURE_REPORTS,
--     SPARE_RECOMMENDATIONS, OBSOLETE_PARTS
-- ───────────────────────────────────────────────────────────────────
do $service$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0003-0001-000000000001';
  ops_alpha      uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:ops.alpha@anvil.test');
  alpha          uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:eng.alpha@anvil.test');
  primary_admin  uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:admin.primary@anvil.test');
  sv_statuses    text[] := array['PLANNED','CHECKED_IN','CHECKED_OUT','REPORT_SUBMITTED','CLOSED'];
  amc_statuses   text[] := array['SCHEDULED','VISIT_CREATED','COMPLETED','SKIPPED','CANCELLED'];
  amc_visit_types text[] := array['PREVENTIVE','EMERGENCY','TRAINING','AUDIT'];
  car_statuses   text[] := array['OPEN','UNDER_REVIEW','CLOSED','REOPENED'];
  s              text;
  k              int := 0;
  mg_id          uuid; tata_id uuid; jbm_id uuid;
  mg_loc         uuid; tata_loc uuid;
  amc_contract   uuid;
  visit_id       uuid;
  car_id_open    uuid;
  car_id_closed  uuid;
  car_id_review  uuid;
begin
  select id into mg_id   from customers where tenant_id = default_tenant and customer_key = 'MG_MOTOR_INDIA';
  select id into tata_id from customers where tenant_id = default_tenant and customer_key = 'TATA_MOTORS_PV_PUNE';
  select id into jbm_id  from customers where tenant_id = default_tenant and customer_key = 'JBM_AUTO';
  select id into mg_loc   from customer_locations where tenant_id = default_tenant and customer_id = mg_id   and location_code = 'HALOL';
  select id into tata_loc from customer_locations where tenant_id = default_tenant and customer_id = tata_id and location_code = 'PUNE';
  -- Pick an AMC contract attached to MG.
  select id into amc_contract from contracts where tenant_id = default_tenant and contract_number = 'C-0009-AMC';

  -- 12 service visits = 5 statuses * 2 visit_types + 2 extras.
  k := 0;
  foreach s in array sv_statuses loop
    for variant in 1..2 loop
      k := k + 1;
      visit_id := uuid_generate_v5(ns, 'sv:' || s || ':' || variant::text);
      insert into service_visits (id, tenant_id, customer_id, customer_location_id, visit_date, line_or_station,
                                  purpose, observation, possible_cause, action_taken, followup_action,
                                  check_in_at, check_out_at, field_engineer, status, notes, created_at)
      values (
        visit_id, default_tenant,
        case (k % 3) when 0 then mg_id when 1 then tata_id else jbm_id end,
        case (k % 3) when 0 then mg_loc when 1 then tata_loc else null end,
        (now() - (k || ' days')::interval)::date,
        'BIW Line A / Station S' || lpad(k::text, 2, '0'),
        case variant when 1 then 'Preventive maintenance' else 'Emergency response' end,
        'Tip wear above threshold; cooling line restricted.',
        'Wear pattern from prolonged duty cycle.',
        'Tip replaced; cooling jacket flushed.',
        'Schedule next preventive in 30 days.',
        case s when 'CHECKED_IN' then now() - interval '2 hours' when 'CHECKED_OUT' then now() - interval '1 day' when 'REPORT_SUBMITTED' then now() - interval '2 days' when 'CLOSED' then now() - interval '5 days' else null end,
        case s when 'CHECKED_OUT' then now() - interval '1 day' + interval '4 hours' when 'REPORT_SUBMITTED' then now() - interval '2 days' + interval '4 hours' when 'CLOSED' then now() - interval '5 days' + interval '4 hours' else null end,
        alpha, s, null, now() - ((k + 5) || ' days')::interval
      ) on conflict (id) do nothing;
    end loop;
  end loop;

  -- 10 AMC schedules + link 3 SCHEDULED to a generated visit (matrix link req).
  k := 0;
  foreach s in array amc_statuses loop
    for v in 1..2 loop
      k := k + 1;
      insert into amc_schedules (id, tenant_id, contract_id, customer_id, customer_location_id,
                                  visit_label, scheduled_date, duration_days, visit_type, status,
                                  generated_visit_id, generated_at, remarks, created_at)
      values (
        uuid_generate_v5(ns,'amc:' || s || ':' || v::text),
        default_tenant, amc_contract, mg_id, mg_loc,
        amc_visit_types[((k - 1) % array_length(amc_visit_types,1)) + 1] || ' ' || s,
        (now() + ((k * 7) || ' days')::interval)::date,
        2, amc_visit_types[((k - 1) % array_length(amc_visit_types,1)) + 1],
        s,
        case when s = 'VISIT_CREATED' or s = 'COMPLETED' then uuid_generate_v5(ns,'sv:CLOSED:1') else null end,
        case when s = 'VISIT_CREATED' or s = 'COMPLETED' then now() - interval '1 day' else null end,
        case s when 'SKIPPED' then 'Customer requested skip.' when 'CANCELLED' then 'Contract cancelled.' else null end,
        now() - ((30 + k) || ' days')::interval
      ) on conflict (id) do nothing;
    end loop;
  end loop;

  -- 8 CAR reports = 4 statuses * 2 + one with five_why_analysis.
  k := 0;
  foreach s in array car_statuses loop
    for v in 1..2 loop
      k := k + 1;
      insert into car_reports (id, tenant_id, customer_id, original_po_no, original_so_no, part_no,
                               qty_rejected, root_cause, five_why_analysis, temporary_countermeasure,
                               permanent_countermeasure, analysis_date, prepared_by, status, created_at)
      values (
        uuid_generate_v5(ns,'car:' || s || ':' || v::text),
        default_tenant, mg_id, '5100002515', 'OB-SO-' || lpad(k::text,4,'0'), 'CT-16-D-1-FS', 12,
        'Tip wear above threshold; supplier alloy variance.',
        case when v = 1 then jsonb_build_object('why1','Worn faster than expected','why2','Alloy hardness outside spec','why3','Supplier change','why4','New batch','why5','QA alert missed','seed_marker','anvil-test-seed-v1') else null end,
        'Replaced batch; tightened QA hold.',
        case s when 'CLOSED' then 'Supplier returned to original alloy spec; QA hold added.' else null end,
        (now() - (k || ' days')::interval)::date,
        alpha, s,
        now() - ((k + 5) || ' days')::interval
      ) on conflict (id) do nothing;
    end loop;
  end loop;

  -- 5 closure reports linked to >=2 distinct CARs.
  select uuid_generate_v5(ns,'car:CLOSED:1') into car_id_closed;
  select uuid_generate_v5(ns,'car:CLOSED:2') into car_id_review;
  select uuid_generate_v5(ns,'car:OPEN:1')   into car_id_open;

  insert into closure_reports (id, tenant_id, car_report_id, customer_id, issue_date, equipment_part_no,
                                investigation, root_cause, temporary_countermeasure, permanent_countermeasure,
                                closed_at, signed_off_by, created_at) values
    (uuid_generate_v5(ns,'cl:1'), default_tenant, car_id_closed, mg_id, (now() - interval '20 days')::date, 'CT-16-D-1-FS',
     'Field investigation confirmed alloy variance.', 'Supplier alloy variance.', 'Replaced batch.', 'QA hold added.',
     now() - interval '15 days', primary_admin, now() - interval '15 days'),
    (uuid_generate_v5(ns,'cl:2'), default_tenant, car_id_closed, mg_id, (now() - interval '18 days')::date, '4-HD32208-2',
     'Holder fatigue investigation.', 'Stress fracture from misalignment.', 'Replaced + retorqued.', 'Updated install procedure.',
     now() - interval '14 days', primary_admin, now() - interval '14 days'),
    (uuid_generate_v5(ns,'cl:3'), default_tenant, car_id_review, mg_id, (now() - interval '12 days')::date, 'CT-16-D-1-FS',
     'Recurrence after batch swap.', 'Inadequate inspection cadence.', 'Inspect every shift change.', null,
     null, null, now() - interval '12 days'),
    (uuid_generate_v5(ns,'cl:4'), default_tenant, car_id_open,   tata_id,(now() - interval '8 days')::date,  'X2C-X-MEDIUM',
     'Investigation pending supplier RCA.', null, null, null, null, null, now() - interval '8 days'),
    (uuid_generate_v5(ns,'cl:5'), default_tenant, null,          tata_id,(now() - interval '4 days')::date,  'IN0-0133',
     'Standalone closure (no parent CAR).', 'Not applicable.', null, null, now() - interval '3 days', primary_admin, now() - interval '4 days')
  on conflict (id) do nothing;

  -- spare_recommendations: 6 rows.
  insert into spare_recommendations (tenant_id, part_no, customer_id, criticality_score, recommended_qty, reason, computed_at) values
    (default_tenant, 'CT-16-D-1-FS', mg_id,   95.5, 1500, jsonb_build_object('reason','high_consumption','seed_marker','anvil-test-seed-v1'), now() - interval '2 days'),
    (default_tenant, '4-HD32208-2',  mg_id,   78.0,   30, jsonb_build_object('reason','holder_fatigue_recent','seed_marker','anvil-test-seed-v1'), now() - interval '2 days'),
    (default_tenant, 'IN0-0133',     mg_id,   88.5,    8, jsonb_build_object('reason','critical_emergency_only','seed_marker','anvil-test-seed-v1'), now() - interval '2 days'),
    (default_tenant, 'CT-16-D-1-FS', tata_id, 92.0, 1200, jsonb_build_object('reason','high_consumption','seed_marker','anvil-test-seed-v1'), now() - interval '2 days'),
    (default_tenant, 'X2C-X-MEDIUM', jbm_id,  70.0,    2, jsonb_build_object('reason','installed_base_size','seed_marker','anvil-test-seed-v1'), now() - interval '2 days'),
    (default_tenant, 'TIP-Y-2026',   jbm_id,  60.0, 1000, jsonb_build_object('reason','trial_alloy_uptake','seed_marker','anvil-test-seed-v1'), now() - interval '2 days')
  on conflict (tenant_id, part_no, customer_id) do nothing;

  -- obsolete_parts: 4 rows.
  insert into obsolete_parts (tenant_id, part_no, last_seen_in_so, last_seen_in_bom, replacement_part_no, notes) values
    (default_tenant, 'LEGACY-TIP-100',    (now() - interval '300 days')::date, (now() - interval '300 days')::date, 'CT-16-D-1-FS',  'Phased out; replaced by 16D.'),
    (default_tenant, 'LEGACY-GUN-200',    (now() - interval '400 days')::date, (now() - interval '500 days')::date, 'X2C-X-MEDIUM',  'Replaced by X2C series.'),
    (default_tenant, 'LEGACY-CABLE-300',  (now() - interval '350 days')::date, (now() - interval '350 days')::date, 'CABLE-Y-2026',  'UV-stable replacement.'),
    (default_tenant, 'DISC-TIMER-100',    (now() - interval '120 days')::date, (now() - interval '120 days')::date, 'TIMER-Y-TRIAL', 'Vendor stopped manufacturing.')
  on conflict (tenant_id, part_no) do nothing;
end $service$;

-- ───────────────────────────────────────────────────────────────────
-- 12. EINVOICES  --  every einvoice_status x 1
-- ───────────────────────────────────────────────────────────────────
do $ein$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0003-0001-000000000001';
  statuses       text[] := array['DRAFT','PENDING_GSTN','GENERATED','CANCELLED','REJECTED'];
  s              text;
  k              int := 0;
  cust_id        uuid;
  ord_id         uuid;
begin
  select id into cust_id from customers where tenant_id = default_tenant and customer_key = 'MG_MOTOR_INDIA';
  foreach s in array statuses loop
    k := k + 1;
    -- Every einvoice references an APPROVED / RECONCILED order.
    ord_id := uuid_generate_v5(ns, 'order:' || (case when k % 2 = 0 then 'APPROVED' else 'RECONCILED' end) || ':SPARES');

    insert into einvoices (id, tenant_id, order_id, invoice_number, invoice_date, customer_id, customer_gstin,
                           seller_gstin, taxable_value, total_value, currency, status, irn, ack_no, ack_date,
                           qr_code_b64, signed_invoice_b64, ewb_no, ewb_valid_upto, cancel_reason, cancel_remarks,
                           cancelled_at, payload, response, created_at, updated_at)
    values (
      uuid_generate_v5(ns,'ein:' || s),
      default_tenant, ord_id,
      'EI-' || lpad(k::text,5,'0'),
      (now() - (k || ' days')::interval)::date,
      cust_id, '24AAKCM8110E1ZR', '27AAACI0000A1Z5',
      250000, 295000, 'INR', s::einvoice_status,
      case s when 'GENERATED' then encode(digest('irn:'||k::text,'sha256'),'hex') || encode(digest('irn-suffix:'||k::text,'sha256'),'hex') else null end,
      case s when 'GENERATED' then '11200' || lpad(k::text,8,'0') else null end,
      case s when 'GENERATED' then now() - interval '1 day' else null end,
      case s when 'GENERATED' then encode(digest('qr:'||k::text,'sha256'),'base64') else null end,
      case s when 'GENERATED' then encode(digest('signed:'||k::text,'sha256'),'base64') else null end,
      case s when 'GENERATED' then 'EWB' || lpad(k::text,10,'0') else null end,
      case s when 'GENERATED' then now() + interval '7 days' else null end,
      case s when 'CANCELLED' then 'duplicate' when 'REJECTED' then 'validation_error' else null end,
      case s when 'CANCELLED' then 'Cancelled within 24h.' when 'REJECTED' then 'GSTN: invalid customer GSTIN.' else null end,
      case s when 'CANCELLED' then now() - interval '4 hours' else null end,
      jsonb_build_object('seed_marker','anvil-test-seed-v1'),
      jsonb_build_object('seed_marker','anvil-test-seed-v1'),
      now() - ((k + 1) || ' days')::interval, now() - (k || ' hours')::interval
    ) on conflict (tenant_id, invoice_number) do nothing;
  end loop;
end $ein$;

-- ───────────────────────────────────────────────────────────────────
-- 13. INVOICES + invoice_number_sequences + payment_records + AP + deduction_queue + razorpay
-- ───────────────────────────────────────────────────────────────────
-- 13a. invoice_number_sequences (1 per tenant)
insert into invoice_number_sequences (tenant_id, next_number, prefix, format, updated_at)
values ('00000000-0000-0000-0000-000000000001', 13, 'INV', '{prefix}-{number:04}', now() - interval '1 day')
on conflict (tenant_id) do nothing;

-- 13b. invoices: 12 rows mix paid/partial/overdue/voided/draft/sent
do $inv$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0003-0001-000000000001';
  fin_alpha      uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:fin.alpha@anvil.test');
  k              int;
  inv_id         uuid;
  cust_id        uuid;
  ord_id         uuid;
  status_cycle   text[] := array['draft','sent','partial','paid','paid','paid','overdue','overdue','void','sent','partial','paid'];
  s              text;
  total          numeric;
  paid           numeric;
begin
  select id into cust_id from customers where tenant_id = default_tenant and customer_key = 'ANVIL_TEST_INDUSTRIES';
  for k in 1..12 loop
    s := status_cycle[k];
    total := 250000 + k * 10000;
    paid  := case s when 'paid' then total when 'partial' then total / 2 else 0 end;
    ord_id := uuid_generate_v5(ns, 'order:' || (case k % 4 when 0 then 'APPROVED' when 1 then 'RECONCILED' when 2 then 'EXPORTED_TO_TALLY' else 'APPROVED' end) || ':SPARES');
    inv_id := uuid_generate_v5(ns,'inv:' || k::text);

    insert into invoices (id, tenant_id, order_id, customer_id, invoice_number, invoice_format, issue_date,
                          due_date, currency, subtotal, tax_total, grand_total, paid_amount, status,
                          payment_terms, notes, line_items, sent_at, paid_at, voided_at, created_by, created_at, updated_at)
    values (
      inv_id, default_tenant, ord_id, cust_id,
      'INV-' || lpad(k::text,4,'0'), '{prefix}-{number:04}',
      (now() - ((30 - k) || ' days')::interval)::date,
      (now() + ((30 - k) || ' days')::interval)::date,
      'INR',
      total - 45000, 45000, total, paid, s,
      'Net 30 days', 'Seed invoice ' || k::text,
      jsonb_build_array(jsonb_build_object('part_no','CT-16-D-1-FS','qty',500,'rate',0.85,'extended',425), jsonb_build_object('seed_marker','anvil-test-seed-v1')),
      case when s in ('sent','partial','paid','overdue','void') then now() - ((28 - k) || ' days')::interval else null end,
      case when s = 'paid' then now() - ((10 - k) || ' days')::interval else null end,
      case when s = 'void' then now() - interval '5 days' else null end,
      fin_alpha, now() - ((30 - k) || ' days')::interval, now() - (k || ' hours')::interval
    ) on conflict (id) do nothing;

    -- 1 payment_records row per paid invoice.
    if s = 'paid' then
      insert into payment_records (id, tenant_id, invoice_id, amount, currency, method, stripe_charge_id, stripe_payment_intent_id, paid_at, raw, created_at)
      values (
        uuid_generate_v5(ns,'pay:' || k::text),
        default_tenant, inv_id, total, 'INR', 'stripe',
        'ch_seed_' || lpad(k::text,6,'0'), 'pi_seed_' || lpad(k::text,6,'0'),
        now() - ((10 - k) || ' days')::interval,
        jsonb_build_object('seed_marker','anvil-test-seed-v1'),
        now() - ((10 - k) || ' days')::interval
      ) on conflict (tenant_id, stripe_payment_intent_id) do nothing;
    end if;
    -- Razorpay variant for one paid invoice.
    if s = 'paid' and k = 4 then
      insert into payment_records (id, tenant_id, invoice_id, amount, currency, method, stripe_payment_intent_id, paid_at, raw, created_at)
      values (uuid_generate_v5(ns,'pay:rzp:' || k::text), default_tenant, inv_id, total, 'INR', 'razorpay', 'razorpay:pay_seed_' || lpad(k::text,6,'0'), now() - interval '6 days', jsonb_build_object('seed_marker','anvil-test-seed-v1'), now() - interval '6 days')
      on conflict (tenant_id, stripe_payment_intent_id) do nothing;
    end if;
  end loop;
end $inv$;

-- 13c. AP three-way match: 6 invoices (2 matched, 1 qty-mismatch, 1 price-mismatch, 1 pending, 1 disputed)
do $ap$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0003-0001-000000000001';
  vid            uuid;
  spo_id         uuid;
  ap_id          uuid;
  patterns       text[] := array['matched','matched','mismatched','mismatched','pending','disputed'];
  p              text;
  k              int := 0;
begin
  select id into vid from vendors where tenant_id = default_tenant and vendor_name = 'Obara Korea Co. Ltd.';
  spo_id := uuid_generate_v5(ns, 'spo:SUPPLIER_ACK:1');

  foreach p in array patterns loop
    k := k + 1;
    ap_id := uuid_generate_v5(ns,'ap:' || k::text);
    insert into ap_invoices (id, tenant_id, vendor_id, vendor_invoice_number, invoice_date, due_date, currency,
                              subtotal, tax_total, grand_total, amount_paid, source_po_id,
                              match_status, match_score, match_details, raw, created_at, updated_at)
    values (
      ap_id, default_tenant, vid, 'VINV-' || lpad(k::text,5,'0'),
      (now() - ((20 - k * 2) || ' days')::interval)::date,
      (now() + ((20 - k * 2) || ' days')::interval)::date,
      'USD', 8000, 0, 8000, case p when 'matched' then 8000 else 0 end,
      spo_id, p, case p when 'matched' then 99.0 when 'mismatched' then 70.0 else null end,
      jsonb_build_object('seed_marker','anvil-test-seed-v1','pattern',p),
      jsonb_build_object('seed_marker','anvil-test-seed-v1'),
      now() - ((20 - k * 2) || ' days')::interval,
      now() - (k || ' hours')::interval
    ) on conflict (tenant_id, vendor_invoice_number) do nothing;

    -- 2 lines per AP invoice.
    insert into ap_invoice_lines (id, tenant_id, ap_invoice_id, line_no, description, quantity, unit_price, extended, po_line_ref) values
      (uuid_generate_v5(ns,'apl:' || k::text || ':1'), default_tenant, ap_id, 1, 'CT-16-D-1-FS bulk', case p when 'mismatched' then 480 else 500 end, 0.85, case p when 'mismatched' then 408 else 425 end, 'PO-LINE-1'),
      (uuid_generate_v5(ns,'apl:' || k::text || ':2'), default_tenant, ap_id, 2, '4-HD32208-2',         20,   case p when 'mismatched' then 220  else 200 end, case p when 'mismatched' then 4400 else 4000 end, 'PO-LINE-2')
    on conflict (id) do nothing;
  end loop;

  -- 4 goods_receipts (one per matched / mismatched + pending).
  insert into ap_goods_receipts (id, tenant_id, source_po_id, receipt_number, received_at, lines, raw, created_at) values
    (uuid_generate_v5(ns,'gr:1'), default_tenant, spo_id, 'GR-001', now() - interval '15 days', jsonb_build_array(jsonb_build_object('part_no','CT-16-D-1-FS','received',500),jsonb_build_object('part_no','4-HD32208-2','received',20)), jsonb_build_object('seed_marker','anvil-test-seed-v1'), now() - interval '15 days'),
    (uuid_generate_v5(ns,'gr:2'), default_tenant, spo_id, 'GR-002', now() - interval '14 days', jsonb_build_array(jsonb_build_object('part_no','CT-16-D-1-FS','received',500),jsonb_build_object('part_no','4-HD32208-2','received',20)), jsonb_build_object('seed_marker','anvil-test-seed-v1'), now() - interval '14 days'),
    (uuid_generate_v5(ns,'gr:3'), default_tenant, spo_id, 'GR-003', now() - interval '8 days',  jsonb_build_array(jsonb_build_object('part_no','CT-16-D-1-FS','received',480),jsonb_build_object('part_no','4-HD32208-2','received',20)), jsonb_build_object('seed_marker','anvil-test-seed-v1'), now() - interval '8 days'),
    (uuid_generate_v5(ns,'gr:4'), default_tenant, spo_id, 'GR-004', now() - interval '4 days',  jsonb_build_array(jsonb_build_object('part_no','CT-16-D-1-FS','received',500),jsonb_build_object('part_no','4-HD32208-2','received',20)), jsonb_build_object('seed_marker','anvil-test-seed-v1'), now() - interval '4 days')
  on conflict (id) do nothing;
end $ap$;

-- 13d. deduction_queue: open / resolved (recovered) / written-off
do $ded$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0003-0001-000000000001';
  fin            uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:fin.alpha@anvil.test');
begin
  insert into deduction_queue (id, tenant_id, invoice_id, customer_id, expected_amount, paid_amount, short_amount, reason_guess, status, notes, flagged_at, resolved_at, resolved_by) values
    (uuid_generate_v5(ns,'ded:1'), default_tenant, uuid_generate_v5(ns,'inv:3'), null, 280000, 220000, 60000, 'short_pay_disputed_qty', 'open',         'Customer disputes one line.',                    now() - interval '5 days',  null,                    null),
    (uuid_generate_v5(ns,'ded:2'), default_tenant, uuid_generate_v5(ns,'inv:11'),null, 360000, 350000, 10000, 'small_short_pay',         'recovered',    'Recovered after follow-up.',                     now() - interval '20 days', now() - interval '14 days', fin),
    (uuid_generate_v5(ns,'ded:3'), default_tenant, uuid_generate_v5(ns,'inv:7'), null, 320000, 280000, 40000, 'damage_claim',            'written_off',  'Written off; goodwill credit.',                  now() - interval '90 days', now() - interval '70 days', fin)
  on conflict (id) do nothing;
end $ded$;

-- 13e. razorpay_payments: 8 covering all 5 statuses (created/authorized/captured/refunded/failed)
do $rzp$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0003-0001-000000000001';
  inv_id         uuid;
  statuses       text[] := array['created','authorized','captured','captured','captured','refunded','failed','captured'];
  s              text;
  k              int := 0;
begin
  foreach s in array statuses loop
    k := k + 1;
    select uuid_generate_v5(ns,'inv:' || ((k % 12) + 1)::text) into inv_id;
    insert into razorpay_payments (id, tenant_id, invoice_id, razorpay_order_id, razorpay_payment_id, razorpay_signature, amount, currency, status, method, email, contact, raw, created_at, updated_at)
    values (
      uuid_generate_v5(ns,'rzp:' || k::text),
      default_tenant, inv_id,
      'order_seed_' || lpad(k::text,8,'0'),
      case s when 'created' then null else 'pay_seed_' || lpad(k::text,8,'0') end,
      case s when 'created' then null else encode(digest('rzp_sig:'||k::text,'sha256'),'hex') end,
      250000 + k * 5000, 'INR', s,
      case (k % 3) when 0 then 'card' when 1 then 'upi' else 'netbanking' end,
      'buyer' || k::text || '@customer.example', '+91 99 0000 ' || lpad(k::text,4,'0'),
      jsonb_build_object('seed_marker','anvil-test-seed-v1','status',s),
      now() - ((10 - k) || ' days')::interval,
      now() - (k || ' hours')::interval
    ) on conflict (tenant_id, razorpay_order_id) do nothing;
  end loop;
end $rzp$;

-- ───────────────────────────────────────────────────────────────────
-- 14. ESIGNATURE  --  4 envelopes covering sent / delivered / signed / declined
-- ───────────────────────────────────────────────────────────────────
do $esig$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0003-0001-000000000001';
  primary_admin  uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:admin.primary@anvil.test');
  statuses       text[] := array['sent','delivered','signed','declined'];
  s              text;
  k              int := 0;
  env_id         uuid;
  ord_id         uuid;
begin
  foreach s in array statuses loop
    k := k + 1;
    env_id := uuid_generate_v5(ns,'esig:' || s);
    ord_id := uuid_generate_v5(ns, 'order:APPROVED:SPARES');
    insert into esignature_envelopes (id, tenant_id, order_id, provider, external_id, status, subject, message, signers, sent_at, completed_at, pdf_storage_path, raw, created_by, created_at, updated_at)
    values (
      env_id, default_tenant, ord_id, 'docusign',
      'docusign-' || lpad(k::text,6,'0'), s,
      'Quote acceptance: order ' || k::text,
      'Please review and sign.',
      jsonb_build_array(jsonb_build_object('name','Buyer','email','buyer@customer.example','status', s), jsonb_build_object('seed_marker','anvil-test-seed-v1')),
      now() - interval '5 days',
      case s when 'signed' then now() - interval '2 days' else null end,
      case s when 'signed' then 'documents/seed/esig/signed-'||k::text||'.pdf' else null end,
      jsonb_build_object('seed_marker','anvil-test-seed-v1'),
      primary_admin, now() - interval '5 days', now() - interval '1 day'
    ) on conflict (id) do nothing;

    -- 1-2 events per envelope.
    insert into esignature_events (id, tenant_id, envelope_id, event, raw, received_at) values
      (uuid_generate_v5(ns,'esige:' || s || ':1'), default_tenant, env_id, 'envelope-sent', jsonb_build_object('seed_marker','anvil-test-seed-v1'), now() - interval '5 days');
    if s = 'signed' then
      insert into esignature_events (id, tenant_id, envelope_id, event, raw, received_at) values
        (uuid_generate_v5(ns,'esige:' || s || ':2'), default_tenant, env_id, 'recipient-signed', jsonb_build_object('seed_marker','anvil-test-seed-v1'), now() - interval '2 days');
    end if;
  end loop;
end $esig$;

-- ───────────────────────────────────────────────────────────────────
-- 15. PORTAL  --  tokens, access_log, quote_acceptances, reorders
-- ───────────────────────────────────────────────────────────────────
do $portal$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0003-0001-000000000001';
  primary_admin  uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:admin.primary@anvil.test');
  cust_id        uuid;
  k              int;
  tok_id         uuid;
  ord_id         uuid;
  source_id      uuid;
begin
  select id into cust_id from customers where tenant_id = default_tenant and customer_key = 'MG_MOTOR_INDIA';

  for k in 1..6 loop
    tok_id := uuid_generate_v5(ns,'pt:' || k::text);
    insert into portal_tokens (id, tenant_id, customer_id, token, email, scopes, revoked_at, expires_at, last_used_at, use_count, created_by, created_at)
    values (
      tok_id, default_tenant, cust_id,
      encode(digest('portal_token:' || k::text, 'sha256'), 'hex'),
      'buyer' || k::text || '@customer.example',
      array['quotes','orders','invoices','pay','reorder','download_invoice','accept_quote'],
      case when k = 5 then now() - interval '10 days' else null end,
      case when k = 6 then now() - interval '2 days' else now() + interval '90 days' end,
      case when k <= 4 then now() - (k || ' days')::interval else null end,
      case when k <= 4 then k * 5 else 0 end,
      primary_admin,
      now() - ((30 + k) || ' days')::interval
    ) on conflict (id) do nothing;

    -- 4 access_log entries per active token.
    if k <= 4 then
      insert into portal_access_log (id, tenant_id, token_id, ip, user_agent, path, status, created_at) values
        (uuid_generate_v5(ns,'pal:' || k::text || ':1'), default_tenant, tok_id, '203.0.113.' || (k * 10)::text, 'Mozilla/5.0', '/portal/quotes',  200, now() - (k || ' days')::interval),
        (uuid_generate_v5(ns,'pal:' || k::text || ':2'), default_tenant, tok_id, '203.0.113.' || (k * 10)::text, 'Mozilla/5.0', '/portal/orders',  200, now() - (k || ' days')::interval),
        (uuid_generate_v5(ns,'pal:' || k::text || ':3'), default_tenant, tok_id, '203.0.113.' || (k * 10)::text, 'Mozilla/5.0', '/portal/invoices',200, now() - (k - 1 || ' days')::interval),
        (uuid_generate_v5(ns,'pal:' || k::text || ':4'), default_tenant, tok_id, '203.0.113.' || (k * 10)::text, 'Mozilla/5.0', '/portal/pay',     200, now() - (k - 1 || ' days')::interval)
      on conflict (id) do nothing;
    end if;
  end loop;

  -- 3 quote acceptances (accepted / accepted / expired-record).
  for k in 1..3 loop
    ord_id := uuid_generate_v5(ns, 'order:APPROVED:' || (case k when 1 then 'SPARES' when 2 then 'PROJECT_FOR' else 'PROJECT_HSS' end));
    insert into portal_quote_acceptances (id, tenant_id, token_id, order_id, customer_id, accepted_at, ip, user_agent, signature_name, signature_email, payload_hash, evidence_url, raw)
    values (
      uuid_generate_v5(ns,'pqa:' || k::text),
      default_tenant, uuid_generate_v5(ns,'pt:' || k::text), ord_id, cust_id,
      now() - ((k + 1) || ' days')::interval,
      '203.0.113.' || (k * 10)::text, 'Mozilla/5.0',
      'Buyer ' || k::text, 'buyer' || k::text || '@customer.example',
      encode(digest('payload:' || k::text, 'sha256'), 'hex'),
      'https://example.com/evidence/' || k::text, jsonb_build_object('seed_marker','anvil-test-seed-v1')
    ) on conflict (id) do nothing;
  end loop;

  -- 5 reorders.
  for k in 1..5 loop
    source_id := uuid_generate_v5(ns, 'order:APPROVED:SPARES');
    insert into portal_reorders (id, tenant_id, token_id, source_order_id, new_order_id, created_at, raw)
    values (
      uuid_generate_v5(ns,'pror:' || k::text),
      default_tenant, uuid_generate_v5(ns,'pt:' || ((k - 1) % 4 + 1)::text), source_id, null,
      now() - (k || ' days')::interval, jsonb_build_object('seed_marker','anvil-test-seed-v1')
    ) on conflict (id) do nothing;
  end loop;
end $portal$;

commit;
