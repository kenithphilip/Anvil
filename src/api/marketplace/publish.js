// POST /api/marketplace/publish
//   { template_id, anonymise?, publisher_display?, fingerprint? }
//
// Operator-initiated publication of a customer_format_templates row
// into the global library. The publishTemplate helper enforces every
// safeguard: triple-gate opt-in (tenant + customer + explicit
// publish), k-anonymity, regex safety, PII redaction, miss-rate
// sanity, replay verification, rate limit, reputation gate.
//
// RBAC: admin only. Publishing is a one-way data-leave event;
// only the tenant-admin can authorise it.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { publishTemplate } from "../_lib/docai/marketplace.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    const body = await readBody(req);
    if (!body.template_id) {
      return json(res, 400, { error: { message: "template_id required" } });
    }
    const svc = serviceClient();
    const r = await publishTemplate(svc, ctx, {
      template_id: body.template_id,
      anonymise: body.anonymise !== false,
      publisher_display: body.publisher_display || null,
      fingerprint: body.fingerprint || {},
    });
    if (!r.ok) {
      await recordAudit(ctx, {
        action: "marketplace.publish.blocked",
        objectType: "customer_format_template",
        objectId: body.template_id,
        detail: {
          blocked_by: r.blocked_by,
          reasons: r.reasons,
          redaction_report: r.redaction_report,
          replay: r.replay,
        },
      });
      return json(res, 409, { error: { message: "publish_blocked", ...r } });
    }
    await recordAudit(ctx, {
      action: "marketplace.publish.submitted",
      objectType: "customer_format_templates_global",
      objectId: r.global_id,
      detail: {
        template_id: body.template_id,
        status: r.status,
        approval_kind: r.approval_kind,
        k_anonymity: r.report?.k_anonymity,
      },
    });
    return json(res, 200, r);
  } catch (err) { sendError(res, err); }
}
