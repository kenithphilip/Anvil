// POST /api/orders/reconcile_quotes   body: { order_id, price_tolerance_pct?, if_changed? }
//
// Auto-reconcile a received PO/SO against the customer's quotes. The
// operator uploads the PO and Anvil finds the corresponding quotes on its
// own. Pools ALL of the order customer's quotes (across every quote, not a
// single hand-picked one), matches each PO line by part number, enriches
// it with the quoted HSN / tax / source, stamps which quote priced each
// line, and stores a verification report (price/qty/part exceptions) on the
// order so the SO renders complete and the operator only reviews the flags.
//
// The work lives in _lib/order-reconcile.js, which the server also runs when
// an order's lines are written. if_changed: true returns the stored report
// when the order's payload hash has not moved since the last reconciliation,
// so the intake screen does not run it a second time for the same lines.
// Without it the run is forced, which is what the workspace's reconcile
// button and a newly attached quote need: the quotes changed, the PO did not.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { reconcileOrderQuotes } from "../_lib/order-reconcile.js";

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
    const orderId = body.order_id;
    if (!orderId) return json(res, 400, { error: { message: "order_id required" } });
    const svc = serviceClient();

    const out = await reconcileOrderQuotes(svc, ctx, orderId, {
      priceTolerancePct: body.price_tolerance_pct != null ? Number(body.price_tolerance_pct) : undefined,
      ifChanged: body.if_changed === true,
      trigger: "manual",
    });
    if (out.status === "not_found") return json(res, 404, { error: { message: "Order not found" } });
    if (out.status === "no_customer") {
      return json(res, 400, { error: { message: "Order has no customer; cannot find matching quotes. Set the customer first." } });
    }
    if (out.status === "no_lines") return json(res, 400, { error: { message: "Order has no lines to reconcile." } });
    return json(res, 200, {
      ...out.report,
      ...(out.status === "unchanged" ? { skipped: "unchanged" } : {}),
    });
  } catch (err) {
    sendError(res, err);
  }
}
