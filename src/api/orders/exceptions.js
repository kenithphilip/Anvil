// GET /api/orders/exceptions?id=<uuid>[&include_shadow=1]
//
// One list of what needs a decision on one order (plan PR 9): reconcile line
// and header issues, findings and blockers, the anomaly rules, the extraction
// run, the terms flags and the customer match. _lib/order-exceptions.js
// builds it from the inputs _lib/order-exceptions-inputs.js reads, the same
// reader the server's move gate uses (order-move-gate.js).
//
// Read-only, read permission, tenant-scoped. Every query names
// ctx.tenantId, and nothing is read without one.
//
// The terms rows come from the terms read path, so they follow its rules:
// with the tenant's check in shadow mode they are hidden, unless an admin
// passes include_shadow=1. A non-admin asking for shadow rows is refused, as
// GET /api/orders/terms refuses. Before migration 250 is applied the list is
// built without terms rows and says so (terms_state "unavailable").

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission, hasPermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { buildOrderExceptions } from "../_lib/order-exceptions.js";
import { readExceptionInputs } from "../_lib/order-exceptions-inputs.js";
import { wantsShadow } from "./terms.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ORDER_COLUMNS = [
  "id", "status", "customer_id", "po_number", "po_date", "vendor_code", "result",
  "rule_findings", "anomaly_flags", "preflight_payload", "committed_delivery_date",
].join(", ");

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return json(res, 405, { error: { message: "Method not allowed" } });
    }
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    // Fail closed: without a tenant there is nothing this caller may see.
    if (!ctx || !ctx.tenantId) return json(res, 403, { error: { message: "No tenant in context" } });
    const orderId = String(req.query?.id || req.query?.order_id || "");
    if (!UUID_RE.test(orderId)) return json(res, 400, { error: { message: "id must be an order id" } });
    const includeShadow = wantsShadow(req.query);
    if (includeShadow && !hasPermission(ctx, "admin")) {
      return json(res, 403, { error: { code: "SHADOW_ADMIN_ONLY", message: "Only an admin may read a shadow-mode terms check." } });
    }

    const svc = serviceClient();
    const o = await svc.from("orders").select(ORDER_COLUMNS)
      .eq("tenant_id", ctx.tenantId).eq("id", orderId).maybeSingle();
    if (o.error) throw new Error("orders read: " + o.error.message);
    if (!o.data) return json(res, 404, { error: { message: "Order not found" } });
    const order = o.data;

    // Exactly what the workspace renders, versioned (EXCEPTIONS_VERSION), so
    // an agent reading this and a person reading the screen see one queue.
    const out = buildOrderExceptions(await readExceptionInputs(svc, ctx, order, { includeShadow }));
    return json(res, 200, out);
  } catch (err) {
    sendError(res, err);
  }
}
