-- 081_deploy_events_tenant_scope.sql
--
-- Tightens the deploy_events table from the May 2026 critic audit.
-- 079_deploy_events.sql shipped with an "any authenticated user can
-- SELECT" RLS policy: the table is intentionally tenant-agnostic
-- (a deploy is a code event, not a tenant event), but the API GET
-- endpoint did not scope by tenant either, so a user from tenant A
-- could enumerate every production deploy, commit SHA, and commit
-- message that any other tenant's instance has shipped. The SOC 2
-- comment in the endpoint described intent that the code did not
-- enforce.
--
-- Resolution: deploy events are private to the platform operator
-- (Anvil itself), not per-tenant readable. We tighten the SELECT
-- RLS policy to admin-role users only. The API endpoint's
-- requirePermission(ctx, "read") -> requirePermission(ctx, "admin")
-- shift in the same PR makes the in-app authorization match the
-- DB-level policy.
--
-- Idempotent.

drop policy if exists "deploy_events_authenticated_read" on deploy_events;

-- Bug fix May 2026 (re-roll): the original migration didn't drop the
-- target policy before creating it, so a partial run that succeeded
-- past line 28 left "deploy_events_admin_read" on the table and the
-- next attempt blew up with `policy already exists`. Idempotency
-- guard added.
drop policy if exists "deploy_events_admin_read" on deploy_events;

-- Service role + supabase admin can always read (for the cron
-- writer + the auditor's direct DB session). For app-side reads,
-- only users whose JWT carries role='admin' or role='service' can
-- SELECT.
create policy "deploy_events_admin_read" on deploy_events
  for select using (
    auth.role() = 'service_role'
    or (current_setting('request.jwt.claims', true)::json->>'role') = 'admin'
  );
