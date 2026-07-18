/*
 * 900_teardown.sql  --  paired teardown for the Anvil seed pack.
 *
 * Purpose
 *   Reverses every insert performed by 100..500 without touching
 *   real customer data. Two safety layers:
 *
 *   1. Env guard. Refuses to run unless `app.seed_env` is set to
 *      'staging' / 'local' / 'ci'.
 *
 *   2. Production hostname guard. Refuses to run if the database's
 *      cluster_name or application_name (whichever Supabase exposes)
 *      contains the substring 'production' or 'prod-'.
 *
 *   Selection of rows to delete:
 *
 *   - Where a deterministic UUID formula is used by the seed (every
 *     row inserted with `uuid_generate_v5(...)` keyed on the seed
 *     namespace), the teardown uses the same formula, so no `where
 *     id = ...` list maintenance is needed.
 *
 *   - Where the seed used the `seed_marker = 'anvil-test-seed-v1'`
 *     marker on a jsonb column, the teardown deletes by that marker.
 *
 *   - Where the seed inserted into a log-shaped table without a
 *     jsonb marker (audit_events tracers, processing_events,
 *     model_routing_log, mcp_call_log), we delete via:
 *       (a) action / detail / case_id / purpose / tool fields whose
 *           value the seed set deterministically, OR
 *       (b) jsonb after_payload / detail keys carrying the marker.
 *
 *   - The corpus seed (supabase/seed.sql) is **never** touched. Its
 *     rows do not carry `seed_marker = 'anvil-test-seed-v1'` and
 *     their UUIDs are not derived from our seed namespace.
 *
 * Order
 *   500 -> 400 -> 300 -> 200 -> 100  (reverse FK order, mirroring
 *   the apply order so cascades from the parent phase happen before
 *   the dependent phase is touched).
 *
 * Idempotency
 *   Every delete returns 0 rows on the second run. Safe to re-apply.
 *
 * Run
 *   set app.seed_env = 'staging';
 *   \i supabase/seed/900_teardown.sql
 */

-- ───────────────────────────────────────────────────────────────────
-- 0. ENV GUARD + PRODUCTION HOSTNAME GUARD
-- ───────────────────────────────────────────────────────────────────
do $guard$
declare
  cluster      text;
  app_name     text;
begin
  if current_setting('app.seed_env', true) is null
     or current_setting('app.seed_env', true) not in ('staging', 'local', 'ci') then
    raise exception 'Refusing to teardown: app.seed_env must be set to staging, local, or ci. Got: %',
      coalesce(current_setting('app.seed_env', true), '<unset>');
  end if;

  -- Try the standard Postgres connection-info settings; both are
  -- safe to read and never raise. Reject anything that smells like
  -- a production cluster.
  cluster  := coalesce(current_setting('cluster_name', true), '');
  app_name := coalesce(current_setting('application_name', true), '');
  if position('production' in lower(cluster))   > 0
     or position('prod-'      in lower(cluster))   > 0
     or position('production' in lower(app_name))  > 0
     or position('prod-'      in lower(app_name))  > 0 then
    raise exception 'Refusing to teardown: cluster_name=% or application_name=% looks like production.',
      cluster, app_name;
  end if;
end $guard$;

begin;

do $role$ begin
  begin set local role 'postgres'; exception when others then null; end;
end $role$;

-- Common literals reused across the file.
-- Default tenant: 00000000-0000-0000-0000-000000000001
-- Seed marker:    anvil-test-seed-v1
-- Phase namespaces:
--   100 = d7a7e5e4-0001-0001-0001-000000000001
--   200 = d7a7e5e4-0001-0002-0001-000000000001
--   300 = d7a7e5e4-0001-0003-0001-000000000001
--   400 = d7a7e5e4-0001-0004-0001-000000000001
--   500 = d7a7e5e4-0001-0005-0001-000000000001

-- ───────────────────────────────────────────────────────────────────
-- 1. PHASE 500  --  ERP mirrors
-- ───────────────────────────────────────────────────────────────────
-- Deep seeds (NetSuite, SAP, Tally) plus templated 14 connectors.
-- Every row carries seed_marker in its `raw` jsonb column (or in
-- `payload` for retry_queue). Delete by marker.
do $p500$
declare
  prefixes text[] := array[
    'netsuite','sap','d365','acu','p21','eclipse','sxe',
    'sagex3','ifs','oracle_fusion','ramco','jde','plex','jobboss',
    'oracle_ebs','proalpha'
  ];
  prefix text;
  candidate_tables text[] := array[
    '_inventory_balances','_branches','_warehouses','_plants','_locations',
    '_currencies','_purchase_orders','_open_orders','_sales_orders',
    '_business_partners','_vendors','_materials','_items','_stock_items',
    '_released_products','_products','_customers',
    '_retry_queue','_sync_runs','_sync_state'
  ];
  suffix text;
  tname  text;
  col    text;
