// amc_renewal_chase
//
// Audit P8.3.4. Goal: chase the customer to renew an AMC contract
// approaching its end_date. Tier escalates: gentle (60d) -> firm
// (30d) -> final (10d). After end_date passes without renewal we
// escalate to ops so commercial can step in.

const HOURS = 60 * 60 * 1000;
const DAYS = 24 * HOURS;

const tierFor = (daysToExpiry) => {
  if (daysToExpiry > 60) return null;
  if (daysToExpiry > 30) return "gentle";
  if (daysToExpiry > 10) return "firm";
  return "final";
};

export const amcRenewalChase = async (goal, ctx) => {
  const svc = ctx.svc;
  const r = await svc.from("contracts")
    .select("id, contract_type, contract_number, customer_id, status, end_date, total_value_inr, currency")
    .eq("tenant_id", goal.tenant_id)
    .eq("id", goal.object_id)
    .maybeSingle();
  if (r.error) return { thought: "contract read failed: " + r.error.message, action: "noop", action_payload: {} };
  if (!r.data) return { thought: "contract missing", action: "give_up", action_payload: { reason: "contract_not_found" } };
  const c = r.data;

  if (c.status === "TERMINATED") {
    return { thought: "Contract terminated; goal complete.", action: "mark_complete", action_payload: {} };
  }
  if (c.status === "ACTIVE" && c.end_date && new Date(c.end_date).getTime() > Date.now() + 365 * DAYS) {
    return { thought: "Contract was renewed (end_date moved out by > 1 year); goal complete.", action: "mark_complete", action_payload: { final_status: c.status } };
  }
  if (!c.end_date) {
    return { thought: "Contract has no end_date; nothing to renew.", action: "give_up", action_payload: { reason: "no_end_date" } };
  }
  const now = Date.now();
  const endMs = new Date(c.end_date).getTime();
  const daysToExpiry = Math.round((endMs - now) / DAYS);
  if (daysToExpiry < -7) {
    return { thought: "Contract expired more than a week ago without renewal; escalating to ops.", action: "escalate", action_payload: { reason: "renewal_lapsed", days_overdue: -daysToExpiry } };
  }
  const tier = tierFor(daysToExpiry);
  if (!tier) {
    return { thought: "Outside renewal-chase window; sleeping.", action: "noop", action_payload: { sleep_hours: Math.max(1, Math.round((endMs - now - 60 * DAYS) / HOURS)) } };
  }
  const lastTouch = goal.last_action_at ? new Date(goal.last_action_at).getTime() : 0;
  const cooldownMs = (goal.config?.cooldown_hours || 168) * HOURS;
  if (now - lastTouch < cooldownMs) {
    return { thought: "Within renewal-chase cooldown.", action: "noop", action_payload: {} };
  }
  const cust = await svc.from("customers")
    .select("contact_email, customer_name")
    .eq("id", c.customer_id)
    .maybeSingle();
  const recipient = cust.data?.contact_email;
  if (!recipient) {
    return { thought: "No customer contact email on file; escalating.", action: "escalate", action_payload: { reason: "no_recipient" } };
  }
  const greet = "Hello" + (cust.data?.customer_name ? " " + cust.data.customer_name : "") + ",";
  const ref = (c.contract_type || "AMC") + " " + c.contract_number;
  const subject = tier === "final"
    ? "Final reminder: " + ref + " expires " + c.end_date
    : tier === "firm"
      ? "Renewal reminder: " + ref + " expires " + c.end_date
      : "Heads up: " + ref + " is up for renewal on " + c.end_date;
  const body = [
    greet, "",
    "Your " + ref + " is set to expire on " + c.end_date + " (" + daysToExpiry + " day" + (daysToExpiry === 1 ? "" : "s") + " from today).",
    "",
    tier === "final"
      ? "We don't want a service gap. Please confirm the renewal terms or share an updated scope so we can get the next contract drawn up before expiry."
      : tier === "firm"
        ? "Could you confirm the renewal terms, or let us know if there are any changes you'd like for the next term?"
        : "Just a heads up so you have time to plan. Do let us know if anything has changed about scope or coverage.",
    "",
    "Reply to this email and we'll set up a quick call to align on terms.",
  ].join("\n");
  return {
    thought: "Sending " + tier + " AMC renewal nudge to " + recipient + " (" + daysToExpiry + "d to expiry)",
    action: "send_email",
    action_payload: {
      kind: "amc_renewal_chase",
      tier,
      object_type: "contract",
      object_id: c.id,
      to: recipient,
      subject,
      body,
    },
  };
};
