-- 251_order_handoff.sql
--
-- The order-processing handoff: who receives it, and what happened to it.
-- Design: docs/SO_TERMS_AND_HANDOFF_SCOPE.md, sections 8.1 and 9.3.
--
-- tenant_settings (edited on Admin > Sales & quotes > Order handoff):
--   order_handoff_enabled   default false. The send button stays hidden until
--                           an admin turns it on.
--   order_handoff_to        the order processing team. Each entry is an email
--                           address or a role token such as 'role:operator',
--                           which expands to the tenant's approved members
--                           with that role (src/api/_lib/internal-recipients.js).
--   order_handoff_cc        CC. Same format.
--   order_handoff_sender    'graph' (the tenant's shared Outlook mailbox) or
--                           'mailer' (Brevo, Resend or SendGrid). NULL means
--                           not chosen yet.
--   order_handoff_template  subject format, prices, attachments (decision 5).
--                           NULL until that decision is taken.
--
-- orders (written only by the handoff endpoint, plan PR 16):
--   handoff_status          'sent', 'failed' or 'not_configured'. NULL means
--                           the order was not handed off.
--   handoff_sent_at, handoff_sent_by, handoff_comm_id, handoff_payload,
--   dispatch_plan           the shipment mode per origin group.
-- These are dedicated columns, not keys in orders.result, so writing them
-- does not reset an approval.
--
-- RLS. No new table. tenant_settings (013) and orders (001) keep the
-- tenant-scoped policies they already have, and the new columns inherit them.
--
-- Additive and idempotent: add column if not exists, and each check
-- constraint is dropped by name before it is added. Every new column is NULL
-- or false for every existing row, so applying this changes no behaviour
-- until an admin saves a value.
--
-- Apply by hand. Merged is not applied.
--
-- VERIFY (expect 11 rows, then 2 rows):
--
--   select table_name, column_name, data_type
--   from information_schema.columns
--   where table_schema = 'public'
--     and ((table_name = 'tenant_settings' and column_name in
--            ('order_handoff_enabled', 'order_handoff_to', 'order_handoff_cc',
--             'order_handoff_sender', 'order_handoff_template'))
--       or (table_name = 'orders' and column_name in
--            ('handoff_status', 'handoff_sent_at', 'handoff_sent_by',
--             'handoff_comm_id', 'handoff_payload', 'dispatch_plan')))
--   order by table_name, column_name;
--
--   select conname from pg_constraint
--   where conname in ('tenant_settings_order_handoff_sender_check',
--                     'orders_handoff_status_check');

-- tenant_settings: the recipients.

alter table tenant_settings
  add column if not exists order_handoff_enabled boolean default false,
  add column if not exists order_handoff_to text[],
  add column if not exists order_handoff_cc text[],
  add column if not exists order_handoff_sender text,
  add column if not exists order_handoff_template jsonb;

alter table tenant_settings drop constraint if exists tenant_settings_order_handoff_sender_check;
alter table tenant_settings
  add constraint tenant_settings_order_handoff_sender_check
  check (order_handoff_sender in ('graph', 'mailer'));

comment on column tenant_settings.order_handoff_enabled is
  'Order-processing handoff email on or off. Default false: the send button is hidden until an admin turns it on.';
comment on column tenant_settings.order_handoff_to is
  'Handoff To list. Each entry is an email address or a role token (role:<role>) that expands to approved members with that role. See src/api/_lib/internal-recipients.js.';
comment on column tenant_settings.order_handoff_cc is
  'Handoff CC list. Same format as order_handoff_to.';
comment on column tenant_settings.order_handoff_sender is
  'graph = the shared Outlook mailbox; mailer = Brevo, Resend or SendGrid. NULL = not chosen.';
comment on column tenant_settings.order_handoff_template is
  'Handoff email template: subject format, prices, attachments. NULL until decision 5 of docs/SO_TERMS_AND_HANDOFF_SCOPE.md.';

-- orders: what happened to the handoff.

alter table orders
  add column if not exists handoff_status text,
  add column if not exists handoff_sent_at timestamptz,
  add column if not exists handoff_sent_by uuid,
  add column if not exists handoff_comm_id uuid references communications(id) on delete set null,
  add column if not exists handoff_payload jsonb,
  add column if not exists dispatch_plan jsonb;

alter table orders drop constraint if exists orders_handoff_status_check;
alter table orders
  add constraint orders_handoff_status_check
  check (handoff_status in ('sent', 'failed', 'not_configured'));

comment on column orders.handoff_status is
  'Order-processing handoff result: sent, failed or not_configured (no mail provider). NULL = not handed off.';
comment on column orders.handoff_payload is
  'What the handoff sent: date, contact, origin groups, a lines hash and the terms summary.';
comment on column orders.dispatch_plan is
  'Shipment mode per origin group: [{ group, country, mode, line_nos }]. orders.dispatch_mode is written only when there is one group.';
