-- 060_security_followup.sql
-- Follow-up audit (May 2026) hardenings on the work landed in 058+059.
--
-- Three findings from the re-audit pass:
--
-- F1: claim_tenant_membership() is SECURITY DEFINER but the
--     migration installed no REVOKE / GRANT. PostgREST's
--     `authenticated` role inherits EXECUTE from PUBLIC, so any
--     authenticated user could call the RPC with an arbitrary
--     p_tenant_id and self-insert into a foreign tenant as
--     status='pending'. The fix:
--       - REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated.
--       - GRANT EXECUTE ... TO service_role only.
--       - SET search_path = public, pg_temp inside the function so a
--         malicious tenant cannot shadow built-ins via a search-path
--         attack (defense-in-depth even with locked-down execute
--         grant).
--
-- F2: search_path hardening on every existing SECURITY DEFINER
--     function in the schema (only one today: the new
--     claim_tenant_membership). Future SECURITY DEFINER functions
--     should follow this pattern.
--
-- Idempotent.

-- Lock down EXECUTE on the new RPC. PostgREST exposes only
-- functions to which `anon` or `authenticated` have EXECUTE.
revoke execute on function claim_tenant_membership(uuid, uuid, text, text, text, text, text, text, boolean) from public;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function claim_tenant_membership(uuid, uuid, text, text, text, text, text, text, boolean) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke execute on function claim_tenant_membership(uuid, uuid, text, text, text, text, text, text, boolean) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function claim_tenant_membership(uuid, uuid, text, text, text, text, text, text, boolean) to service_role';
  end if;
end $$;

-- Pin search_path so the function cannot be tricked by a tenant
-- creating a public.tenant_members shadow (defense-in-depth even
-- after the EXECUTE revoke; if a future migration accidentally
-- re-grants EXECUTE this guard prevents a search-path attack).
alter function claim_tenant_membership(uuid, uuid, text, text, text, text, text, text, boolean)
  set search_path = public, pg_temp;

-- Caller-identity guard inside the function body. Belt-and-braces:
-- even if a future migration re-grants EXECUTE to authenticated,
-- the function refuses to act for a JWT user other than p_user_id.
-- Service-role calls bypass auth.uid() (returns NULL), so the
-- existing tenancy.js path keeps working unchanged.
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

-- Re-apply the EXECUTE revokes after CREATE OR REPLACE, in case
-- the replace reset them (Postgres preserves EXECUTE grants on
-- replace, but we make the lockdown explicit and idempotent).
revoke execute on function claim_tenant_membership(uuid, uuid, text, text, text, text, text, text, boolean) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function claim_tenant_membership(uuid, uuid, text, text, text, text, text, text, boolean) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke execute on function claim_tenant_membership(uuid, uuid, text, text, text, text, text, text, boolean) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function claim_tenant_membership(uuid, uuid, text, text, text, text, text, text, boolean) to service_role';
  end if;
end $$;
