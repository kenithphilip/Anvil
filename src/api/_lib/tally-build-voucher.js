// Tally voucher XML composer (Phase 1 F1, second half).
//
// Before this module the /api/tally/push handler accepted a
// caller-supplied `tallyXml` body and src/v3-app/screens/tally-push.tsx
// sent the literal placeholder `<ENVELOPE/>`. Every create-path push
// therefore reached the bridge with a no-op envelope; only the
// amend path (src/api/tally/amend.js) emitted real XML.
//
// This module assembles a complete Sales voucher from:
//
//   - The order row (po_number, payload_hash, customer_id,
//     result.salesOrder.lineItems, result.salesOrder.grandTotal)
//   - The tally_companies row (seller GSTIN, state_code,
//     default_sales_ledger, default_party_group, name)
//   - The customer row (name, gstin, state_code, bill_to)
//   - The tenant's per-line tax breakdown
//     (order_line_tax_components from migration 106)
//
// GST routing follows the standard place-of-supply rule:
//
//   seller_state == buyer_state -> intrastate -> CGST + SGST
//                                              (each = gst_pct / 2)
//   seller_state != buyer_state -> interstate -> IGST (full gst_pct)
//
// If the seller or buyer state is unknown the composer falls back
// to interstate (IGST), the conservative choice; an intrastate
// misclassification leaks revenue to the wrong state. The audit
// caller can flip the order to manual-fix when this happens.

import { gstinStateCode } from "./gstin.js";
import { resolveSalesVoucherType, toTallyXmlName } from "./tally-voucher-type.js";
import { placeOfSupply, splitTax } from "./gst.js";

const escape = (s) => String(s == null ? "" : s).replace(/[&<>\"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
}[c]));

const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

// Tally XML wants dates as YYYYMMDD with no separators.
const tallyDate = (iso) => {
  if (!iso) return new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const d = String(iso).slice(0, 10).replace(/-/g, "");
  return /^\d{8}$/.test(d) ? d : new Date().toISOString().slice(0, 10).replace(/-/g, "");
};

const round2 = (n) => Math.round(n * 100) / 100;

// Derive a tenant-state code from a tally_companies row. Prefers
// the explicit state_code column; falls back to GSTIN first 2
// digits if column is unset.
export const sellerStateCode = (company) => {
  if (!company) return null;
  if (company.state_code) return String(company.state_code).padStart(2, "0").slice(0, 2);
  return gstinStateCode(company.gstin || "");
};

// Derive a buyer-state code from a customer row.
export const buyerStateCode = (customer) => {
  if (!customer) return null;
  if (customer.state_code) return String(customer.state_code).padStart(2, "0").slice(0, 2);
  return gstinStateCode(customer.gstin || "");
};

// Returns either "intrastate" or "interstate". When either side is
// unknown the conservative answer is "interstate"; misclassifying
// the other way leaks tax revenue to the wrong jurisdiction.
export const placeOfSupplyKind = (company, customer) =>
  placeOfSupply(sellerStateCode(company), buyerStateCode(customer));

// Per-line tax shape. Each line returns
//   { taxable, gst_pct, cgst, sgst, igst, cess, line_total }
// gst_pct lives on item_master.rate_of_duty_pct or on the line
// itself; we accept both.
export const computeLineTax = (line, kind) => {
  const qty = num(line.qty || line.quantity, 0);
  const rate = num(line.rate || line.unitPrice, 0);
  const taxable = round2(qty * rate);
  const gst_pct = num(line.gst_pct ?? line.gstRate ?? line.rate_of_duty_pct, 0);
  const cess_pct = num(line.cess_pct ?? line.cessRate, 0);
  const cess = round2((taxable * cess_pct) / 100);
  // Delegate the CGST/SGST vs IGST split to the shared resolver
  // (src/api/_lib/gst.js) so every tax path stays in sync. UTGST ledger
  // wiring is tracked in docs/GST_COVERAGE_ROADMAP.md.
  const { cgst, sgst, igst } = splitTax(taxable, gst_pct, kind);
  return {
    taxable,
    gst_pct,
    cess_pct,
    cgst,
    sgst,
    igst,
    cess,
    line_total: round2(taxable + cgst + sgst + igst + cess),
  };
};

const stockItemName = (line) =>
  line.tallyItemName || line.itemName || line.description || line.itemCode
  || line.partNumber || line.sku || "Item";

const lineUom = (line) => line.uom || line.unit || "Nos";

const partyLedgerName = (customer, company) =>
  customer?.tally_ledger
  || customer?.customer_name
  || customer?.name
  || (customer?.id ? "Party-" + String(customer.id).slice(0, 8) : "Party-Unnamed");

