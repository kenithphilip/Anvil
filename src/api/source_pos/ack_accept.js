// POST /api/source_pos/<id>/ack_accept
//
// Phase F.2 follow-through. After /api/source_pos/<id>/ack_extract
// has parsed a supplier-ack PDF and the operator has reviewed the
// extracted fields, this endpoint commits them into the canonical
// source_pos record. It is the sole path that:
//
//   1. Reads the supplier_ack_extractions review row.
//   2. Builds the structured `ack` payload the legacy
//      /api/source_pos/ack handler expects.
//   3. Updates source_pos with the confirmed price + ETA + status,
//      maintaining variance + scorecard logic by reusing the same
//      logic as ack.js (composed inline rather than fan-out so the
//      audit trail is one transaction).
//   4. Stamps supplier_ack_extractions.status = 'accepted' +
//      forwarded_at + ack_payload so the workspace can render
//      "applied to source_po by user@time."
//
// Body:
//   {
//     supplier_ack_extraction_id: uuid,
//     overrides?: { confirmed_price?, confirmed_eta?, supplier_ref?, ... }
//                  // operator edits to the extracted values before commit
//   }
//
// Response: { source_po, supplier_ack_extraction, variance: {...} }

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit, recordEvent } from "../_lib/audit.js";

const idFromUrl = (req) => {
  const u = String(req.url || "");
  const m = u.match(/\/source_pos\/([^/?]+)\/ack_accept/);
  return m ? m[1] : null;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");                    // higher bar than write: this commits to source_pos
    const sourcePoId = req.query?.id || idFromUrl(req);
    if (!sourcePoId) return json(res, 400, { error: { message: "source_po id required in URL" } });
    const body = await readBody(req);
    if (!body?.supplier_ack_extraction_id) {
      return json(res, 400, { error: { message: "supplier_ack_extraction_id required" } });
    }
    const svc = serviceClient();

    // Verify source PO + load review row.
    const spo = await svc.from("source_pos")
      .select("*")
      .eq("tenant_id", ctx.tenantId).eq("id", sourcePoId).maybeSingle();
    if (spo.error) throw new Error(spo.error.message);
    if (!spo.data) return json(res, 404, { error: { message: "Source PO not found" } });

    const review = await svc.from("supplier_ack_extractions")
      .select("*")
      .eq("tenant_id", ctx.tenantId)
      .eq("id", body.supplier_ack_extraction_id)
      .eq("source_po_id", sourcePoId)
      .maybeSingle();
    if (review.error) throw new Error(review.error.message);
    if (!review.data) return json(res, 404, { error: { message: "supplier ack extraction not found" } });
    if (review.data.status !== "extracted") {
      return json(res, 409, {
        error: { message: "extraction already in status " + review.data.status },
      });
    }

    // Compose the ack payload, applying any operator edits.
    const o = body.overrides || {};
    const ackPayload = {
      supplierRef: o.supplier_ref ?? review.data.supplier_ref ?? null,
      confirmedPrice: o.confirmed_price ?? review.data.confirmed_price ?? null,
      confirmedCurrency: o.confirmed_currency ?? review.data.confirmed_currency ?? null,
      confirmedEta: o.confirmed_eta ?? review.data.confirmed_eta ?? null,
      paymentTerms: o.payment_terms ?? review.data.payment_terms ?? null,
      remarks: o.remarks ?? review.data.remarks ?? null,
      lineAcks: Array.isArray(o.line_acks) ? o.line_acks
                : Array.isArray(review.data.line_acks) ? review.data.line_acks
                : [],
      _source: {
        kind: "supplier_ack_extraction",
        extraction_run_id: review.data.extraction_run_id,
        supplier_ack_extraction_id: review.data.id,
      },
    };

    // Same variance logic as /api/source_pos/ack so price / eta /
    // status flow consistently. Inlined to keep the accept path
    // atomic + auditable.
    const expectedPrice = Number(spo.data.total_foreign || 0);
    const ackPrice = Number(ackPayload.confirmedPrice ?? 0);
    const priceVariancePct = expectedPrice > 0
      ? ((ackPrice - expectedPrice) / expectedPrice) * 100
      : 0;
    const expectedEta = spo.data.acknowledged_eta
      || (spo.data.payload && spo.data.payload.expectedEta)
      || null;
    const ackEta = ackPayload.confirmedEta || null;
    const etaVarianceDays = (expectedEta && ackEta)
      ? Math.round((new Date(ackEta).getTime() - new Date(expectedEta).getTime()) / 86_400_000)
      : 0;
    const status = ackPrice && Math.abs(priceVariancePct) > 1
      ? "PRICE_CHANGED"
      : (ackEta && etaVarianceDays > 7 ? "DELAYED" : "SUPPLIER_ACK");

    const updated = await svc.from("source_pos").update({
      ack_received_at: new Date().toISOString(),
      ack_payload: ackPayload,
      acknowledged_price: ackPrice || spo.data.acknowledged_price,
      acknowledged_eta: ackEta || spo.data.acknowledged_eta,
      price_variance_pct: priceVariancePct,
      eta_variance_days: etaVarianceDays,
      status,
    }).eq("tenant_id", ctx.tenantId).eq("id", sourcePoId).select("*").single();
    if (updated.error) throw new Error(updated.error.message);

    await svc.from("source_po_events").insert({
      tenant_id: ctx.tenantId,
      source_po_id: sourcePoId,
      from_status: spo.data.status,
      to_status: status,
      detail: "supplier ack (extracted): priceVar="
        + priceVariancePct.toFixed(2) + "% etaVar=" + etaVarianceDays + "d "
        + "(extraction_run=" + review.data.extraction_run_id + ")",
      actor: ctx.user ? ctx.user.id : null,
    });

    // Mark the review row accepted + stamp the forward.
    const reviewUpdate = await svc.from("supplier_ack_extractions").update({
      status: "accepted",
      reviewed_by: ctx.userId || null,
      reviewed_at: new Date().toISOString(),
      forwarded_at: new Date().toISOString(),
      forwarded_by: ctx.userId || null,
      ack_payload: ackPayload,
    }).eq("id", review.data.id).select("*").single();
    if (reviewUpdate.error) throw new Error(reviewUpdate.error.message);

    await recordAudit(ctx, {
      action: "supplier_ack_accepted",
      objectType: "source_po",
      objectId: sourcePoId,
      detail: status + "::priceVar=" + priceVariancePct.toFixed(2) + "%",
      after: { priceVariancePct, etaVarianceDays, supplier_ack_extraction_id: review.data.id },
    });
    await recordEvent(ctx, {
      eventType: "supplier_ack_accepted",
      objectType: "source_po",
      objectId: sourcePoId,
      caseId: spo.data.order_id || sourcePoId,
      detail: { status, priceVariancePct, etaVarianceDays, supplier_ack_extraction_id: review.data.id },
    });

    return json(res, 200, {
      source_po: updated.data,
      supplier_ack_extraction: reviewUpdate.data,
      variance: { priceVariancePct, etaVarianceDays },
      status,
    });
  } catch (err) { sendError(res, err); }
}
