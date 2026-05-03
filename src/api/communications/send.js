// POST /api/communications/send
// Body: { id }   (id of an existing draft)
// Marks the draft sent. If COMMS_PROVIDER_URL is configured, posts the email
// for delivery; otherwise records as 'sent' (manual delivery).

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit, recordEvent } from "../_lib/audit.js";

const PROVIDER_URL = process.env.COMMS_PROVIDER_URL;
const PROVIDER_TOKEN = process.env.COMMS_PROVIDER_TOKEN;

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
    const row = await svc.from("communications").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.id).single();
    if (row.error || !row.data) return json(res, 404, { error: { message: "Draft not found" } });
    if (row.data.status === "sent") return json(res, 200, { ok: true, idempotent: true });
    let providerStatus = null;
    let errorMsg = null;
    if (PROVIDER_URL) {
      try {
        const headers = { "Content-Type": "application/json" };
        if (PROVIDER_TOKEN) headers["Authorization"] = "Bearer " + PROVIDER_TOKEN;
        const upstream = await fetch(PROVIDER_URL, { method: "POST", headers, body: JSON.stringify({ to: row.data.to_addr, subject: row.data.subject, body: row.data.body, from: row.data.from_addr }) });
        providerStatus = upstream.status;
        if (!upstream.ok) errorMsg = "Provider returned " + upstream.status;
      } catch (err) { errorMsg = err.message; }
    }
    const updated = await svc.from("communications").update({
      status: errorMsg ? "failed" : "sent",
      sent_at: new Date().toISOString(),
      metadata: { ...(row.data.metadata || {}), provider_status: providerStatus, provider_error: errorMsg },
    }).eq("id", body.id).select("*").single();
    if (updated.error) throw new Error(updated.error.message);
    await recordAudit(ctx, { action: "comm_send", objectType: "communication", objectId: body.id, detail: errorMsg ? "failed" : "sent" });
    if (row.data.order_id) await recordEvent(ctx, { caseId: row.data.order_id, eventType: errorMsg ? "comm_send_failed" : "comm_sent", objectType: "communication", objectId: body.id });
    return json(res, 200, { communication: updated.data, error: errorMsg });
  } catch (err) {
    sendError(res, err);
  }
}
