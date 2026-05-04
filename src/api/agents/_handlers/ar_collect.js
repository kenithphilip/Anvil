// ar_collect_by_due_plus_7
//
// Goal: collect on an unpaid invoice within 7 days of its due date.
// Reads the target invoice (works on both `einvoices` for India and
// `invoices` for the rest of the world; goal.object_type tells us
// which), checks payment status, and decides next action:
//
// - status paid -> mark_complete
// - within cooldown -> noop
// - past due_at -> escalate
// - otherwise -> send_email at tier (gentle, firm, final)
//
// The runner queues a `communications` row with status=queued; the
// queued-comms reaper at the end of agents/run.js fires the actual
// SendGrid email (Phase 1.2 + 3) on the same tick.

const HOURS = 60 * 60 * 1000;

const isPaid = (status) => {
  if (!status) return false;
  const s = String(status).toLowerCase();
  return s === "paid";
};

// Pull the target invoice from whichever table the goal points at.
// Defaults to `invoices` (the post-Phase-2.1 generic table); falls
// back to `einvoices` for legacy India goals armed before this change.
const readInvoice = async (svc, goal) => {
  const objectType = goal.object_type || "invoice";
  if (objectType === "invoice") {
    const r = await svc
      .from("invoices")
      .select("id, status, due_date, grand_total, paid_amount, currency, customer_id, invoice_number")
      .eq("tenant_id", goal.tenant_id)
      .eq("id", goal.object_id)
      .maybeSingle();
    return { table: "invoices", data: r.data, error: r.error };
  }
  const r = await svc
    .from("einvoices")
    .select("id, status, due_date, total_value_inr, buyer_gstin, customer_id")
    .eq("tenant_id", goal.tenant_id)
    .eq("id", goal.object_id)
    .maybeSingle();
  return { table: "einvoices", data: r.data, error: r.error };
};

const recipientFor = async (svc, tenantId, customerId) => {
  if (!customerId) return null;
  const r = await svc
    .from("customers")
    .select("contact_email, customer_name")
    .eq("tenant_id", tenantId)
    .eq("id", customerId)
    .maybeSingle();
  return r.data || null;
};

export const arCollect = async (goal, ctx) => {
  const svc = ctx.svc;
  const result = await readInvoice(svc, goal);
  if (result.error) {
    return { thought: "Invoice read failed: " + result.error.message, action: "noop", action_payload: {} };
  }
  if (!result.data) {
    return { thought: "Target invoice missing", action: "give_up", action_payload: { reason: "invoice_not_found" } };
  }
  const inv = result.data;
  if (isPaid(inv.status)) {
    return { thought: "Invoice paid; goal succeeded.", action: "mark_complete", action_payload: { table: result.table } };
  }
  if (goal.due_at && new Date(goal.due_at).getTime() < Date.now()) {
    return {
      thought: "Past due_at without payment; escalating.",
      action: "escalate",
      action_payload: { reason: "due_at_passed", invoice_status: inv.status },
    };
  }
  const lastTouch = goal.last_action_at ? new Date(goal.last_action_at).getTime() : 0;
  const sinceTouch = Date.now() - lastTouch;
  const cooldownMs = (goal.config?.cooldown_hours || 96) * HOURS;
  if (sinceTouch < cooldownMs) {
    return { thought: "Within dunning cooldown.", action: "noop", action_payload: {} };
  }
  const tier = goal.step_count >= 4 ? "final" : goal.step_count >= 2 ? "firm" : "gentle";
  const customer = await recipientFor(svc, goal.tenant_id, inv.customer_id);
  if (!customer?.contact_email) {
    return {
      thought: "No customer contact email on file; escalating.",
      action: "escalate",
      action_payload: { reason: "no_recipient", invoice_id: inv.id },
    };
  }
  const total = inv.grand_total != null ? inv.grand_total : inv.total_value_inr;
  const dueDate = inv.due_date || "(not set)";
  const subject = tier === "final"
    ? "Final notice: invoice " + (inv.invoice_number || inv.id) + " is overdue"
    : tier === "firm"
      ? "Reminder: invoice " + (inv.invoice_number || inv.id) + " is past due"
      : "Friendly reminder: invoice " + (inv.invoice_number || inv.id) + " due " + dueDate;
  const body = [
    "Hello" + (customer.customer_name ? " " + customer.customer_name : "") + ",",
    "",
    tier === "final"
      ? "This is a final notice on invoice " + (inv.invoice_number || inv.id) + ". The amount of " + (inv.currency || "INR") + " " + (Number(total) || 0).toFixed(2) + " was due on " + dueDate + " and remains outstanding."
      : tier === "firm"
        ? "Following up on invoice " + (inv.invoice_number || inv.id) + ", " + (inv.currency || "INR") + " " + (Number(total) || 0).toFixed(2) + ", due " + dueDate + ". Please confirm payment or share an updated remit date."
        : "Quick reminder that invoice " + (inv.invoice_number || inv.id) + " (" + (inv.currency || "INR") + " " + (Number(total) || 0).toFixed(2) + ") is due " + dueDate + ".",
    "",
    "Reply to this email if anything is blocking payment; happy to help.",
  ].join("\n");
  return {
    thought: "Sending " + tier + " AR reminder to " + customer.contact_email,
    action: "send_email",
    action_payload: {
      kind: "ar_reminder",
      tier,
      object_type: result.table === "invoices" ? "invoice" : "einvoice",
      object_id: inv.id,
      to: customer.contact_email,
      subject,
      body,
      hint: tier,
    },
  };
};
