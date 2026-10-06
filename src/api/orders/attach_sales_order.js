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
        .select("id, po_number, status, created_at")
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
          .select("id, po_number, status, created_at")
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

    await recordAudit(ctx, {
      action: "order_sales_order_attached", objectType: "order", objectId: order.id,
      detail: {
        document_id: documentId,
        matched_via: via,
        reference: match.reference ?? null,
        overrode_reference: !!match.overrode_reference,
        comparable: compare.comparable,
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
      // The comparison itself is PR 4. Saying so beats returning a shape that
      // looks like it should contain a verdict and never does.
      compared: false,
    });
  } catch (err) { sendError(res, err); }
}
