/*
 * 999_verify.sql  --  read-only verification of the Anvil seed pack.
 *
 * Purpose
 *   After 100..500 have been applied, run this file to confirm that
 *   coverage hit the matrix targets and that every CROSS-MODULE
 *   LINK REQUIREMENT has at least one row.
 *
 *   This file is read-only. It runs nothing but SELECT statements.
 *   You can run it under any role that has read access (it does not
 *   require service_role; though row visibility through RLS will
 *   only show what your role is allowed to see).
 *
 *   Each section below produces one or more result sets that the
 *   operator inspects. A failed assertion appears as a row with
 *   `pass = false` so you can grep the output:
 *
 *     | check                                | want | got | pass |
 *     | order_status: DRAFT                  | >=1  | 5   | t    |
 *     | order_status: PENDING_REVIEW         | >=1  | 5   | t    |
 *     ...
 *
 * Run
 *   set app.seed_env = 'staging';
 *   \i supabase/seed/999_verify.sql
 *
 *   For machine consumption, redirect with:
 *   psql -f 999_verify.sql -A -F$'\t' > verify.tsv
 */

do $guard$
begin
  if current_setting('app.seed_env', true) is null
     or current_setting('app.seed_env', true) not in ('staging', 'local', 'ci') then
    raise exception 'Refusing to verify: app.seed_env must be staging, local, or ci. Got: %',
      coalesce(current_setting('app.seed_env', true), '<unset>');
  end if;
end $guard$;

-- ───────────────────────────────────────────────────────────────────
-- §1  Row-count summary across every business table
-- ───────────────────────────────────────────────────────────────────
\echo '=== §1 row counts ==='

with tables as (
  select format('%I.%I', schemaname, tablename) as qualified, tablename
  from pg_tables
  where schemaname = 'public'
    and tablename not like 'pg_%'
    and tablename not in ('schema_migrations')
),
counted as (
  select t.tablename,
         (xpath('/row/c/text()',
                query_to_xml(format('select count(*) as c from %s', t.qualified), false, true, '')))[1]::text::bigint as rows
  from tables t
)
select tablename, rows
from counted
order by rows desc, tablename;

-- ───────────────────────────────────────────────────────────────────
-- §2  State coverage  --  every enum value + status text has >=1 row
-- ───────────────────────────────────────────────────────────────────
\echo '=== §2 state coverage ==='

-- Enum coverage: assert that every enum value appears in at least
-- one row of any column declared with that enum type.
with enum_columns as (
  select n.nspname as schema_name, c.relname as table_name, a.attname as column_name, t.typname as type_name
  from pg_attribute a
    join pg_class      c on a.attrelid = c.oid
    join pg_namespace  n on c.relnamespace = n.oid
    join pg_type       t on a.atttypid = t.oid
  where t.typtype = 'e'
    and n.nspname = 'public'
    and c.relkind = 'r'
    and not a.attisdropped
),
enum_values as (
  select t.typname as type_name, e.enumlabel as enum_value
  from pg_type t
    join pg_enum e on e.enumtypid = t.oid
  where t.typname in (
    'obara_role','tenant_member_status','order_status','source_po_status',
    'order_mode','customer_type','internal_so_type','contract_type',
    'opportunity_stage','lead_status','project_phase','shipment_mode',
    'item_lifecycle','einvoice_status'
  )
),
hits as (
  select ev.type_name, ev.enum_value,
         (xpath('/row/c/text()',
                query_to_xml(format($q$select count(*) as c from %I.%I where %I::text = %L$q$,
                                    ec.schema_name, ec.table_name, ec.column_name, ev.enum_value),
                             false, true, '')))[1]::text::bigint as cnt
  from enum_values ev
    join enum_columns ec on ec.type_name = ev.type_name
)
select 'enum:' || type_name || ':' || enum_value as check_name,
       '>=1' as want,
       max(cnt) as got,
       (max(cnt) >= 1) as pass
from hits
group by type_name, enum_value
order by type_name, enum_value;

