-- 027_mcp_tokens.sql
-- Per-tenant MCP (Model Context Protocol) tokens that authorise
-- external AI assistants (Claude desktop, ChatGPT plugins, GitHub
-- Copilot Workspace) to query Anvil's data plane via /api/mcp/server.
--
-- Token surface mirrors the pattern of portal_tokens: random hex
-- token, hashed at rest (sha256), revocable, scoped, expirable.
-- Scopes are the same set declared in src/api/_lib/erp-chat-tools.js
-- (read.orders, read.invoices, read.customers, read.inventory,
--  read.pipeline, read.misc).
-- Idempotent.

create table if not exists mcp_tokens (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  name text not null,                         -- "Claude desktop on Daisy's MacBook"
  token_hash text not null,                   -- sha256 of the plaintext token
  token_prefix text not null,                 -- first 8 chars of plaintext, for UI hints
  scopes text[] not null default array['read.orders','read.invoices','read.customers','read.inventory','read.pipeline'],
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  use_count int not null default 0,
  created_at timestamptz not null default now(),
  unique (tenant_id, token_hash)
);

create index if not exists mcp_tokens_hash_idx on mcp_tokens (token_hash);
create index if not exists mcp_tokens_tenant_idx on mcp_tokens (tenant_id, created_at desc);

alter table mcp_tokens enable row level security;
drop policy if exists "mcp_tokens_admin" on mcp_tokens;
create policy "mcp_tokens_admin" on mcp_tokens
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- Per-call audit log. We deliberately split this from the generic
-- audit_events so MCP traffic can be retained on its own schedule
-- and so usage charts (calls / day, top tools) read fast.
create table if not exists mcp_call_log (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  token_id uuid references mcp_tokens(id) on delete set null,
  tool text not null,
  scope text,
  args jsonb,
  status text not null default 'ok' check (status in ('ok','denied','error')),
  error text,
  latency_ms int,
  rows_returned int,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists mcp_call_log_tenant_idx on mcp_call_log (tenant_id, created_at desc);
create index if not exists mcp_call_log_token_idx on mcp_call_log (token_id, created_at desc);

alter table mcp_call_log enable row level security;
drop policy if exists "mcp_call_log_select" on mcp_call_log;
create policy "mcp_call_log_select" on mcp_call_log
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
