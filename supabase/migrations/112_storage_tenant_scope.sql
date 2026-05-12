-- 112_storage_tenant_scope.sql
--
-- Phase 1 F5 from docs/audits/2026_05_11_product_deep_dive/phases/01_p0_fixes.md.
--
-- The 001_init.sql storage policies authorize any authenticated
-- user to read or write any object in the `obara-documents` and
-- `anvil-documents` buckets:
--
--     for select using (bucket_id = 'obara-documents' and
--                       auth.role() = 'authenticated');
--
-- Consequence: a leaked auth token from any tenant could fetch
-- any document path in either bucket, even if the path belonged
-- to a different tenant. SOC 2 and DPDP / GDPR cross-tenant
-- isolation requirements cannot be claimed with this policy.
--
-- The fix is a path-scoped RLS policy. Anvil writes objects with
-- the tenant_id as either the first or second folder segment,
-- depending on the writer:
--
--   - documents/upload.js, quotes/pdf.js, invoices/pdf.js,
--     invoices/send.js, quotes/send.js, email/inbound.js
--     -> `<tenant_uuid>/<...>`
--   - inbound/email/_lib/persist-attachments.js
--     -> `inbound/<tenant_uuid>/<...>`
--   - orders/traveler.js
--     -> `travelers/<tenant_uuid>/<...>`
--
-- The new policy whitelists the two known category prefixes; for
-- every other path the tenant_uuid must be the first folder
-- segment. The check uses current_tenant_ids() from 001_init.sql
-- which reads tenant_members for the authenticated user.

-- 0. Surface a count of currently-existing paths in each bucket
-- so the migration's audit_event row tells operators how many
-- objects fall under the new policy. Service-role inserts bypass
-- RLS so this query stays observability-only.
do $$
declare
  total_objects bigint;
  obara_objects bigint;
  anvil_objects bigint;
begin
  select count(*) into obara_objects from storage.objects where bucket_id = 'obara-documents';
  select count(*) into anvil_objects from storage.objects where bucket_id = 'anvil-documents';
  total_objects := coalesce(obara_objects, 0) + coalesce(anvil_objects, 0);

  insert into audit_events (tenant_id, action, object_type, object_id, detail, created_at)
  values (null, 'rls.storage_tenant_scope.bringup', 'storage.objects', null,
          'obara=' || coalesce(obara_objects, 0) ||
          ', anvil=' || coalesce(anvil_objects, 0) ||
          ', total=' || total_objects, now())
  on conflict do nothing;
end $$;

-- 1. Drop the open policies and replace with the strict
-- path-scoped ones. We use a helper that derives the path's
-- first two folder segments and matches whichever holds the
-- tenant_uuid. Service-role inserts (the API server) bypass RLS
-- so application writes remain unaffected; the policy gates
-- only browser-direct calls.

do $$
begin
  -- Allow drop even if the policy was renamed in a prior
  -- migration; raise nothing for missing.
  begin drop policy if exists "obara documents read" on storage.objects; exception when undefined_object then null; end;
  begin drop policy if exists "obara documents write" on storage.objects; exception when undefined_object then null; end;
  begin drop policy if exists "obara documents update" on storage.objects; exception when undefined_object then null; end;
  begin drop policy if exists "obara documents delete" on storage.objects; exception when undefined_object then null; end;
  begin drop policy if exists "anvil documents read" on storage.objects; exception when undefined_object then null; end;
  begin drop policy if exists "anvil documents write" on storage.objects; exception when undefined_object then null; end;
end $$;

-- Helper: extract the tenant UUID from a known path layout.
-- Returns null when the layout does not match any known
-- convention, which causes the policy to deny.
create or replace function storage_path_tenant_uuid(name text)
  returns uuid
  language sql immutable
as $$
  with parts as (select string_to_array(name, '/') as p)
  select case
    -- Category-prefixed conventions (inbound/, travelers/) put
    -- the tenant uuid in the second segment.
    when (parts.p)[1] in ('inbound', 'travelers') then
      nullif((parts.p)[2], '')::uuid
    -- Default convention puts the tenant uuid in the first
    -- segment.
    else
      nullif((parts.p)[1], '')::uuid
  end
  from parts;
$$ language sql immutable;

-- Wrap in exception block: storage.objects path values that do
-- not parse as UUID raise on insert; the policy short-circuits
-- to false in that case rather than crashing the storage layer.
create or replace function storage_path_tenant_ok(name text, bucket text)
  returns boolean
  language plpgsql
  immutable
as $$
declare
  candidate uuid;
begin
  if bucket not in ('obara-documents', 'anvil-documents') then
    return false;
  end if;
  begin
    candidate := storage_path_tenant_uuid(name);
  exception
    when others then
      return false;
  end;
  if candidate is null then
    return false;
  end if;
  return candidate in (select current_tenant_ids());
end;
$$;

-- 2. Install path-scoped policies on the two managed buckets.

create policy "documents read tenant scoped" on storage.objects
  for select
  using (
    bucket_id in ('obara-documents', 'anvil-documents')
    and storage_path_tenant_ok(name, bucket_id)
  );

create policy "documents insert tenant scoped" on storage.objects
  for insert
  with check (
    bucket_id in ('obara-documents', 'anvil-documents')
    and storage_path_tenant_ok(name, bucket_id)
  );

create policy "documents update tenant scoped" on storage.objects
  for update
  using (
    bucket_id in ('obara-documents', 'anvil-documents')
    and storage_path_tenant_ok(name, bucket_id)
  );

create policy "documents delete tenant scoped" on storage.objects
  for delete
  using (
    bucket_id in ('obara-documents', 'anvil-documents')
    and storage_path_tenant_ok(name, bucket_id)
  );

-- 3. Ensure the anvil-documents bucket exists so the policies
-- have something to gate (some legacy deployments only have
-- obara-documents).
insert into storage.buckets (id, name, public)
values ('anvil-documents', 'anvil-documents', false)
on conflict (id) do nothing;