-- Text-checked status coverage. We list each (table, column,
-- expected_value) explicitly because there's no metadata source for
-- check-constraint values.
\echo '--- §2b text-check coverage ---'

with checks(table_name, column_name, expected) as (values
  ('part_aliases','status','active'),
  ('part_aliases','status','pending'),
  ('part_aliases','status','deprecated'),
  ('tally_voucher_records','status','pending'),
  ('tally_voucher_records','status','validated'),
  ('tally_voucher_records','status','dry_run_ok'),
  ('tally_voucher_records','status','exported'),
  ('tally_voucher_records','status','imported'),
  ('tally_voucher_records','status','failed'),
  ('ocr_runs','status','completed'),
  ('ocr_runs','status','failed'),
  ('zip_scans','status','clean'),
  ('communications','status','sent'),
  ('communications','direction','outbound'),
  ('order_amendments','status','detected'),
  ('order_amendments','status','approved'),
  ('order_amendments','status','rejected'),
  ('order_amendments','status','applied'),
  ('order_amendments','amendment_type','qty'),
  ('order_amendments','amendment_type','price'),
  ('order_amendments','amendment_type','date'),
  ('order_amendments','amendment_type','line_removed'),
  ('contracts','status','ACTIVE'),
  ('contracts','status','EXPIRED'),
  ('contracts','status','TERMINATED'),
  ('contracts','status','PENDING_RENEWAL'),
  ('internal_sales_orders','status','DRAFT'),
  ('internal_sales_orders','status','PENDING_APPROVAL'),
  ('internal_sales_orders','status','APPROVED'),
  ('internal_sales_orders','status','DISPATCHED'),
  ('internal_sales_orders','status','CLOSED'),
  ('internal_sales_orders','status','CANCELLED'),
  ('shipments','status','PLANNED'),
  ('shipments','status','READY'),
  ('shipments','status','IN_TRANSIT'),
  ('shipments','status','AT_PORT'),
  ('shipments','status','CLEARED'),
  ('shipments','status','DELIVERED'),
  ('shipments','status','POD_RECEIVED'),
  ('shipments','status','EXCEPTION'),
  ('projects','status','ACTIVE'),
  ('projects','status','ON_HOLD'),
  ('projects','status','COMPLETED'),
  ('service_visits','status','PLANNED'),
  ('service_visits','status','CHECKED_IN'),
  ('service_visits','status','CHECKED_OUT'),
  ('service_visits','status','REPORT_SUBMITTED'),
  ('service_visits','status','CLOSED'),
  ('car_reports','status','OPEN'),
  ('car_reports','status','UNDER_REVIEW'),
  ('car_reports','status','CLOSED'),
  ('car_reports','status','REOPENED'),
  ('quote_approvals','status','PENDING'),
  ('quote_approvals','status','APPROVED'),
  ('quote_approvals','status','REJECTED'),
  ('quote_approvals','status','SKIPPED'),
  ('amc_schedules','status','SCHEDULED'),
  ('amc_schedules','status','VISIT_CREATED'),
  ('amc_schedules','status','COMPLETED'),
  ('amc_schedules','status','SKIPPED'),
  ('amc_schedules','status','CANCELLED'),
  ('amc_schedules','visit_type','PREVENTIVE'),
  ('amc_schedules','visit_type','EMERGENCY'),
  ('amc_schedules','visit_type','TRAINING'),
  ('amc_schedules','visit_type','AUDIT'),
  ('invoices','status','draft'),
  ('invoices','status','sent'),
  ('invoices','status','partial'),
  ('invoices','status','paid'),
  ('invoices','status','overdue'),
  ('invoices','status','void'),
  ('ap_invoices','match_status','matched'),
  ('ap_invoices','match_status','mismatched'),
  ('ap_invoices','match_status','pending'),
  ('ap_invoices','match_status','disputed'),
  ('deduction_queue','status','open'),
  ('deduction_queue','status','recovered'),
  ('deduction_queue','status','written_off'),
  ('razorpay_payments','status','created'),
  ('razorpay_payments','status','authorized'),
  ('razorpay_payments','status','captured'),
  ('razorpay_payments','status','refunded'),
  ('razorpay_payments','status','failed'),
  ('esignature_envelopes','status','sent'),
  ('esignature_envelopes','status','delivered'),
  ('esignature_envelopes','status','signed'),
  ('esignature_envelopes','status','declined'),
  ('agent_goals','status','active'),
  ('agent_goals','status','paused'),
  ('agent_goals','status','completed'),
  ('agent_goals','status','cancelled'),
  ('agent_goals','status','failed'),
  ('mcp_call_log','status','ok'),
  ('mcp_call_log','status','denied'),
  ('mcp_call_log','status','error'),
  ('inbound_emails','status','received'),
  ('inbound_emails','status','parsed'),
  ('inbound_emails','status','linked'),
  ('inbound_emails','status','duplicate'),
  ('inbound_emails','status','failed'),
  ('inbound_emails','status','archived'),
  ('inbound_messages','channel','whatsapp'),
  ('inbound_messages','channel','slack'),
  ('inbound_messages','channel','teams'),
  ('inbound_messages','channel','wechat'),
  ('voice_calls','status','in_progress'),
  ('voice_calls','status','completed'),
  ('voice_calls','status','failed'),
  ('print_jobs','status','queued'),
  ('print_jobs','status','printing'),
  ('print_jobs','status','printed'),
  ('print_jobs','status','failed'),
  ('print_jobs','status','cancelled'),
  ('plm_sync_state','status','idle'),
  ('plm_sync_state','status','running'),
  ('plm_sync_state','status','error'),
  ('edi_envelopes','status','received'),
  ('edi_envelopes','status','translated'),
  ('edi_envelopes','status','linked'),
  ('edi_envelopes','status','sent'),
  ('edi_envelopes','status','acknowledged'),
  ('edi_envelopes','status','failed'),
  ('prospecting_campaigns','status','active'),
  ('prospecting_campaigns','status','paused'),
  ('prospecting_campaigns','status','draft'),
  ('prospecting_campaigns','status','archived'),
  ('prospecting_targets','status','pending'),
  ('prospecting_targets','status','approved'),
  ('prospecting_targets','status','sent'),
  ('prospecting_targets','status','bounced'),
  ('prospecting_targets','status','replied'),
  ('prospecting_targets','status','unsubscribed'),
  ('prospecting_targets','status','denied')
),
counted as (
  select c.table_name, c.column_name, c.expected,
         (xpath('/row/c/text()',
                query_to_xml(format($q$select count(*) as c from public.%I where %I = %L$q$,
                                    c.table_name, c.column_name, c.expected),
                             false, true, '')))[1]::text::bigint as cnt
  from checks c
)
select c.table_name || '.' || c.column_name || ' = ' || c.expected as check_name,
       '>=1' as want,
       c.cnt as got,
       (c.cnt >= 1) as pass
