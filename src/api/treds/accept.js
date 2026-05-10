// POST /api/treds/accept
//   { offer_id }
//
// Accept the winning bid on a TReDS offer. Creates a
// treds_discounts row, stamps invoices.discounted_via_treds_at,
// and writes the audit_events row. Settlement is T+1 to the
// supplier bank.
//
// Sandbox: the underlying m1xchange-client returns a canned
// disbursement with a mock UTR; everything else flows through
// normal DB writes so the operator UI looks the same.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import {
  acceptBestBid, getAuctionStatus, m1xchangeMode,
} from "../_lib/treds/m1xchange-client.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    if (req.method !== "POST") {
      return json(res, 405, { error: { message: "Method not allowed" } });
    }
    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    const body = await readBody(req);
    if (!body.offer_id) {
      return json(res, 400, { error: { message: "offer_id required" } });
    }
    const svc = serviceClient();
    const offer = await svc.from("treds_offers").select("*")
      .eq("tenant_id", ctx.tenantId).eq("id", body.offer_id).maybeSingle();
    if (offer.error) throw new Error(offer.error.message);
    if (!offer.data) return json(res, 404, { error: { message: "offer not found" } });
    if (offer.data.auction_status !== "live" && offer.data.auction_status !== "won") {
      return json(res, 409, {
        error: { message: "offer auction_status must be live or won, got " + offer.data.auction_status },
      });
    }

    const settings = await tenantSettings(svc, ctx.tenantId);
    const mode = m1xchangeMode(settings || {});

    // Refresh status first so we have a winning bid to record.
    const auction = await getAuctionStatus(
      settings || {},
      offer.data.external_factoring_id,
      {
        start: new Date(offer.data.created_at).getTime(),
        amountInr: Number(offer.data.amount_inr),
      },
    );
    if (auction.status !== "won") {
      return json(res, 409, {
        error: { message: "auction not won yet; status=" + auction.status },
      });
    }

    const disb = await acceptBestBid(settings || {}, offer.data.external_factoring_id, {
      amountInr: Number(offer.data.amount_inr),
    });

    // Persist the discount row + flip the offer status to won + stamp the invoice.
    const discRow = {
      tenant_id: ctx.tenantId,
      offer_id: offer.data.id,
      invoice_id: offer.data.invoice_id,
      financier_name: disb.financier_name,
      rate_bps: disb.rate_bps,
      amount_inr: Number(offer.data.amount_inr),
      net_to_supplier_inr: disb.net_to_supplier_inr,
      platform_fee_inr: disb.platform_fee_inr,
      settlement_at: disb.settlement_at,
      status: disb.status || "disbursed",
      utr: disb.utr || null,
      is_sandbox: !!disb.is_sandbox,
      raw: disb,
    };
    const discIns = await svc.from("treds_discounts")
      .upsert(discRow, { onConflict: "tenant_id,offer_id" })
      .select("*").maybeSingle();
    if (discIns.error) throw new Error(discIns.error.message);

    await svc.from("treds_offers").update({
      auction_status: "won",
      best_rate_bps: disb.rate_bps,
      best_financier_name: disb.financier_name,
      net_amount_inr: disb.net_to_supplier_inr,
      raw: { ...offer.data.raw, disbursement: disb },
    }).eq("id", offer.data.id);

    await svc.from("invoices").update({
      discounted_via_treds_at: new Date().toISOString(),
    }).eq("tenant_id", ctx.tenantId).eq("id", offer.data.invoice_id);

    await recordAudit(ctx, {
      action: "treds.discount.accepted",
      objectType: "treds_discount",
      objectId: discIns.data?.id,
      detail: {
        invoice_id: offer.data.invoice_id,
        offer_id: offer.data.id,
        mode,
        financier: disb.financier_name,
        net: disb.net_to_supplier_inr,
        utr: disb.utr,
      },
    });

    return json(res, 200, { discount: discIns.data, mode });
  } catch (err) { sendError(res, err); }
}
