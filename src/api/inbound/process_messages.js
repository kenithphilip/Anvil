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
// Intent routing here is a deliberately simple keyword classifier;
// the LLM-based triage classifier (Haiku-tier) lands in Phase 5
// of the audit roadmap. For now:
//
//   purchase_order / quote_request / po_revision -> DRAFT order
//   status_request                               -> processing_event
//                                                   (operator triage)
//   other                                        -> resolved + note

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { drainQueue } from "../_lib/queue-runner.js";

const CRON_SECRET = process.env.CRON_SECRET;
const BATCH_SIZE = 25;

// Same heuristic the legacy whatsapp/inbound.js uses, lifted so
// both paths classify consistently. Phase 5 swaps this for a
// Haiku-tier classifier.
const classifyIntent = (text) => {
  const t = String(text || "").toLowerCase();
  if (/(revis|amend|update.*po\b|po.*update)/.test(t)) return "po_revision";
  if (/(quote|quotation|rfq|pricing|price|cost)/.test(t)) return "quote_request";
  if (/(status|delivery|eta|tracking|where\s+is)/.test(t)) return "status_request";
  if (/(po|purchase\s*order|p\.o\.|buy)/.test(t)) return "purchase_order";
  return "other";
};

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
  const intent = classifyIntent(msg.text_body);
  if (intent === "purchase_order" || intent === "quote_request" || intent === "po_revision") {
    return handleOrderIntent(svc, msg, intent);
  }
  if (intent === "status_request") return handleStatusRequest(svc, msg);
  return handleOther(svc, msg);
};

const drainOnce = async (svc) => {
  return drainQueue(svc, {
    table: "inbound_messages",
    selectColumns:
      "id, tenant_id, channel, external_id, thread_external_id, sender_handle, sender_name, text_body, customer_id, status, received_at",
    statusColumn: "status",
    statusValue: "arrived",
    batchOrder: { column: "received_at", ascending: true },
    limit: BATCH_SIZE,
    processFn: (msg) => dispatch(svc, msg),
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
      action: "inbound_chat_drain",
      objectType: "tenant",
      objectId: ctx.tenantId,
      detail: "considered=" + out.considered + " succeeded=" + out.succeeded + " failed=" + out.failed,
    });
    return json(res, 200, { ran_at: new Date().toISOString(), ...out });
  } catch (err) { sendError(res, err); }
}
