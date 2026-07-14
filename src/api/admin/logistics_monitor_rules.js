// /api/admin/logistics_monitor_rules
//
//   GET   -> the tenant's monitor rules merged over the built-in defaults, plus
//            the rule-kind catalog (kinds a rule can target) and the enabled flag.
//   POST  -> upsert one rule { rule_kind, label?, active?, severity?,
//            threshold_days?, sla_hours?, params?, escalate_roles? }, or
//            { logistics_monitor_enabled: bool } to flip the feature flag.
//
// The rule set replaces hardcoded thresholds: the logistics monitor
// (src/api/_lib/logistics/monitor.js) reads these to drive detection + SLA
// clocks + escalation recipients. Design: docs/LOGISTICS_OPS_DESIGN.md.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { DEFAULT_MONITOR_RULES, mergeRules } from "../_lib/logistics/monitor.js";

const SEVERITIES = ["info", "warn", "bad", "critical"];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const rulesRes = await svc.from("logistics_monitor_rules").select("*").eq("tenant_id", ctx.tenantId);
      if (rulesRes.error) throw new Error(rulesRes.error.message);
      const merged = mergeRules(rulesRes.data || []);
      const settings = await svc.from("tenant_settings")
        .select("logistics_monitor_enabled").eq("tenant_id", ctx.tenantId).maybeSingle();
      return json(res, 200, {
        rules: Object.values(merged),
        rule_kinds: DEFAULT_MONITOR_RULES.map((r) => ({ rule_kind: r.rule_kind, label: r.label })),
        is_default: (rulesRes.data || []).length === 0,
        logistics_monitor_enabled: !!settings.data?.logistics_monitor_enabled,
      });
    }

    if (req.method === "POST") {
      // Defining monitor rules / flipping the feature flag is admin config.
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body || typeof body !== "object") return json(res, 400, { error: { message: "body required" } });

      // Feature-flag toggle.
      if (typeof body.logistics_monitor_enabled === "boolean") {
        const up = await svc.from("tenant_settings")
          .upsert({ tenant_id: ctx.tenantId, logistics_monitor_enabled: body.logistics_monitor_enabled }, { onConflict: "tenant_id" })
          .select("logistics_monitor_enabled").maybeSingle();
        if (up.error) throw new Error(up.error.message);
        await recordAudit(ctx, { action: "logistics_monitor_toggle", objectType: "tenant_settings", objectId: null, after: { enabled: body.logistics_monitor_enabled } });
        return json(res, 200, { logistics_monitor_enabled: !!up.data?.logistics_monitor_enabled });
      }

      // Rule upsert (unique on tenant_id + rule_kind).
      if (!body.rule_kind || typeof body.rule_kind !== "string") {
        return json(res, 400, { error: { message: "rule_kind required" } });
      }
      const severity = SEVERITIES.includes(body.severity) ? body.severity : "warn";
      const row = {
        tenant_id: ctx.tenantId,
        rule_kind: body.rule_kind,
        label: body.label || null,
        active: body.active !== false,
        severity,
        threshold_days: body.threshold_days != null && body.threshold_days !== "" ? Number(body.threshold_days) : null,
        sla_hours: body.sla_hours != null && body.sla_hours !== "" ? Number(body.sla_hours) : null,
        params: body.params && typeof body.params === "object" ? body.params : {},
        escalate_roles: Array.isArray(body.escalate_roles) && body.escalate_roles.length ? body.escalate_roles : ["procurement", "admin"],
        updated_at: new Date().toISOString(),
      };
      const saved = await svc.from("logistics_monitor_rules")
        .upsert({ ...row, created_by: ctx.user?.id || null }, { onConflict: "tenant_id,rule_kind" })
        .select("*").maybeSingle();
      if (saved.error) throw new Error(saved.error.message);
      await recordAudit(ctx, { action: "logistics_monitor_rule_upsert", objectType: "logistics_monitor_rule", objectId: saved.data?.id, after: { rule_kind: row.rule_kind, active: row.active, severity } });
      return json(res, 200, { rule: saved.data });
    }

    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
