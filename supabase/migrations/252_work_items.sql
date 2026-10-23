-- 252_work_items.sql
--
-- The work item: one piece of human work with an owner, a due time, a
-- priority and a state. docs/WORK_MANAGEMENT_SCOPE.md section 4.2 designs it;
-- docs/EMAIL_ACCOUNTABILITY_SCOPE.md section 6.4 (decision ED-1) builds it
-- first, as the home of email actions. Email actions are type 'task' with
-- subject_type 'email_action'.
--
-- This is the subset of 4.2 that email actions use, with the same names and
-- types. WM-5 adds the rest (item_key and work_counters, the template
-- columns, custom, links, events and watchers) in its own migration with
-- "add column if not exists", so nothing here needs to change.
--
-- Rules from 4.3 that the columns carry:
--   - An item made by an event is idempotent: source_key is unique while the
--     item is open.
--   - status is a discriminator. No code may write a default status on a
--     missing-column error.
--
-- RLS is on with NO policy for tenant users. Email items carry mail subjects,
-- and the API applies the per-item visibility rule (owner, backup, mailbox,
-- email.view_all). WM-5 adds tenant-user policies for the item kinds that
-- need them.
--
-- Additive and idempotent. APPLY BY HAND, then:
--
--   notify pgrst, 'reload schema';
--
-- VERIFY. Expect 1.
--
--   select count(*) from information_schema.tables where table_name = 'work_items';

create table if not exists work_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  type text not null check (type in ('opportunity', 'project', 'task', 'gate', 'issue')),
  category text,
  title text,
  detail text,

  -- What the item is about. Polymorphic; the code checks it.
  subject_type text not null,
  subject_id uuid not null,

  -- Ancestry. account_id is the customer.
  account_id uuid references customers(id) on delete set null,
  opportunity_id uuid references opportunities(id) on delete set null,
  project_id uuid references projects(id) on delete set null,
  order_id uuid references orders(id) on delete set null,
  parent_id uuid references work_items(id) on delete set null,

  status text,
  status_category text
    check (status_category in ('todo', 'in_progress', 'blocked', 'done', 'cancelled')),
  blocked_reason text,
  blocked_since timestamptz,
  resolution text,

  assignee_user_id uuid references auth.users(id) on delete set null,
  assignee_role text,

  start_at timestamptz,
  due_at timestamptz,
  due_source text
    check (due_source in ('manual', 'sla', 'schedule', 'customer_commit', 'follow_up', 'gate')),
  due_basis jsonb,
  priority smallint not null default 3 check (priority between 1 and 4),

  source text not null default 'manual'
    check (source in ('manual', 'event', 'template', 'automation', 'sweep', 'agent')),
  source_key text,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_by uuid references auth.users(id) on delete set null,
  completed_at timestamptz,
  version int not null default 1,

  constraint work_items_header_or_owned_state check (
    type in ('opportunity', 'project')
    or (title is not null and status is not null and status_category is not null)
  ),
  constraint work_items_blocked_has_reason check (
    status_category is distinct from 'blocked' or blocked_reason is not null
  )
);

create unique index if not exists work_items_source_key_open_uq
  on work_items (tenant_id, source_key)
  where source_key is not null and status_category not in ('done', 'cancelled');
create unique index if not exists work_items_header_subject_uq
  on work_items (tenant_id, subject_type, subject_id)
  where type in ('opportunity', 'project');
create index if not exists work_items_assignee_idx
  on work_items (tenant_id, assignee_user_id, status_category, due_at);
create index if not exists work_items_role_queue_idx
  on work_items (tenant_id, assignee_role, status_category)
  where assignee_user_id is null;
create index if not exists work_items_subject_idx on work_items (subject_type, subject_id);
create index if not exists work_items_order_idx on work_items (tenant_id, order_id);
create index if not exists work_items_opportunity_idx on work_items (tenant_id, opportunity_id);
create index if not exists work_items_account_idx on work_items (tenant_id, account_id);

comment on table work_items is
  'One piece of human work: owner, due time, priority, state. WORK_MANAGEMENT_SCOPE.md 4.2 (subset). First used by email actions. RLS on, no tenant-user policy yet: the API applies visibility.';

alter table work_items enable row level security;
revoke all on work_items from anon, authenticated;
