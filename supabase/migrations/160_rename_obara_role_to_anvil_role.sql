-- 160_rename_obara_role_to_anvil_role.sql
--
-- De-brand: rename the internal member-role enum `obara_role` ->
-- `anvil_role`. The enum is an internal identifier (never shown to
-- users); this removes the last load-bearing "obara" name from the DB
-- schema.
--
-- Why this is safe:
--   * COLUMNS typed obara_role (tenant_members.role, audit actor_role,
--     approval-matrix approver_role, access requested_role) reference the
--     type by OID and follow the rename automatically.
--   * FUNCTION return types (current_tenant_role -> obara_role) are also
--     OID-based and follow the rename.
--   * RLS policies, CHECK constraints and column DEFAULTs store parsed
--     expression trees (OID-based) and are unaffected.
--   * The ONLY thing that breaks is a PL/pgSQL function whose BODY names
--     the type in a text cast, because bodies are stored as source text
--     and re-parsed at call time. That is exactly one function:
--     claim_tenant_membership (latest definition in migration 060, which
--     casts v_role::obara_role / v_requested_role::obara_role). We
--     recreate it below with anvil_role. CREATE OR REPLACE preserves its
--     ownership + EXECUTE grants (locked down in 060), so we do not
--     re-issue those.
--
-- Idempotent + guarded: the rename only fires when obara_role still
-- exists and anvil_role does not, so re-runs and already-renamed DBs are
-- both no-ops. Reverse migration: rename anvil_role back to obara_role
-- and recreate claim_tenant_membership with the obara_role casts.

do $$
begin
  if exists (select 1 from pg_type where typname = 'obara_role')
     and not exists (select 1 from pg_type where typname = 'anvil_role') then
    alter type obara_role rename to anvil_role;
  end if;
end $$;

comment on type anvil_role is
  'Tenant member role (renamed from obara_role in migration 160).';

-- Recreate the one function whose body casts to the enum by name.
-- Body is verbatim from 060_security_followup.sql with the two casts
-- retargeted to anvil_role.
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
set search_path = public, pg_temp
as $$
declare
  v_lock_key bigint;
  v_count int;
  v_is_first boolean;
  v_role text;
  v_status text;
  v_requested_role text;
  v_existing record;
  v_jwt_user uuid;
begin
  -- Caller-identity guard. auth.uid() returns NULL for the
  -- service-role connection (the intended caller), and the
  -- authenticated user's UUID for any user-JWT call. Reject when
  -- the JWT user disagrees with the parameter.
  begin
    v_jwt_user := nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid;
  exception when others then
    v_jwt_user := null;
  end;
  if v_jwt_user is not null and v_jwt_user <> p_user_id then
    raise exception 'caller user_id (%) does not match p_user_id (%)', v_jwt_user, p_user_id
      using errcode = '42501';
  end if;

  v_lock_key := ('x' || substr(md5(p_tenant_id::text), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

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
    p_tenant_id, p_user_id, v_role::anvil_role, v_status, v_requested_role::anvil_role,
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
