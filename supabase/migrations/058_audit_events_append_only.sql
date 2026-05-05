-- 058_audit_events_append_only.sql
-- Security audit P0 (May 2026, finding C4).
--
-- Before: migration 001_init.sql installed two policies on
-- audit_events that allowed mutation:
--
--   tenant_update : USING (tenant_id in (current_tenant_ids()))
--                   -- any tenant member can UPDATE
--   tenant_delete : USING (tenant_id in (current_tenant_ids()))
--                   -- any tenant member can DELETE
--   audit_no_update / audit_no_delete : USING (role = 'admin')
--                   -- the names suggest restriction; PostgreSQL
--                   -- OR's policies together, so admins also pass.
--
-- Net effect: a tenant admin (and any tenant member) could DELETE
-- audit_events rows through PostgREST, breaking the SOC 2 CC7.2 /
-- CC7.3 control evidence chain. The HMAC-signed audit/export
-- ndjson then signs an already-tampered trail.
--
-- After this migration: audit_events is read-only for everyone
-- holding a tenant JWT. INSERTs continue to work because backend
-- code uses the service-role client (which bypasses RLS). UPDATE
-- and DELETE are forbidden at the database layer.
--
-- This is idempotent: running it twice leaves the same final state.

-- Drop the four mutation-permitting policies installed by 001's macro.
drop policy if exists tenant_update on audit_events;
drop policy if exists tenant_delete on audit_events;
drop policy if exists audit_no_update on audit_events;
drop policy if exists audit_no_delete on audit_events;

-- Drop the existing select policy and re-install it explicitly so
-- the final state is unambiguous after this migration.
drop policy if exists tenant_select on audit_events;
drop policy if exists audit_select on audit_events;
create policy audit_select on audit_events
  for select using (tenant_id in (select current_tenant_ids()));

-- INSERT policy is intentionally absent. The backend writes audit
-- rows via the service-role client (`recordAudit` -> serviceClient()
-- in src/api/_lib/audit.js), which bypasses RLS. End-user JWTs
-- cannot insert directly through PostgREST.

-- Sanity: confirm no other inserts/updates/deletes are possible
-- through PostgREST. A regression test in the smoke suite should
-- attempt a DELETE via a non-service-role JWT and assert it returns
-- "permission denied" (PostgREST surfaces this as 403/empty result).
-- audit_events has no updated_at column; created_at carries a
-- column-level default of now(), so service-role inserts already
-- populate it. No additional trigger is needed.