const salesLedgerName = (company, kind, gstPct) => {
  const base = company?.default_sales_ledger;
  if (base) return base;
  // Convention: "Sales Local 18%" / "Sales Interstate 18%". A real
  // Tally install almost certainly has the named ledger already;
  // this fallback exists so the emit never has an empty value.
  return (kind === "intrastate" ? "Sales Local " : "Sales Interstate ") + gstPct + "%";
};

const gstLedger = (kind, type, pct) => {
  if (kind === "intrastate" && type === "cgst") return "CGST Output " + pct + "%";
  if (kind === "intrastate" && type === "sgst") return "SGST Output " + pct + "%";
  if (kind === "interstate" && type === "igst") return "IGST Output " + pct + "%";
  if (type === "cess") return "CESS Output " + pct + "%";
  return type.toUpperCase() + " Output";
};

const stateName = (code) => {
  // Map state code to the Tally-canonical state name. The schedule
  // below mirrors STATE_CODES in gstin.js but uses full names,
  // which is what Tally expects in <STATENAME> / <PLACEOFSUPPLY>.
  const NAMES = {
    "01": "Jammu & Kashmir", "02": "Himachal Pradesh", "03": "Punjab",
    "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana",
    "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh",
    "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh",
    "13": "Nagaland", "14": "Manipur", "15": "Mizoram",
    "16": "Tripura", "17": "Meghalaya", "18": "Assam",
    "19": "West Bengal", "20": "Jharkhand", "21": "Odisha",
    "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat",
    "25": "Daman & Diu", "26": "Dadra & Nagar Haveli",
    "27": "Maharashtra", "28": "Andhra Pradesh", "29": "Karnataka",
    "30": "Goa", "31": "Lakshadweep", "32": "Kerala",
    "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman & Nicobar",
    "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
    "97": "Other Territory", "99": "Centre",
  };
  return NAMES[code] || null;
};

// Build a single inventory entry block per line.
const inventoryEntryXml = (line, kind, company) => {
  const tax = computeLineTax(line, kind);
  const name = escape(stockItemName(line));
  const uom = escape(lineUom(line));
  const rate = num(line.rate || line.unitPrice, 0);
  const qty = num(line.qty || line.quantity, 0);
  const sales = escape(salesLedgerName(company, kind, tax.gst_pct));
  return [
    "<ALLINVENTORYENTRIES.LIST>",
    "<STOCKITEMNAME>", name, "</STOCKITEMNAME>",
    "<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>",
    "<RATE>", escape(rate), "/", uom, "</RATE>",
    "<AMOUNT>", escape(tax.taxable), "</AMOUNT>",
    "<ACTUALQTY>", escape(qty), " ", uom, "</ACTUALQTY>",
    "<BILLEDQTY>", escape(qty), " ", uom, "</BILLEDQTY>",
    "<ACCOUNTINGALLOCATIONS.LIST>",
    "<LEDGERNAME>", sales, "</LEDGERNAME>",
    "<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>",
    "<AMOUNT>", escape(tax.taxable), "</AMOUNT>",
    "</ACCOUNTINGALLOCATIONS.LIST>",
    "</ALLINVENTORYENTRIES.LIST>",
  ].join("");
};

const ledgerEntryXml = (ledgerName, amount, isDeemedPositive) => [
  "<ALLLEDGERENTRIES.LIST>",
  "<LEDGERNAME>", escape(ledgerName), "</LEDGERNAME>",
  "<ISDEEMEDPOSITIVE>", isDeemedPositive ? "Yes" : "No", "</ISDEEMEDPOSITIVE>",
  "<AMOUNT>", escape(amount), "</AMOUNT>",
  "</ALLLEDGERENTRIES.LIST>",
].join("");

