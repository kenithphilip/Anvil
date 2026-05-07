// onboarding_followup
//
// Audit P8.3.6. Goal: friendly check-in 14 days after a customer's
// first order. Single touchpoint. Marks complete after one email.

const HOURS = 60 * 60 * 1000;
const DAYS = 24 * HOURS;

export const onboardingFollowup = async (goal, ctx) => {
  const svc = ctx.svc;
  const r = await svc.from("customers")
    .select("id, customer_name, contact_email, created_at")
    .eq("tenant_id", goal.tenant_id)
    .eq("id", goal.object_id)
    .maybeSingle();
  if (r.error) return { thought: "customer read failed: " + r.error.message, action: "noop", action_payload: {} };
  if (!r.data) return { thought: "customer missing", action: "give_up", action_payload: { reason: "customer_not_found" } };
  const cust = r.data;

  const onboardDays = goal.config?.onboarding_followup_days || 14;
  const sinceCreated = Date.now() - new Date(cust.created_at).getTime();
  if (sinceCreated < onboardDays * DAYS) {
    return { thought: "Customer is " + Math.round(sinceCreated / DAYS) + "d old; sleeping until day " + onboardDays + ".", action: "noop", action_payload: { sleep_hours: Math.round((onboardDays * DAYS - sinceCreated) / HOURS) } };
  }
  // First-touch only.
  if ((goal.step_count || 0) >= 1) {
    return { thought: "Onboarding follow-up already sent; goal complete.", action: "mark_complete", action_payload: {} };
  }
  if (!cust.contact_email) {
    return { thought: "No customer contact email; escalating to ops.", action: "escalate", action_payload: { reason: "no_recipient" } };
  }
  const subject = "Quick check-in from your supplier";
  const body = [
    "Hello" + (cust.customer_name ? " " + cust.customer_name : "") + ",",
    "",
    "It's been a couple of weeks since your first order with us. We wanted to check in:",
    "",
    "  - Did the goods arrive as expected, in the right quantity and condition?",
    "  - Is there anything we could improve about the order, the paperwork, or the lead time?",
    "  - Is there anything else on your shop floor where we can help?",
    "",
    "Reply to this email with whatever's on your mind. Even a one-line note is useful.",
    "",
    "Thanks for trusting us with your business.",
  ].join("\n");
  return {
    thought: "Sending onboarding follow-up to " + cust.contact_email,
    action: "send_email",
    action_payload: {
      kind: "onboarding_followup",
      object_type: "customer",
      object_id: cust.id,
      to: cust.contact_email,
      subject,
      body,
    },
  };
};
