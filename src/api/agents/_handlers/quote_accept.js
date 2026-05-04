// quote_accept_within_14d
//
// Goal: nudge a draft / sent quote toward acceptance within 14 days
// of the goal's start. The handler reads the target order, checks
// status, and decides:
//
// - status moved to APPROVED / EXPORTED_TO_TALLY -> mark_complete
// - status still QUOTE_DRAFT and last contact > 3 days ago -> send_email
// - status still QUOTE_SENT and last contact > 5 days ago -> send_email (escalating)
// - past due_at -> give_up + escalate to owner
// - otherwise -> noop, push next_run_at to next checkpoint

const HOURS = 60 * 60 * 1000;

export const quoteAccept = async (goal, ctx) => {
  const svc = ctx.svc;
  const order = await svc
    .from("orders")
    .select("id, status, customer_id, customer:customer_id(customer_name, contact_email), updated_at, po_number, quote_number")
    .eq("tenant_id", goal.tenant_id)
    .eq("id", goal.object_id)
    .maybeSingle();
  if (order.error) {
    return { thought: "Order read failed: " + order.error.message, action: "noop", action_payload: {} };
  }
  if (!order.data) {
    return { thought: "Target order missing", action: "give_up", action_payload: { reason: "order_not_found" } };
  }
  const o = order.data;
  if (["APPROVED", "EXPORTED_TO_TALLY", "PAID"].includes(o.status)) {
    return {
      thought: "Order is " + o.status + ", goal succeeded.",
      action: "mark_complete",
      action_payload: { final_status: o.status },
    };
  }
  if (goal.due_at && new Date(goal.due_at).getTime() < Date.now()) {
    return {
      thought: "Past due_at without acceptance; escalating to owner.",
      action: "escalate",
      action_payload: { reason: "due_at_passed", final_status: o.status },
    };
  }

  const lastTouch = goal.last_action_at ? new Date(goal.last_action_at).getTime() : 0;
  const sinceTouch = Date.now() - lastTouch;
  const cooldownMs = (goal.config?.cooldown_hours || 72) * HOURS;
  if (sinceTouch < cooldownMs) {
    return {
      thought: "Within cooldown; will check back later.",
      action: "noop",
      action_payload: { sleep_hours: Math.round((cooldownMs - sinceTouch) / HOURS) },
    };
  }

  const recipient = o.customer?.contact_email;
  if (!recipient) {
    return {
      thought: "No customer contact email on file; escalating to owner.",
      action: "escalate",
      action_payload: { reason: "no_recipient" },
    };
  }
  return {
    thought: "Drafting follow-up email for " + (o.customer?.customer_name || "customer"),
    action: "send_email",
    action_payload: {
      kind: "quote_followup",
      order_id: o.id,
      to: recipient,
      subject: "Following up on " + (o.quote_number || o.po_number || "your quote"),
      // The runner will draft the body via communications.draft using
      // this hint; we keep the payload small here.
      hint: "Polite, concise quote nudge. Reference any open questions.",
    },
  };
};
