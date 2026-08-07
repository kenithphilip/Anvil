// /api/comms/dispatch_lines — populate the per-line despatch mirror.
//
//   GET    ?order_id=...            the despatch lines recorded for an order.
//   POST   { order_id?, rows:[...] } upsert despatch lines. Each row may use ERP
//                                    / CSV vocabulary (qty, part, lr, invoice_no,
//                                    voucher_ref, …) — normalizeDispatchLine maps
//                                    it. Idempotent on source_ref, so re-posting
//                                    the same delivery note updates, not dupes.
//   DELETE ?id=... | ?order_id=...  remove a line (or all for an order) — for
//                                    corrections.
//
// This is the writer a future Tally "delivery_note" sync entity calls; the same
// endpoint backs a CSV import or a manual SCM entry. The customer-facing
// register that reads this data is /api/comms/dispatch_register.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { upsertDispatchLines } from "../_lib/dispatch-lines.js";
import { maybeAutoSendDispatchRegister } from "../_lib/dispatch-register-send.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const orderId = req.query?.order_id;
      if (!orderId) return json(res, 400, { error: { message: "order_id required" } });
      const r = await svc.from("dispatch_lines")
        .select("id, order_id, shipment_id, schedule_line_id, line_index, part_no, description, dispatched_qty, uom, dispatch_date, lr_number, carrier, invoice_number, invoice_date, source_ref")
        .eq("tenant_id", ctx.tenantId).eq("order_id", orderId)
        .order("dispatch_date", { ascending: true });
      if (r.error) throw new Error(r.error.message);
      return json(res, 200, { ok: true, dispatch_lines: r.data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const rows = Array.isArray(body?.rows) ? body.rows : null;
      if (!rows || !rows.length) return json(res, 400, { error: { message: "rows[] required" } });
      if (rows.length > 1000) return json(res, 400, { error: { message: "too many rows (max 1000 per call)" } });

      const result = await upsertDispatchLines(svc, ctx.tenantId, rows, { orderId: body?.order_id || null });
      await recordAudit(ctx, {
        action: "dispatch_lines_ingested",
        objectType: "order",
        objectId: body?.order_id || null,
        detail: result.inserted + " inserted, " + result.updated + " updated" + (result.errors.length ? ", " + result.errors.length + " errored" : ""),
      });
      // Auto-send the customer dispatch register on a NEW despatch, when the
      // tenant has opted in (dark by default). Best-effort + fires only on
      // freshly-inserted lines so a re-synced delivery note never re-mails. The
      // helper never throws, so the ingest response is unaffected.
      if (body?.order_id && result.inserted > 0) {
        await maybeAutoSendDispatchRegister(svc, ctx, body.order_id);
      }
      return json(res, 200, { ok: result.errors.length === 0, ...result });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "write");
      let q = svc.from("dispatch_lines").delete().eq("tenant_id", ctx.tenantId);
      if (req.query?.id) q = q.eq("id", req.query.id);
      else if (req.query?.order_id) q = q.eq("order_id", req.query.order_id);
      else return json(res, 400, { error: { message: "id or order_id required" } });
      const del = await q;
      if (del.error) throw new Error(del.error.message);
      return json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    return sendError(res, err);
  }
}