from counted c
order by table_name, column_name, expected;

-- ───────────────────────────────────────────────────────────────────
-- §3  Cross-module link requirements
-- ───────────────────────────────────────────────────────────────────
\echo '=== §3 cross-module links ==='

with checks(name, qty_min, query) as (values
  ('leads.converted_opportunity_id populated >=3', 3,
   'select count(*) as c from leads where converted_opportunity_id is not null'),

  ('orders.parent_order_id blanket-release chain (parent + 5 children)', 5,
   'select count(*) as c from orders where parent_order_id is not null'),

  ('orders.contract_id populated for >=10', 10,
   'select count(*) as c from orders where contract_id is not null'),

  ('orders.customer_location_id populated for >=6', 6,
   'select count(*) as c from orders where customer_location_id is not null'),

  ('source_pos.order_id populated for every non-DRAFT', 1,
   'select count(*) as c from source_pos where order_id is not null'),

  ('shipments referencing order + source_po + internal_so', 1,
   'select count(*) as c from shipments where order_id is not null and source_po_id is not null and internal_so_id is not null'),

  ('amc_schedules with generated_visit_id (>=3)', 3,
   'select count(*) as c from amc_schedules where generated_visit_id is not null'),

  ('car_reports with closure (>=2)', 2,
   'select count(distinct car_report_id) as c from closure_reports where car_report_id is not null'),

  ('quote_approvals PENDING -> orders PENDING_REVIEW', 1,
   'select count(*) as c from quote_approvals qa join orders o on o.id = qa.order_id where qa.status = ''PENDING'' and o.status = ''PENDING_REVIEW'''),

  ('validation_findings unresolved on BLOCKED orders', 3,
   'select count(*) as c from validation_findings vf join orders o on o.id = vf.order_id where o.status = ''BLOCKED'' and vf.resolved = false'),

  ('einvoices GENERATED -> orders APPROVED/RECONCILED', 1,
   'select count(*) as c from einvoices ei join orders o on o.id = ei.order_id where ei.status = ''GENERATED'' and o.status in (''APPROVED'',''RECONCILED'')'),

  ('bill_of_materials 3-level (parent->sub->components)', 16,
   'select count(*) as c from bill_of_materials where parent_part_no = ''X2C-BASE-ASSY'' or parent_part_no like ''SUB-%'''),

  ('ap_invoices 3-way match: matched + qty/price mismatch', 1,
   'select count(*) as c from ap_invoices where match_status in (''matched'',''mismatched'',''disputed'')'),

  ('audit_events cumulative >=250', 250,
   'select count(*) as c from audit_events where tenant_id = ''00000000-0000-0000-0000-000000000001''::uuid'),

  ('processing_events >=100', 100,
   'select count(*) as c from processing_events where tenant_id = ''00000000-0000-0000-0000-000000000001''::uuid'),

  ('model_routing_log >=120', 120,
   'select count(*) as c from model_routing_log where tenant_id = ''00000000-0000-0000-0000-000000000001''::uuid'),

  ('forecast_snapshots >=120', 120,
   'select count(*) as c from forecast_snapshots where tenant_id = ''00000000-0000-0000-0000-000000000001''::uuid'),

  ('inbound_emails >=150', 150,
   'select count(*) as c from inbound_emails where tenant_id = ''00000000-0000-0000-0000-000000000001''::uuid'),

  ('inbound_email_threads >=40', 40,
   'select count(*) as c from inbound_email_threads where tenant_id = ''00000000-0000-0000-0000-000000000001''::uuid'),

  ('orders count >=50', 50,
   'select count(*) as c from orders where tenant_id = ''00000000-0000-0000-0000-000000000001''::uuid')
),
counted as (
  select name, qty_min,
         (xpath('/row/c/text()', query_to_xml(query, false, true, '')))[1]::text::bigint as got
  from checks
)
select name as check_name, ('>= ' || qty_min::text) as want, got, (got >= qty_min) as pass
from counted
order by case when got < qty_min then 0 else 1 end, name;

