// delivery_eta_check
//
// Audit P8.3.2. Goal: ask a supplier for the latest delivery ETA on
// an acknowledged source_pos as the promised date approaches.
//
// The promised date IS the supplier's acknowledged_eta (a real column on
// source_pos), and the supplier contact IS primary_contact_email; the
// terminal states are the source_po_status enum's RECEIVED/CLOSED/CANCELLED
// (there is no FULFILLED). An earlier draft read promised_date /
// supplier_contact_email, which never existed -> the handler always no-op'd.
//
//   - Status RECEIVED / CLOSED / CANCELLED -> mark_complete.
//   - acknowledged_eta < now() and no shipment -> escalate (slipped).
//   - acknowledged_eta - now() within `eta_check_days_before` -> send_email.
//   - otherwise -> noop with sleep.

const HOURS = 60 * 60 * 1000;
const DAYS = 24 * HOURS;

export const deliveryEtaCheck = async (goal, ctx) => {
  const svc = ctx.svc;
  const r = await svc.from("source_pos")
    .select("id, status, reference, supplier, primary_contact_email, acknowledged_eta, ack_received_at")
    .eq("tenant_id", goal.tenant_id)
    .eq("id", goal.object_id)
    .maybeSingle();
  if (r.error) return { thought: "source_pos read failed: " + r.error.message, action: "noop", action_payload: {} };
  if (!r.data) return { thought: "source_po missing", action: "give_up", action_payload: { reason: "po_not_found" } };
  const po = r.data;

  if (["RECEIVED", "CLOSED", "CANCELLED"].includes(po.status)) {
    return { thought: "PO is " + po.status + ", goal complete.", action: "mark_complete", action_payload: { final_status: po.status } };
  }
  if (!po.acknowledged_eta) {
    return { thought: "PO has no acknowledged ETA; nothing to chase.", action: "noop", action_payload: { sleep_hours: 24 } };
  }
  const now = Date.now();
  const promisedMs = new Date(po.acknowledged_eta).getTime();
  const msUntilPromise = promisedMs - now;
  if (msUntilPromise < 0) {
    return { thought: "Promised date passed without fulfilment; escalating.", action: "escalate", action_payload: { reason: "promised_date_passed", days_overdue: Math.round(-msUntilPromise / DAYS) } };
  }
  const checkBeforeDays = goal.config?.eta_check_days_before || 5;
  if (msUntilPromise > checkBeforeDays * DAYS) {
    return { thought: "Outside ETA-check window; sleeping.", action: "noop", action_payload: { sleep_hours: Math.max(1, Math.round((msUntilPromise - checkBeforeDays * DAYS) / HOURS)) } };
  }
  const lastTouch = goal.last_action_at ? new Date(goal.last_action_at).getTime() : 0;
  const cooldownMs = (goal.config?.cooldown_hours || 72) * HOURS;
  if (now - lastTouch < cooldownMs) {
    return { thought: "Within ETA-check cooldown.", action: "noop", action_payload: {} };
  }
  if (!po.primary_contact_email) {
    return { thought: "No supplier contact email on file; escalating.", action: "escalate", action_payload: { reason: "no_supplier_email" } };
  }
  const daysLeft = Math.max(0, Math.round(msUntilPromise / DAYS));
  const subject = "ETA check on PO " + po.reference;
  const body = [
    "Hello" + (po.supplier ? " " + po.supplier + " team" : "") + ",",
    "",
    "PO " + po.reference + " is promised for " + po.acknowledged_eta + " (" + daysLeft + " day" + (daysLeft === 1 ? "" : "s") + " from today).",
    "",
    "Could you confirm whether the goods are still on track for that date, or share an updated ETA if anything has shifted?",
    "",
    "If shipment has already gone, please reply with the dispatch reference so we can update our records.",
  ].join("\n");
  return {
    thought: "Sending ETA check to " + po.primary_contact_email + " (" + daysLeft + "d to promised date)",
    action: "send_email",
    action_payload: {
      kind: "delivery_eta_check",
      object_type: "source_po",
      object_id: po.id,
      to: po.primary_contact_email,
      subject,
      body,
    },
  };
};
