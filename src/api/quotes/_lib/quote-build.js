// Shared quote-building helpers.
//
// Extracted from quotes/index.js (computeTotals, generateQuoteNumber) and
// admin/quote_lines.js (buildQuoteLineRow) so other producers of quotes —
// e.g. the spare-matrix "Feed to quote" flow — can reuse the EXACT same
// number format, totals math, and quote_lines row shape instead of
// re-implementing (and drifting from) them.
//
// Behaviour here is intentionally identical to the originals; this is a
// pure move covered by the existing quotes / quote_lines tests.

// Sum line items into { subtotal, tax_total, grand_total }.
// Accepts either the camelCase JSONB shape (unitPrice/gstRate) or the
// snake_case shape (rate/gst_rate); qty may be `quantity` or `qty`.
export const computeTotals = (lineItems) => {
  const items = Array.isArray(lineItems) ? lineItems : [];
  let subtotal = 0;
  let taxTotal = 0;
  for (const li of items) {
    const qty = Number(li.quantity || li.qty || 0);
    const rate = Number(li.unitPrice || li.rate || 0);
    const lineSubtotal = qty * rate;
    subtotal += lineSubtotal;
    const gstRate = Number(li.gstRate || li.gst_rate || 0);
    if (gstRate > 0 && Number.isFinite(gstRate)) {
      taxTotal += lineSubtotal * gstRate / 100;
    }
  }
  const grandTotal = subtotal + taxTotal;
  return {
    subtotal: Math.round(subtotal * 100) / 100,
    tax_total: Math.round(taxTotal * 100) / 100,
    grand_total: Math.round(grandTotal * 100) / 100,
  };
};

// Per-tenant quote number: Q-YYYYMM-NNNN (NNNN = count-this-month + 1).
export const generateQuoteNumber = async (svc, tenantId) => {
  const stamp = new Date().toISOString().slice(0, 7).replace("-", ""); // YYYYMM
  const r = await svc.from("quotes").select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .like("quote_number", "Q-" + stamp + "-%");
  const next = String((r.count || 0) + 1).padStart(4, "0");
  return "Q-" + stamp + "-" + next;
};

const NUMERIC_KEYS = [
  "qty", "listed_unit_price", "discount_pct", "discounted_unit_price",
  "line_amount", "cgst_pct", "sgst_pct", "igst_pct", "utgst_pct", "cess_pct",
];

// Build a first-class quote_lines row (migration 108) from a raw input.
// Auto-computes discounted_unit_price + line_amount from
// (listed_unit_price, discount_pct, qty) when those are supplied without
// explicit overrides, so the renderer never has to recompute.
export const buildQuoteLineRow = (tenantId, quoteId, raw) => {
  const row = {
    tenant_id: tenantId,
    quote_id: quoteId,
    line_index: Number(raw.line_index),
    part_no: raw.part_no || null,
    description: raw.description || null,
    uom: raw.uom || null,
    hsn_sac: raw.hsn_sac || null,
    customer_part_number: raw.customer_part_number || null,
    source_country: raw.source_country || null,
    supplier_id: raw.supplier_id || null,
    remark: raw.remark || null,
  };
  for (const k of NUMERIC_KEYS) {
    if (k in raw) row[k] = raw[k] == null || raw[k] === "" ? null : Number(raw[k]);
  }
  if (row.listed_unit_price != null && row.discount_pct != null && row.discounted_unit_price == null) {
    row.discounted_unit_price = Number((row.listed_unit_price * (1 - Number(row.discount_pct))).toFixed(4));
  }
  if (row.qty != null && row.line_amount == null) {
    const ppu = row.discounted_unit_price != null
      ? row.discounted_unit_price
      : row.listed_unit_price;
    if (ppu != null) row.line_amount = Number((row.qty * ppu).toFixed(4));
  }
  return row;
};
