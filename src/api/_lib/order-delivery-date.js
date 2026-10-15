// The delivery date read path (plan PR 10): one place that says which date
// an order is due, where that date came from, and when the dates disagree.
//
// #589 extracts the PO's delivery dates (behind the po_extractor@v4 canary):
//   result.salesOrder.customer.delivery_date   the PO header's date
//   result.salesOrder.lineItems[].delivery_date the date printed on a line
// Each is ISO when it parsed (day-first), else the text as printed
// (docai/po-delivery-contact.js deliveryDateOf). Nothing in the order flow
// read them: the grid had no date column, the SO PDF read a key nothing
// writes, and the Excel export had no due date at all.
//
// Two different dates, never mixed up:
//   the PO's date        what the customer asks for (required by)
//   the committed date   what we promise (orders.committed_delivery_date,
//                        the Header fields tab, used for on-time delivery)
//
// The committed date is NEVER filled in from the PO's date here. Whether it
// should be is owner decision 7, still open. The PO's date is offered only as
// a suggestion (suggestedCommittedDate), which a person applies by saving the
// Header fields tab.
//
// PURE. No I/O. The SO PDF, the Excel export, the exceptions list and the
// workspace all read these, so they cannot disagree.

import { isoDayFirst } from "./docai/po-delivery-contact.js";

export const DUE_SOURCES = Object.freeze(["schedule", "po_line", "po_header", "committed", "none"]);

export const DUE_SOURCE_LABEL = Object.freeze({
  schedule: "our schedule",
  po_line: "from the PO line",
  po_header: "from the PO header",
  po_description: "from a line description",
  committed: "committed by us",
  none: "none",
});

// The day "today" is judged in. A date-only comparison done in UTC is a day
// early for half of every Indian morning.
export const DEFAULT_TIME_ZONE = "Asia/Kolkata";

const str = (v) => (v == null ? "" : String(v).trim());

// A date value as { printed, iso }: iso when it reads as a calendar date,
// printed always (the text a person would recognise).
export const readDate = (raw) => {
  const printed = str(raw);
  if (!printed) return null;
  return { printed, iso: isoDayFirst(printed) };
};

// The ISO day `now` falls on, in a time zone.
export const todayIso = (now = new Date(), timeZone = DEFAULT_TIME_ZONE) => {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
};

const linesOf = (order) => (Array.isArray(order?.result?.salesOrder?.lineItems) ? order.result.salesOrder.lineItems : []);

// The PO header's date. The older salesOrder.delivery_date key is read too:
// nothing writes it today, but an import that did would otherwise be lost.
export const poHeaderDate = (order) => {
  const so = order?.result?.salesOrder || {};
  return readDate(so.customer?.delivery_date) || readDate(so.delivery_date);
};

// The date printed on one line.
export const poLineDate = (line) => readDate(line?.delivery_date ?? line?.deliveryDate);

// The committed date (ours).
export const committedDate = (order) => readDate(order?.committed_delivery_date);

// The PO's required-by date for the whole order, with its source:
//   1. the header's date
//   2. else the earliest line date
//   3. else none
// A printed date that does not read as a calendar date still counts as the
// PO's date (so it is shown), but it cannot be compared.
export const poRequiredBy = (order) => {
  const header = poHeaderDate(order);
  if (header) return { ...header, source: "po_header", line_index: null };
  let best = null;
  linesOf(order).forEach((ln, i) => {
    const d = poLineDate(ln);
    if (!d) return;
    if (!best) { best = { ...d, line_index: i }; return; }
    if (d.iso && (!best.iso || d.iso < best.iso)) best = { ...d, line_index: i };
  });
  if (best) return { ...best, source: "po_line" };
  return { printed: null, iso: null, source: "none", line_index: null };
};

// What the order's summary shows: the PO's date when the PO states one,
// else the date we committed to, else none. One date, one source.
export const orderDeliveryDate = (order) => {
  const po = poRequiredBy(order);
  if (po.source !== "none") return po;
  const c = committedDate(order);
  if (c) return { ...c, source: "committed", line_index: null };
  return po;
};

// The due date of one line, as the SO PDF and the Excel export print it.
// In order:
//   1. our schedule for the line (the Schedule tab), as before
//   2. the date printed on the PO line
//   3. the PO header's date
//   4. the committed date
//   5. none
// schedules: rows of order_schedule_lines ({ line_index, scheduled_date }).
export const lineDueDate = (order, lineIndex, schedules = []) => {
  const sched = (Array.isArray(schedules) ? schedules : [])
    .find((s) => s && Number(s.line_index) === Number(lineIndex) && str(s.scheduled_date));
  if (sched) return { ...readDate(sched.scheduled_date), source: "schedule" };
  const line = poLineDate(linesOf(order)[lineIndex]);
  if (line) return { ...line, source: "po_line" };
  const header = poHeaderDate(order);
  if (header) return { ...header, source: "po_header" };
  const c = committedDate(order);
  if (c) return { ...c, source: "committed" };
  return { printed: null, iso: null, source: "none" };
};

// The PO's date written into a description ("Delivery date : 15/11/2026"),
// read only when nothing better exists. Low confidence: it is free text.
const DESCRIPTION_DATE = /delivery\s*date\s*[:\-]?\s*([0-9]{1,2}[/.\-][0-9]{1,2}[/.\-][0-9]{2,4}|[0-9]{1,2}[\s\-]+[A-Za-z]{3,9}[\s\-,]+[0-9]{2,4}|[0-9]{4}-[0-9]{2}-[0-9]{2})/i;
const descriptionDate = (order) => {
  let best = null;
  linesOf(order).forEach((ln, i) => {
    const text = str(ln?.raw_description) + " " + str(ln?.description);
    const m = DESCRIPTION_DATE.exec(text);
    const iso = m ? isoDayFirst(m[1]) : null;
    if (iso && (!best || iso < best.iso)) best = { iso, printed: m[1], line_index: i };
  });
  return best;
};

