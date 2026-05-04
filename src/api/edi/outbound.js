// POST /api/edi/outbound
// Body: { format, message_type, partner_id, payload, source_envelope_id?, order_id?, invoice_id? }
//
// Renders an X12 / EDIFACT envelope from a canonical payload, persists
// the outbound row, and returns the raw string. Transport (AS2/SFTP)
// is the caller's job; we expose this via /api/edi/outbound so the
// caller pulls the envelope and ships it.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { buildX12, buildEdifact } from "../_lib/edi.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const body = await readBody(req);
    if (!body?.message_type || !body?.payload) {
      return json(res, 400, { error: { message: "message_type and payload required" } });
    }
    const format = body.format || (["850", "855", "856", "810"].includes(body.message_type) ? "x12" : "edifact");
    const svc = serviceClient();

    let partner = null;
    if (body.partner_id) {
      const r = await svc.from("edi_partners").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.partner_id).maybeSingle();
      partner = r.data || null;
    }

    let raw;
    try {
      if (format === "x12") {
        raw = buildX12({
          messageType: body.message_type,
          sender: partner?.isa_id || body.sender,
          receiver: partner?.partner_isa_id || body.receiver,
          controlNumber: body.control_number,
          payload: body.payload,
        });
      } else {
        raw = buildEdifact({
          messageType: body.message_type,
          sender: partner?.isa_id || body.sender,
          receiver: partner?.partner_isa_id || body.receiver,
          controlNumber: body.control_number,
          payload: body.payload,
        });
      }
    } catch (err) {
      return json(res, 400, { error: { message: "build failed: " + err.message } });
    }

    const ins = await svc.from("edi_envelopes").insert({
      tenant_id: ctx.tenantId,
      partner_id: body.partner_id || null,
      direction: "outbound",
      format,
      message_type: body.message_type,
      raw_payload: raw,
      parsed: body.payload,
      order_id: body.order_id || null,
      invoice_id: body.invoice_id || null,
      status: "translated",
    }).select("*").single();
    if (ins.error) throw new Error(ins.error.message);
    await recordAudit(ctx, {
      action: "edi_outbound",
      objectType: "edi_envelope",
      objectId: ins.data.id,
      detail: format + "::" + body.message_type,
    });
    return json(res, 200, { envelope: ins.data, payload: raw });
  } catch (err) { sendError(res, err); }
}
