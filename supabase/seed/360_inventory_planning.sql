/*
 * 360_inventory_planning.sql  --  Phase 3.6 of the Anvil seed pack.
 *
 * Purpose
 *   Populate fixtures for the inventory-planning module shipped in
 *   migrations 085 + 086 (see docs/INVENTORY_PLANNING_DESIGN.md).
 *
 *   The planning engine itself ships in Phase 2; this seed provides
 *   enough rows in each new table for the UI smoke tests to render
 *   non-empty, the verify-pass sentinels to fire, and the operator
 *   demo to be meaningful.
 *
 *   Touches:
 *     - item_master extensions (sets item_type, planning_enabled,
 *       safety_stock, reorder_point, default_supplier_id on a
 *       handful of ATD/Timer/Gun rows).
 *     - tenant_settings (flips inventory_planning_enabled on for
 *       the default tenant; defaults handle the rest).
 *     - suppliers              ~3 rows
 *     - source_po_lines        ~5 rows backfilled from existing source_pos
 *     - inventory_allocations  ~3 rows against existing orders/projects
 *     - demand_forecasts       ~24 rows (4 items x 6 weeks)
 *     - inventory_positions    ~8 rows (4 items x 2 days, source='union')
 *     - procurement_plans      ~3 rows
 *     - inventory_exceptions   ~2 rows
 *     - forecast_runs          ~2 rows
 *     - opportunity_line_items ~6 rows on existing opportunities
 *     - 4 new ACTIVE item_master rows for ATD-STD-1, ATD-STD-2,
 *       TIMER-A1, TIMER-B1 so the planning engine has realistic
 *       SKUs to work with (the existing ATD/Timer rows are
 *       DISCONTINUED).
 *
 * Prerequisites
 *   - Migrations 001..086 applied.
 *   - Phases 100, 200, 300, 350 applied.
 *   - app.seed_env in ('staging','local','ci').
 *
 * Idempotency
 *   `on conflict do nothing` everywhere; ids derived via
 *   uuid_generate_v5 with this phase's namespace.
 *
 * Phase namespace
 *   d7a7e5e4-0001-0036-0001-000000000001
 */

-- Env guard: refuse to run unless the operator opted in.
do $env_guard$
begin
  if current_setting('app.seed_env', true) is null
     or current_setting('app.seed_env', true) not in ('staging', 'local', 'ci') then
    raise exception 'Refusing to seed: app.seed_env must be set to staging, local, or ci. Got: %',
      coalesce(current_setting('app.seed_env', true), '<unset>');
  end if;
end $env_guard$;

begin;

do $role$ begin
  begin set local role 'postgres'; exception when others then null; end;
end $role$;

-- ───────────────────────────────────────────────────────────────────
-- 1. tenant_settings: flip the planning flag on
-- ───────────────────────────────────────────────────────────────────
update tenant_settings
   set inventory_planning_enabled = true
 where tenant_id = '00000000-0000-0000-0000-000000000001'
   and inventory_planning_enabled is distinct from true;

-- ───────────────────────────────────────────────────────────────────
-- 2. suppliers (3 rows)
-- ───────────────────────────────────────────────────────────────────
do $suppliers$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0036-0001-000000000001';
begin
  insert into suppliers (
    id, tenant_id, supplier_code, supplier_name, country,
    default_currency, lead_time_days, lead_time_stddev_days,
    on_time_delivery_rate_90d, partial_shipment_rate_90d,
    contact_email, contact_phone, notes
  ) values
    (uuid_generate_v5(ns, 'sup:tokyo-tip'),
      default_tenant, 'TOKYO-TIP', 'Tokyo Tip Industries', 'JP',
      'JPY', 70, 9.5, 0.92, 0.04,
      'sales@tokyo-tip.example.jp', '+81-3-5555-1212',
      'Primary ATD supplier; phase 360 fixture.'),
    (uuid_generate_v5(ns, 'sup:berlin-weld'),
      default_tenant, 'BERLIN-WELD', 'Berlin Welding GmbH', 'DE',
      'EUR', 56, 7.2, 0.88, 0.06,
      'orders@berlinweld.example.de', '+49-30-5555-2424',
      'Primary timer-board supplier; phase 360 fixture.'),
    (uuid_generate_v5(ns, 'sup:seoul-cab'),
      default_tenant, 'SEOUL-CAB', 'Seoul Cabling Co', 'KR',
      'USD', 28, 4.0, 0.95, 0.02,
      'export@seoulcab.example.kr', '+82-2-5555-3636',
      'Backup-tier supplier for cables and minor parts.')
  on conflict (id) do nothing;
