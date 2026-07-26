// Customer payment statement — open invoices, aged, with GRN where we have it.
//
// THE DESIGN CONSTRAINT (from Joel): the customer invests heavily in processing
// the PO and little afterward, so the GRN — number + date — is OFTEN NEVER SENT
// back. Payment terms in Indian B2B routinely clock off the GRN date ("30 days
// from date of receipt"), so a MISSING GRN means the due date is genuinely
// UNKNOWN, not late.
//
// So this must NOT be a waterfall that assumes GRN exists. It:
//   * shows every open invoice with WHATEVER GRN we have (customer_receipts),
//   * computes the due date from the GRN date when terms clock off receipt AND
//     we have the GRN; otherwise falls back to invoice-date terms and marks the
//     figure PROVISIONAL, or marks it PENDING when the terms need a GRN we lack,
//   * and by surfacing "GRN awaited" per line, the statement itself becomes the
//     nudge that gets the GRN sent — which is the only way that data ever
//     arrives.
//
// Pure: no I/O, no dates-from-the-clock (the caller passes `today`), so every
// due-date and aging calculation is deterministic and testable.

// ── payment terms ─────────────────────────────────────────────────────────
// Parse free-text terms into { days, basis }. basis decides the clock:
//   'receipt' — "N days from date of receipt / GRN / goods receipt"  (needs GRN)
//   'invoice' — "N days from invoice date" / "Net N" / bare "N days"
//   'unknown' — no day count found
export const parsePaymentTerms = (text) => {
  const t = String(text || "").toLowerCase();
  // First "<n> day(s)" or "net <n>".
  const m = t.match(/(?:net\s*)?(\d{1,3})\s*day/) || t.match(/net\s*(\d{1,3})/);
  const days = m ? Number(m[1]) : null;
  let basis = "unknown";
  if (days != null) {
    if (/receipt|grn|goods\s*receipt|delivery|srn|service\s*entry/.test(t)) basis = "receipt";
    else basis = "invoice";   // "from invoice", "net N", or bare "N days"
  }
  return { days, basis, raw: text || null };
};

