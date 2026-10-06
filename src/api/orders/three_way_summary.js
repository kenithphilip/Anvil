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
import { partKey } from "../_lib/plm-impact.js";

const MAX_ORDERS = 100;

// How many recent tenant orders to consider as candidates. order_documents has
// no tenant_id (its RLS is enforced transitively via orders), so we scope the
// whole comparison THROUGH the tenant's own orders rather than scanning that
// table across every tenant. Generous, so the `limit` most-recent ATTACHED
// orders are still found when some recent orders carry no sales order. A tenant
// with more than this many recent orders whose attached ones are all older than
// the window would under-count — acceptable: the score is about recent orders.
const CANDIDATE_POOL = 500;
const MAX_DOC_LOOKUP = 1000;

// Extraction outcomes that are NOT a usable ERP read. An empty_lines / parse
// failure still writes a normalized_extract (with no lines), so without this a
// newer failed re-run would shadow an older good read of the same document and
// make every Anvil line look "missing from ERP".
const UNUSABLE_EXTRACT_STATUS = new Set([
  "dedupe_hit", "empty_lines", "parse_failed", "model_refused",
  "upstream_error", "fail_unknown",
]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const limit = Math.min(MAX_ORDERS, Math.max(1, Number(req.query?.limit) || 50));
    const svc = serviceClient();

    // 1. This tenant's recent order ids (cheap — no result blob yet). We scope
    //    the whole comparison through orders because order_documents carries no
    //    tenant_id: scanning it unscoped on the service client returned every
    //    tenant's attachments, and slicing that cross-tenant id list let a busy
    //    tenant crowd this tenant's orders out of the window — under-reporting
    //    or emptying the very score the mode decision turns on.
    const candQ = await svc.from("orders")
      .select("id, created_at")
      .eq("tenant_id", ctx.tenantId)
      .order("created_at", { ascending: false })
      .limit(CANDIDATE_POOL);
    if (candQ.error) throw new Error("orders: " + candQ.error.message);
    const candidates = candQ.data || [];
    if (!candidates.length) {
      return json(res, 200, { available: false, reason: "no_orders", detail: "No orders in this tenant yet, so there is nothing to compare." });
    }

    // 2. Sales-order attachments for THOSE orders only — tenant-scoped
    //    transitively and bounded by the candidate ids. Every doc per order,
    //    not just the first: an order can carry more than one sales-order
    //    upload (a corrected re-issue) and we want whichever one extracted.
    const candidateIds = candidates.map((o) => o.id);
    const linkQ = await svc.from("order_documents")
      .select("order_id, document_id")
      .eq("role", "sales_order")
      .in("order_id", candidateIds);
    if (linkQ.error) throw new Error("order_documents: " + linkQ.error.message);
    const links = linkQ.data || [];
    const docsByOrder = new Map();
    for (const l of links) {
      if (!docsByOrder.has(l.order_id)) docsByOrder.set(l.order_id, []);
      docsByOrder.get(l.order_id).push(l.document_id);
    }
    // The tenant's attached orders, newest first (candidates is already
    // ordered), capped at `limit`.
    const attachedIds = candidateIds.filter((id) => docsByOrder.has(id)).slice(0, limit);
    if (!attachedIds.length) {
      return json(res, 200, {
        available: false,
        reason: "no_sales_orders_attached",
        detail: "No sales order has been attached to any order yet, so there is nothing to compare.",
      });
    }

    // Full rows for just the attached orders we will report on.
    const ordersQ = await svc.from("orders")
      .select("id, customer_id, po_number, result, payment_terms, created_at")
      .eq("tenant_id", ctx.tenantId).in("id", attachedIds);
    if (ordersQ.error) throw new Error("orders (full): " + ordersQ.error.message);
    const rowById = new Map((ordersQ.data || []).map((o) => [o.id, o]));
    const orders = attachedIds.map((id) => rowById.get(id)).filter(Boolean);

    // 3. The ERP extracts for those orders' documents, one query for the set,
    //    newest-first so the first USABLE run per document wins.
    const docIds = [...new Set(orders.flatMap((o) => docsByOrder.get(o.id) || []))].slice(0, MAX_DOC_LOOKUP);
    const runsQ = await svc.from("extraction_runs")
      .select("source_id, normalized_extract, finished_at, status_reason")
      .eq("tenant_id", ctx.tenantId).eq("extraction_kind", "sales_order")
      .in("source_id", docIds)
      .order("finished_at", { ascending: false, nullsFirst: false });
    if (runsQ.error) throw new Error("extraction_runs: " + runsQ.error.message);
    const extractByDoc = new Map();
    for (const r of runsQ.data || []) {
      if (UNUSABLE_EXTRACT_STATUS.has(r.status_reason)) continue;
      const lines = r.normalized_extract?.lines;
      if (!Array.isArray(lines) || lines.length === 0) continue;
      if (!extractByDoc.has(r.source_id)) {
        extractByDoc.set(r.source_id, { extract: r.normalized_extract, finishedAt: r.finished_at || "" });
      }
    }

    // 4. One dual-code map per customer, for the whole set. KEY IT WITH partKey:
    //    the report looks the buyer code up normalised (trim + upper-case), so a
    //    raw key silently misses and the flagship "our part number" field drops
    //    out of the score as undecidable — indistinguishable from "no map".
    const customerIds = [...new Set(orders.map((o) => o.customer_id).filter(Boolean))];
    const mapByCustomer = new Map();
    if (customerIds.length) {
      try {
        const icp = await svc.from("item_customer_parts")
          .select("customer_id, item_id, customer_part_number")
          .eq("tenant_id", ctx.tenantId).in("customer_id", customerIds).is("valid_to", null);
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
          const key = partKey(r.customer_part_number);
          if (!key || !ours) continue;
          if (!mapByCustomer.has(r.customer_id)) mapByCustomer.set(r.customer_id, new Map());
          mapByCustomer.get(r.customer_id).set(key, ours);
        }
      } catch (_e) {
        // Best-effort: without it our part number adjudicates as undecidable
        // and is excluded from both rates, rather than resolving in anybody's
        // favour.
      }
    }

    // 5. Build one report per order, choosing the attached document whose usable
    //    extract is newest. An order whose docs never produced a usable extract
    //    is counted and named in `skipped`, not silently dropped — an order
    //    missing from a denominator is how a score flatters itself.
    const perOrder = [];
    const skipped = [];
    for (const o of orders) {
      let best = null;
      for (const docId of docsByOrder.get(o.id) || []) {
        const e = extractByDoc.get(docId);
        if (e && (!best || e.finishedAt > best.finishedAt)) best = e;
      }
      if (!best) {
        skipped.push({ order_id: o.id, po_number: o.po_number, reason: "sales_order_not_extracted" });
        continue;
      }
      const erp = best.extract;
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