end $suppliers$;

-- ───────────────────────────────────────────────────────────────────
-- 3. New ACTIVE ATD / Timer items (4 rows) for the planning fixtures
-- ───────────────────────────────────────────────────────────────────
do $new_items$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0036-0001-000000000001';
  tokyo_id       uuid := uuid_generate_v5(ns, 'sup:tokyo-tip');
  berlin_id      uuid := uuid_generate_v5(ns, 'sup:berlin-weld');
begin
  insert into item_master (
    id, tenant_id, part_no, description, drawing_no, uom, item_group, item_sub_group,
    category, sub_category, source_country, source_currency, purchase_price,
    hsn_sac, sgst_rate, cgst_rate, igst_rate, default_lead_days, moq, pack_size,
    rounding_rule, lifecycle, is_assembly, is_critical, technical_specs, notes,
    item_type, default_supplier_id, planning_enabled, service_level,
    coverage_period_weeks, created_at, updated_at
  ) values
    (uuid_generate_v5(ns, 'item:atd:std-1'),
      default_tenant, 'ATD-STD-1', 'Auto Tip Dresser standard (JC-class)',
      'ATD-STD-1', 'Nos', 'spares', 'atd', 'spares', 'atd',
      'O-JAPAN', 'JPY', 95000,
      '84612019', 0.09, 0.09, 0.18, 70, 1, 1,
      'none', 'ACTIVE', false, true,
      jsonb_build_object('motor', 'Tokyo-A220', 'seed_marker', 'anvil-test-seed-v1'),
      'Phase 360 fixture: planning-enabled ATD.',
      'ATD', tokyo_id, true, 0.99, 12,
      now() - interval '180 days', now() - interval '7 days'),
    (uuid_generate_v5(ns, 'item:atd:std-2'),
      default_tenant, 'ATD-STD-2', 'Auto Tip Dresser premium (JC-class)',
      'ATD-STD-2', 'Nos', 'spares', 'atd', 'spares', 'atd',
      'O-JAPAN', 'JPY', 110000,
      '84612019', 0.09, 0.09, 0.18, 84, 1, 1,
      'none', 'ACTIVE', false, true,
      jsonb_build_object('motor', 'Tokyo-A300', 'seed_marker', 'anvil-test-seed-v1'),
      'Phase 360 fixture: high-spec ATD.',
      'ATD', tokyo_id, true, 0.99, 12,
      now() - interval '180 days', now() - interval '7 days'),
    (uuid_generate_v5(ns, 'item:timer:a1'),
      default_tenant, 'TIMER-A1', 'Adaptive DC welding timer (gen 2)',
      'TIMER-A1', 'Nos', 'spares', 'timer', 'spares', 'timer',
      'O-GERMANY', 'EUR', 1450,
      '85159000', 0.09, 0.09, 0.18, 56, 1, 1,
      'none', 'ACTIVE', false, true,
      jsonb_build_object('firmware', '2.4.1', 'seed_marker', 'anvil-test-seed-v1'),
      'Phase 360 fixture: planning-enabled timer.',
      'TIMER', berlin_id, true, 0.99, 10,
      now() - interval '180 days', now() - interval '7 days'),
    (uuid_generate_v5(ns, 'item:timer:b1'),
      default_tenant, 'TIMER-B1', 'Adaptive DC welding timer (compact)',
      'TIMER-B1', 'Nos', 'spares', 'timer', 'spares', 'timer',
      'O-GERMANY', 'EUR', 1280,
      '85159000', 0.09, 0.09, 0.18, 56, 1, 1,
      'none', 'ACTIVE', false, true,
      jsonb_build_object('firmware', '2.3.7', 'seed_marker', 'anvil-test-seed-v1'),
      'Phase 360 fixture: compact-form timer.',
      'TIMER', berlin_id, true, 0.95, 10,
      now() - interval '180 days', now() - interval '7 days')
  on conflict (id) do nothing;

  -- Mark a couple of existing gun rows as planning-enabled too, so
  -- the parent-side appears in the dashboard.
  update item_master
     set item_type = 'GUN',
         planning_enabled = true,
         service_level = 0.95,
         coverage_period_weeks = 12
   where tenant_id = default_tenant
     and part_no in ('X2C-BASE-ASSY', 'X3-X-MEDIUM')
     and (item_type is null or item_type = 'OTHER');
end $new_items$;

-- ───────────────────────────────────────────────────────────────────
-- 4. source_po_lines: backfill ~5 lines from existing source_pos rows
-- ───────────────────────────────────────────────────────────────────
do $sp_lines$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0036-0001-000000000001';
  spo            record;
  i              int := 0;
