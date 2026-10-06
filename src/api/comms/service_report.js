// /api/comms/service_report
//
//   GET  ?visit_id=...   assemble the customer-facing report for one service
//                        visit and return it as JSON.
//   POST { visit_id, send?: false, attach_document_id? }
//                        build the report AND draft a communications row —
//                        routed via the matrix to the customer's function for
//                        service_report (typically maintenance / management),
//                        document_type 'service_report'. Left `queued` for a
//                        human unless send:true.
//
// The scanned/signed original can be attached by passing its documents.id as
// attach_document_id — the typed body is the legible record, the scan is the
// signed one. Internal fields (visit.notes, engineer, cost) never appear; see
// _lib/service-report.js.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { buildServiceReport, renderServiceReportText, isReportEmpty, resolveTemplate } from "../_lib/service-report.js";
import { resolveForCustomer } from "../_lib/comms-routing.js";
import { commsRow } from "../_lib/comms-row.js";
import { sendCommunication } from "../_lib/comms-send.js";

const assemble = async (svc, tenantId, visitId) => {
  const v = await svc.from("service_visits").select("*")
    .eq("tenant_id", tenantId).eq("id", visitId).maybeSingle();
  if (v.error || !v.data) return null;
  const visit = v.data;

  const [parts, cust, contact, templates] = await Promise.all([
    svc.from("service_visit_parts")
      .select("seq, part_name, part_number, action_details, remarks")
      .eq("tenant_id", tenantId).eq("visit_id", visitId),
    visit.customer_id
      ? svc.from("customers").select("id, customer_name").eq("tenant_id", tenantId).eq("id", visit.customer_id).maybeSingle()
      : Promise.resolve({ data: null }),
    visit.customer_contact_id
      ? svc.from("customer_contacts").select("id, name, role").eq("tenant_id", tenantId).eq("id", visit.customer_contact_id).maybeSingle()
      : Promise.resolve({ data: null }),
    // The tenant's default template + this customer's override, if any.
    svc.from("service_report_templates")
      .select("customer_id, name, sections, include_parts, is_active")
      .eq("tenant_id", tenantId),
  ]);

  // customer override -> tenant default -> built-in DEFAULT_TEMPLATE.
  const template = resolveTemplate(templates.data || [], visit.customer_id);

  return {
    visit,
    report: buildServiceReport({
      visit,
      parts: parts.data || [],
      customer: cust.data || {},
      contact: contact.data || {},
      template,
    }),
  };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const visitId = req.query?.visit_id;
      if (!visitId) return json(res, 400, { error: { message: "visit_id required" } });
      const out = await assemble(svc, ctx.tenantId, visitId);
      if (!out) return json(res, 404, { error: { message: "Service visit not found" } });
      return json(res, 200, { ok: true, report: out.report });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const visitId = body?.visit_id;
      if (!visitId) return json(res, 400, { error: { message: "visit_id required" } });

      const out = await assemble(svc, ctx.tenantId, visitId);
      if (!out) return json(res, 404, { error: { message: "Service visit not found" } });
      if (isReportEmpty(out.report)) {
        return json(res, 200, { ok: true, report: out.report, drafted: false, reason: "nothing to report yet" });
      }
      const customerId = out.visit.customer_id;
      if (!customerId) {
        return json(res, 200, { ok: true, report: out.report, drafted: false, reason: "visit has no customer to send to" });
      }

      const recipients = await resolveForCustomer(svc, ctx.tenantId, customerId, "service_report", {
        fallbackEmail: body?.fallback_email || null,
      });

      // Attach the signed original when given. Stored as a reference so the row
      // stays small and access stays governed by documents/storage RLS.
      const attachments = body?.attach_document_id
        ? [{ document_id: body.attach_document_id, filename: "service-report.pdf" }]
        : [];

      const subject = "Service report"
        + (out.report.report_number ? " " + out.report.report_number : "")
        + (out.report.visit_date ? " — " + out.report.visit_date : "");
      const draft = {
        tenant_id: ctx.tenantId,
        customer_id: customerId,
        object_type: "service_visit",
        object_id: visitId,
        document_type: "service_report",
        direction: "outbound",
        channel: "email",
        to_addr: recipients.to[0] || null,
        cc_addrs: recipients.cc,
        bcc_addrs: recipients.bcc,
        subject,
        body: renderServiceReportText(out.report, { footer: body?.footer }),
        attachments,
        status: "queued",
        sent_by: ctx.user?.id || null,
        metadata: {
          visit_id: visitId,
          support_type: out.report.support_type,
          routing_fallback: recipients.fallback_used,
          recipient_unresolved: recipients.unresolved,
        },
      };
      const ins = await svc.from("communications").insert(commsRow(draft)).select("*").single();
      if (ins.error) throw new Error("comm draft: " + ins.error.message);

      let sendResult = null;
      if (body?.send === true) sendResult = await sendCommunication(svc, ctx, ins.data.id);

      await recordAudit(ctx, {
        action: "service_report_drafted",
        objectType: "service_visit",
        objectId: visitId,
        detail: (out.report.report_number || visitId) + " · " + (out.report.support_type || "support"),
      });

      return json(res, 200, {
        ok: true,
        report: out.report,
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
