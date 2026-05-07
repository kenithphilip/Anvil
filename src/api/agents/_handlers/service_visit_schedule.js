// service_visit_schedule
//
// Audit P8.3.3. Goal: schedule the next preventive service visit by
// emailing the customer's site contact 14 days before the AMC
// schedule's scheduled_date. Reads `amc_schedules` (the row whose id
// is goal.object_id), checks status:
//
//   - status not SCHEDULED -> mark_complete (visit was created or
//     skipped or cancelled by the AMC cron / operator).
//   - scheduled_date past -> escalate (we missed the window).
//   - within `lead_time_days` of scheduled_date -> send_email.
//   - otherwise sleep until the lead-time window opens.

const HOURS = 60 * 60 * 1000;
const DAYS = 24 * HOURS;

export const serviceVisitSchedule = async (goal, ctx) => {
  const svc = ctx.svc;
  const r = await svc.from("amc_schedules")
    .select("id, status, customer_id, customer_location_id, scheduled_date, visit_label, visit_type")
    .eq("tenant_id", goal.tenant_id)
    .eq("id", goal.object_id)
    .maybeSingle();
  if (r.error) return { thought: "amc read failed: " + r.error.message, action: "noop", action_payload: {} };
  if (!r.data) return { thought: "amc schedule missing", action: "give_up", action_payload: { reason: "amc_not_found" } };
  const sched = r.data;

  if (sched.status !== "SCHEDULED") {
    return { thought: "AMC schedule is " + sched.status + ", goal complete.", action: "mark_complete", action_payload: { final_status: sched.status } };
  }
  const now = Date.now();
  const dueMs = new Date(sched.scheduled_date).getTime();
  const msUntilDue = dueMs - now;
  if (msUntilDue < 0) {
    return { thought: "scheduled_date passed without visit; escalating.", action: "escalate", action_payload: { reason: "scheduled_date_passed" } };
  }
  const leadDays = goal.config?.lead_time_days || 14;
  if (msUntilDue > leadDays * DAYS) {
    return { thought: "Outside lead-time window; sleeping.", action: "noop", action_payload: { sleep_hours: Math.max(1, Math.round((msUntilDue - leadDays * DAYS) / HOURS)) } };
  }
  const lastTouch = goal.last_action_at ? new Date(goal.last_action_at).getTime() : 0;
  const cooldownMs = (goal.config?.cooldown_hours || 96) * HOURS;
  if (now - lastTouch < cooldownMs) {
    return { thought: "Within service-schedule cooldown.", action: "noop", action_payload: {} };
  }
  // Pick recipient: prefer the customer_location's site contact,
  // fall back to the customer's primary contact.
  let recipient = null;
  let recipientName = null;
  if (sched.customer_location_id) {
    const loc = await svc.from("customer_locations")
      .select("contact_name, contact_email")
      .eq("id", sched.customer_location_id)
      .maybeSingle();
    if (loc.data?.contact_email) { recipient = loc.data.contact_email; recipientName = loc.data.contact_name; }
  }
  if (!recipient && sched.customer_id) {
    const c = await svc.from("customers")
      .select("contact_email, customer_name")
      .eq("id", sched.customer_id)
      .maybeSingle();
    if (c.data?.contact_email) {
      recipient = c.data.contact_email;
      recipientName = recipientName || c.data.customer_name;
    }
  }
  if (!recipient) {
    return { thought: "No service contact on file; escalating.", action: "escalate", action_payload: { reason: "no_recipient" } };
  }
  const daysLeft = Math.max(0, Math.round(msUntilDue / DAYS));
  const label = sched.visit_label || (sched.visit_type || "PREVENTIVE") + " visit";
  const subject = "Schedule confirmation: " + label + " in " + daysLeft + " day" + (daysLeft === 1 ? "" : "s");
  const body = [
    "Hello" + (recipientName ? " " + recipientName : "") + ",",
    "",
    "We're planning your next " + (sched.visit_type ? sched.visit_type.toLowerCase() : "service") + " visit for " + sched.scheduled_date + " (" + daysLeft + " day" + (daysLeft === 1 ? "" : "s") + " from today).",
    "",
    "Could you confirm the proposed date works, or suggest an alternative if it does not?",
    "",
    "If your site has any access requirements (gate pass, escort, PPE) please share them so the engineer arrives prepared.",
  ].join("\n");
  return {
    thought: "Sending service-visit schedule confirmation to " + recipient + " (" + daysLeft + "d to visit)",
    action: "send_email",
    action_payload: {
      kind: "service_visit_schedule",
      object_type: "amc_schedule",
      object_id: sched.id,
      to: recipient,
      subject,
      body,
    },
  };
};