begin
  for spo in
    select id, supplier, acknowledged_eta
      from source_pos
     where tenant_id = default_tenant
     order by created_at asc
     limit 3
  loop
    -- Two lines per PO so the join surface has variety.
    i := i + 1;
    insert into source_po_lines (
      id, tenant_id, source_po_id, line_index, part_no, description,
      qty, rate, uom, acknowledged_eta, received_qty
    ) values
      (uuid_generate_v5(ns, 'spol:' || spo.id::text || ':1'),
        default_tenant, spo.id, 1, 'ATD-STD-1', 'Auto Tip Dresser std',
        2, 95000, 'Nos', spo.acknowledged_eta, 0),
      (uuid_generate_v5(ns, 'spol:' || spo.id::text || ':2'),
        default_tenant, spo.id, 2, 'TIMER-A1', 'Adaptive DC timer gen 2',
        3, 1450, 'Nos', spo.acknowledged_eta, 0)
    on conflict (source_po_id, line_index) do nothing;
  end loop;
end $sp_lines$;

-- ───────────────────────────────────────────────────────────────────
-- 5. inventory_allocations (3 rows)
-- ───────────────────────────────────────────────────────────────────
do $allocs$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0036-0001-000000000001';
  alpha          uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:eng.alpha@anvil.test');
  ord_id         uuid;
  proj_id        uuid;
begin
  -- Pick the first APPROVED order + first ACTIVE project for the
  -- default tenant.
  select id into ord_id from orders
   where tenant_id = default_tenant and status = 'APPROVED'
   order by created_at asc limit 1;
  select id into proj_id from projects
   where tenant_id = default_tenant and status = 'ACTIVE'
   order by created_at asc limit 1;

  if ord_id is not null then
    insert into inventory_allocations (
      id, tenant_id, project_id, order_id, part_no, qty, required_by,
      status, reason_text, created_by
    ) values
      (uuid_generate_v5(ns, 'alloc:atd:' || ord_id::text),
        default_tenant, proj_id, ord_id, 'ATD-STD-1',
        2, (now() + interval '30 days')::date,
        'reserved', 'Reserved against confirmed order (seed fixture).',
        alpha),
      (uuid_generate_v5(ns, 'alloc:timer:' || ord_id::text),
        default_tenant, proj_id, ord_id, 'TIMER-A1',
        3, (now() + interval '30 days')::date,
        'reserved', 'Reserved against confirmed order (seed fixture).',
        alpha),
      (uuid_generate_v5(ns, 'alloc:atd2:' || ord_id::text),
        default_tenant, proj_id, ord_id, 'ATD-STD-2',
        1, (now() + interval '60 days')::date,
        'reserved', 'Premium ATD reserved for next-quarter project.',
        alpha)
    on conflict (id) do nothing;
  end if;
end $allocs$;

-- ───────────────────────────────────────────────────────────────────
-- 6. demand_forecasts (4 items x 6 weeks = 24 rows)
-- ───────────────────────────────────────────────────────────────────
do $forecasts$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0036-0001-000000000001';
  parts          text[] := array['ATD-STD-1', 'ATD-STD-2', 'TIMER-A1', 'TIMER-B1'];
  models         text[] := array['TSB+Bootstrap', 'TSB+Bootstrap', 'NHITS', 'SBA'];
  classes        text[] := array['lumpy', 'lumpy', 'erratic', 'intermittent'];
  base_demand    numeric[] := array[3.0, 1.5, 4.5, 2.0];
  p              text;
  m              text;
  cls            text;
  d              numeric;
  wk             date;
  i              int;
  j              int;
begin
  for i in 1..array_length(parts, 1) loop
    p := parts[i];
    m := models[i];
    cls := classes[i];
    d := base_demand[i];
    -- Stamp the demand_class on item_master for this part.
    update item_master set demand_class = cls
     where tenant_id = default_tenant and part_no = p
       and demand_class is distinct from cls;
    for j in 0..5 loop
      wk := (date_trunc('week', now()) + (j * interval '7 days'))::date;
      insert into demand_forecasts (
        id, tenant_id, part_no, week_start,
        forecast_committed, forecast_pipeline, forecast_baseline,
        quantile_50, quantile_90, quantile_95, quantile_99,
        model_name, model_version, wape_4w, wape_8w, wape_12w
      ) values (
        uuid_generate_v5(ns, 'fcst:' || p || ':' || wk::text),
        default_tenant, p, wk,
        round((d * 0.4)::numeric, 2),
        round((d * 0.5 * (1 + 0.1 * j))::numeric, 2),
        round((d * 0.2)::numeric, 2),
        round((d * 1.1)::numeric, 2),
        round((d * 1.6)::numeric, 2),
        round((d * 1.85)::numeric, 2),
        round((d * 2.3)::numeric, 2),
        m, '1.0', 0.184, 0.214, 0.244
      ) on conflict (tenant_id, part_no, week_start, model_name) do nothing;
    end loop;
  end loop;
