-- 203_opportunity_quotes.sql
--
-- Track externally-created (PDF) quotes against an opportunity as a REVISION
-- TIMELINE: a budgetary/initial quote, then revisions as product qty/type
-- changes, then a price/discount version to close. This is DISTINCT from the
-- generate-a-quote `quotes` table (which builds line items for SO conversion) —
-- here the quote is an UPLOADED PDF the sales engineer sends to the customer's
-- contacts (+ CC group). Feeds the P2 pipeline conversion report
-- (quotes sent -> orders processed -> sales completed).
--
-- Applied manually like the other migrations.

create table if not exists opportunity_quotes (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  opportunity_id uuid not null references opportunities(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,     -- denormalised for reporting/filtering
  version int not null default 1,                                    -- 1,2,3… within an opportunity
  supersedes_id uuid references opportunity_quotes(id) on delete set null,  -- prior revision
  quote_type text not null default 'budgetary'
    check (quote_type in ('budgetary', 'revised', 'final', 'discount')),
  document_id uuid references documents(id) on delete set null,      -- the uploaded PDF
  original_filename text,
  amount numeric(18, 2),                                             -- deal size AT this revision
  amount_currency text not null default 'INR',
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'accepted', 'declined', 'superseded')),
  sent_at timestamptz,
  sent_by uuid references auth.users(id) on delete set null,
  change_note text,                                                  -- why: qty change / price / discount
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, opportunity_id, version)
);
create index if not exists opportunity_quotes_opp_idx on opportunity_quotes (tenant_id, opportunity_id, version);
create index if not exists opportunity_quotes_customer_idx on opportunity_quotes (tenant_id, customer_id, sent_at);
create index if not exists opportunity_quotes_status_idx on opportunity_quotes (tenant_id, status);

alter table opportunity_quotes enable row level security;
drop policy if exists opportunity_quotes_select on opportunity_quotes;
create policy opportunity_quotes_select on opportunity_quotes
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists opportunity_quotes_write on opportunity_quotes;
create policy opportunity_quotes_write on opportunity_quotes
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

comment on table opportunity_quotes is
  'Uploaded external quote revisions per opportunity (budgetary -> revised -> discount/final). Distinct from the generate-a-quote quotes table. See src/api/opportunities/quotes.js.';

-- Recipients: who each revision was sent to (primary + CC), reusing the
-- customer contact book. email/name are snapshotted at send time so the record
-- survives a later contact edit/delete.
create table if not exists opportunity_quote_recipients (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  opportunity_quote_id uuid not null references opportunity_quotes(id) on delete cascade,
  contact_id uuid references customer_contacts(id) on delete set null,
  kind text not null default 'to' check (kind in ('to', 'cc')),
  email text,
  name text,
  created_at timestamptz not null default now()
);
create index if not exists opportunity_quote_recipients_quote_idx
  on opportunity_quote_recipients (tenant_id, opportunity_quote_id);

alter table opportunity_quote_recipients enable row level security;
drop policy if exists oqr_select on opportunity_quote_recipients;
create policy oqr_select on opportunity_quote_recipients
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists oqr_write on opportunity_quote_recipients;
create policy oqr_write on opportunity_quote_recipients
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));
