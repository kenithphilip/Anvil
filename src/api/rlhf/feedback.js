// /api/rlhf/feedback
//
// POST: { surface, case_id?, prompt, output, rating, comment?, corrected_output?, model? }
//   submit a single feedback row. Available to anyone with read perm.
// GET ?surface=&from=&to=&rating=&limit=
//   list feedback rows (read perm).
// GET ?surface=&day=YYYY-MM-DD
//   reads pre-aggregated reward_daily for one day if available.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const SURFACES = ["agent", "intake", "anomaly", "bom", "quote_qa", "custom"];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    if (req.method === "POST") {
      requirePermission(ctx, "read");
      const body = await readBody(req);
      if (!body?.surface || !SURFACES.includes(body.surface)) {
        return json(res, 400, { error: { message: "valid surface required" } });
      }
      if (![-1, 0, 1].includes(Number(body.rating))) {
        return json(res, 400, { error: { message: "rating must be -1, 0, or 1" } });
      }
      const ins = await svc.from("rlhf_feedback").insert({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId || null,
        surface: body.surface,
        case_id: body.case_id || null,
        prompt: body.prompt || null,
        output: body.output || null,
        rating: Number(body.rating),
        comment: body.comment || null,
        corrected_output: body.corrected_output || null,
        model: body.model || null,
      }).select("id, created_at").single();
      if (ins.error) throw new Error(ins.error.message);
      await recordAudit(ctx, {
        action: "rlhf_feedback_submitted",
        objectType: "rlhf_feedback",
        objectId: ins.data.id,
        detail: body.surface + "::" + body.rating,
      });
      return json(res, 200, { ok: true, id: ins.data.id });
    }
    if (req.method !== "GET") return json(res, 405, { error: { message: "Method not allowed" } });
    requirePermission(ctx, "read");
    const url = new URL(req.url, "http://x");
    const surface = url.searchParams.get("surface");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const ratingParam = url.searchParams.get("rating");
    const limit = Math.min(500, Number(url.searchParams.get("limit") || 100));
    let q = svc.from("rlhf_feedback")
      .select("id, surface, case_id, rating, comment, model, user_id, created_at")
      .eq("tenant_id", ctx.tenantId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (surface) q = q.eq("surface", surface);
    if (ratingParam) q = q.eq("rating", Number(ratingParam));
    if (from) q = q.gte("created_at", from);
    if (to) q = q.lte("created_at", to);
    const r = await q;
    if (r.error) throw new Error(r.error.message);
    return json(res, 200, { feedback: r.data || [] });
  } catch (err) { sendError(res, err); }
}