end $forecasts$;

-- ───────────────────────────────────────────────────────────────────
-- 7. inventory_positions (4 items x 2 days, source='union')
-- ───────────────────────────────────────────────────────────────────
do $positions$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0036-0001-000000000001';
  parts          text[] := array['ATD-STD-1', 'ATD-STD-2', 'TIMER-A1', 'TIMER-B1'];
  on_hand        numeric[] := array[18, 6, 22, 9];
  in_transit     numeric[] := array[8, 0, 5, 3];
  allocated      numeric[] := array[12, 1, 14, 4];
  ss             numeric[] := array[9, 4, 11, 5];
  rop            numeric[] := array[22, 12, 24, 12];
  d              date;
  i              int;
  k              int;
begin
  for k in 0..1 loop
    d := (current_date - (k * interval '1 day'))::date;
    for i in 1..array_length(parts, 1) loop
      insert into inventory_positions (
        id, tenant_id, part_no, as_of, on_hand_qty, in_transit_qty,
        allocated_qty, reorder_point, safety_stock, source
      ) values (
        uuid_generate_v5(ns, 'pos:' || parts[i] || ':' || d::text),
        default_tenant, parts[i], d,
        on_hand[i], in_transit[i], allocated[i],
        rop[i], ss[i], 'union'
      ) on conflict (tenant_id, part_no, as_of, source) do nothing;
    end loop;
  end loop;
end $positions$;

-- ───────────────────────────────────────────────────────────────────
-- 8. procurement_plans (3 rows; one per planning-enabled item that
--    needs replenishing)
-- ───────────────────────────────────────────────────────────────────
do $plans$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0036-0001-000000000001';
  alpha          uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:eng.alpha@anvil.test');
begin
  insert into procurement_plans (
    id, tenant_id, part_no, for_week, recommended_order_date,
    expected_arrival_date, recommended_qty, policy_source,
    net_requirement, rationale, status, notes
  ) values
    (uuid_generate_v5(ns, 'plan:atd-std-1:wk-22'),
      default_tenant, 'ATD-STD-1',
      (date_trunc('week', now()) + interval '8 weeks')::date,
      (current_date + interval '7 days')::date,
      (current_date + interval '77 days')::date,
      14, 'rule_based_coverage', 6,
      jsonb_build_object(
        'committed', 4, 'pipeline', 8, 'baseline', 2,
        'on_hand', 18, 'in_transit', 8, 'allocated', 12,
        'safety_stock', 9, 'rop', 22, 'service_level', 0.99,
        'top_opps', jsonb_build_array(
          jsonb_build_object('opp', 'JBM Q3 2026', 'qty', 4, 'prob', 0.6),
          jsonb_build_object('opp', 'Tata X3 Phase 2', 'qty', 3, 'prob', 0.7))
      ),
      'draft', 'Auto-generated by seed phase 360 (engine fixture).'),
    (uuid_generate_v5(ns, 'plan:timer-a1:wk-18'),
      default_tenant, 'TIMER-A1',
      (date_trunc('week', now()) + interval '4 weeks')::date,
      (current_date + interval '3 days')::date,
      (current_date + interval '59 days')::date,
      8, 'rule_based_eoq', 3,
      jsonb_build_object(
        'committed', 3, 'pipeline', 5, 'baseline', 2,
        'on_hand', 22, 'in_transit', 5, 'allocated', 14,
        'safety_stock', 11, 'rop', 24, 'service_level', 0.99
      ),
      'draft', 'Coverage period: 10 weeks; EOQ rounded to MOQ.'),
    (uuid_generate_v5(ns, 'plan:atd-std-2:wk-30'),
      default_tenant, 'ATD-STD-2',
      (date_trunc('week', now()) + interval '12 weeks')::date,
      (current_date + interval '14 days')::date,
      (current_date + interval '98 days')::date,
      4, 'rule_based_coverage', 2,
      jsonb_build_object(
        'committed', 1, 'pipeline', 2, 'baseline', 1,
        'on_hand', 6, 'in_transit', 0, 'allocated', 1,
        'safety_stock', 4, 'rop', 12, 'service_level', 0.99
      ),
      'draft', 'Premium ATD; conservative coverage horizon.')
  on conflict (id) do nothing;
end $plans$;

