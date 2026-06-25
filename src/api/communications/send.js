// POST /api/communications/send
// Body: { id }   (id of an existing draft)
//
// Marks the draft sent via the shared send core (_lib/comms-send.js),
// which both this endpoint and the copilot confirm-and-execute path use.
// Provider order: tenant chat config (whatsapp/slack/teams) -> SendGrid
// -> generic webhook -> manual (dev). The matching outbound for WhatsApp
// lives at /api/whatsapp/send.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { sendCommunication } from "../_lib/comms-send.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const body = await readBody(req);
    if (!body || !body.id) return json(res, 400, { error: { message: "id required" } });
    const svc = serviceClient();
    const result = await sendCommunication(svc, ctx, body.id);
    if (result.notFound) return json(res, 404, { error: { message: "Draft not found" } });
    if (result.idempotent) return json(res, 200, { ok: true, idempotent: true });
    return json(res, 200, {
      communication: result.communication,
      provider: result.provider || "manual",
      configured: result.configured,
      error: result.error,
    });
  } catch (err) {
    sendError(res, err);
  }
}
