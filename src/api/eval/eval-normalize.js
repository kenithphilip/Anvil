// CM P4: shape adapters for the golden-set accuracy harness.
//
// The scorer (scoreCase in run.js) compares a flat "order" vocabulary:
//   { poNumber, poDate, customer (string), grandTotal,
//     lineItems: [{ partNo, qty, rate, hsn, itemName }] }
//
// But the two things we actually want to score arrive in DIFFERENT shapes:
//   (a) an APPROVED order's result.salesOrder — the human-verified ground
//       truth we promote to a golden `expected`. Its lines may be camelCase
//       from the extractor (partNumber/quantity/unitPrice) OR the snake/short
//       convert.js shape (partNo/qty/rate).
//   (b) a fresh pipeline `normalized` extract — nested + camelCase
//       (customer.po_number, lines[].partNumber/quantity/unitPrice), which we
//       re-score offline against a golden `expected`.
//
// These helpers rename BOTH into the scorer's vocabulary so a diff is
// apples-to-apples. Pure, dependency-free, exhaustively unit-tested.

const firstDefined = (...vals) => {
  for (const v of vals) if (v !== undefined && v !== null && v !== "") return v;
  return undefined;
};

const numOrUndef = (v) => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

// One extracted/authored line -> the scorer's line vocabulary.
// Accepts both the camelCase extractor shape and the short convert shape.
export const lineToScorable = (line) => {
  if (!line || typeof line !== "object") return {};
  const out = {};
  const partNo = firstDefined(line.partNo, line.partNumber, line.sellerPartNo, line.sku, line.code);
  if (partNo !== undefined) out.partNo = partNo;
  const itemName = firstDefined(line.itemName, line.tallyItemName, line.description, line.name);
  if (itemName !== undefined) out.itemName = itemName;
  // The buyer SAP code (P2b) rides along so the harness can score it too.
  const customerItemCode = firstDefined(line.customerItemCode, line.customer_item_code);
  if (customerItemCode !== undefined) out.customerItemCode = customerItemCode;
  const qty = numOrUndef(firstDefined(line.qty, line.quantity));
  if (qty !== undefined) out.qty = qty;
  const rate = numOrUndef(firstDefined(line.rate, line.unitPrice, line.listed_unit_price));
  if (rate !== undefined) out.rate = rate;
  const hsn = firstDefined(line.hsn, line.hsnCode, line.hsn_sac);
  if (hsn !== undefined) out.hsn = hsn;
  return out;
};

// An order's result.salesOrder -> a scorer `expected`/`actual`.
// salesOrder.customer may be an object ({name, po_number, po_date, ...}) from
// the extractor, or the top-level fields may already be flattened.
export const salesOrderToScorable = (salesOrder) => {
  const so = salesOrder || {};
  const cust = so.customer && typeof so.customer === "object" ? so.customer : null;
  const out = {};
  const poNumber = firstDefined(so.poNumber, so.po_number, cust && cust.po_number);
  if (poNumber !== undefined) out.poNumber = poNumber;
  const poDate = firstDefined(so.poDate, so.po_date, cust && cust.po_date);
  if (poDate !== undefined) out.poDate = poDate;
  const customer = firstDefined(
    typeof so.customer === "string" ? so.customer : undefined,
    cust && cust.name,
    so.customerName,
  );
  if (customer !== undefined) out.customer = customer;
  const grandTotal = numOrUndef(firstDefined(so.grandTotal, so.grand_total, so.totals && so.totals.grand_total));
  if (grandTotal !== undefined) out.grandTotal = grandTotal;
  const lines = Array.isArray(so.lineItems) ? so.lineItems : (Array.isArray(so.lines) ? so.lines : []);
  out.lineItems = lines.map(lineToScorable);
  return out;
};

// A fresh pipeline `normalized` extract -> a scorer `actual`. Used by the
// offline re-score path (zero LLM: re-scores the stored normalized_extract).
export const normalizedToScorable = (normalized) => {
  const n = normalized || {};
  const cust = n.customer && typeof n.customer === "object" ? n.customer : {};
  const out = {};
  if (cust.po_number !== undefined && cust.po_number !== null) out.poNumber = cust.po_number;
  if (cust.po_date !== undefined && cust.po_date !== null) out.poDate = cust.po_date;
  if (cust.name !== undefined && cust.name !== null) out.customer = cust.name;
  const lines = Array.isArray(n.lines) ? n.lines : [];
  out.lineItems = lines.map(lineToScorable);
  // The PO's own declared count (P3) rides along so a completeness/recall
  // metric can compare it too.
  const declared = numOrUndef(n.stated_line_count);
  if (declared !== undefined) out.stated_line_count = declared;
  return out;
};
