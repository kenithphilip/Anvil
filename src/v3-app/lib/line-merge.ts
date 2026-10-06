// Merging a fresh extraction into an order's existing line items.
//
// TWO FAILURES THIS EXISTS FOR
//
// 1. A failed run used to BLANK the order. runExtraction wrote
//    `lineItems: lines` unconditionally, so a run that returned nothing
//    replaced good data with an empty array. A real order lost 44 extracted
//    lines that way. The server's chunked path had already been hardened
//    against exactly this ("do NOT blank the order's existing line items"),
//    but the synchronous client path never was.
//
// 2. Re-extraction would destroy operator work. Anything a sales engineer adds
//    by hand — a line the extractor missed, or one owed under the quote — is
//    invisible to the next extraction, so a wholesale replace erases it.
//    Without this, manual entry is a trap rather than a feature.
//
// The rule: a fresh extraction is authoritative for what it EXTRACTED, and has
// nothing to say about lines a human added. Extracted lines are replaced;
// operator lines are carried forward — unless the extractor has caught up and
// now reports the same line itself, in which case the operator's copy is
// superseded rather than duplicated.

export type LineOrigin = "extracted" | "operator_recovered" | "quote_variance";

/** Lines with no origin recorded predate this field and are extractor output. */
export const originOf = (line: Record<string, unknown> | null | undefined): LineOrigin => {
  const o = line?._origin;
  return o === "operator_recovered" || o === "quote_variance" ? o : "extracted";
};

export const isOperatorLine = (line: Record<string, unknown> | null | undefined): boolean =>
  originOf(line) !== "extracted";

const norm = (v: unknown): string =>
  String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Identity used to tell whether a freshly extracted line IS the line an
// operator added earlier. Strongest available key wins: a customer item code
// or part number is unambiguous, description+quantity is a fallback for
// layouts that carry neither.
//
// Returns null when a line carries nothing identifying — such a line can never
// supersede an operator entry, which is the safe direction: we would rather
// keep a duplicate the operator can delete than silently drop their work.
export const lineIdentity = (line: Record<string, unknown> | null | undefined): string | null => {
  if (!line) return null;
  const code = norm(line.customerItemCode);
  if (code) return "code:" + code;
  const part = norm(line.partNumber);
  if (part) return "part:" + part;
  const desc = norm(line.description);
  if (desc) {
    const qty = Number(line.quantity ?? line.qty);
    return "desc:" + desc + "|" + (Number.isFinite(qty) ? qty : "");
  }
  return null;
};

export interface MergeResult {
  lines: Array<Record<string, unknown>>;
  /** Operator lines carried forward because extraction still does not see them. */
  preserved: number;
  /** Operator lines dropped because extraction now reports them itself. */
  superseded: number;
}

export const mergeExtractedLines = (
  prev: Array<Record<string, unknown>> | null | undefined,
  next: Array<Record<string, unknown>> | null | undefined,
): MergeResult => {
  const fresh = Array.isArray(next) ? next : [];
  const existing = Array.isArray(prev) ? prev : [];

  const freshIds = new Set<string>();
  for (const l of fresh) {
    const id = lineIdentity(l);
    if (id) freshIds.add(id);
  }

  const carried: Array<Record<string, unknown>> = [];
  let superseded = 0;
  for (const l of existing) {
    if (!isOperatorLine(l)) continue;              // extraction owns these
    const id = lineIdentity(l);
    // The extractor now reports this line itself — most often because the
    // customer amended the PO, or because a better adapter finally read it.
    // Keeping both would double-count the value on an order.
    if (id && freshIds.has(id)) { superseded++; continue; }
    carried.push(l);
  }

  return { lines: [...fresh, ...carried], preserved: carried.length, superseded };
};
