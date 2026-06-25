-- 149_action_proposals.sql
-- Copilot safe actions (PR2). See the "system of action" brief.
--
-- The copilot's write-capable tools never execute on first call: they
-- create a proposal here (preview + single-use confirm_token, short TTL,
-- bound to tenant + proposer), and the action only runs when a human
-- confirms it via POST /api/copilot/confirm (approve-gated). This table
-- is the confirm-token store: a DB row gives true single-use (atomic
-- claim on consume), expiry, and an audit trail - which a stateless
-- signed token cannot (and there is no HMAC in _lib/secrets.js).

create table if not exists action_proposals (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  action text not null,                       -- e.g. create_lead | draft_and_send_comms
  args jsonb not null default '{}'::jsonb,     -- the bound action arguments
  preview jsonb not null default '{}'::jsonb,  -- human-facing preview shown before confirm
  payload_hash text,                           -- for actions bound to an approved payload (e.g. ERP push)
  confirm_token text not null unique,          -- opaque single-use token
  status text not null default 'proposed'
    check (status in ('proposed','consumed','cancelled','expired')),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  result jsonb,                                -- execution result, set on consume
  created_at timestamptz not null default now()
);
create index if not exists action_proposals_tenant_idx
  on action_proposals (tenant_id, status, created_at desc);

alter table action_proposals enable row level security;
drop policy if exists action_proposals_select on action_proposals;
create policy action_proposals_select on action_proposals
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists action_proposals_write on action_proposals;
create policy action_proposals_write on action_proposals
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

comment on table action_proposals is
  'PR2 copilot safe actions: a proposed write action with a single-use confirm_token. The action executes only when a human confirms (approve-gated); this row is the propose -> confirm -> execute audit trail.';
