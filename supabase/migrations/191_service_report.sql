-- Service report — a TEMPLATE-DRIVEN customer-facing report, not a replica of
-- any one seller's form.
--
-- An attached Obara "Service /Visit Report" (OI/F/CS/12) was the reference, but
-- replicating its exact fields as columns would be wrong: Anvil is multi-tenant
-- and a welding-gun service report shares almost nothing with an HVAC or an IT
-- one, and even two customers of the SAME seller may want different sections.
-- So the extra fields are DATA, and their layout + labels + customer-vs-internal
-- visibility come from a per-tenant (optionally per-customer) template.
--
-- What stays as first-class columns is only what is genuinely cross-cutting:
-- the report number, the entitlement basis (chargeable/free/AMC/warranty —
-- which billing + the support/SLA layer key on), and the contact. Everything
-- form-specific (warranty status, serial no, robot make, station, …) lives in
-- report_fields and is described by the template.
--
-- See docs/CUSTOMER_COMMS_DESIGN.md item 4. All additive + nullable.

alter table service_visits
  add column if not exists report_number text,
  -- Entitlement basis. Cross-cutting (billing + support/SLA key on it), so a
  -- column, not a template field. Text not enum — support vocabulary is
  -- tenant-specific (amc/pmc/warranty/goodwill differ by seller).
  add column if not exists support_type text,
  -- Flexible, tenant/customer-specific captured fields. Keys are referenced by
  -- the report template. A new field never needs a migration.
  add column if not exists report_fields jsonb not null default '{}'::jsonb,
  add column if not exists customer_contact_id uuid references customer_contacts(id) on delete set null;

comment on column service_visits.report_fields is
  'Tenant/customer-specific service-report fields as key->value (warranty_status, '
  'serial_no, robot_make, disposition, …). Layout + labels + visibility come '
  'from service_report_templates. Additive: a new field needs no migration.';
comment on column service_visits.support_type is
  'Entitlement basis: chargeable | free | amc | pmc | warranty | goodwill. '
  'Text, not an enum — support vocabulary is tenant-specific.';

-- The Parts & Action summary: universal to a service report, so a real child
-- table rather than a template field.
create table if not exists service_visit_parts (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  visit_id uuid not null references service_visits(id) on delete cascade,
  seq int not null default 0,
  part_name text,
  part_number text,
  action_details text,
  remarks text,
  created_at timestamptz not null default now(),
  unique (tenant_id, visit_id, seq)
);

create index if not exists service_visit_parts_visit_idx
  on service_visit_parts (tenant_id, visit_id, seq);

alter table service_visit_parts enable row level security;
drop policy if exists service_visit_parts_select on service_visit_parts;
create policy service_visit_parts_select on service_visit_parts
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists service_visit_parts_write on service_visit_parts;
create policy service_visit_parts_write on service_visit_parts
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

-- The template: what a service report looks like for a tenant, optionally
-- overridden per customer. `sections` is an ordered jsonb array; each field
-- carries a visibility so the same template drives BOTH what the engineer
-- captures and what the customer is shown (internal fields are never sent).
-- customer_id NULL = the tenant default.
create table if not exists service_report_templates (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid references customers(id) on delete cascade,
  name text not null default 'Default',
  sections jsonb not null default '[]'::jsonb,
  include_parts boolean not null default true,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One template per (tenant, customer); the customer-null row is the default.
  unique (tenant_id, customer_id)
);

create index if not exists service_report_templates_idx
  on service_report_templates (tenant_id, customer_id) where is_active;

alter table service_report_templates enable row level security;
drop policy if exists service_report_templates_select on service_report_templates;
create policy service_report_templates_select on service_report_templates
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists service_report_templates_write on service_report_templates;
create policy service_report_templates_write on service_report_templates
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

comment on table service_report_templates is
  'Per-tenant (optionally per-customer) service-report layout. sections[] is '
  'ordered; each field has { key, label, visibility: customer|internal }. Drives '
  'capture + render, so the report adapts per seller AND per their customers. No '
  'row = a built-in default applies (see _lib/service-report.js DEFAULT_TEMPLATE).';
