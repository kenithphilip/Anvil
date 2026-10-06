-- 205_dispatch_register_auto_send_flag.sql
--
-- P3 auto-send: per-tenant opt-in for auto-drafting + sending the customer
-- DISPATCH REGISTER when a despatch is recorded (POST /api/comms/dispatch_lines).
-- OFF by default — byte-identical behaviour for every tenant until one opts in.
-- The send itself routes through the switchable mailer / Outlook-Graph via
-- comms-send.js sendCommunication (cc/bcc + attachments preserved).
--
-- Additive + idempotent. Applied MANUALLY like the rest (live DB lags the repo).

alter table tenant_settings
  add column if not exists dispatch_register_auto_send_enabled boolean not null default false;

comment on column tenant_settings.dispatch_register_auto_send_enabled is
  'Opt-in (default false): auto-draft + send the customer dispatch register when a despatch is recorded (comms/dispatch_lines). Sends once per order via the switchable mailer. See src/api/_lib/dispatch-register-send.js.';