-- ───────────────────────────────────────────────────────────────────
-- 9. inventory_exceptions (2 rows)
-- ───────────────────────────────────────────────────────────────────
do $excs$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0036-0001-000000000001';
begin
  insert into inventory_exceptions (
    id, tenant_id, part_no, exception_kind, severity, detail, status
  ) values
    (uuid_generate_v5(ns, 'exc:atd-std-1:rop'),
      default_tenant, 'ATD-STD-1', 'below_reorder_point', 'warn',
      jsonb_build_object('on_hand', 18, 'rop', 22, 'short_by', 4),
      'open'),
    (uuid_generate_v5(ns, 'exc:timer-a1:delay'),
      default_tenant, 'TIMER-A1', 'supplier_delay', 'bad',
      jsonb_build_object('supplier', 'BERLIN-WELD', 'delay_days', 7,
                         'po_ref', 'SP-9011'),
      'open')
  on conflict (id) do nothing;
end $excs$;

-- ───────────────────────────────────────────────────────────────────
-- 10. forecast_runs (2 rows; provenance for the demand_forecasts above)
-- ───────────────────────────────────────────────────────────────────
do $fruns$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0036-0001-000000000001';
begin
  insert into forecast_runs (
    id, tenant_id, started_at, finished_at, status, items_count,
    models_evaluated, wape_summary, notes
  ) values
    (uuid_generate_v5(ns, 'frun:wk-prev'),
      default_tenant, now() - interval '8 days', now() - interval '8 days' + interval '6 minutes',
      'ok', 4,
      jsonb_build_object('TSB+Bootstrap', 2, 'NHITS', 1, 'SBA', 1),
      jsonb_build_object('mean_wape_4w', 0.182, 'mean_wape_8w', 0.214, 'mean_wape_12w', 0.243),
      'Phase 360 fixture: previous weekly run.'),
    (uuid_generate_v5(ns, 'frun:wk-curr'),
      default_tenant, now() - interval '1 day', now() - interval '1 day' + interval '7 minutes',
      'ok', 4,
      jsonb_build_object('TSB+Bootstrap', 2, 'NHITS', 1, 'SBA', 1),
      jsonb_build_object('mean_wape_4w', 0.181, 'mean_wape_8w', 0.213, 'mean_wape_12w', 0.244),
      'Phase 360 fixture: current weekly run.')
  on conflict (id) do nothing;
end $fruns$;

-- ───────────────────────────────────────────────────────────────────
-- 11. opportunity_line_items (~6 rows; structured pipeline lines per Q7)
-- ───────────────────────────────────────────────────────────────────
do $opp_lines$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0036-0001-000000000001';
  opp            record;
  i              int := 0;
begin
  for opp in
    select id, opportunity_name, customer_id, close_date
      from opportunities
     where tenant_id = default_tenant
       and stage in ('PROPOSAL_PRICE_QUOTE', 'NEGOTIATION_REVIEW', 'FOLLOW_UP', 'RFQ')
     order by created_at asc
     limit 3
  loop
    i := i + 1;
    -- Three lines per opp: a gun + ATD + Timer (Joel's example shape).
    insert into opportunity_line_items (
      id, tenant_id, opportunity_id, line_index,
      product_family, product_category, part_no, description, qty, uom,
      expected_unit_price, expected_currency, expected_close_date, notes
    ) values
      (uuid_generate_v5(ns, 'oli:gun:' || opp.id::text),
        default_tenant, opp.id, 1,
        'Gun', 'x2c', 'X2C-BASE-ASSY', 'MFDC Servo Gun X2C',
        case when i = 1 then 2 when i = 2 then 1 else 3 end, 'Nos',
        780000, 'INR', opp.close_date, 'Phase 360 seed line.'),
      (uuid_generate_v5(ns, 'oli:atd:' || opp.id::text),
        default_tenant, opp.id, 2,
        'ATD', 'JC', 'ATD-STD-1', 'Auto Tip Dresser std (JC)',
        case when i = 1 then 2 when i = 2 then 1 else 3 end, 'Nos',
        95000, 'INR', opp.close_date, 'Phase 360 seed line.'),
      (uuid_generate_v5(ns, 'oli:timer:' || opp.id::text),
        default_tenant, opp.id, 3,
        'Timer', 'adaptive_dc', 'TIMER-A1', 'Adaptive DC welding timer',
        case when i = 1 then 2 when i = 2 then 1 else 3 end, 'Nos',
        145000, 'INR', opp.close_date, 'Phase 360 seed line.')
    on conflict (opportunity_id, line_index) do nothing;
  end loop;
end $opp_lines$;

commit;
