// price_increase_announcement
//
// Audit P8.3.7. Goal: announce a price increase 30 days ahead so
// customers can pull-in orders or adjust budgets. The goal row's
// payload carries the part_no, the current_price, the new_price,
// and the effective_date. The handler fans out one email per
// distinct customer that has bought the part in the last 12 months.
// Single touch per customer. Once every customer has been emailed,
// mark_complete.

const HOURS = 60 * 60 * 1000;
const DAYS = 24 * HOURS;

export const priceIncreaseAnnouncement = async (goal, ctx) => {
  const svc = ctx.svc;
  const cfg = goal.config || {};
  const partNo = cfg.part_no;
  const currentPrice = cfg.current_price;
  const newPrice = cfg.new_price;
  const effectiveDate = cfg.effective_date;
  const currency = cfg.currency || "INR";
  if (!partNo || !newPrice || !effectiveDate) {
    return { thought: "Missing config (part_no / new_price / effective_date); cannot run.", action: "give_up", action_payload: { reason: "missing_config" } };
  }
  const now = Date.now();
  const effMs = new Date(effectiveDate).getTime();
  const daysToEffective = Math.round((effMs - now) / DAYS);
  if (daysToEffective <= 0) {
    return { thought: "Effective date passed; goal complete.", action: "mark_complete", action_payload: { reason: "effective_date_passed" } };
  }
  if (daysToEffective > 60) {
    return { thought: "More than 60 days to effective date; sleeping until 30-day window.", action: "noop", action_payload: { sleep_hours: Math.max(1, Math.round((effMs - now - 30 * DAYS) / HOURS)) } };
  }
  // Find a customer that bought this part in the last year and
  // hasn't been notified yet (notified list lives on goal.config.notified_customer_ids).
  const since = new Date(now - 365 * DAYS).toISOString();
  const buyersQ = await svc.from("orders")
    .select("customer_id, line_items, created_at")
    .eq("tenant_id", goal.tenant_id)
    .gte("created_at", since)
    .limit(2000);
  if (buyersQ.error) return { thought: "orders read failed: " + buyersQ.error.message, action: "noop", action_payload: {} };
  const notified = new Set((cfg.notified_customer_ids || []));
  const buyersWithPart = (buyersQ.data || []).filter((o) => {
    const items = Array.isArray(o.line_items) ? o.line_items : [];
    return items.some((li) => (li.partNumber || li.part_no) === partNo);
  });
  const distinctCustomers = Array.from(new Set(buyersWithPart.map((o) => o.customer_id))).filter((id) => id && !notified.has(id));
  if (!distinctCustomers.length) {
    return { thought: "All buyers notified; goal complete.", action: "mark_complete", action_payload: { notified_count: notified.size } };
  }
  const lastTouch = goal.last_action_at ? new Date(goal.last_action_at).getTime() : 0;
  const cooldownMs = (cfg.cooldown_hours || 1) * HOURS;
  if (now - lastTouch < cooldownMs) {
    return { thought: "Within fan-out cooldown.", action: "noop", action_payload: {} };
  }
  const targetCustomerId = distinctCustomers[0];
  const c = await svc.from("customers").select("contact_email, customer_name").eq("id", targetCustomerId).maybeSingle();
  if (!c.data?.contact_email) {
    // Skip and add to notified so we don't loop forever; ops can
    // pick up via the customer-needs-contact-email queue.
    return {
      thought: "Customer " + targetCustomerId + " has no contact_email; skipping (added to notified).",
      action: "noop",
      action_payload: { advance_notified: targetCustomerId },
    };
  }
  const greet = "Hello" + (c.data.customer_name ? " " + c.data.customer_name : "") + ",";
  const subject = "Price update: " + partNo + " effective " + effectiveDate;
  const lines = [
    greet, "",
    "We're writing to give you 30 days' notice on a price update for part " + partNo + ".",
    "",
    "  Current price: " + currency + " " + (currentPrice ? Number(currentPrice).toFixed(2) : "(see your last order)"),
    "  New price:     " + currency + " " + Number(newPrice).toFixed(2),
    "  Effective:     " + effectiveDate,
    "",
    "Orders placed and confirmed before " + effectiveDate + " ship at the current price.",
    "",
    "Reply if you'd like to lock in volume at the current price, or if there are alternatives we should look at together.",
  ].join("\n");
  return {
    thought: "Notifying customer " + targetCustomerId + " of price update on " + partNo + " (queue=" + distinctCustomers.length + ")",
    action: "send_email",
    action_payload: {
      kind: "price_increase_announcement",
      object_type: "part",
      object_id: partNo,
      to: c.data.contact_email,
      subject,
      body: lines,
      advance_notified: targetCustomerId,
    },
  };
};
