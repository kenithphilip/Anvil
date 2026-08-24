// PR 4 of docs/EXTRACTION_QUALITY.md — per-kind scoring profiles for the
// golden set.
//
// The problem this solves, demonstrably: the golden scorer and its shape
// adapter spoke exactly one vocabulary — purchase order. poNumber, poDate,
// customer, grandTotal, and lines of { partNo, qty, rate, hsn }. Every check
// in scoreCase is guarded by `if (expected.X !== undefined)`, so a fixture for
// a different kind of document did not FAIL — it silently scored only the
// handful of fields it happened to share, and passed.
//
// Concretely: a packing list whose weight_basis flips from per_package to
// per_unit is a 2× error on every shipping weight in the shipment. Run it
// through the old adapter and the line reduces to { itemName, qty }; the
// weight, its unit, its basis and the volume are all dropped before scoring.
// It scores 1.000 against a correct golden. That is the exact class of bug
// commit e357f01 ("the packing list's measurement column was extracted and
// dropped") fixed by hand — a bug the regression gate structurally could not
// have caught, because the gate could not see the column.
//
// A profile declares, per document kind, WHICH fields are worth scoring and
// how to compare them. The `po` profile reproduces the previous hardcoded
// behaviour exactly — check names, order and outcomes — so the three committed
// fixtures and the CI gate do not move.
//
// Field descriptor: { key, from: [source paths], compare: "text" | "number" }
//   key     the name in the scorer vocabulary (and in the check name)
//   from    dotted paths into the normalized extract, first defined wins
//   compare how expected and actual are compared

// Read a dotted path out of a normalized extract.
export const readPath = (obj, path) => {
  if (!obj || typeof obj !== "object") return undefined;
  let cur = obj;
  for (const seg of String(path).split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[seg];
  }
  return cur;
};

