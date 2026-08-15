// GET /api/sales/part_tracking?q=<part or description>&limit=
//
// "Where is my TNA-16-04-40-2?" — the question a customer actually asks.
//
// shipment_import has persisted per-part rows into shipment_lines (mig 209)
// since PR #393, and until now exactly ONE thing read them: the Pending Sales
// Order tracker, server-side. There was no way to ask which shipment carried a
// part, so an operator answered from the spreadsheet the import exists to
// replace.
//
// Returns one row per shipment_line, each carrying its shipment's ladder —
// sailing, port arrival, warehouse receipt — so the answer is "on XIN MEI ZHOU,
// arrived Nhava Sheva 12 Aug, received 15 Aug" rather than a row id.
//
// READ-ONLY. Tenant-scoped through the service client, like its neighbours.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

// PostgREST `or=` is comma-separated and treats , ( ) . as syntax, so a raw
// part number containing them would break the filter or, worse, alter it.
// Stripping them narrows the search rather than corrupting it.
export const sanitiseTerm = (q) =>
  String(q ?? "").trim().replace(/[,()*.]/g, " ").replace(/\s+/g, " ").trim();

// A part number is the high-signal match; description is the fallback, because
// the Thailand sheet (and others) leave Part Number blank and put the code
// inside the description. Searching only part_no would miss those rows
// entirely — 672 of them in one real sheet.
export const buildOrFilter = (term) => {
  const t = sanitiseTerm(term);
  if (!t) return null;
  return `part_no.ilike.%${t}%,description.ilike.%${t}%`;
};

// Which ladder hop a line has actually reached. Derived from the shipment's
// dates rather than its free-text status, so it cannot disagree with them.
export const ladderStage = (s, line) => {
  if (line?.receipt_date || s?.warehouse_receipt_date) return "received";
  if (s?.port_arrival_date) return "at_port";
  if (s?.vessel_sailing_date) return "in_transit";
  return "booked";
};

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
    const url = new URL(req.url, "http://localhost");
    const q = url.searchParams.get("q");
    const filter = buildOrFilter(q);
    if (!filter) {
      // An empty query returning "everything" would be a 34,000-row response
      // that looks like a working search until someone reads it.
      return json(res, 400, { error: { message: "q required — a part number or description fragment" } });
    }
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit")) || DEFAULT_LIMIT));
    const svc = serviceClient();

    const { data, error, count } = await svc
      .from("shipment_lines")
      .select(
        "id, part_no, description, qty, received_qty, receipt_date, remark, shipment_id,"
        + " shipments!inner(shipper_invoice_no, mode, carrier, vessel_or_flight, port_of_loading,"
        + " port_of_discharge, vessel_sailing_date, port_arrival_date, warehouse_receipt_date,"
        + " status, shipment_number)",
        { count: "exact" },
      )
      .eq("tenant_id", ctx.tenantId)
      .or(filter)
      // Most recently received first, then most recently arrived. A customer
      // asking about a part usually means the latest one.
      .order("receipt_date", { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) throw new Error("shipment_lines read: " + error.message);

    const rows = (data || []).map((r) => {
      const s = r.shipments || {};
      return {
        id: r.id,
        part_no: r.part_no,
        description: r.description,
        qty: r.qty,
        received_qty: r.received_qty,
        receipt_date: r.receipt_date,
        remark: r.remark,
        stage: ladderStage(s, r),
        shipment: {
          id: r.shipment_id,
          shipment_number: s.shipment_number || null,
          shipper_invoice_no: s.shipper_invoice_no || null,
          mode: s.mode || null,
          carrier: s.carrier || null,
          vessel_or_flight: s.vessel_or_flight || null,
          port_of_loading: s.port_of_loading || null,
          port_of_discharge: s.port_of_discharge || null,
          vessel_sailing_date: s.vessel_sailing_date || null,
          port_arrival_date: s.port_arrival_date || null,
          warehouse_receipt_date: s.warehouse_receipt_date || null,
          status: s.status || null,
        },
      };
    });

    // `total` is the true match count; `rows` is capped. Reporting both stops
    // "12 results" being read as "12 shipments carried this part".
    return json(res, 200, { q: sanitiseTerm(q), total: count ?? rows.length, truncated: (count ?? 0) > rows.length, rows });
  } catch (err) { sendError(res, err); }
}
