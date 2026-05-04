-- 024_edi.sql
-- EDI message translation (X12 + EDIFACT). Anvil acts as a thin
-- translation layer: AS2/SFTP transport is handled outside (Cleo,
-- Mulesoft, ECGrid). This schema captures inbound and outbound
-- envelopes, parsed canonical form, and the order/invoice they
-- map to.
-- Idempotent.

create table if not exists edi_partners (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  isa_qualifier text,                   -- ZZ, 01, etc
  isa_id text,                          -- our trading-partner id
  partner_isa_qualifier text,
  partner_isa_id text,
  default_format text not null default 'x12' check (default_format in ('x12','edifact')),
  envelopes_in int not null default 0,
  envelopes_out int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);

alter table edi_partners enable row level security;
drop policy if exists "edi_partners_all" on edi_partners;
create policy "edi_partners_all" on edi_partners
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

create table if not exists edi_envelopes (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  partner_id uuid references edi_partners(id) on delete set null,
  direction text not null check (direction in ('inbound','outbound')),
  format text not null check (format in ('x12','edifact')),
  message_type text not null,           -- 850 / 855 / 856 / 810 / ORDERS / ORDRSP
  control_number text,
  raw_payload text not null,            -- the X12/EDIFACT string
  parsed jsonb default '{}'::jsonb,
  status text not null default 'received' check (status in ('received','translated','linked','sent','acknowledged','failed')),
  order_id uuid references orders(id),
  invoice_id uuid references invoices(id),
  error text,
  ack_payload text,                     -- 997/CONTRL acknowledgement
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz
);

create index if not exists edi_envelopes_tenant_idx on edi_envelopes (tenant_id, created_at desc);
create index if not exists edi_envelopes_message_idx on edi_envelopes (tenant_id, message_type);
create index if not exists edi_envelopes_partner_idx on edi_envelopes (tenant_id, partner_id);

alter table edi_envelopes enable row level security;
drop policy if exists "edi_envelopes_all" on edi_envelopes;
create policy "edi_envelopes_all" on edi_envelopes
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
