// ar_collect_by_due_plus_7
//
// Goal: collect on an unpaid invoice within 7 days of its due date.
// Reads the target einvoice (the only invoice surface today), checks
// payment status, and decides next action:
//
// - status PAID -> mark_complete
// - on/after due_date -> send_email (firmer copy each tick)
// - past due_at -> escalate
// - otherwise -> noop

const HOURS = 60 * 60 * 1000;

export const arCollect = async (goal, ctx) => {
  const svc = ctx.svc;
  const inv = await svc
    .from("einvoices")
    .select("id, status, due_date, total_value_inr, buyer_gstin, customer_id")
    .eq("tenant_id", goal.tenant_id)
    .eq("id", goal.object_id)
    .maybeSingle();
  if (inv.error) {
    return { thought: "Invoice read failed: " + inv.error.message, action: "noop", action_payload: {} };
  }
  if (!inv.data) {
    return { thought: "Target invoice missing", action: "give_up", action_payload: { reason: "invoice_not_found" } };
  }
  const i = inv.data;
  if (i.status === "PAID") {
    return { thought: "Invoice paid, goal succeeded.", action: "mark_complete", action_payload: {} };
  }
  if (goal.due_at && new Date(goal.due_at).getTime() < Date.now()) {
    return {
      thought: "Past due_at without payment; escalating.",
      action: "escalate",
      action_payload: { reason: "due_at_passed", invoice_status: i.status },
    };
  }
  const lastTouch = goal.last_action_at ? new Date(goal.last_action_at).getTime() : 0;
  const sinceTouch = Date.now() - lastTouch;
  const cooldownMs = (goal.config?.cooldown_hours || 96) * HOURS;
  if (sinceTouch < cooldownMs) {
    return { thought: "Within dunning cooldown.", action: "noop", action_payload: {} };
  }
  // Cadence: gentle, firm, final. We pick by step_count.
  const tier = goal.step_count >= 4 ? "final" : goal.step_count >= 2 ? "firm" : "gentle";
  return {
    thought: "Sending " + tier + " AR reminder.",
    action: "send_email",
    action_payload: {
      kind: "ar_reminder",
      einvoice_id: i.id,
      tier,
      hint: tier === "final"
        ? "Final notice; cite due date, balance, escalation path."
        : tier === "firm"
          ? "Firm reminder; cite due date and amount."
          : "Friendly reminder of upcoming or just-passed due date.",
    },
  };
};