// Compose the full voucher envelope.
export const buildSalesVoucherXml = ({ order, company, customer, voucherNo }) => {
  if (!order) throw new Error("order required");
  if (!company) throw new Error("company required");
  const lines = (order.result?.salesOrder?.lineItems) || [];
  const kind = placeOfSupplyKind(company, customer);
  const voucherType = resolveSalesVoucherType(company);
  const vtXml = toTallyXmlName(voucherType);
  const dateStr = tallyDate(order.po_date || order.created_at || new Date().toISOString());
  const vNo = escape(voucherNo || order.po_number || ("SO-" + String(order.id || "draft").slice(0, 8)));
  const partyLedger = escape(partyLedgerName(customer, company));
  const partyGstin = escape(customer?.gstin || "");
  const buyerState = stateName(buyerStateCode(customer));

  // Sum tax across lines per ledger.
  const taxes = lines.reduce(
    (acc, line) => {
      const t = computeLineTax(line, kind);
      acc.taxable += t.taxable;
      acc.cgst += t.cgst;
      acc.sgst += t.sgst;
      acc.igst += t.igst;
      acc.cess += t.cess;
      acc.gst_pcts.add(t.gst_pct);
      return acc;
    },
    { taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, gst_pcts: new Set() },
  );
  const grandTotal = round2(taxes.taxable + taxes.cgst + taxes.sgst + taxes.igst + taxes.cess);

  // Inventory entries (one per line).
  const inventoryXml = lines.map((l) => inventoryEntryXml(l, kind, company)).join("");

  // Ledger entries:
  //   - Party DR for grand total (ISDEEMEDPOSITIVE=Yes, AMOUNT negative)
  //   - CGST + SGST CR (intrastate) OR IGST CR (interstate)
  //   - CESS CR if non-zero
  const ledgerXml = [];
  ledgerXml.push(ledgerEntryXml(partyLedger, -grandTotal, true));
  // Use the dominant gst_pct for the ledger name (real Tally
  // installs separate per-rate; we pick the first non-zero).
  const dominantPct = [...taxes.gst_pcts].find((p) => p > 0) || 0;
  if (kind === "intrastate") {
    if (taxes.cgst > 0) ledgerXml.push(ledgerEntryXml(gstLedger("intrastate", "cgst", dominantPct), taxes.cgst, false));
    if (taxes.sgst > 0) ledgerXml.push(ledgerEntryXml(gstLedger("intrastate", "sgst", dominantPct), taxes.sgst, false));
  } else {
    if (taxes.igst > 0) ledgerXml.push(ledgerEntryXml(gstLedger("interstate", "igst", dominantPct), taxes.igst, false));
  }
  if (taxes.cess > 0) ledgerXml.push(ledgerEntryXml(gstLedger(kind, "cess", dominantPct), taxes.cess, false));

  const placeOfSupply = buyerState ? "<PLACEOFSUPPLY>" + escape(buyerState) + "</PLACEOFSUPPLY>" : "";
  const stateNameTag = buyerState ? "<STATENAME>" + escape(buyerState) + "</STATENAME>" : "";
  const gstinTag = partyGstin ? "<PARTYGSTIN>" + partyGstin + "</PARTYGSTIN>" : "";
  const consigneeGstin = partyGstin ? "<CONSIGNEEGSTIN>" + partyGstin + "</CONSIGNEEGSTIN>" : "";
  const referenceTag = order.po_number ? "<REFERENCE>" + escape(order.po_number) + "</REFERENCE>" : "";
  const companyHeader = company.name
    ? "<STATICVARIABLES><SVCURRENTCOMPANY>" + escape(company.name) + "</SVCURRENTCOMPANY></STATICVARIABLES>"
    : "";

  const xml = [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<ENVELOPE>",
    "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>",
    "<BODY><IMPORTDATA>",
    "<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME>", companyHeader, "</REQUESTDESC>",
    "<REQUESTDATA><TALLYMESSAGE>",
    "<VOUCHER VCHTYPE=\"", escape(vtXml), "\" ACTION=\"Create\" OBJVIEW=\"Invoice Voucher View\">",
    "<DATE>", dateStr, "</DATE>",
    referenceTag,
    "<VOUCHERTYPENAME>", escape(vtXml), "</VOUCHERTYPENAME>",
    "<VOUCHERNUMBER>", vNo, "</VOUCHERNUMBER>",
    "<PARTYLEDGERNAME>", partyLedger, "</PARTYLEDGERNAME>",
    "<PARTYNAME>", escape(customer?.customer_name || customer?.name || ""), "</PARTYNAME>",
    "<BASICBUYERNAME>", escape(customer?.customer_name || customer?.name || ""), "</BASICBUYERNAME>",
    stateNameTag,
    placeOfSupply,
    "<COUNTRYOFRESIDENCE>India</COUNTRYOFRESIDENCE>",
    gstinTag,
    consigneeGstin,
    inventoryXml,
    ledgerXml.join(""),
    "</VOUCHER>",
    "</TALLYMESSAGE></REQUESTDATA>",
    "</IMPORTDATA></BODY>",
    "</ENVELOPE>",
  ].join("");

  return {
    xml,
    metadata: {
      voucher_type: voucherType,
      voucher_type_xml: vtXml,
      voucher_no: vNo,
      kind,
      seller_state_code: sellerStateCode(company),
      buyer_state_code: buyerStateCode(customer),
      taxes,
      grand_total: grandTotal,
      line_count: lines.length,
    },
  };
};

// Convenience: is the caller's tallyXml a placeholder envelope
// that the server should replace? Used by push.js to decide
// whether to compose internally.
export const isPlaceholderXml = (xml) => {
  if (!xml) return true;
  const s = String(xml).trim().toLowerCase();
  return s === "<envelope/>" || s === "<envelope></envelope>";
};
