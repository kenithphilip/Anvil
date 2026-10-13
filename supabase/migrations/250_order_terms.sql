-- 250_order_terms.sql
--
-- The commercial-terms check: what the PO's terms say, where they differ from
-- our quote, and what the sales engineer decided about each difference.
-- docs/SO_TERMS_AND_HANDOFF_SCOPE.md section 9.2 (this migration), sections 3
-- and 5 (the clause model and the outcomes) and section 6 (the decisions).
--
--   order_term_checks     one row per run of the check on an order. A re-run
--                         supersedes the previous row (superseded_at).
--   order_term_flags      one row per clause that needs a look: deviates,
--                         po_only, quote_only, unknown, or the one order-level
--                         not_read row. Superseded with their check.
--   order_term_decisions  APPEND-ONLY. One row per decision. A changed mind is
--                         a new row; the latest row per flag is the current
--                         decision. RLS grants insert and select only, so no
--                         tenant user can edit or delete one. The service role
--                         bypasses RLS: the API must only ever insert here.
--   quotes                the terms an uploaded quote already carries
--                         (incoterm, delivery_terms, validity_text), and the
--                         snapshot of our own quote's terms at send.
--   tenant_settings       the check's mode (off by default), the tenant's
--                         policy override, and the amendment email switch.
--
-- Additive and idempotent: create table if not exists, add column if not
-- exists, drop policy if exists before create. Every new table carries
-- tenant_id, and RLS on each uses current_tenant_ids().
--
-- Nothing changes until a tenant turns the check on. terms_check_mode
-- defaults to 'off'. The three quote columns are nullable, and the code reads
-- a database without them exactly as it did before (section 9.4): an uploaded
-- quote stores its head without them, and the reconciler compares the
-- incoterm against the quote's terms text, as it does today.
--
-- APPLY BY HAND. Merging this file does not change any database. After you
-- apply it in the Supabase SQL editor, reload the PostgREST schema cache:
--
--   notify pgrst, 'reload schema';
--
-- VERIFY. Run this. Expect 3, 5, 3, 3, 0 and true.
--
--   select
--     (select count(*) from information_schema.tables
--        where table_schema = 'public'
--          and table_name in ('order_term_checks', 'order_term_flags', 'order_term_decisions')) as new_tables,
--     (select count(*) from information_schema.columns
--        where table_schema = 'public' and table_name = 'quotes'
--          and column_name in ('incoterm', 'delivery_terms', 'validity_text', 'terms_snapshot', 'terms_snapshot_at')) as quote_columns,
--     (select count(*) from information_schema.columns
--        where table_schema = 'public' and table_name = 'tenant_settings'
--          and column_name in ('terms_check_mode', 'terms_policy', 'terms_amendment_email_enabled')) as settings_columns,
--     (select count(*) from pg_class
--        where relname in ('order_term_checks', 'order_term_flags', 'order_term_decisions')
--          and relrowsecurity) as tables_with_rls,
--     (select count(*) from pg_policies
--        where tablename = 'order_term_decisions' and cmd in ('UPDATE', 'DELETE', 'ALL')) as decision_edit_policies,
--     (select bool_and(terms_check_mode = 'off') from tenant_settings) as every_tenant_off;

-- ── order_term_checks ───────────────────────────────────────────────────────

create table if not exists order_term_checks (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  trigger text not null
    check (trigger in ('reconcile', 'manual', 'quote_attached')),
  po_document_id uuid references documents(id) on delete set null,
  po_text_source text
    check (po_text_source in ('text_layer', 'ocr_layer', 'office', 'email_body', 'none')),
  po_terms_status text not null
    check (po_terms_status in ('read', 'partial', 'not_read')),
  po_clauses jsonb not null default '[]'::jsonb,
  segmenter text
    check (segmenter in ('headings', 'fallback')),
  dropped_unverified int not null default 0,
  quote_ids uuid[] not null default '{}',
  policy_version int,
  prompt_version text,
  model text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  superseded_at timestamptz
);

create index if not exists order_term_checks_order_idx
  on order_term_checks (tenant_id, order_id);

comment on table order_term_checks is
  'One run of the terms check on an order (docs/SO_TERMS_AND_HANDOFF_SCOPE.md 9.2). po_clauses holds the verified PO clauses (TermClause records). A re-run sets superseded_at on the previous row. po_terms_status not_read is never shown as "no deviations".';

-- ── order_term_flags ────────────────────────────────────────────────────────

create table if not exists order_term_flags (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  check_id uuid not null references order_term_checks(id) on delete cascade,
  -- One of the clause keys in src/api/_lib/terms/taxonomy.js. Not a database
  -- enum: the clause list is tenant policy data (decision 1). Null only on
  -- the order-level not_read row.
  clause text,
  outcome text not null
    check (outcome in ('deviates', 'po_only', 'quote_only', 'unknown', 'not_read')),
  direction text
    check (direction in ('against_us', 'for_us', 'neutral')),
  severity text not null
    check (severity in ('info', 'warn', 'high', 'critical')),
  method text not null default 'rule'
    check (method in ('rule', 'llm')),
  po jsonb,
  quote jsonb,
  baseline jsonb,
  rationale text,
  text_hash text,
  created_at timestamptz not null default now(),
  superseded_at timestamptz,
  constraint order_term_flags_clause_check check (clause is not null or outcome = 'not_read')
);