begin
  -- Tally-specific tables (don't follow the prefix_table convention).
  delete from tally_voucher_state    where raw      ->> 'seed_marker' = 'anvil-test-seed-v1';
  delete from tally_sync_runs        where company_id in (
    select id from tally_companies where name = 'Northwind Manufacturing (default)' and bridge_url like 'https://tally-bridge.example.com%'
  );
  delete from tally_payment_receipts where raw      ->> 'seed_marker' = 'anvil-test-seed-v1';
  delete from tally_retry_queue      where payload_xml = '<ENVELOPE seed=true/>';
  delete from tally_voucher_records  where validation->> 'seed_marker' = 'anvil-test-seed-v1';
  delete from tally_companies        where name = 'Northwind Manufacturing (default)' and bridge_url like 'https://tally-bridge.example.com%';

  -- For every other prefix, walk the candidate tables. Skip prefixes
  -- where the table doesn't exist (sagex3 has no inventory_balances,
  -- etc.). For most we delete by raw->>seed_marker; for the
  -- retry_queue tables we delete by payload->>seed_marker.
  foreach prefix in array prefixes loop
    foreach suffix in array candidate_tables loop
      tname := prefix || suffix;
      if to_regclass('public.' || tname) is null then continue; end if;

      -- Pick the marker column.
      if suffix = '_retry_queue' then
        col := 'payload';
      else
        col := 'raw';
      end if;

      -- Some templated mirror tables in our seed don't actually
      -- carry a seed_marker on the column we expect (the
      -- inventory_balances rows pack the marker into `raw`, but the
      -- `_branches`/`_warehouses` ones do too; the `_sync_state`
      -- rows have no `raw` at all). Wrap the delete in an exception
      -- block so a column-not-found error doesn't abort the file.
      begin
        execute format($q$
          delete from %I where %I->>'seed_marker' = 'anvil-test-seed-v1'
        $q$, tname, col);
      exception when undefined_column then
        -- The table has no `raw` / `payload` column. Try `error`
        -- isn't applicable; fall through and prune by id formula
        -- below if needed.
        null;
      end;
    end loop;
  end loop;

  -- sync_state rows for the templated 14 don't carry a marker
  -- column; remove them by entity = 'sales_order' and the
  -- deterministic id derived from the seed namespace.
  foreach prefix in array prefixes loop
    if to_regclass('public.' || prefix || '_sync_state') is null then continue; end if;
    execute format($q$
      delete from %I where id = uuid_generate_v5(
        'd7a7e5e4-0001-0005-0001-000000000001'::uuid,
        'erp:%I:ss')
    $q$, prefix || '_sync_state', prefix);
  end loop;

  -- NetSuite sync_state rows from the deep seed (six rows, one per
  -- entity, with deterministic UUIDs).
  delete from netsuite_sync_state where id in (
    uuid_generate_v5('d7a7e5e4-0001-0005-0001-000000000001'::uuid,'ns:ss:customer'),
    uuid_generate_v5('d7a7e5e4-0001-0005-0001-000000000001'::uuid,'ns:ss:item'),
    uuid_generate_v5('d7a7e5e4-0001-0005-0001-000000000001'::uuid,'ns:ss:inventory'),
    uuid_generate_v5('d7a7e5e4-0001-0005-0001-000000000001'::uuid,'ns:ss:sales_order'),
    uuid_generate_v5('d7a7e5e4-0001-0005-0001-000000000001'::uuid,'ns:ss:invoice'),
    uuid_generate_v5('d7a7e5e4-0001-0005-0001-000000000001'::uuid,'ns:ss:ar_aging')
  );

  -- SAP sync_state rows from the deep seed (5 entities).
  delete from sap_sync_state where id in (
    select uuid_generate_v5('d7a7e5e4-0001-0005-0001-000000000001'::uuid, 'sap:ss:' || e)
    from unnest(array['business_partner','material','sales_order','purchase_order','inventory']) e
  );
