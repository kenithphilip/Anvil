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

// Audit P4.8: prefer the customer_contacts row that's marked
// is_primary or has role='accounts'/'primary'/'finance'. Falls
// back to the legacy customers.contact_email.
//
// Returns { contact_email, contact_name, customer_name }.
const recipientFor = async (svc, tenantId, customerId) => {
  if (!customerId) return null;
  const cust = await svc.from("customers")
    .select("contact_email, customer_name")
    .eq("tenant_id", tenantId)
    .eq("id", customerId)
    .maybeSingle();
  if (cust.error) return null;
  const customerName = cust.data?.customer_name || null;

  const PREFERRED_ROLES = ["accounts", "finance", "primary"];
  // Try contacts ordered by: is_primary first, then preferred
  // role first (we sort post-fetch since Supabase JS lacks
  // CASE-based ordering), then most-recently-updated.
  const cts = await svc.from("customer_contacts")
    .select("name, email, role, is_primary, updated_at")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .not("email", "is", null)
    .limit(20);
  const candidates = (cts.data || []).slice().sort((a, b) => {
    if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
    const aRole = PREFERRED_ROLES.indexOf(a.role || "");
    const bRole = PREFERRED_ROLES.indexOf(b.role || "");
    const aRoleOk = aRole >= 0 ? aRole : 99;
    const bRoleOk = bRole >= 0 ? bRole : 99;
    if (aRoleOk !== bRoleOk) return aRoleOk - bRoleOk;
    return String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
  });
  if (candidates.length) {
    const top = candidates[0];
    return {
      contact_email: top.email,
      contact_name: top.name || customerName,
      customer_name: customerName,
    };
  }
  return {
    contact_email: cust.data?.contact_email || null,
    contact_name: customerName,
    customer_name: customerName,
  };
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
  const recipient = await recipientFor(svc, goal.tenant_id, inv.customer_id);
  if (!recipient?.contact_email) {
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
  // Audit P4.8: greet by the contact's name (e.g., "Hello
  // Priya,") when we know who in the customer org we're writing
  // to, otherwise fall back to the customer/company name.
  const greetingTo = recipient.contact_name || recipient.customer_name || "";
  const body = [
    "Hello" + (greetingTo ? " " + greetingTo : "") + ",",
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
    thought: "Sending " + tier + " AR reminder to " + recipient.contact_email,
    action: "send_email",
    action_payload: {
      kind: "ar_reminder",
      tier,
      object_type: result.table === "invoices" ? "invoice" : "einvoice",
      object_id: inv.id,
      to: recipient.contact_email,
      subject,
      body,
      hint: tier,
    },
  };
};
