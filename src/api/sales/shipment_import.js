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
import { buildObservation, resolvePromise } from "../_lib/logistics/eta-history.js";

const uniq = (arr) => [...new Set(arr.filter(Boolean))];

// A line's identity: its part number when it has one, its description
// otherwise. Mirrors shipment_lines.line_key (migration 211). The country
// sheets disagree about which column carries the code — Thailand leaves Part
// Number blank and puts it in DESCRIPTION — so 763 real rows have no part
// number and must still dedupe on re-upload rather than duplicating.
const lineKey = (l) => (String(l?.part_no ?? "").trim() || String(l?.description ?? "").trim() || null);


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
    // `diag` is the per-sheet accounting parseSheets returns — rows, kept,
    // blank, unrecognised, plus a warning when a sheet classifies and yields
    // nothing. Surfaced in the response so a workbook whose headers drift is
    // visible on the first upload rather than after someone counts rows.
    const { pending, lines, diag } = preNormalized
      ? { pending: body.pending || [], lines: body.lines || [], diag: null }
      : parseSheets(body?.sheets);
    if (!pending.length && !lines.length) {
      return json(res, 400, { error: { message: "No shipment or line rows recognised in the uploaded sheets." } });
    }

    // 1. invoice -> set of P/O refs, from line rows that belong to a pending
    //    shipment (bounds the work to the shipments actually being imported).
    const pendInvoices = uniq(pending.map((p) => p.shipper_invoice_no));
    const pendInvoiceSet = new Set(pendInvoices);

    // LINE ROWS RESOLVE AGAINST SHIPMENTS ALREADY IN THE DATABASE, not only
    // those in this payload.
    //
    // Line persistence used to be gated on `pendInvoiceSet` alone, so uploading
    // the per-part workbook without its summary in the SAME request silently
    // discarded every row. That made the natural workflow — line items once,
    // summary refreshed daily — quietly lossy: the operator saw a success and
    // got nothing.
    //
    // Bounded by the invoices the lines actually mention, so this is one
    // indexed lookup rather than a table scan.
    const lineInvoices = uniq(lines.map((l) => l.shipper_invoice_no)).filter((inv) => !pendInvoiceSet.has(inv));
    const existingShipmentByInvoice = new Map();
    if (lineInvoices.length) {
      // Chunked: a workbook can mention hundreds of invoices and a single
      // `in` list is a URL, not a body.
      for (let i = 0; i < lineInvoices.length; i += 200) {
        const batch = lineInvoices.slice(i, i + 200);
        const { data, error } = await svc.from("shipments")
          .select("id, shipper_invoice_no, source_po_id")
          .eq("tenant_id", tenantId).in("shipper_invoice_no", batch);
        if (error) throw new Error("shipments lookup: " + error.message);
        for (const r of (data || [])) existingShipmentByInvoice.set(r.shipper_invoice_no, r);
      }
    }
    // A workbook's line rows exceed the 1 MB body cap, so the client sends them
    // across several requests: shipments first, then line batches. From batch two
    // onward `pending` is empty, and on a PREVIEW nothing has been written yet —
    // so a line whose shipment is still only in batch one looks like an orphan.
    // `known_invoices` is the client naming the invoices it is importing in this
    // multi-request upload, ~14 bytes each rather than the whole pending row.
    //
    // It widens COUNTING only. Writing a line still requires a real shipment_id
    // resolved from this payload's plan or from the database, so a declared
    // invoice that never materialises persists nothing.
    const declaredInvoices = new Set(uniq(body?.known_invoices || []).filter(Boolean));
    // Every invoice a line row can attach to: this payload's, plus what is
    // already on file, plus what the caller says is coming in a sibling request.
    const knownInvoices = new Set([
      ...pendInvoiceSet,
      ...existingShipmentByInvoice.keys(),
      ...declaredInvoices,
    ]);
    // Lines naming an invoice that exists NOWHERE. Reported rather than
    // dropped in silence — it means the summary for those shipments has not
    // been uploaded yet, which is a thing an operator can act on.
    const orphanInvoices = uniq(lines.map((l) => l.shipper_invoice_no)).filter((inv) => !knownInvoices.has(inv));
    const poRefsByInvoice = new Map();
    for (const l of lines) {
      if (!knownInvoices.has(l.shipper_invoice_no)) continue;
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
        // Kept for the ETA observation log below. Stripped from the preview
        // response with `body` — it is import bookkeeping, not operator-facing.
        normalized: n,
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
      if (!knownInvoices.has(l.shipper_invoice_no) || !l.receipt_date) continue;
      const spoId = spoIdByRef.get(l.po_ref);
      if (!spoId) continue;
      // A receipt can only be stamped against a source_po_line, which is keyed
      // by part number. A description-only row has nothing to match on, so it
      // is skipped here — it still lands in shipment_lines below.
      if (!l.part_no) continue;
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
      const key = lineKey(l);
      if (!knownInvoices.has(l.shipper_invoice_no) || !key) continue;
      if (!linesByInvoice.has(l.shipper_invoice_no)) linesByInvoice.set(l.shipper_invoice_no, new Map());
      // Last row for a given (invoice, part) wins — a later sheet row is the
      // fresher status. Avoids an ON CONFLICT double-touch in one upsert batch.
      linesByInvoice.get(l.shipper_invoice_no).set(key, l);
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
      // Lines that attached to a shipment already on file rather than one in
      // this upload — the whole point of decoupling the two workbooks.
      lines_matched_to_existing: existingShipmentByInvoice.size,
      // Lines naming an invoice that exists nowhere: their summary has not been
      // uploaded yet. Named so the operator can fix it, not dropped in silence.
      orphan_invoices: orphanInvoices.length,
      orphan_invoice_sample: orphanInvoices.slice(0, 10),
      // Kept without a part number — real goods identified by description only
      // (Thailand's sheet leaves Part Number blank on 672 rows).
      lines_without_part_no: lines.filter((l) => !l.part_no).length,
      by_source_country: lines.reduce((acc, l) => {
        if (!l.source_country) return acc;
        acc[l.source_country] = (acc[l.source_country] || 0) + 1;
        return acc;
      }, {}),
      sheets: diag || undefined,
    };

    if (!apply) {
      // Strip the internal `body` from the preview payload; keep the readable bits.
      const preview = plan.map(({ body: _b, normalized: _n, ...rest }) => rest);
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
    // 6b. Record the promise, when it moved (Logistics P1, migration 212).
    //
    // `shipments` has no forward-looking ETA column, so the sheet's port/store
    // ETAs were flattened into free-text remarks and every revision overwrote
    // the last. Nobody could ask which shipments were slipping or by how much.
    //
    // A row is written ONLY when a promise changes, so re-importing the same
    // workbook is free and every row is a real revision. The count and the slip
    // are derived from this log rather than stored — the workbook's own
    // "No. of Delays" is hand-maintained, and a mirrored counter is a number
    // Anvil could never verify.
    let etaObservations = 0;
    let etaDegraded = 0;
    const etaTargets = plan.filter((p) => p.shipment_id && p.normalized);
    if (etaTargets.length) {
      // Latest observation per shipment, in one read. The log only holds
      // revisions, so this stays small even for a long-running tenant.
      const latestByShipment = new Map();
      const ids = etaTargets.map((p) => p.shipment_id);
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await svc.from("shipment_eta_observations")
          .select("shipment_id, eta_port, eta_store, observed_at")
          .eq("tenant_id", tenantId)
          .in("shipment_id", ids.slice(i, i + 200))
          .order("observed_at", { ascending: true });
        if (error) { console.warn("[shipment-import] eta history read failed:", error.message); break; }
        // Ascending, so the last write per shipment wins.
        for (const r of (data || [])) latestByShipment.set(r.shipment_id, r);
      }
      const newRows = [];
      for (const p of etaTargets) {
        // resolvePromise, not a direct read: a browser on a bundle cached from
        // before this feature posts rows with no `eta_port_current` at all, and
        // reading it directly recorded nothing while reporting success.
        const next = resolvePromise(p.normalized);
        if (next.degraded) etaDegraded += 1;
        const obs = buildObservation(latestByShipment.get(p.shipment_id) || null, next, {
          tenantId, shipmentId: p.shipment_id,
          source: next.degraded ? "workbook_import_legacy" : "workbook_import",
        });
        if (obs) newRows.push(obs);
      }
      for (let i = 0; i < newRows.length; i += 200) {
        const { error } = await svc.from("shipment_eta_observations").insert(newRows.slice(i, i + 200));
        if (error) { console.warn("[shipment-import] eta history write failed:", error.message); break; }
        etaObservations += newRows.slice(i, i + 200).length;
      }
    }

    for (const r of receipts) {
      const { error } = await svc.from("source_po_lines")
        .update({ received_qty: r.received_qty, received_at: r.received_at, updated_at: new Date().toISOString() })
        .eq("tenant_id", tenantId).eq("id", r.id);
      if (!error) receiptsApplied += 1;
    }
    // Persist the inbound per-part lines.
    //
    // Targets are the shipments upserted above PLUS the ones already on file
    // that these line rows name. Walking `plan` alone was the bug: a workbook
    // uploaded without its summary matched nothing and wrote nothing, so
    // "line items once, summary daily" silently lost every line.
    const lineTargets = [
      ...plan.filter((p) => p.shipment_id),
      ...[...existingShipmentByInvoice.values()].map((r) => ({
        shipment_id: r.id, shipper_invoice_no: r.shipper_invoice_no, source_po_id: r.source_po_id || null,
      })),
    ];
    for (const p of lineTargets) {
      if (!p.shipment_id) continue;
      const byPart = linesByInvoice.get(p.shipper_invoice_no);
      if (!byPart || !byPart.size) continue;
      const rows = [...byPart.values()].map((l) => {
        const spoId = spoIdByRef.get(l.po_ref) || p.source_po_id || null;
        const spoLine = spoId && l.part_no ? spoLineByKey.get(`${spoId}::${l.part_no.trim()}`) : null;
        const qty = l.qty === "" || l.qty == null ? null : Number(l.qty);
        return {
          tenant_id: tenantId,
          shipment_id: p.shipment_id,
          source_po_id: spoId,
          source_po_line_id: spoLine ? spoLine.id : null,
          part_no: l.part_no || null,
          description: l.description || null,
          source_country: l.source_country || null,
          qty: Number.isFinite(qty) ? qty : null,
          received_qty: l.receipt_date ? (Number.isFinite(qty) ? qty : 0) : 0,
          receipt_date: l.receipt_date || null,
          remark: l.remark || null,
        };
      });
      // line_key, not part_no: the old target could not dedupe a row whose part
      // number is null, because NULL never equals NULL in a unique index — every
      // re-upload would have duplicated the 763 description-only rows.
      const { error } = await svc.from("shipment_lines").upsert(rows, { onConflict: "shipment_id,line_key" });
      if (!error) shipmentLinesApplied += rows.length;
    }

    return json(res, 200, { mode: "apply", summary: { ...summary, inserted, updated, line_receipts_applied: receiptsApplied, shipment_lines_applied: shipmentLinesApplied, eta_observations: etaObservations, eta_observations_degraded: etaDegraded } });
  } catch (err) {
    sendError(res, err);
  }
}