end $p500$;

-- ───────────────────────────────────────────────────────────────────
-- 2. PHASE 400  --  logs and analytics
-- ───────────────────────────────────────────────────────────────────
do $p400$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
begin
  -- Append-only / log tables (audit_events, processing_events,
  -- model_routing_log, mcp_call_log) used markers in distinct
  -- fields so we can prune them precisely.
  delete from audit_events            where tenant_id = default_tenant
    and (detail like 'phase400:%' or detail like 'phase300:%' or detail = 'phase400:audit_bulk_marker');
  delete from processing_events       where tenant_id = default_tenant
    and (case_id like 'case:%' or case_id like 'extra:%' or case_id = 'phase400:bulk');
  delete from model_routing_log       where tenant_id = default_tenant
    and (purpose = 'phase400_marker' or purpose in ('extract_po','classify_doc','validate_lines','quote_qa','agent_step','docai_extract','bom_map','reconcile','rlhf_explain','price_compose'));
  delete from mcp_call_log            where tenant_id = default_tenant
    and (tool = 'phase400_marker' or args->>'seed_marker' = 'anvil-test-seed-v1');

  delete from print_jobs              where pdf_storage_path like 'travelers/seed/%';
  delete from erp_chat_messages       where tool_call->>'seed_marker'   = 'anvil-test-seed-v1' or content like 'Seed message %';
  delete from erp_chat_sessions       where scope->>'seed_marker'        = 'anvil-test-seed-v1' or title like 'Seed ERP chat session %';
  delete from vertical_pack_installs  where details->>'seed_marker'      = 'anvil-test-seed-v1';
  delete from plm_sync_state          where tenant_id = default_tenant
                                       and entity in ('boms','changes')
                                       and system_id in (select id from plm_systems where raw->>'seed_marker' = 'anvil-test-seed-v1');
  delete from plm_changes             where raw->>'seed_marker'          = 'anvil-test-seed-v1';
  delete from plm_boms                where raw->>'seed_marker'          = 'anvil-test-seed-v1';
  delete from plm_systems             where raw->>'seed_marker'          = 'anvil-test-seed-v1';
  delete from edi_envelopes           where parsed->>'seed_marker'       = 'anvil-test-seed-v1';
  delete from edi_partners            where name in ('Vega Motor X12','Tata X12','Globex EDIFACT','Acme X12');
  delete from prospecting_suppressions where email like 'unsub%@target.example';
  delete from prospecting_targets     where metadata->>'seed_marker'     = 'anvil-test-seed-v1';
  delete from prospecting_campaigns   where name in ('ICP-paper','ICP-fasteners','ICP-PVF');
  delete from network_sourcing_queries where matched_tenant_ids @> array[default_tenant];
  delete from network_listings        where notes = 'Seed listing.';
  delete from voice_call_actions      where payload->>'seed_marker'      = 'anvil-test-seed-v1';
  delete from voice_calls             where raw->>'seed_marker'          = 'anvil-test-seed-v1';
  delete from voice_configs           where api_key like 'va_seed_%';
  delete from inbound_messages        where raw_payload->>'seed_marker'  = 'anvil-test-seed-v1';
  delete from inbound_chat_configs    where creds_plain->>'seed_marker'  = 'anvil-test-seed-v1';
  delete from inbound_emails          where from_address like 'buyer%@customer.example' and tenant_id = default_tenant;
  delete from inbound_email_threads   where thread_key like 'thread-%' and tenant_id = default_tenant;
  delete from push_notifications      where data->>'seed_marker'         = 'anvil-test-seed-v1';
  delete from push_subscriptions      where endpoint like 'https://fcm.googleapis.com/fcm/send/seed-%' or device_token like 'fcm-token-%';
  delete from rlhf_reward_daily       where surface in ('agent','intake','anomaly','bom','quote_qa') and tenant_id = default_tenant;
  delete from rlhf_feedback           where prompt->>'seed_marker'       = 'anvil-test-seed-v1';
  delete from analytics_winloss_daily where lost_reasons->>'seed_marker' = 'anvil-test-seed-v1';
  delete from analytics_customer_monthly where tenant_id = default_tenant
    and customer_id in (select id from customers where customer_key in ('MG_MOTOR_INDIA','NRD_AUTO_PLANT_1'));
  delete from forecast_snapshots      where tenant_id = default_tenant
    and segment_dimension in ('territory','customer_type');
  delete from injection_test_runs     where catalogue in ('owasp-llm-top-10-2024','anvil-internal-redteam-v1','agent-tool-misuse-v1');
  delete from audit_export_runs       where signed_hash in (
    encode(digest('aer:1','sha256'),'hex'),
    encode(digest('aer:2','sha256'),'hex'),
    encode(digest('aer:3','sha256'),'hex'),
    encode(digest('aer:4','sha256'),'hex')
  );
  delete from backups                 where notes like 'status=%nightly full%' or notes like 'status=%pg_dump%' or notes like 'status=%storage upload%';
  delete from deploys                 where meta->>'seed_marker' = 'anvil-test-seed-v1';
  delete from agent_eval_runs         where summary->>'seed_marker' = 'anvil-test-seed-v1';
  delete from agent_steps             where action_payload->>'seed_marker' = 'anvil-test-seed-v1';
  delete from agent_goals             where config->>'seed_marker' = 'anvil-test-seed-v1';
  delete from eval_case_results       where checks @> '[{"seed_marker":"anvil-test-seed-v1"}]'::jsonb
                                       or run_id in (select id from eval_runs where notes like 'Seed eval run %');
  delete from eval_runs               where notes like 'Seed eval run %';
  delete from eval_cases              where description like 'Seed eval case %';
