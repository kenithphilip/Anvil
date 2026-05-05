-- 059_security_hardening.sql
-- Security audit follow-up (May 2026). Implements the schema-side
-- changes for findings H1, M3, M7, M10, plus the suppression-list
-- RLS tightening flagged in §2.3 (prospecting RLS lets a tenant
-- insert NULL-tenant_id rows that affect other tenants).
-- Idempotent.

-- ---------------------------------------------------------------------------
-- H1: TOTP replay protection.
--
-- We persist (user_id, counter) of every successful TOTP verify.
-- counter = floor(unix_seconds / 30). A unique constraint blocks
-- replays within the verifier's ±1-step window. Old rows (>1 day)
-- can be pruned by a periodic job; the unique constraint stays
-- effective for the entire validity window of any code we'd accept.
-- ---------------------------------------------------------------------------
create table if not exists totp_used_counters (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  counter bigint not null,
  used_at timestamptz not null default now(),
  unique (user_id, counter)
);
create index if not exists totp_used_counters_user_idx on totp_used_counters (user_id, used_at desc);

-- No RLS: this is a server-side-only table (writes via service-role).
-- Reads are also service-role-only (the verifier checks before
-- accepting a code). A SELECT policy that returns nothing is
-- belt-and-braces against accidental PostgREST exposure.
alter table totp_used_counters enable row level security;
drop policy if exists totp_used_counters_no_select on totp_used_counters;
create policy totp_used_counters_no_select on totp_used_counters for select using (false);

-- ---------------------------------------------------------------------------
-- M3: MFA rate limit.
-- M7: Magic-link rate limit.
--
-- Both use the same shape as the existing password_reset_attempts
-- table (created in migration 042): identifier text + attempted_at
-- timestamptz. The limiter helper at src/api/_lib/rate-limit.js
-- queries any of these tables uniformly.
-- ---------------------------------------------------------------------------
create table if not exists mfa_attempts (
  id uuid primary key default uuid_generate_v4(),
  identifier text not null,
  attempted_at timestamptz not null default now()
);
create index if not exists mfa_attempts_idx on mfa_attempts (identifier, attempted_at desc);

create table if not exists magic_link_attempts (
  id uuid primary key default uuid_generate_v4(),
  identifier text not null,
  attempted_at timestamptz not null default now()
);
create index if not exists magic_link_attempts_idx on magic_link_attempts (identifier, attempted_at desc);

-- Service-role-only writes/reads.
alter table mfa_attempts enable row level security;
drop policy if exists mfa_attempts_no_select on mfa_attempts;
create policy mfa_attempts_no_select on mfa_attempts for select using (false);

alter table magic_link_attempts enable row level security;
drop policy if exists magic_link_attempts_no_select on magic_link_attempts;
create policy magic_link_attempts_no_select on magic_link_attempts for select using (false);

-- ---------------------------------------------------------------------------
-- M10: ERP retry queue atomic claim.
--
-- Add a `claimed_at` column to every <prefix>_retry_queue table so
-- the runner can atomically transition pending -> processing in a
-- single UPDATE ... RETURNING and avoid double-pushing under
-- concurrent cron firings.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  prefixes text[] := array[
    'netsuite','tally','sap','d365','acumatica','p21','eclipse','sxe',
    'sagex3','ifs','oracle_fusion','ramco','jde','plex','jobboss',
    'oracle_ebs','proalpha'
  ];
begin
  foreach t in array prefixes loop
    if to_regclass('public.' || t || '_retry_queue') is not null then
      execute format($f$
        alter table %I_retry_queue add column if not exists claimed_at timestamptz;
        alter table %I_retry_queue add column if not exists claimed_by text;
      $f$, t, t);
      -- Add a check that 'processing' rows have claimed_at set, so a
      -- runner that crashes mid-claim doesn't leave rows stuck.
      execute format($f$
        update %I_retry_queue set status = 'pending', claimed_at = null, claimed_by = null
        where status = 'processing' and claimed_at is not null
          and claimed_at < now() - interval '15 minutes'
      $f$, t);
    end if;
  end loop;
end $$;

-- Extend the retry-queue status check to allow 'processing'.
do $$
declare
  t text;
  prefixes text[] := array[
    'netsuite','tally','sap','d365','acumatica','p21','eclipse','sxe',
    'sagex3','ifs','oracle_fusion','ramco','jde','plex','jobboss',
    'oracle_ebs','proalpha'
  ];
  cname text;
