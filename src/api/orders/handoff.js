// /api/orders/handoff
//
//   GET  ?order_id=   the preview: the prefill with its sources, the origin
//                     groups and their modes, the recipients with the reason
//                     for each, the subject, the body, the attachments and
//                     the blockers.
//   POST { order_id, fields?, resend? }
//                     send the order to the order processing team.
//                     fields: { required_by, contact_name, contact_phone,
//                     modes: { import, local, unknown } }; a key left out keeps
//                     the prefill. resend: true sends a handoff that was sent.
//
// The Mode B handoff (docs/SO_TERMS_AND_HANDOFF_SCOPE.md 8.2 to 8.6, built as
// docs/SO_EXECUTION_COHESION.md R-F3 says). Decisions C-D11 and C-D12:
//   - it may go before approval; the blockers below gate it;
//   - an undecided critical terms flag blocks it (409 TERMS_UNDECIDED);
//   - To is the admin's list, the engineer is in CC;
//   - reply-to is the engineer (the owner's change to C-D12, until C-33);
//   - no prices in the email; the SO PDF and the original PO are attached.
//
// It sends in the request, through sendCommunication. It never leaves a
// queued row: the agents/run reaper drains queued rows later and would send a
// stale handoff. The row is inserted as a draft (the reaper reads only
// queued), and with no mail provider the row is marked failed and the order
// says not_configured.
//
// Off unless tenant_settings.order_handoff_enabled is on, and Mode B only.
// Gate: write, then order.handoff.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission, requireAction } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit, recordEvent } from "../_lib/audit.js";
import { commsRow } from "../_lib/comms-row.js";
import { sendCommunication } from "../_lib/comms-send.js";
import { resolveInternalRecipients } from "../_lib/internal-recipients.js";
import { loadSalesOrderParts, renderSalesOrderPdf } from "../_lib/so-document.js";
import { poDocumentOf, readTermsSettings, readTermsView } from "../_lib/terms/check.js";
import { userDisplayNames } from "../_lib/assignee.js";
import {
  SHIP_MODES, dispatchPlan, handoffBlockers, handoffEmail, handoffFields, handoffPrefill, handoffState, originGroups,
} from "../_lib/order-handoff.js";

export const HANDOFF_ACTION = "order.handoff";
const MIGRATION = "251_order_handoff.sql";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const refuse = (res, status, code, message, extra = {}) => json(res, status, { error: { code, message, ...extra } });

// handoff_status decides behaviour, so a database without migration 251 is
// refused, never read as "not handed off" (section 9.4).
const migrationMissing = (res) => refuse(res, 503, "migration_251_not_applied",
  "The handoff columns are not in this database yet. Apply supabase/migrations/" + MIGRATION + ", then retry.", { migration: MIGRATION });

const engineerOf = (ctx) => {
  const meta = ctx.user?.user_metadata || {};
  return { email: ctx.user?.email || null, user_id: ctx.user?.id || null, name: meta.name || meta.full_name || ctx.user?.email || null };
};

// The terms flags the handoff reads. Off and shadow show nothing to an
// engineer, so nothing blocks; a database without migration 250 has no
// check. Any other read failure throws: the send must not go out when it
// cannot tell whether a critical flag is undecided.
const readTerms = async (svc, ctx, orderId) => {
  let settings;
  try { settings = await readTermsSettings(svc, ctx.tenantId); }
  catch (err) {
    if (err?.code === "MIGRATION_NOT_APPLIED") return { mode: "off", checked: false, flags: [] };
    throw err;
  }
  if (settings.mode !== "on") return { mode: settings.mode, checked: false, flags: [] };
  const r = await readTermsView(svc, ctx, orderId, { settings });
  const view = r?.view || {};
  return { mode: "on", checked: !!view.check, flags: view.flags || [] };
};

