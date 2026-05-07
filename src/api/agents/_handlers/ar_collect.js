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
//
// Audit P6.7: bodies are LLM-drafted via _lib/dunning-drafter.js
// using the customer's payment history + the prior thread + the
// tier; falls back to the previous templated body on any drafter
// failure.

import { draftDunningEmail } from "../../_lib/dunning-drafter.js";
import { issuePayLinkForInvoice, substitutePayLink } from "../../_lib/pay-link.js";

const HOURS = 60 * 60 * 1000;
const DAY = 24 * HOURS;
// Audit P8.1. Kept for the templated-body fallback path so the
// substitution helper has a consistent token to look for.
const PAY_LINK_PLACEHOLDER = "[PAY_LINK]";

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
    .select("contact_email, customer_name, tier")
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

// Audit P6.7: pull the last 5 paid invoices for the customer so
// the drafter can recognise reliable payers vs chronic late ones.
const fetchPaymentHistory = async (svc, tenantId, customerId) => {
  if (!customerId) return [];
  const r = await svc.from("invoices")
    .select("invoice_number, due_date, paid_at, status")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("status", "paid")
    .order("paid_at", { ascending: false })
    .limit(5);
  if (r.error) return [];
  return (r.data || []).map((inv) => {
    const due = inv.due_date ? new Date(inv.due_date).getTime() : null;
    const paid = inv.paid_at ? new Date(inv.paid_at).getTime() : null;
    const lateDays = (due && paid) ? Math.round((paid - due) / DAY) : null;
    return {
      invoice_number: inv.invoice_number,
      due_date: inv.due_date,
      paid_at: inv.paid_at,
      late_days: lateDays,
    };
  });
};

// Audit P6.7: pull recent inbound emails on the same invoice's
// thread so the drafter can acknowledge prior commitments.
const fetchPriorThread = async (svc, tenantId, invoiceId) => {
  if (!invoiceId) return [];
  // We don't have a direct inbound_emails -> invoice link today.
  // Best-effort match via communications table on object_type=
  // invoice + object_id; keep it scoped + small to bound the
  // prompt size.
  const r = await svc.from("communications")
    .select("direction, subject, body, created_at, sent_at")
    .eq("tenant_id", tenantId)
    .eq("object_type", "invoice")
    .eq("object_id", invoiceId)
    .order("created_at", { ascending: false })
    .limit(5);
  if (r.error) return [];
  return (r.data || []).map((c) => ({
    direction: c.direction || "out",
    sent_at: c.sent_at || c.created_at,
    received_at: c.direction === "inbound" ? c.created_at : null,
    excerpt: String(c.body || "").slice(0, 200),
  }));
};

const renderTemplatedBody = (tier, inv, customerName) => {
  const total = inv.grand_total != null ? inv.grand_total : inv.total_value_inr;
  const dueDate = inv.due_date || "(not set)";
  const greet = "Hello" + (customerName ? " " + customerName : "") + ",";
  const middle = tier === "final"
    ? "This is a final notice on invoice " + (inv.invoice_number || inv.id) + ". The amount of " + (inv.currency || "INR") + " " + (Number(total) || 0).toFixed(2) + " was due on " + dueDate + " and remains outstanding."
    : tier === "firm"
      ? "Following up on invoice " + (inv.invoice_number || inv.id) + ", " + (inv.currency || "INR") + " " + (Number(total) || 0).toFixed(2) + ", due " + dueDate + ". Please confirm payment or share an updated remit date."
      : "Quick reminder that invoice " + (inv.invoice_number || inv.id) + " (" + (inv.currency || "INR") + " " + (Number(total) || 0).toFixed(2) + ") is due " + dueDate + ".";
  // Audit P8.1: include the [PAY_LINK] placeholder so the
  // ar_collect substitution layer treats templated and LLM-drafted
  // bodies identically.
  return [
    greet, "", middle, "",
    "Pay now: " + PAY_LINK_PLACEHOLDER, "",
    "Reply to this email if anything is blocking payment; happy to help.",
  ].join("\n");
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
  // Audit P6.7: try the LLM drafter first; fall back to the
  // legacy templated body on any drafter failure so dunning
  // never stops because the drafter did. The drafter takes
  // payment history + prior thread + customer + tier and returns
  // a personalised body with a [PAY_LINK] placeholder.
  const dueDate = inv.due_date || "(not set)";
  const fallbackSubject = tier === "final"
    ? "Final notice: invoice " + (inv.invoice_number || inv.id) + " is overdue"
    : tier === "firm"
      ? "Reminder: invoice " + (inv.invoice_number || inv.id) + " is past due"
      : "Friendly reminder: invoice " + (inv.invoice_number || inv.id) + " due " + dueDate;
  // Audit P4.8: greet by the contact's name (e.g., "Hello
  // Priya,") when we know who in the customer org we're writing
  // to, otherwise fall back to the customer/company name.
  const greetingTo = recipient.contact_name || recipient.customer_name || "";

  let subject = fallbackSubject;
  let body = renderTemplatedBody(tier, inv, greetingTo);
  let drafter_used = "templated";

  try {
    const paymentHistory = await fetchPaymentHistory(svc, goal.tenant_id, inv.customer_id);
    const priorThread = await fetchPriorThread(svc, goal.tenant_id, inv.id);
    const drafted = await draftDunningEmail(svc, goal.tenant_id, {
      tier,
      invoice: inv,
      customer: { customer_name: recipient.customer_name, tier: recipient.tier },
      contact: { name: recipient.contact_name || recipient.customer_name },
      payment_history: paymentHistory,
      prior_thread: priorThread,
    });
    if (drafted.ok && drafted.body) {
      subject = drafted.subject || fallbackSubject;
      body = drafted.body;
      drafter_used = "llm:" + (drafted.model || "sonnet");
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[ar_collect] dunning drafter failed; using templated body: " + (err.message || err));
  }

  // Audit P8.1: issue a fresh per-invoice portal token and
  // substitute [PAY_LINK]. The token has scope ['invoices', 'pay']
  // and a 30-day TTL so the customer can pay through /api/portal/pay
  // straight from the dunning email. Best-effort: when the insert
  // fails or PORTAL_BASE_URL isn't configured, the substitution
  // helper drops a "(payment link unavailable)" hint instead of
  // a literal placeholder.
  const payLink = await issuePayLinkForInvoice(svc, goal.tenant_id, inv, {
    email: recipient.contact_email,
  });
  body = substitutePayLink(body, payLink?.url);

  return {
    thought: "Sending " + tier + " AR reminder to " + recipient.contact_email + " (drafter=" + drafter_used + ", pay_link=" + (payLink?.url ? "issued" : "missing") + ")",
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
      drafter: drafter_used,
      portal_token_id: payLink?.id || null,
      portal_url: payLink?.url || null,
    },
  };
};
