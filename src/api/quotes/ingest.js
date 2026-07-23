// POST /api/quotes/ingest
//
// Ingest one or MANY extracted quotations. Seeds the customer-part identity
// flywheel and price history from documents the sales team already produces,
// with no change to how they quote.
//
// Body accepts either shape — a single quote, or a batch:
//   { customer_id, quote: {...}, lines: [...], source_document_id? }
//   { quotes: [ { customer_id, quote, lines, source_document_id }, ... ] }
//
// REDUNDANCY, NOT A WATERFALL. This endpoint is optional in every sense: the
// order pipeline never calls it, never waits for it, and behaves identically
// whether a customer has zero quotes ingested or a thousand. It feeds the same
// shared learning store (item_customer_parts) that operator confirmations and
// PO reconciliation already write to, so it is an ADDITIONAL path to identity
// rather than a new mandatory stage in front of the existing ones.
//
// Because ingested quotes are materialised into the normal quotes/quote_lines
// tables, orders/reconcile_quotes.js — which already pools EVERY non-cancelled
// quote for a customer and matches PO lines across all of them — begins
// verifying prices immediately, including many-quotes-to-one-PO.
//
// Partial success is the norm and is reported, not thrown: one unreadable line
// must never reject a 40-line quote, and one bad quote must never abort a
// back-catalogue import.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { ingestQuotes } from "../_lib/quote-ingest.js";

const MAX_BATCH = 200;

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
    const body = await readBody(req);

    // Normalise single vs batch into one list.
    const list = Array.isArray(body?.quotes)
      ? body.quotes
      : (body?.quote || body?.lines ? [body] : []);
    if (!list.length) {
      return json(res, 400, {
        error: { message: "Provide { quote, lines } or { quotes: [...] }" },
      });
    }
    if (list.length > MAX_BATCH) {
      return json(res, 400, {
        error: { message: "Batch too large: " + list.length + " > " + MAX_BATCH + ". Split the import." },
      });
    }

    const svc = serviceClient();
    const inputs = list.map((q) => ({
      quote: q?.quote || {},
      lines: Array.isArray(q?.lines) ? q.lines : [],
      customerId: q?.customer_id || q?.customerId || null,
      sourceDocumentId: q?.source_document_id || q?.sourceDocumentId || null,
      ingestSource: list.length > 1 ? "bulk" : (q?.ingest_source || "document"),
    }));

    const summary = await ingestQuotes(svc, ctx, inputs);

    await recordAudit(ctx, {
      action: "quote_ingested",
      objectType: "quote",
      objectId: summary.reports.length === 1 ? summary.reports[0].quote_id : null,
      detail: summary.quotes_ok + "/" + summary.quotes_total + " quotes · "
        + summary.lines_written + " lines · " + summary.mappings_learned + " part mappings learned",
    });

    return json(res, 200, { ok: true, ...summary });
  } catch (err) {
    return sendError(res, err);
  }
}