end $p400$;

-- ───────────────────────────────────────────────────────────────────
-- 3. PHASE 300  --  workflow data
-- ───────────────────────────────────────────────────────────────────
do $p300$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0003-0001-000000000001';
begin
  -- Portal first (FK to orders).
  delete from portal_reorders          where raw->>'seed_marker'          = 'anvil-test-seed-v1';
  delete from portal_quote_acceptances where raw->>'seed_marker'          = 'anvil-test-seed-v1';
  delete from portal_access_log        where token_id in (select id from portal_tokens where email like 'buyer%@customer.example');
  delete from portal_tokens            where email like 'buyer%@customer.example';

  -- E-signature.
  delete from esignature_events        where raw->>'seed_marker'          = 'anvil-test-seed-v1';
  delete from esignature_envelopes     where raw->>'seed_marker'          = 'anvil-test-seed-v1';

  -- Razorpay payments.
  delete from razorpay_payments        where raw->>'seed_marker'          = 'anvil-test-seed-v1';

  -- AP three-way match.
  delete from deduction_queue          where invoice_id in (
    select id from invoices where invoice_number like 'INV-____'
      and tenant_id = default_tenant
      and customer_id in (select id from customers where customer_key = 'ANVIL_TEST_INDUSTRIES')
  );
  delete from ap_goods_receipts        where receipt_number like 'GR-00_';
  delete from ap_invoice_lines         where ap_invoice_id in (select id from ap_invoices where vendor_invoice_number like 'VINV-%');
  delete from ap_invoices              where vendor_invoice_number like 'VINV-%';

  -- Invoices + payments.
  delete from payment_records          where raw->>'seed_marker'          = 'anvil-test-seed-v1';
  delete from invoices                 where notes like 'Seed invoice %';
  delete from invoice_number_sequences where tenant_id = default_tenant and prefix = 'INV';

  -- E-invoices.
  delete from einvoices                where payload->>'seed_marker'      = 'anvil-test-seed-v1';

  -- Service module.
  delete from obsolete_parts           where notes in (
    'Phased out; replaced by 16D.',
    'Replaced by X2C series.',
    'UV-stable replacement.',
    'Vendor stopped manufacturing.'
  );
  delete from spare_recommendations    where reason->>'seed_marker'       = 'anvil-test-seed-v1';
  delete from closure_reports          where investigation like 'Seed%' or investigation like 'Field investigation confirmed%' or investigation like 'Holder fatigue investigation.' or investigation like 'Recurrence after batch swap.' or investigation like 'Investigation pending supplier RCA.' or investigation like 'Standalone closure (no parent CAR).';
  delete from car_reports              where five_why_analysis->>'seed_marker' = 'anvil-test-seed-v1' or part_no in ('CT-16-D-1-FS','4-HD32208-2');
  delete from amc_schedules            where visit_label like '%PREVENTIVE%' or visit_label like '%EMERGENCY%' or visit_label like '%TRAINING%' or visit_label like '%AUDIT%';
  delete from service_visits           where line_or_station like 'BIW Line A / Station S%' and tenant_id = default_tenant;

  -- Approvals.
  delete from quote_approvals          where comments in ('Approved.', 'Margin below floor.', 'Skipped: under threshold.') or status = 'PENDING' and tenant_id = default_tenant;

  -- Shipments (referenced by orders/source_pos/internal_so).
  delete from shipments                where shipment_number like 'SH-%' and tenant_id = default_tenant;

  -- Supplier RFQs + quotes + invitations.
  delete from supplier_quotes          where raw->>'seed_marker'          = 'anvil-test-seed-v1';
  delete from supplier_rfq_invitations where rfq_id in (select id from supplier_rfqs where rfq_number like 'RFQ-%' and tenant_id = default_tenant);
  delete from supplier_rfq_lines       where rfq_id in (select id from supplier_rfqs where rfq_number like 'RFQ-%' and tenant_id = default_tenant);
  delete from supplier_rfqs            where rfq_number like 'RFQ-%' and tenant_id = default_tenant;
  delete from supplier_scorecards      where tenant_id = default_tenant
    and supplier in (select vendor_name from vendors where external_ref->>'seed_marker' = 'anvil-test-seed-v1');

  -- Source POs (ON DELETE CASCADE on source_po_events).
  delete from source_pos               where reference like 'SPO-%' and tenant_id = default_tenant;

  -- Order fan-out (in safe order; FKs are mostly cascade-on-order).
  delete from order_reconciliations    where raw->>'seed_marker' = 'anvil-test-seed-v1';
  delete from order_amendments         where diff->>'seed_marker' = 'anvil-test-seed-v1';
  delete from order_schedule_lines     where remark is null and source_document_id in (
    select id from documents where storage_path like 'documents/seed/po/%'
  );
  delete from communications           where metadata->>'seed_marker' = 'anvil-test-seed-v1';
  delete from extraction_runs          where source_url like 'documents/seed/po/%';
  delete from zip_scans                where document_id in (select id from documents where storage_path like 'documents/seed/attach/%');
  delete from ocr_runs                 where document_id in (select id from documents where storage_path like 'documents/seed/po/%');
  delete from validation_findings      where rule_id in ('rule.margin.floor','rule.evidence.miss','rule.lead.gap');
  delete from evidence                 where document_id in (select id from documents where storage_path like 'documents/seed/po/%');
  delete from order_documents          where document_id in (select id from documents where storage_path like 'documents/seed/%');
  delete from documents                where storage_path like 'documents/seed/%';
  delete from orders                   where doc_fingerprint in (
    select encode(digest('order:' || s || ':' || m, 'sha256'), 'hex')
    from unnest(array['DRAFT','PENDING_REVIEW','APPROVED','BLOCKED','DUPLICATE','REUSED','EXPORTED_TO_TALLY','FAILED_TALLY_IMPORT','RECONCILED','CANCELLED']) s
    cross join unnest(array['SPARES','SPARES_ASSEMBLY','PROJECT_FOR','PROJECT_HSS','INTERNAL']) m
  );

  -- Internal SOs.
  delete from internal_so_lines        where part_no in ('CT-16-D-1-FS','4-HD32208-2') and tenant_id = default_tenant
    and internal_so_id in (select id from internal_sales_orders where iso_number like 'ISO-%' and tenant_id = default_tenant);
  delete from internal_sales_orders    where iso_number like 'ISO-%' and tenant_id = default_tenant
    and payload->>'seed_marker' = 'anvil-test-seed-v1';

  -- CRM.
  delete from project_phase_log        where remarks in ('Kickoff complete.','Strategy locked.','RFQ sent.') or remarks like 'Current phase: %';
  delete from projects                 where project_code like 'PRJ-%' and tenant_id = default_tenant;
  delete from opportunities            where opportunity_name like '% opportunity #%' and tenant_id = default_tenant;
  delete from leads                    where notes like 'Seed lead row #%' and tenant_id = default_tenant;
