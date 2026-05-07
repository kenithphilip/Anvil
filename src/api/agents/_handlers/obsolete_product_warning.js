// obsolete_product_warning
//
// Audit P8.3.9. Goal: warn customers whose recent orders include a
// part that the manufacturer has flagged EOL (end-of-life). Goal
// payload: part_no, replacement_part_no (optional), eol_date (the
// last day we accept new orders), reason. Fan-out one email per
// distinct customer, single touch per customer.

const HOURS = 60 * 60 * 1000;
const DAYS = 24 * HOURS;

export const obsoleteProductWarning = async (goal, ctx) => {
  const svc = ctx.svc;
  const cfg = goal.config || {};
  const partNo = cfg.part_no;
  const replacement = cfg.replacement_part_no || null;
  const eolDate = cfg.eol_date;
  const reason = cfg.reason || null;
  if (!partNo || !eolDate) {
    return { thought: "Missing config (part_no / eol_date).", action: "give_up", action_payload: { reason: "missing_config" } };
  }
  const now = Date.now();
  const eolMs = new Date(eolDate).getTime();
  if (eolMs < now - 30 * DAYS) {
    return { thought: "EOL date passed > 30 days ago; goal complete.", action: "mark_complete", action_payload: {} };
  }
  // Fan-out queue: customers who bought partNo in the last 18 months.
  const since = new Date(now - 540 * DAYS).toISOString();
  const buyersQ = await svc.from("orders")
    .select("customer_id, line_items")
    .eq("tenant_id", goal.tenant_id)
    .gte("created_at", since)
    .limit(2000);
  if (buyersQ.error) return { thought: "orders read failed: " + buyersQ.error.message, action: "noop", action_payload: {} };
  const notified = new Set(cfg.notified_customer_ids || []);
  const buyersWithPart = (buyersQ.data || []).filter((o) => {
    const items = Array.isArray(o.line_items) ? o.line_items : [];
    return items.some((li) => (li.partNumber || li.part_no) === partNo);
  });
  const distinctCustomers = Array.from(new Set(buyersWithPart.map((o) => o.customer_id)))
    .filter((id) => id && !notified.has(id));
  if (!distinctCustomers.length) {
    return { thought: "All buyers notified; goal complete.", action: "mark_complete", action_payload: { notified_count: notified.size } };
  }
  const lastTouch = goal.last_action_at ? new Date(goal.last_action_at).getTime() : 0;
  const cooldownMs = (cfg.cooldown_hours || 1) * HOURS;
  if (now - lastTouch < cooldownMs) {
    return { thought: "Within fan-out cooldown.", action: "noop", action_payload: {} };
  }
  const targetCustomerId = distinctCustomers[0];
  const c = await svc.from("customers")
    .select("contact_email, customer_name")
    .eq("id", targetCustomerId)
    .maybeSingle();
  if (!c.data?.contact_email) {
    return {
      thought: "Customer " + targetCustomerId + " has no contact_email; skipping.",
      action: "noop",
      action_payload: { advance_notified: targetCustomerId },
    };
  }
  const subject = "Action needed: " + partNo + " end-of-life on " + eolDate;
  const body = [
    "Hello" + (c.data.customer_name ? " " + c.data.customer_name : "") + ",",
    "",
    "Part " + partNo + " is reaching end-of-life on " + eolDate + (reason ? " (reason: " + reason + ")" : "") + ".",
    "",
    "What this means for you:",
    "  - We can accept orders at the current price up to " + eolDate + ".",
    "  - After " + eolDate + " we cannot promise availability or a fixed lead time.",
    replacement
      ? "  - Recommended replacement: " + replacement + ". We can sample it for you on request."
      : "  - We are still finalising replacement options; we will share them as soon as they're approved.",
    "",
    "If this part is on your bill of materials and you want to lock in a final-call buy, reply with the quantity and we will quote.",
  ].join("\n");
  return {
    thought: "Notifying customer " + targetCustomerId + " of EOL on " + partNo + " (queue=" + distinctCustomers.length + ")",
    action: "send_email",
    action_payload: {
      kind: "obsolete_product_warning",
      object_type: "part",
      object_id: partNo,
      to: c.data.contact_email,
      subject,
      body,
      advance_notified: targetCustomerId,
    },
  };
};
