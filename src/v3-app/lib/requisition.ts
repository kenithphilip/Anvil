// The buyer's purchase requisition (PR) number, per PO line.
//
// A customer's maintenance team raises a PR in SAP against our quote and
// purchasing then issues the PO. A consolidated PO can answer several PRs at
// once: the OEM block layout prints one in the requisition row of every item
// block. Both PO adapters now read it per line (lines[].requisition_no) beside
// the header slot (customer.requisition_no). This module is what the SO
// workspace uses to show it, and to say when one PO carries more than one.
//
// Everything here is computed from the lines it is handed, at render. Nothing
// is stored, so a large PO whose full line set lands later from the background
// worker is described correctly as soon as those lines arrive.
//
// Normalisation starts from the PR-number match key
// docs/ACCOUNTS_ASSETS_PORTAL_SCOPE.md specifies for the later quote link
// (pr_number_norm: upper case, letters and digits only), so "1000 343 964",
// "1000-343964" and "1000343964" are one requisition here too. For ASCII input
// the two keys are identical. Two things differ, both so that a value the
// extractor returned is never hidden or merged with a different one only
// because it was not printed in ASCII:
// - NFKC folding first, so full-width digits on a JP or CN PO
//   ("\uFF11\uFF10...") read as the ASCII digits they are;
// - letters, marks and digits of every script are kept. The scope doc's SQL
//   class [^A-Za-z0-9] would turn "PR-\uC694\uCCAD123" and "PR-\uBC1C\uC8FC123"
//   into the same "PR123".
// The scope doc's generated column is ASCII only; the PR that builds the quote
// link has to adopt this folding (or call this key) so the two agree.

export interface RequisitionGroup {
  /** Normalised match key, or the trimmed value when it has no letter or digit. */
  key: string;
  /** The value as the first line carrying it printed it. */
  value: string;
  /** 1-based line numbers, ascending. */
  lines: number[];
}

/** The requisition number printed on one line, trimmed, or null. */
export const lineRequisition = (ln: unknown): string | null => {
  if (!ln || typeof ln !== "object") return null;
  const v = (ln as Record<string, unknown>).requisition_no;
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
};

/**
 * NFKC, then letters, marks and digits of any script only, upper case; null
 * when nothing is left.
 */
export const normaliseRequisition = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).normalize("NFKC").replace(/[^\p{L}\p{M}\p{N}]/gu, "").toUpperCase();
  return s ? s : null;
};

/**
 * Distinct requisition numbers across the lines, in order of first appearance.
 * A line with no requisition belongs to no group; it is neither a value nor a
 * disagreement. A line that carries a value with no letter or digit in it (a
 * lone "*" or "/") is still a value the extractor returned: it gets a group of
 * its own, keyed by the trimmed value, rather than being dropped. That key
 * cannot collide with a normalised one, which is made only of letters, marks
 * and digits, while this one has none. So the workspace column, which shows
 * whenever there is a group, shows whenever any line carries a value.
 */
export const requisitionGroups = (lines: unknown[] | null | undefined): RequisitionGroup[] => {
  const groups = new Map<string, RequisitionGroup>();
  (Array.isArray(lines) ? lines : []).forEach((ln, i) => {
    const raw = lineRequisition(ln);
    if (!raw) return;
    const key = normaliseRequisition(raw) ?? raw;
    const g = groups.get(key);
    if (g) g.lines.push(i + 1);
    else groups.set(key, { key, value: raw, lines: [i + 1] });
  });
  return [...groups.values()];
};

/** [1,2,3,4] -> "lines 1-4"; [3] -> "line 3"; [1,2,5] -> "lines 1-2, 5". */
export const formatLineRanges = (nums: number[]): string => {
  const sorted = [...new Set(nums.filter((n) => Number.isInteger(n)))].sort((a, b) => a - b);
  if (!sorted.length) return "";
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let k = 1; k <= sorted.length; k++) {
    const n = sorted[k];
    if (n === prev + 1) { prev = n; continue; }
    parts.push(start === prev ? String(start) : start + "-" + prev);
    start = n;
    prev = n;
  }
  return (sorted.length === 1 ? "line " : "lines ") + parts.join(", ");
};

/**
 * The non-blocking notice for a PO whose lines carry more than one
 * requisition number, or null when they carry one or none. It says which lines
 * carry which, because "this PO answers two PRs" is only actionable when the
 * operator can see where the split falls.
 */
export const requisitionNotice = (groups: RequisitionGroup[]): string | null => {
  if (!Array.isArray(groups) || groups.length < 2) return null;
  return "This PO's lines carry " + groups.length + " requisition numbers: "
    + groups.map((g) => g.value + " (" + formatLineRanges(g.lines) + ")").join(", ")
    + ".";
};
