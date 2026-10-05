// POST /api/communications/log
// Body: {
//   object_type: "quote" | "opportunity",
//   object_id: uuid,
//   channel: "call" | "meeting" | "whatsapp" | "visit" | "note",
//   body: string,                         (required)
//   customer_contact_id?: uuid,           (a contact of the target's customer)
//   metadata?: { next_followup_at?: "YYYY-MM-DD" },
// }
//
// Records a rep touch: something a salesperson did OUTSIDE Anvil (rang the
// buyer, met maintenance, sent a WhatsApp) against a quote or an opportunity.
// The QuoteDetailDrawer Follow-up tab and the opportunity detail post here
// through components/TouchLog.tsx.
//
// The row is written final (status 'sent', provider 'manual', document_type
// 'rep_touch'). It is never queued, so the queued-comms reaper in agents/run.js
// never emails it, and it is not a customer-comms document type, so the metric
// catalog's customer-comms totals do not count it. See _lib/rep-touch.js.
//
// 400: unknown object_type or channel, missing body, malformed ids or date.
// 404: the target is not a quote / opportunity of the caller's tenant.
// 400: customer_contact_id is not a contact of the target's customer.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { commsRow } from "../_lib/comms-row.js";
import { TOUCH_DOCUMENT_TYPE, TOUCH_OBJECT_TABLES, validateTouch } from "../_lib/rep-touch.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const checked = validateTouch(await readBody(req));
    if (checked.error) return json(res, 400, { error: { message: checked.error } });
    const t = checked.value;
    const svc = serviceClient();

    // The target must belong to THIS tenant. The service role bypasses RLS,
    // so this lookup is the tenant gate: another tenant's quote id is a 404,
    // never a row written against it.
    const target = await svc.from(TOUCH_OBJECT_TABLES[t.object_type])
      .select("id, customer_id")
      .eq("tenant_id", ctx.tenantId)
      .eq("id", t.object_id)
      .maybeSingle();
    if (target.error) throw new Error(target.error.message);
    if (!target.data) {
      return json(res, 404, { error: { message: t.object_type + " not found" } });
    }
    const customerId = target.data.customer_id || null;

    // A contact is optional, but one that is named must be a contact of the
    // target's customer in this tenant. customer_contact_id is a bare FK with
    // no tenant check, so without this a foreign contact id would be stored.
    if (t.customer_contact_id) {
      const contact = customerId
        ? await svc.from("customer_contacts")
          .select("id")
          .eq("tenant_id", ctx.tenantId)
          .eq("customer_id", customerId)
          .eq("id", t.customer_contact_id)
          .maybeSingle()
        : { data: null, error: null };
      if (contact.error) throw new Error(contact.error.message);
      if (!contact.data) {
        return json(res, 400, { error: { message: "customer_contact_id is not a contact of this " + t.object_type + "'s customer" } });
      }
    }

    const now = new Date().toISOString();
    const insert = await svc.from("communications").insert(commsRow({
      tenant_id: ctx.tenantId,
      object_type: t.object_type,
      object_id: t.object_id,
      customer_id: customerId,
      customer_contact_id: t.customer_contact_id,
      document_type: TOUCH_DOCUMENT_TYPE,
      direction: "outbound",
      channel: t.channel,
      body: t.body,
      status: "sent",
      provider: "manual",
      sent_by: ctx.user.id,
      sent_at: now,
      metadata: t.next_followup_at ? { next_followup_at: t.next_followup_at } : undefined,
    })).select("*").single();
    if (insert.error) throw new Error(insert.error.message);

    await recordAudit(ctx, {
      action: "rep_touch_logged",
      objectType: t.object_type,
      objectId: t.object_id,
      detail: t.channel + (t.next_followup_at ? " :: next " + t.next_followup_at : ""),
    });
    return json(res, 200, { communication: insert.data });
  } catch (err) {
    sendError(res, err);
  }
}
