// GET /api/marketplace/list
//   ?status=approved|pending_review|all
//   ?kind=po|...
//
// Browse the global library. Consumer-facing surface to discover
// templates. Sensitive fields (publisher_tenant_id, replay_verification,
// regex_safety_report, redaction_report) are stripped from the
// response when the caller is not the publisher.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

const SAFE_FIELDS = [
  "id", "kind", "fingerprint", "publisher_display", "anonymise_publisher",
  "status", "k_anonymity", "hit_count", "miss_count", "upvotes", "downvotes",
  "created_at", "updated_at",
];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") {
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const url = new URL(req.url, "http://_");
    const status = url.searchParams.get("status") || "approved";
    const kind = url.searchParams.get("kind") || "po";
    const svc = serviceClient();
    let q = svc.from("customer_format_templates_global")
      .select(SAFE_FIELDS.join(","))
      .eq("kind", kind)
      .order("hit_count", { ascending: false })
      .limit(200);
    if (status !== "all") q = q.eq("status", status);
    const r = await q;
    if (r.error) throw new Error(r.error.message);
    return json(res, 200, { templates: r.data || [] });
  } catch (err) { sendError(res, err); }
}
