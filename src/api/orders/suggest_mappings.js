// GET /api/orders/suggest_mappings?order_id=<uuid>&max=10
//
// Layer C of the item-mapping automation. Returns AI-assisted
// item_master suggestions for every recon-table line on the order
// where _mapped_item is null. Read-only and persists nothing; the
// operator accepts a suggestion on the recon table, the existing
// Layer A applyManualMap path stamps _mapped_item with
// match_via:"llm_suggest", and the server hook in
// src/api/orders/[id].js PATCH writes an item_customer_parts row
// via the shared upsertCustomerPart helper.
//
// Runs lazily (button click on the recon table), never inline on
// order create. Caps the call to maxLines=10 to keep cost and
// latency bounded. A line with no candidate item_master rows is
// returned with suggestions: [] and reason: "no_candidates" so the
// UI can render a "no AI match" state without ambiguity.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit, recordEvent } from "../_lib/audit.js";
import { suggestMappings } from "../_lib/item-mapper-llm.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    if (req.method !== "GET") {
      return json(res, 405, { error: { message: "Method not allowed" } });
    }
    const orderId = req.query.order_id;
    if (!orderId) return json(res, 400, { error: { message: "order_id required" } });
    const maxLines = Math.max(1, Math.min(20, Number(req.query.max || 10)));

    const svc = serviceClient();
    const { data: order, error } = await svc
      .from("orders")
      .select("id, customer_id, result")
      .eq("tenant_id", ctx.tenantId)
      .eq("id", orderId)
      .single();
    if (error || !order) return json(res, 404, { error: { message: "Order not found" } });

    const allLines = (order.result && order.result.salesOrder && Array.isArray(order.result.salesOrder.lineItems))
      ? order.result.salesOrder.lineItems
      : [];
    // Stamp the original index so the response is stably keyed
    // back to the recon table after we filter unmapped.
    const unmapped = allLines
      .map((line, i) => ({ ...(line || {}), _line_index: i }))
      .filter((line) => !line._mapped_item || !line._mapped_item.id);

    const suggestions = await suggestMappings(svc, ctx.tenantId, order.customer_id, unmapped, { maxLines });

    const totalSuggestions = suggestions.reduce((acc, s) => acc + (s.suggestions ? s.suggestions.length : 0), 0);
    await recordAudit(ctx, {
      action: "item_mapping_suggest",
      objectType: "order",
      objectId: orderId,
      detail: { lines_checked: suggestions.length, suggestions: totalSuggestions, max_lines: maxLines },
    });
    await recordEvent(ctx, {
      caseId: orderId,
      eventType: "item_mapping_suggest",
      objectType: "order",
      objectId: orderId,
      detail: { lines_checked: suggestions.length, suggestions: totalSuggestions },
    });

    return json(res, 200, { order_id: orderId, suggestions });
  } catch (err) {
    sendError(res, err);
  }
}
