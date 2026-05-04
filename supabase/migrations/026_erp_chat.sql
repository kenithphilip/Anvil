-- 026_erp_chat.sql
-- Real-time ERP-query chat surface. Operators ask
-- "what's the status of PO 88123?" and get an answer that combines
-- mirrored data from NetSuite/SAP/D365/Acumatica/Tally with native
-- Anvil tables (orders, invoices, customers, einvoices).
-- Idempotent.

create table if not exists erp_chat_sessions (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  title text,
  scope jsonb default '{}'::jsonb,        -- { erps: ["netsuite","sap"], date_from: "..." }
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists erp_chat_messages (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  session_id uuid not null references erp_chat_sessions(id) on delete cascade,
  role text not null check (role in ('user','assistant','tool')),
  content text not null,
  tool_call jsonb,                        -- { name, query, ... }
  tool_result jsonb,                      -- result returned to the model
  citations jsonb default '[]'::jsonb,    -- [{ source: "netsuite_open_orders", ids: [...] }]
  model text,
  latency_ms int,
  tokens_in int,
  tokens_out int,
  created_at timestamptz not null default now()
);

create index if not exists erp_chat_msgs_session_idx on erp_chat_messages (session_id, created_at);
create index if not exists erp_chat_sessions_tenant_idx on erp_chat_sessions (tenant_id, updated_at desc);

alter table erp_chat_sessions enable row level security;
alter table erp_chat_messages enable row level security;
drop policy if exists "erp_chat_sessions_all" on erp_chat_sessions;
create policy "erp_chat_sessions_all" on erp_chat_sessions
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
drop policy if exists "erp_chat_msgs_all" on erp_chat_messages;
create policy "erp_chat_msgs_all" on erp_chat_messages
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
