// /api/admin/item_usage
//   GET ?item_id=<uuid>
//
// Read-only "where is this item used" lookup for the Item Master
// drawer (backlog #15). Returns the orders/drafts whose line items
// reference the given item_master row, with per-order date, status,
// customer, and the matched quantity.
//
// Data model note: order line items live in orders.result.salesOrder
// .lineItems (JSONB). At order-create the intake POST runs
// mapLinesToItemMaster (src/api/_lib/item-mapper.js), which stamps a
// `_mapped_item` block carrying the canonical item_master id onto each
// resolved line. So the authoritative match is line._mapped_item.id ===
// item_id. For older orders (or lines that didn't map an id) we fall
// back to matching the line's own part-number candidates against the
// item's part_no / alias / specification_code -- the same identifiers
// the mapper resolves on. This is a bounded read scan (most-recent N
// orders), not a normalised junction table; that keeps it migration-
// free and zero write-path risk, at the cost of being capped to the
// LOOKBACK_LIMIT most recent orders.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { norm, lineCandidates } from "../_lib/item-mapper.js";

// Cap the reverse scan. A single industrial tenant lands O(100s) of
// orders; 1000 keeps the JSONB scan well within the function budget
// while covering the full realistic history. Surfaced to the client
// via `scanned` so the UI can note when it hit the ceiling.
const LOOKBACK_LIMIT = 1000;

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const itemId = req.query.item_id;
    if (!itemId) return json(res, 400, { error: { message: "item_id required" } });
    const svc = serviceClient();

    // Load the item so we can fall back to identifier matching for
    // lines that never stamped a _mapped_item.id.
    const { data: item } = await svc.from("item_master")
      .select("id, part_no, alias, specification_code, print_name, description, created_at")
      .eq("tenant_id", ctx.tenantId)
      .eq("id", itemId)
      .maybeSingle();
    if (!item) return json(res, 404, { error: { message: "item not found" } });

    // The set of normalised identifiers that mean "this is the item".
    const itemKeys = new Set(
      [item.part_no, item.alias, item.specification_code].map(norm).filter(Boolean),
    );

    const { data: orders, error } = await svc.from("orders")
      .select("id, po_number, quote_number, po_date, status, created_at, result, customer:customer_id(customer_name)")
      .eq("tenant_id", ctx.tenantId)
      .order("created_at", { ascending: false })
      .limit(LOOKBACK_LIMIT);
    if (error) throw new Error(error.message);

    const lineMatchesItem = (line) => {
      if (!line) return false;
      if (line._mapped_item && line._mapped_item.id === itemId) return true;
      if (!itemKeys.size) return false;
      // Fallback: any of the line's part-number candidates equals one
      // of the item's identifiers.
      for (const cand of lineCandidates(line)) {
        if (itemKeys.has(cand)) return true;
      }
      return false;
    };

    const qtyOf = (line) => {
      const q = Number(line?.quantity ?? line?.qty ?? line?.qtyOrdered ?? 0);
      return Number.isFinite(q) ? q : 0;
    };

    const usage = [];
    for (const o of orders || []) {
      const lines = Array.isArray(o.result?.salesOrder?.lineItems) ? o.result.salesOrder.lineItems : [];
      const matched = lines.filter(lineMatchesItem);
      if (!matched.length) continue;
      usage.push({
        order_id: o.id,
        po_number: o.po_number || null,
        quote_number: o.quote_number || null,
        po_date: o.po_date || null,
        status: o.status,
        created_at: o.created_at,
        customer_name: o.customer?.customer_name || null,
        line_count: matched.length,
        total_qty: matched.reduce((s, ln) => s + qtyOf(ln), 0),
        match_via: matched[0]?._mapped_item?.match_via || (matched[0]?._mapped_item?.id === itemId ? "mapped_id" : "identifier_fallback"),
        lines: matched.slice(0, 10).map((ln) => ({
          description: ln.description || ln.itemName || ln.partNumber || ln.partNo || "—",
          part_number: ln.partNumber || ln.partNo || ln.sku || null,
          qty: qtyOf(ln),
          uom: ln.uom || ln.unit || null,
        })),
      });
    }

    return json(res, 200, {
      item: { id: item.id, part_no: item.part_no, print_name: item.print_name, created_at: item.created_at },
      usage,
      order_count: usage.length,
      total_qty: usage.reduce((s, u) => s + (u.total_qty || 0), 0),
      scanned: (orders || []).length,
      scan_capped: (orders || []).length >= LOOKBACK_LIMIT,
    });
  } catch (err) {
    sendError(res, err);
  }
}
