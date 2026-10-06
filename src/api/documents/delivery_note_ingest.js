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

// ── Matching helpers ──────────────────────────────────────────────────────────
//
// References are matched EXACTLY (case-insensitive, trimmed), never by
// substring. A substring read capped at N rows silently drops the real match
// once N other rows contain it, and a dropped match is how a wrong-order
// challan used to be accepted as "not on file".
const READ_LIMIT = 200;

// An exact ILIKE pattern: % and _ escaped; PostgREST also reads * as %, and a
// literal * cannot be escaped, so it becomes the single-character wildcard _.
// Every read is post-filtered with an exact comparison, so a wildcard can only
// widen the read, never change the answer.
const exactPattern = (v) => String(v).replace(/[\\%_]/g, (c) => "\\" + c).replace(/\*/g, "_");

// "PO 4500313249", "4500313249 dt 12.09.26" and "4500313249" are one PO when
// their digit runs agree and are long enough to be an order number.
const digitsKey = (v) => {
  const d = String(v == null ? "" : v).replace(/\D+/g, "");
  return d.length >= 6 ? d : "";
};
const sameRef = (a, b) => {
  if (!a || !b) return false;
  if (poKey(a) === poKey(b)) return true;
  const da = digitsKey(a);
  return !!da && da === digitsKey(b);
};

const readExact = async (svc, table, cols, tenantId, column, values) => {
  const hits = [];
  for (const v of [...new Set(values.filter(Boolean))]) {
    const q = await svc.from(table).select(cols)
      .eq("tenant_id", tenantId).ilike(column, exactPattern(v)).limit(READ_LIMIT);
    if (q.error) throw new Error(`${table} read: ${q.error.message}`);
    const rows = q.data || [];
    // A full page means the answer may be incomplete: refuse to decide.
    if (rows.length >= READ_LIMIT) {
      const err = new Error(`Too many ${table} rows match "${v}" to decide which order this challan belongs to.`);
      err.status = 409;
      throw err;
    }
    hits.push(...rows);
  }
  return hits;
};

// What the challan's OWN references point at. GST invoices live in
// einvoices as well as invoices (see _lib/dispatch-register-send.js), so both
// are read. A failed read throws: an invoice check that quietly skips is how
// a wrong-order challan gets accepted.
const readChallanReferences = async (svc, tenantId, extracted) => {
  const po = clean(extracted.buyer_po_no);
  const inv = clean(extracted.invoice_no);

  let poHits = [];
  if (po) {
    const rows = await readExact(svc, "orders", "id, po_number, customer_id", tenantId, "po_number",
      [po.trim(), digitsKey(po)]);
    const seen = new Set();
    poHits = rows.filter((o) => sameRef(o.po_number, po) && !seen.has(o.id) && seen.add(o.id));
  }

  let invoiceHits = [];
  if (inv) {
    const a = await readExact(svc, "invoices", "id, order_id, invoice_number", tenantId, "invoice_number", [inv.trim()]);
    const b = await readExact(svc, "einvoices", "id, order_id, invoice_number", tenantId, "invoice_number", [inv.trim()]);
    const want = poKey(inv);
    invoiceHits = [...a, ...b].filter((i) => poKey(i.invoice_number) === want && i.order_id);
  }

  const poById = new Map(poHits.map((o) => [o.id, o.po_number || null]));
  const missing = [...new Set(invoiceHits.map((i) => i.order_id))].filter((id) => !poById.has(id));
  if (missing.length) {
    const q = await svc.from("orders").select("id, po_number").eq("tenant_id", tenantId).in("id", missing);
    if (!q.error) for (const o of q.data || []) poById.set(o.id, o.po_number || null);
  }
  return { po, inv, poHits, invoiceHits, poById };
};

const candidatesFor = (ids, poById) =>
  [...new Set(ids)].filter(Boolean).map((id) => ({ id, po_number: poById.get(id) ?? null }));

const refuse = (res, reason, detail, extracted, candidates = [], extra = {}) => json(res, 200, {
  ok: false, reason, detail, candidates, ...extra,
  delivery_note_no: clean(extracted.delivery_note_no),
  buyer_po_no: clean(extracted.buyer_po_no),
  invoice_no: clean(extracted.invoice_no),
  written: { inserted: 0, updated: 0 },
});

