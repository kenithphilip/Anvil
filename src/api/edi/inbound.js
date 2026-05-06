// POST /api/edi/inbound
// Body: { format: 'x12'|'edifact', payload: '<raw>', partner_id?: '<uuid>' }
//
// Accepts an inbound EDI envelope from a transport-layer service
// (AS2, SFTP poller, Mulesoft). Parses, persists, attempts to link
// to an order (for 850 / ORDERS), and returns a 997/CONTRL ack
// payload the caller can ship back to the partner.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { parseX12, parseEdifact, buildX12_997 } from "../_lib/edi.js";
import { safeAwait } from "../_lib/safe-thenable.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const body = await readBody(req);
    if (!body?.payload) return json(res, 400, { error: { message: "payload required" } });
    const format = body.format || (body.payload.startsWith("ISA") ? "x12" : "edifact");
    const svc = serviceClient();
    let parsed;
    try {
      parsed = format === "x12" ? parseX12(body.payload) : parseEdifact(body.payload);
    } catch (err) {
      return json(res, 400, { error: { message: "parse failed: " + err.message } });
    }
    const ins = await svc.from("edi_envelopes").insert({
      tenant_id: ctx.tenantId,
      partner_id: body.partner_id || null,
      direction: "inbound",
      format,
      message_type: parsed.message_type,
      control_number: parsed.isa_control || parsed.st_control || null,
      raw_payload: body.payload,
      parsed,
      status: "translated",
    }).select("*").single();
    if (ins.error) throw new Error(ins.error.message);
    if (body.partner_id) {
      await safeAwait(svc.rpc("noop"));
      await svc.from("edi_partners").update({ envelopes_in: undefined }).eq("id", body.partner_id);
    }
    // Generate functional ack.
    let ack = null;
    if (format === "x12") {
      ack = buildX12_997({
        sender: parsed.receiver, receiver: parsed.sender,
        ackedGsControl: parsed.gs_control, status: "A",
      });
      await svc.from("edi_envelopes").update({ ack_payload: ack, acknowledged_at: new Date().toISOString() })
        .eq("id", ins.data.id);
    }
    await recordAudit(ctx, {
      action: "edi_inbound",
      objectType: "edi_envelope",
      objectId: ins.data.id,
      detail: format + "::" + parsed.message_type,
    });
    return json(res, 200, { envelope: ins.data, ack });
  } catch (err) { sendError(res, err); }
}
