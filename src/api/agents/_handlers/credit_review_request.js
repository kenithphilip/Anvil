// credit_review_request
//
// Audit P8.3.5. Goal: when a customer's outstanding AR is approaching
// or has exceeded their credit_limit, request finance to review the
// limit. Single email to ops (not to the customer); marks complete
// once a review row is recorded.

const HOURS = 60 * 60 * 1000;

const sumOutstanding = async (svc, tenantId, customerId) => {
  const inv = await svc.from("invoices")
    .select("grand_total, paid_amount, status")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId);
  if (inv.error) return 0;
  return (inv.data || [])
    .filter((i) => i.status !== "paid" && i.status !== "void")
    .reduce((s, i) => s + (Number(i.grand_total) || 0) - (Number(i.paid_amount) || 0), 0);
};

export const creditReviewRequest = async (goal, ctx) => {
  const svc = ctx.svc;
  const r = await svc.from("customers")
    .select("id, customer_name, credit_limit, currency, owner_user_id")
    .eq("tenant_id", goal.tenant_id)
    .eq("id", goal.object_id)
    .maybeSingle();
  if (r.error) return { thought: "customer read failed: " + r.error.message, action: "noop", action_payload: {} };
  if (!r.data) return { thought: "customer missing", action: "give_up", action_payload: { reason: "customer_not_found" } };
  const cust = r.data;
  if (!cust.credit_limit) {
    return { thought: "No credit_limit on file; nothing to review.", action: "give_up", action_payload: { reason: "no_credit_limit" } };
  }
  const outstanding = await sumOutstanding(svc, goal.tenant_id, cust.id);
  const ratio = outstanding / Number(cust.credit_limit);
  // Trigger threshold: 85%. Below that, sleep.
  if (ratio < 0.85) {
    return { thought: "Outstanding " + outstanding.toFixed(0) + " is " + (ratio * 100).toFixed(1) + "% of limit; below 85% threshold.", action: "noop", action_payload: { sleep_hours: 24 } };
  }
  const lastTouch = goal.last_action_at ? new Date(goal.last_action_at).getTime() : 0;
  const cooldownMs = (goal.config?.cooldown_hours || 168) * HOURS;
  if (Date.now() - lastTouch < cooldownMs) {
    return { thought: "Within credit-review cooldown.", action: "noop", action_payload: {} };
  }
  // Internal-only escalation: routed via the same send_email
  // pipeline but addressed to the operator's finance alias from
  // tenant_settings.finance_email if present, else the customer's
  // owner_user_id email.
  let recipient = null;
  const ts = await svc.from("tenant_settings").select("finance_email").eq("tenant_id", goal.tenant_id).maybeSingle();
  if (ts.data?.finance_email) recipient = ts.data.finance_email;
  if (!recipient && cust.owner_user_id) {
    const u = await svc.from("users").select("email").eq("id", cust.owner_user_id).maybeSingle();
    if (u.data?.email) recipient = u.data.email;
  }
  if (!recipient) {
    return { thought: "No internal recipient (tenant_settings.finance_email + owner_user_id both empty); escalating.", action: "escalate", action_payload: { reason: "no_internal_recipient" } };
  }
  const subject = "Credit review request: " + cust.customer_name;
  const body = [
    "Internal: credit-limit review",
    "",
    "Customer: " + cust.customer_name,
    "Credit limit: " + (cust.currency || "INR") + " " + Number(cust.credit_limit).toFixed(2),
    "Outstanding AR: " + (cust.currency || "INR") + " " + outstanding.toFixed(2) + " (" + (ratio * 100).toFixed(1) + "% of limit)",
    "",
    "Please review the limit and confirm whether to extend, hold new orders, or unlock partial shipment. Reply with the decision so the agent can resume.",
  ].join("\n");
  return {
    thought: "Requesting credit review for " + cust.customer_name + " (utilisation=" + (ratio * 100).toFixed(0) + "%)",
    action: "send_email",
    action_payload: {
      kind: "credit_review_request",
      object_type: "customer",
      object_id: cust.id,
      to: recipient,
      subject,
      body,
      internal: true,
    },
  };
};
