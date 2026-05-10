-- 103_template_marketplace.sql
--
-- Bet 2: format-template marketplace. Lifts per-tenant
-- customer_format_templates (migration 091) into an opt-in global
-- library keyed on layout fingerprint, not customer_id. New tenants
-- whose POs match a published template skip part of the 3-4-PO LLM
-- warm-up; the LLM still runs (hint mode) unless the operator has
-- promoted the global template after N successful imports.
--
-- Safeguard model:
--
--   Triple-gate opt-in for publish:
--     1. tenant_settings.template_marketplace_publisher_optin
--        (admin must explicitly flip; default FALSE)
--     2. customers.do_not_publish_templates (per-customer; default
--        TRUE so consent is opt-IN per customer, not opt-OUT)
--     3. per-template explicit publish action from Studio
--
--   Stage-1 auto-publish checks (deterministic):
--     - >= 5 distinct sample_doc_hashes (k-anonymity)
--     - >= 3 anchors
--     - regex safety: no ReDoS patterns, capture cap, length cap
--     - PII redaction: sample_value stripped + labels scrubbed
--     - miss_rate < 10% on the publisher's own docs
--
--   Stage-2 human review:
--     - First publication per tenant -> status='pending_review'
--     - Super-admin approval stamps
--       tenant_settings.template_marketplace_publisher_verified_at;
--       subsequent publications auto-approve on Stage-1 pass.
--
--   Matching defaults to HINT MODE:
--     - score >= 0.7  -> banner + L4 LLM still runs with global
--                        known-fields hints
--     - 0.5 - 0.7    -> silent hint mode (no banner)
--     - skip-LLM full takeover only after N successful operator-
--       confirmed imports (default N = 5 per tenant)
--
-- Per docs/STRATEGIC_BET_02_template_marketplace.md.
--
-- Idempotent.

-- 1. Tenant-level opt-in flags + reputation.

alter table tenant_settings
  add column if not exists template_marketplace_publisher_optin boolean not null default false,
  add column if not exists template_marketplace_consumer_optin boolean not null default true,
  add column if not exists template_marketplace_publisher_verified_at timestamptz,
  add column if not exists template_marketplace_publisher_suspended_at timestamptz,
  add column if not exists template_marketplace_skip_llm_after_n_imports smallint not null default 5,
  add column if not exists template_marketplace_publish_daily_cap smallint not null default 10,
  add column if not exists template_marketplace_publisher_revoke_count int not null default 0;

-- 2. Per-customer do-not-publish flag. Default TRUE so publishing
-- is an explicit opt-IN at the customer level. The publisher must
-- both flip the tenant flag AND set this per-customer flag to
-- false before any template tied to this customer becomes
-- publishable. Belt-and-suspenders against accidental disclosure.

alter table customers
  add column if not exists do_not_publish_templates boolean not null default true;

-- 3. Global, tenant-less library. publisher_tenant_id is nullable
-- by design: when the publisher chooses anonymous publication,
-- we null it out so consumers cannot derive who supplies whom.

