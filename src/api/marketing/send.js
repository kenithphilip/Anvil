// /api/marketing/send
//
//   POST { customer_id, subject, body }   (admin)
//     Send a marketing message to a customer's CONSENTED, non-suppressed
//     contacts. Consent (customer_contacts.marketing_consent) + suppression +
//     unsubscribe are enforced by the marketing path (_lib/marketing-send.js),
//     NEVER the transactional one. Each attempt is logged to communications with
//     document_type='marketing' so the transactional reaper skips it and it can
//     never send from the rep's mailbox.
//
// This is the deliberately-separate path of docs/CUSTOMER_COMMS_DESIGN.md §6.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { commsRow } from "../_lib/comms-row.js";
import { sendMarketing } from "../_lib/marketing-send.js";

const personalize = (t, contact, customer) => String(t || "")
  .replace(/\{\{name\}\}/gi, contact.name || "there")
  .replace(/\{\{company\}\}/gi, customer?.customer_name || "your company");

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return json(res, 405, { error: { message: "Method not allowed" } });
    }
    requirePermission(ctx, "admin");
    const body = await readBody(req);
    const customerId = body?.customer_id;
    if (!customerId) return json(res, 400, { error: { message: "customer_id required" } });
    if (!body?.subject || !body?.body) return json(res, 400, { error: { message: "subject and body required" } });

    // ONLY consented, active contacts. Absence of consent = no marketing.
    const contactsQ = await svc.from("customer_contacts")
      .select("id, name, email, marketing_consent, is_active")
      .eq("tenant_id", ctx.tenantId).eq("customer_id", customerId)
      .eq("is_active", true).eq("marketing_consent", true);
    if (contactsQ.error) throw new Error("contacts: " + contactsQ.error.message);
    const contacts = (contactsQ.data || []).filter((c) => c.email);
    if (!contacts.length) {
      return json(res, 200, { ok: true, sent: 0, total: 0, reason: "no consented contacts" });
    }
    const cust = await svc.from("customers").select("customer_name").eq("tenant_id", ctx.tenantId).eq("id", customerId).maybeSingle();

    const results = [];
    for (const contact of contacts) {
      const subject = personalize(body.subject, contact, cust.data);
      const text = personalize(body.body, contact, cust.data);
      const r = await sendMarketing(svc, ctx.tenantId, { to: contact.email, subject, body: text, consented: true });

      // Log real attempts (sent / provider-failure). Policy-skips (suppressed /
      // no_provider) are counted, not logged — they are non-events, and a queued
      // marketing row would just sit unswept (the reaper skips document_type='marketing').
      if (r.ok || (r.status && !r.ok)) {
        await svc.from("communications").insert(commsRow({
          tenant_id: ctx.tenantId,
          customer_id: customerId,
          customer_contact_id: contact.id,
          object_type: "marketing",
          document_type: "marketing",
          direction: "outbound",
          channel: "email",
          to_addr: contact.email,
          subject,
          body: text,
          status: r.ok ? "sent" : "failed",
          sent_at: r.ok ? new Date().toISOString() : null,
          sent_by: ctx.user?.id || null,
          metadata: { marketing: true, provider: r.provider || null, provider_status: r.status || null },
        }));
      }
      results.push({ contact_id: contact.id, ok: !!r.ok, skipped: r.skipped || null });
    }

    const sent = results.filter((r) => r.ok).length;
    await recordAudit(ctx, {
      action: "marketing_send", objectType: "customer", objectId: customerId,
      detail: sent + "/" + results.length + " sent",
    });
    return json(res, 200, { ok: true, sent, total: results.length, results });
  } catch (err) {
    return sendError(res, err);
  }
}
