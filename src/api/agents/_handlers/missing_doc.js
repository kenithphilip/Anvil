// missing_doc_followup
//
// Goal: drive an order with missing required documents to a complete
// intake state. Reads the target order, checks which document roles
// are missing, and either nudges the customer or marks the goal
// complete.
//
// config.required_roles: array of doc roles that must be present, e.g.
// ["purchase_order", "spec_sheet"]. If missing, defaults to
// ["purchase_order"].

const HOURS = 60 * 60 * 1000;

export const missingDoc = async (goal, ctx) => {
  const svc = ctx.svc;
  const required = Array.isArray(goal.config?.required_roles) && goal.config.required_roles.length
    ? goal.config.required_roles
    : ["purchase_order"];
  const order = await svc
    .from("orders")
    .select("id, status, customer:customer_id(contact_email, customer_name), documents(id, role)")
    .eq("tenant_id", goal.tenant_id)
    .eq("id", goal.object_id)
    .maybeSingle();
  if (order.error) {
    return { thought: "Order read failed: " + order.error.message, action: "noop", action_payload: {} };
  }
  if (!order.data) {
    return { thought: "Target order missing", action: "give_up", action_payload: { reason: "order_not_found" } };
  }
  const have = new Set((order.data.documents || []).map((d) => d.role));
  const missing = required.filter((r) => !have.has(r));
  if (missing.length === 0) {
    return { thought: "All required documents present.", action: "mark_complete", action_payload: { roles: required } };
  }
  if (goal.due_at && new Date(goal.due_at).getTime() < Date.now()) {
    return { thought: "Past due_at; escalating.", action: "escalate", action_payload: { missing } };
  }
  const lastTouch = goal.last_action_at ? new Date(goal.last_action_at).getTime() : 0;
  const sinceTouch = Date.now() - lastTouch;
  const cooldownMs = (goal.config?.cooldown_hours || 48) * HOURS;
  if (sinceTouch < cooldownMs) {
    return { thought: "Within cooldown.", action: "noop", action_payload: { missing } };
  }
  const recipient = order.data.customer?.contact_email;
  if (!recipient) {
    return { thought: "No recipient on file.", action: "escalate", action_payload: { reason: "no_recipient", missing } };
  }
  // Audit P1.4 (May 2026): the runner used to fall back to
  // action_payload.hint for the email body, which meant the literal
  // string "Polite request for the listed documents; keep short."
  // arrived in the customer's inbox. Provide a real templated body.
  // LLM-drafted variants land in Phase 6.
  const customerName = order.data.customer?.customer_name || null;
  const greet = "Hello" + (customerName ? " " + customerName : "") + ",";
  const list = missing.map((r) => "  - " + String(r).replace(/_/g, " ")).join("\n");
  const ref = order.data.po_number || ("order " + String(order.data.id || "").slice(0, 8));
  const subject = "Documents needed for " + ref;
  const body = [
    greet,
    "",
    "To process " + ref + " we still need the following from you:",
    list,
    "",
    "Please reply to this email with the documents attached, or let us know if any of these are no longer applicable.",
    "",
    "Thanks,",
    "The team",
  ].join("\n");
  return {
    thought: "Requesting missing documents from customer.",
    action: "send_email",
    action_payload: {
      kind: "missing_doc_request",
      order_id: order.data.id,
      to: recipient,
      missing_roles: missing,
      subject,
      body,
    },
  };
};
