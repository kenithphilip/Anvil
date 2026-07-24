-- Function-based communication routing: document_type x customer function -> To/CC.
--
-- A customer is not a person. It is a company with FUNCTIONS — stores,
-- accounts, purchase, quality, management. A dispatch register goes TO the
-- stores team with purchase and accounts in CC; a payment reminder goes TO
-- accounts. Same customer, different recipient sets, per document type.
--
-- customer_contacts (065) could not express any of that: it has a free-text
-- `role`, `is_primary`, and nothing else. No taxonomy, no per-document-type
-- subscription, no To/CC.
--
-- See docs/CUSTOMER_COMMS_DESIGN.md §3.

-- ── 1. The function taxonomy — TENANT DATA, not an enum ───────────────────
-- Deliberately a table, not a CHECK constraint: one tenant's "stores" is
-- another's "warehouse" or "receiving", and a services business has neither.
-- An enum would need a migration per tenant vocabulary.
create table if not exists contact_functions (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  code text not null,                         -- stable key: 'stores', 'accounts'
  label text not null,                        -- what the operator sees
  sort_order int not null default 100,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, code)
);

create index if not exists contact_functions_tenant_idx
  on contact_functions (tenant_id, sort_order) where is_active;

alter table contact_functions enable row level security;
drop policy if exists contact_functions_select on contact_functions;
create policy contact_functions_select on contact_functions
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists contact_functions_write on contact_functions;
create policy contact_functions_write on contact_functions
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

comment on table contact_functions is
  'Per-tenant taxonomy of customer-side functions (stores, accounts, purchase, '
  'quality, management). Seeded and editable — NOT an enum, because the '
  'vocabulary is entity-specific.';

-- ── 2. Attach a function to a contact ─────────────────────────────────────
-- `role` stays as legacy free text; nothing reads it for routing.
alter table customer_contacts
  add column if not exists function_id uuid references contact_functions(id) on delete set null,
  add column if not exists is_active boolean not null default true;

create index if not exists customer_contacts_function_idx
  on customer_contacts (tenant_id, customer_id, function_id) where is_active;

-- Marketing consent is per CONTACT and legally distinct from transactional
-- mail. Absence of consent means no marketing — and must never affect a
-- payment reminder or a PoD. See docs/CUSTOMER_COMMS_DESIGN.md §6.
alter table customer_contacts
  add column if not exists marketing_consent boolean not null default false,
  add column if not exists consent_source text,
  add column if not exists consent_recorded_at timestamptz;

-- ── 3. The routing matrix ─────────────────────────────────────────────────
-- One row per (customer, document_type, function) with a To/CC/BCC
-- disposition. Absence of any row is NOT an error — the resolver falls back
-- (see _lib/comms-routing.js). Redundancy, not a gate.
create table if not exists comms_routing_rules (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  document_type text not null,
  function_id uuid not null references contact_functions(id) on delete cascade,
  disposition text not null default 'to' check (disposition in ('to', 'cc', 'bcc')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, customer_id, document_type, function_id)
);

create index if not exists comms_routing_lookup_idx
  on comms_routing_rules (tenant_id, customer_id, document_type) where is_active;

alter table comms_routing_rules enable row level security;
drop policy if exists comms_routing_rules_select on comms_routing_rules;
create policy comms_routing_rules_select on comms_routing_rules
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists comms_routing_rules_write on comms_routing_rules;
create policy comms_routing_rules_write on comms_routing_rules
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

comment on table comms_routing_rules is
  'document_type x function -> To/CC/BCC, per customer. No rule is not an '
  'error: the resolver degrades to the function, then the primary contact, '
  'then the operator, recording which fallback fired.';

-- ── 4. Seed a starting taxonomy for every existing tenant ─────────────────
-- Generic on purpose. A tenant renames or deletes what does not apply; the
-- point is that routing is configurable from day one rather than empty.
insert into contact_functions (tenant_id, code, label, sort_order)
select t.id, v.code, v.label, v.sort_order
  from tenants t
 cross join (values
   ('stores',     'Stores / Receiving', 10),
   ('purchase',   'Purchase',           20),
   ('accounts',   'Accounts / Finance', 30),
   ('quality',    'Quality',            40),
   ('management', 'Management',         50)
 ) as v(code, label, sort_order)
 where not exists (
   select 1 from contact_functions cf
    where cf.tenant_id = t.id and cf.code = v.code
 );
