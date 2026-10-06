// /api/source_pos/:id/receive  (Logistics Ops P2 — GRN-first)
//
//   GET   -> { po, lines, receipts }  the PO's relational lines (with
//            received-so-far) + prior goods receipts, for the Receive modal.
//   POST  -> body { lines: [{ line_index, received_qty }], receipt_number?, note? }
//            Records a goods receipt: increments source_po_lines.received_qty,
//            writes one ap_goods_receipts (GRN) row in the shape the AP 3-way
//            match reads, and — when every ordered line is met — flips the PO to
//            RECEIVED (guarded) with a source_po_events row.
//
// This closes the previously-open inbound receipt loop: received_qty was
// created but never written, and ap_goods_receipts had no application writer.
// Design: docs/LOGISTICS_OPS_DESIGN.md.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { applyReceipt, projectReceipt } from "../_lib/logistics/receiving.js";

// RECEIVED is reachable from these open statuses (mirrors the guard in
// source_pos/[id].js ALLOWED_TRANSITIONS; kept local so we don't couple to it).
const CAN_RECEIVE_FROM = new Set(["SUPPLIER_ACK", "PRICE_CHANGED", "ETA_CONFIRMED", "DELAYED", "RECEIVED"]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    // The router injects the PO id as req.query.id (param:"id"). Do NOT parse it
    // from req.url — under the Vercel rewrite req.url is "/api/dispatch".
    const id = req.query?.id;
    if (!id) return json(res, 400, { error: { message: "source_po id required" } });

    // Confirm the PO exists in this tenant (also the tenant-scope guard).
    const poQ = await svc.from("source_pos").select("id, reference, status")
      .eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
    if (poQ.error) throw new Error(poQ.error.message);
    if (!poQ.data) return json(res, 404, { error: { message: "Source PO not found" } });
    const po = poQ.data;

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const [linesQ, recQ] = await Promise.all([
        svc.from("source_po_lines").select("*")
          .eq("tenant_id", ctx.tenantId).eq("source_po_id", id).order("line_index", { ascending: true }),
        svc.from("ap_goods_receipts").select("*")
          .eq("tenant_id", ctx.tenantId).eq("source_po_id", id).order("received_at", { ascending: false }),
      ]);
      if (linesQ.error) throw new Error(linesQ.error.message);
      return json(res, 200, { po, lines: linesQ.data || [], receipts: recQ.data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const inputs = Array.isArray(body?.lines) ? body.lines : [];
      if (!inputs.length) return json(res, 400, { error: { message: "lines[] with { line_index, received_qty } required" } });

      const linesQ = await svc.from("source_po_lines").select("id, line_index, part_no, qty, received_qty")
        .eq("tenant_id", ctx.tenantId).eq("source_po_id", id).order("line_index", { ascending: true });
      if (linesQ.error) throw new Error(linesQ.error.message);
      const lines = linesQ.data || [];
      if (!lines.length) return json(res, 400, { error: { message: "This PO has no relational lines to receive against" } });

      const nowIso = new Date().toISOString();
      const { grnLines, errors } = applyReceipt(lines, inputs);
      if (!grnLines.length) {
        return json(res, 400, { error: { message: "No valid lines to receive", errors } });
      }

      // 1. Write the immutable GRN ledger row FIRST (shape the AP 3-way match
      //    reads: lines[].po_line_ref = part number + received_qty). Writing the
      //    ledger before mutating the projection means a later failure leaves a
      //    recomputable projection, not an inflated received_qty with no event.
      const receiptNumber = body.receipt_number || ("GRN-" + (po.reference || String(id).slice(0, 8)) + "-" + Date.now().toString(36));
      const grn = await svc.from("ap_goods_receipts").insert({
        tenant_id: ctx.tenantId,
        source_po_id: id,
        receipt_number: receiptNumber,
        received_at: nowIso,
        lines: grnLines,
        raw: { note: body.note || null, received_by: ctx.user?.id || null, input_errors: errors },
      }).select("id").maybeSingle();
      if (grn.error) throw new Error("ap_goods_receipts insert: " + grn.error.message);

      // 2. Re-project source_po_lines.received_qty from the FULL ledger (incl.
      //    the row just written), so received_qty is always the sum of receipts.
      const allRecQ = await svc.from("ap_goods_receipts").select("lines")
        .eq("tenant_id", ctx.tenantId).eq("source_po_id", id);
      if (allRecQ.error) throw new Error("ap_goods_receipts read: " + allRecQ.error.message);
      const { updates, overReceived, fullyReceived } = projectReceipt(lines, allRecQ.data || [], nowIso);
      for (const u of updates) {
        const upd = await svc.from("source_po_lines")
          .update({ received_qty: u.received_qty, received_at: u.received_at, updated_at: nowIso })
          .eq("tenant_id", ctx.tenantId).eq("id", u.id);
        if (upd.error) throw new Error("source_po_lines update: " + upd.error.message);
      }

      // 3. Flip to RECEIVED when fully received and the transition is legal.
      let statusChanged = false;
      if (fullyReceived && CAN_RECEIVE_FROM.has(po.status) && po.status !== "RECEIVED") {
        const stUpd = await svc.from("source_pos")
          .update({ status: "RECEIVED", updated_at: nowIso })
          .eq("tenant_id", ctx.tenantId).eq("id", id);
        if (stUpd.error) throw new Error("source_pos status update: " + stUpd.error.message);
        await svc.from("source_po_events").insert({
          tenant_id: ctx.tenantId, source_po_id: id,
          from_status: po.status, to_status: "RECEIVED",
          detail: "Goods received (GRN " + receiptNumber + ")", actor: ctx.user?.id || null,
        });
        statusChanged = true;
      }

      await recordAudit(ctx, {
        action: "source_po_receive",
        objectType: "source_po",
        objectId: id,
        after: { grn_id: grn.data?.id, fully_received: fullyReceived, status: statusChanged ? "RECEIVED" : po.status, lines_received: updates.length },
      });

      return json(res, 200, {
        received: true,
        grn_id: grn.data?.id,
        receipt_number: receiptNumber,
        fully_received: fullyReceived,
        status: statusChanged ? "RECEIVED" : po.status,
        status_changed: statusChanged,
        over_received: overReceived,
        errors,
      });
    }

    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
