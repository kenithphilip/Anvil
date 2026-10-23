// /api/email/policy: the tenant's reminder, escalation and calendar policy.
// docs/EMAIL_ACCOUNTABILITY_SCOPE.md 6.7.
//
//   GET  { stored, effective, defaults }. Any writer may read it.
//   PUT  { policy }: the overlay on the defaults (policy.js). email.rules
//        (admin). An empty object goes back to the defaults. Audited.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission, requireAction } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings, updateTenantSettings } from "../_lib/stripe-client.js";
import { DEFAULT_EMAIL_POLICY, tenantPolicy, policyErrors } from "../_lib/email-accountability/policy.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const svc = serviceClient();
    const s = await tenantSettings(svc, ctx.tenantId);

    if (req.method === "GET") {
      const stored = s?.email_policy || {};
      return json(res, 200, { ok: true, stored, effective: tenantPolicy(stored), defaults: DEFAULT_EMAIL_POLICY });
    }
    if (req.method === "PUT") {
      requireAction(ctx, "email.rules");
      const body = (await readBody(req)) || {};
      const policy = body.policy;
      const errors = policyErrors(policy);
      if (errors.length) return json(res, 400, { error: { message: "the policy has errors", errors } });
      await updateTenantSettings(svc, ctx.tenantId, { email_policy: policy });
      await recordAudit(ctx, {
        action: "email_policy_changed", objectType: "tenant_settings", objectId: ctx.tenantId,
        before: s?.email_policy || {}, after: policy,
      });
      return json(res, 200, { ok: true, stored: policy, effective: tenantPolicy(policy) });
    }
    return json(res, 405, { error: { message: "method not allowed" } });
  } catch (err) {
    return sendError(res, err);
  }
}
