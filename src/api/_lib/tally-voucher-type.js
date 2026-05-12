// Map the canonical voucher_type enum (stored on
// tally_companies.default_sales_voucher_type and
// tally_voucher_records.voucher_type) to the literal voucher-type
// string Tally expects in <VOUCHER VCHTYPE="..."> and
// <VOUCHERTYPENAME>.
//
// The canonical form is PascalCase, no spaces, so it survives
// JSON / URL transport and matches the Postgres check constraints
// (016_tally_v2.sql, 110_tally_voucher_type_per_company.sql).
// The XML form is whatever Tally actually names the voucher type
// in the company data, which has spaces for compound names.

const TALLY_VOUCHER_TYPE_XML = {
  Sales: "Sales",
  SalesOrder: "Sales Order",
  Purchase: "Purchase",
  Receipt: "Receipt",
  Payment: "Payment",
  Contra: "Contra",
  Journal: "Journal",
  DebitNote: "Debit Note",
  CreditNote: "Credit Note",
  StockJournal: "Stock Journal",
};

// Phase 1 F1 audit conclusion: "Sales" is the right default for
// the SO push path, because it books revenue + GST output.
// "SalesOrder" leaves the buyer's ITC chain broken.
export const DEFAULT_CANONICAL_VOUCHER_TYPE = "Sales";

export const toTallyXmlName = (canonical) => {
  if (!canonical) return TALLY_VOUCHER_TYPE_XML[DEFAULT_CANONICAL_VOUCHER_TYPE];
  return TALLY_VOUCHER_TYPE_XML[canonical] || TALLY_VOUCHER_TYPE_XML[DEFAULT_CANONICAL_VOUCHER_TYPE];
};

export const isCanonicalVoucherType = (s) =>
  typeof s === "string" && Object.prototype.hasOwnProperty.call(TALLY_VOUCHER_TYPE_XML, s);

export const resolveSalesVoucherType = (company) => {
  if (company && typeof company.default_sales_voucher_type === "string"
      && isCanonicalVoucherType(company.default_sales_voucher_type)) {
    return company.default_sales_voucher_type;
  }
  return DEFAULT_CANONICAL_VOUCHER_TYPE;
};
