// POST /api/orders/attach_sales_order
//   { document_id, extracted, order_id? }
//
// Attaches a sales order — the ERP's reply to a customer purchase order — to
// the Anvil order it answers, and says whether it can be compared.
//
// Mode A/B PR 3: the join. Unlike attach_quote, the caller does NOT supply the
// order. The document names it: the buyer's reference printed on its face is
// the customer's PO number, and orders.po_number holds the other side. Making
// somebody find and pick the order they have just uploaded a document ABOUT is
// exactly the manual step the product exists to remove.
//
// order_id is accepted as an OVERRIDE, for the two cases the match cannot
// decide on its own: several orders sharing a PO number, and a document whose
// reference did not read. An override is recorded as such — a human decision
// and an automatic one should never look the same afterwards.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { matchSalesOrderToOrders, comparability, poKey } from "../_lib/sales-order-match.js";

// Longer than any ERP voucher number. A longer value is a misread, not a
// number, and a cut-down one would print a number no document gave, so it is
// not written at all.
export const MAX_VOUCHER_LENGTH = 64;

// Extraction outcomes that are not a read of the document, as register.js
// treats them: a dedupe hit is a copy of an older run.
const NOT_A_READ = new Set(["dedupe_hit"]);

// A voucher number, trimmed, or "" when there is none or it is too long.
const voucherOf = (v) => {
  const s = typeof v === "string" || typeof v === "number" ? String(v).trim() : "";
  return s.length <= MAX_VOUCHER_LENGTH ? s : "";
};

