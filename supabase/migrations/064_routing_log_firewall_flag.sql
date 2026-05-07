-- 064_routing_log_firewall_flag.sql
--
-- Audit P3.6 (May 2026). The /api/claude/messages wrapper accepts a
-- bypassFirewall flag (admin-only post-PR-22) but the
-- model_routing_log table did not capture whether a particular
-- call had the firewall on or off. Security reviews wanting to
-- answer "what fraction of last-month's Anthropic traffic
-- bypassed the firewall, and on which objects?" had to join
-- audit_events against the routing log on timestamp + user with
-- no direct foreign key.
--
-- Adds two booleans:
--   firewall_bypassed: true when the caller passed
--                      bypassFirewall=true (admin-gated already).
--   tools_used:        true when the caller supplied a `tools`
--                      array. Lets the cost dashboard split tool-
--                      use traffic from extraction traffic.
--
-- Both default false so existing rows read sanely.

alter table model_routing_log
  add column if not exists firewall_bypassed boolean not null default false,
  add column if not exists tools_used boolean not null default false,
  add column if not exists has_cache_breakpoint boolean not null default false;

create index if not exists model_routing_log_bypass_idx
  on model_routing_log (tenant_id, created_at desc)
  where firewall_bypassed = true;