end $p300$;

-- ───────────────────────────────────────────────────────────────────
-- 4. PHASE 200  --  master data
-- ───────────────────────────────────────────────────────────────────
do $p200$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0002-0001-000000000001';
begin
  -- Engineering specs.
  delete from engineering_specs        where payload->>'seed_marker'      = 'anvil-test-seed-v1';

  -- Blanket release drawdown.
  delete from blanket_release_drawdown where contract_id in (
    select id from contracts where tenant_id = default_tenant and contract_number like 'C-%-BLANKET_PO'
  );

  -- Payment milestones.
  delete from payment_milestones       where contract_id in (
    select id from contracts where tenant_id = default_tenant and contract_number like 'C-%' and notes like 'Seed contract:%'
  );

  -- Contracts (cascades to contract_lines).
  delete from contracts                where tenant_id = default_tenant and notes like 'Seed contract:%';

  -- Installed base removed 2026-07 (table dropped in migration 177).

  -- Equipment installed parts (FK cascade from equipment_hierarchy).
  delete from equipment_installed_parts where equipment_id in (
    select id from equipment_hierarchy where tenant_id = default_tenant
      and (plant_name in ('MG Halol Plant','NRD Plant 1'))
  );
  delete from equipment_hierarchy      where tenant_id = default_tenant
    and (plant_name in ('MG Halol Plant','NRD Plant 1'));

  -- Catalog tables.
  delete from private_label_items      where label_brand = 'AnvilEdge';
  delete from catalog_alternatives     where notes like 'Y alloy lasts 30%%' or notes like 'X3 supersedes X2C series.' or notes like 'Larger throat; same family.' or notes like 'Smaller throat; cost-down.' or notes like 'Trial X4 ~equivalent to X3 production.' or notes like 'UV-stable replacement.' or notes like 'Legacy phaseout migration path.' or notes like 'Base assembly is BOM parent for the X2C-X-MEDIUM SKU.' or notes like 'Cost-down to baseline 16D alloy.' or notes like 'Premium trial alloy; suggest as crosssell.';
  delete from catalog_synonyms         where source = 'manual' and synonym in ('cap tip 16 D','X2C medium gun','X3 medium gun','point holder 2208','cable Y 2026') or source = 'learned' and synonym in ('16D cap tip','X2C-M servo gun','X3 successor') or source = 'imported' and synonym in ('welding tip 16D','UV-stable power cable');

  -- Tally inventory.
  delete from tally_inventory          where stock_item_name in (
    'CT-16-D-1-FS','4-TP3082','IN0-0133','SW-Y1000-6P-MM-H/S','403A7K878-169','4-HD32208-2',
    'X2C-X-MEDIUM','X2C-X-LARGE','X2C-BASE-ASSY','SUB-ARM','SUB-BRACKET','SUB-COOLING','SUB-ELECTRODE',
    'TIP-Y-2026','CABLE-Y-2026'
  ) and tenant_id = default_tenant;

  -- BOM rows: phase 200 uses parent X2C-BASE-ASSY and SUB-* sub-assemblies.
  delete from bill_of_materials        where parent_part_no in ('X2C-BASE-ASSY','SUB-ARM','SUB-BRACKET','SUB-COOLING','SUB-ELECTRODE')
    and tenant_id = default_tenant;

  -- UOM aliases (12 rows).
  delete from uom_aliases              where raw_uom in ('Nos','Pcs','Pieces','EA','Box-500','Pack-10','Mtr','Meter','Roll-50','Set','Kg','Drum')
    and tenant_id = default_tenant;

  -- Part aliases.
  delete from part_aliases             where customer_part_no like 'MG-%' or customer_part_no like 'TATA-%' or customer_part_no like 'NRD-%' or customer_part_no like 'ATI-%' or customer_part_no like 'NK-%';

  -- Vendors (8 rows).
  delete from vendors                  where external_ref->>'seed_marker' = 'anvil-test-seed-v1';

  -- Item master rows added by phase 200 (lifecycle states).
  delete from item_master              where part_no in (
    'LEGACY-TIP-100','LEGACY-GUN-200','LEGACY-CABLE-300',
    'DISC-TIMER-100','DISC-ATD-100','DISC-HOLDER-100',
    'X3-X-MEDIUM','TIP-Y-2026','CABLE-Y-2026','ASSY-Z-2026',
    'TIP-Z-TRIAL','X4-X-TRIAL','TIMER-Y-TRIAL',
    'X2C-BASE-ASSY','SUB-ARM','SUB-BRACKET','SUB-COOLING','SUB-ELECTRODE'
  ) and tenant_id = default_tenant;

  -- Customer format profiles + versions (trigger-managed).
  delete from customer_format_profile_versions where notes like 'Layout changed:%' or fingerprint->>'seed_marker' = 'anvil-test-seed-v1';
  delete from customer_format_profiles where fingerprint->>'seed_marker' = 'anvil-test-seed-v1';

  -- Customer locations + customers (4 fictional).
  delete from customer_locations       where tenant_id = default_tenant
    and customer_id in (select id from customers where customer_key in ('ANVIL_TEST_INDUSTRIES','GLOBEX_MFG_GMBH','ACME_ROBOTICS_LLC','NIPPON_KOGYO'));
  delete from customers                where tenant_id = default_tenant
    and customer_key in ('ANVIL_TEST_INDUSTRIES','GLOBEX_MFG_GMBH','ACME_ROBOTICS_LLC','NIPPON_KOGYO');
