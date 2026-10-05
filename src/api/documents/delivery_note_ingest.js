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
import { poKey } from "../_lib/sales-order-match.js";

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

// PostgREST LIKE/ILIKE patterns treat % and _ as wildcards; a challan or
// invoice number containing them must match literally.
const likeEscape = (v) => String(v).replace(/[\\%_]/g, (c) => "\\" + c);

// What the challan's OWN references point at, read the same way whether or
// not the operator named an order. Reads are filtered on the server (a
// tenant-wide read is capped by PostgREST and silently truncated) and then
// matched exactly under poKey. A failed read throws: an invoice check that
// quietly skips is how a wrong-order challan gets accepted.
const readChallanReferences = async (svc, tenantId, extracted) => {
  const po = clean(extracted.buyer_po_no);
  const inv = clean(extracted.invoice_no);

  let poHits = [];
  if (po) {
    const q = await svc.from("orders")
      .select("id, po_number, customer_id")
      .eq("tenant_id", tenantId)
      .ilike("po_number", "%" + likeEscape(po) + "%")
      .limit(200);
    if (q.error) throw new Error("orders read: " + q.error.message);
    const want = poKey(po);
    poHits = (q.data || []).filter((o) => poKey(o.po_number) === want);
  }

  let invoiceHits = [];
  if (inv) {
    const q = await svc.from("invoices")
      .select("id, order_id, invoice_number")
      .eq("tenant_id", tenantId)
      .ilike("invoice_number", "%" + likeEscape(inv) + "%")
      .limit(200);
    if (q.error) throw new Error("invoices read: " + q.error.message);
    const want = poKey(inv);
    invoiceHits = (q.data || []).filter((i) => poKey(i.invoice_number) === want && i.order_id);
  }

  // PO numbers for every order a refusal may name, so a candidate is shown
  // by the number the operator knows rather than an internal id.
  const poById = new Map(poHits.map((o) => [o.id, o.po_number || null]));
  const missing = [...new Set(invoiceHits.map((i) => i.order_id))].filter((id) => !poById.has(id));
  if (missing.length) {
    const q = await svc.from("orders").select("id, po_number")
      .eq("tenant_id", tenantId).in("id", missing);
    if (!q.error) for (const o of q.data || []) poById.set(o.id, o.po_number || null);
  }
  return { po, inv, poHits, invoiceHits, poById };
};

const candidatesFor = (ids, poById) =>
  [...new Set(ids)].filter(Boolean).map((id) => ({ id, po_number: poById.get(id) ?? null }));