create table if not exists customer_format_templates_global (
  id uuid primary key default uuid_generate_v4(),
  kind text not null check (kind in ('po','quote','invoice','supplier_ack','eway_bill')),
  fingerprint jsonb not null default '{}'::jsonb,
  -- Anchors are stored with `sample_value` REDACTED already at
  -- write time. We never store raw values from the publisher's
  -- documents in the global library.
  anchors jsonb not null default '[]'::jsonb,
  line_anchors jsonb not null default '[]'::jsonb,
  publisher_tenant_id uuid references tenants(id) on delete set null,
  publisher_display text,
  anonymise_publisher boolean not null default true,
  status text not null default 'pending_review'
    check (status in ('pending_review','approved','rejected','revoked','superseded','auto_suspended')),
  approval_kind text check (approval_kind is null or approval_kind in ('auto','human')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  rejection_reason text,
  k_anonymity int not null default 0,
  hit_count int not null default 0,
  miss_count int not null default 0,
  upvotes int not null default 0,
  downvotes int not null default 0,
  revoke_reports int not null default 0,
  source_template_id uuid references customer_format_templates(id) on delete set null,
  superseded_by uuid references customer_format_templates_global(id) on delete set null,
  redaction_report jsonb not null default '{}'::jsonb,
  regex_safety_report jsonb not null default '{}'::jsonb,
  replay_verification jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists cftg_status_idx
  on customer_format_templates_global (kind, status);
create index if not exists cftg_fingerprint_idx
  on customer_format_templates_global using gin (fingerprint);
create index if not exists cftg_publisher_idx
  on customer_format_templates_global (publisher_tenant_id, status)
  where publisher_tenant_id is not null;

-- Global library has NO RLS-by-tenant; it's a global catalog.
-- We instead gate the API surface so consumers can only see
-- status='approved' rows + their own publications.

alter table customer_format_templates_global enable row level security;
drop policy if exists "cftg_select_approved" on customer_format_templates_global;
drop policy if exists "cftg_select_own_publications" on customer_format_templates_global;
create policy "cftg_select_approved" on customer_format_templates_global
  for select using (status = 'approved');
create policy "cftg_select_own_publications" on customer_format_templates_global
  for select using (
    publisher_tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid
  );

create or replace function cftg_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists cftg_updated_at on customer_format_templates_global;
create trigger cftg_updated_at before update on customer_format_templates_global
  for each row execute function cftg_touch_updated_at();

-- 4. Per-tenant publication audit trail. Survives even when the
-- global row is later revoked + soft-deleted, so consent provenance
-- never disappears.

create table if not exists template_publications (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  template_id uuid not null references customer_format_templates(id) on delete cascade,
  global_id uuid references customer_format_templates_global(id) on delete set null,
  customer_id uuid references customers(id) on delete set null,
  published_by uuid references auth.users(id) on delete set null,
  redaction_report jsonb not null default '{}'::jsonb,
  regex_safety_report jsonb not null default '{}'::jsonb,
  anonymise_publisher boolean not null default true,
  k_anonymity int not null default 0,
  status text not null default 'submitted'
    check (status in ('submitted','approved','rejected','revoked')),
  rejection_reason text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (tenant_id, template_id)
);

create index if not exists tp_tenant_idx
  on template_publications (tenant_id, status, created_at desc);

alter table template_publications enable row level security;
drop policy if exists "tp_owner" on template_publications;
create policy "tp_owner" on template_publications
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- 5. Per-tenant consumption audit. Every time a consumer tenant
-- adopts a global template (hint or skip-LLM), a row lands here.

create table if not exists template_imports (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  global_id uuid not null references customer_format_templates_global(id) on delete cascade,
  match_score numeric(4, 3) not null check (match_score >= 0 and match_score <= 1),
  fingerprint_score numeric(4, 3),
  anchor_hit_rate numeric(4, 3),
  use_mode text not null check (use_mode in ('hint', 'skip_llm')),
  used_for_extraction_ids uuid[] not null default array[]::uuid[],
  operator_confirmed_count int not null default 0,
  reverted_at timestamptz,
  revert_reason text,
  created_at timestamptz not null default now()
);

create index if not exists ti_tenant_idx
  on template_imports (tenant_id, global_id, created_at desc);
create index if not exists ti_promote_idx
  on template_imports (tenant_id, global_id, operator_confirmed_count);

alter table template_imports enable row level security;
drop policy if exists "ti_owner" on template_imports;
create policy "ti_owner" on template_imports
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- 6. Abuse reports. Consumers report a template that mis-extracts
-- or seems malicious; super-admin reviews + revokes.

create table if not exists template_reports (
  id uuid primary key default uuid_generate_v4(),
  global_id uuid not null references customer_format_templates_global(id) on delete cascade,
  reporter_tenant_id uuid references tenants(id) on delete set null,
  reporter_user_id uuid references auth.users(id) on delete set null,
  reason text not null check (reason in (
    'mis_extracts_value', 'exfiltrates_data', 'pii_leak',
    'redos_pattern', 'irrelevant_template', 'other'
  )),
  evidence jsonb not null default '{}'::jsonb,
  resolved_at timestamptz,
  resolution text check (resolution is null or resolution in
    ('confirmed', 'rejected_invalid', 'duplicate', 'no_action')),
  resolved_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists treports_global_idx
  on template_reports (global_id, resolved_at);

-- Reports are readable by the reporter tenant AND by the publisher
-- tenant of the reported template (so the publisher can see why
-- their template was revoked). Super-admins go through the service
-- client.

alter table template_reports enable row level security;
drop policy if exists "treports_owner_or_publisher" on template_reports;
create policy "treports_owner_or_publisher" on template_reports
  for select using (
    reporter_tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid
    or exists (
      select 1 from customer_format_templates_global g
      where g.id = template_reports.global_id
        and g.publisher_tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid
    )
  );
drop policy if exists "treports_reporter_modify" on template_reports;
create policy "treports_reporter_modify" on template_reports
  for insert with check (
    reporter_tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid
  );

-- 7. Analytics split on extraction_runs: was this run influenced
-- by a global template, and in what mode?

alter table extraction_runs
  add column if not exists global_template_used uuid references customer_format_templates_global(id) on delete set null,
  add column if not exists global_template_use_mode text;

alter table extraction_runs
  drop constraint if exists extraction_runs_global_template_use_mode_check;
alter table extraction_runs
  add constraint extraction_runs_global_template_use_mode_check
  check (global_template_use_mode is null or global_template_use_mode in ('hint', 'skip_llm'));

create index if not exists extraction_runs_global_template_idx
  on extraction_runs (tenant_id, global_template_used, started_at desc)
  where global_template_used is not null;

-- 8. Comments for documentation.

comment on table customer_format_templates_global is
  'Bet 2: global format-template library. Anchors stored already-redacted; sample_value is NEVER persisted in this table. RLS only exposes approved rows + the publisher tenant''s own pending rows.';
comment on column customers.do_not_publish_templates is
  'Bet 2: per-customer publish opt-in flag. Default TRUE means the customer''s templates cannot be published until the tenant operator explicitly flips this off (DPDP-aligned opt-IN model).';
comment on column tenant_settings.template_marketplace_publisher_optin is
  'Bet 2: master switch for publishing. Default FALSE so a tenant that has not signed the DPA amendment never accidentally publishes.';
comment on column tenant_settings.template_marketplace_skip_llm_after_n_imports is
  'Bet 2: number of operator-confirmed imports before a global template promotes from hint mode to full skip-LLM. Default 5; conservative because skipping LLM is irreversible until the next replan.';
comment on column tenant_settings.template_marketplace_publisher_suspended_at is
  'Bet 2: set when the publisher accumulated too many confirmed-malicious revokes (reputation gate). Suspended publishers cannot publish new templates until super-admin intervenes.';
comment on column template_publications.k_anonymity is
  'Bet 2: number of distinct sample_doc_hashes at publish time. Stage-1 auto-publish requires k_anonymity >= 5.';
comment on table template_reports is
  'Bet 2: consumer-side abuse reports. Three confirmed reports auto-suspend the publisher.';
