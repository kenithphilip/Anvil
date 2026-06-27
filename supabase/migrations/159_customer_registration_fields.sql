-- 159_customer_registration_fields.sql
--
-- Categorized customer-registration data-point capture (design:
-- docs/CUSTOMER_REGISTRATION_DESIGN.md). One row per registration field,
-- grouped by category, with provenance (source) + verification metadata so the
-- later automation (GSTIN fetch #186, document OCR cross-check #187) can
-- populate/verify fields individually. The canonical customer master stays in
-- `customers`; this is the capture/tracking layer whose approved values sync
-- into master columns later. Catalog of valid field_keys lives in
-- src/api/_lib/customer-registration.js.

create table if not exists customer_registration_fields (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  category text not null,
  field_key text not null,
  value text,
  source text not null default 'manual',      -- manual | gst | doc | internal
  verified boolean not null default false,
  verified_against text,                       -- e.g. gst_certificate | cancelled_cheque | po | invoice
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, customer_id, field_key)
);

create index if not exists customer_registration_fields_idx
  on customer_registration_fields (tenant_id, customer_id);

alter table customer_registration_fields enable row level security;
drop policy if exists "customer_registration_fields_all" on customer_registration_fields;
create policy "customer_registration_fields_all" on customer_registration_fields
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
