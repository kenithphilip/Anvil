// POST /api/orders/detach_quote  { order_id, document_id }
//
// Remove a redundant quote attachment from a PO.
//
// WHY THIS IS NARROW. The operator's ask was "if a quote is duplicated it
// should not get uploaded, and delete previous redundant versions". The first
// half is handled at the source — documents/upload.js now returns the existing
// document for identical content, so a duplicate is no longer created. This is
// the second half: the copies already sitting on orders.
//
// IT UNLINKS. It does not delete the document, and it does not touch the
// quote or its lines.
//
//   - The documents row is referenced by audit events, extraction runs and
//     evidence rows. Deleting it to tidy a screen would break the trail that
//     explains how the order was priced.
//   - Unlinking is reversible: re-attach puts it back.
//   - A hard delete of stored bytes is not something to do implicitly on the
//     way to fixing a display problem.
//
// THE GUARD THAT MATTERS. It refuses to detach the document that actually
// carries the quote. Removing that one would take the quote's provenance off
// the order and leave the reconciler pricing lines from a document nobody can
// point at.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = (await readBody(req)) || {};
    const orderId = body.order_id;
    const documentId = body.document_id;
    if (!orderId || !documentId) {
      return json(res, 400, { error: { message: "order_id and document_id are required" } });
    }
    const svc = serviceClient();

    // order_documents carries no tenant_id; the tenant check lives here.
    const orderQ = await svc.from("orders").select("id")
      .eq("tenant_id", ctx.tenantId).eq("id", orderId).maybeSingle();
    if (orderQ.error) throw new Error("orders read: " + orderQ.error.message);
    if (!orderQ.data) return json(res, 404, { error: { message: "Order not found" } });

    const linkQ = await svc.from("order_documents")
      .select("order_id, document_id, role")
      .eq("order_id", orderId).eq("document_id", documentId).maybeSingle();
    if (linkQ.error) throw new Error("order_documents read: " + linkQ.error.message);
    if (!linkQ.data) return json(res, 404, { error: { message: "That document is not attached to this order." } });

    // Does this document carry a quote? If so it is the record, not a
    // redundant copy, and detaching it would orphan the pricing provenance.
    let carriesQuote = null;
    const q = await svc.from("quotes")
      .select("id, quote_number").eq("tenant_id", ctx.tenantId).eq("source_document_id", documentId).limit(1);
    // source_document_id arrived in migration 188. On a database without it,
    // refuse rather than guess: we cannot prove this copy is redundant, and
    // unlinking the wrong one is the failure worth avoiding.
    if (q.error) {
      return json(res, 409, {
        error: { message: "Cannot confirm this attachment is redundant on this database — leaving it in place." },
      });
    }
    carriesQuote = (q.data || [])[0] || null;
    if (carriesQuote) {
      return json(res, 409, {
        error: {
          message: `This is the copy carrying quote ${carriesQuote.quote_number} — detaching it would remove the order's link to the document that priced it. Detach the redundant copy instead.`,
        },
        quote_number: carriesQuote.quote_number,
      });
    }

    const del = await svc.from("order_documents")
      .delete().eq("order_id", orderId).eq("document_id", documentId);
    if (del.error) throw new Error("order_documents delete: " + del.error.message);

    await recordAudit(ctx, {
      action: "order_quote_detached", objectType: "order", objectId: orderId,
      detail: { document_id: documentId, role: linkQ.data.role, document_kept: true },
    });

    return json(res, 200, {
      detached: true,
      document_id: documentId,
      // Said explicitly, because "delete" was the word in the request and this
      // deliberately did less than that.
      document_deleted: false,
      note: "The attachment was removed from this order. The document itself is kept, so the audit trail and any extraction history stay intact.",
    });
  } catch (err) {
    sendError(res, err);
  }
}