// The date we could commit to, as a suggestion, never applied by itself:
//   value       the ISO date
//   source      po_header, po_line or po_description
//   rule        which rule produced it
//   confidence  high for a date the PO states in a delivery field (header
//               or line), low otherwise
//   applies_via the existing control that sets it (the Header fields tab)
// Null when the PO states no date that reads as a calendar date.
export const suggestedCommittedDate = (order) => {
  const po = poRequiredBy(order);
  const via = {
    kind: "endpoint", method: "PATCH", path: "/api/orders/{order_id}", body: "committed_delivery_date",
    control: "Header fields tab: Committed delivery date, then Save header", permission: "write",
  };
  if (po.iso && po.source === "po_header") {
    return { value: po.iso, source: "po_header", rule: "po_header_date", confidence: "high", printed: po.printed, applies_via: via };
  }
  if (po.iso && po.source === "po_line") {
    return { value: po.iso, source: "po_line", rule: "earliest_po_line_date", confidence: "high", printed: po.printed, line_index: po.line_index, applies_via: via };
  }
  const d = descriptionDate(order);
  if (d) return { value: d.iso, source: "po_description", rule: "delivery_date_in_description", confidence: "low", printed: d.printed, line_index: d.line_index, applies_via: via };
  return null;
};

// The conflict rules, plainly:
//   committed_after_po_date   our committed date is later than the PO's
//                             required-by date (header, else earliest line)
//   line_differs_from_header  a line's date is not the header's date (both
//                             read as calendar dates)
//   date_in_past              before approval, the PO's date, a line's date
//                             or the committed date is earlier than today
// A date that does not read as a calendar date is never compared.
export const CONFLICT_RULES = Object.freeze(["committed_after_po_date", "line_differs_from_header", "date_in_past"]);

const REVIEW_STATUSES = new Set(["DRAFT", "PENDING_REVIEW", "BLOCKED"]);

export const deliveryDateConflicts = (order, { now = new Date(), timeZone = DEFAULT_TIME_ZONE } = {}) => {
  const out = [];
  if (!order || typeof order !== "object") return out;
  const po = poRequiredBy(order);
  const header = poHeaderDate(order);
  const committed = committedDate(order);
  const lines = linesOf(order);

  if (committed?.iso && po.iso && committed.iso > po.iso) {
    out.push({
      rule: "committed_after_po_date", severity: "high",
      title: "Committed date is later than the PO's date",
      detail: "Committed " + committed.iso + " vs PO " + po.iso + " (" + DUE_SOURCE_LABEL[po.source] + ")",
      payload: { field: "committed_delivery_date", po_value: po.iso, committed_value: committed.iso, po_source: po.source, line_index: po.line_index },
    });
  }

  if (header?.iso) {
    const differ = [];
    lines.forEach((ln, i) => {
      const d = poLineDate(ln);
      if (d?.iso && d.iso !== header.iso) differ.push({ line_index: i, iso: d.iso });
    });
    if (differ.length) {
      out.push({
        rule: "line_differs_from_header", severity: "warn",
        title: (differ.length === 1 ? "A line's date differs" : differ.length + " lines' dates differ") + " from the PO header's date",
        detail: "Header " + header.iso + "; " + differ.slice(0, 6).map((d) => "line " + (d.line_index + 1) + " " + d.iso).join(", ")
          + (differ.length > 6 ? ", +" + (differ.length - 6) + " more" : ""),
        payload: { field: "delivery_date", po_value: header.iso, line_indexes: differ.map((d) => d.line_index), line_values: differ },
      });
    }
  }

  if (REVIEW_STATUSES.has(str(order.status))) {
    const today = todayIso(now, timeZone);
    const past = [];
    if (header?.iso && header.iso < today) past.push({ which: "PO header", iso: header.iso });
    lines.forEach((ln, i) => {
      const d = poLineDate(ln);
      if (d?.iso && d.iso < today && d.iso !== header?.iso) past.push({ which: "line " + (i + 1), iso: d.iso, line_index: i });
    });
    if (committed?.iso && committed.iso < today) past.push({ which: "committed", iso: committed.iso });
    if (past.length) {
      out.push({
        rule: "date_in_past", severity: "warn",
        title: past.length === 1 ? "A delivery date is in the past" : past.length + " delivery dates are in the past",
        detail: past.slice(0, 6).map((p) => p.which + " " + p.iso).join(", ") + (past.length > 6 ? ", +" + (past.length - 6) + " more" : "") + "; today is " + today,
        payload: { field: "delivery_date", today, dates: past, line_indexes: past.filter((p) => p.line_index != null).map((p) => p.line_index) },
      });
    }
  }
  return out;
};

// Everything a screen shows about delivery, in one object:
//   shown       the one date the summary shows, with its source
//   po          the PO's required-by date
//   committed   ours, or null
//   suggestion  suggestedCommittedDate, or null
//   conflicts   deliveryDateConflicts
export const deliverySummary = (order, opts = {}) => ({
  shown: orderDeliveryDate(order),
  po: poRequiredBy(order),
  committed: committedDate(order),
  suggestion: suggestedCommittedDate(order),
  conflicts: deliveryDateConflicts(order, opts),
});

// "30-Oct-26" as the SO PDF prints a date; the printed text when it is not a
// calendar date.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const fmtDueDate = (d) => {
  if (!d) return "";
  if (d.iso) {
    const [y, m, day] = d.iso.split("-");
    return day + "-" + MONTHS[Number(m) - 1] + "-" + y.slice(-2);
  }
  return d.printed || "";
};
