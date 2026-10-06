// /api/comms/payment_statement
//
//   GET  ?customer_id=...   assemble the statement (open invoices, aged, with
//                           whatever GRN we have) and return it as JSON.
//   POST { customer_id, send?: false }
//                           build the statement AND draft a communications row
//                           for it — routed via the matrix to the customer's
//                           ACCOUNTS function, document_type 'payment_reminder'.
//                           The row is left `queued` (not sent) unless send:true,
//                           so a human confirms before it goes out.
//
// See _lib/payment-statement.js for the assembler and its central design point:
// the GRN is often never sent back, so the statement degrades gracefully and
// doubles as the nudge that gets it sent. See docs/CUSTOMER_COMMS_DESIGN.md §4/§7.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { buildPaymentStatement, renderStatementText } from "../_lib/payment-statement.js";
import { resolveForCustomer } from "../_lib/comms-routing.js";
import { commsRow } from "../_lib/comms-row.js";
import { sendCommunication } from "../_lib/comms-send.js";


// Assemble the statement for one customer. Shared by GET + POST.
const assemble = async (svc, tenantId, customerId, todayIso) => {
  const [cust, invs, rcpts] = await Promise.all([
    svc.from("customers").select("id, customer_name").eq("tenant_id", tenantId).eq("id", customerId).maybeSingle(),
    svc.from("invoices")
      .select("id, invoice_number, po_number, issue_date, due_date, currency, grand_total, paid_amount, status, payment_terms, customer_id")
      .eq("tenant_id", tenantId).eq("customer_id", customerId)
      .not("status", "in", "(void,paid,draft,cancelled)")
      .limit(500),
    svc.from("customer_receipts")
      .select("invoice_id, invoice_number, po_number, receipt_number, receipt_date, receipt_type, status")
      .eq("tenant_id", tenantId).eq("customer_id", customerId)
      .limit(1000),
  ]);
  return buildPaymentStatement({
    customer: cust.data || { id: customerId },
    invoices: invs.data || [],
    receipts: rcpts.data || [],
    today: todayIso,
  });
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    // `today` is an input, not read from the clock, so the assembler stays
    // deterministic; the handler supplies the real one.
    const todayIso = new Date().toISOString().slice(0, 10);

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const customerId = req.query?.customer_id;
      if (!customerId) return json(res, 400, { error: { message: "customer_id required" } });
      const statement = await assemble(svc, ctx.tenantId, customerId, todayIso);
      return json(res, 200, { ok: true, statement });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const customerId = body?.customer_id;
      if (!customerId) return json(res, 400, { error: { message: "customer_id required" } });

      const statement = await assemble(svc, ctx.tenantId, customerId, todayIso);
      if (!statement.lines.length) {
        return json(res, 200, { ok: true, statement, drafted: false, reason: "no open invoices" });
      }

      // Route to the accounts function; fall back per the matrix's ladder.
      const recipients = await resolveForCustomer(svc, ctx.tenantId, customerId, "payment_reminder", {
        fallbackEmail: body?.fallback_email || null,
      });

      const subject = "Statement of outstanding invoices"
        + (statement.customer_name ? " — " + statement.customer_name : "")
        + " (as of " + statement.as_of + ")";
      const draft = {
        tenant_id: ctx.tenantId,
        customer_id: customerId,
        document_type: "payment_reminder",
        direction: "outbound",
        channel: "email",
        to_addr: recipients.to[0] || null,
        cc_addrs: recipients.cc,
        bcc_addrs: recipients.bcc,
        subject,
        body: renderStatementText(statement, { footer: body?.footer }),
        status: "queued",
        sent_by: ctx.user?.id || null,
        metadata: {
          statement_summary: statement.summary,
          routing_fallback: recipients.fallback_used,
          recipient_unresolved: recipients.unresolved,
        },
      };
      const ins = await svc.from("communications").insert(commsRow(draft)).select("*").single();
      if (ins.error) throw new Error("comm draft: " + ins.error.message);

      let sendResult = null;
      if (body?.send === true) {
        // Optional immediate send. Default is to leave it queued for a human,
        // since a payment reminder to the wrong function is a real annoyance.
        sendResult = await sendCommunication(svc, ctx, ins.data.id);
      }

      await recordAudit(ctx, {
        action: "payment_statement_drafted",
        objectType: "customer",
        objectId: customerId,
        detail: statement.summary.open_invoices + " invoices · " + statement.summary.grn_awaited_count + " GRN-awaited",
      });

      return json(res, 200, {
        ok: true,
        statement,
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
