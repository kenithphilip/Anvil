// GET /api/supplier_rfq/matrix?rfq_id=...
//
// Returns a comparison matrix keyed by line, with a column per
// vendor showing unit_price, lead_time_days, delta to target_price,
// and a winner-flag for the lowest price within each line.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

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
      // Pick winner: lowest unit_price across cells with a price.
      const priced = cells.filter((c) => c.unit_price != null);
      if (priced.length) {
        const min = priced.reduce((a, b) => a.unit_price < b.unit_price ? a : b);
        min.winner = true;
      }
      return {
        line_no: line.line_no,
        part_number: line.part_number,
        description: line.description,
        quantity: line.quantity,
        uom: line.uom,
        target_price: line.target_price,
        cells,
      };
    });

    return json(res, 200, {
      rfq_id: rfqId,
      vendors: vendorIds.map((id) => vendorById.get(id) || { id, vendor_name: id.slice(0, 8) }),
      matrix,
    });
  } catch (err) { sendError(res, err); }
}
