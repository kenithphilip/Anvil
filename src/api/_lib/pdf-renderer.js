// Server-side PDF renderer used by the quote and invoice endpoints.
//
// We use @react-pdf/renderer instead of puppeteer because puppeteer
// pulls a full chromium binary (>200MB) that does not fit Vercel's
// serverless function size limits. react-pdf renders entirely in
// Node, returns a Buffer, and reuses the existing react dep.
//
// Layout is intentionally compact: a header with brand + tenant +
// "Quote" / "Invoice" eyebrow, a customer + address block, a
// line-items table, totals, terms + notes footer. The same
// renderQuote / renderInvoice helpers are used by:
//   - GET /api/quotes/pdf?orderId=...
//   - GET /api/invoices/[id]/pdf
//
// Both helpers take a flat data object so the caller doesn't need to
// know react-pdf primitives.

import React from "react";
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from "@react-pdf/renderer";

const styles = StyleSheet.create({
  page:        { padding: 36, fontFamily: "Helvetica", fontSize: 10, color: "#1c1917" },
  header:      { flexDirection: "row", justifyContent: "space-between", marginBottom: 16, borderBottomWidth: 1, borderBottomColor: "#d6d3d1", paddingBottom: 12 },
  brandBlock:  { flexDirection: "column" },
  brandName:   { fontSize: 20, fontWeight: 700 },
  brandLine:   { fontSize: 9, color: "#57534e", marginTop: 2 },
  docMeta:     { textAlign: "right" },
  docKind:     { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, color: "#9a3412" },
  docNumber:   { fontSize: 14, fontWeight: 700, marginTop: 2 },
  docDate:     { fontSize: 9, color: "#57534e", marginTop: 2 },
  twoCol:      { flexDirection: "row", justifyContent: "space-between", marginBottom: 16 },
  partyBox:    { width: "48%" },
  partyTitle:  { fontSize: 8, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, color: "#78716c", marginBottom: 4 },
  partyName:   { fontSize: 11, fontWeight: 700 },
  partyMono:   { fontSize: 9, color: "#57534e", marginTop: 2 },
  table:       { borderWidth: 1, borderColor: "#d6d3d1", marginBottom: 12 },
  thead:       { flexDirection: "row", backgroundColor: "#f5f5f4", borderBottomWidth: 1, borderBottomColor: "#d6d3d1" },
  th:          { padding: 6, fontSize: 9, fontWeight: 700, textTransform: "uppercase", color: "#44403c" },
  tr:          { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#e7e5e4" },
  td:          { padding: 6, fontSize: 9, color: "#1c1917" },
  colDesc:     { width: "44%" },
  colQty:      { width: "10%", textAlign: "right" },
  colUom:      { width: "10%" },
  colRate:     { width: "16%", textAlign: "right" },
  colTotal:    { width: "20%", textAlign: "right" },
  totalsBox:   { width: "40%", marginLeft: "60%", borderTopWidth: 1, borderTopColor: "#d6d3d1", paddingTop: 6 },
  totalsRow:   { flexDirection: "row", justifyContent: "space-between", marginBottom: 2 },
  totalsLbl:   { fontSize: 10, color: "#44403c" },
  totalsVal:   { fontSize: 10, fontWeight: 700 },
  grandRow:    { flexDirection: "row", justifyContent: "space-between", marginTop: 6, borderTopWidth: 1, borderTopColor: "#1c1917", paddingTop: 6 },
  grandLbl:    { fontSize: 11, fontWeight: 700 },
  grandVal:    { fontSize: 11, fontWeight: 700 },
  notes:       { marginTop: 18, fontSize: 9, color: "#57534e" },
  notesTitle:  { fontSize: 8, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, color: "#78716c", marginBottom: 4 },
  footer:      { position: "absolute", bottom: 24, left: 36, right: 36, fontSize: 8, color: "#a8a29e", textAlign: "center" },
});

const fmtMoney = (amount, currency) => {
  const n = Number(amount) || 0;
  const code = currency || "USD";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code, maximumFractionDigits: 2 }).format(n);
  } catch (_) {
    return code + " " + n.toFixed(2);
  }
};

