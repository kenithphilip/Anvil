// POST /api/operator_actions/evidence
// Body: { id, step_id?, document_id?, kind?, ocr_text? }
//
// Attaches a captured artifact to an operator action. The artifact bytes
// live in the existing documents bucket (client uploads via
// /api/documents/upload and passes document_id); OCR text, when wanted,
// is produced via /api/documents/ocr and passed as ocr_text. This only
// stores the link. Flag-gated. See docs/OPERATOR_ACTIONS_DESIGN.md.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings } from "../_lib/stripe-client.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const svc = serviceClient();
    const settings = await tenantSettings(svc, ctx.tenantId);
    if (!settings?.operator_actions_enabled) return json(res, 409, { error: { code: "FEATURE_DISABLED", message: "Operator actions are disabled for this tenant" } });

    const body = await readBody(req);
    if (!body?.id) return json(res, 400, { error: { message: "id (operator_action_id) required" } });
    if (!body.document_id && !body.ocr_text && body.kind !== "note") {
      return json(res, 400, { error: { message: "document_id, ocr_text, or kind=note required" } });
    }

    const aQ = await svc.from("operator_actions").select("id").eq("tenant_id", ctx.tenantId).eq("id", body.id).maybeSingle();
    if (aQ.error) throw new Error(aQ.error.message);
    if (!aQ.data) return json(res, 404, { error: { message: "Operator action not found" } });

    const ins = await svc.from("operator_action_evidence").insert({
      tenant_id: ctx.tenantId,
      operator_action_id: body.id,
      step_id: body.step_id || null,
      document_id: body.document_id || null,
      kind: body.kind || (body.document_id ? "screenshot" : "note"),
      ocr_text: body.ocr_text || null,
      captured_by: ctx.user?.id || null,
    }).select("*").single();
    if (ins.error) throw new Error(ins.error.message);

    await recordAudit(ctx, { action: "operator_action_evidence", objectType: "operator_action", objectId: body.id, detail: ins.data.kind });
    return json(res, 201, { evidence: ins.data });
  } catch (err) { sendError(res, err); }
}