create index if not exists order_term_flags_order_idx
  on order_term_flags (tenant_id, order_id);

comment on table order_term_flags is
  'One clause of one terms check that needs a look (docs/SO_TERMS_AND_HANDOFF_SCOPE.md 5.2). po and quote are TermClause records; quote adds quote_id. text_hash decides whether a decision carries forward to the next check.';

-- ── order_term_decisions (append-only) ──────────────────────────────────────

create table if not exists order_term_decisions (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  flag_id uuid not null references order_term_flags(id) on delete cascade,
  decision text not null
    check (decision in ('accept', 'request_amendment', 'reject_term', 'not_a_deviation')),
  reason text not null,
  decided_by uuid references auth.users(id) on delete set null,
  decided_role text,
  decided_at timestamptz not null default now(),
  -- The decision this one carried forward from, when a re-check found the
  -- same clause with the same wording on both sides.
  carried_from uuid references order_term_decisions(id) on delete set null
);

create index if not exists order_term_decisions_order_idx
  on order_term_decisions (tenant_id, order_id);
create index if not exists order_term_decisions_flag_idx
  on order_term_decisions (flag_id, decided_at desc);

comment on table order_term_decisions is
  'Append-only. The engineer''s decision on one terms flag, with a required reason. A changed mind is a new row; the latest per flag is current. RLS grants select and insert only. The service role bypasses RLS, so the API only ever inserts.';

-- ── row-level security ──────────────────────────────────────────────────────

alter table order_term_checks enable row level security;
drop policy if exists order_term_checks_select on order_term_checks;
create policy order_term_checks_select on order_term_checks
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists order_term_checks_write on order_term_checks;
create policy order_term_checks_write on order_term_checks
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

alter table order_term_flags enable row level security;
drop policy if exists order_term_flags_select on order_term_flags;
create policy order_term_flags_select on order_term_flags
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists order_term_flags_write on order_term_flags;
create policy order_term_flags_write on order_term_flags
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

-- Insert and select only. With RLS on and no update or delete policy, an
-- update or delete by a tenant user matches no row.
alter table order_term_decisions enable row level security;
drop policy if exists order_term_decisions_select on order_term_decisions;
create policy order_term_decisions_select on order_term_decisions
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists order_term_decisions_insert on order_term_decisions;
create policy order_term_decisions_insert on order_term_decisions
  for insert with check (tenant_id in (select current_tenant_ids()));

-- ── quotes ──────────────────────────────────────────────────────────────────

alter table quotes add column if not exists incoterm text;
alter table quotes add column if not exists delivery_terms text;
alter table quotes add column if not exists validity_text text;
alter table quotes add column if not exists terms_snapshot jsonb;
alter table quotes add column if not exists terms_snapshot_at timestamptz;

comment on column quotes.incoterm is
  'The trade term as the quote prints it, e.g. "FCA Chennai". Read off an uploaded quote by the extractor; the reconciler compares the PO incoterm against it. Null on a quote that states none.';
comment on column quotes.delivery_terms is
  'Delivery lead time or schedule as the quote prints it, e.g. "11-12 weeks from receipt of order".';
comment on column quotes.validity_text is
  'Validity as the quote prints it, e.g. "One(1) Month". The wording, not a date: validity_days and expires_at stay the structured values.';
comment on column quotes.terms_snapshot is
  'Our quote''s clauses as frozen at send (plan PR 10b), or an uploaded quote''s verified clauses (provenance quote_document). Never written over a quote authored in Anvil by an ingest.';
comment on column quotes.terms_snapshot_at is
  'When terms_snapshot was written.';

-- ── tenant_settings ─────────────────────────────────────────────────────────

alter table tenant_settings
  add column if not exists terms_check_mode text not null default 'off';

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'tenant_settings'::regclass
      and conname = 'tenant_settings_terms_check_mode_check'
  ) then
    alter table tenant_settings drop constraint tenant_settings_terms_check_mode_check;
  end if;
end $$;

alter table tenant_settings
  add constraint tenant_settings_terms_check_mode_check
  check (terms_check_mode in ('off', 'shadow', 'on'));

alter table tenant_settings add column if not exists terms_policy jsonb;
alter table tenant_settings
  add column if not exists terms_amendment_email_enabled boolean default false;

comment on column tenant_settings.terms_check_mode is
  'The terms check. off (default): not run. shadow: run and stored, not shown to engineers. on: run and shown. A discriminator: a reader without this column returns 503 migration_250_not_applied, never a guess.';
comment on column tenant_settings.terms_policy is
  'The tenant''s override of DEFAULT_TERMS_POLICY (src/api/_lib/terms/taxonomy.js), key by key. Null = the default policy.';
comment on column tenant_settings.terms_amendment_email_enabled is
  'Whether Anvil may draft an amendment request email to the customer (decision 9). Default false.';
