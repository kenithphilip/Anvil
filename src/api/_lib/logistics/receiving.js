// Goods-receipt (GRN) math — pure, no I/O (Logistics Ops P2).
//
// Model: the ap_goods_receipts rows are the immutable ledger; a source PO
// line's received_qty is a PROJECTION = sum of that line's received_qty across
// every GRN. The receive endpoint therefore writes the GRN FIRST, then
// re-projects received_qty from the ledger. This keeps received_qty consistent
// with what the AP 3-way match reads (it also reads the ledger), and means a
// mid-write failure leaves a recomputable projection rather than a lost/inflated
// increment.
//
// GRN line keys: `line_index` is the stable relational key (used to project
// onto source_po_lines); `po_line_ref` is the PART NUMBER, which is the key the
// AP 3-way match + the invoice extractor (ap_invoice_lines.po_line_ref =
// partNumber) join on. All three sides — PO line, GRN, invoice — join on part.

// Validate inputs and build the GRN lines for ONE receipt event. Inputs are
// pre-summed per line_index so two entries for the same line don't clobber each
// other. Returns { grnLines, errors }; running totals come from projectReceipt.
export const applyReceipt = (lines, inputs) => {
  const byIdx = new Map((lines || []).map((l) => [Number(l.line_index), l]));
  const summed = new Map();   // line_index -> qty received in THIS event
  const errors = [];
  for (const inp of (inputs || [])) {
    const idx = Number(inp?.line_index);
    const qty = Number(inp?.received_qty);
    const line = byIdx.get(idx);
    if (!line) { errors.push({ line_index: inp?.line_index, error: "no such line_index" }); continue; }
    if (!Number.isFinite(qty) || qty <= 0) { errors.push({ line_index: idx, error: "received_qty must be > 0" }); continue; }
    summed.set(idx, (summed.get(idx) || 0) + qty);
  }
  const grnLines = [];
  for (const [idx, qty] of summed) {
    const line = byIdx.get(idx);
    grnLines.push({
      line_index: idx,
      po_line_ref: line.part_no,   // part number -> joins to ap_invoice_lines.po_line_ref
      part_no: line.part_no,
      received_qty: qty,
      ordered_qty: Number(line.qty) || 0,
    });
  }
  return { grnLines, errors };
};

// Sum received_qty across ALL goods receipts for a PO, keyed by line_index.
export const sumReceiptLines = (receipts) => {
  const totals = new Map();
  for (const r of (receipts || [])) {
    for (const ln of (r?.lines || [])) {
      const idx = Number(ln?.line_index);
      if (!Number.isFinite(idx)) continue;
      totals.set(idx, (totals.get(idx) || 0) + (Number(ln?.received_qty) || 0));
    }
  }
  return totals;
};

// Project source_po_lines.received_qty from the ledger. Returns the line updates
// that actually changed (so received_at only moves for touched lines), whether
// the PO is now fully received, and any over-receipts.
export const projectReceipt = (lines, receipts, nowIso) => {
  const totals = sumReceiptLines(receipts);
  const updates = [];
  const overReceived = [];
  let fullyReceived = (lines || []).length > 0;
  for (const l of (lines || [])) {
    const idx = Number(l.line_index);
    const ordered = Number(l.qty) || 0;
    const total = totals.has(idx) ? totals.get(idx) : (Number(l.received_qty) || 0);
    if (total !== (Number(l.received_qty) || 0)) {
      updates.push({ id: l.id, line_index: idx, received_qty: total, received_at: nowIso });
    }
    if (total > ordered) overReceived.push({ line_index: idx, ordered_qty: ordered, received_qty: total });
    if (total < ordered) fullyReceived = false;
  }
  return { updates, overReceived, fullyReceived };
};