const refuse = (res, reason, detail, extracted, candidates = []) => json(res, 200, {
  ok: false, reason, detail, candidates,
  delivery_note_no: clean(extracted.delivery_note_no),
  buyer_po_no: clean(extracted.buyer_po_no),
  invoice_no: clean(extracted.invoice_no),
  written: { inserted: 0, updated: 0 },
});

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

    // ── The challan's own identity ────────────────────────────────────────────
    //
    // dispatch_lines is keyed (tenant_id, source_ref) across the WHOLE tenant
    // and an update rewrites order_id, so the key decides whether a second
    // upload updates this challan or moves another order's rows. Tally challan
    // numbers restart each financial year, so the number alone is not an
    // identity: the challan date joins it. A challan with no number falls back
    // to the stored document (uploads are de-duplicated by content hash, so
    // the same file is the same document). With neither, a re-upload could not
    // be told from a new consignment, so it is refused.
    const dnNo = clean(extracted.delivery_note_no);
    const dnDate = clean(extracted.delivery_note_date);
    const documentId = clean(body.document_id);
    const identity = dnNo ? `${dnNo}@${dnDate || "undated"}` : (documentId ? `doc:${documentId}` : null);
    if (!identity) {
      return refuse(res, "no_challan_identity",
        "The challan carries no number and no stored document, so a second upload could not be told apart from a new consignment. Nothing was recorded.",
        extracted);
    }

    // ── Which order does this consignment belong to? ──────────────────────────
    const refs = await readChallanReferences(svc, ctx.tenantId, extracted);
    const poOrderIds = refs.poHits.map((o) => o.id);
    const invOrderIds = refs.invoiceHits.map((i) => i.order_id);

    let orderId = null;
    // How the order was settled, for the audit row and the response.
    let basis = null;
    const explicitOrderId = clean(body.order_id);

    if (explicitOrderId) {
      // The operator chose the order. That choice is checked against what the
      // challan itself cites, not trusted: a challan uploaded on the wrong
      // order would otherwise land there silently and satisfy that order's
      // despatch check.
      const ordQ = await svc.from("orders")
        .select("id, po_number")
        .eq("tenant_id", ctx.tenantId).eq("id", explicitOrderId).maybeSingle();
      if (ordQ.error) throw new Error("order read: " + ordQ.error.message);
      if (!ordQ.data) return json(res, 404, { error: { message: "order not found" } });
      const order = ordQ.data;
      const orderPo = poKey(order.po_number);
      const challanPo = refs.po ? poKey(refs.po) : "";

      const poHere = !!(challanPo && orderPo && challanPo === orderPo);
      // The challan's PO points elsewhere when the order carries a different
      // PO, or when the order has none and the challan's PO belongs to
      // another order.
      const poElsewhere = !!challanPo && !poHere && (
        !!orderPo || poOrderIds.some((id) => id !== order.id)
      );
      const invoiceHere = invOrderIds.includes(order.id);
      const invoiceElsewhere = invOrderIds.some((id) => id !== order.id);

      if (poElsewhere || invoiceElsewhere) {
        const elsewhere = [...poOrderIds, ...invOrderIds].filter((id) => id !== order.id);
        return refuse(res, "order_mismatch",
          poElsewhere
            ? (orderPo
              ? `This challan cites PO "${refs.po}", but the chosen order is for PO "${order.po_number}". Nothing was recorded.`
              : `This challan cites PO "${refs.po}", which belongs to a different order, and the chosen order has no PO number. Nothing was recorded.`)
            : `This challan cites invoice "${refs.inv}", which belongs to a different order. Nothing was recorded.`,
          extracted, candidatesFor(elsewhere, refs.poById));
      }

      orderId = order.id;
      // Say exactly what was checked, never more.
      const checked = [];
      if (poHere) checked.push("PO number matches");
      if (invoiceHere) checked.push("invoice number matches");
      if (challanPo && !poHere) checked.push("the challan's PO is on no order and the order has no PO number to compare");
      if (refs.inv && !invoiceHere && !invoiceElsewhere) checked.push("the challan's invoice number is not on file");
      basis = "order chosen by operator; " + (checked.length ? checked.join("; ") : "challan carries no checkable reference");
    } else {
      // No order named: the challan's references must resolve to exactly one
      // order, and must not point two ways.
      const poUnique = refs.poHits.length === 1 ? refs.poHits[0].id : null;
      const invUnique = new Set(invOrderIds).size === 1 ? invOrderIds[0] : null;
      if (poUnique && invUnique && poUnique !== invUnique) {
        return refuse(res, "conflicting_references",
          `This challan's PO "${refs.po}" and invoice "${refs.inv}" belong to different orders, so which order it belongs to has no answer. Nothing was recorded.`,
          extracted, candidatesFor([poUnique, invUnique], refs.poById));
      }
      if (poUnique) {
        orderId = poUnique; basis = "matched_on_buyer_po_number";
      } else if (refs.poHits.length > 1) {
        return refuse(res, "several_orders_with_that_reference",
          `${refs.poHits.length} orders carry the purchase-order number "${refs.po}". Open the right order and upload the challan there.`,
          extracted, candidatesFor(poOrderIds, refs.poById));
      } else if (invUnique) {
        // Second tier: the invoice this consignment is billed on. A challan
        // often cites the invoice and not the customer's PO.
        orderId = invUnique; basis = "matched_on_invoice_number";
      } else if (new Set(invOrderIds).size > 1) {
        // Two invoices carrying one number is a data problem, and picking
        // either would attach the goods to a guess.
        return refuse(res, "ambiguous_invoice_number",
          `${new Set(invOrderIds).size} orders have an invoice numbered "${refs.inv}", so which order this consignment belongs to has no answer.`,
          extracted, candidatesFor(invOrderIds, refs.poById));
      } else {
        return refuse(res, "unresolved_order",
          refs.po || refs.inv
            ? "No order carries this challan's PO or invoice number. Open the order and upload the challan there."
            : "The challan carries no PO or invoice number. Open the order and upload the challan there.",
          extracted);
      }
    }

    // ── Is this challan already recorded on another order? ────────────────────
    const likeKey = likeEscape(identity) + "#%";
    const prior = await svc.from("dispatch_lines")
      .select("order_id")
      .eq("tenant_id", ctx.tenantId)
      .like("source_ref", likeKey)
      .limit(50);
    if (prior.error) throw new Error("dispatch_lines read: " + prior.error.message);
    const otherOrders = [...new Set((prior.data || []).map((r) => r.order_id).filter((id) => id && id !== orderId))];
    if (otherOrders.length) {
      const pq = await svc.from("orders").select("id, po_number").eq("tenant_id", ctx.tenantId).in("id", otherOrders);
      const poById = new Map((pq.data || []).map((o) => [o.id, o.po_number || null]));
      return refuse(res, "challan_recorded_on_other_order",
        `Challan ${dnNo || "(unnumbered)"} is already recorded on another order. Recording it here would move those despatch lines. Nothing was recorded.`,
        extracted, candidatesFor(otherOrders, poById));
    }

    // ── Build the despatch rows ───────────────────────────────────────────────
    //
    // Header values repeat onto every row deliberately. dispatch_lines has no
    // header table (migration 193 is a flat per-line mirror), and the register
    // and the readiness check both read these off a line.
    const header = {
      delivery_note_no: dnNo,
      dispatch_date: dnDate,
      lr_number: clean(extracted.docket_no),
      carrier: clean(extracted.carrier),
      invoice_number: clean(extracted.invoice_no),
      invoice_date: clean(extracted.invoice_date),
    };

    const rows = lines.map((ln, i) => ({
      ...header,
      order_id: orderId,
      // One key per line of THIS challan, by position, so a re-upload of the
      // same challan updates the same rows and two lines never share a key
      // (a non-numeric line_ref with no part number used to collapse them).
      source_ref: `${identity}#${i}`,
      line_index: asOrdinal(ln?.line_ref),
      part_no: clean(ln?.partNumber ?? ln?.part_no),
      description: clean(ln?.description),
      // The despatched quantity, which is the number the whole kind exists for.
      dispatched_qty: ln?.quantity ?? ln?.qty ?? 0,
      uom: clean(ln?.uom),
      source_document_id: documentId,
      // Unknown keys are rescued into metadata by normalizeDispatchLine rather
      // than dropped, so the e-way bill reference and the vehicle survive as
      // evidence without this endpoint pretending to file anything.
      eway_bill_no: clean(extracted.eway_bill_no),
      vehicle_no: clean(extracted.vehicle_no),
      ordered_qty: ln?.ordered_qty ?? null,
      line_ref: clean(ln?.line_ref),
    }));

    const written = await upsertDispatchLines(svc, ctx.tenantId, rows, { orderId });
    const failed = Array.isArray(written.errors) && written.errors.length > 0;

    await recordAudit(ctx, {
      action: "delivery_note_ingest",
      objectType: "order",
      objectId: orderId,
      detail: `${written.inserted} inserted, ${written.updated} updated${failed ? `, ${written.errors.length} failed` : ""} from challan ${dnNo || "(unnumbered)"}; ${basis}`,
    });

    // A write that failed is not a recorded challan, whatever was counted.
    if (failed) {
      return json(res, 200, {
        ok: false, reason: "write_failed",
        detail: `${written.errors.length} of ${rows.length} despatch line${rows.length === 1 ? "" : "s"} could not be recorded: ${written.errors[0].message}`,
        order_id: orderId, written, candidates: [],
      });
    }

    return json(res, 200, {
      ok: true,
      order_id: orderId,
      matched_on: basis,
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
