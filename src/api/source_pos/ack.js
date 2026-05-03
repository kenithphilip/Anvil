// POST /api/source_pos/ack
// Body: { sourcePoId, ack: { confirmedPrice?, confirmedEta?, supplierRef?, raw? } }
// Compares acknowledgement against the source PO, records variance, updates status.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit, recordEvent } from "../_lib/audit.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = await readBody(req);
    if (!body || !body.sourcePoId || !body.ack) return json(res, 400, { error: { message: "sourcePoId and ack required" } });
    const svc = serviceClient();
    const spo = await svc.from("source_pos").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.sourcePoId).single();
    if (spo.error || !spo.data) return json(res, 404, { error: { message: "Source PO not found" } });
    const expectedPrice = Number(spo.data.total_foreign || 0);
    const ackPrice = Number(body.ack.confirmedPrice != null ? body.ack.confirmedPrice : 0);
    const priceVariancePct = expectedPrice > 0 ? ((ackPrice - expectedPrice) / expectedPrice) * 100 : 0;
    const expectedEta = spo.data.acknowledged_eta || (spo.data.payload && spo.data.payload.expectedEta) || null;
    const ackEta = body.ack.confirmedEta || null;
    const etaVarianceDays = expectedEta && ackEta ? Math.round((new Date(ackEta).getTime() - new Date(expectedEta).getTime()) / 86400000) : 0;
    const status = ackPrice && Math.abs(priceVariancePct) > 1 ? "PRICE_CHANGED" : ackEta && etaVarianceDays > 7 ? "DELAYED" : "SUPPLIER_ACK";

    const updated = await svc.from("source_pos").update({
      ack_received_at: new Date().toISOString(),
      ack_payload: body.ack,
      acknowledged_price: ackPrice || spo.data.acknowledged_price,
      acknowledged_eta: ackEta || spo.data.acknowledged_eta,
      price_variance_pct: priceVariancePct,
      eta_variance_days: etaVarianceDays,
      status,
    }).eq("tenant_id", ctx.tenantId).eq("id", body.sourcePoId).select("*").single();
    if (updated.error) throw new Error(updated.error.message);

    await svc.from("source_po_events").insert({ tenant_id: ctx.tenantId, source_po_id: body.sourcePoId, from_status: spo.data.status, to_status: status, detail: "supplier ack: priceVar=" + priceVariancePct.toFixed(2) + "% etaVar=" + etaVarianceDays + "d", actor: ctx.user ? ctx.user.id : null });

    // Update supplier scorecard
    const supplier = spo.data.supplier;
    if (supplier) {
      const onTime = etaVarianceDays <= 0 ? 1 : 0;
      const accurate = Math.abs(priceVariancePct) <= 1 ? 1 : 0;
      const existing = await svc.from("supplier_scorecards").select("*").eq("tenant_id", ctx.tenantId).eq("supplier", supplier).maybeSingle();
      if (existing.data) {
        const total = existing.data.total_acks + 1;
        const onTimePct = ((existing.data.on_time_pct * existing.data.total_acks) + onTime * 100) / total;
        const accuracyPct = ((existing.data.price_accuracy_pct * existing.data.total_acks) + accurate * 100) / total;
        await svc.from("supplier_scorecards").update({
          on_time_pct: onTimePct,
          price_accuracy_pct: accuracyPct,
          total_acks: total,
          variance_count: existing.data.variance_count + (Math.abs(priceVariancePct) > 1 || etaVarianceDays > 7 ? 1 : 0),
          last_updated: new Date().toISOString(),
        }).eq("id", existing.data.id);
      } else {
        await svc.from("supplier_scorecards").insert({
          tenant_id: ctx.tenantId,
          supplier,
          country: spo.data.country,
          on_time_pct: onTime * 100,
          price_accuracy_pct: accurate * 100,
          total_acks: 1,
          variance_count: Math.abs(priceVariancePct) > 1 || etaVarianceDays > 7 ? 1 : 0,
        });
      }
    }

    await recordAudit(ctx, { action: "source_po_ack", objectType: "source_po", objectId: body.sourcePoId, detail: status, after: { priceVariancePct, etaVarianceDays } });
    await recordEvent(ctx, { caseId: spo.data.order_id || body.sourcePoId, eventType: "supplier_ack_received", objectType: "source_po", objectId: body.sourcePoId, detail: { status, priceVariancePct, etaVarianceDays } });

    return json(res, 200, { sourcePo: updated.data, priceVariancePct, etaVarianceDays, status });
  } catch (err) {
    sendError(res, err);
  }
}