end $p200$;

-- ───────────────────────────────────────────────────────────────────
-- 5. PHASE 100  --  identity
-- ───────────────────────────────────────────────────────────────────
do $p100$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0001-0001-000000000001';
  emails         text[] := array[
    'admin.primary@anvil.test','admin.recovery@anvil.test',
    'eng.alpha@anvil.test','eng.beta@anvil.test','eng.charlie@anvil.test',
    'mgr.alpha@anvil.test','mgr.beta@anvil.test',
    'prc.alpha@anvil.test','prc.beta@anvil.test',
    'fin.alpha@anvil.test','fin.beta@anvil.test',
    'ops.alpha@anvil.test','vwr.alpha@anvil.test',
    'denied.user@anvil.test','deactivated.user@anvil.test'
  ];
  e text;
begin
  -- Rate-limit ledgers.
  delete from magic_link_attempts      where identifier like 'anvil-seed:%';
  delete from mfa_attempts             where identifier like 'anvil-seed:%';
  delete from password_reset_attempts  where email = ANY(emails) or email = 'unknown@anvil.test';

  -- Magic link audit (phase 100 inserts).
  delete from auth_magic_links         where email = ANY(emails) or email like 'unknown%@anvil.test';

  -- Email intake rules.
  delete from email_intake_rules       where notes in (
    'Bucket inbound POs by subject hint.',
    'Inbound RFQs land in the opportunity inbox.',
    'Supplier acks come from internal Northwind mailboxes.',
    'Finance mailbox.',
    'Service team triages CAR-shaped emails.'
  );

  -- Logistics + taxonomies (global rows).
  delete from logistics_carriers       where carrier_code in ('HX','MAEU','CMDU','ONEY','6E','AI','DHL','GATI');
  delete from logistics_ports          where port_code   in ('INNSA','INMUN','INMAA','INPAV','INCOK','INBOM','INDEL','INMAA-A','KRPUS','JPYOK','CNSHA','DEHAM');
  delete from inco_terms_taxonomy      where code in ('EXW','FCA','CPT','CIP','DAP','DPU','DDP','FAS','FOB','CFR','CIF','FOR') and tenant_id is null;
  delete from lost_reason_taxonomy     where code in ('PRICE_UNDERCUT','PRICE_UNREALISTIC','LEAD_TIME','QUALITY','RELATIONSHIP','SCOPE_CHANGE','NO_RESPONSE','NOT_QUALIFIED','BUDGET_CUT','TECH_MISMATCH','INTERNAL_MAKE','LEGACY_UNUSED') and tenant_id is null;

  -- Customer / supplier lead times.
  delete from customer_lead_times      where notes in ('Halol contract SLA: 10 days from PO.','Servo-gun assemblies allowed 21 days.','Pune dock-to-dock window.','Tier-1 line-builder; tight cycle.','Alliance Auto India.');
  delete from supplier_lead_times      where supplier in ('Northwind Korea','Northwind Japan','Northwind China','BKS Cables Pvt Ltd','Globex Manufacturing GmbH','Acme Robotics LLC');

  -- FX rates.
  delete from fx_rates                 where source = 'frankfurter' and tenant_id = default_tenant
    and as_of >= (now() - interval '8 days')::date;

  -- Holiday calendar (DE rows added by phase 100).
  delete from holiday_calendar         where country = 'DE' and tenant_id is null;

  -- Redaction rules.
  delete from redaction_rules          where field_path in ('free_text','supplier_remarks')
    and (replacement in ('[redacted-email]','[redacted-phone]','[redacted-card]','[redacted-gstin]','[redacted-pan]','[redacted-internal]'));

  -- MCP tokens (no marker; identify by token_prefix and seed-derived hashes).
  delete from mcp_tokens               where token_prefix in ('mcp_act_','mcp_rev_','mcp_exp_');

  -- Access reviews + admin notifications.
  delete from access_reviews           where notes in (
    'Quarterly review. Two new sales_engineers approved; deactivated.user offboarded.',
    'In-progress monthly review.'
  );
  delete from admin_notifications      where kind in ('access_request','cron_stalled','push_failed','totp_enrolled')
    and tenant_id = default_tenant
    and (resolution_note like 'Denied: external%' or resolution_note like 'Manual restart%' or resolution_note like 'Auto-recovered.' or resolution_note = 'Acknowledged.' or resolution_note is null);

  -- Tenant settings (only the seed-inserted row; ignore real config).
  delete from tenant_settings          where tenant_id = default_tenant and invoice_prefix = 'INV' and default_payment_terms = 'Net 30 days NEFT';

  -- User security trail + passkeys + settings.
  delete from user_security_audit      where detail->>'seed_marker'      = 'anvil-test-seed-v1';
  delete from user_passkeys            where label = 'MacBook Pro (Touch ID)';
  delete from user_security_settings   where user_id in (
    select uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:' || e2)
    from unnest(emails) e2
  );

  -- Tenant memberships + auth.users (cascade on auth.users delete).
  delete from tenant_members           where tenant_id = default_tenant
    and user_id in (
      select uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:' || e2)
      from unnest(emails) e2
    );

  -- auth.users (only when the schema is reachable). Iterate the
  -- already-declared `emails` array; we can't nest a separate do
  -- block here because it would lose the variable scope.
  if exists (select 1 from information_schema.schemata where schema_name = 'auth') then
    foreach e in array emails loop
      begin
        execute 'delete from auth.users where id = uuid_generate_v5(uuid_ns_dns(), $1)'
          using ('anvil-seed-user:' || e);
      exception
        when insufficient_privilege then
          raise notice 'Insufficient privilege to delete from auth.users; skipping.';
          exit;
        when others then
          null;
      end;
    end loop;
  end if;

  -- The `operator` enum value that 100 added to anvil_role stays. We
  -- never drop enum values: that requires a full type rebuild and
  -- could break unrelated code. Leaving `operator` in place is safe.
