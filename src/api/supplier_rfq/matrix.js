// GET /api/supplier_rfq/matrix?rfq_id=...
//
// Returns a comparison matrix keyed by line, with a column per
// vendor showing unit_price, lead_time_days, delta to target_price,
// and a winner-flag for the lowest price within each line.
//
// "Lowest price" is now lowest CONVERTED price. This endpoint used to crown
// the winner with a raw numeric comparison across cells that each carry their
// own `currency` column, sitting on the same row and never read — so a JPY bid
// beat a USD bid on the digits alone. For an importer sourcing from JP, KR and
// CN that is not an edge case, it is the normal shape of an RFQ.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { rankCells, currenciesNeeded } from "../_lib/rfq-compare.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const url = new URL(req.url, "http://x");
    const rfqId = url.searchParams.get("rfq_id");
    if (!rfqId) return json(res, 400, { error: { message: "rfq_id required" } });
    const svc = serviceClient();

    const BASE_CCY = "INR";
    const [linesQ, invitationsQ, quotesQ, vendorsQ] = await Promise.all([
      svc.from("supplier_rfq_lines").select("*").eq("tenant_id", ctx.tenantId).eq("rfq_id", rfqId).order("line_no"),
      svc.from("supplier_rfq_invitations").select("*").eq("tenant_id", ctx.tenantId).eq("rfq_id", rfqId),
      svc.from("supplier_quotes").select("*").eq("tenant_id", ctx.tenantId).eq("rfq_id", rfqId),
      svc.from("vendors").select("id, vendor_name, default_lead_time_days, payment_terms").eq("tenant_id", ctx.tenantId),
    ]);
    if (linesQ.error) throw new Error(linesQ.error.message);
    const lines = linesQ.data || [];
    const invitations = invitationsQ.data || [];
    const quotes = quotesQ.data || [];
    const vendorById = new Map((vendorsQ.data || []).map((v) => [v.id, v]));

    // One rate lookup for every foreign currency the quotes actually use.
    // Most recent row at or before today per currency; a currency with no row
    // simply stays absent, and rankCells then refuses to crown a winner rather
    // than comparing raw numbers — which is the bug this replaced.
    const base = BASE_CCY;
    const needed = currenciesNeeded(quotes, base);
    const fxRates = {};
    if (needed.length) {
      const fxQ = await svc.from("fx_rates")
        .select("from_ccy, to_ccy, rate, as_of")
        .eq("tenant_id", ctx.tenantId)
        .eq("to_ccy", base)
        .in("from_ccy", needed)
        .lte("as_of", new Date().toISOString().slice(0, 10))
        .order("as_of", { ascending: false });
      // A failed FX read is not fatal: the matrix still renders every bid, it
      // just declines to name a winner. Losing the whole comparison because a
      // rate table hiccuped would be worse than losing the badge.
      for (const row of (!fxQ.error && fxQ.data) || []) {
        if (fxRates[row.from_ccy] == null) fxRates[row.from_ccy] = Number(row.rate);
      }
    }

    const vendorIds = Array.from(new Set(invitations.map((i) => i.vendor_id)));
    const matrix = lines.map((line) => {
      const cells = vendorIds.map((vendorId) => {
        const q = quotes.find((qq) => qq.vendor_id === vendorId && qq.line_no === line.line_no);
        const v = vendorById.get(vendorId);
        return q ? {
          vendor_id: vendorId,
          vendor_name: v?.vendor_name || vendorId.slice(0, 8),
          unit_price: q.unit_price != null ? Number(q.unit_price) : null,
          lead_time_days: q.lead_time_days ?? v?.default_lead_time_days ?? null,
          currency: q.currency || "USD",
          validity_days: q.validity_days || null,
          notes: q.notes || null,
          delta_to_target: line.target_price != null && q.unit_price != null
            ? Math.round((Number(q.unit_price) - Number(line.target_price)) * 100) / 100
            : null,
          winner: false,
        } : {
          vendor_id: vendorId,
          vendor_name: v?.vendor_name || vendorId.slice(0, 8),
          unit_price: null, lead_time_days: null,
          notes: null, winner: false,
          status: invitations.find((i) => i.vendor_id === vendorId)?.response_status || "pending",
        };
      });
      // Lowest CONVERTED price. Where a rate is missing no winner is crowned
      // at all — ranking the convertible subset would answer "cheapest of the
      // ones we could price" while wearing the label "cheapest".
      const ranked = rankCells(cells, { base, rates: fxRates });
      return {
        line_no: line.line_no,
        part_number: line.part_number,
        description: line.description,
        quantity: line.quantity,
        uom: line.uom,
        target_price: line.target_price,
        cells: ranked.cells,
        comparison_base: base,
        comparable: ranked.comparable,
        // Why no winner, when there is none.
        not_comparable_reason: ranked.reason,
        missing_rates: ranked.missing_rates,
        tied_vendors: ranked.tied || [],
        // Reported, not acted on: ranking by price cannot see that the
        // cheapest bid is also the slowest.
        slowest_is_cheapest: ranked.slowest_is_cheapest || false,
      };
    });

    return json(res, 200, {
      rfq_id: rfqId,
      vendors: vendorIds.map((id) => vendorById.get(id) || { id, vendor_name: id.slice(0, 8) }),
      matrix,
    });
  } catch (err) { sendError(res, err); }
}
