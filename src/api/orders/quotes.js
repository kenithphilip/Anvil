// GET /api/orders/quotes?order_id=...
//
// What quotes are attached to this PO, and what do they say?
//
// WHY. Attaching a quotation gave a toast and then nothing. Once the panel
// re-rendered there was no way to tell from the order whether a quote had been
// uploaded at all, which one, what it was worth, or when it was issued — so an
// operator could not answer "did that upload work?" without going to the
// database. The reconcile banner only names quotes that MATCHED, which is
// precisely the wrong set: the interesting case is the one that did not.
//
// Every field here already existed; nothing was aggregated for reading.
//
// READ-ONLY.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

// Columns added by later, hand-applied migrations. PostgREST rejects the whole
// select over one unknown name, so they are requested first and dropped on
// 42703 rather than taking the endpoint out on a tenant that is behind.
const OPTIONAL = ["revision", "revised_date", "notes", "ingest_source", "source_document_id"];
const BASE_COLS = "id, quote_number, version, status, currency, grand_total, sent_at, created_at, updated_at";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const orderId = req.query?.order_id;
    if (!orderId) return json(res, 400, { error: { message: "order_id required" } });
    const svc = serviceClient();

    const orderQ = await svc.from("orders").select("id, customer_id")
      .eq("tenant_id", ctx.tenantId).eq("id", orderId).maybeSingle();
    if (orderQ.error) throw new Error("orders read: " + orderQ.error.message);
    if (!orderQ.data) return json(res, 404, { error: { message: "Order not found" } });

    // 1. The documents attached to this PO as quotes.
    const linkQ = await svc.from("order_documents")
      .select("document_id, role").eq("order_id", orderId).eq("role", "quote");
    if (linkQ.error) throw new Error("order_documents read: " + linkQ.error.message);
    const docIds = (linkQ.data || []).map((r) => r.document_id).filter(Boolean);

    let documents = [];
    if (docIds.length) {
      // order_documents has no tenant_id of its own; the tenant check lives on
      // the order above and again on documents here.
      const docQ = await svc.from("documents")
        .select("id, filename, mime_type, size_bytes, created_at")
        .eq("tenant_id", ctx.tenantId).in("id", docIds);
      if (docQ.error) throw new Error("documents read: " + docQ.error.message);
      documents = docQ.data || [];
    }

    // 2. The quote rows those documents produced, plus every other quote for
    //    this customer that the reconciler would pool. A quote can reach an
    //    order two ways — ingested from an attached PDF (source_document_id
    //    points back), or authored in Anvil and merely linked — so neither
    //    half alone is the answer.
    let quotes = [];
    let optionalKnown = true;
    if (orderQ.data.customer_id) {
      let q = await svc.from("quotes").select(BASE_COLS + ", " + OPTIONAL.join(", "))
        .eq("tenant_id", ctx.tenantId).eq("customer_id", orderQ.data.customer_id)
        .order("created_at", { ascending: false }).limit(200);
      if (q.error && (q.error.code === "42703" || OPTIONAL.some((c) => new RegExp("\\b" + c + "\\b").test(q.error.message || "")))) {
        optionalKnown = false;
        q = await svc.from("quotes").select(BASE_COLS)
          .eq("tenant_id", ctx.tenantId).eq("customer_id", orderQ.data.customer_id)
          .order("created_at", { ascending: false }).limit(200);
      }
      if (q.error) throw new Error("quotes read: " + q.error.message);
      quotes = q.data || [];
    }

    const byDoc = new Map();
    for (const qt of quotes) if (qt.source_document_id) byDoc.set(qt.source_document_id, qt);

    // 3. Line counts, in ONE query rather than per quote.
    const relevant = quotes.filter((qt) => docIds.includes(qt.source_document_id));
    const counts = new Map();
    const totalsByQuote = new Map();
    if (relevant.length) {
      const lq = await svc.from("quote_lines")
        .select("quote_id, qty, discounted_unit_price, listed_unit_price, line_amount")
        .eq("tenant_id", ctx.tenantId).in("quote_id", relevant.map((r) => r.id));
      if (lq.error) throw new Error("quote_lines read: " + lq.error.message);
      for (const ln of lq.data || []) {
        counts.set(ln.quote_id, (counts.get(ln.quote_id) || 0) + 1);
        // A fallback for a quote whose header total did not extract: sum the
        // lines. Reported separately so the UI never presents a derived figure
        // as the quoted total.
        const rate = ln.discounted_unit_price != null ? Number(ln.discounted_unit_price) : Number(ln.listed_unit_price);
        const amt = ln.line_amount != null ? Number(ln.line_amount)
          : (Number.isFinite(rate) && ln.qty != null ? rate * Number(ln.qty) : null);
        if (amt != null && Number.isFinite(amt)) {
          totalsByQuote.set(ln.quote_id, Math.round(((totalsByQuote.get(ln.quote_id) || 0) + amt) * 100) / 100);
        }
      }
    }

    const attached = documents.map((doc) => {
      const qt = byDoc.get(doc.id) || null;
      const lineCount = qt ? (counts.get(qt.id) || 0) : 0;
      const lineTotal = qt ? (totalsByQuote.get(qt.id) ?? null) : null;
      return {
        document_id: doc.id,
        filename: doc.filename,
        uploaded_at: doc.created_at,
        size_bytes: doc.size_bytes ?? null,
        // Null when the PDF is attached but produced no quote row — extraction
        // failed, or it was not a quotation. That IS the answer to "did the
        // upload work", so it is reported rather than hidden.
        quote: qt
          ? {
              id: qt.id,
              quote_number: qt.quote_number,
              version: qt.version,
              revision: optionalKnown ? (qt.revision || null) : null,
              status: qt.status,
              currency: qt.currency || null,
              grand_total: qt.grand_total ?? null,
              line_count: lineCount,
              line_total: lineTotal,
              // "As of when was this priced." A revision date supersedes the
              // issue date when the document carries both.
              effective_date: (optionalKnown && qt.revised_date) || qt.sent_at || qt.created_at || null,
              effective_date_is_revision: !!(optionalKnown && qt.revised_date),
              quote_date: qt.sent_at || null,
              revised_date: optionalKnown ? (qt.revised_date || null) : null,
              authored_in_anvil: optionalKnown ? (qt.ingest_source == null || qt.ingest_source === "") : null,
            }
          : null,
        ingested: !!qt,
      };
    });

    // Quotes that will price this PO but have no attached PDF — authored in
    // Anvil, or ingested against a different document. Without these the card
    // would imply the reconciler had nothing to work with.
    const linkedQuoteIds = new Set(attached.map((a) => a.quote?.id).filter(Boolean));
    const otherQuotes = quotes
      .filter((qt) => !linkedQuoteIds.has(qt.id))
      .map((qt) => ({
        id: qt.id, quote_number: qt.quote_number, version: qt.version, status: qt.status,
        currency: qt.currency || null, grand_total: qt.grand_total ?? null,
        effective_date: (optionalKnown && qt.revised_date) || qt.sent_at || qt.created_at || null,
        authored_in_anvil: optionalKnown ? (qt.ingest_source == null || qt.ingest_source === "") : null,
      }));

    return json(res, 200, {
      order_id: orderId,
      attached,
      other_quotes: otherQuotes,
      // False when the database predates migration 215/188: revision and
      // provenance read as unknown rather than as absent.
      revision_fields_available: optionalKnown,
      summary: {
        attached_documents: attached.length,
        ingested: attached.filter((a) => a.ingested).length,
        not_ingested: attached.filter((a) => !a.ingested).length,
        other_quotes: otherQuotes.length,
      },
    });
  } catch (err) {
    sendError(res, err);
  }
}
