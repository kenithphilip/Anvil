// /api/sales/shipment_tracking
//   GET  Account-owner tracking read-model over `shipments`.
//
// The logistics team's Excel trackers are invoice/PO-centric, but a sales
// engineer thinks in terms of THEIR projects. This endpoint resolves each
// shipment up the chain
//   shipment.order_id -> orders (customer, opportunity, order_mode,
//                                committed_delivery_date)
//   order.opportunity_id -> opportunities (project name, owner = sales engineer)
//   order.customer_id -> customers (name)
//   shipment.source_po_id -> source_po_lines (per-line received summary)
// and classifies the item type from order_mode (project material vs spares),
// so the UI can group a caller's imported kit by project and show its delivery
// ladder + line-receipt progress.
//
// Query params:
//   ?mine=1       scope to shipments whose owning opportunity.owner_id == caller
//   ?owner_id=…   scope to a specific owner (used by managers)
//   ?status=…     filter by shipment status
//
// Read-only + level-gated (requirePermission "read"); no named RBAC action, so
// it needs no ACTIONS/SERVER_ACTIONS parity entry.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

const SPARES_MODES = new Set(["SPARES", "SPARES_ASSEMBLY"]);
const PROJECT_MODES = new Set(["PROJECT_FOR", "PROJECT_HSS"]);

// order_mode -> the two categories the logistics team distinguishes, plus the
// internal / unknown escape hatches.
export const shipmentItemType = (mode) =>
  SPARES_MODES.has(mode) ? "spares"
    : PROJECT_MODES.has(mode) ? "project"
      : mode === "INTERNAL" ? "internal"
        : "unknown";

const uniq = (arr) => [...new Set(arr.filter(Boolean))];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const tenantId = ctx.tenantId;

    // 1. Base shipments (newest first).
    let q = svc.from("shipments").select("*").eq("tenant_id", tenantId)
      .order("created_at", { ascending: false }).limit(1000);
    if (req.query.status) q = q.eq("status", req.query.status);
    const { data: ships, error } = await q;
    if (error) throw new Error(error.message);
    const shipments = ships || [];

    // 2. Orders (customer, opportunity, mode, committed date).
    const orderIds = uniq(shipments.map((s) => s.order_id));
    const ordersById = new Map();
    if (orderIds.length) {
      const { data: orders } = await svc.from("orders")
        .select("id, customer_id, opportunity_id, order_mode, committed_delivery_date, po_number")
        .eq("tenant_id", tenantId).in("id", orderIds);
      for (const o of (orders || [])) ordersById.set(o.id, o);
    }

    // 3. Opportunities (project name + owner). Fall back to the opportunity's
    //    own customer_id / order_mode when the order didn't carry them.
    const oppIds = uniq([...ordersById.values()].map((o) => o.opportunity_id));
    const oppById = new Map();
    if (oppIds.length) {
      const { data: opps } = await svc.from("opportunities")
        .select("id, opportunity_name, owner_id, customer_id, order_mode")
        .eq("tenant_id", tenantId).in("id", oppIds);
      for (const o of (opps || [])) oppById.set(o.id, o);
    }

    // 4. Customers.
    const custIds = uniq([
      ...[...ordersById.values()].map((o) => o.customer_id),
      ...[...oppById.values()].map((o) => o.customer_id),
    ]);
    const custById = new Map();
    if (custIds.length) {
      const { data: custs } = await svc.from("customers")
        .select("id, customer_name, display_name").eq("tenant_id", tenantId).in("id", custIds);
      for (const c of (custs || [])) custById.set(c.id, c);
    }

    // 5. Owner display names — bounded per-unique-owner lookup against auth
    //    metadata (same pattern as listTenantAdmins). A tracker view has only a
    //    handful of distinct owners, so this stays cheap.
    const ownerIds = uniq([...oppById.values()].map((o) => o.owner_id));
    const ownerNameById = new Map();
    await Promise.all(ownerIds.map(async (id) => {
      try {
        const { data } = await svc.auth.admin.getUserById(id);
        const u = data?.user;
        ownerNameById.set(id, u?.user_metadata?.name || u?.user_metadata?.full_name || u?.email || id.slice(0, 8));
      } catch (_) { ownerNameById.set(id, id.slice(0, 8)); }
    }));

    // 6. Per-line received summary from source_po_lines (the import-PO parts).
    const spoIds = uniq(shipments.map((s) => s.source_po_id));
    const lineSummaryBySpo = new Map();
    if (spoIds.length) {
      const { data: lines } = await svc.from("source_po_lines")
        .select("source_po_id, qty, received_qty").eq("tenant_id", tenantId).in("source_po_id", spoIds);
      for (const l of (lines || [])) {
        const cur = lineSummaryBySpo.get(l.source_po_id) || { total: 0, received: 0 };
        cur.total += 1;
        // A line counts as received once its received_qty covers the ordered qty.
        if (Number(l.received_qty) > 0 && Number(l.received_qty) >= Number(l.qty || 0)) cur.received += 1;
        lineSummaryBySpo.set(l.source_po_id, cur);
      }
    }

    // 7. Assemble the enriched rows.
    let rows = shipments.map((s) => {
      const order = ordersById.get(s.order_id);
      const opp = order?.opportunity_id ? oppById.get(order.opportunity_id) : null;
      const mode = order?.order_mode || opp?.order_mode || null;
      const custId = order?.customer_id || opp?.customer_id || null;
      const cust = custId ? custById.get(custId) : null;
      const ownerId = opp?.owner_id || null;
      const lines = s.source_po_id ? (lineSummaryBySpo.get(s.source_po_id) || null) : null;
      return {
        ...s,
        committed_delivery_date: order?.committed_delivery_date || null,
        po_number: order?.po_number || null,
        customer_id: custId,
        customer_name: cust?.customer_name || cust?.display_name || null,
        opportunity_id: order?.opportunity_id || null,
        project_name: opp?.opportunity_name || null,
        owner_id: ownerId,
        owner_name: ownerId ? (ownerNameById.get(ownerId) || null) : null,
        order_mode: mode,
        item_type: shipmentItemType(mode),
        lines,
      };
    });

    // 8. Owner scoping.
    if (req.query.mine === "1" && ctx.user) {
      rows = rows.filter((r) => r.owner_id === ctx.user.id);
    } else if (req.query.owner_id) {
      rows = rows.filter((r) => r.owner_id === req.query.owner_id);
    }

    return json(res, 200, { shipments: rows });
  } catch (err) {
    sendError(res, err);
  }
}
