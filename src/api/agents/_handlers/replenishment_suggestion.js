// replenishment_suggestion
//
// Audit P8.3.8. Goal: when a customer has been buying a part on a
// regular cadence (rolling median order interval), and the next
// expected order date is within 7 days, send a polite "ready to
// reorder?" email. Single touch per cycle: marks complete after
// one email; the operator re-arms with a fresh goal next cycle.

const HOURS = 60 * 60 * 1000;
const DAYS = 24 * HOURS;

const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
};

export const replenishmentSuggestion = async (goal, ctx) => {
  const svc = ctx.svc;
  const cfg = goal.config || {};
  const partNo = cfg.part_no;
  if (!partNo) return { thought: "Missing config.part_no", action: "give_up", action_payload: { reason: "missing_config" } };

  const cust = await svc.from("customers")
    .select("id, customer_name, contact_email")
    .eq("tenant_id", goal.tenant_id)
    .eq("id", goal.object_id)
    .maybeSingle();
  if (!cust.data) return { thought: "customer missing", action: "give_up", action_payload: { reason: "customer_not_found" } };

  // Pull this customer's last 18 months of orders that include
  // partNo in line_items.
  const since = new Date(Date.now() - 540 * DAYS).toISOString();
  const ordQ = await svc.from("orders")
    .select("created_at, line_items")
    .eq("tenant_id", goal.tenant_id)
    .eq("customer_id", cust.data.id)
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(500);
  if (ordQ.error) return { thought: "orders read failed: " + ordQ.error.message, action: "noop", action_payload: {} };
  const dates = (ordQ.data || [])
    .filter((o) => Array.isArray(o.line_items) && o.line_items.some((li) => (li.partNumber || li.part_no) === partNo))
    .map((o) => new Date(o.created_at).getTime());
  if (dates.length < 3) {
    return { thought: "Insufficient history (" + dates.length + " orders); cannot project cadence.", action: "give_up", action_payload: { reason: "insufficient_history" } };
  }
  const intervals = [];
  for (let i = 1; i < dates.length; i += 1) intervals.push(dates[i] - dates[i - 1]);
  const medianIntervalMs = median(intervals);
  const lastOrderMs = dates[dates.length - 1];
  const projectedNextMs = lastOrderMs + medianIntervalMs;
  const now = Date.now();
  const daysUntilProjected = Math.round((projectedNextMs - now) / DAYS);

  if (daysUntilProjected > 7) {
    return { thought: "Projected next order is " + daysUntilProjected + " days out; sleeping.", action: "noop", action_payload: { sleep_hours: Math.max(1, Math.round((projectedNextMs - now - 7 * DAYS) / HOURS)) } };
  }
  if (daysUntilProjected < -14) {
    return { thought: "Customer is " + (-daysUntilProjected) + " days past expected reorder; the cadence has shifted. Goal failed.", action: "give_up", action_payload: { reason: "cadence_shifted" } };
  }
  if ((goal.step_count || 0) >= 1) {
    return { thought: "Already nudged this cycle; goal complete.", action: "mark_complete", action_payload: {} };
  }
  if (!cust.data.contact_email) {
    return { thought: "No contact email; escalating.", action: "escalate", action_payload: { reason: "no_recipient" } };
  }
  const subject = "Time to reorder " + partNo + "?";
  const body = [
    "Hello" + (cust.data.customer_name ? " " + cust.data.customer_name : "") + ",",
    "",
    "Looking at your reorder cadence on " + partNo + ", it looks like a fresh batch is due in about " + Math.max(0, daysUntilProjected) + " day" + (daysUntilProjected === 1 ? "" : "s") + ".",
    "",
    "Quantity / spec the same as last time, or any changes? Reply with the PO and we'll get it queued.",
    "",
    "If consumption has shifted, do let us know so we can re-tune the suggested cadence.",
  ].join("\n");
  return {
    thought: "Sending replenishment nudge to " + cust.data.contact_email + " (cadence median ~" + Math.round(medianIntervalMs / DAYS) + "d)",
    action: "send_email",
    action_payload: {
      kind: "replenishment_suggestion",
      object_type: "customer",
      object_id: cust.data.id,
      to: cust.data.contact_email,
      subject,
      body,
    },
  };
};
