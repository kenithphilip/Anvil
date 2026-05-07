-- 072_credit_debit_notes.sql
--
-- Audit P7.5. The audit flagged that credit notes / debit notes
-- weren't first-class entities. Operators were handling them
-- manually as ad-hoc "negative invoices" or with notes on the
-- original invoice. Real GST workflows need separate documents:
-- the customer's accounting team reconciles credits and debits
-- separately, and the GSTN e-invoice flow has dedicated
-- TRANSACTION types.

do $$ begin
  if not exists (select 1 from pg_type where typname = 'credit_note_kind') then
    create type credit_note_kind as enum ('CREDIT', 'DEBIT');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'credit_note_status') then
    create type credit_note_status as enum (
      'DRAFT', 'ISSUED', 'ACKNOWLEDGED', 'CANCELLED'
    );
  end if;
end $$;

create table if not exists credit_notes (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  invoice_id uuid references invoices(id) on delete set null,
  einvoice_id uuid references einvoices(id) on delete set null,
  customer_id uuid references customers(id) on delete set null,
  kind credit_note_kind not null,                          -- CREDIT or DEBIT
  status credit_note_status not null default 'DRAFT',
  note_number text not null,
  note_date date not null default current_date,
  reason text not null,                                    -- 'price_correction' | 'short_shipment' | 'tax_correction' | 'goods_returned' | 'other'
  reason_text text,                                        -- operator-typed detail
  currency text not null default 'INR',
  subtotal numeric(18, 2),
  tax_total numeric(18, 2),
  grand_total numeric(18, 2),
  line_items jsonb not null default '[]'::jsonb,
  issued_at timestamptz,
  acknowledged_at timestamptz,
  cancelled_at timestamptz,
  payload_hash text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists credit_notes_number_uniq
  on credit_notes (tenant_id, kind, note_number);
create index if not exists credit_notes_invoice_idx
  on credit_notes (tenant_id, invoice_id) where invoice_id is not null;
create index if not exists credit_notes_einvoice_idx
  on credit_notes (tenant_id, einvoice_id) where einvoice_id is not null;
create index if not exists credit_notes_customer_status_idx
  on credit_notes (tenant_id, customer_id, status);

alter table credit_notes enable row level security;
drop policy if exists "credit_notes_owner" on credit_notes;
create policy "credit_notes_owner" on credit_notes
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
