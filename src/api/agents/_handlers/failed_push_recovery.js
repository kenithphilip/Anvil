// failed_push_recovery
//
// Audit P6.10. Goal: detect orders stuck in
// FAILED_TALLY_IMPORT (or any failed-ERP-push variant) for more
// than 24 hours and escalate so an operator can re-run the push.
//
// The audit found that an order failing a push lands at status
// FAILED_TALLY_IMPORT but no agent watches the queue; the
// per-ERP retry queues handle transient errors but a permanent
// rejection (bad payload, duplicate voucher, missing master)
// doesn't get a human signal. This handler is the safety net.

const HOURS = 60 * 60 * 1000;

const FAILED_STATUSES = new Set(["FAILED_TALLY_IMPORT", "BLOCKED"]);

export const failedPushRecovery = async (goal, ctx) => {
  const svc = ctx.svc;
  const orderQ = await svc.from("orders")
    .select("id, status, customer_id, po_number, quote_number, updated_at, result")
    .eq("tenant_id", goal.tenant_id)
    .eq("id", goal.object_id)
    .maybeSingle();
  if (orderQ.error) {
    return { thought: "Order read failed: " + orderQ.error.message, action: "noop", action_payload: {} };
  }
  if (!orderQ.data) {
    return { thought: "Target order missing", action: "give_up", action_payload: { reason: "order_not_found" } };
  }
  const order = orderQ.data;
  if (!FAILED_STATUSES.has(order.status)) {
    // Order recovered or moved to a terminal good state.
    return { thought: "Order is " + order.status + " (no longer failed); goal succeeded.", action: "mark_complete", action_payload: { final_status: order.status } };
  }
  // Cooldown: don't re-escalate sooner than every 24h.
  const lastTouch = goal.last_action_at ? new Date(goal.last_action_at).getTime() : 0;
  const sinceTouch = Date.now() - lastTouch;
  const cooldownMs = (goal.config?.cooldown_hours || 24) * HOURS;
  if (sinceTouch < cooldownMs) {
    return { thought: "Within escalation cooldown.", action: "noop", action_payload: { sleep_hours: Math.round((cooldownMs - sinceTouch) / HOURS) } };
  }
  // The order has been in a failed state long enough to need a
  // human. Surface a processing_event the operator dashboard
  // shows; do NOT email the customer (the failure is internal).
  const lastError = order.result?.external_systems?.tally?.last_error
    || order.result?.external_systems?.netsuite?.last_error
    || order.result?.external_systems?.sap?.last_error
    || "(no last_error captured on the order's result.external_systems)";
  return {
    thought: "Order " + order.id.slice(0, 8) + " stuck in " + order.status + " > " + (cooldownMs / HOURS) + "h; escalating.",
    action: "escalate",
    action_payload: {
      reason: "erp_push_failed_long",
      order_id: order.id,
      po_number: order.po_number,
      status: order.status,
      last_error: String(lastError).slice(0, 400),
    },
  };
};
