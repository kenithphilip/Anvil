-- 042_access_approvals.sql
--
-- Approval-gated tenant memberships + in-portal admin notifications.
--
-- Why this exists: until now, /api/auth/signup auto-created an
-- approved tenant_members row and returned a session. Anyone with
-- the public signup endpoint could become a `sales_engineer` on the
-- default tenant immediately. That was fine for the early dev
-- environment but is unacceptable in production.
--
-- This migration adds:
--   1. A `status` enum on tenant_members: pending, approved, denied,
--      deactivated. Existing rows are backfilled to "approved" so
--      the change is non-disruptive for current users.
--   2. Audit columns (requested_role, requested_at, approved_by,
--      approved_at, denied_by, denied_at, denied_reason) so an
--      admin can see who decided what and when.
--   3. An `admin_notifications` table for the in-portal bell,
--      with per-user read state.
-- Idempotent.

-- ── 1. Status + audit columns on tenant_members ──────────────────

do $$ begin
  if not exists (select 1 from pg_type where typname = 'tenant_member_status') then
    create type tenant_member_status as enum ('pending', 'approved', 'denied', 'deactivated');
  end if;
end $$;

alter table tenant_members
  add column if not exists status tenant_member_status not null default 'approved',
  add column if not exists requested_role obara_role,
  add column if not exists requested_at timestamptz not null default now(),
  add column if not exists approved_by uuid references auth.users(id) on delete set null,
  add column if not exists approved_at timestamptz,
  add column if not exists denied_by uuid references auth.users(id) on delete set null,
  add column if not exists denied_at timestamptz,
  add column if not exists denied_reason text,
  -- The signup form captures these so an admin can review the
  -- request without paging through Supabase auth metadata.
  add column if not exists request_email text,
  add column if not exists request_display_name text,
  add column if not exists request_notes text;

-- Backfill: every pre-existing membership stays approved.
update tenant_members set status = 'approved' where status is null;

-- An index that makes the admin Access Requests view cheap.
create index if not exists tenant_members_status_idx
  on tenant_members (tenant_id, status, requested_at desc);

-- Helper view used by the admin endpoint: every membership joined
-- with its email + display name from auth.users. Saves the API
-- from a second roundtrip.
create or replace view tenant_members_enriched as
  select
    tm.tenant_id,
    tm.user_id,
    tm.role,
    tm.requested_role,
    tm.status,
    tm.requested_at,
    tm.approved_by,
    tm.approved_at,
    tm.denied_by,
    tm.denied_at,
    tm.denied_reason,
    tm.request_email,
    tm.request_display_name,
    tm.request_notes,
    tm.created_at,
    u.email                                   as user_email,
    u.last_sign_in_at,
    u.raw_user_meta_data ->> 'name'           as meta_name,
    u.raw_user_meta_data ->> 'full_name'      as meta_full_name
  from tenant_members tm
  left join auth.users u on u.id = tm.user_id;

-- The view inherits RLS from tenant_members; we don't add a
-- separate policy. Service-role queries (used by /api/admin/...)
-- bypass RLS as before.

-- ── 2. admin_notifications ───────────────────────────────────────
--
-- A small table so the in-portal bell can show unread items
-- without needing a websocket. Polling is fine; the volume is low
-- (signup, push failure, retry-queue stalls, ...).

create table if not exists admin_notifications (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  kind text not null,                              -- e.g. 'access_request', 'push_failed', 'cron_stalled'
  title text not null,
  body text,
  -- Where the notification deep-links to. The frontend reads
  -- link_route and pushes a hash like "#/admin?tab=access".
  link_route text,
  link_params jsonb default '{}'::jsonb,
  -- The actor that triggered the notification (e.g. the user who
  -- signed up). Null when the notification is system-wide.
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_email text,
  -- Object the notification points at (e.g. tenant_member row).
  object_type text,
  object_id uuid,
  -- Read state: a JSON array of user_ids who've marked it read.
  -- A row is "unread" for user X if X is not in this array.
  read_by uuid[] not null default '{}',
  -- Optional resolution: when an admin acts on the notification
  -- (approve / deny), set resolved + resolved_by + resolved_at so
  -- it disappears from the bell for everyone.
  resolved boolean not null default false,
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz not null default now()
);

create index if not exists admin_notifications_tenant_idx
  on admin_notifications (tenant_id, resolved, created_at desc);
create index if not exists admin_notifications_kind_idx
  on admin_notifications (tenant_id, kind);

alter table admin_notifications enable row level security;

-- Visible to any member of the same tenant (we filter by role in
-- the API layer, since the bell only renders for admins).
drop policy if exists "admin_notifications_tenant_visible" on admin_notifications;
create policy "admin_notifications_tenant_visible" on admin_notifications
  for select using (
    tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid
  );

drop policy if exists "admin_notifications_admin_modify" on admin_notifications;
create policy "admin_notifications_admin_modify" on admin_notifications
  for all using (
    tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid
  ) with check (
    tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid
  );
