// supplier_ack_followup
//
// Audit P8.3.1. Goal: chase a supplier that has not acknowledged a
// source_pos within N business days. Lifecycle:
//
//   - source_pos.status SENT and ack_received_at null past the
//     cutoff -> send_email nudge to the supplier contact.
//   - status moved to ACKNOWLEDGED / FULFILLED / CANCELLED -> mark_complete.
//   - past goal.due_at without ack -> escalate.
//   - within cooldown -> noop.

const HOURS = 60 * 60 * 1000;

const TERMINAL = new Set(["ACKNOWLEDGED", "PARTIAL_ACK", "FULFILLED", "CANCELLED"]);

export const supplierAckFollowup = async (goal, ctx) => {
  const svc = ctx.svc;
  const r = await svc.from("source_pos")
    .select("id, status, reference, supplier, supplier_contact_email, ack_received_at, sent_at")
    .eq("tenant_id", goal.tenant_id)
    .eq("id", goal.object_id)
    .maybeSingle();
  if (r.error) return { thought: "source_pos read failed: " + r.error.message, action: "noop", action_payload: {} };
  if (!r.data) return { thought: "source_po missing", action: "give_up", action_payload: { reason: "po_not_found" } };
  const po = r.data;

  if (TERMINAL.has(po.status)) {
    return { thought: "PO is " + po.status + ", goal complete.", action: "mark_complete", action_payload: { final_status: po.status } };
  }
  if (po.ack_received_at) {
    return { thought: "Ack already received at " + po.ack_received_at, action: "mark_complete", action_payload: {} };
  }
  if (goal.due_at && new Date(goal.due_at).getTime() < Date.now()) {
    return { thought: "Past due_at without ack; escalating.", action: "escalate", action_payload: { reason: "due_at_passed" } };
  }
  const lastTouch = goal.last_action_at ? new Date(goal.last_action_at).getTime() : 0;
  const cooldownMs = (goal.config?.cooldown_hours || 48) * HOURS;
  if (Date.now() - lastTouch < cooldownMs) {
    return { thought: "Within ack-followup cooldown.", action: "noop", action_payload: {} };
  }
  if (!po.supplier_contact_email) {
    return { thought: "No supplier contact email on file; escalating.", action: "escalate", action_payload: { reason: "no_supplier_email" } };
  }
  const greet = "Hello" + (po.supplier ? " " + po.supplier + " team" : "") + ",";
  const subject = "Following up on PO " + po.reference;
  const body = [
    greet, "",
    "We sent purchase order " + po.reference + " on " + (po.sent_at ? po.sent_at.slice(0, 10) : "(not recorded)") + " and have not received an acknowledgement yet.",
    "",
    "Could you confirm receipt and the expected fulfilment date at your earliest convenience?",
    "",
    "Reply to this email if anything was missing or needs clarification on the PO.",
  ].join("\n");
  return {
    thought: "Sending supplier ack followup to " + po.supplier_contact_email,
    action: "send_email",
    action_payload: {
      kind: "supplier_ack_followup",
      object_type: "source_po",
      object_id: po.id,
      to: po.supplier_contact_email,
      subject,
      body,
    },
  };
};
