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
        // Deduping across KINDS would be a lie. The unique index behind this is
        // (tenant_id, order_id) with no kind in it, so a quotation queued while
        // the order's PO extraction is still running would be handed that PO
        // job and reported as queued — the caller sees ok, tells the operator
        // "the rest is being read in the background", and nothing ever reads
        // it. Same order, different document, different job.
        const existingKind = existing.data.extraction_kind || "po";
        const wantedKind = body.kind || body.extraction_kind || "po";
        if (existingKind !== wantedKind) {
          return json(res, 409, {
            error: {
              code: "extraction_in_flight_other_kind",
              message: "A '" + existingKind + "' extraction is already running on this order, and only one job"
                + " per order can be in flight. Retry the '" + wantedKind + "' read once it finishes.",
            },
            job: existing.data,
          });
        }
        return json(res, 200, { job: existing.data, deduped: true });
      }
      // The kinds the extractor has a schema for — the same list migration 219
      // constrains the column to, which is extraction_runs' list. Validated
      // rather than passed through: an unknown kind would be rejected by the
      // CHECK and take the whole insert with it (PostgREST rejects the
      // statement, not the column), so a typo in a caller would look like the
      // queue was broken.
      const KNOWN_KINDS = new Set([
        "po", "rfq", "supplier_ack", "invoice", "eway_bill", "generic",
        "assembly_bom", "part_drawing", "quote", "packing_list",
      ]);
      const requestedKind = body.kind || body.extraction_kind || null;
      if (requestedKind && !KNOWN_KINDS.has(requestedKind)) {
        return json(res, 400, {
          error: { message: "unknown kind: " + requestedKind + ". Expected one of " + [...KNOWN_KINDS].join(", ") },
        });
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
        // Default 'po' rather than null: every caller today is a PO flow, and
        // recording what the document actually is beats recording nothing and
        // making the worker guess again.
        extraction_kind: requestedKind || "po",
      };
      let ins = await svc.from("extraction_jobs").insert(row).select("*").single();
      // Migrations are applied by hand, so the column can be missing in a
      // database that already has this code. Retry without it rather than
      // refusing to queue the job — a document that extracts on the PO schema
      // is better than one that never extracts at all.
      //
      // That reasoning held while a PO was the only thing anyone could queue.
      // It is now DESTRUCTIVE for anything else. A job that persists without
      // its kind reads back through kindOfJob as "po" (it has an order id), so
      // the merge step takes the PO_SHAPED branch and writes the document's
      // lines into orders.result.salesOrder.lineItems — replacing the
      // customer's purchase-order lines with a quotation's.
      //
      // So: fall back only for the PO-shaped kinds, where dropping the label
      // costs nothing because "po" is exactly what the worker would infer
      // anyway. For any other kind, fail closed and say why. An unqueued long
      // quotation is a visible gap; a quotation silently overwriting a PO is
      // data loss nobody sees until the order is wrong.
      const PO_SHAPED_KINDS = new Set(["po", "rfq", "generic"]);
      if (ins.error && (ins.error.code === "42703" || /extraction_kind/.test(ins.error.message || ""))) {
        if (!PO_SHAPED_KINDS.has(row.extraction_kind)) {
          return json(res, 503, {
            error: {
              code: "extraction_kind_column_missing",
              message: "Cannot queue a '" + row.extraction_kind + "' extraction: this database has not had"
                + " migration 219 applied, so the job could not record what kind of document it is and would"
                + " be processed as a purchase order. Apply 219 and retry.",
            },
          });
        }
        const retry = { ...row };
        delete retry.extraction_kind;
        ins = await svc.from("extraction_jobs").insert(retry).select("*").single();
      }
      if (ins.error) {
        // A concurrent request already created an in-flight job for this order
        // (partial unique index extraction_jobs_one_inflight_per_order). Return
        // that job instead of erroring, so a double-click can't double-process.
        if (ins.error.code === "23505" || /duplicate key|unique constraint/i.test(ins.error.message)) {
          const race = await svc.from("extraction_jobs").select("*")
            .eq("tenant_id", ctx.tenantId).eq("order_id", body.order_id)
            .in("status", ["queued", "profiling", "chunking", "extracting", "merging"])
            .order("created_at", { ascending: false }).limit(1).maybeSingle();
          if (race.data) return json(res, 200, { job: race.data, deduped: true });
        }
        throw new Error(ins.error.message);
      }
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