// Everything the preview and the send share.
const buildHandoff = async (svc, ctx, order, settings, input) => {
  const tenantId = ctx.tenantId;
  const lines = Array.isArray(order.result?.salesOrder?.lineItems) ? order.result.salesOrder.lineItems : [];
  const parts = await loadSalesOrderParts(svc, tenantId, order);
  let primary = null;
  const buyerName = String(order.result?.salesOrder?.customer?.contact_name || "").trim();
  if (!parts.contact && !buyerName && order.customer_id) {
    const p = await svc.from("customer_contacts").select("name, phone")
      .eq("tenant_id", tenantId).eq("customer_id", order.customer_id).eq("is_primary", true).limit(1);
    if (!p.error) primary = (p.data || [])[0] || null;
  }
  const prefill = handoffPrefill(order, { contact: parts.contact, primary });
  const groups = originGroups(lines);
  const fields = handoffFields(prefill, groups, input);
  const terms = await readTerms(svc, ctx, order.id);
  const undecidedCritical = terms.flags.filter((f) => f.state === "undecided" && f.severity === "critical");
  const engineer = engineerOf(ctx);
  const recipients = await resolveInternalRecipients(svc, tenantId, {
    to: settings.order_handoff_to, cc: settings.order_handoff_cc, engineer,
  });
  // The resolver sets reply_to to the engineer. A clerk's reply sent to the
  // tenant's inbound address would enter the Postmark pipeline as a new PO.
  // shortcut: reply-to is the engineer until C-33 joins a clerk reply to its order; then use the tenant inbound address (C-D12).
  const replyTo = recipients.reply_to;
  const poDocumentId = await poDocumentOf(svc, { id: order.id, source_document_id: order.preflight_payload?.source_document_id || null });
  const attachments = [
    { label: "SO PDF", filename: "SO-" + (order.po_number || order.id.slice(0, 8)) + ".pdf" },
    ...(poDocumentId ? [{ label: "original PO", document_id: poDocumentId }] : []),
  ];
  const email = handoffEmail({
    order, customerName: parts.customer?.customer_name || order.result?.salesOrder?.customer?.name,
    groups, fields, prefill, terms, schedules: parts.schedules, attachments,
    engineerName: engineer.name, appUrl: process.env.PUBLIC_APP_URL || "",
  });
  const blockers = handoffBlockers({ order, groups, fields, undecidedCritical, recipients });
  return { parts, prefill, groups, fields, terms, undecidedCritical, recipients, replyTo, attachments, email, blockers };
};

