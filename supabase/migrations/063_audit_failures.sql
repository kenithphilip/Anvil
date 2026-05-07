-- 063_audit_failures.sql
--
-- Audit P1.7 (May 2026). recordAudit() and recordEvent() in
-- src/api/_lib/audit.js used to await the Supabase insert and
-- discard the result. Supabase returns { data, error } rather
-- than throwing, so any insert that hit a constraint violation,
-- an RLS rejection, or a transient connectivity blip silently
-- vanished. The user-visible action proceeded. Only the audit
-- record disappeared.
--
-- An attacker who could deliberately cause an audit_events insert
-- to fail (e.g., by injecting a too-large `detail` payload) would
-- effectively turn auditing off for that operation.
--
-- This sentinel table captures audit-write failures so on-call can
-- monitor and react. The shape is intentionally minimal (no
-- foreign keys, no RLS) so an audit-events failure does not also
-- cause an audit_failures failure.

create table if not exists audit_failures (
  id bigint generated always as identity primary key,
  attempted_at timestamptz not null default now(),
  tenant_id uuid,
  table_name text not null,
  attempted_action text,
  attempted_object_type text,
  attempted_object_id text,
  error_message text,
  error_code text,
  raw_payload jsonb
);

create index if not exists audit_failures_attempted_at_idx
  on audit_failures (attempted_at desc);
create index if not exists audit_failures_tenant_idx
  on audit_failures (tenant_id, attempted_at desc);

comment on table audit_failures is
  'Sentinel table for audit-write failures. Monitored by on-call; a non-zero count over the last hour is a P0 alert.';
