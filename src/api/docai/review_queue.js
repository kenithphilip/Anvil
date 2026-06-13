// /api/docai/review_queue
//
// Operator-facing read + decide surface over the extraction review
// queue (Wave 4.1). The pipeline already enqueues low-confidence,
// anomaly-blocker, parse-failed, and handwriting runs via
// `enqueueReview` at the end of runExtractionPipeline; until now there
// was no HTTP endpoint to list or resolve them, so the queue filled
// up invisibly. This wires the read + triage path.
//
//   GET  ?status=&severity=&reason=&customer_id=&limit=
//        Lists queue rows (default: open + in_review), newest first,
//        plus an open-count summary by severity for the screen header.
//
//   POST body: { id, action: "claim"|"resolve"|"reopen",
//                resolution?: "confirmed"|"rejected"|"reextracted",
//                notes? }
//        Triages one row. "claim" assigns it to the caller and moves
//        it to in_review; "resolve" closes it with a resolution;
//        "reopen" returns it to open.
//
// The queue card renders entirely from the row's `preview` + `metrics`
// jsonb (customer name, po number, line preview, confidence, adapter),
// so no join back to extraction_runs is needed for the list view.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { updateReviewStatus } from "../_lib/docai/review-queue.js";

const ALLOWED_STATUS = new Set(["open", "in_review", "resolved", "archived"]);
const ALLOWED_SEVERITY = new Set(["low", "medium", "high", "critical"]);
const ALLOWED_RESOLUTION = new Set(["confirmed", "rejected", "reextracted"]);

const userIdOf = (ctx) => ctx.user?.id || ctx.userId || null;

const listQueue = async (svc, ctx, url) => {
  const statusParam = url.searchParams.get("status");
  const severity = url.searchParams.get("severity");
  const reason = url.searchParams.get("reason");
  const customerId = url.searchParams.get("customer_id");
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 100)));

  let q = svc.from("extraction_review_queue")
    .select(`id, customer_id, extraction_run_id, case_id, reason, severity,
             triggered_by, preview, metrics, status, assigned_to,
             resolved_by, resolved_at, resolution, notes,
             created_at, updated_at`)
    .eq("tenant_id", ctx.tenantId)
    .order("created_at", { ascending: false })
    .limit(limit);

  // Default view is the actionable backlog (open + in_review). A
  // caller can pass an explicit status to see resolved/archived.
  if (statusParam && ALLOWED_STATUS.has(statusParam)) {
    q = q.eq("status", statusParam);
  } else {
    q = q.in("status", ["open", "in_review"]);
  }
  if (severity && ALLOWED_SEVERITY.has(severity)) q = q.eq("severity", severity);
  if (reason) q = q.eq("reason", reason);
  if (customerId) q = q.eq("customer_id", customerId);

  const r = await q;
  if (r.error) throw new Error(r.error.message);
  const rows = r.data || [];

  // Lightweight open-backlog summary for the screen header: counts by
  // severity across all open + in_review rows (independent of the
  // current filter so the header total is stable).
  const summaryRows = await svc.from("extraction_review_queue")
    .select("severity")
    .eq("tenant_id", ctx.tenantId)
    .in("status", ["open", "in_review"]);
  const summary = { low: 0, medium: 0, high: 0, critical: 0, total: 0 };
  for (const row of (summaryRows.data || [])) {
    if (summary[row.severity] != null) summary[row.severity] += 1;
    summary.total += 1;
  }
  return { queue: rows, summary };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const url = new URL(req.url || "/", "http://x");
      const out = await listQueue(svc, ctx, url);
      return json(res, 200, out);
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const id = body?.id;
      const action = body?.action;
      if (!id || !action) {
        return json(res, 400, { error: { message: "id and action required" } });
      }

      let update;
      if (action === "claim") {
        update = { status: "in_review", assignedTo: userIdOf(ctx) };
      } else if (action === "reopen") {
        update = { status: "open", assignedTo: null };
      } else if (action === "resolve") {
        const resolution = body?.resolution;
        if (!resolution || !ALLOWED_RESOLUTION.has(resolution)) {
          return json(res, 400, {
            error: { message: "resolution must be one of confirmed|rejected|reextracted" },
          });
        }
        update = {
          status: "resolved",
          resolution,
          resolvedBy: userIdOf(ctx),
          notes: body?.notes,
        };
      } else {
        return json(res, 400, { error: { message: "action must be claim|resolve|reopen" } });
      }

      const result = await updateReviewStatus(svc, {
        tenantId: ctx.tenantId,
        queueId: id,
        ...update,
      });
      if (!result.ok) {
        return json(res, 400, { error: { message: result.error || "update_failed" } });
      }

      await recordAudit(ctx, {
        action: "docai_review_" + action,
        objectType: "extraction_review_queue",
        objectId: id,
        detail: update.resolution || action,
      });
      return json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
