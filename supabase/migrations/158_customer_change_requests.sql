-- 158_customer_change_requests.sql
--
-- Customer data entry with approval. Write-role users (sales/procurement)
-- submit a create/update as a pending request instead of writing the master
-- directly; an approver (sales_manager/finance/admin) approves -> the change
-- is applied to `customers`, or rejects with a reason. Admins may still apply
-- directly. Keeps the customer-master guard rail while unblocking data entry.

create table if not exists customer_change_requests (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  change_type text not null check (change_type in ('create', 'update')),
  target_customer_id uuid references customers(id) on delete cascade,  -- null for create
  payload jsonb not null default '{}'::jsonb,                          -- proposed fields
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_by uuid references auth.users(id),
  decided_by uuid references auth.users(id),
  decided_reason text,
  applied_customer_id uuid references customers(id) on delete set null, -- created/updated on approve
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create index if not exists customer_change_requests_idx
  on customer_change_requests (tenant_id, status, created_at desc);

alter table customer_change_requests enable row level security;
drop policy if exists "customer_change_requests_all" on customer_change_requests;
create policy "customer_change_requests_all" on customer_change_requests
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
