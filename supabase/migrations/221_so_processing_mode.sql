-- 221_so_processing_mode.sql
--
-- MODE A / MODE B: who processes the sales order.
--
--   A  Anvil processes it and pushes the voucher to the ERP. Anvil is the
--      system of action.
--   B  A person processes it by hand in the ERP. Anvil computes what it WOULD
--      have done, records that, pushes NOTHING, and compares the two.
--
-- Mode B is the on-ramp, and it is safe by construction: the customer's ledger
-- is untouched, their process is unchanged, and after a month they have a
-- scored comparison over their OWN orders instead of a vendor accuracy claim.
--
-- DEFAULT 'A', deliberately. Every tenant today is implicitly in A — Anvil
-- pushes — so defaulting to B would silently stop the pushes of anyone who has
-- this applied before they have chosen anything. A migration must not change
-- behaviour for a tenant who has not asked it to.
--
-- Note this is the opposite polarity from the reasoning in 218: there, an
-- experiment had to be opted INTO; here, the existing behaviour has to be
-- preserved. Both come from the same rule — a column arriving must not change
-- what the system already does.
--
-- Additive and idempotent.

alter table tenant_settings
  add column if not exists so_processing_mode text not null default 'A';

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'tenant_settings'::regclass
      and conname = 'tenant_settings_so_processing_mode_check'
  ) then
    alter table tenant_settings drop constraint tenant_settings_so_processing_mode_check;
  end if;
end $$;

alter table tenant_settings
  add constraint tenant_settings_so_processing_mode_check
  check (so_processing_mode in ('A', 'B'));

comment on column tenant_settings.so_processing_mode is
  'A = Anvil processes sales orders and pushes to the ERP (system of action). B = a person processes them by hand in the ERP; Anvil records its own proposal, pushes NOTHING, and compares. Default A preserves existing behaviour.';
