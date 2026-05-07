// expiring_quote_nudge
//
// Audit P6.9. Goal: nudge a customer 3 days before their SENT
// quote expires. The handler:
//
//   - Reads the target quote.
//   - status NOT 'SENT' (already accepted / declined / converted /
//     expired / cancelled) -> mark_complete.
//   - expires_at > 3 days away -> noop with sleep until 3 days
//     before expiry.
//   - expires_at within 0-3 days -> send_email at the right tier.
//   - expires_at past -> mark_complete (the daily expiry cron
//     handles the EXPIRED transition; we just close the goal).
//
// Cooldown 48h to avoid double-nudging.
//
// Body: templated reminder. The Phase 6.7 dunning drafter
// pattern could be reused here for personalised wording, but the
// expiring-quote message is short enough that the template is
// fine for the first pass.

const HOURS = 60 * 60 * 1000;
const DAYS = 24 * HOURS;

export const expiringQuoteNudge = async (goal, ctx) => {
  const svc = ctx.svc;
  const quoteQ = await svc.from("quotes")
    .select("id, status, quote_number, version, customer_id, customer_contact_id, expires_at, currency, grand_total")
    .eq("tenant_id", goal.tenant_id)
    .eq("id", goal.object_id)
    .maybeSingle();
  if (quoteQ.error) {
    return { thought: "Quote read failed: " + quoteQ.error.message, action: "noop", action_payload: {} };
  }
  if (!quoteQ.data) {
    return { thought: "Target quote missing", action: "give_up", action_payload: { reason: "quote_not_found" } };
  }
  const quote = quoteQ.data;
  if (["ACCEPTED", "CONVERTED", "DECLINED", "CANCELLED", "EXPIRED"].includes(quote.status)) {
    return { thought: "Quote is " + quote.status + ", goal complete.", action: "mark_complete", action_payload: { final_status: quote.status } };
  }
  if (!quote.expires_at) {
    return { thought: "Quote has no expires_at; cannot nudge.", action: "give_up", action_payload: { reason: "no_expires_at" } };
  }
  const now = Date.now();
  const expiresMs = new Date(quote.expires_at).getTime();
  const msUntilExpiry = expiresMs - now;
  if (msUntilExpiry <= 0) {
    // Already expired; wait for the daily expiry cron to flip
    // status. The handler doesn't try to race the cron.
    return { thought: "Quote already past expires_at; wait for daily expiry cron.", action: "mark_complete", action_payload: { reason: "past_expires_at" } };
  }
  // 3-day window. Outside it, sleep until 3 days before expiry.
  if (msUntilExpiry > 3 * DAYS) {
    const sleepHours = Math.max(1, Math.round((msUntilExpiry - 3 * DAYS) / HOURS));
    return { thought: "Outside 3-day nudge window; sleeping " + sleepHours + "h.", action: "noop", action_payload: { sleep_hours: sleepHours } };
  }
  // Cooldown: don't nudge twice within 48h.
  const lastTouch = goal.last_action_at ? new Date(goal.last_action_at).getTime() : 0;
  const sinceTouch = now - lastTouch;
  const cooldownMs = (goal.config?.cooldown_hours || 48) * HOURS;
  if (sinceTouch < cooldownMs) {
    return { thought: "Within nudge cooldown.", action: "noop", action_payload: { sleep_hours: Math.round((cooldownMs - sinceTouch) / HOURS) } };
  }
  // Resolve recipient: customer_contact preferred, fall back to
  // customer.contact_email.
  let recipient = null;
  let recipientName = null;
  if (quote.customer_contact_id) {
    const c = await svc.from("customer_contacts").select("email, name").eq("id", quote.customer_contact_id).maybeSingle();
    if (c.data?.email) { recipient = c.data.email; recipientName = c.data.name || null; }
  }
  if (!recipient && quote.customer_id) {
    const cust = await svc.from("customers").select("contact_email, customer_name").eq("id", quote.customer_id).maybeSingle();
    if (cust.data?.contact_email) {
      recipient = cust.data.contact_email;
      recipientName = recipientName || cust.data.customer_name;
    }
  }
  if (!recipient) {
    return { thought: "No recipient on file for the quote's customer; escalating.", action: "escalate", action_payload: { reason: "no_recipient", quote_id: quote.id } };
  }
  const daysLeft = Math.max(1, Math.round(msUntilExpiry / DAYS));
  const ref = quote.quote_number + " v" + quote.version;
  const greet = "Hello" + (recipientName ? " " + recipientName : "") + ",";
  const subject = "Reminder: quotation " + ref + " expires in " + daysLeft + " day" + (daysLeft === 1 ? "" : "s");
  const body = [
    greet,
    "",
    "Just a heads up that quotation " + ref + " for "
      + (quote.currency || "INR") + " " + (Number(quote.grand_total) || 0).toFixed(2)
      + " is set to expire on " + new Date(quote.expires_at).toLocaleDateString("en-US") + ".",
    "",
    "Let us know if you'd like to accept it as-is, or if there's anything we can revise to move things forward.",
    "",
    "Happy to extend the validity if you need more time.",
  ].join("\n");
  return {
    thought: "Sending expiring-quote nudge to " + recipient + " (" + daysLeft + "d left)",
    action: "send_email",
    action_payload: {
      kind: "quote_expiring_nudge",
      object_type: "quote",
      object_id: quote.id,
      to: recipient,
      subject,
      body,
    },
  };
};
