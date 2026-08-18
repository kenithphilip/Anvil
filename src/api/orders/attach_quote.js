// POST /api/orders/attach_quote
//   { order_id, document_id, extracted? }
//
// Attach an already-uploaded quotation PDF to a customer PO and make its
// contents count.
//
// Every piece of this existed and nothing joined them up:
//   - /api/documents/upload stores the PDF
//   - DocAI has a quote schema (extract_quote / QUOTE_TOOL, reached with
//     kind:"quote" — run.js maps kind -> hints.expectedKind)
//   - /api/quotes/ingest materialises an extracted quote into quotes +
//     quote_lines
//   - orders/reconcile_quotes.js already pools EVERY non-cancelled quote for
//     the customer and matches the PO across all of them, so many-quotes-to-
//     one-PO needs no new comparison logic at all
//   - order_documents(order_id, document_id, role) has carried a 'quote' role
//     since 001_init, with a composite PK that already means many documents
//     per order
//
// ...but no client method called ingest, no UI wrote order_documents, and the
// reconciler never looked at an uploaded document. A quote PDF attached to a PO
// was stored and ignored. This is the bridge, and it is deliberately thin: it
// orchestrates, it does not re-implement.
//
// The caller extracts first and posts the payload, the same order
// OpportunityQuoteRevisions already uses. /api/docai/extract resolves document
// bytes out of storage through a substantial amount of logic; re-running that
// here would be a second copy of it, and a second place for it to drift.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { ingestQuotes } from "../_lib/quote-ingest.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return json(res, 405, { error: { message: "Method not allowed" } });
    }
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = await readBody(req);
    const orderId = body?.order_id;
    const documentId = body?.document_id;
    if (!orderId || !documentId) {
      return json(res, 400, { error: { message: "order_id and document_id are required" } });
    }
    const svc = serviceClient();

    const orderQ = await svc.from("orders")
      .select("id, customer_id, po_number")
      .eq("tenant_id", ctx.tenantId).eq("id", orderId).maybeSingle();
    if (orderQ.error) throw new Error("orders read: " + orderQ.error.message);
    if (!orderQ.data) return json(res, 404, { error: { message: "Order not found" } });
    const order = orderQ.data;
    // The reconciler finds quotes BY CUSTOMER, so a quote ingested against an
    // order with no customer would be invisible to it — stored, and ignored
    // exactly as before. Refuse rather than pretend.
    if (!order.customer_id) {
      return json(res, 400, {
        error: { message: "Set the order's customer before attaching a quote — quotes are matched to the PO by customer." },
      });
    }

    const docQ = await svc.from("documents")
      .select("id, filename, mime_type")
      .eq("tenant_id", ctx.tenantId).eq("id", documentId).maybeSingle();
    if (docQ.error) throw new Error("documents read: " + docQ.error.message);
    if (!docQ.data) return json(res, 404, { error: { message: "Document not found" } });

    // 1. Link it to the PO first, so the attachment survives even if extraction
    //    fails. An operator who uploaded the right file should not have to
    //    upload it again because the model had a bad day.
    //    Composite PK (order_id, document_id) makes the re-attach idempotent.
    const linkQ = await svc.from("order_documents")
      .upsert({ order_id: orderId, document_id: documentId, role: "quote" }, { onConflict: "order_id,document_id" });
    if (linkQ.error) throw new Error("order_documents: " + linkQ.error.message);

    // 2. The extracted payload, produced by the caller via /api/docai/extract
    //    with kind:"quote". kind:"po" would classify a seller's quotation as
    //    non_po and yield nothing usable.
    const extracted = body?.extracted || null;
    const lines = Array.isArray(extracted?.lines) ? extracted.lines : [];
    if (!extracted || extracted.classification === "non_quote" || !lines.length) {
      // Attached but not ingested — reported, not thrown, and the caller is
      // told which half succeeded so the operator knows what to do next.
      await recordAudit(ctx, {
        action: "order_quote_attached", objectType: "order", objectId: orderId,
        detail: { document_id: documentId, ingested: false, reason: extracted ? "no_lines_or_not_a_quote" : "no_extraction" },
      });
      return json(res, 200, {
        attached: true, ingested: false,
        reason: extracted?.classification === "non_quote"
          ? "That document did not read as a quotation."
          : "No quote lines could be read from that document.",
        document: { id: documentId, filename: docQ.data.filename },
      });
    }

    // 3. Materialise into quotes/quote_lines — which is what makes the existing
    //    reconciler see it. No new comparison code.
    const report = await ingestQuotes(svc, ctx, [{
      customerId: order.customer_id,
      sourceDocumentId: documentId,
      ingestSource: "document",
      quote: {
        quote_number: extracted.quote_number || null,
        quote_date: extracted.quote_date || null,
        currency: extracted.currency || null,
        terms: extracted.terms || extracted.payment_terms || null,
        grand_total: extracted.grand_total ?? null,
      },
      lines,
    }]);

    await recordAudit(ctx, {
      action: "order_quote_attached", objectType: "order", objectId: orderId,
      detail: {
        document_id: documentId, ingested: true,
        quote_number: extracted.quote_number || null,
        lines_written: report.lines_written,
      },
    });

    return json(res, 200, {
      attached: true,
      ingested: report.quotes_ok > 0,
      quote_number: extracted.quote_number || null,
      lines_written: report.lines_written,
      mappings_learned: report.mappings_learned,
      report,
      document: { id: documentId, filename: docQ.data.filename },
      // The caller re-runs reconciliation; doing it here would hide which step
      // failed when something goes wrong.
      next: "reconcile",
    });
  } catch (err) {
    sendError(res, err);
  }
}
