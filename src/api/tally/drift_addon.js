// /api/tally/drift_addon
//
// Bet 5: enable / disable the Tally drift reconciliation paid SKU
// for the current tenant. Idempotent. Audit-logged.
//
//   POST { plan: 'starter' | 'growth' | 'enterprise' | 'trial' }
//     -> flips tally_drift_addon_enabled = true on tenant_settings,
//        stamps started_at if first time, records billing_plan.
//        Triggers a synchronous 30-day initial drift scan
//        (best-effort; failure does not roll back the flag flip).
//
//   DELETE
//     -> flips tally_drift_addon_enabled = false. Does NOT clear
//        started_at; the historical record stays.
//
// Permission: admin only.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit, recordEvent } from "../_lib/audit.js";
import { driftCheck } from "../_lib/tally-reconciler.js";

const ALLOWED_PLANS = new Set(["starter", "growth", "enterprise", "trial"]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    const svc = serviceClient();

    if (req.method === "POST") {
      const body = await readBody(req);
      const plan = body?.plan || "trial";
      if (!ALLOWED_PLANS.has(plan)) {
        return json(res, 400, { error: { message: "plan must be one of: " + Array.from(ALLOWED_PLANS).join(", ") } });
      }

      // Read current state so we can preserve started_at when the
      // operator toggles off-then-on.
      const cur = await svc.from("tenant_settings")
        .select("tally_drift_addon_enabled, tally_drift_addon_started_at")
        .eq("tenant_id", ctx.tenantId)
        .maybeSingle();
      const startedAt = cur?.data?.tally_drift_addon_started_at || new Date().toISOString();
      const wasEnabled = !!cur?.data?.tally_drift_addon_enabled;

      const upd = await svc.from("tenant_settings")
        .update({
          tally_drift_addon_enabled: true,
          tally_drift_addon_started_at: startedAt,
          tally_drift_addon_billing_plan: plan,
        })
        .eq("tenant_id", ctx.tenantId)
        .select("*")
        .maybeSingle();
      if (upd.error) throw new Error(upd.error.message);

      await recordAudit(ctx, {
        action: "drift_addon_enabled",
        objectType: "tenant_settings",
        objectId: ctx.tenantId,
        detail: "plan=" + plan + (wasEnabled ? "::re-enable" : "::first-enable"),
      });
      await recordEvent(ctx, {
        eventType: "drift_addon_enabled",
        objectType: "tenant_settings",
        objectId: ctx.tenantId,
        caseId: null,
        detail: { plan, was_enabled: wasEnabled, started_at: startedAt },
      });

      // First-run experience: trigger a 30-day initial scan synchronously
      // when the operator is enabling for the first time. The result is
      // returned so the UI can render "We found N findings covering Rs X
      // of value." Best-effort: a scan failure does not roll back the
      // enable.
      let firstRun = null;
      let firstRunError = null;
      if (!wasEnabled) {
        try {
          firstRun = await driftCheck(svc, {
            tenantId: ctx.tenantId,
            scope: "tenant_recent",
            trigger: "workspace",
            triggeredBy: ctx.userId || null,
            limit: 200,                              // expanded scope for the first scan
          });
        } catch (err) {
          firstRunError = err?.message || String(err);
        }
      }

      return json(res, 200, {
        ok: true,
        addon_enabled: true,
        addon_started_at: startedAt,
        addon_billing_plan: plan,
        first_run: firstRun,
        first_run_error: firstRunError,
      });
    }

    if (req.method === "DELETE") {
      const upd = await svc.from("tenant_settings")
        .update({ tally_drift_addon_enabled: false })
        .eq("tenant_id", ctx.tenantId)
        .select("*")
        .maybeSingle();
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, {
        action: "drift_addon_disabled",
        objectType: "tenant_settings",
        objectId: ctx.tenantId,
        detail: "operator-initiated",
      });
      return json(res, 200, { ok: true, addon_enabled: false });
    }

    res.setHeader("Allow", "POST, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
