// GET /api/orders/three_way_report?orderId=<id>
//
// The PO, Anvil and the ERP, side by side, for one order.
//
// Mode A/B PR 4. Reads only — it computes nothing durable, because the useful
// artefact here is the comparison at the moment somebody asks for it, and
// storing a verdict would mean deciding when to invalidate it against three
// documents that can each change.
//
// The three sides:
//   PO     what the customer asked for. Preserved by the reconciler on each
//          line as _match.po_qty / _match.po_rate.
//   Anvil  what Anvil would put on the sales order — the reconciled line.
//   ERP    what a person actually recorded, from the attached sales_order
//          document's extraction run.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { buildThreeWayReport } from "../_lib/three-way-report.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const orderId = req.query?.orderId || req.query?.order_id;
    if (!orderId) return json(res, 400, { error: { message: "orderId required" } });
    const svc = serviceClient();

    const orderQ = await svc.from("orders")
      .select("id, customer_id, po_number, result, payment_terms")
      .eq("tenant_id", ctx.tenantId).eq("id", orderId).maybeSingle();
    if (orderQ.error) throw new Error("orders read: " + orderQ.error.message);
    if (!orderQ.data) return json(res, 404, { error: { message: "Order not found" } });
    const order = orderQ.data;

    // The ERP's side. Attached by PR 3 with role='sales_order'.
    const linkQ = await svc.from("order_documents")
      .select("document_id").eq("order_id", orderId).eq("role", "sales_order");
    if (linkQ.error) throw new Error("order_documents: " + linkQ.error.message);
    const docIds = (linkQ.data || []).map((r) => r.document_id).filter(Boolean);
    if (!docIds.length) {
      // Not an error, and worth distinguishing from "compared, no differences".
      // Those look identical in any summary that only reports a score.
      return json(res, 200, {
        order_id: orderId,
        available: false,
        reason: "no_sales_order_attached",
        detail: "No sales order has been attached to this order, so there is nothing to compare against.",
      });
    }

    // Newest first: a re-issued sales order supersedes the one before it.
    const runQ = await svc.from("extraction_runs")
      .select("id, normalized_extract, finished_at, status_reason, source_id")
      .eq("tenant_id", ctx.tenantId).eq("extraction_kind", "sales_order")
      .in("source_id", docIds)
      .order("finished_at", { ascending: false, nullsFirst: false })
      .limit(5);
    if (runQ.error) throw new Error("extraction_runs: " + runQ.error.message);
    // Skip dedupe_hit for the reason the quote viewer does: a content-hash
    // match mints a fresh run with a new finished_at, so it sorts first while
    // carrying a copy of an older read.
    const run = (runQ.data || []).find((r) => r.status_reason !== "dedupe_hit" && r.normalized_extract);
    if (!run) {
      return json(res, 200, {
        order_id: orderId,
        available: false,
        reason: "sales_order_not_extracted",
        detail: "A sales order is attached but no extraction of it could be read.",
      });
    }
    const erp = run.normalized_extract || {};

    // The dual-code map, so our own part number can be adjudicated against
    // item_master rather than against the PO — which never states it.
    // valid_to IS NULL: superseded mappings stay in the table, and reading one
    // would judge today's line against a part the code used to mean.
    const customerPartMap = new Map();
    if (order.customer_id) {
      try {
        const icp = await svc.from("item_customer_parts")
          .select("item_id, customer_part_number")
          .eq("tenant_id", ctx.tenantId).eq("customer_id", order.customer_id).is("valid_to", null);
        const ids = [...new Set((icp.data || []).map((r) => r.item_id).filter(Boolean))];
        if (!icp.error && ids.length) {
          const byId = new Map();
          for (let i = 0; i < ids.length; i += 100) {
            const im = await svc.from("item_master").select("id, part_no")
              .eq("tenant_id", ctx.tenantId).in("id", ids.slice(i, i + 100));
            if (im.error) break;
            for (const r of im.data || []) byId.set(r.id, r.part_no);
          }
          for (const r of icp.data || []) {
            const ours = byId.get(r.item_id);
            if (r.customer_part_number && ours) customerPartMap.set(r.customer_part_number, ours);
          }
        }
      } catch (_e) {
        // Best-effort. Without it our part number adjudicates as undecidable —
        // excluded from both rates — rather than resolving in anyone's favour.
      }
    }

    const so = order.result?.salesOrder || {};
    const report = buildThreeWayReport({
      anvilLines: Array.isArray(so.lineItems) ? so.lineItems : [],
      erpLines: Array.isArray(erp.lines) ? erp.lines : [],
      poTerms: so.customer?.payment_terms || so.payment_terms || order.payment_terms || null,
      anvilTerms: so.payment_terms || order.payment_terms || null,
      erpTerms: erp.payment_terms || null,
      customerPartMap,
    });

    return json(res, 200, {
      order_id: orderId,
      available: true,
      po_number: order.po_number,
      erp_document: { run_id: run.id, voucher_no: erp.voucher_no ?? null, buyer_ref: erp.buyer_ref_order_no ?? null },
      ...report,
    });
  } catch (err) { sendError(res, err); }
}