// Add N days to a YYYY-MM-DD date. Returns a YYYY-MM-DD string or null.
const addDays = (isoDate, days) => {
  if (!isoDate || days == null) return null;
  const d = new Date(isoDate + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString().slice(0, 10);
};

const daysBetween = (fromIso, toIso) => {
  if (!fromIso || !toIso) return null;
  const a = Date.parse(fromIso + "T00:00:00Z");
  const b = Date.parse(toIso + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── one line ──────────────────────────────────────────────────────────────
// Given an invoice + its matched receipt (or null) + parsed terms, decide the
// due date and how confident we are in it.
//
// due_basis:
//   'grn'         due = GRN date + N days — the real, contractual date
//   'invoice'     due = invoice date + N days — terms clock off the invoice
//   'provisional' terms clock off GRN, we lack it, so we show invoice+N as a
//                 PLACEHOLDER and say so
//   'pending'     terms clock off GRN, we lack it, and there is no sane
//                 invoice-based placeholder — due date genuinely unknown
export const computeInvoiceLine = (invoice, receipt, today) => {
  const terms = parsePaymentTerms(invoice.payment_terms);
  const outstanding = round2((Number(invoice.grand_total) || 0) - (Number(invoice.paid_amount) || 0));
  const grnDate = receipt?.receipt_date || null;
  const grnNumber = receipt?.receipt_number || null;

  let dueDate = null;
  let dueBasis;
  if (terms.basis === "receipt") {
    if (grnDate) {
      dueDate = addDays(grnDate, terms.days);
      dueBasis = "grn";
    } else if (terms.days != null && invoice.issue_date) {
      // Terms need a GRN we do not have. Show an invoice-anchored placeholder
      // so the row still ages, but flag it hard — the true clock has not started.
      dueDate = addDays(invoice.issue_date, terms.days);
      dueBasis = "provisional";
    } else {
      dueBasis = "pending";
    }
  } else if (terms.basis === "invoice" && invoice.issue_date) {
    dueDate = addDays(invoice.issue_date, terms.days);
    dueBasis = "invoice";
  } else {
    // No parseable terms: fall back to the invoice's own stored due_date.
    dueDate = invoice.due_date || null;
    dueBasis = invoice.due_date ? "invoice" : "pending";
  }

  const daysPastDue = dueDate ? daysBetween(dueDate, today) : null;

  return {
    invoice_id: invoice.id || null,
    invoice_number: invoice.invoice_number || null,
    po_number: invoice.po_number || null,
    issue_date: invoice.issue_date || null,
    currency: invoice.currency || "INR",
    grand_total: round2(invoice.grand_total),
    paid_amount: round2(invoice.paid_amount),
    outstanding,
    payment_terms: terms.raw,
    terms_days: terms.days,
    terms_basis: terms.basis,
    grn_number: grnNumber,
    grn_date: grnDate,
    grn_awaited: terms.basis === "receipt" && !grnDate,   // the nudge flag
    due_date: dueDate,
    due_basis: dueBasis,
    days_past_due: daysPastDue,
    overdue: dueBasis !== "pending" && dueBasis !== "provisional" && daysPastDue != null && daysPastDue > 0,
  };
};

const bucketFor = (line) => {
  if (line.grn_awaited || line.due_basis === "pending") return "grn_awaited";
  if (line.due_basis === "provisional") return "provisional";
  const d = line.days_past_due;
  if (d == null || d <= 0) return "current";
  if (d <= 30) return "1-30";
  if (d <= 60) return "31-60";
  if (d <= 90) return "61-90";
  return "90+";
};

// ── the statement ───────────────────────────────────────────────────────────
// invoices: open invoices for one customer.
// receipts: customer_receipts for that customer (any subset).
// Matches a receipt to an invoice by invoice_id, then invoice_number, then
// po_number — because in practice GRNs arrive keyed to whichever the customer's
// stores team happened to type.
export const buildPaymentStatement = ({ customer, invoices = [], receipts = [], today }) => {
  const byInvoiceId = new Map();
  const byInvoiceNo = new Map();
  const byPo = new Map();
  for (const r of receipts) {
    if (r.invoice_id) byInvoiceId.set(String(r.invoice_id), r);
    if (r.invoice_number) byInvoiceNo.set(String(r.invoice_number).trim().toUpperCase(), r);
    if (r.po_number) byPo.set(String(r.po_number).trim().toUpperCase(), r);
  }
  const matchReceipt = (inv) =>
    (inv.id && byInvoiceId.get(String(inv.id)))
    || (inv.invoice_number && byInvoiceNo.get(String(inv.invoice_number).trim().toUpperCase()))
    || (inv.po_number && byPo.get(String(inv.po_number).trim().toUpperCase()))
    || null;

  const lines = invoices
    .map((inv) => computeInvoiceLine(inv, matchReceipt(inv), today))
    .filter((l) => l.outstanding > 0);

  const currency = lines[0]?.currency || "INR";
  const buckets = { current: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0, provisional: 0, grn_awaited: 0 };
  let totalOutstanding = 0;
  let overdueOutstanding = 0;
  let grnAwaitedOutstanding = 0;
  for (const l of lines) {
    totalOutstanding += l.outstanding;
    buckets[bucketFor(l)] += l.outstanding;
    if (l.overdue) overdueOutstanding += l.outstanding;
    if (l.grn_awaited) grnAwaitedOutstanding += l.outstanding;
  }

  return {
    customer_id: customer?.id || null,
    customer_name: customer?.customer_name || customer?.name || null,
    as_of: today,
    currency,
    lines,
    summary: {
      open_invoices: lines.length,
      total_outstanding: round2(totalOutstanding),
      overdue_outstanding: round2(overdueOutstanding),
      // The whole point: how much is stuck ONLY because we never got the GRN.
      grn_awaited_count: lines.filter((l) => l.grn_awaited).length,
      grn_awaited_outstanding: round2(grnAwaitedOutstanding),
    },
    aging: Object.entries(buckets).map(([label, amt]) => ({ label, outstanding: round2(amt) })),
  };
};

// ── render an email body ────────────────────────────────────────────────────
// Plain-text statement suitable as the comm body. Deliberately doubles as a GRN
// nudge: the awaited rows are called out, with a one-line ask.
export const renderStatementText = (st, opts = {}) => {
  const money = (n) => (st.currency ? st.currency + " " : "") + Number(n || 0).toLocaleString("en-IN");
  const L = [];
  L.push("Statement of outstanding invoices" + (st.customer_name ? " — " + st.customer_name : ""));
  L.push("As of " + (st.as_of || "") + "\n");
  L.push("Inv No        | PO No       | Invoice Dt | Outstanding   | GRN No / Date        | Due");
  for (const l of st.lines) {
    const grn = l.grn_number
      ? l.grn_number + " / " + (l.grn_date || "?")
      : (l.grn_awaited ? "AWAITED" : "—");
    const due = l.due_date
      ? l.due_date + (l.due_basis === "provisional" ? " (provisional)" : l.due_basis === "grn" ? " (per GRN)" : "")
      : "pending GRN";
    L.push([
      (l.invoice_number || "—").padEnd(13),
      (l.po_number || "—").padEnd(11),
      (l.issue_date || "—").padEnd(10),
      money(l.outstanding).padEnd(13),
      grn.padEnd(20),
      due,
    ].join(" | "));
  }
  L.push("");
  L.push("Total outstanding: " + money(st.summary.total_outstanding));
  if (st.summary.overdue_outstanding > 0) L.push("Of which overdue: " + money(st.summary.overdue_outstanding));
  if (st.summary.grn_awaited_count > 0) {
    L.push("");
    L.push(st.summary.grn_awaited_count + " invoice(s) totalling " + money(st.summary.grn_awaited_outstanding)
      + " are on receipt-based terms and we have NOT received your GRN.");
    L.push("Please share the GRN number and date for these so we can confirm the payment due date.");
  }
  if (opts.footer) { L.push(""); L.push(opts.footer); }
  return L.join("\n");
};
