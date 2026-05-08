// /api/voice/consent
//
//   GET ?phone=+91...                  list consent records for a number
//   POST                                record a fresh consent
//   DELETE ?id=<uuid>                  withdraw consent (sets withdrawn_at;
//                                       the row stays for audit)
//
// Per DEFERRED_ROADMAP §1, prior consent is the gate the
// /api/voice/outbound endpoint enforces before dialing US (TCPA),
// EU (GDPR), and Indian (DPDP) numbers. This endpoint is how the
// operator captures + manages those records.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { recordVoiceConsent, normalizeE164 } from "../_lib/voice-compliance.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const phone = req.query?.phone || null;
      let q = svc.from("voice_consent")
        .select("id, phone_number, customer_id, customer_contact_id, scope, source, source_artifact_url, consented_at, expires_at, withdrawn_at, notes")
        .eq("tenant_id", ctx.tenantId)
        .order("consented_at", { ascending: false })
        .limit(200);
      if (phone) {
        const e164 = normalizeE164(phone);
        if (!e164) return json(res, 400, { error: { message: "phone could not be parsed to E.164" } });
        q = q.eq("phone_number", e164);
      }
      const r = await q;
      if (r.error) throw new Error(r.error.message);
      return json(res, 200, { rows: r.data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body?.phone_number) return json(res, 400, { error: { message: "phone_number required" } });
      if (!body?.source) return json(res, 400, { error: { message: "source required (one of: inbound_call, inbound_message, signed_agreement, opt_in_form, recorded_verbal, manual_attestation)" } });
      let result;
      try {
        result = await recordVoiceConsent(svc, {
          tenantId: ctx.tenantId,
          phoneNumber: body.phone_number,
          source: body.source,
          customerId: body.customer_id,
          customerContactId: body.customer_contact_id,
          expiresAt: body.expires_at,
          sourceArtifactUrl: body.source_artifact_url,
          notes: body.notes,
          createdBy: ctx.user?.id || null,
        });
      } catch (err) {
        return json(res, 400, { error: { message: err.message } });
      }
      await recordAudit(ctx, {
        action: "voice_consent_recorded",
        objectType: "voice_consent",
        objectId: result.id,
        detail: result.phone_number + "::" + body.source,
      });
      return json(res, 200, { id: result.id, phone_number: result.phone_number });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "write");
      const id = req.query?.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const upd = await svc.from("voice_consent")
        .update({ withdrawn_at: new Date().toISOString() })
        .eq("tenant_id", ctx.tenantId)
        .eq("id", id)
        .select("id, phone_number")
        .single();
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, {
        action: "voice_consent_withdrawn",
        objectType: "voice_consent",
        objectId: upd.data.id,
        detail: upd.data.phone_number,
      });
      return json(res, 200, { id: upd.data.id, withdrawn: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
