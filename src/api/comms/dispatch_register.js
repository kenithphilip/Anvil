// /api/comms/dispatch_register
//
//   GET  ?order_id=...   assemble the customer-facing dispatch register for one
//                        order and return it as JSON.
//   POST { order_id, send?: false, attach_document_id?, footer?, fallback_email?, template? }
//                        build the register AND draft a communications row —
//                        routed via the matrix to the customer's stores function
//                        (purchase + accounts in CC), document_type
//                        'dispatch_register'. Left `queued` for a human unless
//                        send:true.
//
// A signed delivery challan can be attached with attach_document_id — the typed
// register is the legible record, the scan is the signed one. Internal context
// (dispatch_lines.metadata, cost) never appears; see _lib/dispatch-register.js.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import {
  renderDispatchRegisterText, isDispatchRegisterEmpty, dispatchRegisterSubject,
} from "../_lib/dispatch-register.js";
import { assembleDispatchRegister } from "../_lib/dispatch-register-send.js";
import { resolveForCustomer } from "../_lib/comms-routing.js";
import { commsRow } from "../_lib/comms-row.js";
import { sendCommunication } from "../_lib/comms-send.js";

// assembleDispatchRegister moved to _lib/dispatch-register-send.js so the manual
// endpoint (below) and the auto-send path (comms/dispatch_lines) build it identically.

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const orderId = req.query?.order_id;
      if (!orderId) return json(res, 400, { error: { message: "order_id required" } });
      const out = await assembleDispatchRegister(svc, ctx.tenantId, orderId, null);
      if (!out) return json(res, 404, { error: { message: "Order not found" } });
      return json(res, 200, { ok: true, register: out.register });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const orderId = body?.order_id;
      if (!orderId) return json(res, 400, { error: { message: "order_id required" } });

      const out = await assembleDispatchRegister(svc, ctx.tenantId, orderId, body?.template);
      if (!out) return json(res, 404, { error: { message: "Order not found" } });
      if (isDispatchRegisterEmpty(out.register)) {
        return json(res, 200, { ok: true, register: out.register, drafted: false, reason: "nothing despatched yet" });
      }
      const customerId = out.order.customer_id;
      if (!customerId) {
        return json(res, 200, { ok: true, register: out.register, drafted: false, reason: "order has no customer to send to" });
      }

      const recipients = await resolveForCustomer(svc, ctx.tenantId, customerId, "dispatch_register", {
        fallbackEmail: body?.fallback_email || null,
      });

      const attachments = body?.attach_document_id
        ? [{ document_id: body.attach_document_id, filename: "delivery-challan.pdf" }]
        : [];

      const draft = {
        tenant_id: ctx.tenantId,
        customer_id: customerId,
        order_id: orderId,
        object_type: "order",
        object_id: orderId,
        document_type: "dispatch_register",
        direction: "outbound",
        channel: "email",
        to_addr: recipients.to[0] || null,
        cc_addrs: recipients.cc,
        bcc_addrs: recipients.bcc,
        subject: dispatchRegisterSubject(out.register),
        body: renderDispatchRegisterText(out.register, { footer: body?.footer }),
        attachments,
        status: "queued",
        sent_by: ctx.user?.id || null,
        metadata: {
          order_id: orderId,
          po_number: out.register.po_number,
          line_count: out.register.summary?.line_count,
          dispatched_line_count: out.register.summary?.dispatched_line_count,
          header_fallback: !!out.register.degraded?.header_fallback,
          routing_fallback: recipients.fallback_used,
          recipient_unresolved: recipients.unresolved,
        },
      };
      const ins = await svc.from("communications").insert(commsRow(draft)).select("*").single();
      if (ins.error) throw new Error("comm draft: " + ins.error.message);

      let sendResult = null;
      if (body?.send === true) sendResult = await sendCommunication(svc, ctx, ins.data.id);

      await recordAudit(ctx, {
        action: "dispatch_register_drafted",
        objectType: "order",
        objectId: orderId,
        detail: (out.register.po_number || orderId) + " · " + (out.register.summary?.dispatched_line_count || 0) + " despatched line(s)",
      });

      return json(res, 200, {
        ok: true,
        register: out.register,
        drafted: true,
        communication_id: ins.data.id,
        recipients: { to: recipients.to, cc: recipients.cc, fallback_used: recipients.fallback_used, unresolved: recipients.unresolved },
        send_result: sendResult,
      });
    }

    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    return sendError(res, err);
  }
}
