// POST /api/push/unsubscribe Body: { endpoint?, id? }

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    if (!ctx.userId) return json(res, 401, { error: { message: "must be signed in" } });
    const body = await readBody(req);
    const svc = serviceClient();
    const q = svc.from("push_subscriptions")
      .update({ is_active: false })
      .eq("tenant_id", ctx.tenantId)
      .eq("user_id", ctx.userId);
    if (body?.id) q.eq("id", body.id);
    else if (body?.endpoint) q.eq("endpoint", body.endpoint);
    const r = await q;
    if (r.error) throw new Error(r.error.message);
    return json(res, 200, { ok: true });
  } catch (err) { sendError(res, err); }
}
