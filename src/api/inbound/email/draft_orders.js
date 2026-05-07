// GET or POST /api/inbound/email/draft_orders
//
// Cron-only via Bearer CRON_SECRET (drains every 5 min from
// /api/cron/tick), plus a manual admin trigger. Picks
// inbound_emails.status='linked' rows that don't have a
// linked_order_id yet, creates a DRAFT order per row, and flips
// the email row to status='archived' with linked_order_id set.
//
// Audit P2.2. Before this worker, parse.js set status='linked' but
// no consumer ever processed the linked rows. Operators saw
// emails sit in the inbox indefinitely; the headline gap in
// "automated RFQ capture" was that the platform identified RFQs
// and stopped.
//
// What this worker does NOT do (deferred to later phases):
//
//   - Download attachment bytes from Postmark / Microsoft Graph.
//     That requires per-provider download APIs. The linked-email
//     row already has attachment metadata; the auto-OCR worker
//     (P2.5) handles persisted documents but does not yet fetch
//     remote bytes. A subsequent phase wires that.
//   - Run docai extraction over the email body text. The order
//     created here is in the DRAFT state with the raw text in
//     preflight_payload; the operator opens the SO Workspace
//     screen to extract. Auto-extraction over body_text + once-
//     downloaded attachments lands in Phase 3.

import { applyCors, handlePreflight, json, sendError } from "../../_lib/cors.js";
import { resolveContext, requirePermission } from "../../_lib/auth.js";
import { serviceClient } from "../../_lib/supabase.js";
import { recordAudit } from "../../_lib/audit.js";
import { drainQueue } from "../../_lib/queue-runner.js";

const CRON_SECRET = process.env.CRON_SECRET;
const BATCH_SIZE = 25;

const buildOrderRow = (email) => ({
  tenant_id: email.tenant_id,
  customer_id: email.customer_id || null,
  status: "DRAFT",
  preflight_payload: {
    source: "inbound_email",
    inbound_email_id: email.id,
    thread_id: email.thread_id || null,
    from: email.from_address || null,
    from_name: email.from_name || null,
    subject: email.subject || null,
    text: typeof email.body_text === "string" ? email.body_text.slice(0, 16_000) : null,
    received_at: email.received_at || null,
    priority_score: email.priority_score != null ? Number(email.priority_score) : null,
    attachments: Array.isArray(email.attachments) ? email.attachments : [],
  },
  blocker_summary: email.customer_id
    ? null
    : "Inbound email matched no known customer; assign one before approval.",
});

const drainOnce = async (svc) => {
  return drainQueue(svc, {
    table: "inbound_emails",
    selectColumns:
      "id, tenant_id, thread_id, from_address, from_name, subject, body_text, attachments, received_at, priority_score, customer_id, linked_order_id, status",
    statusColumn: "status",
    statusValue: "linked",
    batchOrder: { column: "received_at", ascending: true },
    limit: BATCH_SIZE,
    processFn: async (email) => {
      // Defensive: if the row already has a linked_order_id (could
      // happen on a partially-applied previous run), don't make a
      // duplicate; just mark it archived.
      if (email.linked_order_id) {
        return { ok: true, patch: { status: "archived" } };
      }
      const ins = await svc.from("orders").insert(buildOrderRow(email)).select("id").single();
      if (ins.error) return { ok: false, error: "orders insert: " + ins.error.message };
      const orderId = ins.data.id;
      await svc.from("audit_events").insert({
        tenant_id: email.tenant_id,
        action: "inbound_email_drafted",
        object_type: "order",
        object_id: orderId,
        detail: "from inbound_email " + email.id,
      });
      // The thread now has a destination order; record on the
      // thread row too for the inbox UI.
      if (email.thread_id) {
        await svc.from("inbound_email_threads")
          .update({ linked_order_id: orderId })
          .eq("id", email.thread_id)
          .is("linked_order_id", null);
      }
      return {
        ok: true,
        patch: {
          status: "archived",
          linked_order_id: orderId,
          parsed_at: new Date().toISOString(),
        },
      };
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
      action: "inbound_email_drain",
      objectType: "tenant",
      objectId: ctx.tenantId,
      detail: "considered=" + out.considered + " succeeded=" + out.succeeded + " failed=" + out.failed,
    });
    return json(res, 200, { ran_at: new Date().toISOString(), ...out });
  } catch (err) { sendError(res, err); }
}
