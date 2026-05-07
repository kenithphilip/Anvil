// quote_accept_within_14d
//
// Goal: nudge a draft / sent quote toward acceptance within 14 days
// of the goal's start. The handler reads the target row, checks
// status, and decides:
//
// - terminal status reached -> mark_complete
// - past due_at -> give_up + escalate to owner
// - within cooldown -> noop
// - otherwise -> send_email
//
// Audit P10 (May 2026). Accepts both shapes:
//
//   - object_type='quote' (new): goal.object_id is a quotes.id;
//     status reads from the quote_status enum. Terminal:
//     ACCEPTED, CONVERTED. Goal completes when the customer
//     actually accepts the quote, not when an order is approved.
//
//   - object_type='order' (legacy): goal.object_id is an orders.id
//     for orders carrying a quote_number; terminal is
//     APPROVED / EXPORTED_TO_TALLY / PAID. Kept for goals
//     created before migration 068 promoted quotes to a
//     first-class object.
//
// Defaults to the quote shape when object_type is missing
// because the autonomy work creates only quote-shaped goals
// going forward.

const HOURS = 60 * 60 * 1000;

const TERMINAL_QUOTE = ["ACCEPTED", "CONVERTED"];
const TERMINAL_ORDER = ["APPROVED", "EXPORTED_TO_TALLY", "PAID"];

const readTargetQuote = async (svc, goal) => {
  const r = await svc.from("quotes")
    .select("id, status, quote_number, version, customer_id, customer:customer_id(customer_name, contact_email), customer_contact:customer_contact_id(email, name), updated_at")
    .eq("tenant_id", goal.tenant_id)
    .eq("id", goal.object_id)
    .maybeSingle();
  if (r.error) return { error: r.error.message };
  if (!r.data) return { missing: true };
  return {
    row: {
      id: r.data.id,
      status: r.data.status,
      reference: r.data.quote_number + (r.data.version > 1 ? " v" + r.data.version : ""),
      customer_name: r.data.customer?.customer_name || null,
      contact_email: r.data.customer_contact?.email || r.data.customer?.contact_email || null,
      object_type: "quote",
    },
    terminal: TERMINAL_QUOTE,
  };
};

const readTargetOrder = async (svc, goal) => {
  const r = await svc.from("orders")
    .select("id, status, customer_id, customer:customer_id(customer_name, contact_email), updated_at, po_number, quote_number")
    .eq("tenant_id", goal.tenant_id)
    .eq("id", goal.object_id)
    .maybeSingle();
  if (r.error) return { error: r.error.message };
  if (!r.data) return { missing: true };
  return {
    row: {
      id: r.data.id,
      status: r.data.status,
      reference: r.data.quote_number || r.data.po_number || ("draft " + String(r.data.id || "").slice(0, 8)),
      customer_name: r.data.customer?.customer_name || null,
      contact_email: r.data.customer?.contact_email || null,
      object_type: "order",
    },
    terminal: TERMINAL_ORDER,
  };
};

export const quoteAccept = async (goal, ctx) => {
  const svc = ctx.svc;
  const isQuoteShaped = goal.object_type !== "order";
  const reader = isQuoteShaped ? readTargetQuote : readTargetOrder;
  const r = await reader(svc, goal);
  if (r.error) {
    return { thought: "Target read failed: " + r.error, action: "noop", action_payload: {} };
  }
  if (r.missing) {
    return { thought: "Target missing", action: "give_up", action_payload: { reason: "target_not_found" } };
  }
  const o = r.row;
  if (r.terminal.includes(o.status)) {
    return {
      thought: o.object_type + " is " + o.status + ", goal succeeded.",
      action: "mark_complete",
      action_payload: { final_status: o.status },
    };
  }
  if (goal.due_at && new Date(goal.due_at).getTime() < Date.now()) {
    return {
      thought: "Past due_at without acceptance; escalating to owner.",
      action: "escalate",
      action_payload: { reason: "due_at_passed", final_status: o.status },
    };
  }

  const lastTouch = goal.last_action_at ? new Date(goal.last_action_at).getTime() : 0;
  const sinceTouch = Date.now() - lastTouch;
  const cooldownMs = (goal.config?.cooldown_hours || 72) * HOURS;
  if (sinceTouch < cooldownMs) {
    return {
      thought: "Within cooldown; will check back later.",
      action: "noop",
      action_payload: { sleep_hours: Math.round((cooldownMs - sinceTouch) / HOURS) },
    };
  }

  const recipient = o.contact_email;
  if (!recipient) {
    return {
      thought: "No customer contact email on file; escalating to owner.",
      action: "escalate",
      action_payload: { reason: "no_recipient" },
    };
  }
  // Audit P1.4 (May 2026): the runner falls back to action_payload.hint
  // when body is absent. Previously this handler returned only a hint
  // ("Polite, concise quote nudge. Reference any open questions.")
  // which then shipped as the customer email body verbatim. Provide
  // a real templated body. The deeper "LLM-drafted bodies" work is
  // Phase 6 of the audit roadmap; this is the regression fix.
  const ref = o.reference;
  const greet = "Hello" + (o.customer_name ? " " + o.customer_name : "") + ",";
  const body = [
    greet,
    "",
    "We're following up on quote " + ref + ".",
    "Let us know if you have any questions or if there's anything we can adjust to move this forward.",
    "",
    "Happy to set up a quick call if that's easier.",
    "",
    "Thanks,",
    "The team",
  ].join("\n");
  return {
    thought: "Drafting follow-up email for " + (o.customer_name || "customer"),
    action: "send_email",
    action_payload: {
      kind: "quote_followup",
      // Carry both ids so downstream wiring can attribute the
      // communication correctly regardless of which shape the
      // goal took.
      ...(o.object_type === "quote" ? { quote_id: o.id } : { order_id: o.id }),
      to: recipient,
      subject: "Following up on " + ref,
      body,
    },
  };
};