const Header = ({ kind, number, date, brand }) => (
  React.createElement(View, { style: styles.header, fixed: true },
    React.createElement(View, { style: styles.brandBlock },
      React.createElement(Text, { style: styles.brandName }, brand?.name || "Anvil"),
      brand?.tagline && React.createElement(Text, { style: styles.brandLine }, brand.tagline),
      brand?.address && React.createElement(Text, { style: styles.brandLine }, brand.address),
    ),
    React.createElement(View, { style: styles.docMeta },
      React.createElement(Text, { style: styles.docKind }, kind),
      React.createElement(Text, { style: styles.docNumber }, "#" + (number || "—")),
      React.createElement(Text, { style: styles.docDate }, "Issued " + (date || new Date().toLocaleDateString("en-US"))),
    ),
  )
);

const Parties = ({ from, to }) => (
  React.createElement(View, { style: styles.twoCol },
    React.createElement(View, { style: styles.partyBox },
      React.createElement(Text, { style: styles.partyTitle }, "From"),
      React.createElement(Text, { style: styles.partyName }, from?.name || "—"),
      from?.line2 && React.createElement(Text, { style: styles.partyMono }, from.line2),
      from?.gstin && React.createElement(Text, { style: styles.partyMono }, "GSTIN " + from.gstin),
    ),
    React.createElement(View, { style: styles.partyBox },
      React.createElement(Text, { style: styles.partyTitle }, "Bill to"),
      React.createElement(Text, { style: styles.partyName }, to?.name || "—"),
      to?.line2 && React.createElement(Text, { style: styles.partyMono }, to.line2),
      to?.email && React.createElement(Text, { style: styles.partyMono }, to.email),
      to?.gstin && React.createElement(Text, { style: styles.partyMono }, "GSTIN " + to.gstin),
    ),
  )
);

const LineItems = ({ items, currency }) => (
  React.createElement(View, { style: styles.table },
    React.createElement(View, { style: styles.thead },
      React.createElement(Text, { style: [styles.th, styles.colDesc] }, "Description"),
      React.createElement(Text, { style: [styles.th, styles.colQty] }, "Qty"),
      React.createElement(Text, { style: [styles.th, styles.colUom] }, "UOM"),
      React.createElement(Text, { style: [styles.th, styles.colRate] }, "Rate"),
      React.createElement(Text, { style: [styles.th, styles.colTotal] }, "Total"),
    ),
    (items || []).map((it, i) => (
      React.createElement(View, { style: styles.tr, key: i },
        React.createElement(Text, { style: [styles.td, styles.colDesc] },
          (it.partNumber ? it.partNumber + " " : "") + (it.description || it.itemName || "—")
        ),
        React.createElement(Text, { style: [styles.td, styles.colQty] }, String(it.quantity || it.qty || "")),
        React.createElement(Text, { style: [styles.td, styles.colUom] }, it.uom || ""),
        React.createElement(Text, { style: [styles.td, styles.colRate] }, fmtMoney(it.rate || it.unitPrice, currency)),
        React.createElement(Text, { style: [styles.td, styles.colTotal] }, fmtMoney(it.total || (Number(it.rate || 0) * Number(it.quantity || 0)), currency)),
      )
    ))
  )
);

const Totals = ({ subtotal, tax, total, currency }) => (
  React.createElement(View, { style: styles.totalsBox },
    React.createElement(View, { style: styles.totalsRow },
      React.createElement(Text, { style: styles.totalsLbl }, "Subtotal"),
      React.createElement(Text, { style: styles.totalsVal }, fmtMoney(subtotal, currency)),
    ),
    (Number(tax) > 0) && React.createElement(View, { style: styles.totalsRow },
      React.createElement(Text, { style: styles.totalsLbl }, "Tax"),
      React.createElement(Text, { style: styles.totalsVal }, fmtMoney(tax, currency)),
    ),
    React.createElement(View, { style: styles.grandRow },
      React.createElement(Text, { style: styles.grandLbl }, "Total"),
      React.createElement(Text, { style: styles.grandVal }, fmtMoney(total, currency)),
    ),
  )
);

