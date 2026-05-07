// paid_partial_followup
//
// Audit P6.11. Goal: when an invoice has been paid partially
// (60-99% of grand_total), send a soft thank-you-and-balance
// reminder rather than the standard ar_collect dunning. The
// audit flagged that ar_collect runs the same loop on
// status != 'paid' regardless of partial payment, which means
// a customer who paid 80% gets the same firm-tier reminder as
// one who paid nothing.

const HOURS = 60 * 60 * 1000;

const fetchInvoice = async (svc, goal) => {
  const r = await svc.from("invoices")
    .select("id, status, due_date, grand_total, paid_amount, currency, customer_id, invoice_number")
    .eq("tenant_id", goal.tenant_id)
    .eq("id", goal.object_id)
    .maybeSingle();
  return r.data || null;
};

const fetchCustomer = async (svc, tenantId, customerId) => {
  if (!customerId) return null;
  const r = await svc.from("customers")
    .select("contact_email, customer_name")
    .eq("tenant_id", tenantId).eq("id", customerId).maybeSingle();
  return r.data || null;
};

export const paidPartialFollowup = async (goal, ctx) => {
  const svc = ctx.svc;
  const inv = await fetchInvoice(svc, goal);
  if (!inv) {
    return { thought: "Target invoice missing", action: "give_up", action_payload: { reason: "invoice_not_found" } };
  }
  if (inv.status === "paid") {
    return { thought: "Invoice fully paid; goal complete.", action: "mark_complete", action_payload: { final_status: "paid" } };
  }
  const grand = Number(inv.grand_total) || 0;
  const paid = Number(inv.paid_amount) || 0;
  if (grand <= 0) {
    return { thought: "Invoice grand_total is zero or null; nothing to follow up.", action: "give_up", action_payload: { reason: "no_grand_total" } };
  }
  const ratio = paid / grand;
  if (ratio < 0.6) {
    // Not partial enough; the standard ar_collect goal handles
    // this customer.
    return { thought: "Paid ratio " + ratio.toFixed(2) + " < 0.6; out of paid_partial scope.", action: "noop", action_payload: { sleep_hours: 24 } };
  }
  if (ratio >= 1) {
    // Edge case: paid_amount over grand_total. Mark complete.
    return { thought: "Paid >= grand_total; treating as complete.", action: "mark_complete", action_payload: { final_status: "paid" } };
  }
  // Cooldown 96h to match the normal ar_collect cadence.
  const lastTouch = goal.last_action_at ? new Date(goal.last_action_at).getTime() : 0;
  const sinceTouch = Date.now() - lastTouch;
  const cooldownMs = (goal.config?.cooldown_hours || 96) * HOURS;
  if (sinceTouch < cooldownMs) {
    return { thought: "Within partial-paid follow-up cooldown.", action: "noop", action_payload: { sleep_hours: Math.round((cooldownMs - sinceTouch) / HOURS) } };
  }
  const customer = await fetchCustomer(svc, goal.tenant_id, inv.customer_id);
  if (!customer?.contact_email) {
    return { thought: "No customer contact email on file; escalating.", action: "escalate", action_payload: { reason: "no_recipient", invoice_id: inv.id } };
  }
  const balance = Math.max(0, grand - paid);
  const ref = inv.invoice_number || inv.id;
  const subject = "Thanks for the partial payment on invoice " + ref;
  const body = [
    "Hello" + (customer.customer_name ? " " + customer.customer_name : "") + ",",
    "",
    "Thanks for the partial payment on invoice " + ref + ".",
    "We've recorded " + (inv.currency || "INR") + " " + paid.toFixed(2) + " against the total of "
      + (inv.currency || "INR") + " " + grand.toFixed(2) + ".",
    "",
    "Could you let us know when we can expect the remaining "
      + (inv.currency || "INR") + " " + balance.toFixed(2) + "?",
    "",
    "Reply to this email if anything is blocking; happy to help.",
  ].join("\n");
  return {
    thought: "Sending paid-partial follow-up to " + customer.contact_email + " (paid " + (ratio * 100).toFixed(1) + "%)",
    action: "send_email",
    action_payload: {
      kind: "paid_partial_followup",
      object_type: "invoice",
      object_id: inv.id,
      to: customer.contact_email,
      subject,
      body,
    },
  };
};
