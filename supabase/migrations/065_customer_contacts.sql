-- 065_customer_contacts.sql
--
-- Audit P4.1 (May 2026). Inbound matching at
-- src/api/_lib/inbound-email.js#matchInboundToCustomer was
-- returning the first customers row whose contact_email matched,
-- or whose domain matched. A 12-person account at one customer
-- always resolved to the first contact; the actual sender's
-- identity was lost. Threads landed under the wrong person and
-- AR escalations emailed the wrong human.
--
-- This migration adds a customer_contacts table that holds one
-- row per (customer, email/phone). The matcher in P4.2 returns
-- a { customer, contact } pair so downstream uses the right
-- recipient + name.
--
-- Schema decisions:
--
--   - email is case-insensitive unique per (tenant, customer).
--     Two contacts with the same email at the same customer is a
--     dedup bug, not a use-case.
--   - role is freeform but the operator UI offers a curated list
--     (procurement, accounts, dispatch, qa, owner, other). Search
--     filters in Phase 5+ build on top.
--   - is_primary lets ar_collect / quote_accept pick a default
--     when no specific contact is on the thread.
--   - source records how the row arrived (operator, inbound_email,
--     erp_sync, portal). Useful for audit + de-dup heuristics.
--   - external_ref holds NetSuite/SAP/D365 contact IDs so the ERP
--     sync can keep them in step without creating duplicates.

create table if not exists customer_contacts (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  name text,
  email text,
  phone text,
  role text,
  is_primary boolean not null default false,
  source text not null default 'operator' check (source in
    ('operator','inbound_email','erp_sync','portal','signup','other')),
  external_ref jsonb default '{}'::jsonb,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Case-insensitive uniqueness per customer. Two contacts at the
-- same customer with the same email is a dup; the matcher upserts
-- onto this index.
create unique index if not exists customer_contacts_email_uniq
  on customer_contacts (tenant_id, customer_id, lower(email))
  where email is not null;

-- Look up a contact by raw email globally for the inbound matcher
-- (it doesn't know the customer up front).
create index if not exists customer_contacts_email_idx
  on customer_contacts (tenant_id, lower(email))
  where email is not null;

create index if not exists customer_contacts_customer_idx
  on customer_contacts (tenant_id, customer_id);

create index if not exists customer_contacts_primary_idx
  on customer_contacts (tenant_id, customer_id)
  where is_primary = true;

alter table customer_contacts enable row level security;
drop policy if exists "customer_contacts_owner" on customer_contacts;
create policy "customer_contacts_owner" on customer_contacts
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- Audit P4.4: link the inbound_emails row to a specific contact
-- when the matcher resolves one. The caller still also writes
-- customer_id on the email row (denormalised for the inbox UI's
-- existing queries), but customer_contact_id lets dunning agents
-- thread-aware reply.
alter table inbound_emails
  add column if not exists customer_contact_id uuid references customer_contacts(id) on delete set null;

create index if not exists inbound_emails_contact_idx
  on inbound_emails (tenant_id, customer_contact_id)
  where customer_contact_id is not null;

-- P4.3 backfill: seed customer_contacts from any customer that
-- has a contact_email. is_primary=true so the matcher's "fall
-- back to primary" behaviour matches what the legacy
-- contact_email field used to do.
insert into customer_contacts (tenant_id, customer_id, name, email, phone, role, is_primary, source)
select c.tenant_id,
       c.id,
       c.customer_name,
       lower(c.contact_email),
       c.contact_phone,
       'primary',
       true,
       'erp_sync'
from customers c
where c.contact_email is not null
  and not exists (
    select 1 from customer_contacts cc
    where cc.tenant_id = c.tenant_id
      and cc.customer_id = c.id
      and lower(cc.email) = lower(c.contact_email)
  );