const QuoteDoc = ({ kind, number, date, brand, from, to, items, subtotal, tax, total, currency, notes }) => (
  React.createElement(Document, null,
    React.createElement(Page, { size: "A4", style: styles.page },
      React.createElement(Header, { kind, number, date, brand }),
      React.createElement(Parties, { from, to }),
      React.createElement(LineItems, { items, currency }),
      React.createElement(Totals, { subtotal, tax, total, currency }),
      notes && React.createElement(View, { style: styles.notes },
        React.createElement(Text, { style: styles.notesTitle }, "Notes"),
        React.createElement(Text, null, notes),
      ),
      React.createElement(Text, {
        style: styles.footer,
        render: ({ pageNumber, totalPages }) => "Page " + pageNumber + " of " + totalPages,
        fixed: true,
      }),
    )
  )
);

// Public surface: { kind: "Quote" | "Invoice", number, date, brand,
// from, to, items, subtotal, tax, total, currency, notes } -> Buffer.
export const renderPdf = async (data) => {
  const doc = QuoteDoc(data);
  return await renderToBuffer(doc);
};

// Convenience for the quote endpoint.
export const renderQuote = async (data) => renderPdf({ ...data, kind: "Quote" });

// Convenience for the invoice endpoint.
export const renderInvoice = async (data) => renderPdf({ ...data, kind: "Invoice" });

// ───────────────────────────────────────────────────────────────────
// Sales-voucher (ERP / Tally style) document.
//
// Distinct from the quote PDF: this is the post-approval sales-order
// voucher with an HSN column, an explicit CGST/SGST vs IGST split
// driven by place of supply, seller + party GSTIN/state blocks, and a
// tax-summary footer. Mirrors the Tally sales voucher the XML push
// builds (src/api/_lib/tally-build-voucher.js) so the printed document
// matches what lands in the ERP.
const vstyles = StyleSheet.create({
  metaStrip:   { flexDirection: "row", justifyContent: "space-between", backgroundColor: "#f5f5f4", borderWidth: 1, borderColor: "#d6d3d1", padding: 6, marginBottom: 12 },
  metaCell:    { flexDirection: "column" },
  metaLbl:     { fontSize: 7, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, color: "#78716c" },
  metaVal:     { fontSize: 9, color: "#1c1917", marginTop: 1 },
  colHsn:      { width: "12%" },
  vColDesc:    { width: "34%" },
  vColQty:     { width: "9%", textAlign: "right" },
  vColUom:     { width: "9%" },
  vColRate:    { width: "14%", textAlign: "right" },
  vColTax:     { width: "10%", textAlign: "right" },
  vColAmt:     { width: "12%", textAlign: "right" },
});

const VoucherMeta = ({ voucherType, poRef, placeOfSupply }) => (
  React.createElement(View, { style: vstyles.metaStrip },
    React.createElement(View, { style: vstyles.metaCell },
      React.createElement(Text, { style: vstyles.metaLbl }, "Voucher type"),
      React.createElement(Text, { style: vstyles.metaVal }, voucherType || "Sales"),
    ),
    React.createElement(View, { style: vstyles.metaCell },
      React.createElement(Text, { style: vstyles.metaLbl }, "Buyer ref / PO"),
      React.createElement(Text, { style: vstyles.metaVal }, poRef || "—"),
    ),
    React.createElement(View, { style: vstyles.metaCell },
      React.createElement(Text, { style: vstyles.metaLbl }, "Place of supply"),
      React.createElement(Text, { style: vstyles.metaVal }, placeOfSupply || "—"),
    ),
  )
);