// The voucher number this document read as, and what the read classified it
// as. The register shows the number from the document's own sales order
// read (register.js loadErp: newest first, a dedupe hit skipped, a run with
// no number skipped), so this takes it from the same rows and the PDF and the
// register cannot disagree. The request body is used only when the document
// has no read at all.
const readVoucher = async (svc, tenantId, documentId, extracted) => {
  const runs = await svc.from("extraction_runs")
    .select("voucher_no:normalized_extract->>voucher_no, classification:normalized_extract->>classification, finished_at, status_reason")
    .eq("tenant_id", tenantId).eq("extraction_kind", "sales_order").eq("source_id", documentId)
    .order("finished_at", { ascending: false, nullsFirst: false });
  if (runs.error) throw new Error("extraction_runs: " + runs.error.message);
  const reads = (runs.data || []).filter((r) => !NOT_A_READ.has(r.status_reason));
  if (!reads.length) {
    return { voucher_no: extracted?.voucher_no ?? null, classification: extracted?.classification || null, source: "request" };
  }
  const hit = reads.find((r) => r.voucher_no);
  return { voucher_no: hit?.voucher_no ?? null, classification: hit?.classification || null, source: "read" };
};

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
    const documentId = body?.document_id;
    const extracted = body?.extracted || null;
    if (!documentId) {
      return json(res, 400, { error: { message: "document_id is required" } });
    }

    const svc = serviceClient();
    const docQ = await svc.from("documents")
      .select("id, filename")
      .eq("tenant_id", ctx.tenantId).eq("id", documentId).maybeSingle();
    if (docQ.error) throw new Error("documents read: " + docQ.error.message);
    if (!docQ.data) return json(res, 404, { error: { message: "Document not found" } });

    // What this document will support, decided before anything is stored. A
    // sales order with no readable lines can still be attached — somebody
    // uploaded it for a reason — but it cannot be compared, and saying so now
    // is the difference between a visible gap and a silent one.
    const compare = comparability(extracted);

    let order = null;
    let match = null;
    let via = null;

    if (body?.order_id) {
      // The override path. Still verified against the tenant: an order id from
      // a request body is not proof the caller may attach to it.
      const o = await svc.from("orders")
        .select("id, po_number, status, created_at, so_voucher_no")
        .eq("tenant_id", ctx.tenantId).eq("id", body.order_id).maybeSingle();
      if (o.error) throw new Error("orders read: " + o.error.message);
      if (!o.data) return json(res, 404, { error: { message: "Order not found" } });
      order = o.data;
      via = "explicit";
      // Say when a person overrode a reference that pointed elsewhere. Not an
      // error — they may well be right, and an amended PO number is ordinary —
      // but it is a fact the comparison should carry rather than lose.
      const ref = poKey(extracted?.buyer_ref_order_no);
      match = {
        matched: true,
        reference: extracted?.buyer_ref_order_no ?? null,
        overrode_reference: !!(ref && poKey(order.po_number) !== ref),
      };
    } else {
      const ref = poKey(extracted?.buyer_ref_order_no);
      // Scoped to the reference rather than scanning the tenant's orders. The
      // matcher is pure and would happily filter a hundred thousand rows in
      // memory; the database should not have to send them.
      const candQ = ref
        ? await svc.from("orders")
          .select("id, po_number, status, created_at, so_voucher_no")
          .eq("tenant_id", ctx.tenantId).ilike("po_number", extracted.buyer_ref_order_no.trim())
        : { data: [] };
      if (candQ.error) throw new Error("orders read: " + candQ.error.message);
      match = matchSalesOrderToOrders(extracted, candQ.data || []);
      if (!match.matched) {
        // Reported, not thrown. The caller is told exactly which of the three
        // things went wrong, and ambiguity comes back with the candidates so
        // the next call can name one instead of guessing.
        return json(res, 200, {
          attached: false,
          match,
          comparable: compare.comparable,
          comparability: compare,
          document: { id: documentId, filename: docQ.data.filename },
        });
      }
      order = match.order;
      via = "buyer_reference";
    }

    // Read before anything is stored, so a failed read stores nothing.
    const read = await readVoucher(svc, ctx.tenantId, documentId, extracted);

    const link = await svc.from("order_documents")
      .upsert({ order_id: order.id, document_id: documentId, role: "sales_order" },
        { onConflict: "order_id,document_id" });
    if (link.error) {
      // 42703 is the wrong code here — a CHECK rejection is 23514. Migration
      // 222 adds 'sales_order' to order_documents.role, and without it every
      // attach fails on a constraint whose message names neither the column
      // nor the migration.
      if (link.error.code === "23514" || /order_documents_role_check|role/.test(link.error.message || "")) {
        return json(res, 503, {
          error: {
            code: "sales_order_role_not_permitted",
            message: "This database has not had migration 222 applied, so a document cannot be linked with role 'sales_order'.",
          },
        });
      }
      throw new Error("order_documents: " + link.error.message);
    }

    // The ERP's own number for this sales order, onto the order it answers, so
    // the SO PDF prints it (orders.so_voucher_no, migration 162). The register
    // already showed this number from the read; nothing wrote it to the order,
    // so the PDF's Voucher No. was always blank. Written only when the read
    // found one: a number that did not read leaves the order's number alone,
    // and a document read as something other than a sales order has none.
    //
    // Not written when the document names a different PO: the number may be
    // another order's, and the PDF goes to the customer. A re-issued sales
    // order replaces the number, and the response and the audit say which
    // number it replaced.
    const voucherNo = read.classification && read.classification !== "sales_order" ? "" : voucherOf(read.voucher_no);
    const previous = voucherOf(order.so_voucher_no) || null;
    const voucher = { number: voucherNo || null, previous, written: false, replaced: false, skipped: null, error: null };
    if (voucherNo && match.overrode_reference) {
      voucher.skipped = "reference_overridden";
    } else if (voucherNo && voucherNo !== previous) {
      const up = await svc.from("orders").update({ so_voucher_no: voucherNo })
        .eq("tenant_id", ctx.tenantId).eq("id", order.id);
      if (up.error) {
        // The document is linked by now, so the attach did happen. Say that
        // only the number failed, rather than "could not attach"; attaching
        // again retries it.
        voucher.error = up.error.message || "update failed";
        console.error("[orders/attach_sales_order] so_voucher_no: " + voucher.error);
      } else {
        voucher.written = true;
        voucher.replaced = !!previous;
      }
    }

    await recordAudit(ctx, {
      action: "order_sales_order_attached", objectType: "order", objectId: order.id,
      detail: {
        document_id: documentId,
        matched_via: via,
        reference: match.reference ?? null,
        overrode_reference: !!match.overrode_reference,
        comparable: compare.comparable,
        so_voucher_no: voucherNo || null,
        so_voucher_source: voucherNo ? read.source : null,
        previous_so_voucher_no: previous,
        so_voucher_written: voucher.written,
        so_voucher_skipped: voucher.skipped,
        so_voucher_error: voucher.error,
      },
    });

    return json(res, 200, {
      attached: true,
      matched_via: via,
      order: { id: order.id, po_number: order.po_number },
      match,
      comparable: compare.comparable,
      comparability: compare,
      document: { id: documentId, filename: docQ.data.filename },
      voucher,
      // The comparison itself is PR 4. Saying so beats returning a shape that
      // looks like it should contain a verdict and never does.
      compared: false,
    });
  } catch (err) { sendError(res, err); }
}
