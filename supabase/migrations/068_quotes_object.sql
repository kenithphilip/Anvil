-- 068_quotes_object.sql
--
-- Audit P6.1 (May 2026). The "quote" in quote-to-cash was not a
-- first-class object. Quote-shaped data was jammed into the
-- orders table via the quote_number field; the agent
-- quote_accept handler had dead branches referencing
-- QUOTE_DRAFT / QUOTE_SENT enum values that never existed; the
-- portal/accept_quote endpoint moved orders directly to APPROVED
-- without ever passing through a quote lifecycle. The largest
-- single structural gap from the audit.
--
-- This migration introduces:
--
--   quote_status              enum DRAFT | PENDING_INTERNAL_APPROVAL |
--                             SENT | ACCEPTED | DECLINED | EXPIRED |
--                             CONVERTED | CANCELLED
--   quotes                    one row per quote (every version
--                             gets its own row; revisions chain
--                             via prior_version_id)
--   orders.quote_id           FK back from a converted quote's
--                             order to the source quote.
--
-- The lifecycle:
--
--   DRAFT -> SENT -> ACCEPTED -> CONVERTED   happy path
--                 -> DECLINED                  customer says no
--                 -> EXPIRED                   validity_days lapsed
--   any   -> CANCELLED                          operator-side abort
--
-- Revisions: the operator clones a SENT/DECLINED quote, the
-- clone lands in DRAFT with prior_version_id set to the source.
-- Both rows stay in the table so the audit trail is complete.

do $$ begin
  if not exists (select 1 from pg_type where typname = 'quote_status') then
    create type quote_status as enum (
      'DRAFT', 'PENDING_INTERNAL_APPROVAL', 'SENT', 'ACCEPTED',
      'DECLINED', 'EXPIRED', 'CONVERTED', 'CANCELLED'
    );
  end if;
end $$;

create table if not exists quotes (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  customer_contact_id uuid references customer_contacts(id) on delete set null,
  opportunity_id uuid references opportunities(id) on delete set null,
  quote_number text not null,
  version int not null default 1,
  prior_version_id uuid references quotes(id) on delete set null,
  status quote_status not null default 'DRAFT',
  currency text not null default 'INR',
  subtotal numeric(18, 2),
  tax_total numeric(18, 2),
  grand_total numeric(18, 2),
  validity_days int not null default 30,
  expires_at timestamptz,
  sent_at timestamptz,
  sent_via text,                                  -- 'email' | 'portal' | 'whatsapp' | 'manual'
  accepted_at timestamptz,
  accepted_by_email text,
  accepted_signature_name text,
  declined_at timestamptz,
  declined_reason text,
  converted_at timestamptz,
  converted_order_id uuid references orders(id) on delete set null,
  cancelled_at timestamptz,
  terms text,
  notes text,
  line_items jsonb not null default '[]'::jsonb,  -- [{partNumber, description, quantity, unitPrice, hsn, uom, ...}]
  payload_hash text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Quote number is unique per tenant per version. Revisions of
-- the same quote share quote_number but differ in version.
create unique index if not exists quotes_number_version_uniq
  on quotes (tenant_id, quote_number, version);

create index if not exists quotes_customer_idx
  on quotes (tenant_id, customer_id, status);

create index if not exists quotes_status_idx
  on quotes (tenant_id, status, expires_at);

create index if not exists quotes_open_expires_idx
  on quotes (tenant_id, expires_at)
  where status in ('SENT', 'PENDING_INTERNAL_APPROVAL');

alter table quotes enable row level security;
drop policy if exists "quotes_owner" on quotes;
create policy "quotes_owner" on quotes
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- Orders learn about their source quote (if any). NULL when the
-- order came from a direct PO upload or a voice/whatsapp inbound
-- flow.
alter table orders
  add column if not exists quote_id uuid references quotes(id) on delete set null;

create index if not exists orders_quote_id_idx on orders (tenant_id, quote_id) where quote_id is not null;

-- Portal token scopes update: existing portal_tokens.scopes
-- already supports 'accept_quote' from migration 022. No change
-- needed.
