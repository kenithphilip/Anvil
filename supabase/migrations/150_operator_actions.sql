-- 150_operator_actions.sql
-- Governed operator actions (PR4). See docs/OPERATOR_ACTIONS_DESIGN.md.
--
-- Brings API-less workflow steps (thick clients, VDI, admin consoles)
-- onto the same approval + audit rails: a typed ordered checklist with
-- captured evidence (reusing the documents bucket + OCR) and a governed
-- reconcile-back into Anvil's system of record. v1 is human-in-the-loop;
-- the schema is designed so a computer-use driver can later sit behind
-- the same contract. Flag-gated off by default; strictly additive.

alter table tenant_settings
  add column if not exists operator_actions_enabled boolean default false;

create table if not exists operator_actions (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  action_type text,                          -- neutral: erp_screen_entry | portal_download | console_approval | ...
  title text not null,
  target_system text,                        -- the API-less system worked in
  object_type text,                          -- optional related Anvil object: order | source_po | invoice | ...
  object_id uuid,                            -- validated in code (no cross-table FK)
  status text not null default 'proposed'
    check (status in ('proposed','in_progress','evidence_captured','reconciled','abandoned')),
  requires_evidence boolean not null default true,
  reconcile_contract jsonb not null default '{}'::jsonb,
  reconcile_result jsonb,
  driver text not null default 'human',      -- 'human' now; 'cua' later (the driver seam)
  created_by uuid references auth.users(id) on delete set null,
  started_by uuid references auth.users(id) on delete set null,
  reconciled_by uuid references auth.users(id) on delete set null,
  started_at timestamptz,
  reconciled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists operator_actions_tenant_idx on operator_actions (tenant_id, status, created_at desc);
create index if not exists operator_actions_object_idx on operator_actions (tenant_id, object_type, object_id);

create table if not exists operator_action_steps (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  operator_action_id uuid not null references operator_actions(id) on delete cascade,
  seq int not null,
  instruction text not null,
  expected text,
  status text not null default 'pending' check (status in ('pending','done','skipped')),
  notes text,
  done_by uuid references auth.users(id) on delete set null,
  done_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, operator_action_id, seq)
);
create index if not exists operator_action_steps_idx on operator_action_steps (tenant_id, operator_action_id, seq);

create table if not exists operator_action_evidence (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  operator_action_id uuid not null references operator_actions(id) on delete cascade,
  step_id uuid references operator_action_steps(id) on delete set null,
  document_id uuid references documents(id) on delete set null,
  kind text,                                 -- screenshot | export | diff | note
  ocr_text text,
  captured_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists operator_action_evidence_idx on operator_action_evidence (tenant_id, operator_action_id, created_at desc);

alter table operator_actions enable row level security;
drop policy if exists operator_actions_select on operator_actions;
create policy operator_actions_select on operator_actions
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists operator_actions_write on operator_actions;
create policy operator_actions_write on operator_actions
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

alter table operator_action_steps enable row level security;
drop policy if exists operator_action_steps_select on operator_action_steps;
create policy operator_action_steps_select on operator_action_steps
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists operator_action_steps_write on operator_action_steps;
create policy operator_action_steps_write on operator_action_steps
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

alter table operator_action_evidence enable row level security;
drop policy if exists operator_action_evidence_select on operator_action_evidence;
create policy operator_action_evidence_select on operator_action_evidence
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists operator_action_evidence_write on operator_action_evidence;
create policy operator_action_evidence_write on operator_action_evidence
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

comment on table operator_actions is
  'PR4 governed operator actions: a checklist + evidence + reconcile record for API-less workflow steps, on the same approval + audit rails. Flag-gated by tenant_settings.operator_actions_enabled.';