const VoucherParties = ({ from, to }) => (
  React.createElement(View, { style: styles.twoCol },
    React.createElement(View, { style: styles.partyBox },
      React.createElement(Text, { style: styles.partyTitle }, "Seller"),
      React.createElement(Text, { style: styles.partyName }, from?.name || "—"),
      from?.line2 && React.createElement(Text, { style: styles.partyMono }, from.line2),
      from?.gstin && React.createElement(Text, { style: styles.partyMono }, "GSTIN " + from.gstin),
      from?.state && React.createElement(Text, { style: styles.partyMono }, "State " + from.state),
    ),
    React.createElement(View, { style: styles.partyBox },
      React.createElement(Text, { style: styles.partyTitle }, "Party (buyer)"),
      React.createElement(Text, { style: styles.partyName }, to?.name || "—"),
      to?.line2 && React.createElement(Text, { style: styles.partyMono }, to.line2),
      to?.gstin && React.createElement(Text, { style: styles.partyMono }, "GSTIN " + to.gstin),
      to?.state && React.createElement(Text, { style: styles.partyMono }, "State " + to.state),
    ),
  )
);

const VoucherLines = ({ items, currency }) => (
  React.createElement(View, { style: styles.table },
    React.createElement(View, { style: styles.thead },
      React.createElement(Text, { style: [styles.th, vstyles.vColDesc] }, "Description"),
      React.createElement(Text, { style: [styles.th, vstyles.colHsn] }, "HSN/SAC"),
      React.createElement(Text, { style: [styles.th, vstyles.vColQty] }, "Qty"),
      React.createElement(Text, { style: [styles.th, vstyles.vColUom] }, "UOM"),
      React.createElement(Text, { style: [styles.th, vstyles.vColRate] }, "Rate"),
      React.createElement(Text, { style: [styles.th, vstyles.vColTax] }, "GST%"),
      React.createElement(Text, { style: [styles.th, vstyles.vColAmt] }, "Taxable"),
    ),
    (items || []).map((it, i) => (
      React.createElement(View, { style: styles.tr, key: i },
        React.createElement(Text, { style: [styles.td, vstyles.vColDesc] },
          (it.partNumber ? it.partNumber + " " : "") + (it.description || it.itemName || "—")),
        React.createElement(Text, { style: [styles.td, vstyles.colHsn] }, it.hsn || ""),
        React.createElement(Text, { style: [styles.td, vstyles.vColQty] }, String(it.quantity ?? it.qty ?? "")),
        React.createElement(Text, { style: [styles.td, vstyles.vColUom] }, it.uom || ""),
        React.createElement(Text, { style: [styles.td, vstyles.vColRate] }, fmtMoney(it.rate ?? it.unitPrice, currency)),
        React.createElement(Text, { style: [styles.td, vstyles.vColTax] }, (it.gstPct != null ? it.gstPct + "%" : "")),
        React.createElement(Text, { style: [styles.td, vstyles.vColAmt] }, fmtMoney(it.taxable ?? it.amount, currency)),
      )
    ))
  )
);

const VoucherTotals = ({ taxable, cgst, sgst, igst, total, currency }) => (
  React.createElement(View, { style: styles.totalsBox },
    React.createElement(View, { style: styles.totalsRow },
      React.createElement(Text, { style: styles.totalsLbl }, "Taxable value"),
      React.createElement(Text, { style: styles.totalsVal }, fmtMoney(taxable, currency)),
    ),
    (Number(cgst) > 0) && React.createElement(View, { style: styles.totalsRow },
      React.createElement(Text, { style: styles.totalsLbl }, "CGST"),
      React.createElement(Text, { style: styles.totalsVal }, fmtMoney(cgst, currency)),
    ),
    (Number(sgst) > 0) && React.createElement(View, { style: styles.totalsRow },
      React.createElement(Text, { style: styles.totalsLbl }, "SGST"),
      React.createElement(Text, { style: styles.totalsVal }, fmtMoney(sgst, currency)),
    ),
    (Number(igst) > 0) && React.createElement(View, { style: styles.totalsRow },
      React.createElement(Text, { style: styles.totalsLbl }, "IGST"),
      React.createElement(Text, { style: styles.totalsVal }, fmtMoney(igst, currency)),
    ),
    React.createElement(View, { style: styles.grandRow },
      React.createElement(Text, { style: styles.grandLbl }, "Voucher total"),
      React.createElement(Text, { style: styles.grandVal }, fmtMoney(total, currency)),
    ),
  )
);

