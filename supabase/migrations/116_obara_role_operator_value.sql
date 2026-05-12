-- 116_obara_role_operator_value.sql
--
-- Phase 1 F11: role enum drift.
--
-- The original obara_role enum in 001_init.sql:25-27 had six
-- values: sales_engineer, sales_manager, procurement, finance,
-- admin, viewer. The frontend matrix at src/v3-app/lib/rbac.ts:19
-- treats `operator` as a first-class role with its own
-- per-screen permission grants, and docs/RBAC.md says migration
-- 010 was meant to add it, but no migration ever did. As a
-- workaround the seed at supabase/seed/100_users_and_tenants.sql:82
-- runs `alter type obara_role add value if not exists 'operator'`
-- at every seed apply, but a migrations-only deploy (the
-- production path) never picks it up. A tenant_members.insert
-- with role='operator' against a freshly-migrated production DB
-- fails at the obara_role cast.
--
-- This migration lands the enum value through the standard
-- migration path so a phase=migrations apply is sufficient. The
-- seed-time alter still runs idempotently and is now a no-op
-- against any DB that has had this migration applied.
--
-- Idempotency: `add value if not exists` is supported on
-- Postgres 12+ and is itself idempotent. The single `commit`
-- below ensures the new value is usable by any subsequent
-- migration in the same apply run (Postgres rejects use of an
-- enum value in the same transaction that added it; we commit
-- and let the next migration cast freely).

alter type obara_role add value if not exists 'operator';

commit;

comment on type obara_role is
  'sales_engineer | sales_manager | procurement | finance | admin | operator | viewer · canonical role set, mirrored in src/v3-app/lib/rbac.ts and src/api/admin/members.js ALLOWED_ROLES';
