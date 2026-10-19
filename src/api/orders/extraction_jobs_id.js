// /api/orders/extraction_jobs/[id]
//   GET    read job status (including chunk_status + partial_result for the UI)
//   PATCH  operator-side actions: cancel (status -> 'cancelled')
//
// Note the file is named extraction_jobs_id.js (with the
// trailing _id rather than [id]) so the router maps to
// /orders/extraction_jobs/{id}. See router.js.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    const id = req.query.id || req.query.job_id || (req.url || "").split("/").pop().split("?")[0];
    if (!id) return json(res, 400, { error: { message: "job id required" } });

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const r = await svc.from("extraction_jobs")
        .select("*")
        .eq("tenant_id", ctx.tenantId)
        .eq("id", id)
        .maybeSingle();
      if (!r.data) return json(res, 404, { error: { message: "job not found" } });
      return json(res, 200, { job: r.data });
    }

    if (req.method === "PATCH") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const existing = await svc.from("extraction_jobs")
        .select("*").eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
      if (!existing.data) return json(res, 404, { error: { message: "job not found" } });
      if (TERMINAL_STATUSES.has(existing.data.status)) {
        return json(res, 409, { error: { message: "job already in terminal status " + existing.data.status } });
      }
      // A merging job is writing its result to the order now. A cancel then
      // would say "cancelled" over lines that are already written.
      // shortcut: a job stuck in merging cannot be cancelled here (the worker
      // retries it when its lease ends), upgrade if a stuck merge is seen.
      if (existing.data.status === "merging") {
        return json(res, 409, { error: { code: "JOB_WRITING", message: "The job is writing its result to the order and can no longer be cancelled." } });
      }
      const patch = {};
      if (body.action === "cancel") {
        patch.status = "cancelled";
        patch.completed_at = new Date().toISOString();
        patch.last_error = body.reason || "operator cancelled";
      } else {
        return json(res, 400, { error: { message: "unsupported action; only 'cancel' is supported" } });
      }
      // Compare-and-set on the status read above: the worker may have moved
      // the job on (to merging) since.
      const upd = await svc.from("extraction_jobs")
        .update(patch)
        .eq("tenant_id", ctx.tenantId)
        .eq("id", id)
        .eq("status", existing.data.status)
        .select("*")
        .maybeSingle();
      if (upd.error) throw new Error(upd.error.message);
      if (!upd.data) return json(res, 409, { error: { code: "JOB_MOVED", message: "The job changed while it was being cancelled. Reload and try again." } });
      await recordAudit(ctx, {
        action: "extraction_job_" + body.action,
        objectType: "extraction_job",
        objectId: id,
        before: existing.data,
        after: upd.data,
      });
      return json(res, 200, { job: upd.data });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
