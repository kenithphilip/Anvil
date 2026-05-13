-- 127_customer_external_ids.sql
--
-- Wave CM 1.2: customer_external_ids table.
--
-- One customer can carry multiple foreign identifiers without
-- bloating the customers row. Today the customer master holds
-- one customer_key plus optional ERP refs in scattered
-- connector tables (acu_customers, d365_customers, sxe_customers,
-- etc.). That works for the canonical ERP sync but doesn't
-- generalise: many customer rows also need a SAP business-
-- partner ID, a NetSuite internal ID, the customer's portal
-- vendor code, a buyer-side cost center, and an EDI sender ID.
--
-- customer_external_ids is the unified table:
--
--   (tenant_id, customer_id, system_code, external_id)
--
-- system_code is text (open enum via CHECK) so a new source can
-- be added without a schema migration. The dedupe + linkage
-- engine (CM 4.1, 4.2) joins on this table when matching an
-- inbound document's customer block: a PO whose header reads
-- "SAP Vendor: 100051" can resolve to the right customer when
-- one customer_external_ids row binds 100051 -> customer X.
--
-- Idempotent.

create table if not exists customer_external_ids (
  id            uuid primary key default uuid_generate_v4(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  customer_id   uuid not null references customers(id) on delete cascade,
  -- Open enum. The full set today, extensible by CHECK rewrite:
  --   sap         -- SAP business-partner ID
  --   netsuite    -- NetSuite internal ID
  --   d365        -- Microsoft Dynamics 365 account ID
  --   acumatica   -- Acumatica customer ID
  --   tally       -- Tally ledger group ID
  --   sxe         -- SXE customer code
  --   eclipse     -- Eclipse customer ID
  --   p21         -- Prophet 21 customer number
  --   sage_x3     -- Sage X3 BP code
  --   jde         -- JD Edwards customer master number
  --   ifs         -- IFS customer code
  --   portal      -- inbound supplier portal vendor code
  --   edi         -- EDI sender ID / GLN
  --   internal    -- operator-assigned, no external system
  --   other       -- catch-all
  system_code   text not null,
  external_id   text not null,
  -- Marks the row each customer treats as PRIMARY for that
  -- system. A customer can have multiple SAP codes (different
  -- plants); is_primary picks the one that goes on outbound
  -- documents.
  is_primary    boolean not null default false,
  -- Provenance + audit.
  source        text not null default 'operator' check (source in
    ('operator', 'inbound_email', 'erp_sync', 'portal', 'bulk_import', 'other')),
  notes         text,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint customer_external_ids_system_chk check (system_code in (
    'sap', 'netsuite', 'd365', 'acumatica', 'tally', 'sxe', 'eclipse',
    'p21', 'sage_x3', 'jde', 'ifs', 'portal', 'edi', 'internal', 'other'
  ))
);

-- Lookup: "which customer is SAP vendor 100051 for this tenant?"
-- Hot path for inbound matching. Case-insensitive on external_id
-- because operators sometimes type ABC and the document carries
-- abc.
create unique index if not exists customer_external_ids_lookup_uq
  on customer_external_ids (tenant_id, system_code, lower(external_id));

-- "Show me every external ID for this customer", used by the
-- customer detail drawer.
create index if not exists customer_external_ids_by_customer
  on customer_external_ids (tenant_id, customer_id, system_code);

-- "What's the primary SAP code for this customer?" The drawer
-- shows the primary row first.
create index if not exists customer_external_ids_primary
  on customer_external_ids (tenant_id, customer_id, system_code)
  where is_primary = true;

alter table customer_external_ids enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'customer_external_ids'
      and policyname = 'customer_external_ids_tenant_rw'
  ) then
    create policy customer_external_ids_tenant_rw
      on customer_external_ids for all
      to authenticated
      using (tenant_id in (select current_tenant_ids()))
      with check (tenant_id in (select current_tenant_ids()));
  end if;
end $$;

comment on table customer_external_ids is
  'CM 1.2: per-customer foreign identifiers across ERP, portal, EDI, and operator-assigned codes. The dedupe + linkage engine joins on this table for inbound documents.';

-- Updated_at trigger.
drop trigger if exists customer_external_ids_set_updated_at on customer_external_ids;
create trigger customer_external_ids_set_updated_at
  before update on customer_external_ids
  for each row execute function set_updated_at();
