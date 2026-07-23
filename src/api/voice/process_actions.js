// GET or POST /api/voice/process_actions
//
// Cron-only via Bearer CRON_SECRET (drained every 5 min from
// /api/cron/tick), plus a manual admin trigger. Picks up
// voice_call_actions rows where completed=false and dispatches
// each action to a per-action handler.
//
// Audit P2.3. voice/webhook.js had been inserting structured
// actions (place_order, quote_request, check_delivery,
// verify_customer, escalate, note) into voice_call_actions
// since Phase 5 with a comment promising "the next /api/cron/tick
// picks them up." There was no consumer. Voice agents that
// successfully extracted intent ended up with a row in a table
// no one read.
//
// What each action does today:
//
//   place_order      -> create a DRAFT order with the LLM payload
//                       in preflight_payload; operator extracts.
//   quote_request    -> same shape, with order_mode hint.
//   check_delivery   -> write a processing_event for operator
//                       triage; we don't yet auto-reply with a
//                       shipment status.
//   verify_customer  -> write a processing_event so an operator
//                       can confirm the caller is a known contact.
//   escalate         -> write a processing_event with severity
//                       'warn'.
//   note             -> just mark complete; the note is in the
//                       voice_calls.summary and on the action's
//                       payload, no further work needed.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { drainQueue } from "../_lib/queue-runner.js";

const CRON_SECRET = process.env.CRON_SECRET;
const BATCH_SIZE = 25;

const recordEventDirect = async (svc, action, eventType, severity, detail) => {
  await svc.from("processing_events").insert({
    tenant_id: action.tenant_id,
    case_id: action.call_id,
    event_type: eventType,
    object_type: "voice_call_action",
    object_id: action.id,
    detail: { ...(detail || {}), severity: severity || "info" },
  });
};

const handlePlaceOrder = async (svc, action, mode) => {
  const payload = action.payload || {};
  const ord = await svc.from("orders").insert({
    tenant_id: action.tenant_id,
    customer_id: payload.customer_id || null,
    status: "DRAFT",
    order_mode: mode || null,
    preflight_payload: {
      source: "voice_call_action",
      voice_call_id: action.call_id,
      voice_action_id: action.id,
      action: action.action,
      raw_payload: payload,
    },
    blocker_summary: payload.customer_id
      ? null
      : "Voice call did not resolve a known customer; assign one before approval.",
  }).select("id").single();
  if (ord.error) return { ok: false, error: "orders insert: " + ord.error.message };
  return {
    ok: true,
    result: { order_id: ord.data.id, order_mode: mode || null },
    audit_action: "voice_action_drafted_order",
    detail: action.action + " -> order " + ord.data.id,
  };
};

const dispatch = async (svc, action) => {
  switch (action.action) {
    case "place_order":   return handlePlaceOrder(svc, action, null);
    case "quote_request": return handlePlaceOrder(svc, action, null);
    case "check_delivery":
      await recordEventDirect(svc, action, "voice_check_delivery", "info", action.payload || {});
      return { ok: true, result: { handled: "operator_event" }, audit_action: "voice_action_check_delivery" };
    case "verify_customer":
      await recordEventDirect(svc, action, "voice_verify_customer", "warn", action.payload || {});
      return { ok: true, result: { handled: "operator_event" }, audit_action: "voice_action_verify_customer" };
    case "escalate":
      await recordEventDirect(svc, action, "voice_escalation", "warn", action.payload || {});
      return { ok: true, result: { handled: "escalated" }, audit_action: "voice_action_escalated" };
    case "note":
      return { ok: true, result: { handled: "note" }, audit_action: "voice_action_noted" };
    default:
      return { ok: false, error: "unknown action: " + action.action };
  }
};

const drainOnce = async (svc) => {
  return drainQueue(svc, {
    table: "voice_call_actions",
    selectColumns: "id, tenant_id, call_id, action, payload, completed, result, error, created_at",
    completedColumn: "completed",
    completedValue: false,
    batchOrder: { column: "created_at", ascending: true },
    limit: BATCH_SIZE,
    errorColumn: "error",
    processFn: async (action) => {
      const out = await dispatch(svc, action);
      if (!out.ok) return out;
      // Persist the per-action result + completion flag.
      await svc.from("voice_call_actions").update({
        completed: true,
        completed_at: new Date().toISOString(),
        result: out.result || {},
        error: null,
      }).eq("id", action.id);
      // Audit so operators see the dispatch downstream.
      await svc.from("audit_events").insert({
        tenant_id: action.tenant_id,
        action: out.audit_action,
        object_type: "voice_call_action",
        object_id: action.id,
        detail: out.detail || JSON.stringify(out.result).slice(0, 240),
      });
      // We've already updated the row above; tell the helper not
      // to write its own patch.
      return { ok: true };
    },
  });
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
      return json(res, 200, { ran_at: new Date().toISOString(), ...out });
    }
    if (req.method !== "POST" && req.method !== "GET") {
      res.setHeader("Allow", "POST, GET");
      return json(res, 405, { error: { message: "Method not allowed" } });
    }
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const out = await drainOnce(svc);
    await recordAudit(ctx, {
      action: "voice_actions_drain",
      objectType: "tenant",
      objectId: ctx.tenantId,
      detail: "considered=" + out.considered + " succeeded=" + out.succeeded + " failed=" + out.failed,
    });
    return json(res, 200, { ran_at: new Date().toISOString(), ...out });
  } catch (err) { sendError(res, err); }
}