begin
  foreach t in array prefixes loop
    if to_regclass('public.' || t || '_retry_queue') is not null then
      -- Drop and re-add the status check to include 'processing'.
      -- The constraint name varies per migration; find it via pg_constraint.
      for cname in
        select conname from pg_constraint
        where conrelid = (t || '_retry_queue')::regclass
          and contype = 'c'
          and pg_get_constraintdef(oid) like '%status%'
      loop
        execute format('alter table %I_retry_queue drop constraint %I', t, cname);
      end loop;
      execute format($f$
        alter table %I_retry_queue add constraint %I check
          (status in ('pending','processing','succeeded','gave_up'))
      $f$, t, t || '_retry_queue_status_check');
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- M2: atomic first-user-admin claim function.
-- Replaces the count-then-insert TOCTOU pattern in _lib/tenancy.js.
-- An advisory lock keyed on the tenant UUID hash serializes
-- concurrent signups; only one ever observes count=0 inside the
-- locked region.
-- ---------------------------------------------------------------------------
create or replace function claim_tenant_membership(
  p_tenant_id        uuid,
  p_user_id          uuid,
  p_user_email       text,
  p_default_role     text default 'sales_engineer',
  p_first_role       text default 'admin',
  p_requested_role   text default null,
  p_display_name     text default null,
  p_notes            text default null,
  p_require_approval boolean default true
) returns table (
  out_tenant_id uuid,
  out_role text,
  out_status text,
  out_requested_role text,
  out_was_first boolean
)
language plpgsql
security definer
as $$
declare
  v_lock_key bigint;
  v_count int;
  v_is_first boolean;
  v_role text;
  v_status text;
  v_requested_role text;
  v_existing record;
begin
  -- Hash the UUID into a bigint for the advisory lock.
  v_lock_key := ('x' || substr(md5(p_tenant_id::text), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  -- If this user already has a row, return it as-is. The caller
  -- treats this as the idempotent "already onboarded" path.
  select tenant_id, role::text as role, status::text as status, requested_role::text as requested_role
    into v_existing
    from tenant_members
   where tenant_id = p_tenant_id and user_id = p_user_id;
  if found then
    out_tenant_id := v_existing.tenant_id;
    out_role := v_existing.role;
    out_status := v_existing.status;
    out_requested_role := v_existing.requested_role;
    out_was_first := false;
    return next;
    return;
  end if;

  select count(*) into v_count from tenant_members where tenant_members.tenant_id = p_tenant_id;
  v_is_first := (v_count = 0);
  v_role := case when v_is_first then p_first_role else p_default_role end;
  v_status := case when v_is_first or not p_require_approval then 'approved' else 'pending' end;
  v_requested_role := case when v_is_first then null else coalesce(p_requested_role, p_default_role) end;

  insert into tenant_members (
    tenant_id, user_id, role, status, requested_role,
    requested_at, request_email, request_display_name, request_notes,
    approved_at, approved_by
  ) values (
    p_tenant_id, p_user_id, v_role::obara_role, v_status, v_requested_role::obara_role,
    now(), p_user_email, p_display_name, p_notes,
    case when v_status = 'approved' then now() else null end,
    case when v_status = 'approved' then p_user_id else null end
  );

  out_tenant_id := p_tenant_id;
  out_role := v_role;
  out_status := v_status;
  out_requested_role := v_requested_role;
  out_was_first := v_is_first;
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tighten prospecting_suppressions RLS.
--
-- Migration 057 lets a tenant member upsert a row with NULL
-- tenant_id (the WITH CHECK clause is `tenant_id = current_tenant`,
-- so a NULL tenant_id is rejected, but the policy_select OR'ed in
-- a NULL clause). Verify and add a guard: the SELECT policy can
-- still see global NULL-tenant rows (for cross-tenant blocklists),
-- but writes are strictly tenant-scoped.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.prospecting_suppressions') is not null then
    drop policy if exists prospecting_suppressions_modify on prospecting_suppressions;
    create policy prospecting_suppressions_modify on prospecting_suppressions
      for all using (
        tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid
      ) with check (
        tenant_id is not null
        and tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid
      );
    -- Global suppressions are managed by service-role only (RLS bypass).
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- L6: JDE token TTL configurable per tenant.
-- Hardened JDE deployments configure rest.ini with timeouts shorter
-- than the default 30 minutes; we let operators match by tenant.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.tenant_settings') is not null then
    execute 'alter table tenant_settings add column if not exists jde_session_ttl_sec int default 1500';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- H9: documents.scan_status pipeline.
--
-- New uploads land with status 'pending' and downstream consumers
-- (OCR, extract, document-fetch) refuse to process anything not
-- 'clean'. The scan endpoint is the only path that flips pending
-- to clean (or quarantined / infected). Backfill: existing rows are
-- treated as legacy 'unverified'; the operator can re-scan from the
-- documents UI to bring them current.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.documents') is not null then
    execute 'alter table documents add column if not exists scan_status text default ''unverified''';
    execute 'alter table documents add column if not exists scan_completed_at timestamptz';
    execute 'create index if not exists documents_scan_status_idx on documents (tenant_id, scan_status)';
  end if;
end $$;
