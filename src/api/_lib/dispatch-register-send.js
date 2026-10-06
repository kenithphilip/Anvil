// Dispatch-register assembly + gated auto-send.
//
// `assembleDispatchRegister` reads the order + despatch lines + shipments +
// customer + invoices/einvoices and builds the customer-facing register (shared
// by the manual POST /api/comms/dispatch_register endpoint and the auto path).
//
// `maybeAutoSendDispatchRegister` is the P3 auto-send: when a despatch is
// recorded (comms/dispatch_lines) and the tenant has opted in
// (tenant_settings.dispatch_register_auto_send_enabled, OFF by default), it
// drafts + sends the register once per order. Guardrails, all mandatory because
// this is an OUTWARD customer email fired without an operator click:
//   - per-tenant flag, OFF by default
//   - only when the mailer is configured (switchable mailer OR Outlook/Graph)
//   - stricter recipients than the manual endpoint: never send into the operator
//     fallback (skip when routing is unresolved)
//   - send ONCE per order (skip if a sent register already exists) — a later
//     despatch update is sent manually, so we never spam the customer
//   - best-effort: never throws, so the despatch ingest response is unaffected
// The send routes through comms-send.js sendCommunication (switchable mailer /
// Graph, cc/bcc + attachments, idempotency, audit + event).

import { emailConfigured } from "./mailer.js";
import { graphIsConnected } from "./graph-client.js";
import { sendCommunication } from "./comms-send.js";
import { commsRow } from "./comms-row.js";
import { resolveForCustomer } from "./comms-routing.js";
import { recordAudit } from "./audit.js";
import {
  buildDispatchRegister, renderDispatchRegisterText, isDispatchRegisterEmpty,
  dispatchRegisterSubject, extractPoLines,
} from "./dispatch-register.js";

export const assembleDispatchRegister = async (svc, tenantId, orderId, template) => {
  // `result` carries the authoritative PO line items (the ordered side).
  const o = await svc.from("orders").select("id, po_number, po_date, customer_id, result")
    .eq("tenant_id", tenantId).eq("id", orderId).maybeSingle();
  if (o.error || !o.data) return null;
  const order = o.data;

  const [dispatch, ships, cust, invs, eInvs] = await Promise.all([
    svc.from("dispatch_lines")
      .select("id, line_index, part_no, description, dispatched_qty, uom, dispatch_date, lr_number, carrier, invoice_number, invoice_date")
      .eq("tenant_id", tenantId).eq("order_id", orderId).order("dispatch_date", { ascending: true }),
    svc.from("shipments")
      .select("shipment_number, carrier, shipper_invoice_no, ready_date, vessel_sailing_date, warehouse_receipt_date, customer_delivery_date")
      .eq("tenant_id", tenantId).eq("order_id", orderId),
    order.customer_id
      ? svc.from("customers").select("id, customer_name").eq("tenant_id", tenantId).eq("id", order.customer_id).maybeSingle()
      : Promise.resolve({ data: null }),
    svc.from("invoices").select("invoice_number, issue_date").eq("tenant_id", tenantId).eq("order_id", orderId),
    // India GST invoices live in einvoices, not invoices. Union both so the
    // invoice fallback is never blank for an India tenant.
    svc.from("einvoices").select("invoice_number, invoice_date").eq("tenant_id", tenantId).eq("order_id", orderId),
  ]);

  const invoices = [
    ...(invs.data || []).map((iv) => ({ invoice_number: iv.invoice_number, issue_date: iv.issue_date })),
    ...(eInvs.data || []).map((iv) => ({ invoice_number: iv.invoice_number, issue_date: iv.invoice_date })),
  ];

  return {
    order,
    register: buildDispatchRegister({
      order,
      poLines: extractPoLines(order),
      dispatchLines: dispatch.data || [],
      shipments: ships.data || [],
      customer: cust.data || {},
      invoices,
      template: template || null,
    }),
  };
};

// Best-effort, never throws. Returns { sent } or { skipped: <reason> }.
export const maybeAutoSendDispatchRegister = async (svc, ctx, orderId) => {
  try {
    if (!orderId) return { skipped: "no_order" };

    // Per-tenant opt-in, OFF by default.
    let settings = null;
    try {
      const st = await svc.from("tenant_settings").select("*").eq("tenant_id", ctx.tenantId).maybeSingle();
      settings = st.data || null;
    } catch { settings = null; }
    if (settings?.dispatch_register_auto_send_enabled !== true) return { skipped: "flag_off" };

    // Only when a provider is usable (switchable mailer OR the tenant's Outlook/Graph).
    if (!emailConfigured() && !graphIsConnected(settings)) return { skipped: "not_configured" };

    const out = await assembleDispatchRegister(svc, ctx.tenantId, orderId, null);
    if (!out) return { skipped: "order_not_found" };
    if (isDispatchRegisterEmpty(out.register)) return { skipped: "nothing_despatched" };
    const customerId = out.order.customer_id;
    if (!customerId) return { skipped: "no_customer" };

    // Send once per order: a later despatch update is sent manually, so a
    // re-synced delivery note never re-mails the customer.
    const prior = await svc.from("communications").select("id")
      .eq("tenant_id", ctx.tenantId).eq("order_id", orderId)
      .eq("document_type", "dispatch_register").eq("status", "sent").limit(1);
    if (!prior.error && (prior.data || []).length) return { skipped: "already_sent" };

    const recipients = await resolveForCustomer(svc, ctx.tenantId, customerId, "dispatch_register", { fallbackEmail: null });
    // Stricter than the manual endpoint: never auto-send into the operator fallback.
    if (recipients.unresolved || !recipients.to?.[0]) return { skipped: "recipient_unresolved" };

    const ins = await svc.from("communications").insert(commsRow({
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
      body: renderDispatchRegisterText(out.register, {}),
      status: "queued",
      sent_by: ctx.user?.id || null,
      metadata: {
        order_id: orderId,
        po_number: out.register.po_number,
        auto_sent: true,
        routing_fallback: recipients.fallback_used,
      },
    })).select("*").single();
    if (ins.error) return { skipped: "draft_failed" };

    const r = await sendCommunication(svc, ctx, ins.data.id);
    await recordAudit(ctx, {
      action: "dispatch_register_auto_sent",
      objectType: "order",
      objectId: orderId,
      detail: { comm_id: ins.data.id, status: r?.communication?.status || null },
    });
    return { sent: r?.communication?.status === "sent", comm_id: ins.data.id };
  } catch (e) {
    try {
      await recordAudit(ctx, {
        action: "dispatch_register_auto_send_failed",
        objectType: "order",
        objectId: orderId,
        detail: { error: String(e?.message || e) },
      });
    } catch { /* audit is non-throwing; ignore */ }
    return { skipped: "error" };
  }
};
