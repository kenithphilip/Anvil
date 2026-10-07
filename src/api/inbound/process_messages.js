// GET or POST /api/inbound/process_messages
//
// Cron-only via Bearer CRON_SECRET (drained every 5 min from
// /api/cron/tick), plus a manual admin trigger. Drains
// inbound_messages where status='arrived' and routes each row
// by intent.
//
// Audit P2.4. inbound-chat.js (called from Slack, Teams, and the
// newer WhatsApp webhook) had been writing inbound_messages rows
// since Phase 5 with status='arrived'. There was no consumer.
// A customer messaging "I need a quote for WGC-K12464 qty 50"
// over Slack ended up in a table no one read.
//
// Intent routing here is a deliberately simple keyword classifier
// (_lib/chat-intent.js, shared with the legacy whatsapp/inbound.js);
// the LLM-based triage classifier (Haiku-tier) lands in Phase 5
// of the audit roadmap. For now:
//
//   complaint                                    -> processing_event
//                                                   (inbound_complaint,
//                                                   same shape as email)
//   purchase_order / quote_request / po_revision -> DRAFT order
//   status_request                               -> processing_event
//                                                   (operator triage)
//   other                                        -> resolved + note

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { drainQueue } from "../_lib/queue-runner.js";
import { classifyChatIntent, chatSubject, ORDER_INTENTS } from "../_lib/chat-intent.js";

const CRON_SECRET = process.env.CRON_SECRET;
const BATCH_SIZE = 25;

const buildOrderRow = (msg, intent) => ({
  tenant_id: msg.tenant_id,
  customer_id: msg.customer_id || null,
  status: "DRAFT",
  preflight_payload: {
    source: "inbound_chat",
    inbound_message_id: msg.id,
    channel: msg.channel,
    thread_external_id: msg.thread_external_id || null,
    sender_handle: msg.sender_handle || null,
    sender_name: msg.sender_name || null,
    text: typeof msg.text_body === "string" ? msg.text_body.slice(0, 16_000) : null,
    intent,
    received_at: msg.received_at || null,
  },
  blocker_summary: msg.customer_id
    ? null
    : "Inbound chat matched no known customer; assign one before approval.",
});

const handleOrderIntent = async (svc, msg, intent) => {
  const ord = await svc.from("orders").insert(buildOrderRow(msg, intent)).select("id").single();
  if (ord.error) return { ok: false, error: "orders insert: " + ord.error.message };
  await svc.from("audit_events").insert({
    tenant_id: msg.tenant_id,
    action: "inbound_chat_drafted_order",
    object_type: "order",
    object_id: ord.data.id,
    detail: msg.channel + "::" + intent + "::" + msg.id,
  });
  return {
    ok: true,
    patch: {
      status: "linked",
      linked_order_id: ord.data.id,
      processed_at: new Date().toISOString(),
    },
  };
};

const handleStatusRequest = async (svc, msg) => {
  await svc.from("processing_events").insert({
    tenant_id: msg.tenant_id,
    case_id: msg.id,
    event_type: "inbound_chat_status_request",
    object_type: "inbound_message",
    object_id: msg.id,
    detail: {
      channel: msg.channel,
      sender_handle: msg.sender_handle,
      text: typeof msg.text_body === "string" ? msg.text_body.slice(0, 800) : null,
      severity: "info",
    },
  });
  return {
    ok: true,
    patch: {
      status: "resolved",
      processed_at: new Date().toISOString(),
    },
  };
};

// A complaint writes the same processing_event the email path writes
// (agents/handle_replies.js handleComplaint): event_type
// inbound_complaint, the source row as case and object, severity warn.
// It never becomes an order. The email path leaves a complaint email
// un-resolved and marks it handled in a side column; inbound_messages
// has no such column, so the message moves to `intake-extracted` (the
// step before `resolved` in migration 039's lifecycle). That takes it
// off the `arrived` queue, so the next drain does not record it twice,
// and it stays un-resolved.
const handleComplaint = async (svc, msg) => {
  const ev = await svc.from("processing_events").insert({
    tenant_id: msg.tenant_id,
    case_id: msg.id,
    event_type: "inbound_complaint",
    object_type: "inbound_message",
    object_id: msg.id,
    detail: { from: msg.sender_handle || null, subject: chatSubject(msg.text_body), severity: "warn" },
  });
  if (ev.error) return { ok: false, error: "processing_events insert: " + ev.error.message };
  return {
    ok: true,
    patch: {
      status: "intake-extracted",
      processed_at: new Date().toISOString(),
    },
  };
};

const handleOther = async (_svc, _msg) => {
  return {
    ok: true,
    patch: {
      status: "resolved",
      processed_at: new Date().toISOString(),
    },
  };
};

const dispatch = async (svc, msg) => {
  const intent = classifyChatIntent(msg.text_body);
  if (intent === "complaint") return handleComplaint(svc, msg);
  if (ORDER_INTENTS.includes(intent)) return handleOrderIntent(svc, msg, intent);
  if (intent === "status_request") return handleStatusRequest(svc, msg);
  return handleOther(svc, msg);
};

const drainOnce = async (svc, tenantId) => {
  return drainQueue(svc, {
    table: "inbound_messages",
    selectColumns:
      "id, tenant_id, channel, external_id, thread_external_id, sender_handle, sender_name, text_body, customer_id, status, received_at",
    statusColumn: "status",
    statusValue: "arrived",
    batchOrder: { column: "received_at", ascending: true },
    limit: BATCH_SIZE,
    processFn: (msg) => dispatch(svc, msg),
    tenantId,   // null for cron (all tenants); set for a manual admin drain
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
    const out = await drainOnce(svc, ctx.tenantId);   // manual drain -> caller's tenant only
    await recordAudit(ctx, {
      action: "inbound_chat_drain",
      objectType: "tenant",
      objectId: ctx.tenantId,
      detail: "considered=" + out.considered + " succeeded=" + out.succeeded + " failed=" + out.failed,
    });
    return json(res, 200, { ran_at: new Date().toISOString(), ...out });
  } catch (err) { sendError(res, err); }
}
