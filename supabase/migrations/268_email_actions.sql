-- 268_email_actions.sql
--
-- Email accountability, EA-3. docs/EMAIL_ACCOUNTABILITY_SCOPE.md 6.2 to 6.5.
--
--   email_actions          the email side of one action. Its owner, due time,
--                          priority and state live on the work_items row
--                          (migration 252) it points to. Stores IDs and short
--                          metadata only: no body, no attachment.
--   email_rules            tenant rules, or rules of one user (scope_user_id):
--                          trusted senders, keywords, customer rules,
--                          exclusions, deadlines.
--   email_action_ensure()  makes the work item and the email action in ONE
--                          transaction, or returns the existing pair. The
--                          unique key (tenant_id, message_key, action_type) holds
--                          for life, so a replayed sync page, a reset
--                          checkpoint or a second mailbox that received the
--                          same message never makes a second action.
--   tenant_settings        email_actions_mode: 'observe' (default) counts what
--                          the rules would create and writes nothing; 'create'
--                          makes the actions. Turn it to 'create' after the
--                          counts look right (the logistics monitor's first
--                          run made ~2,000 wrong rows; this avoids that).
--                          email_content_retention_days: after this many days
--                          the daily sweep (EA-8) clears the preview text.
--
-- RLS is on with NO policy for tenant users (mail subjects and senders). The
-- API applies the visibility rule. The function runs for the service role
-- only.
--
-- Additive and idempotent. APPLY BY HAND after 252 and 267, then:
--
--   notify pgrst, 'reload schema';
--
-- VERIFY. Expect 2 and 1.
--
--   select count(*) from information_schema.tables
--    where table_name in ('email_actions', 'email_rules');
--   select count(*) from pg_proc where proname = 'email_action_ensure';

create table if not exists email_actions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  work_item_id uuid unique references work_items(id) on delete cascade,
  connection_id uuid references mailbox_connections(id) on delete set null,

  provider text not null check (provider in ('outlook', 'gmail')),
  provider_message_id text not null,
  internet_message_id text,
  message_key text generated always as
    (coalesce(internet_message_id, provider || ':' || provider_message_id)) stored,
  conversation_id text,
  conversation_index text,
  thread_refs text[] not null default '{}',

  from_address text,
  from_name text,
  to_addresses text[] not null default '{}',
  cc_addresses text[] not null default '{}',
  subject text,
  preview text,
  received_at timestamptz,
  web_link text,
  customer_contact_id uuid references customer_contacts(id) on delete set null,

  action_type text not null check (action_type in
    ('reply', 'forward', 'provide_documents', 'confirm_payment', 'obtain_approval', 'investigate')),
  -- What evidence completes it (plan 6.6).
  requirement text not null check (requirement in
    ('reply_to_sender', 'reply_with_attachment', 'forward_to_target', 'manual')),
  forward_to text[] not null default '{}',
  -- The business outcome, kept apart from the action state on work_items.
  business_status text not null default 'not_assessed' check (business_status in
    ('not_assessed', 'awaiting_internal', 'awaiting_external', 'in_progress', 'resolved', 'closed')),
  -- [{ kind: 'fact' | 'inferred', code, text }]
  reasons jsonb not null default '[]'::jsonb,
  consequence text,
  backup_user_id uuid references auth.users(id) on delete set null,
  due_timezone text not null default 'Asia/Kolkata',
  escalation_level int not null default 0,
  reopen_count int not null default 0,
  seen_connection_ids uuid[] not null default '{}',

  last_synced_at timestamptz,
  last_activity_at timestamptz,
  content_purged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists email_actions_message_uq
  on email_actions (tenant_id, message_key, action_type);
create index if not exists email_actions_imid_idx
  on email_actions (tenant_id, internet_message_id);
create index if not exists email_actions_conversation_idx
  on email_actions (tenant_id, conversation_id);
create index if not exists email_actions_connection_idx
  on email_actions (tenant_id, connection_id);

comment on table email_actions is
  'Email accountability: the email side of one action; owner, due time, priority and state are on work_items. IDs and short metadata only. RLS on, no tenant-user policy: the API applies visibility.';

create table if not exists email_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  -- Null: a tenant rule (admin). Set: applies to that user's mailboxes only.
  scope_user_id uuid references auth.users(id) on delete cascade,
  kind text not null check (kind in ('trusted_sender', 'keyword', 'customer', 'exclusion', 'deadline')),
  -- trusted_sender, exclusion: an address or "@domain" (exclusion also a
  -- subject phrase); keyword: a phrase; customer: a customer id; deadline: an
  -- action type or "*".
  pattern text not null check (length(pattern) between 1 and 200),
  -- { priority, action_type, due_hours }
  effect jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists email_rules_tenant_idx on email_rules (tenant_id, active);

alter table email_actions enable row level security;
revoke all on email_actions from anon, authenticated;
alter table email_rules enable row level security;
revoke all on email_rules from anon, authenticated;

