// GET /api/rlhf/dataset?surface=&min_rating=&format=json|jsonl
//
// Exports a preference-pair dataset usable as RLHF training data.
// Each row in the export pairs the original output with the
// operator's corrected_output (when present) and the rating. We
// emit JSONL by default since downstream trainers (TRL, Axolotl,
// etc.) expect that.

import { applyCors, handlePreflight, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    res.end(JSON.stringify({ error: { message: "Method not allowed" } }));
    return;
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const svc = serviceClient();
    const url = new URL(req.url, "http://x");
    const surface = url.searchParams.get("surface");
    const minRating = url.searchParams.get("min_rating");
    const format = (url.searchParams.get("format") || "jsonl").toLowerCase();

    let q = svc.from("rlhf_feedback")
      .select("surface, prompt, output, corrected_output, rating, comment, model, created_at")
      .eq("tenant_id", ctx.tenantId)
      .order("created_at", { ascending: false })
      .limit(50_000);
    if (surface) q = q.eq("surface", surface);
    if (minRating != null && minRating !== "") q = q.gte("rating", Number(minRating));
    const r = await q;
    if (r.error) throw new Error(r.error.message);
    const rows = r.data || [];

    if (format === "json") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.end(JSON.stringify({ count: rows.length, rows }));
      return;
    }
    // JSONL: one preference pair per line.
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Content-Disposition", `attachment; filename="rlhf-${(surface || "all")}.jsonl"`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    for (const row of rows) {
      const line = {
        surface: row.surface,
        prompt: row.prompt,
        chosen: row.corrected_output || (row.rating > 0 ? row.output : null),
        rejected: row.rating < 0 ? row.output : null,
        rating: row.rating,
        comment: row.comment,
        model: row.model,
      };
      res.write(JSON.stringify(line) + "\n");
    }
    res.end();
  } catch (err) { sendError(res, err); }
}
