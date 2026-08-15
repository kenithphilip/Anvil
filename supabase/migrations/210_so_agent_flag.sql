-- 210_so_agent_flag.sql
-- Ask Anvil module personas — the Sales Order agent (thin slice).
--
-- A floating "Ask Anvil" surface whose persona follows the module the operator
-- is standing in. The first persona is READ-ONLY: it answers questions about
-- the order in front of you and cites the tools it used. It cannot mutate
-- anything, because its scope list contains no write.* scope at all (see
-- src/api/_lib/agent-personas.js) — not because a check happens to reject it.
--
-- OFF BY DEFAULT, per tenant. Follows the same shape as
-- operator_actions_enabled (150) and dispatch_register_auto_send_enabled (205):
-- a boolean on tenant_settings, defaulting false, so enabling it is a
-- deliberate per-client decision rather than something that ships switched on.
-- Strictly additive; no existing behaviour changes when the flag is absent.
--
-- The flag gates BOTH halves: /api/agent/personas omits the persona so the
-- button never renders, and /api/erp_chat/send rejects a forged persona with
-- 403. Neither half trusts the other.

alter table tenant_settings
  add column if not exists so_agent_enabled boolean default false;

comment on column tenant_settings.so_agent_enabled is
  'Ask Anvil Sales Order persona (read-only agent panel on the SO workspace). Default false; enable per client on request.';