alter table tenant_settings
  add column if not exists email_actions_mode text not null default 'observe',
  add column if not exists email_content_retention_days int not null default 30;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenant_settings_email_retention_chk') then
    alter table tenant_settings add constraint tenant_settings_email_retention_chk
      check (email_content_retention_days between 1 and 3650);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tenant_settings_email_actions_mode_chk') then
    alter table tenant_settings add constraint tenant_settings_email_actions_mode_chk
      check (email_actions_mode in ('observe', 'create'));
  end if;
end $$;

-- p_item:   { title, detail, category, account_id, opportunity_id, order_id,
--             status, status_category, assignee_user_id, assignee_role,
--             due_at, due_source, due_basis, priority }
-- p_action: the email_actions columns, with arrays as JSON arrays.
-- Returns the action id, the work item id, and whether this call made them.
create or replace function email_action_ensure(p_item jsonb, p_action jsonb)
returns table (out_action_id uuid, out_item_id uuid, out_created boolean)
language plpgsql
set search_path = public
as $$
declare
  v_tenant uuid := (p_action->>'tenant_id')::uuid;
  v_type text := p_action->>'action_type';
  v_conn uuid := nullif(p_action->>'connection_id', '')::uuid;
  v_key text := coalesce(nullif(p_action->>'internet_message_id', ''),
                         (p_action->>'provider') || ':' || (p_action->>'provider_message_id'));
  v_action uuid;
  v_item uuid;
begin
  insert into email_actions as ea (
    tenant_id, connection_id, provider, provider_message_id, internet_message_id,
    conversation_id, conversation_index, thread_refs,
    from_address, from_name, to_addresses, cc_addresses, subject, preview,
    received_at, web_link, customer_contact_id,
    action_type, requirement, forward_to, business_status, reasons, consequence,
    backup_user_id, due_timezone, seen_connection_ids, last_synced_at, last_activity_at
  ) values (
    v_tenant, v_conn, p_action->>'provider', p_action->>'provider_message_id',
    nullif(p_action->>'internet_message_id', ''),
    p_action->>'conversation_id', p_action->>'conversation_index',
    array(select jsonb_array_elements_text(p_action->'thread_refs')),
    p_action->>'from_address', p_action->>'from_name',
    array(select jsonb_array_elements_text(p_action->'to_addresses')),
    array(select jsonb_array_elements_text(p_action->'cc_addresses')),
    p_action->>'subject', p_action->>'preview',
    (p_action->>'received_at')::timestamptz, p_action->>'web_link',
    nullif(p_action->>'customer_contact_id', '')::uuid,
    v_type, p_action->>'requirement',
    array(select jsonb_array_elements_text(p_action->'forward_to')),
    coalesce(p_action->>'business_status', 'not_assessed'),
    coalesce(p_action->'reasons', '[]'::jsonb),
    p_action->>'consequence',
    nullif(p_action->>'backup_user_id', '')::uuid,
    coalesce(p_action->>'due_timezone', 'Asia/Kolkata'),
    case when v_conn is null then '{}'::uuid[] else array[v_conn] end,
    now(), now()
  )
  on conflict (tenant_id, message_key, action_type) do nothing
  returning ea.id into v_action;

  if v_action is null then
    -- The action exists: record that this mailbox saw the message too.
    update email_actions e
       set seen_connection_ids = case
             when v_conn is null or v_conn = any(e.seen_connection_ids) then e.seen_connection_ids
             else e.seen_connection_ids || v_conn end,
           last_synced_at = now()
     where e.tenant_id = v_tenant and e.message_key = v_key and e.action_type = v_type
     returning e.id, e.work_item_id into v_action, v_item;
    return query select v_action, v_item, false;
    return;
  end if;

  insert into work_items (
    tenant_id, type, category, title, detail, subject_type, subject_id,
    account_id, opportunity_id, order_id,
    status, status_category, assignee_user_id, assignee_role,
    due_at, due_source, due_basis, priority, source, source_key
  ) values (
    v_tenant, 'task', p_item->>'category', p_item->>'title', p_item->>'detail',
    'email_action', v_action,
    nullif(p_item->>'account_id', '')::uuid,
    nullif(p_item->>'opportunity_id', '')::uuid,
    nullif(p_item->>'order_id', '')::uuid,
    p_item->>'status', p_item->>'status_category',
    nullif(p_item->>'assignee_user_id', '')::uuid, p_item->>'assignee_role',
    (p_item->>'due_at')::timestamptz, p_item->>'due_source', p_item->'due_basis',
    coalesce((p_item->>'priority')::smallint, 3), 'event', 'email_action:' || v_action
  )
  returning id into v_item;

  update email_actions set work_item_id = v_item where id = v_action;
  return query select v_action, v_item, true;
end;
$$;

-- PostgREST exposes a function to the roles that may execute it. Only the
-- service role may (the 060 pattern).
revoke all on function email_action_ensure(jsonb, jsonb) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function email_action_ensure(jsonb, jsonb) to service_role';
  end if;
end $$;