const VoucherDoc = ({
  number, date, brand, from, to, voucherType, poRef, placeOfSupply,
  items, taxable, cgst, sgst, igst, total, currency, totalInWords, notes,
}) => (
  React.createElement(Document, null,
    React.createElement(Page, { size: "A4", style: styles.page },
      React.createElement(Header, { kind: "Sales Voucher", number, date, brand }),
      React.createElement(VoucherParties, { from, to }),
      React.createElement(VoucherMeta, { voucherType, poRef, placeOfSupply }),
      React.createElement(VoucherLines, { items, currency }),
      React.createElement(VoucherTotals, { taxable, cgst, sgst, igst, total, currency }),
      totalInWords && React.createElement(View, { style: styles.notes },
        React.createElement(Text, { style: styles.notesTitle }, "Amount in words"),
        React.createElement(Text, null, totalInWords),
      ),
      notes && React.createElement(View, { style: styles.notes },
        React.createElement(Text, { style: styles.notesTitle }, "Notes"),
        React.createElement(Text, null, notes),
      ),
      React.createElement(Text, {
        style: styles.footer,
        render: ({ pageNumber, totalPages }) => "Page " + pageNumber + " of " + totalPages,
        fixed: true,
      }),
    )
  )
);

// Public: render an ERP-format sales voucher. Data contract:
//   { number, date, brand, from:{name,line2,gstin,state},
//     to:{name,line2,gstin,state}, voucherType, poRef, placeOfSupply,
//     items:[{partNumber,description,hsn,quantity,uom,rate,gstPct,taxable}],
//     taxable, cgst, sgst, igst, total, currency, totalInWords, notes }
export const renderVoucher = async (data) => await renderToBuffer(VoucherDoc(data));