// ── Dates ─────────────────────────────────────────────────────────────────────
//
// The extractor returns a challan date as printed. Indian documents print the
// day first ("01/10/2026" is 1 October), and a DATE column under Postgres's
// default MDY style would read it as 10 January, or reject "13/10/2026"
// outright. So dates are normalised here, and an unparseable one is null (the
// raw text is kept in metadata) rather than guessed.
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const ymd = (y, m, d) => {
  if (!(m >= 1 && m <= 12) || !(d >= 1)) return null;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > dim || y < 1990 || y > 2100) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};
export const challanDate = (v) => {
  const s = clean(v);
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
  if (m) return ymd(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})[\s\-/.]*([A-Za-z]{3,9})[\s\-/.,']*(\d{2}|\d{4})$/);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) {
    return ymd(m[3].length === 2 ? 2000 + +m[3] : +m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]);
  }
  return null;
};
// Indian financial year (April to March): Tally restarts voucher numbering
// at its start, so the same challan number in two financial years is two
// challans, and within one year it is one.
const financialYear = (iso) => {
  if (!iso) return null;
  const [y, mo] = iso.split("-").map(Number);
  return mo >= 4 ? y : y - 1;
};
const sameChallanDate = (a, b) => !a || !b || financialYear(a) === financialYear(b);

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
    // upload updates this challan or moves another order's rows.
    //   key   = the challan number, upper-cased with spaces removed, or the
    //           stored document when the challan has no number (uploads are
    //           de-duplicated by content hash, so the same file is the same
    //           document);
    //   date  = the challan date normalised to ISO, or "undated";
    //   row   = key@date#position.
    // The same key in the same financial year (or with either date unknown)
    // is the same challan, however its date was printed or read.
    const dnNo = clean(extracted.delivery_note_no);
    const documentId = clean(body.document_id);
    const challanKey = dnNo ? dnNo.toUpperCase().replace(/\s+/g, "") : (documentId ? `DOC:${documentId}` : null);
    if (!challanKey) {
      return refuse(res, "no_challan_identity",
        "The challan carries no number and no stored document, so a second upload could not be told apart from a new consignment. Nothing was recorded.",
        extracted);
    }
    const dnDateIso = challanDate(extracted.delivery_note_date);
    const prefix = `${challanKey}@`;
    const identity = `${prefix}${dnDateIso || "undated"}`;

    // ── Which order does this consignment belong to? ──────────────────────────
    const refs = await readChallanReferences(svc, ctx.tenantId, extracted);
    const poOrderIds = refs.poHits.map((o) => o.id);
    const invOrderIds = [...new Set(refs.invoiceHits.map((i) => i.order_id))];

    let orderId = null;
    // How the order was settled, for the audit row and the response.
    let basis = null;
    const explicitOrderId = clean(body.order_id);

    if (explicitOrderId) {
      // The operator chose the order. That choice is checked against what the
      // challan itself cites, not trusted.
      const ordQ = await svc.from("orders")
        .select("id, po_number")
        .eq("tenant_id", ctx.tenantId).eq("id", explicitOrderId).maybeSingle();
      if (ordQ.error) throw new Error("order read: " + ordQ.error.message);
      if (!ordQ.data) return json(res, 404, { error: { message: "order not found" } });
      const order = ordQ.data;

      const poHere = !!refs.po && sameRef(refs.po, order.po_number);
      const poOther = poOrderIds.filter((id) => id !== order.id);
      const invoiceHere = invOrderIds.includes(order.id);
      const invoiceOther = invOrderIds.filter((id) => id !== order.id);

      // Hard refusal: the challan's own references name another order.
      if ((refs.po && !poHere && poOther.length) || invoiceOther.length) {
        return refuse(res, "order_mismatch",
          invoiceOther.length
            ? `This challan cites invoice "${refs.inv}", which belongs to a different order. Nothing was recorded.`
            : `This challan cites PO "${refs.po}", which belongs to a different order${order.po_number ? ` (the chosen order is for PO "${order.po_number}")` : ""}. Nothing was recorded.`,
          extracted, candidatesFor([...poOther, ...invoiceOther], refs.poById));
      }
      // Soft refusal: the challan's PO is on no order at all and differs from
      // this order's PO. It may be a typo, a format the matcher does not know,
      // or a genuinely different PO, so the operator decides.
      const poUnrecognised = !!refs.po && !poHere && !!order.po_number && !poOrderIds.length;
      if (poUnrecognised && body.confirm_po_mismatch !== true) {
        return refuse(res, "po_differs",
          `This challan cites PO "${refs.po}", which is on no order, and the chosen order is for PO "${order.po_number}". Record it on this order only if you are sure it belongs here.`,
          extracted, [], { overridable: true });
      }

      orderId = order.id;
      // Say exactly what was checked, never more.
      const checked = [];
      if (poHere) checked.push(poOther.length ? `PO number matches (also on ${poOther.length} other order${poOther.length === 1 ? "" : "s"})` : "PO number matches");
      if (invoiceHere) checked.push("invoice number matches");
      if (poUnrecognised) checked.push(`operator confirmed despite the challan's PO "${refs.po}" differing from the order's`);
      else if (refs.po && !poHere) checked.push("the challan's PO is on no order and the order has no PO number to compare");
      if (refs.inv && !invoiceHere && !invoiceOther.length) checked.push("the challan's invoice number is not on file");
      basis = "order chosen by operator; " + (checked.length ? checked.join("; ") : "challan carries no checkable reference");
    } else {
      // No order named: the challan's references must resolve to exactly one
      // order, and must not point two ways.
      const poUnique = poOrderIds.length === 1 ? poOrderIds[0] : null;
      const invUnique = invOrderIds.length === 1 ? invOrderIds[0] : null;
      if (poUnique && invUnique && poUnique !== invUnique) {
        return refuse(res, "conflicting_references",
          `This challan's PO "${refs.po}" and invoice "${refs.inv}" belong to different orders, so which order it belongs to has no answer. Nothing was recorded.`,
          extracted, candidatesFor([poUnique, invUnique], refs.poById));
      }
      if (poUnique) {
        orderId = poUnique; basis = "matched_on_buyer_po_number";
      } else if (poOrderIds.length > 1) {
        return refuse(res, "several_orders_with_that_reference",
          `${poOrderIds.length} orders carry the purchase-order number "${refs.po}". Open the right order and upload the challan there.`,
          extracted, candidatesFor(poOrderIds, refs.poById));
      } else if (invUnique) {
        // Second tier: the invoice this consignment is billed on.
        orderId = invUnique; basis = "matched_on_invoice_number";
      } else if (invOrderIds.length > 1) {
        return refuse(res, "ambiguous_invoice_number",
          `${invOrderIds.length} orders have an invoice numbered "${refs.inv}", so which order this consignment belongs to has no answer.`,
          extracted, candidatesFor(invOrderIds, refs.poById));
      } else {
        return refuse(res, "unresolved_order",
          refs.po || refs.inv
            ? "No order carries this challan's PO or invoice number. Open the order and upload the challan there."
            : "The challan carries no PO or invoice number. Open the order and upload the challan there.",
          extracted);
      }
    }

    // ── Is this challan already recorded, here or elsewhere? ──────────────────
    const priorQ = await svc.from("dispatch_lines")
      .select("id, order_id, source_ref")
      .eq("tenant_id", ctx.tenantId)
      .like("source_ref", exactPattern(prefix) + "%")
      .limit(1000);
    if (priorQ.error) throw new Error("dispatch_lines read: " + priorQ.error.message);
    const priorRows = (priorQ.data || []).filter((r) => typeof r.source_ref === "string" && r.source_ref.startsWith(prefix));
    const rowDate = (r) => {
      const d = r.source_ref.slice(prefix.length).split("#")[0];
      return d === "undated" ? null : d;
    };
    const sameChallan = priorRows.filter((r) => sameChallanDate(rowDate(r), dnDateIso));
    // A row with no order counts as "elsewhere": adopting it would be a guess.
    const elsewhere = [...new Set(sameChallan.filter((r) => r.order_id !== orderId).map((r) => r.order_id || null))];
    if (elsewhere.length) {
      const ids = elsewhere.filter(Boolean);
      const pq = ids.length
        ? await svc.from("orders").select("id, po_number").eq("tenant_id", ctx.tenantId).in("id", ids)
        : { data: [] };
      const poById = new Map((pq.data || []).map((o) => [o.id, o.po_number || null]));
      return refuse(res, "challan_recorded_on_other_order",
        `Challan ${dnNo || "(unnumbered)"} is already recorded on another order. Recording it here would move those despatch lines. Nothing was recorded.`,
        extracted, candidatesFor(ids, poById));
    }

    // ── Build the despatch rows ───────────────────────────────────────────────
    //
    // Header values repeat onto every row deliberately. dispatch_lines has no
    // header table (migration 193 is a flat per-line mirror), and the register
    // and the readiness check both read these off a line.
    const header = {
      delivery_note_no: dnNo,
      dispatch_date: dnDateIso,
      lr_number: clean(extracted.docket_no),
      carrier: clean(extracted.carrier),
      invoice_number: clean(extracted.invoice_no),
      invoice_date: challanDate(extracted.invoice_date),
    };

    const rows = lines.map((ln, i) => ({
      ...header,
      order_id: orderId,
      // One key per line of THIS challan, by position.
      source_ref: `${identity}#${i}`,
      line_index: asOrdinal(ln?.line_ref),
      part_no: clean(ln?.partNumber ?? ln?.part_no),
      description: clean(ln?.description),
      // The despatched quantity, which is the number the whole kind exists for.
      dispatched_qty: ln?.quantity ?? ln?.qty ?? 0,
      uom: clean(ln?.uom),
      source_document_id: documentId,
      // Unknown keys are rescued into metadata by normalizeDispatchLine rather
      // than dropped, so the e-way bill reference, the vehicle and the dates
      // as printed survive as evidence without this endpoint filing anything.
      eway_bill_no: clean(extracted.eway_bill_no),
      vehicle_no: clean(extracted.vehicle_no),
      delivery_note_date_raw: clean(extracted.delivery_note_date),
      invoice_date_raw: clean(extracted.invoice_date),
      ordered_qty: ln?.ordered_qty ?? null,
      line_ref: clean(ln?.line_ref),
    }));

    const written = await upsertDispatchLines(svc, ctx.tenantId, rows, { orderId });
    const failed = Array.isArray(written.errors) && written.errors.length > 0;

    // A re-upload REPLACES this challan on this order: rows of the same
    // challan that this read did not produce (fewer lines than before, or the
    // date printed or read differently) are removed, so despatch is never
    // counted twice. Only after a clean write, and only this challan's rows
    // on this order.
    let removed = 0;
    if (!failed) {
      const keep = new Set(rows.map((r) => r.source_ref));
      const stale = sameChallan.filter((r) => r.order_id === orderId && !keep.has(r.source_ref)).map((r) => r.id);
      if (stale.length) {
        const del = await svc.from("dispatch_lines").delete()
          .eq("tenant_id", ctx.tenantId).eq("order_id", orderId).in("id", stale);
        if (del.error) throw new Error("dispatch_lines cleanup: " + del.error.message);
        removed = stale.length;
      }
    }

    await recordAudit(ctx, {
      action: "delivery_note_ingest",
      objectType: "order",
      objectId: orderId,
      detail: `${written.inserted} inserted, ${written.updated} updated${removed ? `, ${removed} superseded removed` : ""}${failed ? `, ${written.errors.length} failed` : ""} from challan ${dnNo || "(unnumbered)"}; ${basis}`,
    });

    // A write that failed is not a recorded challan, whatever was counted. The
    // lines that did land are reported, so the screen can refresh the check.
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
      written: { ...written, removed },
      // Said out loud: the docket is now on record and the e-way bill number is
      // evidence only. Nothing here filed a bill.
      note: "Despatch lines recorded. The e-way bill number is stored as evidence; filing remains a separate act.",
    });
  } catch (err) { sendError(res, err); }
}
