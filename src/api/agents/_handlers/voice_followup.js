// voice_followup
//
// Goal: a previous voice call ended with the customer asking us to
// call back later (e.g. "I'm in a meeting, try me at 4 pm"). The
// runtime arms a goal targeting the original voice_calls row; this
// handler attempts the callback when the cooldown has elapsed.
//
// Decision tree:
//
//   - The original call's customer or contact has WITHDRAWN consent
//     since -> mark_complete (no recourse).
//   - Past due_at -> escalate (the operator picks it up).
//   - Within cooldown -> noop (sleep until next checkpoint).
//   - Otherwise -> emit a "place_outbound_call" action via the
//     action_payload. The runner consults /api/voice/outbound;
//     compliance gating happens there, not here.
//
// Audit: DEFERRED_ROADMAP §1 (voice AI). Closes the "voice
// follow-up" loop the design called out: when a real-time call
// asks us to call back, we don't lose the thread.

import { hasVoiceConsent } from "../../_lib/voice-compliance.js";

const HOURS = 60 * 60 * 1000;

export const voiceFollowup = async (goal, ctx) => {
  const svc = ctx.svc;
  const callQ = await svc.from("voice_calls")
    .select("id, status, direction, customer_id, callee_phone_number, caller_phone_number, summary, action_extracted, ended_at")
    .eq("tenant_id", goal.tenant_id)
    .eq("id", goal.object_id)
    .maybeSingle();
  if (callQ.error) {
    return { thought: "Call read failed: " + callQ.error.message, action: "noop", action_payload: {} };
  }
  if (!callQ.data) {
    return { thought: "Target voice_call missing", action: "give_up", action_payload: { reason: "call_not_found" } };
  }
  const call = callQ.data;

  // Did the call already produce a follow-up? If a NEWER outbound
  // call exists for the same callee from this tenant, the loop is
  // closed; mark complete.
  const target = call.direction === "outbound"
    ? call.callee_phone_number
    : call.caller_phone_number;

  // P1 from May 2026 critic: the header comment promised a withdrawn-
  // consent early-exit but the code went straight to the newer-call
  // dedup. A customer who explicitly opted out would still get a dial
  // attempt that the gate would bounce, and the goal would keep
  // retrying + escalating. Now: if consent is withdrawn for the
  // target number, complete the goal cleanly with the reason.
  if (target) {
    try {
      const c = await hasVoiceConsent(svc, { tenantId: goal.tenant_id, phoneNumber: target });
      if (!c.consented && c.reason === "withdrawn") {
        return {
          thought: "Customer withdrew voice consent for " + target + "; closing follow-up.",
          action: "mark_complete",
          action_payload: { reason: "consent_withdrawn", target },
        };
      }
    } catch (_e) {
      // Consent lookup failures are non-fatal here; fall through to
      // the dedup + cooldown logic. The /api/voice/outbound gate
      // re-checks consent before any actual dial.
    }
  }
  if (target) {
    const newer = await svc.from("voice_calls")
      .select("id, started_at, status")
      .eq("tenant_id", goal.tenant_id)
      .eq("direction", "outbound")
      .eq("callee_phone_number", target)
      .gt("started_at", call.ended_at || call.started_at)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (newer.data) {
      return {
        thought: "A subsequent outbound call (" + newer.data.id + ") already happened; closing.",
        action: "mark_complete",
        action_payload: { final_status: newer.data.status, follow_up_call_id: newer.data.id },
      };
    }
  }

  if (goal.due_at && new Date(goal.due_at).getTime() < Date.now()) {
    return {
      thought: "Past due_at without follow-up; escalating to owner.",
      action: "escalate",
      action_payload: { reason: "due_at_passed" },
    };
  }

  const lastTouch = goal.last_action_at ? new Date(goal.last_action_at).getTime() : 0;
  const sinceTouch = Date.now() - lastTouch;
  const cooldownMs = (goal.config?.cooldown_hours || 24) * HOURS;
  if (sinceTouch < cooldownMs) {
    return {
      thought: "Within cooldown; will check back later.",
      action: "noop",
      action_payload: { sleep_hours: Math.round((cooldownMs - sinceTouch) / HOURS) },
    };
  }

  if (!target) {
    return {
      thought: "No phone number to dial back; escalating.",
      action: "escalate",
      action_payload: { reason: "no_callee_number" },
    };
  }

  // Emit an instruction the runner can execute. The runner is the
  // component with HTTP access; we don't dial from inside the
  // handler (handlers are pure). The runner's action dispatcher
  // recognises "place_outbound_call" and POSTs to
  // /api/voice/outbound with the payload below.
  return {
    thought: "Re-dialing " + target + " for follow-up.",
    action: "place_outbound_call",
    action_payload: {
      to: target,
      customer_id: call.customer_id || null,
      reason: "voice_followup",
      original_call_id: call.id,
    },
  };
};