// ───────────────────────────────────────────────────────────────────
// Sales ORDER voucher (Tally "SALES ORDER" acknowledgment layout).
//
// Distinct from the post-tax Sales Voucher above: this reproduces the
// Tally Sales Order the seller sends back on receiving a customer PO —
// seller box with PAN/CIN/State, a right-hand voucher-details box,
// separate Consignee(Ship-to) + Buyer(Bill-to) blocks, and an 11-column
// line table (Sl No, Description, HSN, Cust Part No, Part No, Due on,
// Qty, Rate, per, Disc.%, Amount) with a "Batch : <PO#>" sub-row per
// line. Body is EX-TAX (Amount = Qty x Rate); tax lives in the quote.
const so = StyleSheet.create({
  page:       { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 34, fontFamily: "Helvetica", fontSize: 7.2, color: "#111" },
  title:      { fontSize: 12, fontWeight: 700, textAlign: "center", marginBottom: 6 },
  frame:      { borderWidth: 0.7, borderColor: "#000" },
  topRow:     { flexDirection: "row" },
  sellerCell: { width: "58%", borderRightWidth: 0.7, borderRightColor: "#000", padding: 5 },
  metaCell:   { width: "42%" },
  metaKV:     { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#000" },
  metaK:      { width: "45%", padding: 3, borderRightWidth: 0.5, borderRightColor: "#000", color: "#333" },
  metaV:      { width: "55%", padding: 3, fontWeight: 700 },
  partyRow:   { flexDirection: "row", borderTopWidth: 0.7, borderTopColor: "#000" },
  partyCell:  { width: "50%", padding: 5 },
  partyDivR:  { borderRightWidth: 0.7, borderRightColor: "#000" },
  ptitle:     { fontSize: 6.5, color: "#555", marginBottom: 2 },
  pname:      { fontSize: 8.5, fontWeight: 700 },
  pline:      { fontSize: 7, color: "#222", marginTop: 1 },
  sellerName: { fontSize: 9.5, fontWeight: 700 },
  msg:        { borderTopWidth: 0.7, borderTopColor: "#000", padding: 4, fontSize: 6.6, color: "#333" },
  thead:      { flexDirection: "row", borderTopWidth: 0.7, borderTopColor: "#000", borderBottomWidth: 0.7, borderBottomColor: "#000", backgroundColor: "#eee" },
  th:         { padding: 2.5, fontSize: 6.4, fontWeight: 700 },
  row:        { flexDirection: "row" },
  td:         { paddingHorizontal: 2.5, paddingTop: 2.5, fontSize: 6.8 },
  batchRow:   { flexDirection: "row" },
  batchTd:    { paddingHorizontal: 2.5, paddingBottom: 2.5, fontSize: 6.4, color: "#333" },
  cSl:   { width: "4%" },
  cDesc: { width: "17%" },
  cHsn:  { width: "9%" },
  cCust: { width: "15%" },
  cPart: { width: "14%" },
  cDue:  { width: "9%" },
  cQty:  { width: "8%", textAlign: "right" },
  cRate: { width: "9%", textAlign: "right" },
  cPer:  { width: "4%" },
  cDisc: { width: "4%", textAlign: "right" },
  cAmt:  { width: "13%", textAlign: "right" },
  soFooter: { position: "absolute", bottom: 16, left: 20, right: 20, fontSize: 7, color: "#333", textAlign: "center" },
});

const grp = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const SOKV = (k, v) => React.createElement(View, { style: so.metaKV },
  React.createElement(Text, { style: so.metaK }, k),
  React.createElement(Text, { style: so.metaV }, v || ""),
);

const SOParty = (title, p, extraStyle) => React.createElement(View, { style: extraStyle ? [so.partyCell, extraStyle] : so.partyCell },
  React.createElement(Text, { style: so.ptitle }, title),
  React.createElement(Text, { style: so.pname }, (p && p.name) || "—"),
  ...(((p && p.addressLines) || []).map((l, i) => React.createElement(Text, { style: so.pline, key: i }, l))),
  (p && p.gstin) && React.createElement(Text, { style: so.pline }, "GSTIN/UIN : " + p.gstin),
  (p && (p.stateName || p.stateCode)) && React.createElement(Text, { style: so.pline }, "State Name : " + (p.stateName || "") + (p.stateCode ? ", Code : " + p.stateCode : "")),
);

const SOHeaderBlock = (d) => React.createElement(View, { style: so.frame, fixed: true },
  // Seller + right meta box
  React.createElement(View, { style: so.topRow },
    React.createElement(View, { style: so.sellerCell },
      React.createElement(Text, { style: so.sellerName }, (d.seller && d.seller.name) || "—"),
      ...(((d.seller && d.seller.addressLines) || []).map((l, i) => React.createElement(Text, { style: so.pline, key: i }, l))),
      (d.seller && d.seller.gstin) && React.createElement(Text, { style: so.pline }, "GSTIN/UIN: " + d.seller.gstin),
      (d.seller && (d.seller.stateName || d.seller.stateCode)) && React.createElement(Text, { style: so.pline }, "State Name : " + (d.seller.stateName || "") + (d.seller.stateCode ? ", Code : " + d.seller.stateCode : "")),
      (d.seller && d.seller.cin) && React.createElement(Text, { style: so.pline }, "CIN: " + d.seller.cin),
      (d.seller && d.seller.email) && React.createElement(Text, { style: so.pline }, "E-Mail : " + d.seller.email),
      (d.seller && d.seller.pan) && React.createElement(Text, { style: so.pline }, "Company's PAN : " + d.seller.pan),
    ),
    React.createElement(View, { style: so.metaCell },
      SOKV("Voucher No.", d.voucherNo),
      SOKV("Dated", d.dated),
      SOKV("Mode/Terms of Payment", d.modeOfPayment),
      SOKV("Buyer's Ref./Order No.", d.buyerRef),
      SOKV("Reg. Serial No.", d.regSerialNo),
      SOKV("Dispatched through", d.dispatchedThrough),
      SOKV("Destination", d.destination),
      SOKV("Terms of Delivery", d.termsOfDelivery),
      SOKV("Contact Person", d.contactPerson),
      SOKV("Contact Phone", d.contactPhone),
    ),
  ),
  // Consignee + Buyer
  React.createElement(View, { style: so.partyRow },
    SOParty("Consignee (Ship to)", d.consignee, so.partyDivR),
    SOParty("Buyer (Bill to)", d.buyer),
  ),
  d.message && React.createElement(View, { style: so.msg }, React.createElement(Text, null, d.message)),
  // Column header
  React.createElement(View, { style: so.thead },
    React.createElement(Text, { style: [so.th, so.cSl] }, "Sl"),
    React.createElement(Text, { style: [so.th, so.cDesc] }, "Description of Goods"),
    React.createElement(Text, { style: [so.th, so.cHsn] }, "HSN/SAC"),
    React.createElement(Text, { style: [so.th, so.cCust] }, "Cust Part No."),
    React.createElement(Text, { style: [so.th, so.cPart] }, "Part No."),
    React.createElement(Text, { style: [so.th, so.cDue] }, "Due on"),
    React.createElement(Text, { style: [so.th, so.cQty] }, "Quantity"),
    React.createElement(Text, { style: [so.th, so.cRate] }, "Rate"),
    React.createElement(Text, { style: [so.th, so.cPer] }, "per"),
    React.createElement(Text, { style: [so.th, so.cDisc] }, "Disc.%"),
    React.createElement(Text, { style: [so.th, so.cAmt] }, "Amount"),
  ),
);

const SOLine = (it, i) => React.createElement(View, { key: i, wrap: false },
  React.createElement(View, { style: so.row },
    React.createElement(Text, { style: [so.td, so.cSl] }, String(it.sl != null ? it.sl : i + 1)),
    React.createElement(Text, { style: [so.td, so.cDesc] }, it.description || "—"),
    React.createElement(Text, { style: [so.td, so.cHsn] }, it.hsn || ""),
    React.createElement(Text, { style: [so.td, so.cCust] }, it.custPartNo || ""),
    React.createElement(Text, { style: [so.td, so.cPart] }, it.partNo || ""),
    React.createElement(Text, { style: [so.td, so.cDue] }, it.dueOn || ""),
    React.createElement(Text, { style: [so.td, so.cQty] }, (it.qty != null ? String(it.qty) : "") + (it.uom ? " " + it.uom : "")),
    React.createElement(Text, { style: [so.td, so.cRate] }, grp(it.rate)),
    React.createElement(Text, { style: [so.td, so.cPer] }, it.uom || ""),
    React.createElement(Text, { style: [so.td, so.cDisc] }, it.disc != null && it.disc !== "" ? String(it.disc) : ""),
    React.createElement(Text, { style: [so.td, so.cAmt] }, grp(it.amount != null ? it.amount : (Number(it.qty) || 0) * (Number(it.rate) || 0))),
  ),
  it.batch && React.createElement(View, { style: so.batchRow },
    React.createElement(Text, { style: [so.batchTd, so.cSl] }, ""),
    React.createElement(Text, { style: [so.batchTd, so.cDesc] }, "Batch : " + it.batch),
  ),
);

const SalesOrderDoc = (d) => React.createElement(Document, null,
  React.createElement(Page, { size: "A4", style: so.page },
    React.createElement(Text, {
      style: so.title, fixed: true,
      render: ({ pageNumber }) => pageNumber > 1 ? "SALES ORDER (Page " + pageNumber + ")" : "SALES ORDER",
    }),
    SOHeaderBlock(d),
    React.createElement(View, { style: so.frame }, (d.items || []).map((it, i) => SOLine(it, i))),
    React.createElement(Text, { style: so.soFooter, fixed: true }, "This is a Computer Generated Document"),
  ),
);

// Public: render a Tally-style Sales Order. Data contract:
//   { voucherNo, dated, modeOfPayment, buyerRef, regSerialNo,
//     dispatchedThrough, destination, termsOfDelivery, contactPerson,
//     contactPhone, message, currency,
//     seller:{name,addressLines[],gstin,stateName,stateCode,cin,email,pan},
//     consignee:{name,addressLines[],gstin,stateName,stateCode},
//     buyer:{...same as consignee...},
//     items:[{sl,description,hsn,custPartNo,partNo,dueOn,qty,uom,rate,disc,amount,batch}] }
export const renderSalesOrder = async (data) => await renderToBuffer(SalesOrderDoc(data));
