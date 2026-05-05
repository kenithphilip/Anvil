// /api/ap/match
//
//   GET   list AP invoices and their match status for the calling tenant.
//   POST  body: { ap_invoice_id }. Run the 3-way match for a single
//         invoice. Joins (source_po, goods_receipt, ap_invoice) and
//         flags discrepancies above tolerance. Within tolerance and
//         when ap_auto_approve_within_tolerance=true, sets
//         match_status='approved' so the invoice can be paid.
//
// Phase 6 (C.5).

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings } from "../_lib/stripe-client.js";

const matchOne = async (svc, tenantId, apInvoiceId, tolerances) => {
  const inv = await svc.from("ap_invoices").select("*").eq("tenant_id", tenantId).eq("id", apInvoiceId).maybeSingle();
  if (inv.error) throw new Error(inv.error.message);
  if (!inv.data) return { ok: false, error: "ap invoice not found" };

  const lines = await svc.from("ap_invoice_lines").select("*").eq("ap_invoice_id", apInvoiceId);
  if (lines.error) throw new Error(lines.error.message);

  let po = null;
  let receipts = [];
  if (inv.data.source_po_id) {
    const poQ = await svc.from("source_pos").select("*").eq("id", inv.data.source_po_id).maybeSingle();
    po = poQ.data || null;
    const recQ = await svc.from("ap_goods_receipts").select("*")
      .eq("tenant_id", tenantId).eq("source_po_id", inv.data.source_po_id);
    receipts = recQ.data || [];
  }

  // Aggregate received quantities per po_line_ref.
  const receivedByLine = {};
  for (const r of receipts) {
    for (const ln of (r.lines || [])) {
      const key = String(ln.po_line_ref || ln.line_no || "");
      receivedByLine[key] = (receivedByLine[key] || 0) + Number(ln.received_qty || ln.qty || 0);
    }
  }

  // Compute per-line variance against the source PO + the goods
  // receipt total. Tolerances are pct-based for price, absolute for
  // quantity.
  const tolerancePct = Number(tolerances.ap_tolerance_pct ?? 2.0);
  const maxQtyVariance = Number(tolerances.ap_max_qty_variance ?? 0);
  const findings = [];
  let priceMismatch = 0;
  let qtyMismatch = 0;
  let receiptShort = 0;

  const poLines = po?.line_items || po?.lines || [];
  const poByRef = new Map();
  for (const pl of poLines) {
    poByRef.set(String(pl.line_no || pl.line || pl.po_line_ref || pl.id), pl);
  }

  for (const il of (lines.data || [])) {
    const ref = String(il.po_line_ref || il.line_no);
    const pl = poByRef.get(ref);
    const received = Number(receivedByLine[ref] || 0);
    if (!pl) {
      findings.push({ line: il.line_no, kind: "no_po_line", note: "Invoice line has no matching PO line" });
      priceMismatch += 1;
      continue;
    }
    const poUnit = Number(pl.unit_price ?? pl.price ?? 0);
    const invUnit = Number(il.unit_price);
    const priceDeltaPct = poUnit > 0 ? Math.abs(invUnit - poUnit) / poUnit * 100 : (invUnit > 0 ? 100 : 0);
    if (priceDeltaPct > tolerancePct) {
      findings.push({ line: il.line_no, kind: "price_above_tolerance",
        po_unit: poUnit, invoice_unit: invUnit, delta_pct: priceDeltaPct.toFixed(2) });
      priceMismatch += 1;
    }
    const invQty = Number(il.quantity);
    const poQty = Number(pl.quantity ?? pl.qty ?? 0);
    if (Math.abs(invQty - poQty) > maxQtyVariance) {
      findings.push({ line: il.line_no, kind: "qty_above_tolerance",
        po_qty: poQty, invoice_qty: invQty });
      qtyMismatch += 1;
    }
    if (received < invQty) {
      findings.push({ line: il.line_no, kind: "receipt_short",
        invoice_qty: invQty, received_qty: received });
      receiptShort += 1;
    }
  }

  const everythingClean = findings.length === 0;
  const score = (lines.data || []).length > 0
    ? Math.max(0, 100 - (priceMismatch * 30 + qtyMismatch * 20 + receiptShort * 15))
    : 0;
  const matchStatus = everythingClean
    ? (tolerances.ap_auto_approve_within_tolerance ? "approved" : "matched")
    : "mismatched";
  const details = {
    findings,
    counts: { price_mismatch: priceMismatch, qty_mismatch: qtyMismatch, receipt_short: receiptShort },
    matched_at: new Date().toISOString(),
  };
  await svc.from("ap_invoices").update({
    match_status: matchStatus,
    match_score: score,
    match_details: details,
    updated_at: new Date().toISOString(),
  }).eq("tenant_id", tenantId).eq("id", apInvoiceId);

  return { ok: true, ap_invoice_id: apInvoiceId, match_status: matchStatus, match_score: score, details };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const svc = serviceClient();

    if (req.method === "GET") {
      const r = await svc.from("ap_invoices")
        .select("id, vendor_invoice_number, vendor_id, source_po_id, grand_total, currency, match_status, match_score, invoice_date")
        .eq("tenant_id", ctx.tenantId)
        .order("invoice_date", { ascending: false })
        .limit(200);
      if (r.error) throw new Error(r.error.message);
      return json(res, 200, { invoices: r.data || [], count: (r.data || []).length });
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      if (!body?.ap_invoice_id) return json(res, 400, { error: { message: "ap_invoice_id required" } });
      const settings = await tenantSettings(svc, ctx.tenantId);
      const result = await matchOne(svc, ctx.tenantId, body.ap_invoice_id, {
        ap_tolerance_pct: settings.ap_tolerance_pct,
        ap_max_qty_variance: settings.ap_max_qty_variance,
        ap_auto_approve_within_tolerance: settings.ap_auto_approve_within_tolerance ?? true,
      });
      if (!result.ok) return json(res, 404, { error: { message: result.error } });
      await recordAudit(ctx, {
        action: "ap_three_way_match",
        objectType: "ap_invoice",
        objectId: body.ap_invoice_id,
        detail: result.match_status + "::score=" + result.match_score,
      });
      return json(res, 200, result);
    }

    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    return sendError(res, err);
  }
}
