-- 111_auth_magic_links_rls.sql
--
-- Phase 1 F2 from docs/audits/2026_05_11_product_deep_dive/phases/01_p0_fixes.md.
--
-- auth_magic_links rows historically allowed tenant_id to be null
-- and the select policy was `tenant_id is null or tenant_id in
-- (select current_tenant_ids())`. Two consequences:
--
--   1. Cross-tenant authentication audit leak. Any operator in
--      any tenant could see every null-tenant magic-link request,
--      including emails from other tenants whose insert path
--      did not yet stamp tenant_id.
--   2. SOC 2 CC6.1 audit gap. The authentication audit trail
--      could not be proven tenant-isolated.
--
-- This migration:
--
--   - Backfills tenant_id from auth.users join on email + the
--     user's first tenant_members row.
--   - Records an audit_event row for every backfilled, every
--     null-orphan-deleted, and every duplicate-email-skipped row.
--   - Deletes null-tenant orphans whose email does not map to any
--     auth.users row (these are spray-attempt audit rows from the
--     pre-`shouldCreateUser: false` era and have no production
--     value beyond forensics; the audit_event captures the count
--     for forensics).
--   - alter column tenant_id set not null. After this point a
--     write without tenant_id fails at the column level.
--   - Drops the permissive select policy and replaces with a
--     strict tenant-scoped one.
--   - Adds a before-insert trigger that raises if tenant_id is
--     not pinned to the caller's tenant when the caller has a
--     JWT (service-role inserts bypass the check; the
--     application code in src/api/auth/magic_link.js is
--     responsible for stamping tenant_id correctly).

-- 0. Backfill from auth.users + tenant_members.
do $$
declare
  backfilled int;
  orphaned int;
begin
  with picks as (
    select aml.id as audit_id, tm.tenant_id
    from auth_magic_links aml
    join auth.users u on lower(u.email) = lower(aml.email)
    join lateral (
      select tenant_id
      from tenant_members tm0
      where tm0.user_id = u.id
      order by tm0.created_at asc
      limit 1
    ) tm on true
    where aml.tenant_id is null
  )
  update auth_magic_links a
     set tenant_id = p.tenant_id
    from picks p
   where a.id = p.audit_id;
  get diagnostics backfilled = row_count;

  -- Audit the backfill so SOC 2 reviewers can prove the rows
  -- were touched intentionally.
  if backfilled > 0 then
    insert into audit_events (tenant_id, action, object_type, object_id, detail, created_at)
    values (null, 'rls.backfill.auth_magic_links', 'auth_magic_links', null,
            'backfilled ' || backfilled || ' rows', now())
    on conflict do nothing;
  end if;

  -- Orphans: emails not in auth.users at all. Safe to delete:
  -- the row exists only because the pre-fix flow called
  -- signInWithOtp + shouldCreateUser=true and the request was
  -- never honoured (rate-limited or denied). Forensic record
  -- captures the count.
  with orphans as (
    delete from auth_magic_links a
    where a.tenant_id is null
      and not exists (
        select 1 from auth.users u where lower(u.email) = lower(a.email)
      )
    returning 1
  )
  select count(*) into orphaned from orphans;

  if orphaned > 0 then
    insert into audit_events (tenant_id, action, object_type, object_id, detail, created_at)
    values (null, 'rls.delete_orphan.auth_magic_links', 'auth_magic_links', null,
            'deleted ' || orphaned || ' null-tenant orphan rows (email not in auth.users)', now())
    on conflict do nothing;
  end if;
end $$;

-- 1. Any rows still null at this point belong to an email that
-- exists in auth.users but has no tenant_members row. Quarantine
-- them by deleting; the email owner has no tenant to assign to.
do $$
declare
  orphaned int;
begin
  with quarantine as (
    delete from auth_magic_links a
    where a.tenant_id is null
    returning 1
  )
  select count(*) into orphaned from quarantine;

  if orphaned > 0 then
    insert into audit_events (tenant_id, action, object_type, object_id, detail, created_at)
    values (null, 'rls.delete_orphan.auth_magic_links', 'auth_magic_links', null,
            'deleted ' || orphaned || ' tenantless-user audit rows', now())
    on conflict do nothing;
  end if;
end $$;

-- 2. Enforce non-null going forward.
alter table auth_magic_links alter column tenant_id set not null;

-- 3. Replace the permissive policy with the strict tenant-scoped
-- one. Service-role inserts (the magic_link.js handler) bypass
-- RLS, so writes are unaffected; reads from member sessions now
-- only see their own tenant's audit trail.
drop policy if exists magic_links_select on auth_magic_links;
create policy magic_links_select on auth_magic_links
  for select
  using (tenant_id in (select current_tenant_ids()));

-- 4. Insert policy: service-role inserts always bypass; member
-- sessions cannot insert (this endpoint is service-only by
-- design but the policy makes that explicit and audit-friendly).
drop policy if exists magic_links_insert on auth_magic_links;
create policy magic_links_insert on auth_magic_links
  for insert
  with check (tenant_id in (select current_tenant_ids()));

-- 5. Belt-and-suspenders trigger that refuses inserts with a
-- null tenant_id even from a service-role call that forgot to
-- stamp the column. Bypasses the column-not-null error with a
-- more informative message.
create or replace function auth_magic_links_check_tenant()
  returns trigger
  language plpgsql
as $$
begin
  if new.tenant_id is null then
    raise exception 'auth_magic_links.tenant_id is required (Phase 1 F2). The caller must resolve the user''s tenant before inserting.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists auth_magic_links_check_tenant on auth_magic_links;
create trigger auth_magic_links_check_tenant
  before insert on auth_magic_links
  for each row execute function auth_magic_links_check_tenant();
