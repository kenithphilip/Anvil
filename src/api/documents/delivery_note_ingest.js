// POST /api/documents/delivery_note_ingest
//   { document_id, extracted, order_id? }
//
// Turn an extracted delivery note into despatch records.
//
// WHY THIS DOCUMENT. PR #539 shipped a pre-send check asking whether the
// consignment behind an invoice can lawfully move — is a required e-way bill
// filed, is there a docket number. It reports `docket_missing` on every invoice,
// because the docket is typed into Tally at despatch and Anvil never sees it.
// The challan is the one artefact that already exists on every consignment and
// carries all three things nothing else does: the docket number, the e-way bill
// reference, and the quantity that actually left per line.
//
// It also gives `dispatch_lines` (migration 193) its first caller. The writer,
// `upsertDispatchLines`, has existed and been tested since it was built and has
// never been called by anything — the register was read by four modules and
// populated by none.
//
// IT WRITES ONE THING: dispatch_lines. It does not create shipments, does not
// touch orders or invoices, does not file e-way bills. The e-way bill number it
// reads is recorded on the despatch row as evidence, NOT used to create or
// amend a bill: filing is a statutory act with its own endpoint and its own
// operator, and inferring one from a PDF would be the wrong kind of helpful.
// Same discipline as packing_list_ingest.js, which reads weights and refuses to
// touch the shipment ladder.
//
// ORDER RESOLUTION IS REFUSED, NOT GUESSED. A despatch row attached to the
// wrong order is worse than no row: it silently satisfies a dispatch check for a
// consignment that never shipped. So the match must be unambiguous or the
// caller is told why it was not, with candidates, and nothing is written.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { upsertDispatchLines } from "../_lib/dispatch-lines.js";
import { matchSalesOrderToOrders, poKey } from "../_lib/sales-order-match.js";

const clean = (v) => {
  const s = v === null || v === undefined ? "" : String(v).trim();
  return s || null;
};

