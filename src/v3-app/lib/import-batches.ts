// Splitting a workbook upload across requests.
//
// The In Transit workbook normalizes to ~35,000 line rows — a 6.2 MB body
// against a 1 MB `MAX_BODY_BYTES` cap (src/api/_lib/cors.js). It cannot go up in
// one request no matter how the rows are trimmed, because the rows ARE the
// payload: pre-normalizing the whole thing saves 5%.
//
// Until now the client hid this by filtering line rows down to the invoices in
// the SAME upload's summary sheet. That kept the body under the cap by accident
// and cost two real things:
//
//   - uploading the line workbook ALONE sent zero rows, because there was no
//     summary sheet to match against. That is the "line items once, summary
//     daily" workflow, and the server was fixed to support it (lines resolve
//     against shipments already on file) while the client still discarded the
//     rows before they left the browser.
//   - even with both workbooks, 861 of 1,625 invoices in the line sheets had no
//     row in that day's summary and were dropped in silence.
//
// So the filter comes out and the payload gets split instead. Shipments go in
// the first request; line batches follow, and attach to what the first request
// created.

/** Body cap is 1 MB; leave room for the pending rows, envelope and JSON overhead. */
export const LINE_BATCH_BYTES = 700 * 1024;

const bytes = (v: unknown) => {
  const s = JSON.stringify(v) ?? "";
  // Byte length, not string length — a part description with an en-dash or a
  // Japanese supplier name is multi-byte, and undercounting is what a cap
  // measured in bytes cannot forgive.
  return typeof TextEncoder !== "undefined" ? new TextEncoder().encode(s).length : Buffer.byteLength(s);
};

/**
 * Greedily pack rows into batches no larger than `maxBytes`.
 *
 * A single row larger than the cap gets its own batch rather than being dropped
 * or silently splitting a row across requests: one oversized row should fail
 * loudly at the server, not disappear here.
 */
export const batchByBytes = <T,>(rows: T[], maxBytes = LINE_BATCH_BYTES): T[][] => {
  const out: T[][] = [];
  let cur: T[] = [];
  let size = 2; // the enclosing []
  for (const row of rows || []) {
    const n = bytes(row) + 1; // + the comma
    if (cur.length && size + n > maxBytes) {
      out.push(cur);
      cur = [];
      size = 2;
    }
    cur.push(row);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
};

export interface ImportRequest {
  mode: "preview" | "apply";
  pending: any[];
  lines: any[];
  /** Invoices in this upload, so a later batch's lines are not miscounted as orphans. */
  known_invoices?: string[];
}

/**
 * The exact sequence of request bodies for one upload.
 *
 * Order is load-bearing on apply: the shipment rows must land before the line
 * rows that attach to them, so `pending` always rides the first request.
 */
export const planImportRequests = (
  mode: "preview" | "apply",
  pending: any[],
  lines: any[],
  maxBytes = LINE_BATCH_BYTES,
): ImportRequest[] => {
  const pend = pending || [];
  const known = Array.from(
    new Set(pend.map((p: any) => p?.shipper_invoice_no).filter(Boolean)),
  ) as string[];
  // Room the pending rows already take out of the first request's budget.
  const firstBudget = Math.max(0, maxBytes - bytes(pend) - bytes(known));
  const all = lines || [];

  // Pending rows alone can fill the request. Send them by themselves rather
  // than squeezing in a token handful of lines.
  const head = firstBudget > 2 ? batchByBytes(all, firstBudget)[0] || [] : [];
  const rest = batchByBytes(all.slice(head.length), maxBytes);

  const reqs: ImportRequest[] = [{ mode, pending: pend, lines: head, known_invoices: known }];
  for (const b of rest) reqs.push({ mode, pending: [], lines: b, known_invoices: known });
  // An upload of shipments only is one request; so is an upload of nothing.
  return reqs;
};

/**
 * Fold the per-request summaries back into one.
 *
 * Counts add. Shipment-plan figures come from the first request, the only one
 * carrying `pending`. Samples are unioned and re-capped so the operator sees a
 * spread of orphan invoices rather than ten from whichever batch ran first.
 */
export const mergeSummaries = (summaries: any[]): any => {
  const list = (summaries || []).filter(Boolean);
  if (!list.length) return {};
  const head = list[0] || {};
  const sum = (k: string) => list.reduce((n, s) => n + (Number(s?.[k]) || 0), 0);
  const country: Record<string, number> = {};
  const orphans = new Set<string>();
  for (const s of list) {
    for (const [k, v] of Object.entries(s?.by_source_country || {})) {
      country[k] = (country[k] || 0) + (Number(v) || 0);
    }
    for (const inv of s?.orphan_invoice_sample || []) orphans.add(inv);
  }
  return {
    ...head,
    // Shipment-side figures belong to the request that carried the shipments.
    pending_rows: head.pending_rows || 0,
    to_insert: head.to_insert || 0,
    to_update: head.to_update || 0,
    linked_to_project: head.linked_to_project || 0,
    unlinked: head.unlinked || 0,
    // Line-side figures accumulate across every request.
    line_rows: sum("line_rows"),
    line_receipts_matched: sum("line_receipts_matched"),
    line_receipts_applied: sum("line_receipts_applied"),
    shipment_lines_matched: sum("shipment_lines_matched"),
    shipment_lines_applied: sum("shipment_lines_applied"),
    lines_without_part_no: sum("lines_without_part_no"),
    orphan_invoices: sum("orphan_invoices"),
    orphan_invoice_sample: [...orphans].slice(0, 10),
    // Distinct existing invoices, counted per batch. An invoice whose rows
    // straddle a batch boundary is counted twice, so this can overshoot by at
    // most one per boundary — a handful against hundreds. The alternative, a
    // max across batches, would report one batch's share as the whole.
    lines_matched_to_existing: sum("lines_matched_to_existing"),
    inserted: sum("inserted"),
    updated: sum("updated"),
    by_source_country: country,
    sheets: head.sheets,
  };
};