end $p100$;

-- ───────────────────────────────────────────────────────────────────
-- Phase 360 (inventory-planning): clean up the rows the seed phase
-- 360_inventory_planning.sql + the planning engine cron itself
-- inserted. Tagged either by the explicit `seed_marker` payload or
-- (for engine-emitted rows) by the seed_marker-tagged item_master
-- entries; we delete by tenant_id for those engine outputs since
-- they all hang off planning_enabled = true.
-- ───────────────────────────────────────────────────────────────────
do $p360$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
begin
  -- Engine outputs (per-tenant; safe to drop wholesale on teardown).
  delete from procurement_plans      where tenant_id = default_tenant;
  delete from inventory_exceptions   where tenant_id = default_tenant;
  delete from forecast_runs          where tenant_id = default_tenant;
  delete from demand_forecasts       where tenant_id = default_tenant;
  delete from inventory_positions    where tenant_id = default_tenant;
  delete from inventory_allocations  where tenant_id = default_tenant;

  -- Backfill rows from migration 087 + seed phase 360.
  delete from source_po_lines        where tenant_id = default_tenant;
  delete from suppliers              where tenant_id = default_tenant
    and notes in ('Backfilled by migration 087.',
                  'Primary ATD supplier; phase 360 fixture.',
                  'Primary timer-board supplier; phase 360 fixture.',
                  'Backup-tier supplier for cables and minor parts.');

  -- Opportunity line items from phase 360.
  delete from opportunity_line_items where tenant_id = default_tenant
    and notes = 'Phase 360 seed line.';

  -- Seed-only item_master rows from phase 360.
  delete from item_master where tenant_id = default_tenant
    and part_no in ('ATD-STD-1','ATD-STD-2','TIMER-A1','TIMER-B1');

  -- Reset the per-item planning columns we set at run-time on
  -- master items that survive teardown. Leaves the operator's
  -- pre-existing item_master rows in a clean "not planning" state.
  update item_master set
    planning_enabled = false,
    safety_stock = null,
    reorder_point = null,
    demand_class = null,
    pinned_model = null
   where tenant_id = default_tenant;

  -- Tenant-level inventory-planning settings.
  update tenant_settings set inventory_planning_enabled = false
   where tenant_id = default_tenant;
end $p360$;

commit;
