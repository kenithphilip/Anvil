// credit_review_request
//
// Audit P8.3.5. Goal: when a customer's outstanding AR is approaching
// or has exceeded their credit_limit, request finance to review the
// limit. Single email to ops (not to the customer); marks complete
// once a review row is recorded.

import { isMissingOwnerColumn } from "../../_lib/customer-owner.js";
import { resolveAssignee } from "../../_lib/assignee.js";

const HOURS = 60 * 60 * 1000;

const sumOutstanding = async (svc, tenantId, customerId) => {
  const inv = await svc.from("invoices")
    .select("grand_total, paid_amount, status")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId);
  if (inv.error) return 0;
  return (inv.data || [])
    .filter((i) => i.status !== "paid" && i.status !== "void")
    .reduce((s, i) => s + (Number(i.grand_total) || 0) - (Number(i.paid_amount) || 0), 0);
};

// The account owner's email. Auth users live in the auth schema, which
// PostgREST does not expose; this used to read a `users` table that does not
// exist, so the owner fallback could never produce a recipient.
//
// Only while the owner is still an APPROVED member of this tenant: an owner
// was a member when assigned, but membership can be revoked afterwards, and a
// credit-limit summary must not go to someone who has left.
//
// Returns { email } or { reason } for an answer, and THROWS when it could not
// find out: a failed membership read or auth lookup is a transient fault, not
// evidence that the owner left, so the caller retries instead of escalating
// with a reason that would be false.
const ownerRecipient = async (svc, tenantId, userId) => {
  if (!(await resolveAssignee(svc, tenantId, userId))) return { reason: "owner_not_member" };
  const { data, error } = await svc.auth.admin.getUserById(userId);
  if (error) throw new Error("could not read the owner's auth user: " + (error.message || String(error)));
  const email = data && data.user && data.user.email;
  return email ? { email } : { reason: "owner_has_no_email" };
};

const OWNER_REASON_THOUGHT = {
  owner_not_member: "the account owner is no longer an approved member of this tenant",
  owner_has_no_email: "the account owner has no email address on their login",
};

const readCustomer = (svc, goal, cols) => svc.from("customers")
  .select(cols)
  .eq("tenant_id", goal.tenant_id)
  .eq("id", goal.object_id)
  .maybeSingle();

export const creditReviewRequest = async (goal, ctx) => {
  const svc = ctx.svc;
  let r = await readCustomer(svc, goal, "id, customer_name, credit_limit, currency, owner_user_id");
  // owner_user_id arrives with migration 227. Before it is applied, selecting
  // it fails the whole read, and the review never runs. The owner is a
  // nullable ATTRIBUTE (it only picks a fallback recipient), so drop it and
  // read again rather than stall the agent.
  if (r.error && isMissingOwnerColumn(r.error)) {
    r = await readCustomer(svc, goal, "id, customer_name, credit_limit, currency");
  }
  if (r.error) return { thought: "customer read failed: " + r.error.message, action: "noop", action_payload: {} };
  if (!r.data) return { thought: "customer missing", action: "give_up", action_payload: { reason: "customer_not_found" } };
  const cust = r.data;
  if (!cust.credit_limit) {
    return { thought: "No credit_limit on file; nothing to review.", action: "give_up", action_payload: { reason: "no_credit_limit" } };
  }
  const outstanding = await sumOutstanding(svc, goal.tenant_id, cust.id);
  const ratio = outstanding / Number(cust.credit_limit);
  // Trigger threshold: 85%. Below that, sleep.
  if (ratio < 0.85) {
    return { thought: "Outstanding " + outstanding.toFixed(0) + " is " + (ratio * 100).toFixed(1) + "% of limit; below 85% threshold.", action: "noop", action_payload: { sleep_hours: 24 } };
  }
  const lastTouch = goal.last_action_at ? new Date(goal.last_action_at).getTime() : 0;
  const cooldownMs = (goal.config?.cooldown_hours || 168) * HOURS;
  if (Date.now() - lastTouch < cooldownMs) {
    return { thought: "Within credit-review cooldown.", action: "noop", action_payload: {} };
  }
  // Internal-only escalation: routed via the same send_email
  // pipeline but addressed to the operator's finance alias from
  // tenant_settings.finance_email if present, else the customer's
  // owner_user_id email.
  let recipient = null;
  const ts = await svc.from("tenant_settings").select("finance_email").eq("tenant_id", goal.tenant_id).maybeSingle();
  if (ts.data?.finance_email) recipient = ts.data.finance_email;
  let ownerReason = null;
  if (!recipient && cust.owner_user_id) {
    let o;
    try {
      o = await ownerRecipient(svc, goal.tenant_id, cust.owner_user_id);
    } catch (err) {
      // Same as a failed customer read above: try again next tick.
      return { thought: "account owner lookup failed: " + (err && err.message ? err.message : String(err)) + "; retrying.", action: "noop", action_payload: {} };
    }
    if (o.email) recipient = o.email;
    else ownerReason = o.reason;
  }
  if (!recipient && ownerReason) {
    return {
      thought: "No internal recipient: tenant_settings.finance_email is empty and " + OWNER_REASON_THOUGHT[ownerReason] + "; escalating.",
      action: "escalate",
      action_payload: { reason: ownerReason },
    };
  }
  if (!recipient) {
    return { thought: "No internal recipient (tenant_settings.finance_email + owner_user_id both empty); escalating.", action: "escalate", action_payload: { reason: "no_internal_recipient" } };
  }
  const subject = "Credit review request: " + cust.customer_name;
  const body = [
    "Internal: credit-limit review",
    "",
    "Customer: " + cust.customer_name,
    "Credit limit: " + (cust.currency || "INR") + " " + Number(cust.credit_limit).toFixed(2),
    "Outstanding AR: " + (cust.currency || "INR") + " " + outstanding.toFixed(2) + " (" + (ratio * 100).toFixed(1) + "% of limit)",
    "",
    "Please review the limit and confirm whether to extend, hold new orders, or unlock partial shipment. Reply with the decision so the agent can resume.",
  ].join("\n");
  return {
    thought: "Requesting credit review for " + cust.customer_name + " (utilisation=" + (ratio * 100).toFixed(0) + "%)",
    action: "send_email",
    action_payload: {
      kind: "credit_review_request",
      object_type: "customer",
      object_id: cust.id,
      to: recipient,
      subject,
      body,
      internal: true,
    },
  };
};