const sentByName = async (svc, order) => (order.handoff_sent_by
  ? (await userDisplayNames(svc, [order.handoff_sent_by])).get(order.handoff_sent_by) || null
  : null);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    if (req.method !== "GET" && req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return json(res, 405, { error: { message: "Method not allowed" } });
    }
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    requireAction(ctx, HANDOFF_ACTION);
    // Fail closed: no tenant, nothing to read or send.
    if (!ctx.tenantId) return refuse(res, 403, "TENANT_REQUIRED", "No tenant in context");
    const body = req.method === "POST" ? (await readBody(req)) || {} : {};
    const orderId = req.method === "GET" ? req.query?.order_id : body.order_id;
    if (typeof orderId !== "string" || !UUID_RE.test(orderId)) return refuse(res, 400, "ORDER_ID_REQUIRED", "order_id must be an order id");
    const svc = serviceClient();

    const st = await svc.from("tenant_settings").select("*").eq("tenant_id", ctx.tenantId).maybeSingle();
    if (st.error) throw new Error("tenant_settings read: " + st.error.message);
    const settings = st.data || {};
    if (st.data && !Object.prototype.hasOwnProperty.call(st.data, "order_handoff_enabled")) return migrationMissing(res);
    const off = settings.order_handoff_enabled !== true ? "off" : settings.so_processing_mode !== "B" ? "not_mode_b" : null;
    if (off) {
      if (req.method === "GET") return json(res, 200, { enabled: false, reason: off });
      return off === "off"
        ? refuse(res, 409, "HANDOFF_OFF", "The order handoff is off for this tenant. An admin turns it on under Admin > Order handoff.")
        : refuse(res, 409, "NOT_MODE_B", "The order handoff is for Mode B, where the team keys the sales order into the ERP. This tenant is in Mode A.");
    }

    const oq = await svc.from("orders").select("*").eq("tenant_id", ctx.tenantId).eq("id", orderId).maybeSingle();
    if (oq.error) throw new Error("orders read: " + oq.error.message);
    if (!oq.data) return refuse(res, 404, "ORDER_NOT_FOUND", "Order not found");
    const order = oq.data;
    if (!Object.prototype.hasOwnProperty.call(order, "handoff_status")) return migrationMissing(res);

    if (req.method === "POST" && order.handoff_status === "sent" && body.resend !== true) {
      // A second click returns the first result. "Send again" passes resend.
      return json(res, 200, {
        ok: true, idempotent: true, status: "sent", communication_id: order.handoff_comm_id || null,
        message: "Already sent to the order processing team. Use Send again to send it again.",
        handoff: handoffState(order, await sentByName(svc, order)),
      });
    }

    const h = await buildHandoff(svc, ctx, order, settings, req.method === "POST" ? body.fields : null);

    if (req.method === "GET") {
      return json(res, 200, {
        enabled: true,
        order_id: order.id,
        handoff: handoffState(order, await sentByName(svc, order)),
        prefill: h.prefill,
        fields: h.fields,
        groups: h.groups,
        modes: SHIP_MODES,
        recipients: { to: h.recipients.to, cc: h.recipients.cc, reply_to: h.replyTo, dropped: h.recipients.dropped },
        subject: h.email.subject,
        body: h.email.body,
        attachments: h.attachments.map(({ label, filename }) => ({ label, filename: filename || null })),
        blockers: h.blockers,
      });
    }

    // POST: the server decides the blockers again from the fields it was sent.
    if (h.blockers.length) {
      const terms = h.blockers.some((b) => b.code === "terms_undecided");
      return refuse(res, 409, terms ? "TERMS_UNDECIDED" : "HANDOFF_BLOCKED", h.blockers.map((b) => b.message).join(" "), { blockers: h.blockers });
    }

    const plan = dispatchPlan(h.groups, h.fields);
    const dispatchMode = plan.length === 1 ? SHIP_MODES[plan[0].mode] : null;
    // The SO PDF prints the plan the engineer chose.
    const planned = { ...order, dispatch_plan: plan, ...(dispatchMode ? { dispatch_mode: dispatchMode } : {}) };
    const { pdf } = await renderSalesOrderPdf(svc, ctx.tenantId, planned, h.parts);
    const to = h.recipients.to.map((r) => r.email);
    // shortcut: communications.to_addr holds one address, so a second To
    // address goes in CC; upgrade when the row gets a To list.
    const cc = [...to.slice(1), ...h.recipients.cc.map((r) => r.email)];
    const ins = await svc.from("communications").insert(commsRow({
      tenant_id: ctx.tenantId,
      order_id: order.id,
      customer_id: order.customer_id || null,
      object_type: "order",
      object_id: order.id,
      document_type: "order_handoff",
      direction: "outbound",
      channel: "email",
      to_addr: to[0],
      cc_addrs: cc,
      reply_to: h.replyTo,
      subject: h.email.subject,
      body: h.email.body,
      // shortcut: the SO PDF rides inline as base64 on the row; upgrade to a
      // stored document when handoffs need the PDF kept beside the order.
      attachments: [
        { filename: h.attachments[0].filename, content_base64: pdf.toString("base64"), type: "application/pdf" },
        ...h.attachments.slice(1).map((a) => ({ document_id: a.document_id })),
      ],
      // A draft, never queued: the reaper drains only queued rows.
      status: "draft",
      sent_by: ctx.user.id,
      metadata: { po_number: order.po_number || null, resend: body.resend === true, groups: plan.map((g) => g.group + ":" + g.line_nos.length) },
    })).select("id").single();
    if (ins.error) throw new Error("communications insert: " + ins.error.message);
    const commId = ins.data.id;

    // shortcut: two POSTs in the same second can both send; the button is
    // disabled while one is in flight. Upgrade with a conditional claim on
    // the order if double sends are seen.
    const r = await sendCommunication(svc, ctx, commId);
    if (r?.notFound) throw new Error("handoff: the communication row could not be read back");
    const commStatus = r.communication?.status;
    let status;
    let message;
    if (commStatus === "sent") {
      status = "sent";
      message = "Sent to the order processing team.";
    } else if (commStatus === "queued") {
      // No provider took it. Mark the row failed, so no reaper sends it later.
      status = "not_configured";
      message = "Not sent: no mail provider is configured.";
      const fx = await svc.from("communications").update({
        status: "failed",
        updated_at: new Date().toISOString(),
        metadata: { ...(r.communication.metadata || {}), error: "no_provider_at_send" },
      }).eq("tenant_id", ctx.tenantId).eq("id", commId).eq("status", "queued");
      if (fx.error) throw new Error("communications update: " + fx.error.message);
    } else {
      status = "failed";
      message = "Failed: " + (r.error || r.communication?.metadata?.provider_error || "the mail provider did not accept it") + ".";
    }

    const now = new Date().toISOString();
    const update = {
      handoff_status: status,
      handoff_sent_at: now,
      handoff_sent_by: ctx.user.id,
      handoff_comm_id: commId,
      // payload_hash: the order's hash at send. The stage (C-9) compares it
      // with the order's hash to show "changed since handoff".
      handoff_payload: {
        payload_hash: order.payload_hash || null,
        required_by: { value: h.fields.required_by, source: h.fields.required_by_source },
        committed: h.prefill.committed,
        contact: { name: h.fields.contact_name, phone: h.fields.contact_phone || null, source: h.fields.contact_source },
        groups: plan,
        terms: { mode: h.terms.mode, checked: h.terms.checked, open: h.terms.flags.filter((f) => f.state === "undecided").length },
        resend: body.resend === true,
      },
      dispatch_plan: plan,
      ...(dispatchMode ? { dispatch_mode: dispatchMode } : {}),
    };
    const up = await svc.from("orders").update(update).eq("tenant_id", ctx.tenantId).eq("id", order.id);
    if (up.error) throw new Error("orders update: " + up.error.message);

    // Counts and ids only: no contact name or phone.
    const groupCounts = plan.map((g) => ({ group: g.group, mode: g.mode, lines: g.line_nos.length }));
    await recordAudit(ctx, {
      action: "order_handoff_sent",
      objectType: "order",
      objectId: order.id,
      detail: "status=" + status + " comm=" + commId,
      after: { comm_id: commId, status, groups: groupCounts },
    });
    await recordEvent(ctx, {
      caseId: order.id, eventType: "order_handoff", objectType: "order", objectId: order.id,
      detail: { comm_id: commId, status, groups: groupCounts },
    });

    return json(res, 200, {
      ok: status === "sent",
      status,
      message,
      communication_id: commId,
      handoff: handoffState({ ...order, ...update }, engineerOf(ctx).name),
    });
  } catch (err) {
    sendError(res, err);
  }
}