// A line_ref is only usable as a line_index when it is actually an ordinal.
// Challans print "1", "2" as often as "L-004/A" or a part code, and coercing
// the latter to a number would key the row onto whichever PO line happened to
// sit at that position. Non-numeric refs are kept in metadata and the register
// falls back to part_no, which is its documented second tier.
const asOrdinal = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  // Challans are 1-based; dispatch_lines.line_index is the 0-based ordinal into
  // orders.result.salesOrder.lineItems[], the same key the register uses.
  return n >= 1 ? n - 1 : null;
};

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
    const extracted = body.extracted || null;
    if (!extracted) return json(res, 400, { error: { message: "extracted required" } });

    const svc = serviceClient();

    // A non-challan reaching here is the caller's mistake, and saying so beats
    // writing despatch rows from an invoice.
    const classification = clean(extracted.classification);
    if (classification && classification !== "delivery_note") {
      return json(res, 200, {
        ok: false, reason: "not_a_delivery_note",
        classification,
        detail: `This document was read as ${classification}, so no despatch records were written.`,
        written: { inserted: 0, updated: 0 },
      });
    }

    const lines = Array.isArray(extracted.lines) ? extracted.lines : [];
    if (!lines.length) {
      // KIND_GATES_TABLE marks delivery_note requiresLines, so a run with no
      // lines is already refused upstream. Repeated here because this endpoint
      // can be called with a hand-built payload.
      return json(res, 200, {
        ok: false, reason: "no_lines",
        detail: "The delivery note carried no line items, so there is nothing to record as despatched.",
        written: { inserted: 0, updated: 0 },
      });
    }

    // ── Which order does this consignment belong to? ──────────────────────────
    let orderId = clean(body.order_id);
    let match = null;
    if (!orderId) {
      const ordersQ = await svc.from("orders")
        .select("id, po_number, customer_id")
        .eq("tenant_id", ctx.tenantId).limit(2000);
      if (ordersQ.error) throw new Error("orders read: " + ordersQ.error.message);

      // Reuse the existing matcher rather than writing a second one — it already
      // refuses ambiguity and returns candidates. It reads buyer_ref_order_no,
      // so the challan's own field name is adapted rather than the matcher
      // duplicated.
      match = matchSalesOrderToOrders(
        { buyer_ref_order_no: extracted.buyer_po_no },
        ordersQ.data || [],
      );

      if (!match.matched && clean(extracted.invoice_no)) {
        // Second tier: the invoice this consignment is billed on. A challan
        // often cites the invoice and not the customer's PO.
        const invQ = await svc.from("invoices")
          .select("id, order_id, invoice_number")
          .eq("tenant_id", ctx.tenantId);
        if (!invQ.error) {
          const want = poKey(extracted.invoice_no);
          const hits = (invQ.data || []).filter((i) => poKey(i.invoice_number) === want && i.order_id);
          // Ambiguity refused here too: two invoices carrying one number is a
          // data problem, and picking either would attach the goods to a guess.
          if (hits.length === 1) {
            orderId = hits[0].order_id;
            match = { matched: true, reason: "matched_on_invoice_number", order_id: orderId };
          } else if (hits.length > 1) {
            match = {
              matched: false, reason: "ambiguous_invoice_number",
              detail: `${hits.length} invoices carry the number "${extracted.invoice_no}", so which order this consignment belongs to has no answer.`,
              candidates: hits.map((i) => ({ invoice_id: i.id, order_id: i.order_id })),
            };
          }
        }
      } else if (match.matched) {
        orderId = match.order?.id || match.order_id || null;
      }
    }

    if (!orderId) {
      // Nothing written, and the reason is specific enough to act on.
      return json(res, 200, {
        ok: false,
        reason: match?.reason || "unresolved_order",
        detail: match?.detail || "Could not determine which order this delivery note belongs to, so nothing was recorded.",
        candidates: match?.candidates || [],
        delivery_note_no: clean(extracted.delivery_note_no),
        buyer_po_no: clean(extracted.buyer_po_no),
        invoice_no: clean(extracted.invoice_no),
        written: { inserted: 0, updated: 0 },
      });
    }

    // ── Build the despatch rows ───────────────────────────────────────────────
    //
    // Header values repeat onto every row deliberately. dispatch_lines has no
    // header table (migration 193 is a flat per-line mirror), and the register
    // and the readiness check both read these off a line.
    const header = {
      delivery_note_no: clean(extracted.delivery_note_no),
      dispatch_date: clean(extracted.delivery_note_date),
      lr_number: clean(extracted.docket_no),
      carrier: clean(extracted.carrier),
      invoice_number: clean(extracted.invoice_no),
      invoice_date: clean(extracted.invoice_date),
    };

    const rows = lines.map((ln) => ({
      ...header,
      order_id: orderId,
      line_index: asOrdinal(ln?.line_ref),
      part_no: clean(ln?.partNumber ?? ln?.part_no),
      description: clean(ln?.description),
      // The despatched quantity, which is the number the whole kind exists for.
      dispatched_qty: ln?.quantity ?? ln?.qty ?? 0,
      uom: clean(ln?.uom),
      source_document_id: clean(body.document_id),
      // Unknown keys are rescued into metadata by normalizeDispatchLine rather
      // than dropped, so the e-way bill reference and the vehicle survive as
      // evidence without this endpoint pretending to file anything.
      eway_bill_no: clean(extracted.eway_bill_no),
      vehicle_no: clean(extracted.vehicle_no),
      ordered_qty: ln?.ordered_qty ?? null,
      line_ref: clean(ln?.line_ref),
    }));

    const written = await upsertDispatchLines(svc, ctx.tenantId, rows, { orderId });

    await recordAudit(ctx, {
      action: "delivery_note_ingest",
      objectType: "order",
      objectId: orderId,
      detail: `${written.inserted} inserted, ${written.updated} updated from challan ${header.delivery_note_no || "(unnumbered)"}`,
    });

    return json(res, 200, {
      ok: true,
      order_id: orderId,
      matched_on: match?.reason || (body.order_id ? "explicit_order_id" : null),
      delivery_note_no: header.delivery_note_no,
      docket_no: header.lr_number,
      eway_bill_no: clean(extracted.eway_bill_no),
      written,
      // Said out loud: the docket is now on record and the e-way bill number is
      // evidence only. Nothing here filed a bill.
      note: "Despatch lines recorded. The e-way bill number is stored as evidence; filing remains a separate act.",
    });
  } catch (err) { sendError(res, err); }
}