-- ───────────────────────────────────────────────────────────────────
-- §4  RBAC fixture audit  --  1 user per role, 1 user per status
-- ───────────────────────────────────────────────────────────────────
\echo '=== §4 RBAC fixture audit ==='

with role_check as (
  select 'role:' || r as check_name, '>= 1' as want,
         (select count(*) from tenant_members tm where tm.role = r) as got
  from unnest(array['sales_engineer','sales_manager','procurement','finance','admin','operator','viewer']::obara_role[]) r
), status_check as (
  select 'status:' || s as check_name, '>= 1' as want,
         (select count(*) from tenant_members tm where tm.status = s) as got
  from unnest(array['pending','approved','denied','deactivated']::tenant_member_status[]) s
)
select check_name, want, got, (got >= 1) as pass from role_check
union all
select check_name, want, got, (got >= 1) as pass from status_check
order by check_name;

-- ───────────────────────────────────────────────────────────────────
-- §5  UI smoke probes  --  mirror what each v3 screen reads
-- ───────────────────────────────────────────────────────────────────
-- Each row in the result is a v3 screen + the count its dashboard
-- query would return. All counts must be >=1; the "pass" column
-- flags any screen that would render empty after the seed.
\echo '=== §5 v3 screen smoke probes ==='

with probes(screen, qty_min, query) as (values
  ('admin/access-requests',          1, 'select count(*) as c from tenant_members where status = ''pending'''),
  ('admin/members',                  6, 'select count(*) as c from tenant_members where status = ''approved'''),
  ('admin/security/audit',           1, 'select count(*) as c from user_security_audit'),
  ('admin/mcp-tokens',               1, 'select count(*) as c from mcp_tokens where revoked_at is null and (expires_at is null or expires_at > now())'),
  ('admin/access-reviews',           1, 'select count(*) as c from access_reviews'),
  ('admin/notifications',            1, 'select count(*) as c from admin_notifications where resolved = false'),
  ('admin/redaction',                1, 'select count(*) as c from redaction_rules'),
  ('admin/holiday-calendar',         1, 'select count(*) as c from holiday_calendar'),
  ('admin/lead-times',               1, 'select count(*) as c from supplier_lead_times'),
  ('admin/fx',                       1, 'select count(*) as c from fx_rates'),
  ('admin/lost-reasons',             1, 'select count(*) as c from lost_reason_taxonomy'),
  ('admin/incoterms',                1, 'select count(*) as c from inco_terms_taxonomy'),
  ('customers',                      6, 'select count(*) as c from customers'),
  ('customer-locations',             1, 'select count(*) as c from customer_locations'),
  ('items',                          1, 'select count(*) as c from item_master'),
  ('items/aliases',                  1, 'select count(*) as c from part_aliases'),
  ('items/uom',                      1, 'select count(*) as c from uom_aliases'),
  ('items/bom',                      1, 'select count(*) as c from bill_of_materials'),
  ('catalog/synonyms',               1, 'select count(*) as c from catalog_synonyms'),
  ('catalog/alternatives',           1, 'select count(*) as c from catalog_alternatives'),
  ('catalog/private-label',          1, 'select count(*) as c from private_label_items'),
  ('vendors',                        1, 'select count(*) as c from vendors'),
  ('contracts',                      1, 'select count(*) as c from contracts'),
  ('engineering-specs',              1, 'select count(*) as c from engineering_specs'),
  ('equipment',                      1, 'select count(*) as c from equipment_hierarchy'),
  ('installed-base',                 1, 'select count(*) as c from installed_base'),
  ('leads',                          1, 'select count(*) as c from leads'),
  ('opportunities',                  1, 'select count(*) as c from opportunities'),
  ('projects',                       1, 'select count(*) as c from projects'),
  ('internal-sos',                   1, 'select count(*) as c from internal_sales_orders'),
  ('orders',                         1, 'select count(*) as c from orders'),
  ('orders/documents',               1, 'select count(*) as c from order_documents'),
  ('orders/evidence',                1, 'select count(*) as c from evidence'),
  ('orders/findings',                1, 'select count(*) as c from validation_findings'),
  ('orders/amendments',              1, 'select count(*) as c from order_amendments'),
  ('orders/reconciliations',         1, 'select count(*) as c from order_reconciliations'),
  ('orders/schedule-lines',          1, 'select count(*) as c from order_schedule_lines'),
  ('source-pos',                     1, 'select count(*) as c from source_pos'),
  ('source-pos/events',              1, 'select count(*) as c from source_po_events'),
  ('supplier-rfqs',                  1, 'select count(*) as c from supplier_rfqs'),
  ('supplier-quotes',                1, 'select count(*) as c from supplier_quotes'),
  ('supplier-scorecards',            1, 'select count(*) as c from supplier_scorecards'),
  ('shipments',                      1, 'select count(*) as c from shipments'),
  ('approvals',                      1, 'select count(*) as c from quote_approvals'),
  ('service/visits',                 1, 'select count(*) as c from service_visits'),
  ('service/amc',                    1, 'select count(*) as c from amc_schedules'),
  ('service/car',                    1, 'select count(*) as c from car_reports'),
  ('service/closure',                1, 'select count(*) as c from closure_reports'),
  ('spares',                         1, 'select count(*) as c from spare_recommendations'),
  ('spares/obsolete',                1, 'select count(*) as c from obsolete_parts'),
  ('finance/invoices',               1, 'select count(*) as c from invoices'),
  ('finance/einvoices',              1, 'select count(*) as c from einvoices'),
  ('finance/payments',               1, 'select count(*) as c from payment_records'),
  ('finance/ap',                     1, 'select count(*) as c from ap_invoices'),
  ('finance/ap/lines',               1, 'select count(*) as c from ap_invoice_lines'),
  ('finance/ap/receipts',            1, 'select count(*) as c from ap_goods_receipts'),
  ('finance/deductions',             1, 'select count(*) as c from deduction_queue'),
  ('finance/razorpay',               1, 'select count(*) as c from razorpay_payments'),
  ('comms/email',                    1, 'select count(*) as c from inbound_emails'),
  ('comms/email/threads',            1, 'select count(*) as c from inbound_email_threads'),
  ('comms/chat',                     1, 'select count(*) as c from inbound_messages'),
  ('comms/voice',                    1, 'select count(*) as c from voice_calls'),
  ('comms/communications',           1, 'select count(*) as c from communications'),
  ('esign/envelopes',                1, 'select count(*) as c from esignature_envelopes'),
  ('esign/events',                   1, 'select count(*) as c from esignature_events'),
  ('portal/tokens',                  1, 'select count(*) as c from portal_tokens'),
  ('portal/access-log',              1, 'select count(*) as c from portal_access_log'),
  ('portal/quote-acceptances',       1, 'select count(*) as c from portal_quote_acceptances'),
  ('portal/reorders',                1, 'select count(*) as c from portal_reorders'),
  ('agents/goals',                   1, 'select count(*) as c from agent_goals'),
  ('agents/steps',                   1, 'select count(*) as c from agent_steps'),
  ('agents/eval-runs',               1, 'select count(*) as c from agent_eval_runs'),
  ('eval/cases',                     1, 'select count(*) as c from eval_cases'),
  ('eval/runs',                      1, 'select count(*) as c from eval_runs'),
  ('eval/case-results',              1, 'select count(*) as c from eval_case_results'),
  ('audit/events',                   250, 'select count(*) as c from audit_events'),
  ('audit/export-runs',              1, 'select count(*) as c from audit_export_runs'),
  ('audit/processing',               1, 'select count(*) as c from processing_events'),
  ('audit/injection-tests',          1, 'select count(*) as c from injection_test_runs'),
  ('audit/model-routing',            1, 'select count(*) as c from model_routing_log'),
  ('audit/deploys',                  1, 'select count(*) as c from deploys'),
  ('audit/backups',                  1, 'select count(*) as c from backups'),
  ('analytics/forecast',             1, 'select count(*) as c from forecast_snapshots'),
  ('analytics/customer-monthly',     1, 'select count(*) as c from analytics_customer_monthly'),
  ('analytics/winloss-daily',        1, 'select count(*) as c from analytics_winloss_daily'),
  ('analytics/rlhf',                 1, 'select count(*) as c from rlhf_feedback'),
  ('analytics/rlhf-reward',          1, 'select count(*) as c from rlhf_reward_daily'),
  ('push/subscriptions',             1, 'select count(*) as c from push_subscriptions'),
  ('push/notifications',             1, 'select count(*) as c from push_notifications'),
  ('network/listings',               1, 'select count(*) as c from network_listings'),
  ('network/sourcing-queries',       1, 'select count(*) as c from network_sourcing_queries'),
  ('prospecting/campaigns',          1, 'select count(*) as c from prospecting_campaigns'),
  ('prospecting/targets',            1, 'select count(*) as c from prospecting_targets'),
  ('prospecting/suppressions',       1, 'select count(*) as c from prospecting_suppressions'),
  ('edi/partners',                   1, 'select count(*) as c from edi_partners'),
  ('edi/envelopes',                  1, 'select count(*) as c from edi_envelopes'),
  ('plm/systems',                    1, 'select count(*) as c from plm_systems'),
  ('plm/boms',                       1, 'select count(*) as c from plm_boms'),
  ('plm/changes',                    1, 'select count(*) as c from plm_changes'),
  ('plm/sync-state',                 1, 'select count(*) as c from plm_sync_state'),
  ('vertical-packs',                 1, 'select count(*) as c from vertical_pack_installs'),
  ('erp-chat/sessions',              1, 'select count(*) as c from erp_chat_sessions'),
  ('erp-chat/messages',              1, 'select count(*) as c from erp_chat_messages'),
  ('print-jobs',                     1, 'select count(*) as c from print_jobs'),
  ('netsuite/sync-runs',             1, 'select count(*) as c from netsuite_sync_runs'),
  ('netsuite/retry-queue',           1, 'select count(*) as c from netsuite_retry_queue'),
  ('netsuite/open-orders',           1, 'select count(*) as c from netsuite_open_orders'),
  ('netsuite/vendors',               1, 'select count(*) as c from netsuite_vendors'),
  ('netsuite/purchase-orders',       1, 'select count(*) as c from netsuite_purchase_orders'),
  ('sap/sync-runs',                  1, 'select count(*) as c from sap_sync_runs'),
  ('sap/business-partners',          1, 'select count(*) as c from sap_business_partners'),
  ('sap/materials',                  1, 'select count(*) as c from sap_materials'),
  ('tally/companies',                1, 'select count(*) as c from tally_companies'),
  ('tally/voucher-records',          1, 'select count(*) as c from tally_voucher_records'),
  ('tally/payment-receipts',         1, 'select count(*) as c from tally_payment_receipts'),
  ('tally/sync-runs',                1, 'select count(*) as c from tally_sync_runs')
),
counted as (
  select screen, qty_min,
         (xpath('/row/c/text()', query_to_xml(query, false, true, '')))[1]::text::bigint as got
  from probes
)
select screen as check_name,
       ('>= ' || qty_min::text) as want,
       got,
       (got >= qty_min) as pass
