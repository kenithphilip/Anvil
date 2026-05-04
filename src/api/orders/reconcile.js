// POST /api/orders/reconcile
// Body: {
//   order_id,
//   confirmation: {
//     source_type: 'email' | 'pdf' | 'xml' | 'manual',
//     source_id?, source_url?,
//     vendor_id?,
//     lines: [
//       { line_no, part_number?, description?,
//         quantity?, unit_price?, lead_time_days?, currency? }
//     ],
//     terms?: object,
//   }
// }
//
// Diffs the vendor's confirmation against the issued order and
// returns a structured discrepancy report (line, field, expected,
// received, severity). Persists order_reconciliations for audit.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const FIELDS = ["quantity", "unit_price", "lead_time_days", "currency"];
const SEVERITY = {
  quantity: "high",
  unit_price: "high",
  lead_time_days: "medium",
  currency: "high",
};

const compareLines = (orderLines, conf) => {
  const out = [];
  let matching = 0, mismatched = 0;
  const byLine = new Map(orderLines.map((li, i) => [li.line_no || (i + 1), li]));
  for (const c of conf.lines || []) {
    const expected = byLine.get(c.line_no);
    if (!expected) {
      out.push({
        line_no: c.line_no, field: "exists",
        expected: null, received: c, severity: "high",
        note: "extra line in confirmation",
      });
      mismatched += 1;
      continue;
    }
    let lineMatched = true;
    for (const f of FIELDS) {
      if (c[f] === undefined) continue;
      const exp = expected[f] ?? expected[f === "quantity" ? "qty" : f] ?? null;
      const rec = c[f];
      if (exp == null && rec == null) continue;
      if (String(exp) !== String(rec)) {
        out.push({
          line_no: c.line_no, field: f,
          expected: exp, received: rec,
          severity: SEVERITY[f] || "low",
        });
        lineMatched = false;
      }
    }
    if (lineMatched) matching += 1;
    else mismatched += 1;
  }
  // Lines in order that aren't in confirmation.
  const confLineNumbers = new Set((conf.lines || []).map((l) => l.line_no));
  for (const [lineNo, exp] of byLine.entries()) {
    if (!confLineNumbers.has(lineNo)) {
      out.push({
        line_no: lineNo, field: "exists",
        expected: exp, received: null,
        severity: "high",
        note: "line missing from confirmation",
      });
      mismatched += 1;
    }
  }
  return { discrepancies: out, matching, mismatched };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const body = await readBody(req);
    if (!body?.order_id || !body?.confirmation?.lines) {
      return json(res, 400, { error: { message: "order_id and confirmation.lines required" } });
    }
    const svc = serviceClient();
    const orderQ = await svc.from("orders").select("*")
      .eq("tenant_id", ctx.tenantId).eq("id", body.order_id).maybeSingle();
    if (orderQ.error) throw new Error(orderQ.error.message);
    if (!orderQ.data) return json(res, 404, { error: { message: "order not found" } });

    const orderLines = (orderQ.data.result?.salesOrder?.lineItems || [])
      .map((li, i) => ({
        line_no: li.line_no || (i + 1),
        part_number: li.partNumber || li.itemName,
        quantity: Number(li.quantity || li.qty || 0),
        unit_price: Number(li.rate || li.unitPrice || 0),
        currency: orderQ.data.result?.salesOrder?.currency || orderQ.data.currency,
      }));
    const { discrepancies, matching, mismatched } = compareLines(orderLines, body.confirmation);
    const matchStatus = mismatched === 0 ? "match"
      : (matching > 0 ? "partial" : "mismatch");

    const ins = await svc.from("order_reconciliations").insert({
      tenant_id: ctx.tenantId,
      order_id: body.order_id,
      source_type: body.confirmation.source_type || "manual",
      source_id: body.confirmation.source_id || null,
      source_url: body.confirmation.source_url || null,
      vendor_id: body.confirmation.vendor_id || null,
      match_status: matchStatus,
      total_lines: (body.confirmation.lines || []).length,
      matching_lines: matching,
      mismatched_lines: mismatched,
      discrepancies,
      raw: body.confirmation,
    }).select("*").single();
    if (ins.error) throw new Error(ins.error.message);

    await recordAudit(ctx, {
      action: matchStatus === "match" ? "order_reconciled_match"
        : matchStatus === "partial" ? "order_reconciled_partial"
        : "order_reconciled_mismatch",
      objectType: "order",
      objectId: body.order_id,
      detail: matching + "/" + ((body.confirmation.lines || []).length) + " lines match",
    });
    return json(res, 200, {
      reconciliation: ins.data,
      summary: { match_status: matchStatus, matching, mismatched, total: (body.confirmation.lines || []).length },
    });
  } catch (err) { sendError(res, err); }
}
