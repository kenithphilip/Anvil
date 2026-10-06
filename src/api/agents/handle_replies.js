// GET or POST /api/agents/handle_replies
//
// Audit P6.8. The Phase 5 inbound classifier writes
// classified_intent on every email; this worker consumes
// payment_acknowledge / delivery_query / complaint intents and
// updates the matching agent_goals.
//
// Cron-only via Bearer CRON_SECRET (drains every 5 min from
// /api/cron/tick), plus a manual admin trigger.
//
// payment_acknowledge: pause the AR goal for 14 days so the
//   customer has time to actually pay; if the invoice hasn't
//   moved to status='paid' by then, dunning resumes.
//
// delivery_query: write a processing_event so an operator can
//   answer; do NOT modify the goal (the customer is asking, not
//   committing).
//
// complaint: write a high-severity processing_event for operator
//   triage; do NOT modify the goal.
//
// Each handled row is marked agent_reply_handled_at so a re-run
// is a no-op.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const CRON_SECRET = process.env.CRON_SECRET;
const BATCH_SIZE = 50;
const HOURS = 60 * 60 * 1000;

const ACTIONABLE_INTENTS = ["payment_acknowledge", "delivery_query", "complaint"];

const findOpenArGoal = async (svc, tenantId, customerId) => {
  if (!customerId) return null;
  // Goals are anchored to invoice/einvoice, not customer; we
  // join via the invoices table to locate one for this customer.
  const r = await svc.from("agent_goals")
    .select("id, goal_type, object_type, object_id, status, last_action_at, step_count, config")
    .eq("tenant_id", tenantId)
    .eq("goal_type", "ar_collect_by_due_plus_7")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(20);
  if (r.error || !r.data?.length) return null;
  // Filter to a goal whose target invoice belongs to this customer.
  for (const g of r.data) {
    if (g.object_type === "invoice") {
      const inv = await svc.from("invoices").select("customer_id, paid_amount, grand_total")
        .eq("tenant_id", tenantId).eq("id", g.object_id).maybeSingle();
      if (inv.data?.customer_id === customerId) {
        return { goal: g, invoice: inv.data };
      }
    } else {
      const inv = await svc.from("einvoices").select("customer_id")
        .eq("tenant_id", tenantId).eq("id", g.object_id).maybeSingle();
      if (inv.data?.customer_id === customerId) {
        return { goal: g, invoice: inv.data };
      }
    }
  }
  return null;
};

const pauseArGoal = async (svc, goal, days, reason) => {
  const next = new Date(Date.now() + days * 24 * HOURS).toISOString();
  await svc.from("agent_goals").update({
    next_run_at: next,
    last_action: "noop",
    updated_at: new Date().toISOString(),
  }).eq("id", goal.id);
  await svc.from("agent_steps").insert({
    tenant_id: goal.tenant_id,
    goal_id: goal.id,
    step_no: (goal.step_count || 0) + 1,
    thought: "Paused " + days + "d after inbound " + reason,
    action: "noop",
    action_payload: { reason, days },
    result: "ok",
    result_detail: "reply-driven pause",
  });
};

const handlePaymentAck = async (svc, email) => {
  const found = await findOpenArGoal(svc, email.tenant_id, email.customer_id);
  if (!found) return { kind: "no_open_goal" };
  await pauseArGoal(svc, found.goal, 14, "payment_acknowledge");
  return { kind: "paused_ar_goal", goal_id: found.goal.id, days: 14 };
};

const handleDeliveryQuery = async (svc, email) => {
  await svc.from("processing_events").insert({
    tenant_id: email.tenant_id,
    case_id: email.id,
    event_type: "inbound_delivery_query",
    object_type: "inbound_email",
    object_id: email.id,
    detail: { from: email.from_address, subject: email.subject, severity: "info" },
  });
  return { kind: "operator_event" };
};

const handleComplaint = async (svc, email) => {
  await svc.from("processing_events").insert({
    tenant_id: email.tenant_id,
    case_id: email.id,
    event_type: "inbound_complaint",
    object_type: "inbound_email",
    object_id: email.id,
    detail: { from: email.from_address, subject: email.subject, severity: "warn" },
  });
  return { kind: "operator_event_warn" };
};

const dispatchByIntent = async (svc, email) => {
  switch (email.classified_intent) {
    case "payment_acknowledge": return handlePaymentAck(svc, email);
    case "delivery_query":      return handleDeliveryQuery(svc, email);
    case "complaint":           return handleComplaint(svc, email);
    default: return { kind: "unsupported_intent" };
  }
};

const drainOnce = async (svc) => {
  const rows = await svc.from("inbound_emails")
    .select("id, tenant_id, from_address, subject, classified_intent, customer_id, customer_contact_id, received_at")
    .in("classified_intent", ACTIONABLE_INTENTS)
    .is("agent_reply_handled_at", null)
    .order("received_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (rows.error) throw new Error("inbound_emails read: " + rows.error.message);

  const results = [];
  for (const email of rows.data || []) {
    let outcome;
    try {
      outcome = await dispatchByIntent(svc, email);
    } catch (err) {
      outcome = { kind: "error", error: (err.message || String(err)).slice(0, 240) };
    }
    await svc.from("inbound_emails").update({
      agent_reply_handled_at: new Date().toISOString(),
      agent_reply_action: outcome.kind || "unknown",
    }).eq("id", email.id);
    await svc.from("audit_events").insert({
      tenant_id: email.tenant_id,
      action: "inbound_reply_handled",
      object_type: "inbound_email",
      object_id: email.id,
      detail: email.classified_intent + "::" + (outcome.kind || "?"),
    });
    results.push({ id: email.id, intent: email.classified_intent, ...outcome });
  }
  return {
    ran_at: new Date().toISOString(),
    considered: (rows.data || []).length,
    handled: results.length,
    results,
  };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const isCron = !!CRON_SECRET && auth === CRON_SECRET;
    const svc = serviceClient();
    if (isCron) {
      const out = await drainOnce(svc);
      return json(res, 200, out);
    }
    if (req.method !== "POST" && req.method !== "GET") {
      res.setHeader("Allow", "POST, GET");
      return json(res, 405, { error: { message: "Method not allowed" } });
    }
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const out = await drainOnce(svc);
    await recordAudit(ctx, {
      action: "inbound_reply_drain",
      objectType: "tenant",
      objectId: ctx.tenantId,
      detail: "considered=" + out.considered + " handled=" + out.handled,
    });
    return json(res, 200, out);
  } catch (err) { sendError(res, err); }
}