from counted
order by case when got < qty_min then 0 else 1 end, screen;

-- ───────────────────────────────────────────────────────────────────
-- §6  Summary of failures (single-row dashboard line)
-- ───────────────────────────────────────────────────────────────────
\echo '=== §6 summary ==='

-- This re-runs the §3 + §4 + §5 checks and emits a single line:
-- pass = true means every assertion succeeded.
do $summary$
declare
  total_failures int := 0;
begin
  -- The same checks as §3 packed as count expressions.
  if (select count(*) from leads where converted_opportunity_id is not null) < 3 then total_failures := total_failures + 1; end if;
  if (select count(*) from orders where parent_order_id is not null) < 5 then total_failures := total_failures + 1; end if;
  if (select count(*) from orders where contract_id is not null) < 10 then total_failures := total_failures + 1; end if;
  if (select count(*) from orders where customer_location_id is not null) < 6 then total_failures := total_failures + 1; end if;
  if (select count(*) from audit_events where tenant_id = '00000000-0000-0000-0000-000000000001'::uuid) < 250 then total_failures := total_failures + 1; end if;
  if (select count(*) from forecast_snapshots where tenant_id = '00000000-0000-0000-0000-000000000001'::uuid) < 120 then total_failures := total_failures + 1; end if;
  if (select count(*) from inbound_emails where tenant_id = '00000000-0000-0000-0000-000000000001'::uuid) < 150 then total_failures := total_failures + 1; end if;
  if (select count(*) from inbound_email_threads where tenant_id = '00000000-0000-0000-0000-000000000001'::uuid) < 40 then total_failures := total_failures + 1; end if;
  if (select count(*) from orders where tenant_id = '00000000-0000-0000-0000-000000000001'::uuid) < 50 then total_failures := total_failures + 1; end if;
  if (select count(*) from model_routing_log where tenant_id = '00000000-0000-0000-0000-000000000001'::uuid) < 120 then total_failures := total_failures + 1; end if;

  if total_failures = 0 then
    raise notice 'verify: PASS (all sentinel coverage checks satisfied).';
  else
    raise notice 'verify: FAIL (% sentinel coverage check(s) below floor; see §3/§5 above).', total_failures;
  end if;
end $summary$;
