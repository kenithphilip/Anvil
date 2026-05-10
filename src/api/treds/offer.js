// /api/treds/offer
//   POST  { invoice_id, supplier_bank_account? }   submit an invoice
//                                                    to TReDS for factoring
//   GET                                             list offers
//   GET   ?id=<offer-id>                            poll one offer
//   PATCH { id }                                    refresh status from
//                                                    upstream
//
// SANDBOX mode walks the auction state submitted -> live -> won
// over a few minutes of wall-clock time so the UI + cron can
// drive the flow without real M1xchange access.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import {
  submitFactoring, getAuctionStatus, m1xchangeMode,
} from "../_lib/treds/m1xchange-client.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    const url = new URL(req.url, "http://_");

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const id = url.searchParams.get("id");
      if (id) {
        const r = await svc.from("treds_offers").select("*")
          .eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
        if (r.error) throw new Error(r.error.message);
        return json(res, 200, { offer: r.data || null });
      }
      const invoiceId = url.searchParams.get("invoice_id");
      let q = svc.from("treds_offers").select("*")
        .eq("tenant_id", ctx.tenantId)
        .order("created_at", { ascending: false })
        .limit(100);
      if (invoiceId) q = q.eq("invoice_id", invoiceId);
      const r = await q;
      if (r.error) throw new Error(r.error.message);
      return json(res, 200, { offers: r.data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body.invoice_id) {
        return json(res, 400, { error: { message: "invoice_id required" } });
      }

      // Pull the invoice + buyer GSTIN. The buyer GSTIN is on the
      // customer record (not the invoice itself), so we join.
      const inv = await svc.from("invoices").select(
        "id, customer_id, invoice_number, grand_total, due_date, currency, discounted_via_treds_at",
      )
        .eq("tenant_id", ctx.tenantId).eq("id", body.invoice_id).maybeSingle();
      if (inv.error) throw new Error(inv.error.message);
      if (!inv.data) return json(res, 404, { error: { message: "invoice not found" } });
      if (inv.data.currency !== "INR") {
        return json(res, 400, { error: { message: "TReDS supports INR invoices only" } });
      }
      if (inv.data.discounted_via_treds_at) {
        return json(res, 409, { error: { message: "invoice already discounted" } });
      }

      let buyerGstin = body.buyer_gstin;
      if (!buyerGstin && inv.data.customer_id) {
        const c = await svc.from("customers").select("gstin")
          .eq("tenant_id", ctx.tenantId).eq("id", inv.data.customer_id).maybeSingle();
        buyerGstin = c.data?.gstin || null;
      }
      if (!buyerGstin) {
        return json(res, 400, { error: { message: "buyer GSTIN required (invoice customer has no GSTIN)" } });
      }

      // Minimum invoice threshold from tenant_settings.
      const settings = await tenantSettings(svc, ctx.tenantId);
      const minInr = Number(settings?.treds_min_invoice_inr) || 100000;
      if (Number(inv.data.grand_total) < minInr) {
        return json(res, 400, {
          error: { message: "invoice below tenant TReDS minimum (Rs " + minInr + ")" },
        });
      }

      const mode = m1xchangeMode(settings || {});
      const upstream = await submitFactoring(settings || {}, {
        tenantId: ctx.tenantId,
        invoiceId: body.invoice_id,
        invoiceNumber: inv.data.invoice_number,
        buyerGstin,
        amountInr: Number(inv.data.grand_total),
        dueDate: inv.data.due_date,
        supplierBankAccount: body.supplier_bank_account || null,
      });

      const row = {
        tenant_id: ctx.tenantId,
        invoice_id: body.invoice_id,
        treds_platform: mode === "sandbox" ? "sandbox" : (settings?.treds_provider || "m1xchange"),
        external_factoring_id: upstream.external_factoring_id,
        buyer_gstin: buyerGstin,
        amount_inr: Number(inv.data.grand_total),
        due_date: inv.data.due_date,
        auction_status: upstream.auction_status || "submitted",
        is_sandbox: !!upstream.is_sandbox,
        raw: upstream,
      };
      const up = await svc.from("treds_offers")
        .upsert(row, { onConflict: "tenant_id,treds_platform,external_factoring_id" })
        .select("*").maybeSingle();
      if (up.error) throw new Error(up.error.message);

      await recordAudit(ctx, {
        action: "treds.offer.submitted",
        objectType: "treds_offer",
        objectId: up.data?.id,
        detail: {
          invoice_id: body.invoice_id,
          mode,
          external_factoring_id: upstream.external_factoring_id,
        },
      });

      return json(res, 200, { offer: up.data, mode });
    }

    if (req.method === "PATCH") {
      requirePermission(ctx, "read");
      const body = await readBody(req);
      if (!body.id) return json(res, 400, { error: { message: "id required" } });
      const existing = await svc.from("treds_offers").select("*")
        .eq("tenant_id", ctx.tenantId).eq("id", body.id).maybeSingle();
      if (existing.error) throw new Error(existing.error.message);
      if (!existing.data) return json(res, 404, { error: { message: "offer not found" } });

      const settings = await tenantSettings(svc, ctx.tenantId);
      const upstream = await getAuctionStatus(
        settings || {},
        existing.data.external_factoring_id,
        {
          start: new Date(existing.data.created_at).getTime(),
          amountInr: Number(existing.data.amount_inr),
        },
      );
      const upd = await svc.from("treds_offers").update({
        auction_status: upstream.status || existing.data.auction_status,
        best_rate_bps: upstream.best_rate_bps ?? existing.data.best_rate_bps,
        best_financier_name: upstream.best_financier_name || existing.data.best_financier_name,
        net_amount_inr: upstream.net_amount_inr ?? existing.data.net_amount_inr,
        raw: { ...existing.data.raw, last_poll: upstream },
      }).eq("id", body.id).select("*").maybeSingle();
      if (upd.error) throw new Error(upd.error.message);
      return json(res, 200, { offer: upd.data });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