const firstDefined = (obj, paths) => {
  for (const p of paths) {
    const v = readPath(obj, p);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
};

const numOrUndef = (v) => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

// ── the purchase order profile ───────────────────────────────────────
//
// Byte-compatible with the previous hardcoded scoreCase: same field set, same
// order, same identity-matching rule, same check names. Changing anything here
// changes what the CI gate measures, so it is written out longhand rather than
// derived.
const PO_PROFILE = {
  kind: "po",
  suite: "po-extraction",
  label: "Purchase order",
  docRole: "purchase_order",
  header: [
    { key: "poNumber", from: ["customer.po_number"], compare: "text" },
    { key: "poDate", from: ["customer.po_date"], compare: "text" },
    { key: "customer", from: ["customer.name"], compare: "text" },
    { key: "grandTotal", from: ["grandTotal", "totals.grand_total"], compare: "number" },
  ],
  // How an expected line is matched to an actual one. Each rule is tried in
  // order; the first actual line (not already used) that satisfies any rule
  // wins. `name` is what the identity check is called.
  identity: {
    name: "partNo",
    rules: [
      { actual: ["partNo", "sellerPartNo"], expected: ["partNo"] },
      { actual: ["itemName", "tallyItemName"], expected: ["itemName", "partNo"] },
    ],
  },
  line: [
    { key: "qty", from: ["qty", "quantity"], compare: "number" },
    { key: "rate", from: ["rate", "unitPrice", "listed_unit_price"], compare: "number" },
    { key: "hsn", from: ["hsn", "hsnCode", "hsn_sac"], compare: "text", actualAlias: ["hsnCode"] },
  ],
  // Fields the MODEL does not own — deterministic enrichment or post-processing
  // fills them, so a live replay must not treat their absence as a regression.
  modelOwned: { dropHeader: ["grandTotal"], dropLine: ["hsn"] },
};

// ── the non-PO profiles ──────────────────────────────────────────────
//
// Each names only the fields whose corruption a human would call a defect.
// Deliberately narrow: a field that is scored but nobody acts on turns a
// regression gate into noise, and a noisy gate gets disabled.

const QUOTE_PROFILE = {
  kind: "quote",
  suite: "quote-extraction",
  label: "Supplier / customer quotation",
  docRole: "quote",
  header: [
    { key: "quoteNumber", from: ["quote_number"], compare: "text" },
    { key: "quoteDate", from: ["quote_date"], compare: "text" },
    // customer.name, NOT customer_name. `customer_name` is a QUOTE_TOOL schema
    // property, but the normalizer consumes it and re-emits it nested
    // (claude.js: `customer: out.customer || (isQuote && out.customer_name ?
    // { name: out.customer_name } : null)`), so it does not survive into the
    // stored normalized_extract this profile reads. Reading the schema name
    // returned undefined, toScorableFor omitted the key, and scoreCase skipped
    // the check — every quote golden silently scored the customer as a pass.
    // The flat alias is kept second in case an adapter ever emits it raw.
    { key: "customer", from: ["customer.name", "customer_name"], compare: "text" },
    { key: "currency", from: ["currency"], compare: "text" },
    { key: "grandTotal", from: ["grand_total"], compare: "number" },
    { key: "revision", from: ["revision"], compare: "text" },
  ],
  identity: {
    name: "partNo",
    rules: [
      { actual: ["partNo"], expected: ["partNo"] },
      { actual: ["itemName"], expected: ["itemName", "partNo"] },
    ],
  },
  line: [
    { key: "qty", from: ["quantity", "qty"], compare: "number" },
    // The two price columns. #462 shipped because a quote printing a list
    // price beside a discounted one had the discounted one silently dropped —
    // scoring only one of these would leave that bug invisible again.
    { key: "rate", from: ["unitPrice"], compare: "number" },
    { key: "listRate", from: ["listUnitPrice"], compare: "number" },
    { key: "uom", from: ["uom"], compare: "text" },
    { key: "hsn", from: ["hsn"], compare: "text" },
    { key: "taxPct", from: ["igst_pct"], compare: "number" },
    // The line total. It is correctable on the Quotes tab, so without a
    // descriptor here an operator could fix it, watch the harvest count it as
    // a corrected field, and have toScorableFor drop it — a golden that names
    // a field it does not check. It is also worth checking on its own terms:
    // qty x rate disagreeing with the printed amount is how a misread decimal
    // shows up.
    { key: "amount", from: ["amount"], compare: "number" },
    // `remark` is deliberately NOT scored. It is correctable — it carries MOQ
    // and per-row conditions, and those are worth feeding to the hint loop —
    // but it is free text, and an exact-match check on free text is how a
    // regression gate becomes noise, and a noisy gate gets turned off.
  ],
  modelOwned: { dropHeader: [], dropLine: [] },
};

const PACKING_LIST_PROFILE = {
  kind: "packing_list",
  suite: "packing-list-extraction",
  label: "Packing list",
  docRole: "packing_list",
  header: [
    { key: "packingListNo", from: ["packing_list_no"], compare: "text" },
    { key: "invoiceNo", from: ["invoice_no"], compare: "text" },
    { key: "supplier", from: ["supplier_name"], compare: "text" },
    { key: "totalPackages", from: ["total_packages"], compare: "number" },
    { key: "totalNetWeight", from: ["total_net_weight"], compare: "number" },
    // The document-level unit. A packing list printed in pounds and read as
    // kilograms mis-scales every weight in the shipment by 2.2×.
    { key: "weightUom", from: ["weight_uom"], compare: "text" },
  ],
  identity: {
    name: "partNo",
    rules: [
      { actual: ["partNo"], expected: ["partNo"] },
      { actual: ["itemName"], expected: ["itemName", "partNo"] },
    ],
  },
  line: [
    { key: "qty", from: ["quantity", "qty"], compare: "number" },
    { key: "packages", from: ["packages"], compare: "number" },
    { key: "weight", from: ["weight"], compare: "number" },
    { key: "weightUom", from: ["weight_uom"], compare: "text" },
    // The single field the whole freight chain hangs on: whether the printed
    // weight is per unit or per package. Getting it wrong is a silent 2×-to-
    // 50× error on a shipping weight that nothing downstream can detect.
    { key: "weightBasis", from: ["weight_basis"], compare: "text" },
    { key: "volumeCbm", from: ["volume_cbm"], compare: "number" },
    { key: "volumeBasis", from: ["volume_basis"], compare: "text" },
  ],
  modelOwned: { dropHeader: [], dropLine: [] },
};

const INVOICE_PROFILE = {
  kind: "invoice",
  suite: "invoice-extraction",
  label: "Supplier invoice",
  docRole: "invoice",
  header: [
    { key: "invoiceNumber", from: ["invoice_number"], compare: "text" },
    { key: "invoiceDate", from: ["invoice_date"], compare: "text" },
    { key: "supplier", from: ["supplier_name"], compare: "text" },
    // The buyer's PO reference is the join key the three-way match runs on;
    // a wrong one silently orphans the invoice.
    { key: "poReference", from: ["po_reference"], compare: "text" },
    { key: "currency", from: ["currency"], compare: "text" },
    { key: "subtotal", from: ["subtotal"], compare: "number" },
    { key: "taxTotal", from: ["tax_total"], compare: "number" },
    { key: "grandTotal", from: ["grand_total"], compare: "number" },
  ],
  identity: {
    name: "partNo",
    rules: [
      { actual: ["partNo"], expected: ["partNo"] },
      { actual: ["itemName"], expected: ["itemName", "partNo"] },
    ],
  },
  line: [
    { key: "qty", from: ["quantity", "qty"], compare: "number" },
    { key: "rate", from: ["unitPrice"], compare: "number" },
    { key: "amount", from: ["amount"], compare: "number" },
    { key: "hsn", from: ["hsn"], compare: "text" },
  ],
  modelOwned: { dropHeader: [], dropLine: [] },
};

const EWAY_BILL_PROFILE = {
  kind: "eway_bill",
  suite: "eway-bill-extraction",
  label: "E-way bill",
  docRole: "eway_bill",
  header: [
    { key: "ewbNo", from: ["ewb_no"], compare: "text" },
    { key: "ewbDate", from: ["ewb_date"], compare: "text" },
    { key: "validUpto", from: ["ewb_valid_upto"], compare: "text" },
    { key: "docNo", from: ["doc_no"], compare: "text" },
    { key: "vehicleNo", from: ["vehicle_no"], compare: "text" },
    { key: "fromGstin", from: ["from_gstin"], compare: "text" },
    { key: "toGstin", from: ["to_gstin"], compare: "text" },
    { key: "taxableValue", from: ["taxable_value"], compare: "number" },
  ],
  identity: {
    name: "partNo",
    rules: [
      { actual: ["partNo"], expected: ["partNo"] },
      { actual: ["itemName"], expected: ["itemName", "partNo"] },
    ],
  },
  line: [
    { key: "qty", from: ["quantity", "qty"], compare: "number" },
    { key: "hsn", from: ["hsn"], compare: "text" },
    { key: "taxableValue", from: ["taxable_value"], compare: "number" },
  ],
  modelOwned: { dropHeader: [], dropLine: [] },
};

// The sales order the customer's ERP produced. The third side of the Mode A/B
// comparison, and the only document that prints BOTH part numbers.
const SALES_ORDER_PROFILE = {
  kind: "sales_order",
  suite: "sales-order-extraction",
  label: "Sales order / order acknowledgement",
  docRole: "sales_order",
  header: [
    // The join key first, because it is the field the whole comparison hangs
    // on. A sales order whose buyer reference is misread does not reconcile
    // against anything, and it fails looking like an unmatched order rather
    // than a bad extraction.
    { key: "buyerRefOrderNo", from: ["buyer_ref_order_no"], compare: "text" },
    { key: "voucherNo", from: ["voucher_no"], compare: "text" },
    { key: "voucherDate", from: ["voucher_date"], compare: "text" },
    { key: "buyer", from: ["buyer_name"], compare: "text" },
    { key: "paymentTerms", from: ["payment_terms"], compare: "text" },
    { key: "currency", from: ["currency"], compare: "text" },
    { key: "totalAmount", from: ["total_amount"], compare: "number" },
  ],
  identity: {
    // Matched on OUR part number, like every other kind — but a sales order is
    // the one document that also prints the customer's, so a fixture can pin
    // both and catch the columns being read the wrong way round.
    name: "partNo",
    rules: [
      { actual: ["partNo"], expected: ["partNo"] },
      { actual: ["itemName"], expected: ["itemName", "partNo"] },
    ],
  },
  line: [
    { key: "qty", from: ["quantity", "qty"], compare: "number" },
    { key: "rate", from: ["rate", "unitPrice"], compare: "number" },
    { key: "amount", from: ["amount"], compare: "number" },
    { key: "discountPct", from: ["discount_pct"], compare: "number" },
    { key: "uom", from: ["uom"], compare: "text" },
    { key: "hsn", from: ["hsn"], compare: "text" },
    // The customer's own code, scored explicitly. This is the mapping a person
    // performed by hand, it is the field most worth verifying in the whole
    // comparison, and a fixture that did not check it would let the two part
    // columns be swapped without a single test going red.
    { key: "customerPartNo", from: ["customerPartNumber", "customer_part_number"], compare: "text" },
    // `due_on` and `batch` are extracted and deliberately NOT scored here.
    // A due date is a commitment the ERP derived, not a fact printed on the
    // PO, so it belongs in the three-way adjudication where the authority is
    // named — not in a pass/fail on extraction accuracy.
  ],
  modelOwned: {
    // Neither is a claim about the model's reading. The voucher number and
    // date are the ERP's own sequence and clock, unknowable to anything
    // outside it, so a live replay must not score them.
    dropHeader: ["voucherNo", "voucherDate"],
    dropLine: [],
  },
};

export const KIND_PROFILES = {
  po: PO_PROFILE,
  rfq: PO_PROFILE,          // rfq runs the PO schema; same vocabulary
  quote: QUOTE_PROFILE,
  packing_list: PACKING_LIST_PROFILE,
  invoice: INVOICE_PROFILE,
  eway_bill: EWAY_BILL_PROFILE,
  sales_order: SALES_ORDER_PROFILE,
};

// A kind with no profile has no business in the golden set: a fixture the
// scorer cannot read would pass vacuously, which is worse than no fixture.
// assembly_bom and part_drawing are deliberately absent — their extracts are
// not header+lines and need their own scoring model, not a bad fit to this one.
export const profileFor = (kind) => KIND_PROFILES[String(kind || "po")] || null;

// Resolve the profile for a stored golden case. The kind rides inside
// `expected._provenance` — the same no-migration metadata channel promote.js
// already uses for the order id and approver — so eval_cases needs no new
// column and no hand-applied migration to carry non-PO goldens.
//
// A case with NO recorded kind is a purchase order: every golden promoted
// before PR 4 was one. A case whose kind is recorded but unsupported returns
// null so the caller can SKIP it, rather than score it against the wrong
// vocabulary and report a confident, meaningless number.
export const kindOfExpected = (expected) =>
  (expected && expected._provenance && expected._provenance.extraction_kind) || null;
export const profileForExpected = (expected) => {
  const kind = kindOfExpected(expected);
  return kind ? profileFor(kind) : profileFor("po");
};
export const profileForSuite = (suite) =>
  Object.values(KIND_PROFILES).find((p) => p.suite === String(suite || "")) || null;
export const SCORABLE_KINDS = Object.keys(KIND_PROFILES);

// ── the shape adapter, profile-driven ────────────────────────────────
//
// Renames a normalized extract into the scorer's vocabulary for its kind.
// Only fields the profile declares survive — which is the point: an undeclared
// field cannot be scored, so declaring one is the deliberate act of saying
// "this field matters".
export const toScorableFor = (normalized, profile) => {
  const n = normalized || {};
  const p = profile || PO_PROFILE;
  const out = {};
  for (const f of p.header) {
    const raw = firstDefined(n, f.from);
    if (raw === undefined) continue;
    const v = f.compare === "number" ? numOrUndef(raw) : raw;
    if (v !== undefined) out[f.key] = v;
  }
  const lines = Array.isArray(n.lines) ? n.lines : (Array.isArray(n.lineItems) ? n.lineItems : []);
  out.lineItems = lines.map((line) => {
    const l = line && typeof line === "object" ? line : {};
    const item = {};
    // Identity fields, so a scorable line can be matched back.
    const partNo = firstDefined(l, ["partNo", "partNumber", "sellerPartNo", "sku", "code"]);
    if (partNo !== undefined) item.partNo = partNo;
    const itemName = firstDefined(l, ["itemName", "tallyItemName", "description", "name"]);
    if (itemName !== undefined) item.itemName = itemName;
    const custCode = firstDefined(l, ["customerItemCode", "customer_item_code", "customerPartNumber"]);
    if (custCode !== undefined) item.customerItemCode = custCode;
    for (const f of p.line) {
      const raw = firstDefined(l, f.from);
      if (raw === undefined) continue;
      const v = f.compare === "number" ? numOrUndef(raw) : raw;
      if (v !== undefined) item[f.key] = v;
    }
    return item;
  });
  const declared = numOrUndef(n.stated_line_count);
  if (declared !== undefined) out.stated_line_count = declared;
  return out;
};

// Strip the fields the model does not own, so a live replay measures the model
// rather than the deterministic enrichment layered on top of it.
export const modelOwnedFor = (expected, profile) => {
  const p = profile || PO_PROFILE;
  const out = { ...(expected || {}) };
  delete out._provenance;
  for (const k of p.modelOwned.dropHeader) delete out[k];
  if (Array.isArray(out.lineItems)) {
    out.lineItems = out.lineItems.map((l) => {
      const c = { ...l };
      for (const k of p.modelOwned.dropLine) delete c[k];
      return c;
    });
  }
  return out;
};
