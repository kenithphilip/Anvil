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
