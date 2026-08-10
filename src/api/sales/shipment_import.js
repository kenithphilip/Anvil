// /api/sales/shipment_import
//   POST { sheets: [{ name, rows }], mode: "preview" | "apply" }
//
// Ingests the logistics team's shipment workbooks so nobody re-keys them. The
// frontend parses each .xlsx client-side (SheetJS) and posts the sheets as 2D
// `rows` arrays; this handler normalizes them (src/api/_lib/shipment-import.js),
// resolves each shipment to its project, and upserts.
//
// The project link is the clever bit: the header (Pending) sheet only carries a
// supplier invoice, but the per-part (line) sheets carry BOTH the invoice AND
// the source-PO reference (P/O). So we build an invoice -> P/O bridge from the
// line rows, match those P/O refs to source_pos.reference, and thereby link the
// shipment to its order (and thus opportunity/owner) — no manual linking.
//
// preview  -> read-only; returns exactly what apply would do + match stats.
// apply    -> upserts shipments (by shipper_invoice_no) and marks matching
//             source_po_lines received. Never nulls existing values on update.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { parseSheets, pendingToShipment } from "../_lib/shipment-import.js";

const uniq = (arr) => [...new Set(arr.filter(Boolean))];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return json(res, 405, { error: { message: "Method not allowed" } });
    }
    const ctx = await resolveContext(req);
    const body = await readBody(req);
    const apply = body?.mode === "apply";
    requirePermission(ctx, apply ? "write" : "read");
    const svc = serviceClient();
    const tenantId = ctx.tenantId;

    // The frontend parses the workbook client-side (it already bundles SheetJS)
    // and normally posts pre-normalized { pending, lines } — the line sheets run
    // to tens of thousands of historical rows, so it also pre-filters them to the
    // invoices actually being imported before sending. Falls back to parsing raw
    // { sheets } here (used by tests / smaller uploads).
    const preNormalized = Array.isArray(body?.pending) || Array.isArray(body?.lines);
    const { pending, lines } = preNormalized
      ? { pending: body.pending || [], lines: body.lines || [] }
      : parseSheets(body?.sheets);
    if (!pending.length && !lines.length) {
      return json(res, 400, { error: { message: "No shipment or line rows recognised in the uploaded sheets." } });
    }

    // 1. invoice -> set of P/O refs, from line rows that belong to a pending
    //    shipment (bounds the work to the shipments actually being imported).
    const pendInvoices = uniq(pending.map((p) => p.shipper_invoice_no));
    const pendInvoiceSet = new Set(pendInvoices);
    const poRefsByInvoice = new Map();
    for (const l of lines) {
      if (!pendInvoiceSet.has(l.shipper_invoice_no)) continue;
      if (!poRefsByInvoice.has(l.shipper_invoice_no)) poRefsByInvoice.set(l.shipper_invoice_no, new Set());
      poRefsByInvoice.get(l.shipper_invoice_no).add(l.po_ref);
    }

    // 2. Match those P/O refs to source_pos -> { source_po_id, order_id }.
    const allPoRefs = uniq([...poRefsByInvoice.values()].flatMap((s) => [...s]));
    const spoByRef = new Map();
    if (allPoRefs.length) {
      const { data: spos } = await svc.from("source_pos")
        .select("id, order_id, reference").eq("tenant_id", tenantId).in("reference", allPoRefs);
      for (const s of (spos || [])) spoByRef.set(s.reference, s);
    }

    // 3. Existing shipments by invoice -> update vs insert.
    const existingByInvoice = new Map();
    if (pendInvoices.length) {
      const { data: existing } = await svc.from("shipments")
        .select("id, shipper_invoice_no").eq("tenant_id", tenantId).in("shipper_invoice_no", pendInvoices);
      for (const s of (existing || [])) existingByInvoice.set(s.shipper_invoice_no, s);
    }

    // 4. Build the per-shipment plan.
    const resolveLink = (invoice) => {
      const refs = poRefsByInvoice.get(invoice);
      if (!refs) return {};
      for (const ref of refs) {
        const spo = spoByRef.get(ref);
        if (spo) return { source_po_id: spo.id, order_id: spo.order_id, matched_po_ref: ref };
      }
      return {};
    };

    const plan = pending.map((n) => {
      const link = resolveLink(n.shipper_invoice_no);
      const body2 = pendingToShipment(n, link);
      const existing = existingByInvoice.get(n.shipper_invoice_no);
      return {
        shipper_invoice_no: n.shipper_invoice_no,
        action: existing ? "update" : "insert",
        existing_id: existing?.id || null,
        linked: !!link.source_po_id,
        matched_po_ref: link.matched_po_ref || null,
        order_id: link.order_id || null,
        source_po_id: link.source_po_id || null,
        body: body2,
        preview: {
          supplier: n.supplier, items: n.items_text, mode: n.mode,
          vessel_or_flight: n.vessel_or_flight, bl_awb: n.bl_awb,
          ready_date: body2.ready_date, vessel_sailing_date: body2.vessel_sailing_date,
          port_arrival_date: body2.port_arrival_date, warehouse_receipt_date: body2.warehouse_receipt_date,
          eta_india: n.eta_india, eta_store: n.eta_store, status: body2.status,
        },
      };
    });

    // 5. Line receipts to mark received (matched source_po_id + part_no, with a
    //    receipt date). Only over pending invoices' matched POs.
    const spoIds = uniq(plan.map((p) => p.source_po_id));
    const spoLineByKey = new Map(); // `${source_po_id}::${part_no}` -> line
    if (spoIds.length) {
      const { data: spoLines } = await svc.from("source_po_lines")
        .select("id, source_po_id, part_no, qty, received_qty").eq("tenant_id", tenantId).in("source_po_id", spoIds);
      for (const l of (spoLines || [])) spoLineByKey.set(`${l.source_po_id}::${(l.part_no || "").trim()}`, l);
    }
    const spoIdByRef = new Map([...spoByRef.entries()].map(([ref, s]) => [ref, s.id]));
    const receipts = [];
    for (const l of lines) {
      if (!pendInvoiceSet.has(l.shipper_invoice_no) || !l.receipt_date) continue;
      const spoId = spoIdByRef.get(l.po_ref);
      if (!spoId) continue;
      const line = spoLineByKey.get(`${spoId}::${l.part_no.trim()}`);
      if (!line) continue;
      receipts.push({ id: line.id, received_qty: Number(l.qty) || Number(line.qty) || 0, received_at: l.receipt_date });
    }

    // 5b. Inbound shipment lines — which parts each shipment carried. The
    //     workbook's per-part rows are otherwise discarded after receipts are
    //     stamped; persisting them (mig 209) lets the Pending-SO tracker pin the
    //     ladder to a specific SO line even when a source PO splits across
    //     several shipments. Grouped by pending invoice, deduped by part_no.
    const linesByInvoice = new Map();
    for (const l of lines) {
      if (!pendInvoiceSet.has(l.shipper_invoice_no) || !l.part_no) continue;
      if (!linesByInvoice.has(l.shipper_invoice_no)) linesByInvoice.set(l.shipper_invoice_no, new Map());
      // Last row for a given (invoice, part) wins — a later sheet row is the
      // fresher status. Avoids an ON CONFLICT double-touch in one upsert batch.
      linesByInvoice.get(l.shipper_invoice_no).set(l.part_no.trim(), l);
    }
    const shipmentLinesMatched = [...linesByInvoice.values()].reduce((n, m) => n + m.size, 0);

    const summary = {
      pending_rows: pending.length,
      line_rows: lines.length,
      to_insert: plan.filter((p) => p.action === "insert").length,
      to_update: plan.filter((p) => p.action === "update").length,
      linked_to_project: plan.filter((p) => p.linked).length,
      unlinked: plan.filter((p) => !p.linked).length,
      line_receipts_matched: receipts.length,
      shipment_lines_matched: shipmentLinesMatched,
    };

    if (!apply) {
      // Strip the internal `body` from the preview payload; keep the readable bits.
      const preview = plan.map(({ body: _b, ...rest }) => rest);
      return json(res, 200, { mode: "preview", summary, shipments: preview });
    }

    // 6. Apply. Insert new, patch existing (only fields the sheet provided, so an
    //    update never nulls a value the operator set by hand).
    let inserted = 0, updated = 0, receiptsApplied = 0, shipmentLinesApplied = 0;
    for (const p of plan) {
      if (p.action === "insert") {
        const row = { tenant_id: tenantId, ...p.body };
        const { data, error } = await svc.from("shipments").insert(row).select("id").single();
        if (!error && data) {
          inserted += 1;
          p.shipment_id = data.id;
          await recordAudit(ctx, { action: "shipment_import_insert", objectType: "shipment", objectId: data.id, after: row });
        }
      } else if (p.existing_id) {
        const patch = { updated_at: new Date().toISOString() };
        for (const [k, v] of Object.entries(p.body)) if (v !== null && v !== undefined) patch[k] = v;
        const { error } = await svc.from("shipments").update(patch)
          .eq("tenant_id", tenantId).eq("id", p.existing_id);
        if (!error) {
          updated += 1;
          p.shipment_id = p.existing_id;
          await recordAudit(ctx, { action: "shipment_import_update", objectType: "shipment", objectId: p.existing_id, after: patch });
        }
      }
    }
    for (const r of receipts) {
      const { error } = await svc.from("source_po_lines")
        .update({ received_qty: r.received_qty, received_at: r.received_at, updated_at: new Date().toISOString() })
        .eq("tenant_id", tenantId).eq("id", r.id);
      if (!error) receiptsApplied += 1;
    }
    // Persist the inbound per-part lines for each shipment we just upserted.
    for (const p of plan) {
      if (!p.shipment_id) continue;
      const byPart = linesByInvoice.get(p.shipper_invoice_no);
      if (!byPart || !byPart.size) continue;
      const rows = [...byPart.values()].map((l) => {
        const spoId = spoIdByRef.get(l.po_ref) || p.source_po_id || null;
        const spoLine = spoId ? spoLineByKey.get(`${spoId}::${l.part_no.trim()}`) : null;
        const qty = l.qty === "" || l.qty == null ? null : Number(l.qty);
        return {
          tenant_id: tenantId,
          shipment_id: p.shipment_id,
          source_po_id: spoId,
          source_po_line_id: spoLine ? spoLine.id : null,
          part_no: l.part_no,
          description: l.description || null,
          qty: Number.isFinite(qty) ? qty : null,
          received_qty: l.receipt_date ? (Number.isFinite(qty) ? qty : 0) : 0,
          receipt_date: l.receipt_date || null,
          remark: l.remark || null,
        };
      });
      const { error } = await svc.from("shipment_lines").upsert(rows, { onConflict: "shipment_id,part_no" });
      if (!error) shipmentLinesApplied += rows.length;
    }

    return json(res, 200, { mode: "apply", summary: { ...summary, inserted, updated, line_receipts_applied: receiptsApplied, shipment_lines_applied: shipmentLinesApplied } });
  } catch (err) {
    sendError(res, err);
  }
}
