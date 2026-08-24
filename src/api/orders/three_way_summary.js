// GET /api/orders/three_way_summary?limit=N
//
// The running score across orders — the number the Mode A / Mode B decision
// actually turns on.
//
// The per-order panel answers "did this one go right". This answers "across
// our own orders, how often is Anvil wrong, and how often is the process we
// have today already wrong". A customer deciding whether to hand over
// sales-order processing needs the second question, and a vendor's accuracy
// figure is a claim about a benchmark rather than about their POs.
//
// Bulk-fetched, not a loop of per-order requests. The report is pure, so every
// order's data is gathered in a handful of queries and the comparisons run in
// memory — a round trip per order would make this the slowest screen in the
// app and would scale with the very thing it is measuring.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { buildThreeWayReport } from "../_lib/three-way-report.js";
import { summariseReports, confidence } from "../_lib/three-way-summary.js";

const MAX_ORDERS = 100;

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const limit = Math.min(MAX_ORDERS, Math.max(1, Number(req.query?.limit) || 50));
    const svc = serviceClient();

    // Orders that have a sales order attached at all. Everything else is
    // outside the question — an order nobody uploaded an ERP document for
    // cannot be compared, and counting it as agreement would be a lie.
    const linkQ = await svc.from("order_documents")
      .select("order_id, document_id").eq("role", "sales_order");
    if (linkQ.error) throw new Error("order_documents: " + linkQ.error.message);
    const links = linkQ.data || [];
    if (!links.length) {
      return json(res, 200, {
        available: false,
        reason: "no_sales_orders_attached",
        detail: "No sales order has been attached to any order yet, so there is nothing to compare.",
      });
    }

    const orderIds = [...new Set(links.map((l) => l.order_id))];
    const ordersQ = await svc.from("orders")
      .select("id, customer_id, po_number, result, payment_terms, created_at")
      .eq("tenant_id", ctx.tenantId).in("id", orderIds.slice(0, MAX_ORDERS))
      .order("created_at", { ascending: false }).limit(limit);
    if (ordersQ.error) throw new Error("orders: " + ordersQ.error.message);
    const orders = ordersQ.data || [];
    if (!orders.length) {
      return json(res, 200, { available: false, reason: "no_orders", detail: "No orders in this tenant carry an attached sales order." });
    }

    // The ERP extracts, in one query for the whole set.
    const docIds = links.filter((l) => orders.some((o) => o.id === l.order_id)).map((l) => l.document_id);
    const runsQ = await svc.from("extraction_runs")
      .select("source_id, normalized_extract, finished_at, status_reason")
      .eq("tenant_id", ctx.tenantId).eq("extraction_kind", "sales_order")
      .in("source_id", docIds.slice(0, 500))
      .order("finished_at", { ascending: false, nullsFirst: false });
    if (runsQ.error) throw new Error("extraction_runs: " + runsQ.error.message);
    const extractByDoc = new Map();
    for (const r of runsQ.data || []) {
      // Newest usable wins; dedupe_hit skipped for the reason it always is —
      // a content-hash match mints a fresh run that sorts first while carrying
      // a copy of an older read.
      if (r.status_reason === "dedupe_hit" || !r.normalized_extract) continue;
      if (!extractByDoc.has(r.source_id)) extractByDoc.set(r.source_id, r.normalized_extract);
    }

    // One dual-code map per customer, for the whole set rather than per order.
    const customerIds = [...new Set(orders.map((o) => o.customer_id).filter(Boolean))];
    const mapByCustomer = new Map();
    if (customerIds.length) {
      try {
        const icp = await svc.from("item_customer_parts")
          .select("customer_id, item_id, customer_part_number")
          .eq("tenant_id", ctx.tenantId).in("customer_id", customerIds.slice(0, 200)).is("valid_to", null);
        const ids = [...new Set((icp.data || []).map((r) => r.item_id).filter(Boolean))];
        const byId = new Map();
        for (let i = 0; i < ids.length; i += 100) {
          const im = await svc.from("item_master").select("id, part_no")
            .eq("tenant_id", ctx.tenantId).in("id", ids.slice(i, i + 100));
          if (im.error) break;
          for (const r of im.data || []) byId.set(r.id, r.part_no);
        }
        for (const r of icp.data || []) {
          const ours = byId.get(r.item_id);
          if (!r.customer_part_number || !ours) continue;
          if (!mapByCustomer.has(r.customer_id)) mapByCustomer.set(r.customer_id, new Map());
          mapByCustomer.get(r.customer_id).set(r.customer_part_number, ours);
        }
      } catch (_e) {
        // Best-effort: without it our part number adjudicates as undecidable
        // and is excluded from both rates, rather than resolving in anybody's
        // favour.
      }
    }

    const docByOrder = new Map();
    for (const l of links) if (!docByOrder.has(l.order_id)) docByOrder.set(l.order_id, l.document_id);

    const perOrder = [];
    const skipped = [];
    for (const o of orders) {
      const erp = extractByDoc.get(docByOrder.get(o.id));
      if (!erp) {
        // Attached but never successfully extracted. Counted and named, not
        // dropped: an order silently missing from a denominator is how a score
        // flatters itself.
        skipped.push({ order_id: o.id, po_number: o.po_number, reason: "sales_order_not_extracted" });
        continue;
      }
      const so = o.result?.salesOrder || {};
      perOrder.push({
        order_id: o.id,
        po_number: o.po_number,
        report: buildThreeWayReport({
          anvilLines: Array.isArray(so.lineItems) ? so.lineItems : [],
          erpLines: Array.isArray(erp.lines) ? erp.lines : [],
          poTerms: so.customer?.payment_terms || so.payment_terms || o.payment_terms || null,
          anvilTerms: so.payment_terms || o.payment_terms || null,
          erpTerms: erp.payment_terms || null,
          customerPartMap: mapByCustomer.get(o.customer_id) || null,
        }),
      });
    }

    const summary = summariseReports(perOrder);
    return json(res, 200, {
      available: true,
      limit,
      // Named so a thin score can be read as thin rather than as a verdict.
      confidence: confidence(summary),
      skipped,
      ...summary,
    });
  } catch (err) { sendError(res, err); }
}
