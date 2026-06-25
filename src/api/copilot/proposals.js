// GET /api/copilot/proposals
//
// Lists the tenant's pending (proposed, unexpired) copilot action
// proposals so the UI can show a Confirm/Cancel queue. Read-only.
// Each row carries its preview + confirm_token for the confirm call.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const nowIso = new Date().toISOString();
    const { data, error } = await svc.from("action_proposals")
      .select("id, action, preview, confirm_token, created_by, expires_at, created_at")
      .eq("tenant_id", ctx.tenantId)
      .eq("status", "proposed")
      .gt("expires_at", nowIso)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return json(res, 200, { proposals: data || [] });
  } catch (err) { sendError(res, err); }
}
