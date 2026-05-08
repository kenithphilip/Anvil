/*
 * 350_recent_modules.sql  --  Phase 3.5 of the Anvil seed pack.
 *
 * Purpose
 *   Cover the modules that landed in PRs 50-63 (May 2026) that
 *   the original 100..500 seed pack pre-dates. Empty-data screens
 *   were the symptom: the Quotes screen, the credit-notes screen,
 *   the e-Way bills screen, the recurring-invoices screen, the
 *   voice operator screen all rendered with no rows because the
 *   underlying tables had no seed rows.
 *
 *   This file inserts representative fixtures into:
 *     - quotes (PR #52, migration 068)              ~10 rows
 *     - customer_contacts (migration 065)            3 per customer
 *     - credit_notes (Phase 7.5, migration 072)     ~6 rows
 *     - eway_bills (Phase 7.7, migration 074)       ~5 rows
 *     - recurring_invoice_schedules (Phase 7.6,
 *       migration 073)                              ~4 rows
 *     - deploy_events (PR #57, migration 079)       ~12 rows
 *     - voice_consent (PR #58, migration 080)       ~6 rows
 *     - voice_dnd_list (PR #58, migration 080)      ~4 rows
 *     - extraction_corrections (migration 029)      ~10 rows
 *
 * Prerequisites
 *   - Migrations 001..084 applied.
 *   - supabase/seed.sql applied (default tenant + corpus customers
 *     + items).
 *   - Phases 100, 200, 300 applied (auth users, customers,
 *     orders, invoices that this file references via FK).
 *   - Run as service_role with `set app.seed_env = 'staging';`.
 *
 * Idempotency
 *   `on conflict ... do nothing` everywhere. Every UUID derived
 *   via uuid_generate_v5 with this phase's namespace.
 *
 * Phase namespace
 *   d7a7e5e4-0001-0035-0001-000000000001
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

-- Bug fix May 2026: the original block was malformed. The other
-- phase files (200, 300, 500, 900) use a single `do $role$ begin
-- ... end $role$;` block with the set-role guard nested inside;
-- this file had the begin on a separate line which made psql
-- read `end $role$;` as a stray `end` keyword and bail out with
-- `syntax error at or near "end"`. Match the canonical shape.
do $role$ begin
  begin set local role 'postgres'; exception when others then null; end;
end $role$;

-- ───────────────────────────────────────────────────────────────────
-- 1. customer_contacts  --  3 contacts per corpus customer
-- ───────────────────────────────────────────────────────────────────
do $contacts$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0035-0001-000000000001';
  cust           record;
  domain         text;
  contact_idx    int;
  roles          text[] := array['Procurement', 'Accounts Payable', 'Engineering'];
  fnames         text[] := array['Anjali', 'Vikram', 'Priya'];
  lnames         text[] := array['Sharma', 'Kapoor', 'Iyer'];
begin
  for cust in
    select id, customer_key, customer_name, contact_email
    from customers
    where tenant_id = default_tenant
  loop
    domain := coalesce(split_part(cust.contact_email, '@', 2), lower(replace(cust.customer_key, '_', '-')) || '.example');
    for contact_idx in 1..3 loop
      -- Bug fix May 2026: customer_contacts has no `metadata`
      -- column; the seed marker lands in `external_ref` (jsonb)
      -- which is already on the table per migration 065. The
      -- column was originally for ERP-side row pointers, but
      -- nothing else writes to it on tenant-scoped seeded rows
      -- and the schema accepts arbitrary jsonb so a seed_marker
      -- key is harmless.
      insert into customer_contacts (
        id, tenant_id, customer_id, name, email, phone, role, is_primary, external_ref
      ) values (
        uuid_generate_v5(ns, 'contact:' || cust.customer_key || ':' || contact_idx),
        default_tenant,
        cust.id,
        fnames[contact_idx] || ' ' || lnames[contact_idx],
        lower(fnames[contact_idx]) || '.' || lower(lnames[contact_idx]) || '@' || domain,
        '+91' || (9000000000 + (hashtext(cust.customer_key || '/' || contact_idx::text) % 999999999))::text,
        roles[contact_idx],
        contact_idx = 1,
        jsonb_build_object('seed_marker', 'anvil-test-seed-v1', 'phase', 350)
      )
      on conflict (id) do nothing;
    end loop;
  end loop;
end $contacts$;

-- ───────────────────────────────────────────────────────────────────
-- 2. quotes  --  one per quote_status enum value, plus a revision
--                chain on the SENT version
-- ───────────────────────────────────────────────────────────────────
do $quotes$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0035-0001-000000000001';
  alpha          uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:eng.alpha@anvil.test');
  cust_id        uuid;
  contact_id     uuid;
  base_lines     jsonb := jsonb_build_array(
    jsonb_build_object('partNumber', 'BR-6204-2RS', 'description', 'Deep groove bearing 20x47x14',  'quantity', 100, 'unitPrice',   140, 'uom', 'pcs'),
    jsonb_build_object('partNumber', '22214-E1-XL', 'description', 'Spherical roller bearing',     'quantity',  20, 'unitPrice', 3800, 'uom', 'pcs'),
    jsonb_build_object('partNumber', 'OS-25-42-7',  'description', 'Oil seal 25x42x7',            'quantity', 250, 'unitPrice',   17.20, 'uom', 'pcs')
  );
  statuses       text[] := array['DRAFT', 'PENDING_INTERNAL_APPROVAL', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CONVERTED', 'CANCELLED'];
  s              text;
  i              int := 0;
  expires        timestamptz;
  parent_id      uuid;
begin
  -- Anchor on the corpus customer MG_MOTOR_INDIA + its primary contact.
  select id into cust_id from customers where tenant_id = default_tenant and customer_key = 'MG_MOTOR_INDIA' limit 1;
  if cust_id is null then return; end if;
  select id into contact_id
    from customer_contacts
    where tenant_id = default_tenant and customer_id = cust_id
    order by is_primary desc, created_at asc limit 1;

  foreach s in array statuses loop
    i := i + 1;
    expires := now() + ((i * 30) || ' days')::interval;
    insert into quotes (
      id, tenant_id, customer_id, customer_contact_id,
      quote_number, version, status,
      currency, subtotal, tax_total, grand_total,
      validity_days, expires_at,
      sent_at, sent_via, accepted_at, accepted_by_email, accepted_signature_name,
      declined_at, declined_reason, converted_at, cancelled_at,
      terms, notes, line_items, created_by, created_at
    ) values (
      uuid_generate_v5(ns, 'quote:' || s),
      default_tenant, cust_id, contact_id,
      'Q-2026-' || lpad(i::text, 4, '0'),
      1, s::quote_status,
      'INR',
      88340.00, 15901.20, 104241.20,
      30, expires,
      case when s in ('SENT','ACCEPTED','DECLINED','EXPIRED','CONVERTED') then now() - ((i * 2) || ' days')::interval end,
      case when s in ('SENT','ACCEPTED','DECLINED','EXPIRED','CONVERTED') then 'email' end,
      case when s = 'ACCEPTED' or s = 'CONVERTED' then now() - '1 day'::interval end,
      case when s = 'ACCEPTED' or s = 'CONVERTED' then 'anjali.sharma@mgmotor.example' end,
      case when s = 'ACCEPTED' or s = 'CONVERTED' then 'Anjali Sharma' end,
      case when s = 'DECLINED' then now() - '4 days'::interval end,
      case when s = 'DECLINED' then 'Customer specified competitor MFR' end,
      case when s = 'CONVERTED' then now() - '6 hours'::interval end,
      case when s = 'CANCELLED' then now() - '7 days'::interval end,
      'Net 30. FOB origin. Validity 30 days from issue.',
      'Seeded fixture (phase 350) for Quotes screen smoke.',
      base_lines,
      alpha,
      now() - ((i * 5) || ' days')::interval
    )
    on conflict (id) do nothing;
  end loop;

  -- Revision chain: a v2 DRAFT cloned from the SENT v1.
  parent_id := uuid_generate_v5(ns, 'quote:SENT');
  insert into quotes (
    id, tenant_id, customer_id, customer_contact_id,
    quote_number, version, prior_version_id, status,
    currency, subtotal, tax_total, grand_total,
    validity_days, expires_at, terms, notes, line_items,
    created_by, created_at
  ) values (
    uuid_generate_v5(ns, 'quote:SENT:v2'),
    default_tenant, cust_id, contact_id,
    'Q-2026-' || lpad((array_position(statuses, 'SENT'))::text, 4, '0'),
    2, parent_id, 'DRAFT',
    'INR', 95000.00, 17100.00, 112100.00,
    30, now() + '60 days'::interval,
    'Net 30. Revised pricing per customer email.',
    'Phase 350 fixture: revision of the SENT v1 with a 7% uplift.',
    base_lines, alpha, now() - '1 day'::interval
  )
  on conflict (id) do nothing;
end $quotes$;

-- ───────────────────────────────────────────────────────────────────
-- 3. credit_notes  --  one per (kind, status) combination
-- ───────────────────────────────────────────────────────────────────
do $credit_notes$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0035-0001-000000000001';
  inv_id         uuid;
  einv_id        uuid;
  -- Bug fix May 2026: kind + status are enum-typed
  -- (credit_note_kind / credit_note_status, migration 072) with
  -- uppercase values. Previous version used lowercase strings which
  -- failed the implicit cast and bombed seed-apply.
  cn_kinds       text[] := array['CREDIT', 'DEBIT'];
  cn_statuses    text[] := array['DRAFT', 'ISSUED', 'CANCELLED'];
  k              text;
  st             text;
  reason         text;
  i              int := 0;
begin
  -- Pick any seeded invoice + einvoice as anchor.
  select id into inv_id from invoices where tenant_id = default_tenant order by created_at asc limit 1;
  select id into einv_id from einvoices where tenant_id = default_tenant order by created_at asc limit 1;

  foreach k in array cn_kinds loop
    foreach st in array cn_statuses loop
      i := i + 1;
      reason := case (i % 4)
        when 0 then 'rate_correction'
        when 1 then 'qty_short_shipped'
        when 2 then 'tax_revision'
        else 'goods_returned'
      end;
      -- Bug fix May 2026: note_number is NOT NULL on credit_notes
      -- (migration 072) and was missing from the previous insert.
      -- Builds a deterministic CN-YYYY-NNNN style number from the
      -- kind + status + index so re-runs are idempotent.
      insert into credit_notes (
        id, tenant_id, note_number, kind, reason, reason_text, status,
        invoice_id, einvoice_id, currency, subtotal, tax_total, grand_total,
        line_items, created_by, created_at, issued_at, cancelled_at
      ) values (
        uuid_generate_v5(ns, 'cn:' || k || ':' || st),
        default_tenant,
        case k when 'CREDIT' then 'CN' else 'DN' end || '-2026-' || lpad(i::text, 4, '0'),
        k, reason,
        case k when 'CREDIT' then 'Customer requested CN for short delivery' else 'Operator-initiated DN for under-billed line' end,
        st,
        case when st <> 'DRAFT' and inv_id is not null then inv_id end,
        case when st <> 'DRAFT' and einv_id is not null then einv_id end,
        'INR', 1500.00, 270.00, 1770.00,
        jsonb_build_array(
          jsonb_build_object('description', 'Adjustment line', 'qty', 1, 'rate', 1500.00, 'gst_pct', 18)
        ),
        uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:fin.alpha@anvil.test'),
        now() - ((i * 3) || ' days')::interval,
        case when st = 'ISSUED' then now() - ((i * 3) || ' days')::interval + '4 hours'::interval end,
        case when st = 'CANCELLED' then now() - ((i * 3) || ' days')::interval + '8 hours'::interval end
      )
      on conflict (id) do nothing;
    end loop;
  end loop;
end $credit_notes$;

-- ───────────────────────────────────────────────────────────────────
-- 4. recurring_invoice_schedules  --  one per (cadence, status)
-- ───────────────────────────────────────────────────────────────────
do $recurring$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0035-0001-000000000001';
  cust_id        uuid;
  -- Bug fix May 2026: cadence is a CHECK constraint with uppercase
  -- values (MONTHLY/QUARTERLY/BIANNUAL/ANNUAL) and status is the
  -- recurring_invoice_status enum (ACTIVE/PAUSED/CANCELLED).
  -- 'completed' is NOT a valid status; use 'CANCELLED' so the
  -- end_date branch keeps its meaning.
  cadences       text[] := array['MONTHLY', 'QUARTERLY', 'ANNUAL'];
  statuses       text[] := array['ACTIVE', 'PAUSED', 'CANCELLED'];
  cad            text;
  st             text;
  i              int := 0;
begin
  select id into cust_id from customers where tenant_id = default_tenant and customer_key = 'TATA_MOTORS_PV_PUNE' limit 1;
  if cust_id is null then return; end if;
  foreach cad in array cadences loop
    foreach st in array statuses loop
      i := i + 1;
      -- Bug fix May 2026: column is `invoice_count` not
      -- `generated_count`; `next_invoice_date` is NOT NULL and
      -- was missing entirely from the prior insert. Default to 30
      -- days out for ACTIVE rows, the start_date for CANCELLED
      -- rows (the schedule is closed, the next-date stamp is
      -- moot but the column requires a value).
      insert into recurring_invoice_schedules (
        id, tenant_id, customer_id, cadence, amount, currency,
        start_date, next_invoice_date, end_date, status, max_invoices, invoice_count,
        description, net_days, created_by, created_at
      ) values (
        uuid_generate_v5(ns, 'recur:' || cad || ':' || st),
        default_tenant, cust_id, cad, 25000.00, 'INR',
        (now() - '180 days'::interval)::date,
        case when st = 'ACTIVE' then (now() + '30 days'::interval)::date
             else (now() - '180 days'::interval)::date end,
        case when st = 'CANCELLED' then (now() - '7 days'::interval)::date end,
        st, 12, case st when 'CANCELLED' then 12 when 'PAUSED' then 6 else 4 end,
        'Phase 350 fixture: ' || cad || ' AMC retainer',
        30,
        uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:fin.alpha@anvil.test'),
        now() - ((i * 14) || ' days')::interval
      )
      on conflict (id) do nothing;
    end loop;
  end loop;
end $recurring$;

-- ───────────────────────────────────────────────────────────────────
-- 5. eway_bills  --  one per status across two transport modes
-- ───────────────────────────────────────────────────────────────────
do $ewb$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0035-0001-000000000001';
  inv_id         uuid;
  einv_id        uuid;
  -- Bug fix May 2026: eway_bills.status is the eway_bill_status
  -- enum (DRAFT / PENDING_NIC / GENERATED / CANCELLED / REJECTED /
  -- EXPIRED) per migration 074. trans_mode has no CHECK so the
  -- mode label can be free-text but we capitalize for symmetry.
  statuses       text[] := array['DRAFT', 'GENERATED', 'CANCELLED', 'EXPIRED'];
  modes          text[] := array['Road', 'Rail'];
  st             text;
  m              text;
  i              int := 0;
begin
  select id into inv_id from invoices where tenant_id = default_tenant order by created_at asc limit 1;
  select id into einv_id from einvoices where tenant_id = default_tenant order by created_at asc limit 1;
  if inv_id is null and einv_id is null then return; end if;
  foreach st in array statuses loop
    foreach m in array modes loop
      i := i + 1;
      insert into eway_bills (
        id, tenant_id, invoice_id, einvoice_id, doc_no, doc_date,
        trans_mode, trans_distance, vehicle_no, vehicle_type,
        transporter_id, transporter_name, taxable_value, total_inv_value,
        status, ewb_no, ewb_valid_upto, created_at
      ) values (
        uuid_generate_v5(ns, 'ewb:' || st || ':' || m),
        default_tenant, inv_id, einv_id,
        'INV-2026-' || lpad(i::text, 5, '0'),
        (now() - ((i * 2) || ' days')::interval)::date,
        m,
        180 + (i * 50),
        case m when 'Road' then 'MH04AB' || lpad((1000 + i)::text, 4, '0') else null end,
        case m when 'Road' then 'regular' else 'rail' end,
        '27ABCDE1234F1Z' || (5 + i % 5)::text,
        'Continental Transport Pvt Ltd',
        88340.00, 104241.20,
        st,
        case when st in ('GENERATED', 'CANCELLED', 'EXPIRED') then '321' || lpad((1000000 + i)::text, 10, '0') end,
        case when st = 'GENERATED' then now() + '7 days'::interval
             when st = 'EXPIRED'   then now() - '1 day'::interval end,
        now() - ((i * 5) || ' days')::interval
      )
      on conflict (id) do nothing;
    end loop;
  end loop;
end $ewb$;

-- ───────────────────────────────────────────────────────────────────
-- 6. deploy_events  --  12 deploys (mix of production + preview,
--                       different states), drives the SOC 2 change-log
--                       audit-export view.
-- ───────────────────────────────────────────────────────────────────
do $deploys$
declare
  ns         uuid := 'd7a7e5e4-0001-0035-0001-000000000001';
  envs       text[] := array['production', 'preview', 'preview', 'production'];
  states     text[] := array['ready', 'ready', 'error', 'cancelled', 'ready', 'ready'];
  i          int := 0;
  e          text;
  st         text;
begin
  for i in 1..12 loop
    e  := envs[((i - 1) % array_length(envs, 1)) + 1];
    st := states[((i - 1) % array_length(states, 1)) + 1];
    insert into deploy_events (
      id, provider, environment, deployment_id, url, commit_sha,
      commit_message, branch, state, ts, meta
    ) values (
      uuid_generate_v5(ns, 'deploy:' || i),
      'vercel', e,
      'dpl_' || encode(decode(lpad(to_hex(i * 5318008), 8, '0'), 'hex'), 'base64'),
      'https://anvil-' || e || '-' || i || '.vercel.app',
      lpad(to_hex(i * 31337), 7, '0') || lpad(to_hex(i * 7), 5, '0'),
      case (i % 6)
        when 0 then 'feat(verticals): four more packs (welding + pn-hydraulics + safety + automation)'
        when 1 then 'fix: bug-squash sweep (P0 + P1 + P2 from May 2026 critic audit)'
        when 2 then 'feat(voice): voice AI build (compliance + outbound + followup agent + UI)'
        when 3 then 'feat(quotes): arm autonomous-agent goals when a quote is sent'
        when 4 then 'feat(landing): align pricing tiers + FAQ + compare table'
        else        'chore(deps): bump dependencies'
      end,
      case (i % 4) when 0 then 'main' when 1 then 'main' when 2 then 'feat-bug-squash' else 'feat-followups' end,
      st,
      now() - ((i * 6) || ' hours')::interval,
      jsonb_build_object('seed_marker', 'anvil-test-seed-v1', 'phase', 350, 'fixture_index', i)
    )
    on conflict (id) do nothing;
  end loop;
end $deploys$;

-- ───────────────────────────────────────────────────────────────────
-- 7. voice_consent  --  6 records covering active / withdrawn / expired
-- ───────────────────────────────────────────────────────────────────
do $voice_consent$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0035-0001-000000000001';
  alpha          uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:eng.alpha@anvil.test');
  cust_id        uuid;
  ct_id          uuid;
  -- six distinct phone-numbers: India + US + Canada + UK + AE + SG
  rows           jsonb := jsonb_build_array(
    jsonb_build_object('phone', '+919876500001', 'source', 'inbound_call',     'state', 'active'),
    jsonb_build_object('phone', '+14155550001',  'source', 'opt_in_form',      'state', 'active'),
    jsonb_build_object('phone', '+14165550002',  'source', 'signed_agreement', 'state', 'expired'),
    jsonb_build_object('phone', '+442071230003', 'source', 'inbound_message',  'state', 'withdrawn'),
    jsonb_build_object('phone', '+971501230004', 'source', 'recorded_verbal',  'state', 'active'),
    jsonb_build_object('phone', '+6512340005',   'source', 'manual_attestation','state', 'active')
  );
  r              jsonb;
  i              int := 0;
begin
  select id into cust_id from customers where tenant_id = default_tenant and customer_key = 'MG_MOTOR_INDIA' limit 1;
  select id into ct_id from customer_contacts where tenant_id = default_tenant and customer_id = cust_id order by is_primary desc limit 1;

  for r in select * from jsonb_array_elements(rows) loop
    i := i + 1;
    insert into voice_consent (
      id, tenant_id, phone_number, customer_id, customer_contact_id,
      scope, source, consented_at, source_artifact_url, expires_at,
      withdrawn_at, notes, created_by
    ) values (
      uuid_generate_v5(ns, 'consent:' || (r->>'phone')),
      default_tenant, r->>'phone',
      cust_id, case when (r->>'phone') like '+91%' then ct_id end,
      'voice', r->>'source',
      now() - ((i * 7) || ' days')::interval,
      case (r->>'source') when 'signed_agreement' then 'https://docs.example/anvil-seed/signed-' || i || '.pdf' end,
      case (r->>'state') when 'expired' then now() - '1 day'::interval end,
      case (r->>'state') when 'withdrawn' then now() - '2 days'::interval end,
      'Phase 350 fixture (' || (r->>'state') || ')',
      alpha
    )
    on conflict (id) do nothing;
  end loop;
end $voice_consent$;

-- ───────────────────────────────────────────────────────────────────
-- 8. voice_dnd_list  --  4 entries (tenant manual + customer request
--                        + global TRAI + global FCC)
-- ───────────────────────────────────────────────────────────────────
do $voice_dnd$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0035-0001-000000000001';
  alpha          uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:eng.alpha@anvil.test');
  rows           jsonb := jsonb_build_array(
    jsonb_build_object('phone', '+919876599901', 'source', 'tenant_manual',    'tenant_scope', true,  'reason', 'Operator added: customer asked us to stop calling'),
    jsonb_build_object('phone', '+919876599902', 'source', 'customer_request', 'tenant_scope', true,  'reason', 'Captured during voice call: caller requested removal'),
    jsonb_build_object('phone', '+919876599903', 'source', 'trai_ndnc',        'tenant_scope', false, 'reason', 'TRAI NDNC list snapshot'),
    jsonb_build_object('phone', '+14155559999',  'source', 'fcc_dnc',          'tenant_scope', false, 'reason', 'FCC DNC list snapshot')
  );
  r              jsonb;
begin
  for r in select * from jsonb_array_elements(rows) loop
    insert into voice_dnd_list (
      id, tenant_id, phone_number, source, region, added_at, reason, added_by, source_loaded_at
    ) values (
      uuid_generate_v5(ns, 'dnd:' || (r->>'source') || ':' || (r->>'phone')),
      case when (r->>'tenant_scope')::boolean then default_tenant end,
      r->>'phone',
      r->>'source',
      case when (r->>'phone') like '+91%' then 'IN' when (r->>'phone') like '+1%' then 'US' end,
      now() - '14 days'::interval,
      r->>'reason',
      case when (r->>'tenant_scope')::boolean then alpha end,
      case when not (r->>'tenant_scope')::boolean then now() - '7 days'::interval end
    )
    on conflict on constraint voice_dnd_list_unique do nothing;
  end loop;
end $voice_dnd$;

-- ───────────────────────────────────────────────────────────────────
-- 9. extraction_corrections  --  ~10 rows so the per-customer
--    prompt-overrides bundle has training material for the docai
--    fallback path.
-- ───────────────────────────────────────────────────────────────────
do $extraction$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0035-0001-000000000001';
  alpha          uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:eng.alpha@anvil.test');
  run_id         uuid;
  cust_id        uuid;
  fields         text[] := array['lines[0].partNumber', 'lines[0].quantity', 'lines[1].unitPrice', 'customer.name', 'lines[2].description'];
  reasons        text[] := array['Operator corrected OCR misread', 'Alias resolved to canonical part', 'Rate normalised to per-unit', 'Customer name spelled wrong', 'Description fully expanded'];
  f              text;
  r              text;
  i              int := 0;
begin
  -- Anchor on any extraction_runs row that exists. If none, skip.
  select er.id, er.customer_id into run_id, cust_id
  from extraction_runs er
  where er.tenant_id = default_tenant
  order by er.started_at desc nulls last
  limit 1;
  if run_id is null then return; end if;

  for i in 1..array_length(fields, 1) loop
    f := fields[i];
    r := reasons[i];
    insert into extraction_corrections (
      id, tenant_id, extraction_run_id, customer_id,
      field_path, original_value, corrected_value, reason, user_id, applied_at
    ) values (
      uuid_generate_v5(ns, 'extr_corr:' || run_id::text || ':' || f),
      default_tenant, run_id, cust_id,
      f,
      to_jsonb('original_' || i)::jsonb,
      to_jsonb('corrected_' || i)::jsonb,
      r,
      alpha,
      now() - ((i * 4) || ' hours')::interval
    )
    on conflict (id) do nothing;
  end loop;
end $extraction$;

-- ───────────────────────────────────────────────────────────────────
-- 10. agent_goals on quotes  --  arm two goals per SENT quote so
--     the autonomy runtime has work to drain. These mirror what
--     /api/quotes/send does via armQuoteAgentGoals.
-- ───────────────────────────────────────────────────────────────────
do $quote_goals$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  ns             uuid := 'd7a7e5e4-0001-0035-0001-000000000001';
  alpha          uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:eng.alpha@anvil.test');
  q              record;
begin
  for q in
    select id, expires_at, sent_at, version
    from quotes
    where tenant_id = default_tenant
      and status = 'SENT'
      and id = uuid_generate_v5(ns, 'quote:SENT')
  loop
    -- quote_accept_within_14d
    insert into agent_goals (
      id, tenant_id, goal_type, object_type, object_id,
      due_at, config, status, created_by, owner_user_id, created_at
    ) values (
      uuid_generate_v5(ns, 'goal:quote_accept:' || q.id::text),
      default_tenant, 'quote_accept_within_14d', 'quote', q.id,
      coalesce(q.sent_at, now()) + '14 days'::interval,
      jsonb_build_object('cooldown_hours', 72, 'sent_at', q.sent_at, 'version', q.version, 'seed_marker', 'anvil-test-seed-v1'),
      'active', alpha, alpha, now() - '6 hours'::interval
    )
    on conflict on constraint agent_goals_active_target_uniq do nothing;
    -- expiring_quote_nudge
    insert into agent_goals (
      id, tenant_id, goal_type, object_type, object_id,
      due_at, config, status, created_by, owner_user_id, created_at
    ) values (
      uuid_generate_v5(ns, 'goal:expiring_quote:' || q.id::text),
      default_tenant, 'expiring_quote_nudge', 'quote', q.id,
      q.expires_at,
      jsonb_build_object('sent_at', q.sent_at, 'expires_at', q.expires_at, 'version', q.version, 'seed_marker', 'anvil-test-seed-v1'),
      'active', alpha, alpha, now() - '6 hours'::interval
    )
    on conflict on constraint agent_goals_active_target_uniq do nothing;
  end loop;
end $quote_goals$;

commit;

-- Phase 350 done. Re-running is a no-op.
