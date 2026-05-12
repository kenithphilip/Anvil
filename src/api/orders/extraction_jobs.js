// /api/orders/extraction_jobs
//   POST   create a new background extraction job
//   GET    list jobs for an order or customer (filtered by query)
//   GET /[id] is served by extraction_jobs/[id].js
//
// Phase C1. The synchronous extraction path can handle PDFs up
// to ~60 pages inside Vercel's 60-second function ceiling. For
// 70-500 page documents we land here: the client uploads the
// PDF, this endpoint records an extraction_jobs row, the cron
// worker picks it up on the next tick and processes it
// chunk-by-chunk across multiple ticks.
//
// The job carries enough context (storage_path, document_id,
// order_id, customer_id) that the worker can pick up the source
// bytes without holding them in memory between invocations.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

// Bound list responses so a tenant with thousands of jobs
// cannot blow up the UI on the rollup view.
const LIST_LIMIT = 50;

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    const actor = ctx.user && ctx.user.id ? ctx.user.id : null;

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let q = svc.from("extraction_jobs")
        .select("id, order_id, customer_id, status, total_pages, next_chunk_index, attempts, last_error, source_filename, source_size_bytes, created_at, updated_at, started_at, completed_at")
        .eq("tenant_id", ctx.tenantId)
        .order("created_at", { ascending: false })
        .limit(LIST_LIMIT);
      if (req.query.order_id)    q = q.eq("order_id", req.query.order_id);
      if (req.query.customer_id) q = q.eq("customer_id", req.query.customer_id);
      if (req.query.status)      q = q.eq("status", req.query.status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json(res, 200, { jobs: data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body.order_id) {
        return json(res, 400, { error: { message: "order_id required" } });
      }
      // Validate the order belongs to the tenant before
      // creating a job against it.
      const ord = await svc.from("orders")
        .select("id, customer_id")
        .eq("tenant_id", ctx.tenantId)
        .eq("id", body.order_id)
        .maybeSingle();
      if (!ord.data) {
        return json(res, 404, { error: { message: "order not found" } });
      }
      // De-dupe: if a job for this order is already in flight,
      // return that one. The operator clicks "extract" twice and
      // we don't want to spawn parallel duplicate jobs.
      const existing = await svc.from("extraction_jobs")
        .select("*")
        .eq("tenant_id", ctx.tenantId)
        .eq("order_id", body.order_id)
        .in("status", ["queued", "profiling", "chunking", "extracting", "merging"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existing.data) {
        return json(res, 200, { job: existing.data, deduped: true });
      }
      const row = {
        tenant_id: ctx.tenantId,
        order_id: body.order_id,
        customer_id: ord.data.customer_id || body.customer_id || null,
        document_id: body.document_id || null,
        storage_path: body.storage_path || null,
        source_filename: body.source_filename || null,
        source_size_bytes: body.source_size_bytes || null,
        source_mime: body.source_mime || "application/pdf",
        status: "queued",
        created_by: actor,
      };
      const ins = await svc.from("extraction_jobs").insert(row).select("*").single();
      if (ins.error) throw new Error(ins.error.message);
      await recordAudit(ctx, {
        action: "extraction_job_created",
        objectType: "extraction_job",
        objectId: ins.data.id,
        after: { order_id: body.order_id, document_id: row.document_id, source_filename: row.source_filename },
      });
      return json(res, 201, { job: ins.data });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
